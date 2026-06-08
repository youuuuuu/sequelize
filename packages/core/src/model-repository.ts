import { EMPTY_ARRAY, EMPTY_OBJECT, find, shallowClonePojo } from '@sequelize/utils';
import assert from 'node:assert';
import { getBelongsToAssociationsWithTarget } from './_model-internals/get-belongs-to-associations-with-target.js';
import { AbstractDataType } from './abstract-dialect/data-types/index.js';
import type { BelongsToAssociation } from './associations/index.js';
import { AggregateError } from './errors/index.js';
import { BulkRecordError } from './errors/index.js';
import { mayRunHook } from './hooks.js';
import type { ModelDefinition } from './model-definition.js';
import {
  assertHasPrimaryKey,
  assertHasWhereOptions,
  ensureOptionsAreImmutable,
  getModelPkWhere,
  getPrimaryKeyValueOrThrow,
  setTransactionFromCls,
} from './model-internals.js';
import type {
  BulkDestroyOptions,
  BulkUpsertOptions,
  CommonDestroyOptions,
  DestroyManyOptions,
} from './model-repository.types.js';
import { ManualOnDelete } from './model-repository.types.js';
import type { Attributes, CreationAttributes, Model, Transactionable } from './model.js';
import { Op } from './operators.js';
import { mapValueFieldNames } from './utils/format.js';

/**
 * The goal of this class is to become the new home of all the static methods that are currently present on the Model class,
 * as a way to enable a true Repository Mode for Sequelize.
 *
 * Currently, this class is not usable as a repository (due to having a dependency on ModelStatic), but as we migrate all of
 * Model to this class, we will be able to remove the dependency on ModelStatic, and make this class usable as a repository.
 *
 * See https://github.com/sequelize/sequelize/issues/15389 for more details.
 *
 * Unlike {@link ModelDefinition}, it's possible to have multiple different repositories for the same model (as users can provide their own implementation).
 */
export class ModelRepository<M extends Model = Model> {
  readonly #modelDefinition: ModelDefinition<M>;

  constructor(modelDefinition: ModelDefinition<M>) {
    this.#modelDefinition = modelDefinition;
  }

