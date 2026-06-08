import { EMPTY_ARRAY, EMPTY_OBJECT, find, pojo, shallowClonePojo } from '@sequelize/utils';
import defaultsLodash from 'lodash/defaults';
import intersection from 'lodash/intersection';
import omit from 'lodash/omit';
import without from 'lodash/without';
import assert from 'node:assert';
import { AbstractDataType } from './abstract-dialect/data-types.js';
import { getBelongsToAssociationsWithTarget } from './_model-internals/get-belongs-to-associations-with-target.js';
import { BelongsToAssociation, BelongsToManyAssociation } from './associations/index.js';
import * as SequelizeErrors from './errors/index.js';
import { mayRunHook } from './hooks.js';
import type { ModelDefinition } from './model-definition.js';
import {
  _validateIncludedElements,
  assertHasPrimaryKey,
  assertHasWhereOptions,
  ensureOptionsAreImmutable,
  getModelPkWhere,
  getPrimaryKeyValueOrThrow,
  setTransactionFromCls,
} from './model-internals.js';
import type {
  BulkDestroyOptions,
  CommonDestroyOptions,
  DestroyManyOptions,
} from './model-repository.types.js';
import { ManualOnDelete } from './model-repository.types.js';
import type {
  Attributes,
  BulkCreateOptions,
  CreationAttributes,
  Model,
  ModelStatic,
  Transactionable,
} from './model.js';
import { Op } from './operators.js';
import { mapValueFieldNames } from './utils/format.js';
import { cloneDeep } from './utils/object.js';

type BulkUpsertModelStatic<M extends Model> = ModelStatic<M> & {
  _conformIncludes(options: object, self: ModelStatic<M>): void;
  _expandIncludeAll(options: object): void;
};

type BulkWriteQueryInterface = {
  bulkInsert(
    tableName: unknown,
    records: object[],
    options?: object,
    attributes?: Record<string, unknown>,
  ): Promise<unknown>;
  bulkUpsert?(
    tableName: unknown,
    records: object[],
    options?: object,
    attributes?: Record<string, unknown>,
  ): Promise<unknown>;
};

type BulkUpsertOptions<M extends Model> = Omit<
  BulkCreateOptions<Attributes<M>>,
  'fields' | 'updateOnDuplicate' | 'conflictAttributes' | 'returning'
