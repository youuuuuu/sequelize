import { BaseSqlExpression, SQL_IDENTIFIER } from './base-sql-expression.js';

/**
 * Do not use me directly. Use {@link sql.col}
 */
export class Col extends BaseSqlExpression {
  declare protected readonly [SQL_IDENTIFIER]: 'col';

  readonly identifiers: Array<string | number>;

  constructor(...identifiers: string[]) {
    super();

    // Parse JSON path expressions like 'data.nested[0].property'
    if (identifiers.length === 1 && typeof identifiers[0] === 'string' && /[\.\[]/.test(identifiers[0])) {
      const pathSegments: Array<string | number> = [];
      const regex = /(?:^|\.)([^.\[\]]+)|\[['"]?([^'"\[\]]+)['"]?\]/g;
      let match;
      while ((match = regex.exec(identifiers[0])) !== null) {
        const segment = match[1] !== undefined ? match[1] : match[2];
        pathSegments.push(/^\d+$/.test(segment) ? Number(segment) : segment);
      }
      this.identifiers = pathSegments.length > 0 ? pathSegments : identifiers;
    } else {
      this.identifiers = identifiers;
    }
  }
}

/**
 * Creates an object which represents a column in the DB, this allows referencing another column in your query.
 * This is often useful in conjunction with {@link sql.fn}, {@link sql.where} and {@link sql} which interpret strings as values and not column names.
 *
 * Col works similarly to {@link sql.identifier}, but "*" has special meaning, for backwards compatibility.
 *
 * ⚠️ We recommend using {@link sql.identifier}, or {@link sql.attribute} instead.
 *
 * @param identifiers The name of the column
 */
export function col(...identifiers: string[]): Col {
  return new Col(...identifiers);
}
