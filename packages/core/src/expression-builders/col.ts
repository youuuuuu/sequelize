import { parseNestedJsonKeySyntax } from '../utils/attribute-syntax.js';
import { BaseSqlExpression, SQL_IDENTIFIER } from './base-sql-expression.js';

/**
 * Do not use me directly. Use {@link sql.col}
 */
export class Col extends BaseSqlExpression {
  declare protected readonly [SQL_IDENTIFIER]: 'col';

  readonly identifiers: string[];

  constructor(...identifiers: string[]) {
    super();

    // TODO: verify whether the "more than one identifier" case is still needed
    this.identifiers = identifiers;
  }
}

export interface ParsedColJsonPath {
  readonly baseIdentifier: string;
  readonly columnIdentifier: string;
  readonly pathSegments: ReadonlyArray<string | number>;
  readonly prefix: string | undefined;
}

function splitIdentifierHead(identifier: string): { head: string; tail: string | null } {
  const dotIndex = identifier.indexOf('.');
  const bracketIndex = identifier.indexOf('[');

  let separatorIndex = -1;
  if (dotIndex === -1) {
    separatorIndex = bracketIndex;
  } else if (bracketIndex === -1) {
    separatorIndex = dotIndex;
  } else {
    separatorIndex = Math.min(dotIndex, bracketIndex);
  }

  if (separatorIndex === -1) {
    return {
      head: identifier,
      tail: null,
    };
  }

  return {
    head: identifier.slice(0, separatorIndex),
    tail: identifier.slice(separatorIndex),
  };
}

function parsePathSegments(path: string): ReadonlyArray<string | number> | null {
  if (path.length === 0) {
    return null;
  }

  const nestedPath = path.startsWith('.') ? path.slice(1) : path;
  if (nestedPath.length === 0) {
    return null;
  }

  const parsedPath = parseNestedJsonKeySyntax(nestedPath);
  if (parsedPath.castsAndModifiers.length > 0) {
    return null;
  }

  return parsedPath.pathSegments;
}

function parseCandidate(
  identifier: string,
  isJsonColumn: (identifier: string) => boolean,
  prefix: string | undefined,
): ParsedColJsonPath | null {
  const { head, tail } = splitIdentifierHead(identifier);
  if (tail == null || !isJsonColumn(head)) {
    return null;
  }

  const pathSegments = parsePathSegments(tail);
  if (pathSegments == null) {
    return null;
  }

  return {
    baseIdentifier: prefix ? `${prefix}.${head}` : head,
    columnIdentifier: head,
    pathSegments,
    prefix,
  };
}

export function parseColJsonPath(
  identifier: string,
  isJsonColumn: (identifier: string) => boolean,
  prefixes: ReadonlyArray<string | null | undefined> = [],
): ParsedColJsonPath | null {
  for (const prefix of prefixes) {
    if (!prefix || !identifier.startsWith(`${prefix}.`)) {
      continue;
    }

    const parsed = parseCandidate(identifier.slice(prefix.length + 1), isJsonColumn, prefix);
    if (parsed) {
      return parsed;
    }
  }

  return parseCandidate(identifier, isJsonColumn, undefined);
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