  get #sequelize() {
    return this.#modelDefinition.sequelize;
  }

  get #queryInterface() {
    return this.#sequelize.queryInterface;
  }

  async _UNSTABLE_destroy(
    instanceOrInstances: readonly M[] | M,
    options: DestroyManyOptions = EMPTY_OBJECT,
  ): Promise<number> {
    options = shallowClonePojo(options);
    options.manualOnDelete ??= ManualOnDelete.paranoid;

    assertHasPrimaryKey(this.#modelDefinition);
    setTransactionFromCls(options, this.#sequelize);

    const instances: M[] = Array.isArray(instanceOrInstances)
      ? [...instanceOrInstances]
      : [instanceOrInstances];
    if (instances.length === 0) {
      return 0;
    }

    options = ensureOptionsAreImmutable(options);

    if (mayRunHook('beforeDestroyMany', options.noHooks)) {
      await this.#modelDefinition.hooks.runAsync('beforeDestroyMany', instances, options);

      // in case the beforeDestroyMany hook removed all instances.
      if (instances.length === 0) {
        return 0;
      }
    }

    Object.freeze(instances);

    let result: number;
    const cascadingAssociations = this.#getCascadingDeleteAssociations(options);
    if (cascadingAssociations.length > 0 && !options.transaction) {
      result = await this.#sequelize.transaction(async transaction => {
        options.transaction = transaction;
        Object.freeze(options);

        return this.#destroyInternal(instances, cascadingAssociations, options);
      });
    } else {
      Object.freeze(options);
      result = await this.#destroyInternal(instances, cascadingAssociations, options);
    }

    if (mayRunHook('afterDestroyMany', options.noHooks)) {
      await this.#modelDefinition.hooks.runAsync('afterDestroyMany', instances, options, result);
    }

    return result;
  }

  async #destroyInternal(
    instances: readonly M[],
    cascadingAssociations: readonly BelongsToAssociation[],
    options: DestroyManyOptions,
  ): Promise<number> {
    if (cascadingAssociations.length > 0) {
      await this.#manuallyCascadeDestroy(instances, cascadingAssociations, options);
    }

    const isSoftDelete = !options.hardDelete && this.#modelDefinition.isParanoid();
    if (isSoftDelete) {
      // TODO: implement once updateMany is implemented - https://github.com/sequelize/sequelize/issues/4501
      throw new Error('ModelRepository#_UNSTABLE_destroy does not support paranoid deletion yet.');
    }

    const primaryKeys = this.#modelDefinition.primaryKeysAttributeNames;
    let where;
    if (instances.length === 1) {
      where = getModelPkWhere(instances[0], true)!;
    } else if (primaryKeys.size === 1 && !this.#modelDefinition.versionAttributeName) {
      const primaryKey: string = primaryKeys.values().next().value;

      const values = instances.map(instance => getPrimaryKeyValueOrThrow(instance, primaryKey));

      where = { [primaryKey]: values };
    } else {
      where = {
        // Ideally, we'd use tuple comparison here, but that's not supported by Sequelize yet.
        // It would look like this:
        // WHERE (id1, id2) IN ((1, 2), (3, 4))
        [Op.or]: instances.map(instance => getModelPkWhere(instance, true)!),
      };
    }

    const bulkDeleteOptions = {
      ...options,
      limit: null,
      where,
    };

    // DestroyManyOptions-specific options.
    delete bulkDeleteOptions.hardDelete;
    delete bulkDeleteOptions.noHooks;

    return this.#queryInterface.bulkDelete(this.#modelDefinition, bulkDeleteOptions);
  }

  async _UNSTABLE_bulkDestroy(options: BulkDestroyOptions<M>) {
    options = shallowClonePojo(options);
    options.manualOnDelete ??= ManualOnDelete.paranoid;

    assertHasWhereOptions(options);
    setTransactionFromCls(options, this.#sequelize);

    // TODO: support "scope" option + default scope

    const modelDefinition = this.#modelDefinition;

    if (mayRunHook('_UNSTABLE_beforeBulkDestroy', options.noHooks)) {
      await modelDefinition.hooks.runAsync('_UNSTABLE_beforeBulkDestroy', options);
    }

    let result: number;
    const cascadingAssociations = this.#getCascadingDeleteAssociations(options);
    if (cascadingAssociations.length > 0 && !options.transaction) {
      result = await this.#sequelize.transaction(async transaction => {
        options.transaction = transaction;
        Object.freeze(options);

        return this.#bulkDestroyInternal(cascadingAssociations, options);
      });
    } else {
      Object.freeze(options);
      result = await this.#bulkDestroyInternal(cascadingAssociations, options);
    }

    if (mayRunHook('_UNSTABLE_afterBulkDestroy', options.noHooks)) {
      await modelDefinition.hooks.runAsync('_UNSTABLE_afterBulkDestroy', options, result);
    }

    return result;
  }

  async #bulkDestroyInternal(
    cascadingAssociations: readonly BelongsToAssociation[],
    options: BulkDestroyOptions<M>,
  ): Promise<number> {
    const modelDefinition = this.#modelDefinition;

    if (cascadingAssociations.length > 0) {
      // TODO: if we know this is the last cascade,
      //  we can avoid the fetch and call bulkDestroy directly instead of destroyMany.
      // TODO: only fetch the attributes that are referenced by a foreign key, not all attributes.
      const instances: M[] = await modelDefinition.model.findAll(options);

      await this.#manuallyCascadeDestroy(instances, cascadingAssociations, options);
    }

    const deletedAtAttributeName = modelDefinition.timestampAttributeNames.deletedAt;
    if (deletedAtAttributeName && !options.hardDelete) {
      throw new Error(
        'ModelRepository#_UNSTABLE_bulkDestroy does not support paranoid deletion yet.',
      );
      // const deletedAtAttribute = modelDefinition.attributes.getOrThrow(deletedAtAttributeName);

      // return this.#queryInterface.bulkUpdate(
      //   modelDefinition,
      //   pojo({
      //     [deletedAtAttributeName]: new Date(),
      //   }),
      //   and(
      //     {
      //       [deletedAtAttributeName]: deletedAtAttribute.defaultValue ?? null,
      //     },
      //     options.where,
      //   ),
      //   options,
      // );
    }

    return this.#queryInterface.bulkDelete(this.#modelDefinition, options);
  }

  #getCascadingDeleteAssociations(
    options: CommonDestroyOptions & Transactionable,
  ): readonly BelongsToAssociation[] {
    if (options.manualOnDelete === ManualOnDelete.none) {
      return EMPTY_ARRAY;
    }

    if (
      options.manualOnDelete === ManualOnDelete.paranoid &&
      !options.hardDelete &&
      this.#modelDefinition.isParanoid()
    ) {
      return EMPTY_ARRAY;
    }

    const belongsToAssociations = getBelongsToAssociationsWithTarget(this.#modelDefinition.model);

    return belongsToAssociations.filter(association => {
      const source = association.source.modelDefinition;
      const foreignKey = source.physicalAttributes.getOrThrow(association.foreignKey);

      return (
        foreignKey.onDelete === 'CASCADE' ||
        foreignKey.onDelete === 'SET NULL' ||
        foreignKey.onDelete === 'SET DEFAULT'
      );
    });
  }

  async #manuallyCascadeDestroy(
    instances: readonly M[],
    cascadingAssociations: readonly BelongsToAssociation[],
    options: CommonDestroyOptions & Transactionable,
  ) {
    assert(options.transaction, 'Handling ON DELETE in JavaScript requires a transaction.');

    const isSoftDelete = !options.hardDelete && this.#modelDefinition.isParanoid();

    await Promise.all(
      cascadingAssociations.map(async association => {
        const source = association.source.modelDefinition;
        const foreignKey = source.physicalAttributes.getOrThrow(association.foreignKey);

        switch (foreignKey.onDelete) {
          case 'CASCADE': {
            // Because the cascade can lead to further cascades,
            // we need to fetch the instances first to recursively destroy them.
            // TODO: if we know this is the last cascade,
            //  we can avoid the fetch and call bulkDestroy directly instead of destroyMany.
            // TODO: only fetch the attributes that are referenced by a foreign key, not all attributes.
            const associatedInstances = await source.model.findAll({
              transaction: options.transaction,
              connection: options.connection,
              where: {
                [association.foreignKey]: instances.map(instance =>
                  instance.get(association.targetKey),
                ),
              },
            });

            if (associatedInstances.length === 0) {
              return;
            }

            if (isSoftDelete && !source.isParanoid()) {
              throw new Error(`Trying to soft delete model ${this.#modelDefinition.modelName}, but it is associated with a non-paranoid model, ${source.modelName}, through ${association.name} with onDelete: 'CASCADE'.
This would lead to an active record being associated with a deleted record.`);
            }

            await source.model.modelRepository._UNSTABLE_destroy(associatedInstances, options);

            return;
          }

          case 'SET NULL': {
            // TODO: implement once bulkUpdate is implemented
            throw new Error('Manual cascades do not support SET NULL yet.');
          }

          case 'SET DEFAULT': {
            // TODO: implement once bulkUpdate is implemented
            throw new Error('Manual cascades do not support SET DEFAULT yet.');
          }

          default:
            throw new Error(`Unexpected onDelete action: ${foreignKey.onDelete}`);
        }
      }),
    );
  }

  async bulkUpsert(
    records: ReadonlyArray<CreationAttributes<M>>,
    options: BulkUpsertOptions<Attributes<M>> = {},
  ): Promise<M[]> {
    if (records.length === 0) {
      return [];
    }

    const modelDefinition = this.#modelDefinition;
    const model = modelDefinition.model;
    const sequelize = this.#sequelize;
    const now = new Date();

    options = shallowClonePojo(options);
    setTransactionFromCls(options, sequelize);

    const createdAtAttr = modelDefinition.timestampAttributeNames.createdAt;
    const updatedAtAttr = modelDefinition.timestampAttributeNames.updatedAt;
    const allAttributeNames = Array.from(modelDefinition.attributes.keys());

    options = {
      validate: false,
      hooks: true,
      individualHooks: false,
      returning: true,
      fields: allAttributeNames as Array<keyof Attributes<M>>,
      ...options,
    };

    if (
      options.updateOnDuplicate !== undefined &&
      (!Array.isArray(options.updateOnDuplicate) || options.updateOnDuplicate.length === 0)
    ) {
      throw new Error('updateOnDuplicate option only supports non-empty array.');
    }

    if (!options.updateOnDuplicate || options.updateOnDuplicate.length === 0) {
      options.updateOnDuplicate = allAttributeNames
        .filter(
          attrName =>
            attrName !== createdAtAttr &&
            !modelDefinition.readOnlyAttributeNames.has(attrName),
        ) as Array<keyof Attributes<M>>;
    }

    const instances = records.map(values =>
      model.build(values, { isNewRecord: true }),
    );

    if (options.hooks !== false) {
      await modelDefinition.hooks.runAsync('beforeBulkCreate', instances, options);
    }

    if (options.validate) {
      const errors: BulkRecordError[] = [];
      const validateOptions: Record<string, unknown> = {
        ...options,
        hooks: options.individualHooks,
      };

      await Promise.all(
        instances.map(async instance => {
          try {
            await instance.validate(validateOptions);
          } catch (error) {
            errors.push(new BulkRecordError(error as Error, instance));
          }
        }),
      );

      if (errors.length > 0) {
        throw new AggregateError(errors);
      }
    }

    if (options.individualHooks) {
      await Promise.all(
        instances.map(async instance => {
          await instance.save({
            transaction: options.transaction,
            logging: options.logging,
          });
        }),
      );
    } else {
      const fields = options.fields!;

      const fieldMappedRecords = instances.map(instance => {
        const values: Record<string, unknown> = { ...instance.dataValues };

        if (createdAtAttr && !values[createdAtAttr]) {
          values[createdAtAttr] = now;
        }

        if (updatedAtAttr && !values[updatedAtAttr]) {
          values[updatedAtAttr] = now;
        }

        const out = mapValueFieldNames(values, fields as Iterable<string>, model);
        for (const key of modelDefinition.virtualAttributeNames) {
          delete out[key];
        }

        return out;
      });

      const fieldMappedAttributes: Record<string, unknown> = {};
      for (const attrName of Object.keys(model.tableAttributes)) {
        const attribute = modelDefinition.attributes.get(attrName);
        if (attribute) {
          fieldMappedAttributes[attribute.columnName] = attribute;
        }
      }

      const updateOnDuplicate = (options.updateOnDuplicate as Array<keyof Attributes<M>>).map(
        attrName => modelDefinition.getColumnName(attrName as string),
      );

      let upsertKeys: string[];
      if (options.conflictAttributes) {
        upsertKeys = options.conflictAttributes.map(attrName =>
          modelDefinition.getColumnName(attrName as string),
        );
      } else {
        const keys: string[] = [];
        for (const index of model.getIndexes()) {
          if (index.unique && !index.where && index.fields) {
            for (const field of index.fields) {
              if (typeof field === 'string') {
                keys.push(field);
              }
            }
          }
        }

        upsertKeys =
          keys.length > 0
            ? keys
            : Object.values(model.primaryKeys).map((pk: any) => pk.field);
      }

      const callOptions: Record<string, unknown> = {
        ...options,
        updateOnDuplicate,
        upsertKeys,
      };

      if (callOptions.returning && Array.isArray(callOptions.returning)) {
        callOptions.returning = (callOptions.returning as Array<string | unknown>).map(attr =>
          modelDefinition.getColumnNameLoose(attr as string),
        );
      }

      const results = await (this.#queryInterface as any).bulkInsert(
        model.table,
        fieldMappedRecords,
        callOptions,
        fieldMappedAttributes,
      );

      if (Array.isArray(results)) {
        for (const [i, result] of (results as Array<Record<string, unknown>>).entries()) {
          const instance = instances[i];
          if (!instance) continue;

          for (const key of Object.keys(result)) {
            const value = result[key];
            const attr = find(
              modelDefinition.attributes.values(),
              (attribute: any) =>
                attribute.attributeName === key || attribute.columnName === key,
            );
            const attributeName = attr?.attributeName || key;
            instance.dataValues[attributeName] =
              value != null && attr?.type instanceof AbstractDataType
                ? attr.type.parseDatabaseValue(value)
                : value;
            (instance as any)._previousDataValues[attributeName] =
              instance.dataValues[attributeName];
            instance.changed(attributeName, false);
          }

          instance.isNewRecord = false;
        }
      }
    }

    if (options.hooks !== false) {
      await modelDefinition.hooks.runAsync('afterBulkCreate', instances, options);
    }

    return instances;
  }

  // async save(instances: M[] | M): Promise<void> {}
  // async updateOne(instance: M, values: object, options: unknown): Promise<M> {}
  // async updateMany(data: Array<{ instance: M, values: object }>, options: unknown): Promise<M> {}
  // async updateMany(data: Array<{ where: object, values: object }>, options: unknown): Promise<M> {}
  // async restore(instances: M[] | M, options: unknown): Promise<number> {}
  // async bulkUpdate(options: unknown): Promise<M> {}
  // async bulkRestore(options: unknown): Promise<M> {}
}

const modelRepositories = new WeakMap<ModelDefinition, ModelRepository>();

export function getModelRepository(model: ModelDefinition): ModelRepository {
  let internals = modelRepositories.get(model);
  if (internals) {
    return internals;
  }

  internals = new ModelRepository(model);

  return internals;
}
