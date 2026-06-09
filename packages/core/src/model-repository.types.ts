import type { StrictRequiredBy } from '@sequelize/utils';
import type { QiBulkDeleteOptions } from './abstract-dialect/query-interface.types.js';
import type { Col } from './expression-builders/col.js';
import type { Literal } from './expression-builders/literal.js';
import type { NewHookable } from './hooks.js';
import type { WhereOptions } from './index.js';
import type {
  Attributes,
  CreationAttributes,
  Hookable,
  Logging,
  Model,
  SearchPathable,
  Transactionable,
} from './model.js';

export enum ManualOnDelete {
  /**
   * Only replicates the behavior of ON DELETE in JS for soft deletions,
   * otherwise is equivalent to "none".
   */
  paranoid = 'paranoid',

  /**
   * Lets the database delete the cascading instances, does nothing in JS.
   * Most efficient, but not compatible with soft deletions.
   */
  none = 'none',

  /**
   * Pre-deletes every cascading model in JS before deleting the current instance.
   * Useful if you need to trigger the JS delete hooks for the cascading models.
   *
   * This is the least efficient option.
   */
  all = 'all',
}

export interface CommonDestroyOptions {
  /**
   * If set to true, paranoid models will actually be deleted instead of soft deleted.
   */
  hardDelete?: boolean | undefined;

  /**
   * Manually handles the behavior of ON DELETE in JavaScript, instead of using the native database ON DELETE behavior.
   * This option is useful when:
   * - The deletion is a soft deletion.
   * - You wish to run JS delete hooks for the cascading models.
   *
   * @default 'paranoid'
   */
  manualOnDelete?: ManualOnDelete | undefined;
}

/**
 * Used by {@link ModelRepository#_UNSTABLE_destroy}
 */
export interface DestroyManyOptions
  extends NewHookable<'beforeDestroyMany' | 'afterDestroyMany'>,
    Omit<QiBulkDeleteOptions, 'where' | 'limit'>,
    CommonDestroyOptions {}

/**
 * Used by {@link ModelRepository#_UNSTABLE_bulkDestroy}
 */
export interface BulkDestroyOptions<TModel extends Model>
  extends NewHookable<'_UNSTABLE_beforeBulkDestroy' | '_UNSTABLE_afterBulkDestroy'>,
    StrictRequiredBy<QiBulkDeleteOptions<Attributes<TModel>>, 'where'>,
    CommonDestroyOptions {}

/**
 * Options for ModelRepository.bulkUpsert method
 */
export interface BulkUpsertOptions<TModel extends Model>
  extends Logging,
    Transactionable,
    Hookable,
    SearchPathable,
    NewHookable<'_UNSTABLE_beforeBulkUpsert' | '_UNSTABLE_afterBulkUpsert'> {
  /**
   * Fields to insert (defaults to all fields)
   */
  fields?: Array<keyof CreationAttributes<TModel>>;

  /**
   * Should each row be subject to validation before it is inserted.
   * The whole insert will fail if one row fails validation.
   *
   * @default false
   */
  validate?: boolean;

  /**
   * Fields to update if row key already exists (on duplicate key update)? (only supported by MySQL,
   * MariaDB, SQLite >= 3.24.0 & Postgres >= 9.5).
   */
  updateOnDuplicate?: Array<keyof Attributes<TModel>>;

  /**
   * Return all columns or only the specified columns for the affected rows (only for postgres)
   */
  returning?: boolean | Array<keyof Attributes<TModel> | Literal | Col>;

  /**
   * An optional parameter to specify a where clause for partial unique indexes
   * (note: `ON CONFLICT WHERE` not `ON CONFLICT DO UPDATE WHERE`).
   * Only supported in Postgres >= 9.5 and sqlite >= 9.5
   */
  conflictWhere?: WhereOptions<Attributes<TModel>>;

  /**
   * Optional override for the conflict fields in the ON CONFLICT part of the query.
   * Only supported in Postgres >= 9.5 and SQLite >= 3.24.0
   */
  conflictAttributes?: Array<keyof Attributes<TModel>>;
}
