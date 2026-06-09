import { BaseSqlExpression, SQL_IDENTIFIER } from './base-sql-expression.js';
import { parseAttributeSyntax } from '../utils/attribute-syntax.js';
import { Attribute } from './attribute.js';
import { JsonPath } from './json-path.js';

/**
 * Do not use me directly. Use {@link sql.col}
 */
export class Col extends BaseSqlExpression {
  declare protected readonly [SQL_IDENTIFIER]: 'col';

  readonly identifiers: string[];

  /**
   * If this Col represents a JSON path expression (e.g. col('data.name') or col('data[0].key')),
   * this property holds the parsed JSON path segments.
   * Otherwise, it is undefined.
   */
  readonly jsonPath: ReadonlyArray<string | number> | undefined;

  /**
   * If this Col represents a JSON path expression, this is the base column name
   * (e.g. 'data' from col('data.name')).
   * Otherwise, it is undefined.
   */
  readonly baseIdentifier: string | undefined;

  constructor(...identifiers: string[]) {
    super();

    // TODO: verify whether the "more than one identifier" case is still needed
    this.identifiers = identifiers;

    if (identifiers.length === 1) {
      const identifier = identifiers[0];
      if (identifier.includes('.') || identifier.includes('[')) {
        try {
          const parsed = parseAttributeSyntax(identifier);
          if (parsed instanceof JsonPath && parsed.expression instanceof Attribute) {
            this.jsonPath = parsed.path;
            this.baseIdentifier = parsed.expression.attributeName;
          }
        } catch {
          // If parsing fails, treat as a regular column name without JSON path
        }
      }
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
