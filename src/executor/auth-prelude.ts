// Per-request auth prelude: `SET LOCAL ROLE` + `request.jwt.*` GUCs.
//
// The REST path and the realtime poller both send the caller's
// resolved role and JWT claims through the same prelude.
// `context.auth.role` and `context.auth.claims` land in
// `SET LOCAL ROLE` and `set_config('request.jwt.claim.*', ..., true)`
// respectively — same shape PostgREST uses so RLS policies written
// against PostgREST work against CloudREST unchanged.
//
// Claim keys and values reach SQL via `set_config($1, $2, true)` with
// BOUND parameters. No user-controlled string is inlined. The only
// inlined value is the resolved role identifier, which is
// double-quote-escaped via `escapeIdent` — the same primitive the
// rest of the builder uses for schema-cache identifiers.
// `SET LOCAL ROLE` does NOT accept bind parameters at the protocol
// level; this is the one place in the executor where an identifier
// gets interpolated, so the role-validation rules
// (config.database.anonRole, JWT claim walker) are the gate.
//
// SECURITY: `escapeIdent` doubles internal quotes. A role name
// containing `"` still round-trips correctly. The role cannot
// contain a NUL byte because Postgres identifiers cannot, and the
// JWT claim walker already rejects non-string role values.

import type { AuthClaims } from '../auth/authenticate';
import { escapeIdent } from '../builder/identifiers';

export interface AuthPrelude {
  /** `SET LOCAL ROLE ...` statement, or null when no role should be issued. */
  readonly roleSql: string | null;
  /**
   * `SELECT set_config($1, $2, true), ...` wrapper with bound params
   * for every `request.jwt.*` GUC. Null when there are no claims
   * worth setting.
   */
  readonly claimsPreQuery:
    | { readonly sql: string; readonly params: readonly string[] }
    | null;
}

/**
 * Build the role + claims prelude for a given auth context. Returns
 * a structure the executor merges into `RunQueryOptions` before
 * `runTransaction` assembles its prelude batch.
 *
 * - `roleSql` is always rendered when `auth.role` is a non-empty
 *   string — even the anon role gets an explicit `SET LOCAL ROLE
 *   "anon"` so RLS policies can distinguish "anonymous but
 *   intentional" from "server-role fallback".
 * - `claimsPreQuery` is null when `auth.claims` is empty. Otherwise
 *   it emits one `set_config` per claim plus a `request.jwt.claims`
 *   entry carrying the whole payload as JSON (the form PostgREST
 *   RLS expressions usually read).
 */
export function buildAuthPrelude(auth: AuthClaims): AuthPrelude {
  const roleSql =
    auth.role.length > 0 ? `SET LOCAL ROLE ${escapeIdent(auth.role)}` : null;

  const pairs: [string, string][] = [];

  // PostgREST sets `request.jwt.claims` to the JSON-encoded
  // payload so RLS can read `current_setting('request.jwt.claims',
  // true)::jsonb ->> 'sub'`.
  if (Object.keys(auth.claims).length > 0) {
    pairs.push(['request.jwt.claims', JSON.stringify(auth.claims)]);
  }

  // PostgREST also splits out scalar top-level claims as
  // `request.jwt.claim.<key>` so older policies written against
  // individual GUCs keep working. Only string/number/boolean values
  // are exposed; objects/arrays stay in the full `claims` blob above.
  for (const [key, value] of Object.entries(auth.claims)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      pairs.push([`request.jwt.claim.${key}`, String(value)]);
    }
  }

  if (pairs.length === 0) {
    return { roleSql, claimsPreQuery: null };
  }

  const setConfigs: string[] = [];
  const params: string[] = [];
  for (const [key, value] of pairs) {
    const keyParam = `$${params.length + 1}`;
    params.push(key);
    const valueParam = `$${params.length + 1}`;
    params.push(value);
    setConfigs.push(`set_config(${keyParam}, ${valueParam}, true)`);
  }

  return {
    roleSql,
    claimsPreQuery: {
      sql: `SELECT ${setConfigs.join(', ')}`,
      params,
    },
  };
}