> & {
  fields?: string[] | undefined;
  updateOnDuplicate?: string[] | undefined;
  conflictAttributes?: string[] | undefined;
  returning?: BulkCreateOptions<Attributes<M>>['returning'] | string[] | undefined;
  model?: BulkUpsertModelStatic<M> | undefined;
  includeValidated?: boolean | undefined;
  association?: unknown;
  upsertKeys?: string[] | undefined;
  skip?: string[] | undefined;
};

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

  async bulkUpsert(
    records: ReadonlyArray<CreationAttributes<M>>,
    options: BulkCreateOptions<Attributes<M>> = EMPTY_OBJECT,
  ): Promise<M[]> {
    if (records.length === 0) {
      return [];
    }

    const dialect = this.#sequelize.dialect.name;
    const now = new Date();
    const model = this.#modelDefinition.model as BulkUpsertModelStatic<M>;
    const queryInterface = this.#queryInterface as unknown as BulkWriteQueryInterface;
    const executeBulkUpsert = queryInterface.bulkUpsert?.bind(queryInterface) ?? queryInterface.bulkInsert.bind(queryInterface);

    const bulkUpsertOptions = (cloneDeep(options) ?? {}) as BulkUpsertOptions<M>;

    setTransactionFromCls(bulkUpsertOptions, this.#sequelize);

    bulkUpsertOptions.model = model;

    if (!bulkUpsertOptions.includeValidated) {
      model._conformIncludes(bulkUpsertOptions, model);
      if (bulkUpsertOptions.include) {
        model._expandIncludeAll(bulkUpsertOptions);
        _validateIncludedElements(bulkUpsertOptions);
      }
    }

    const instances = records.map(values =>
      model.build(values, { isNewRecord: true, include: bulkUpsertOptions.include }),
    );

    const recursiveBulkUpsert = async <T extends Model>(
      instancesToUpsert: T[],
      recursiveOptions: BulkUpsertOptions<T>,
    ): Promise<T[]> => {
      const options: BulkUpsertOptions<T> = {
        validate: false,
        hooks: true,
        individualHooks: false,
        ignoreDuplicates: false,
        ...recursiveOptions,
      };

      if (options.returning === undefined) {
        options.returning = options.association ? false : true;
      }

      const model = options.model!;
      if (options.ignoreDuplicates && model.sequelize.dialect.supports.inserts.ignoreDuplicates === false) {
        throw new Error(`${dialect} does not support the ignoreDuplicates option.`);
      }

      if (options.updateOnDuplicate && !model.sequelize.dialect.supports.inserts.updateOnDuplicate) {
        throw new Error(`${dialect} does not support the updateOnDuplicate option.`);
      }

      const modelDefinition = model.modelDefinition;
      const fields = (options.fields ??= Array.from(modelDefinition.attributes.keys()));
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

      if (options.hooks) {
        await model.hooks.runAsync(
          'beforeBulkCreate',
          instancesToUpsert,
          options as BulkCreateOptions<Attributes<T>>,
        );
      }

      if (options.validate) {
        const errors: SequelizeErrors.BulkRecordError[] = [];
        const validateOptions = {
          ...options,
          hooks: options.individualHooks ?? false,
        } as any;

        await Promise.all(
          instancesToUpsert.map(async instance => {
            try {
              await instance.validate(validateOptions);
            } catch (error) {
              errors.push(new SequelizeErrors.BulkRecordError(error as Error, instance));
            }
          }),
        );

        delete options.skip;
        if (errors.length > 0) {
          throw new SequelizeErrors.AggregateError(errors);
        }
      }

      if (options.individualHooks) {
        await Promise.all(
          instancesToUpsert.map(async instance => {
            const individualOptions = {
              ...options,
              validate: false,
              hooks: true,
            } as any;
            delete individualOptions.fields;
            delete individualOptions.individualHooks;
            delete individualOptions.ignoreDuplicates;

            await instance.save(individualOptions);
          }),
        );
      } else {
        if (options.include && options.include.length > 0) {
          await Promise.all(
            options.include
              .filter((include: any) => include.association instanceof BelongsToAssociation)
              .map(async (include: any) => {
                const associationInstances: Model[] = [];
                const associationInstanceIndexToInstanceMap: T[] = [];

                for (const instance of instancesToUpsert) {
                  const associationInstance = instance.get(include.as) as Model | null;
                  if (associationInstance) {
                    associationInstances.push(associationInstance);
                    associationInstanceIndexToInstanceMap.push(instance);
                  }
                }

                if (associationInstances.length === 0) {
                  return;
                }

                const includeOptions = defaultsLodash(omit(cloneDeep(include), ['association']), {
                  connection: options.connection,
                  transaction: options.transaction,
                  logging: options.logging,
                }) as BulkUpsertOptions<Model>;

                const createdAssociationInstances = await recursiveBulkUpsert(
                  associationInstances,
                  includeOptions,
                );
                for (const idx in createdAssociationInstances) {
                  const associationInstance = createdAssociationInstances[idx];
                  const instance = associationInstanceIndexToInstanceMap[idx];

                  await include.association.set(instance, associationInstance, {
                    save: false,
                    logging: options.logging,
                  });
                }
              }),
          );
        }

        const serializedRecords = instancesToUpsert.map(instance => {
          const values = instance.dataValues;

          if (createdAtAttr && !values[createdAtAttr]) {
            values[createdAtAttr] = now;
            if (!fields.includes(createdAtAttr)) {
              fields.push(createdAtAttr);
            }
          }

          if (updatedAtAttr && !values[updatedAtAttr]) {
            values[updatedAtAttr] = now;
            if (!fields.includes(updatedAtAttr)) {
              fields.push(updatedAtAttr);
            }
          }

          const out = mapValueFieldNames(values, fields, model);
          for (const key of modelDefinition.virtualAttributeNames) {
            delete out[key];
          }

          return out;
        });

        const fieldMappedAttributes = pojo<Record<string, unknown>>();
        for (const attrName in model.tableAttributes) {
          const attribute = modelDefinition.attributes.get(attrName);
          if (attribute) {
            fieldMappedAttributes[attribute.columnName] = attribute;
          }
        }

        if (options.updateOnDuplicate) {
          options.updateOnDuplicate = options.updateOnDuplicate.map(attrName => {
            return modelDefinition.getColumnName(String(attrName));
          });

          if (options.conflictAttributes) {
            options.upsertKeys = options.conflictAttributes.map(attrName =>
              modelDefinition.getColumnName(String(attrName)),
            );
          } else {
            const upsertKeys: string[] = [];

            for (const index of model.getIndexes()) {
              if (index.unique && !index.where) {
                upsertKeys.push(...(index.fields as string[]));
              }
            }

            options.upsertKeys =
              upsertKeys.length > 0
                ? upsertKeys
                : Object.values(model.primaryKeys).map(primaryKey => primaryKey.field);
          }
        }

        if (options.returning && Array.isArray(options.returning)) {
          options.returning = options.returning.map(attr =>
            typeof attr === 'string' ? modelDefinition.getColumnNameLoose(attr) : attr,
          );
        }

        const results = await executeBulkUpsert(
          model.table,
          serializedRecords,
          options,
          fieldMappedAttributes,
        );
        if (Array.isArray(results)) {
          for (const [i, result] of results.entries()) {
            const instance = instancesToUpsert[i] as T & {
              _previousDataValues: Record<string, unknown>;
            };

            for (const key in result as Record<string, unknown>) {
              if (!Object.hasOwn(result as Record<string, unknown>, key)) {
                continue;
              }

              if (
                !instance ||
                (key === model.primaryKeyAttribute &&
                  instance.get(model.primaryKeyAttribute) &&
                  ['mysql', 'mariadb'].includes(dialect))
              ) {
                continue;
              }

              const value = (result as Record<string, unknown>)[key];
              const attribute = find(
                modelDefinition.attributes.values(),
                (candidate: any) => candidate.attributeName === key || candidate.columnName === key,
              );
              const attributeName = attribute?.attributeName || key;
              instance.dataValues[attributeName] =
                value != null && attribute?.type instanceof AbstractDataType
                  ? attribute.type.parseDatabaseValue(value)
                  : value;
              instance._previousDataValues[attributeName] = instance.dataValues[attributeName];
            }
          }
        }
      }

      if (options.include && options.include.length > 0) {
        await Promise.all(
          options.include
            .filter(
              (include: any) =>
                !(
                  include.association instanceof BelongsToAssociation ||
                  (include.parent && include.parent.association instanceof BelongsToManyAssociation)
                ),
            )
            .map(async (include: any) => {
              const associationInstances: Model[] = [];
              const associationInstanceIndexToInstanceMap: T[] = [];

              for (const instance of instancesToUpsert) {
                let associated: any = instance.get(include.as);
                if (!Array.isArray(associated)) {
                  associated = [associated];
                }

                for (const associationInstance of associated as Model[]) {
                  if (associationInstance) {
                    if (!(include.association instanceof BelongsToManyAssociation)) {
                      const instanceModel = instance.constructor as ModelStatic<Model>;
                      associationInstance.set(
                        include.association.foreignKey,
                        instance.get(
                          include.association.sourceKey || instanceModel.primaryKeyAttribute,
                          { raw: true },
                        ),
                        { raw: true },
                      );
                      Object.assign(associationInstance, include.association.scope);
                    }

                    associationInstances.push(associationInstance);
                    associationInstanceIndexToInstanceMap.push(instance);
                  }
                }
              }

              if (associationInstances.length === 0) {
                return;
              }

              const includeOptions = defaultsLodash(omit(cloneDeep(include), ['association']), {
                connection: options.connection,
                transaction: options.transaction,
                logging: options.logging,
              }) as BulkUpsertOptions<Model>;

              const createdAssociationInstances = await recursiveBulkUpsert(
                associationInstances,
                includeOptions,
              );
              if (include.association instanceof BelongsToManyAssociation) {
                const valueSets: Array<Record<string, unknown>> = [];

                for (const idx in createdAssociationInstances) {
                  const associationInstance = createdAssociationInstances[idx];
                  const instance = associationInstanceIndexToInstanceMap[idx];
                  const instanceModel = instance.constructor as ModelStatic<Model>;
                  const associationModel = associationInstance.constructor as ModelStatic<Model>;
                  const associationInstanceWithThrough = associationInstance as any;

                  const values: Record<string, unknown> = {
                    [include.association.foreignKey]: instance.get(instanceModel.primaryKeyAttribute as string, {
                      raw: true,
                    }),
                    [include.association.otherKey]: associationInstance.get(
                      associationModel.primaryKeyAttribute as string,
                      { raw: true },
                    ),
                    ...include.association.through.scope,
                  };
                  if (associationInstanceWithThrough[include.association.through.model.name]) {
                    const throughDefinition = include.association.through.model.modelDefinition;

                    for (const attributeName of throughDefinition.attributes.keys()) {
                      const attribute = throughDefinition.attributes.get(attributeName);

                      if (
                        attribute?._autoGenerated ||
                        attributeName === include.association.foreignKey ||
                        attributeName === include.association.otherKey ||
                        typeof associationInstanceWithThrough[include.association.through.model.name][
                          attributeName
                        ] === 'undefined'
                      ) {
                        continue;
                      }

                      values[attributeName] =
                        associationInstanceWithThrough[include.association.through.model.name][
                          attributeName
                        ];
                    }
                  }

                  valueSets.push(values);
                }

                const throughOptions = defaultsLodash(
                  omit(cloneDeep(include), ['association', 'attributes']),
                  {
                    connection: options.connection,
                    transaction: options.transaction,
                    logging: options.logging,
                  },
                ) as BulkUpsertOptions<Model>;
                throughOptions.model = include.association.throughModel as BulkUpsertModelStatic<Model>;
                const throughInstances = include.association.throughModel.bulkBuild(
                  valueSets,
                  throughOptions,
                );

                await recursiveBulkUpsert(throughInstances, throughOptions);
              }
            }),
        );
      }

      for (const instance of instancesToUpsert) {
        const attributeDefs = modelDefinition.attributes;
        const instanceData = instance as T & { _previousDataValues: Record<string, unknown> };

        for (const attribute of attributeDefs.values()) {
          if (
            instanceData.dataValues[attribute.columnName] !== undefined &&
            attribute.columnName !== attribute.attributeName
          ) {
            instanceData.dataValues[attribute.attributeName] = instanceData.dataValues[attribute.columnName];
            delete instanceData.dataValues[attribute.columnName];
          }

          instanceData._previousDataValues[attribute.attributeName] =
            instanceData.dataValues[attribute.attributeName];
          instanceData.changed(attribute.attributeName, false);
        }

        instanceData.isNewRecord = false;
      }

      if (options.hooks) {
        await model.hooks.runAsync(
          'afterBulkCreate',
          instancesToUpsert,
          options as BulkCreateOptions<Attributes<T>>,
        );
      }

      return instancesToUpsert;
    };

    return recursiveBulkUpsert(instances, bulkUpsertOptions);
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
