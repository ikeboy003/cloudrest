// Inline `$N` bind parameters into a SQL string so `EXPLAIN (FORMAT
// JSON)` can consume it.
//
// INVARIANT: this function runs ONLY against a SQL string CloudREST's
// own builder emitted. The builder guarantees every user-controlled
// value reached SQL via `SqlBuilder.addParam` and identifiers go
// through `escapeIdent`, so the string we inline is either a
// number/boolean/null literal or a quoted string whose single-quote
// escaping we own.
//
// SECURITY: inlining is ONLY for the EXPLAIN round-trip. The real
// execution path still uses the parameterized query — this helper
// never feeds Postgres a user-composed string.

/**
 * Walk a SQL string and replace every `$N` placeholder with a
 * Postgres literal form of `params[N-1]`.
 *
 * Placeholder scanning is regex-based but uses a lookahead so
 * `$1` does not collide with `$10`. The replacement order is
 * highest-to-lowest for the same reason.
 */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  let result = sql;
  for (let i = params.length; i >= 1; i--) {
    const literal = postgresLiteralFor(params[i - 1]);
    result = result.replace(new RegExp(`\\$${i}(?!\\d)`, 'g'), literal);
  }
  return result;
}

function postgresLiteralFor(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  // Objects / arrays → JSON.stringify so they produce a valid SQL
  // string literal. Strings pass through with single-quote escaping.
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${s.replace(/'/g, "''")}'`;
}
