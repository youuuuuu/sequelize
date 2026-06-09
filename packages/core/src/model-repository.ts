import { EMPTY_ARRAY, EMPTY_OBJECT, shallowClonePojo } from '@sequelize/utils';
import assert from 'node:assert';
import { getBelongsToAssociationsWithTarget } from './_model-internals/get-belongs-to-associations-with-target.js';
import type { BelongsToAssociation } from './associations/index.js';
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
import type { CreationAttributes, Model, Transactionable } from './model.js';
import { Op } from './operators.js';
import { mapValueFieldNames } from './utils/format.js';
import { getObjectFromMap } from './utils/object.js';

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
        [Op.or]: instances.map(instance => getModelPkWhere(instance, true)!),
      };
    }

    const bulkDeleteOptions = {
      ...options,
      limit: null,
      where,
    };

    delete bulkDeleteOptions.hardDelete;
    delete bulkDeleteOptions.noHooks;

    return this.#queryInterface.bulkDelete(this.#modelDefinition, bulkDeleteOptions);
  }

  async _UNSTABLE_bulkDestroy(options: BulkDestroyOptions<M>) {
    options = shallowClonePojo(options);
    options.manualOnDelete ??= ManualOnDelete.paranoid;

    assertHasWhereOptions(options);
    setTransactionFromCls(options, this.#sequelize);

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
      const instances: M[] = await modelDefinition.model.findAll(options);

      await this.#manuallyCascadeDestroy(instances, cascadingAssociations, options);
    }

    const deletedAtAttributeName = modelDefinition.timestampAttributeNames.deletedAt;
    if (deletedAtAttributeName && !options.hardDelete) {
      throw new Error(
        'ModelRepository#_UNSTABLE_bulkDestroy does not support paranoid deletion yet.',
      );
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
            throw new Error('Manual cascades do not support SET NULL yet.');
          }

          case 'SET DEFAULT': {
            throw new Error('Manual cascades do not support SET DEFAULT yet.');
          }

          default:
            throw new Error(`Unexpected onDelete action: ${foreignKey.onDelete}`);
        }
      }),
    );
  }

  async _UNSTABLE_bulkUpsert(
    records: ReadonlyArray<CreationAttributes<M>>,
    options: BulkUpsertOptions<M> = EMPTY_OBJECT,
  ): Promise<M[]> {
    if (records.length === 0) {
      return [];
    }

    options = shallowClonePojo(options);
    setTransactionFromCls(options, this.#sequelize);

    const modelDefinition = this.#modelDefinition;
    const dialect = this.#sequelize.dialect.name;

    if (
      options.updateOnDuplicate &&
      !this.#sequelize.dialect.supports.inserts.updateOnDuplicate
    ) {
      throw new Error(`${dialect} does not support the updateOnDuplicate option.`);
    }

    const instances: M[] = records.map(values =>
      modelDefinition.model.build(values, { isNewRecord: true }),
    );

    if (mayRunHook('_UNSTABLE_beforeBulkUpsert', options.noHooks)) {
      await modelDefinition.hooks.runAsync('_UNSTABLE_beforeBulkUpsert', instances, options as any);
    }

    const now = new Date();
    const createdAtAttr = modelDefinition.timestampAttributeNames.createdAt;
    const updatedAtAttr = modelDefinition.timestampAttributeNames.updatedAt;

    const fields: string[] = (options.fields as string[]) ?? Array.from(modelDefinition.attributes.keys());

    if (options.updateOnDuplicate !== undefined) {
      if (Array.isArray(options.updateOnDuplicate) && options.updateOnDuplicate.length > 0) {
        const updateOnDuplicateSet = new Set(modelDefinition.physicalAttributes.keys());
        options.updateOnDuplicate = options.updateOnDuplicate.filter(field =>
          updateOnDuplicateSet.has(field as string) && field !== createdAtAttr,
        ) as Array<keyof CreationAttributes<M>>;
      } else {
        throw new Error('updateOnDuplicate option only supports non-empty array.');
      }
    }

    if (options.validate) {
      const errors: Error[] = [];

      await Promise.all(
        instances.map(async instance => {
          try {
            await instance.validate({ hooks: options.noHooks ? false : true });
          } catch (error) {
            errors.push(error as Error);
          }
        }),
      );

      if (errors.length > 0) {
        throw new AggregateError(errors);
      }
    }

    if (createdAtAttr && !fields.includes(createdAtAttr)) {
      fields.push(createdAtAttr);
    }

    if (updatedAtAttr && !fields.includes(updatedAtAttr)) {
      fields.push(updatedAtAttr);
    }

    const fieldMappedAttributes = getObjectFromMap(modelDefinition.attributes);
    const recordsForInsert = instances.map(instance => {
      const values = instance.dataValues;

      if (createdAtAttr && !values[createdAtAttr]) {
        values[createdAtAttr] = now;
      }

      if (updatedAtAttr && !values[updatedAtAttr]) {
        values[updatedAtAttr] = now;
      }

      const out = mapValueFieldNames(values, fields, modelDefinition.model);
      for (const key of modelDefinition.virtualAttributeNames) {
        delete out[key];
      }

      return out;
    });

    const bulkInsertOptions: Record<string, unknown> = {
      ...options,
      model: modelDefinition.model,
    };

    const results = await this.#queryInterface.bulkInsert(
      modelDefinition.table,
      recordsForInsert,
      bulkInsertOptions as any,
      fieldMappedAttributes as any,
    );

    if (options.returning !== false && Array.isArray(results)) {
      for (let i = 0; i < instances.length; i++) {
        const result = results[i];
        if (result) {
          instances[i].set(result, { raw: true });
          instances[i].isNewRecord = false;
        }
      }
    } else {
      for (const instance of instances) {
        instance.isNewRecord = false;
      }
    }

    if (mayRunHook('_UNSTABLE_afterBulkUpsert', options.noHooks)) {
      await modelDefinition.hooks.runAsync('_UNSTABLE_afterBulkUpsert', instances, options as any, results);
    }

    return instances;
  }
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
