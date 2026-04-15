// Identifier and literal rendering primitives.
//
// INVARIANT: Every SQL identifier and every SQL literal the rewrite
// emits MUST go through this file. No other file
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
// (see builder/sql.ts).

import type { QualifiedIdentifier } from '@/http/request';

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
 * Sentinel `QualifiedIdentifier` that asks the renderers for
 * UNQUALIFIED column references — bare `"col"` instead of
 * `"schema"."table"."col"` or `"t"."col"`.
 *
 * RUNTIME: used by `builder/rpc.ts` for filters/order/projections
 * applied to the output of a set-returning function. Inside a
 * `FROM fn() pgrst_call WHERE ...` scope there is exactly one
 * table in scope, so column names resolve unambiguously with no
 * alias prefix and the builder doesn't have to fight with a fake
 * `"t"."col"` qualifier that doesn't actually exist at that
 * nesting level.
 *
 * INVARIANT: the helpers in this file are the ONLY code that reads
 * the sentinel. Callers that want a local-scope reference import
 * `LOCAL_SCOPE` and pass it through; the renderers handle the
 * special case in one place.
 */
export const LOCAL_SCOPE: QualifiedIdentifier = Object.freeze({
  schema: '',
  name: '',
});

function isLocalScope(q: QualifiedIdentifier): boolean {
  return q.schema === '' && q.name === '';
}

/**
 * Format a QualifiedIdentifier as `"schema"."name"`.
 *
 * - `LOCAL_SCOPE` (both empty) returns an empty string so
 *   `qualifiedColumnToSql(LOCAL_SCOPE, 'col')` becomes `"col"`.
 * - A bare name with empty schema returns `"name"` (used for
 *   temp/local references like `pgrst_call`).
 * - Otherwise returns `"schema"."name"`.
 */
export function qualifiedIdentifierToSql(q: QualifiedIdentifier): string {
  if (isLocalScope(q)) return '';
  if (q.schema === '') return escapeIdent(q.name);
  return escapeIdent(q.schema) + '.' + escapeIdent(q.name);
}

/**
 * Format a column reference. Shapes:
 *
 *   LOCAL_SCOPE + col      → `"col"`            (bare, no qualifier)
 *   LOCAL_SCOPE + '*'      → `*`                (bare wildcard)
 *   {name: t} + col        → `"t"."col"`
 *   {schema, name} + col   → `"schema"."name"."col"`
 *   same + '*'             → `"schema"."name".*`
 */
export function qualifiedColumnToSql(
  target: QualifiedIdentifier,
  column: string,
): string {
  if (isLocalScope(target)) {
    return column === '*' ? '*' : escapeIdent(column);
  }
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
