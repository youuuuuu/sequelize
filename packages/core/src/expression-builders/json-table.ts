import { BaseSqlExpression, SQL_IDENTIFIER } from './base-sql-expression.js';
import type { Expression } from '../sequelize.js';

export interface JsonTableColumn {
  name: string;
  path?: string;
  type?: string;
  nullOnEmpty?: boolean;
  errorOnEmpty?: boolean;
  defaultOnEmpty?: Expression;
  nullOnError?: boolean;
  errorOnError?: boolean;
  defaultOnError?: Expression;
}

export interface JsonTableOptions {
  jsonExpr: Expression;
  path: string;
  columns: Array<JsonTableColumn>;
  alias?: string;
}

export class JsonTable extends BaseSqlExpression {
  declare protected readonly [SQL_IDENTIFIER]: 'json-table';

  readonly jsonExpr: Expression;
  readonly path: string;
  readonly columns: Array<JsonTableColumn>;
  readonly alias?: string;

  constructor(options: JsonTableOptions) {
    super();
    this.jsonExpr = options.jsonExpr;
    this.path = options.path;
    this.columns = options.columns;
    this.alias = options.alias;
  }
}

export function jsonTable(options: JsonTableOptions): JsonTable {
  return new JsonTable(options);
}
