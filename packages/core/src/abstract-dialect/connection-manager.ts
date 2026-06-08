import { QueryTypes } from '../enums.js';
import type { AcquireConnectionOptions, ReplicationPool } from './replication-pool.js';
import type { AbstractDialect, ConnectionOptions } from './dialect.js';

export interface GetConnectionOptions {
  /**
   * Set which replica to use. Available options are `read` and `write`
   */
  type: 'read' | 'write';

  /**
   * Force master or write replica to get connection from
   */
  useMaster?: boolean;
}

export interface AbstractConnection {
  /** The UUID of the transaction that is using this connection */
  // TODO: replace with the transaction object itself.
  uuid?: string | undefined;
}

export type ConnectionHealthCheckMode = 'acquire' | 'idle';

export interface ConnectionHealthCheckModeOptions {
  enabled?: boolean | undefined;
  timeout?: number | undefined;
}

export interface AcquireConnectionHealthCheckOptions extends ConnectionHealthCheckModeOptions {
  idleTime?: number | undefined;
  maxRetries?: number | undefined;
}

export interface IdleConnectionHealthCheckOptions extends ConnectionHealthCheckModeOptions {
  interval?: number | undefined;
}

export interface ConnectionHealthCheckOptions {
  acquire?: boolean | AcquireConnectionHealthCheckOptions | undefined;
  idle?: boolean | IdleConnectionHealthCheckOptions | undefined;
  query?: string | undefined;
}

declare const ConnectionType: unique symbol;
export type Connection<
  DialectOrConnectionManager extends AbstractDialect | AbstractConnectionManager,
> = DialectOrConnectionManager extends AbstractDialect
  ? Connection<DialectOrConnectionManager['connectionManager']>
  : DialectOrConnectionManager extends AbstractConnectionManager
    ? DialectOrConnectionManager[typeof ConnectionType]
    : never;

interface ConnectionHealthState {
  inUse: boolean;
  releasedAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pendingCheck: Promise<boolean> | null;
}

interface NormalizedAcquireConnectionHealthCheckOptions {
  enabled: boolean;
  idleTime: number;
  timeout: number;
  maxRetries: number | null;
}

interface NormalizedIdleConnectionHealthCheckOptions {
  enabled: boolean;
  interval: number;
  timeout: number;
}

/**
 * Abstract Connection Manager
 *
 * Connection manager which handles pooling & replication.
 * Uses sequelize-pool for pooling
 *
 * @param connection
 */
export class AbstractConnectionManager<
  Dialect extends AbstractDialect = AbstractDialect,
  TConnection extends AbstractConnection = AbstractConnection,
