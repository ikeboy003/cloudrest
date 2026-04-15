// Edge cache key derivation.
//
// INVARIANT: cache keys are PURE functions of `(request, config,
// auth)`. The cache layer never consults `context.bindings` at key-
// derivation time.

import type { AuthClaims } from '@/auth/authenticate';
import type { AppConfig } from '@/config/schema';
import type { ParsedHttpRequest } from '@/http/request';

// ----- Shape ----------------------------------------------------------

/**
 * A cache decision. `decision === 'skip'` means the request must
 * NOT be cached — the caller bypasses both read and write. A `key`
 * value is the stable string that both reads and writes use.
 */
export type CacheDecision =
  | { readonly decision: 'skip'; readonly reason: string }
  | { readonly decision: 'cache'; readonly key: string };

export interface CacheKeyInput {
  readonly httpRequest: ParsedHttpRequest;
  readonly config: AppConfig;
  readonly auth: AuthClaims;
}

// ----- Public API -----------------------------------------------------

/**
 * Decide whether to cache this request and, if so, compute the key.
 *
 * Preconditions:
 *  - the request MUST be a GET on a relation (mutations / RPC are
 *    never cached by this layer);
 *  - the table MUST be listed in `config.cache.tables`;
 *  - no pre-request hook may be configured.
 *
 * All three of those land as `'skip'` results with a human-readable
 * reason so a `?__cache=debug` knob can echo it back.
 */
export function deriveCacheDecision(input: CacheKeyInput): CacheDecision {
  const { httpRequest, config } = input;

  // Only relation reads are cacheable.
  if (httpRequest.action.type !== 'relationRead') {
    return { decision: 'skip', reason: 'not a relation read' };
  }
  if (httpRequest.action.headersOnly) {
    // HEAD requests still cacheable in principle; the finalizer
    // strips the body. We skip them to keep the code path narrow.
    return { decision: 'skip', reason: 'HEAD request' };
  }
  if (httpRequest.method !== 'GET') {
    return { decision: 'skip', reason: `method ${httpRequest.method}` };
  }

  // #33: any pre-request hook disables caching.
  if (config.database.preRequest !== null) {
    return { decision: 'skip', reason: 'preRequest hook configured' };
  }

  // #32: opt-in per table.
  const cacheConfig = config.cache;
  if (cacheConfig === undefined) {
    return { decision: 'skip', reason: 'cache not configured' };
  }
  const tableKey = `${httpRequest.action.target.schema}.${httpRequest.action.target.name}`;
  const tableEntry = cacheConfig.tables[tableKey];
  if (tableEntry === undefined) {
    return { decision: 'skip', reason: `table ${tableKey} not opted in` };
  }

  // #31: fingerprint role + every configured claim.
  const fingerprint = buildRoleFingerprint(input, tableEntry.claimsInKey);

  const key = composeKey({
    httpRequest,
    fingerprint,
  });
  return { decision: 'cache', key };
}

// ----- Helpers ---------------------------------------------------------

/**
 * Fold the caller's role and selected JWT claims into a stable
 * string. `null` values are encoded as the literal `"null"` so a
 * "claim present but null" case collides with neither "claim absent"
 * nor a real value of `"null"`.
 */
function buildRoleFingerprint(
  input: CacheKeyInput,
  claimsInKey: readonly string[],
): string {
  const parts: string[] = [`role=${input.auth.role}`];
  for (const claim of claimsInKey) {
    const value = input.auth.claims[claim];
    if (value === undefined) {
      parts.push(`${claim}=__missing__`);
    } else if (value === null) {
      parts.push(`${claim}=__null__`);
    } else if (typeof value === 'string') {
      parts.push(`${claim}=s:${value}`);
    } else {
      parts.push(`${claim}=j:${JSON.stringify(value)}`);
    }
  }
  return parts.join('\0');
}

/**
 * Build the final cache key string. Shape:
 *   `GET|<method>|<schema>.<relation>|<canonical-query>|<accept>|<range>|<fingerprint>`
 *
 * The canonical query comes from `parseQueryParams` — the parser
 * already sorts and normalizes it so two URLs with the same
 * semantic meaning share a key.
 */
function composeKey(input: {
  readonly httpRequest: ParsedHttpRequest;
  readonly fingerprint: string;
}): string {
  const { httpRequest, fingerprint } = input;
  if (httpRequest.action.type !== 'relationRead') {
    // deriveCacheDecision already guards this.
    return '';
  }
  const target = httpRequest.action.target;
  const accept = httpRequest.rawAcceptHeader;
  const rangeHeader =
    httpRequest.topLevelRange.limit === null
      ? `${httpRequest.topLevelRange.offset}-`
      : `${httpRequest.topLevelRange.offset}-${httpRequest.topLevelRange.offset + httpRequest.topLevelRange.limit - 1}`;
  return [
    httpRequest.method,
    `${target.schema}.${target.name}`,
    httpRequest.url.search,
    accept,
    rangeHeader,
    fingerprint,
  ].join('\0');
}
