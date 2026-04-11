// Identifier and literal rendering primitives.
//
// INVARIANT: Every SQL identifier and every SQL literal the rewrite
// emits MUST go through this file. CONSTITUTION §1.4. No other file
// may implement its own `escapeIdent`, `pgFmtLit`, or equivalent.
//
// SECURITY: `pgFmtLit` intentionally handles the backslash-vs-E-prefix
// ordering in a way that is robust to refactor. The old helper in
// `src/schema/identifiers.ts:38-44` did the single-quote escape first
// then tested `escaped.includes('\\')` — correct, but subtle: a
// refactor that flipped the order would produce malformed `E''...`.
// The rewrite flips the test to the INPUT string, not the escaped
// string, so the ordering is decoupled.
//
// SECURITY: `pgFmtLit` is ONLY for values the rewrite knows came from
// the database catalog (table types, routine names) or from code-level
// constants. User-controlled values MUST go through `SqlBuilder.addParam`
// (see builder/sql.ts). CONSTITUTION §1.3.

import type { QualifiedIdentifier } from '../http/request';

/**
 * Escape a SQL identifier by wrapping in double quotes and doubling
 * internal double quotes. Postgres identifier rules allow anything
 * between double quotes.
 */
export function escapeIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Escape a list of identifiers and join with `, `.
 */
export function escapeIdentList(names: readonly string[]): string {
  return names.map(escapeIdent).join(', ');
}

/**
 * Format a QualifiedIdentifier as `"schema"."name"`.
 * When the schema is empty, returns just `"name"` (used for temp/local
 * references).
 */
export function qualifiedIdentifierToSql(q: QualifiedIdentifier): string {
  if (q.schema === '') return escapeIdent(q.name);
  return escapeIdent(q.schema) + '.' + escapeIdent(q.name);
}

/**
 * Format a column reference: `"schema"."table"."column"` or
 * `"schema"."table".*` for the wildcard.
 */
export function qualifiedColumnToSql(
  target: QualifiedIdentifier,
  column: string,
): string {
  if (column === '*') return qualifiedIdentifierToSql(target) + '.*';
  return qualifiedIdentifierToSql(target) + '.' + escapeIdent(column);
}

/**
 * Format a string as a Postgres SQL literal.
 *
 * SECURITY: This helper is for database-catalog strings and code
 * constants ONLY. User-controlled values must use SqlBuilder.addParam.
 *
 * SECURITY INVARIANT: The backslash check runs on the INPUT string,
 * before the single-quote escape, so that refactoring does not flip
 * the order. Either the value contains a backslash (needs `E'...'`
 * with doubled backslashes) or it does not (plain `'...'`).
 */
export function pgFmtLit(value: string): string {
  const hasBackslash = value.includes('\\');
  const quoteEscaped = value.replace(/'/g, "''");

  if (hasBackslash) {
    // E'...' with both single quotes and backslashes escaped.
    return "E'" + quoteEscaped.replace(/\\/g, '\\\\') + "'";
  }
  return "'" + quoteEscaped + "'";
}
