import { EMPTY_ARRAY, EMPTY_OBJECT, find, pojo, shallowClonePojo } from '@sequelize/utils';
import cloneDeepLodash from 'lodash/cloneDeep';
import defaultsLodash from 'lodash/defaults';
import intersection from 'lodash/intersection';
import omit from 'lodash/omit';
import without from 'lodash/without';
import assert from 'node:assert';
import { getBelongsToAssociationsWithTarget } from './_model-internals/get-belongs-to-associations-with-target.js';
import type { BelongsToAssociation, BelongsToManyAssociation } from './associations/index.js';
import { AbstractDataType } from './abstract-dialect/data-types';
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
import { mapValueFieldNames } from './utils/format';
import { getObjectFromMap } from './utils/object';
import { Op } from './operators.js';

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

  async _UNSTABLE_bulkUpsert(
    records: ReadonlyArray<CreationAttributes<M>>,
    options: BulkUpsertOptions<Attributes<M>> = EMPTY_OBJECT,
  ): Promise<M[]> {
    if (records.length === 0) {
      return [];
    }

    const dialect = this.#sequelize.dialect.name;
    const now = new Date();
    options = cloneDeepLodash(options) ?? {};

    setTransactionFromCls(options, this.#sequelize);

    const modelDefinition = this.#modelDefinition;
    const model = modelDefinition.model;

    // TODO: handle include options once they are properly supported
    // if (!options.includeValidated) {
    //   model._conformIncludes(options, model);
    //   if (options.include) {
    //     model._expandIncludeAll(options);
    //     _validateIncludedElements(options);
    //   }
    // }

    const instances = records.map(values =>
      model.build(values, { isNewRecord: true }),
    );

    const recursiveBulkUpsert = async (instances: M[], options: any) => {
      options = {
        validate: false,
        individualHooks: false,
        ignoreDuplicates: false,
        ...options,
      };

      if (options.returning === undefined) {
        if (options.association) {
          options.returning = false;
        } else {
          options.returning = true;
        }
      }

      if (
        options.ignoreDuplicates &&
        this.#sequelize.dialect.supports.inserts.ignoreDuplicates === false
      ) {
        throw new Error(`${dialect} does not support the ignoreDuplicates option.`);
      }

      if (
        options.updateOnDuplicate &&
        !this.#sequelize.dialect.supports.inserts.updateOnDuplicate
      ) {
        throw new Error(`${dialect} does not support the updateOnDuplicate option.`);
      }

      options.fields = options.fields || Array.from(modelDefinition.attributes.keys());
      const createdAtAttr = modelDefinition.timestampAttributeNames.createdAt;
      const updatedAtAttr = modelDefinition.timestampAttributeNames.updatedAt;

      if (options.updateOnDuplicate !== undefined) {
        if (Array.isArray(options.updateOnDuplicate) && options.updateOnDuplicate.length > 0) {
          options.updateOnDuplicate = intersection(
            without(Object.keys(model.tableAttributes), createdAtAttr),
            options.updateOnDuplicate,
          );
        } else {
          throw new Error('updateOnDuplicate option only supports non-empty array.');
        }
      }

      // Run before hook
      if (mayRunHook('_UNSTABLE_beforeBulkUpsert', options.noHooks)) {
        await modelDefinition.hooks.runAsync('_UNSTABLE_beforeBulkUpsert', instances, options);
      }

      // Validate
      if (options.validate) {
        const errors: any[] = [];
        const validateOptions = { ...options };
        validateOptions.hooks = options.individualHooks;

        await Promise.all(
          instances.map(async instance => {
            try {
              await instance.validate(validateOptions);
            } catch (error: any) {
              errors.push({ error, instance });
            }
          }),
        );

        delete options.skip;
        if (errors.length > 0) {
          throw new Error('Validation failed');
        }
      }

      if (options.individualHooks) {
        await Promise.all(
          instances.map(async instance => {
            const individualOptions = {
              ...options,
              validate: false,
              noHooks: true,
            };
            delete individualOptions.fields;
            delete individualOptions.individualHooks;
            delete individualOptions.ignoreDuplicates;

            await instance.save(individualOptions);
          }),
        );
      } else {
        // TODO: handle include options once they are properly supported
        // if (options.include && options.include.length > 0) {
        //   await Promise.all(
        //     options.include
        //       .filter(include => include.association instanceof BelongsToAssociation)
        //       .map(async include => {
        //         // ... include handling logic
        //       }),
        //   );
        // }

        // Create all in one query
        // Recreate records from instances to represent any changes made in hooks or validation
        const mappedRecords = instances.map(instance => {
          const values = instance.dataValues;

          // set createdAt/updatedAt attributes
          if (createdAtAttr && !values[createdAtAttr]) {
            values[createdAtAttr] = now;
            if (!options.fields.includes(createdAtAttr)) {
              options.fields.push(createdAtAttr);
            }
          }

          if (updatedAtAttr && !values[updatedAtAttr]) {
            values[updatedAtAttr] = now;
            if (!options.fields.includes(updatedAtAttr)) {
              options.fields.push(updatedAtAttr);
            }
          }

          const out = mapValueFieldNames(values, options.fields, model);
          for (const key of modelDefinition.virtualAttributeNames) {
            delete out[key];
          }

          return out;
        });

        // Map attributes to fields for serial identification
        const fieldMappedAttributes = pojo();
        for (const attrName in model.tableAttributes) {
          const attribute = modelDefinition.attributes.get(attrName);
          if (attribute) {
            fieldMappedAttributes[attribute.columnName] = attribute;
          }
        }

        // Map updateOnDuplicate attributes to fields
        if (options.updateOnDuplicate) {
          options.updateOnDuplicate = options.updateOnDuplicate.map((attrName: string) => {
            return modelDefinition.getColumnName(attrName);
          });

          if (options.conflictAttributes) {
            options.upsertKeys = options.conflictAttributes.map((attrName: string) =>
              modelDefinition.getColumnName(attrName),
            );
          } else {
            const upsertKeys: string[] = [];

            for (const i of model.getIndexes()) {
              if (i.unique && !i.where) {
                // Don't infer partial indexes
                upsertKeys.push(...i.fields);
              }
            }

            options.upsertKeys =
              upsertKeys.length > 0
                ? upsertKeys
                : Object.values(model.primaryKeys).map(x => x.field);
          }
        }

        // Map returning attributes to fields
        if (options.returning && Array.isArray(options.returning)) {
          options.returning = options.returning.map((attr: string) =>
            modelDefinition.getColumnNameLoose(attr),
          );
        }

        const results = await this.#queryInterface.bulkInsert(
          model.table,
          mappedRecords,
          options,
          fieldMappedAttributes,
        );
        if (Array.isArray(results)) {
          for (const [i, result] of results.entries()) {
            const instance = instances[i];

            for (const key in result) {
              if (!Object.hasOwn(result, key)) {
                continue;
              }

              if (
                !instance ||
                (key === model.primaryKeyAttribute &&
                  instance.get(model.primaryKeyAttribute) &&
                  ['mysql', 'mariadb'].includes(dialect))
              ) {
                // The query.js for these DBs is blind, it autoincrements the
                // primarykey value, even if it was set manually. Also, it can
                // return more results than instances, bug?.
                continue;
              }

              const value = result[key];
              const attr = find(
                modelDefinition.attributes.values(),
                attribute => attribute.attributeName === key || attribute.columnName === key,
              );
              const attributeName = attr?.attributeName || key;
              instance.dataValues[attributeName] =
                value != null && attr?.type instanceof AbstractDataType
                  ? attr.type.parseDatabaseValue(value)
                  : value;
              instance._previousDataValues[attributeName] = instance.dataValues[attributeName];
            }
          }
        }
      }

      // TODO: handle include options once they are properly supported
      // if (options.include && options.include.length > 0) {
      //   await Promise.all(
      //     options.include
      //       .filter(
      //         include =>
      //           !(
      //             include.association instanceof BelongsToAssociation ||
      //             (include.parent && include.parent.association instanceof BelongsToManyAssociation)
      //           ),
      //       )
      //       .map(async include => {
      //         // ... include handling logic
      //       }),
      //   );
      // }

      // map fields back to attributes
      for (const instance of instances) {
        const attributeDefs = modelDefinition.attributes;

        for (const attribute of attributeDefs.values()) {
          if (
            instance.dataValues[attribute.columnName] !== undefined &&
            attribute.columnName !== attribute.attributeName
          ) {
            instance.dataValues[attribute.attributeName] =
              instance.dataValues[attribute.columnName];
            // TODO: if a column shares the same name as an attribute, this will cause a bug!
            delete instance.dataValues[attribute.columnName];
          }

          instance._previousDataValues[attribute.attributeName] =
            instance.dataValues[attribute.attributeName];
          instance.changed(attribute.attributeName, false);
        }

        instance.isNewRecord = false;
      }

      // Run after hook
      if (mayRunHook('_UNSTABLE_afterBulkUpsert', options.noHooks)) {
        await modelDefinition.hooks.runAsync('_UNSTABLE_afterBulkUpsert', instances, options);
      }

      return instances;
    };

    return await recursiveBulkUpsert(instances, options);
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
