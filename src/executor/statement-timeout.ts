// `SET LOCAL statement_timeout` rendering.
//
// INVARIANT: every transaction MUST
// set a statement timeout. The value comes from
// `config.database.statementTimeoutMs`. The executor's transaction
// runner calls this for every request — there is no "opt out" path.
//
// SECURITY: the timeout value is a positive integer validated at
// config-load time; the renderer inlines it as a literal rather than a
// bind parameter because `SET LOCAL` does not accept parameters at all.

/**
 * Render a `SET LOCAL statement_timeout = '<ms>'` statement.
 *
 * The value is clamped to a sane minimum (1ms) — passing 0 or a
 * negative integer would disable the timeout on Postgres, which the
 * rewrite refuses to allow.
 */
export function renderStatementTimeoutSql(statementTimeoutMs: number): string {
  if (
    !Number.isFinite(statementTimeoutMs) ||
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1
  ) {
    // Defensive: config/load.ts enforces `min: 1`, but we don't trust
    // a caller who bypassed that path. Refuse to disable the timeout.
    statementTimeoutMs = 1;
  }
  return `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`;
}
