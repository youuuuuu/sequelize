import type { DataType } from '../abstract-dialect/data-types.js';
import type { AbstractDialect } from '../abstract-dialect/dialect.js';
import type { EscapeOptions } from '../abstract-dialect/query-generator-typescript.js';
import type { Expression } from '../sequelize.js';
import { DialectAwareFn } from './dialect-aware-fn.js';

export type JsonTableColumnBehavior = 'null' | 'error' | { default: string };

export type JsonTableColumn =
  | JsonTableOrdinalityColumn
  | JsonTablePathColumn
  | JsonTableExistsColumn
  | JsonTableNestedColumn;

export interface JsonTableOrdinalityColumn {
  kind: 'ordinality';
  name: string;
}

export interface JsonTablePathColumn {
  kind: 'path';
  name: string;
  sqlType: DataType | string;
  path: string;
  onEmpty?: JsonTableColumnBehavior;
  onError?: JsonTableColumnBehavior;
}

export interface JsonTableExistsColumn {
  kind: 'exists';
  name: string;
  sqlType: DataType | string;
  path: string;
}

export interface JsonTableNestedColumn {
  kind: 'nested';
  path: string;
  columns: readonly JsonTableColumn[];
}

export interface JsonTableOptions {
  alias: string;
}

export class JsonTable extends DialectAwareFn {
  constructor(
    readonly expression: Expression,
    readonly path: string,
    readonly columns: readonly JsonTableColumn[],
    readonly options: JsonTableOptions,
  ) {
    super();
  }

  supportsDialect(dialect: AbstractDialect): boolean {
    return dialect.supports.jsonTable;
  }

  applyForDialect(dialect: AbstractDialect, escapeOptions?: EscapeOptions): string {
    if (typeof (dialect.queryGenerator as { jsonTable?: unknown }).jsonTable !== 'function') {
      throw new Error(`JSON_TABLE has not been implemented in ${dialect.name}.`);
    }

    return (
      dialect.queryGenerator as unknown as {
        jsonTable(
          expression: Expression,
          path: string,
          columns: readonly JsonTableColumn[],
          options: JsonTableOptions,
          escapeOptions?: EscapeOptions,
        ): string;
      }
    ).jsonTable(this.expression, this.path, this.columns, this.options, escapeOptions);
  }
}

export function jsonTable(
  expression: Expression,
  path: string,
  columns: readonly JsonTableColumn[],
  options: JsonTableOptions,
): JsonTable {
  return new JsonTable(expression, path, columns, options);
}
