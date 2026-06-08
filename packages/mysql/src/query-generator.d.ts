import type { Expression } from '@sequelize/core';
import type { EscapeOptions } from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator-typescript.js';
import type {
  JsonTableColumn,
  JsonTableOptions,
} from '@sequelize/core/_non-semver-use-at-your-own-risk_/expression-builders/json-table.js';
import { MySqlQueryGeneratorTypeScript } from './query-generator-typescript.internal.js';

export class MySqlQueryGenerator extends MySqlQueryGeneratorTypeScript {
  jsonTable(
    expression: Expression,
    path: string,
    columns: readonly JsonTableColumn[],
    options: JsonTableOptions,
    escapeOptions?: EscapeOptions,
  ): string;
}