> {
  declare [ConnectionType]: TConnection;

  protected readonly dialect: Dialect;
  #trackedConnections = new Set<TConnection>();
  #connectionHealthStates = new WeakMap<TConnection, ConnectionHealthState>();
  #poolHealthChecksInstalled = false;

  constructor(dialect: Dialect) {
    this.dialect = dialect;
  }

  protected get sequelize() {
    return this.dialect.sequelize;
  }

  get pool(): never {
    throw new Error('The "pool" property has been moved to the Sequelize instance.');
  }

  installPoolHealthChecks(): void {
    if (this.#poolHealthChecksInstalled) {
      return;
    }

    const pool = this.sequelize.pool as ReplicationPool<TConnection, ConnectionOptions<Dialect>>;
    const originalAcquire = pool.acquire.bind(pool);
    const originalRelease = pool.release.bind(pool);
    const originalDestroy = pool.destroy.bind(pool);
    const originalDestroyAllNow = pool.destroyAllNow.bind(pool);

    pool.acquire = async (options?: AcquireConnectionOptions): Promise<TConnection> => {
      const acquireOptions = options;
      const maxRetries = this.#getAcquireHealthCheckMaxRetries(pool);
      let failedChecks = 0;

      while (true) {
        const connection = await originalAcquire(acquireOptions);
        this.#trackConnection(connection);
        this.#markConnectionAcquired(connection);

        const isHealthy = await this.checkConnectionHealth(connection, 'acquire');
        if (isHealthy) {
          return connection;
        }

        await originalDestroy(connection);
        this.#forgetConnection(connection);

        if (failedChecks >= maxRetries) {
          throw new Error('Unable to acquire a healthy connection from the pool.');
        }

        failedChecks++;
      }
    };

    pool.release = (connection: TConnection): void => {
      originalRelease(connection);
      this.#markConnectionReleased(connection);
    };

    pool.destroy = async (connection: TConnection): Promise<void> => {
      this.#forgetConnection(connection);
      await originalDestroy(connection);
    };

    pool.destroyAllNow = async (): Promise<void> => {
      for (const connection of this.#trackedConnections) {
        this.#forgetConnection(connection);
      }

      await originalDestroyAllNow();
    };

    this.#poolHealthChecksInstalled = true;
  }

  /**
   * Determine if a connection is still valid or not
   *
   * @param _connection
   */
  validate(_connection: TConnection): boolean {
    throw new Error(`validate not implemented in ${this.constructor.name}`);
  }

  async checkConnectionHealth(
    connection: TConnection,
    mode: ConnectionHealthCheckMode,
  ): Promise<boolean> {
    if (!this.#runSynchronousConnectionValidation(connection)) {
      return false;
    }

    if (!this.#shouldRunActiveHealthCheck(connection, mode)) {
      return true;
    }

    const state = this.#getConnectionHealthState(connection);
    if (state.pendingCheck) {
      return state.pendingCheck;
    }

    state.pendingCheck = this.#performConnectionHealthCheck(connection, mode).finally(() => {
      const latestState = this.#connectionHealthStates.get(connection);
      if (latestState) {
        latestState.pendingCheck = null;
      }
    });

    return state.pendingCheck;
  }

  async connect(_config: ConnectionOptions<Dialect>): Promise<TConnection> {
    throw new Error(`connect not implemented in ${this.constructor.name}`);
  }

  async disconnect(_connection: TConnection): Promise<void> {
    throw new Error(`disconnect not implemented in ${this.constructor.name}`);
  }

  #trackConnection(connection: TConnection): void {
    this.#trackedConnections.add(connection);
    this.#getConnectionHealthState(connection);
  }

  #forgetConnection(connection: TConnection): void {
    const state = this.#connectionHealthStates.get(connection);
    if (state?.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    this.#trackedConnections.delete(connection);
    this.#connectionHealthStates.delete(connection);
  }

  #getConnectionHealthState(connection: TConnection): ConnectionHealthState {
    const existingState = this.#connectionHealthStates.get(connection);
    if (existingState) {
      return existingState;
    }

    const newState: ConnectionHealthState = {
      inUse: true,
      releasedAt: null,
      idleTimer: null,
      pendingCheck: null,
    };

    this.#connectionHealthStates.set(connection, newState);

    return newState;
  }

  #markConnectionAcquired(connection: TConnection): void {
    const state = this.#getConnectionHealthState(connection);
    state.inUse = true;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  #markConnectionReleased(connection: TConnection): void {
    const state = this.#getConnectionHealthState(connection);
    state.inUse = false;
    state.releasedAt = Date.now();

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    const idleHealthCheckOptions = this.#getIdleHealthCheckOptions();
    if (!idleHealthCheckOptions.enabled) {
      return;
    }

    state.idleTimer = setTimeout(() => {
      void this.#runIdleHealthCheck(connection, state.releasedAt);
    }, idleHealthCheckOptions.interval);
  }

  async #runIdleHealthCheck(connection: TConnection, releasedAt: number | null): Promise<void> {
    const state = this.#connectionHealthStates.get(connection);
    if (!state || state.inUse || state.releasedAt !== releasedAt) {
      return;
    }

    state.idleTimer = null;

    const isHealthy = await this.checkConnectionHealth(connection, 'idle');
    if (!isHealthy) {
      try {
        await (this.sequelize.pool as ReplicationPool<TConnection, ConnectionOptions<Dialect>>).destroy(
          connection,
        );
      } catch {
        return;
      }

      return;
    }

    if (state.inUse || state.releasedAt !== releasedAt) {
      return;
    }

    const idleHealthCheckOptions = this.#getIdleHealthCheckOptions();
    state.idleTimer = setTimeout(() => {
      void this.#runIdleHealthCheck(connection, releasedAt);
    }, idleHealthCheckOptions.interval);
  }

  #runSynchronousConnectionValidation(connection: TConnection): boolean {
    if (this.sequelize.options.pool?.validate) {
      return this.sequelize.options.pool.validate(connection);
    }

    return this.validate(connection);
  }

  #shouldRunActiveHealthCheck(connection: TConnection, mode: ConnectionHealthCheckMode): boolean {
    const state = this.#connectionHealthStates.get(connection);
    if (!state) {
      return false;
    }

    if (mode === 'idle') {
      return this.#getIdleHealthCheckOptions().enabled;
    }

    const acquireHealthCheckOptions = this.#getAcquireHealthCheckOptions();
    if (!acquireHealthCheckOptions.enabled || state.releasedAt == null) {
      return false;
    }

    return Date.now() - state.releasedAt >= acquireHealthCheckOptions.idleTime;
  }

  async #performConnectionHealthCheck(
    connection: TConnection,
    mode: ConnectionHealthCheckMode,
  ): Promise<boolean> {
    const timeout =
      mode === 'acquire'
        ? this.#getAcquireHealthCheckOptions().timeout
        : this.#getIdleHealthCheckOptions().timeout;

    try {
      const healthCheckQuery = this.#getConnectionHealthCheckQuery();
      const queryPromise = this.sequelize.query(healthCheckQuery, {
        raw: true,
        plain: true,
        type: QueryTypes.SELECT,
        connection,
        logging: false,
        retry: { max: 0 },
      });

      if (timeout <= 0) {
        await queryPromise;

        return true;
      }

      await Promise.race([
        queryPromise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Connection health check timed out.'));
          }, timeout);

          void queryPromise.finally(() => {
            clearTimeout(timer);
          });
        }),
      ]);

      return true;
    } catch {
      return false;
    }
  }

  #getAcquireHealthCheckMaxRetries(
    pool: ReplicationPool<TConnection, ConnectionOptions<Dialect>>,
  ): number {
    const acquireHealthCheckOptions = this.#getAcquireHealthCheckOptions();
    if (!acquireHealthCheckOptions.enabled) {
      return 0;
    }

    return acquireHealthCheckOptions.maxRetries ?? Math.max(pool.size, 1);
  }

  #getAcquireHealthCheckOptions(): NormalizedAcquireConnectionHealthCheckOptions {
    const acquireHealthCheck = this.sequelize.options.pool?.healthCheck?.acquire;
    if (!acquireHealthCheck) {
      return {
        enabled: false,
        idleTime: 0,
        timeout: 5000,
        maxRetries: null,
      };
    }

    if (acquireHealthCheck === true) {
      return {
        enabled: true,
        idleTime: 0,
        timeout: 5000,
        maxRetries: null,
      };
    }

    return {
      enabled: acquireHealthCheck.enabled ?? true,
      idleTime: acquireHealthCheck.idleTime ?? 0,
      timeout: acquireHealthCheck.timeout ?? 5000,
      maxRetries: acquireHealthCheck.maxRetries ?? null,
    };
  }

  #getIdleHealthCheckOptions(): NormalizedIdleConnectionHealthCheckOptions {
    const idleHealthCheck = this.sequelize.options.pool?.healthCheck?.idle;
    if (!idleHealthCheck) {
      return {
        enabled: false,
        interval: 30_000,
        timeout: 5000,
      };
    }

    if (idleHealthCheck === true) {
      return {
        enabled: true,
        interval: 30_000,
        timeout: 5000,
      };
    }

    return {
      enabled: idleHealthCheck.enabled ?? true,
      interval: idleHealthCheck.interval ?? 30_000,
      timeout: idleHealthCheck.timeout ?? 5000,
    };
  }

  #getConnectionHealthCheckQuery(): string {
    const customQuery = this.sequelize.options.pool?.healthCheck?.query;
    if (customQuery) {
      return customQuery;
    }

    const dummyTableName = this.dialect.supports.select.dummyTable;
    const fromClause = dummyTableName
      ? ` FROM ${this.sequelize.queryGenerator.quoteIdentifier(dummyTableName)}`
      : '';

    return `SELECT 1+1 AS result${fromClause}`;
  }
}
