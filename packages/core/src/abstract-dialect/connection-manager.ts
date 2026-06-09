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

declare const ConnectionType: unique symbol;
export type Connection<
  DialectOrConnectionManager extends AbstractDialect | AbstractConnectionManager,
> = DialectOrConnectionManager extends AbstractDialect
  ? Connection<DialectOrConnectionManager['connectionManager']>
  : DialectOrConnectionManager extends AbstractConnectionManager
    ? DialectOrConnectionManager[typeof ConnectionType]
    : never;

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

  constructor(dialect: Dialect) {
    this.dialect = dialect;
  }

  protected get sequelize() {
    return this.dialect.sequelize;
  }

  get pool(): never {
    throw new Error('The "pool" property has been moved to the Sequelize instance.');
  }

  /**
   * Determine if a connection is still valid or not
   *
   * @param _connection
   */
  validate(_connection: TConnection): boolean {
    throw new Error(`validate not implemented in ${this.constructor.name}`);
  }

  /**
   * Perform an active health check on a connection by executing a simple query.
   *
   * Unlike {@link validate}, which performs a synchronous local-state check,
   * this method actively tests the connection by running a simple SQL query.
   * This can detect broken connections caused by database server restarts or
   * network interruptions that are not reflected in the driver's local state.
   *
   * @param connection - The connection to check.
   * @returns `true` if the connection is healthy, `false` otherwise.
   */
  async healthCheck(connection: TConnection): Promise<boolean> {
    const healthCheckQuery = this.#getHealthCheckQuery();

    try {
      await this.sequelize.queryRaw(healthCheckQuery, {
        connection,
        type: 'RAW',
        raw: true,
        logging: false,
        retry: { max: 0 },
      });

      return true;
    } catch {
      return false;
    }
  }

  #getHealthCheckQuery(): string {
    const healthCheckOptions = this.sequelize.rawOptions?.pool?.healthCheck;
    if (healthCheckOptions?.query) {
      return healthCheckOptions.query;
    }

    const dialect = this.dialect;
    const dummyTable = dialect.supports.select?.dummyTable;
    if (dummyTable) {
      const quotedTable = dialect.queryGenerator?.quoteIdentifier?.(dummyTable) ?? dummyTable;

      return `SELECT 1 FROM ${quotedTable}`;
    }

    return 'SELECT 1';
  }

  async connect(_config: ConnectionOptions<Dialect>): Promise<TConnection> {
    throw new Error(`connect not implemented in ${this.constructor.name}`);
  }

  async disconnect(_connection: TConnection): Promise<void> {
    throw new Error(`disconnect not implemented in ${this.constructor.name}`);
  }
}
