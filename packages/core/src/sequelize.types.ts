import type { PartialOrUndefined, StrictRequiredBy } from '@sequelize/utils';
import type { Connection } from './abstract-dialect/connection-manager.js';
import type {
  AbstractDialect,
  ConnectionOptions,
  DialectOptions,
} from './abstract-dialect/dialect.js';
import type { ReplicationPoolOptions } from './abstract-dialect/replication-pool.js';
import type {
  EphemeralSequelizeOptions,
  PersistedSequelizeOptions,
} from './sequelize.internals.js';
import type { NormalizedReplicationOptions } from './sequelize.js';

/**
 * Health check options for connection pool.
 *
 * Used in {@link PoolOptions.healthCheck}
 */
export interface PoolHealthCheckOptions {
  /**
   * Whether to enable connection health checks.
   *
   * When enabled, Sequelize will actively test connections before they are used.
   * This helps detect broken connections caused by database server restarts or network interruptions.
   *
   * @default false
   */
  enabled?: boolean;

  /**
   * The health check mode. Determines when connections are checked:
   *
   * - `'acquire'`: Check connections when they are acquired from the pool (before use).
   * - `'idle'`: Check idle connections periodically (uses driver-level validation).
   * - `'both'`: Check connections both when acquired and when idle.
   *
   * @default 'acquire'
   */
  mode?: 'acquire' | 'idle' | 'both';

  /**
   * A custom SQL query to use for connection health checks.
   *
   * If not specified, a built-in dialect-appropriate query will be used
   * (typically `SELECT 1` or equivalent).
   */
  query?: string;

  /**
   * The interval in milliseconds at which idle connections are checked.
   * Only applies when {@link mode} includes `'idle'`.
   *
   * @default 10_000 (10 seconds)
   */
  idleCheckIntervalMs?: number;
}

/**
 * Connection Pool options.
 *
 * Used in {@link SequelizeCoreOptions.pool}
 */
export interface PoolOptions<Dialect extends AbstractDialect>
  extends PartialOrUndefined<ReplicationPoolOptions> {
  /**
   * A function that validates a connection.
   *
   * If provided, this overrides the default connection validation built in to sequelize.
   */
  validate?: ((connection?: Connection<Dialect>) => boolean) | undefined;

  /**
   * Health check configuration for connections in the pool.
   *
   * When enabled, Sequelize will actively test connections to ensure they are still valid
   * before they are used, helping to recover from database server restarts or network
   * interruptions without manual intervention.
   */
  healthCheck?: PoolHealthCheckOptions;
}

/**
 * Options of the {@link Sequelize} constructor used by the core library.
 *
 * See {@link Options} for the full list of options, including those dialect-specific.
 */
interface SequelizeCoreOptions<Dialect extends AbstractDialect>
  extends PersistedSequelizeOptions<Dialect>,
    EphemeralSequelizeOptions<Dialect> {}

/**
 * Options for the constructor of the {@link Sequelize} main class.
 */
export type Options<Dialect extends AbstractDialect> = SequelizeCoreOptions<Dialect> &
  Omit<DialectOptions<Dialect>, keyof SequelizeCoreOptions<AbstractDialect>> &
  Omit<ConnectionOptions<Dialect>, keyof SequelizeCoreOptions<AbstractDialect>>;

export type NormalizedOptions<Dialect extends AbstractDialect> = StrictRequiredBy<
  Omit<PersistedSequelizeOptions<Dialect>, 'replication'>,
  | 'transactionType'
  | 'noTypeValidation'
  | 'timezone'
  | 'disableClsTransactions'
  | 'defaultTransactionNestMode'
  | 'defaultTimestampPrecision'
> & {
  replication: NormalizedReplicationOptions<Dialect>;
};
