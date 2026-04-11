// Per-request SQL prelude builder.
//
// Turns the authenticated `HandlerContext` into the three runQuery
// option slots the executor pipeline expects:
//
//   1. `roleSql`        — `SET LOCAL ROLE <role>`, built from
//                          `context.auth.role`. CONSTITUTION §1.3:
//                          the role is a configured identifier (from
//                          `DB_ANON_ROLE`, `DB_JWT_DEFAULT_ROLE`, or
//                          a JWT claim), so it is quoted with
//                          `escapeIdent` rather than bound — `SET
//                          LOCAL ROLE` does not accept placeholders.
//   2. `preQuerySql`    — the `request.jwt.claims` + per-claim
//                          `request.jwt.claim.<key>` + request
//                          metadata (`request.method`, `request.path`,
//                          `request.headers`, `request.cookies`)
//                          GUCs, rendered as a bound `set_config`
//                          batch. The executor `withAppSettings`
//                          helper concatenates this with the
//                          config-level `APP_SETTINGS` prelude.
//   3. `preRequestSql`  — `SELECT <schema>.<fn>()` when
//                          `DB_PRE_REQUEST` is configured. Parsed
//                          into schema/fn halves here so each
//                          identifier is quoted safely.
//
// INVARIANT: every value a client can influence (claim values,
// header values, cookie values) reaches Postgres via bind parameters,
// never by string interpolation. Keys are composed into the SQL
// because `set_config` needs a literal key per call, but the keys
// themselves are derived from the PostgREST convention
// (`request.jwt.claim.<key>`) — the user-influenced portion is the
// claim NAME, which we whitelist to `^[a-zA-Z_][a-zA-Z0-9_]*$` before
// inlining. Anything that fails the check is silently skipped — the
// query still runs; policies that depend on that specific claim
// shape simply don't see it, which is strictly safer than injecting
// it.

import { escapeIdent } from '@/builder/identifiers';
import type { AppConfig } from '@/config/schema';
import type { AuthClaims } from '@/auth/authenticate';
import type { ParsedHttpRequest } from '@/http/request';

export interface RequestPrelude {
  readonly roleSql: string | null;
  readonly preQuerySql:
    | { readonly sql: string; readonly params: readonly unknown[] }
    | null;
  readonly preRequestSql: string | null;
}

/**
 * Build the per-request SQL prelude pieces for `runQuery`.
 *
 * The caller passes the already-authenticated `AuthClaims` plus the
 * config and parsed HTTP request. Every slot is optional: a field is
 * `null` when there is nothing to issue, and the executor skips the
 * corresponding step.
 */
export function buildRequestPrelude(input: {
  readonly auth: AuthClaims;
  readonly config: AppConfig;
  readonly httpRequest: ParsedHttpRequest;
}): RequestPrelude {
  const { auth, config, httpRequest } = input;

  return {
    roleSql: renderRoleSql(auth.role),
    preQuerySql: renderClaimsPrelude(auth, httpRequest),
    preRequestSql: renderPreRequestSql(config.database.preRequest),
  };
}

// ----- role ------------------------------------------------------------

function renderRoleSql(role: string | null | undefined): string | null {
  if (role === null || role === undefined || role === '') return null;
  // `SET LOCAL ROLE` does not accept bind parameters; the role is a
  // server-side identifier. We quote it with `escapeIdent` — the same
  // helper every other identifier flows through (CONSTITUTION §1.4).
  return `SET LOCAL ROLE ${escapeIdent(role)}`;
}

// ----- claims + request metadata --------------------------------------

// A claim-name must look like a plain identifier before we embed it
// in a `request.jwt.claim.<key>` GUC. Anything else is dropped.
const CLAIM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface SetConfigPair {
  readonly key: string;
  readonly value: string;
}

function renderClaimsPrelude(
  auth: AuthClaims,
  httpRequest: ParsedHttpRequest,
): { readonly sql: string; readonly params: readonly unknown[] } | null {
  const pairs: SetConfigPair[] = [];

  // 1. The full claims blob — `current_setting('request.jwt.claims')`
  //    is how PostgREST policies typically read claims.
  const claimsJson = safeStringify(auth.claims);
  if (claimsJson !== null) {
    pairs.push({ key: 'request.jwt.claims', value: claimsJson });
  }

  // 2. Role as its own GUC for policies that key off
  //    `current_setting('request.jwt.claim.role')`.
  if (auth.role) {
    pairs.push({ key: 'request.jwt.claim.role', value: auth.role });
  }

  // 3. Per-claim GUCs — only stringy scalars. Nested objects,
  //    arrays, and non-identifier keys are skipped.
  for (const [rawKey, rawValue] of Object.entries(auth.claims)) {
    if (!CLAIM_NAME_RE.test(rawKey)) continue;
    const value = stringifyScalarClaim(rawValue);
    if (value === null) continue;
    pairs.push({ key: `request.jwt.claim.${rawKey}`, value });
  }

  // 4. Request metadata — method + path, header bag, cookie bag.
  pairs.push({ key: 'request.method', value: httpRequest.method });
  pairs.push({ key: 'request.path', value: httpRequest.path });
  const headersJson = safeStringify(Object.fromEntries(httpRequest.headers));
  if (headersJson !== null) {
    pairs.push({ key: 'request.headers', value: headersJson });
  }
  const cookiesJson = safeStringify(Object.fromEntries(httpRequest.cookies));
  if (cookiesJson !== null) {
    pairs.push({ key: 'request.cookies', value: cookiesJson });
  }

  if (pairs.length === 0) return null;

  // Render as one multi-call SELECT so postgres.js executes it in
  // one round-trip. Every key and value flows through bind params.
  const selects: string[] = [];
  const params: string[] = [];
  for (const pair of pairs) {
    const keyParam = `$${params.length + 1}`;
    params.push(pair.key);
    const valueParam = `$${params.length + 1}`;
    params.push(pair.value);
    selects.push(`set_config(${keyParam}, ${valueParam}, true)`);
  }
  return { sql: `SELECT ${selects.join(', ')}`, params };
}

function stringifyScalarClaim(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ----- pre-request function -------------------------------------------

/**
 * Render `DB_PRE_REQUEST` as a quoted `SELECT schema.fn()`. Accepts
 * either `schema.fn` or a bare `fn` — the latter relies on the
 * `search_path` set by `buildAppSettingsPrelude`.
 */
function renderPreRequestSql(preRequest: string | null): string | null {
  if (preRequest === null || preRequest === '') return null;
  const dot = preRequest.indexOf('.');
  if (dot === -1) {
    return `SELECT ${escapeIdent(preRequest)}()`;
  }
  const schema = preRequest.slice(0, dot);
  const fn = preRequest.slice(dot + 1);
  return `SELECT ${escapeIdent(schema)}.${escapeIdent(fn)}()`;
}
