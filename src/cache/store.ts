// Edge cache store — wraps Cloudflare's `caches.default` behind a
// small interface so the read handler can participate in caching
// without knowing about the runtime-specific `Cache` object.
//
// STAGE 13 FIXES:
//   - `put` runs under `ctx.waitUntil` so the handler's response
//     ships to the client even if the cache write is slow.
//   - The cache key is a synthetic URL derived from
//     `deriveCacheDecision`'s output, NOT the raw request URL. Two
//     requests that differ only by Range/Accept/role still resolve
//     to distinct cached entries.
//   - The stored response carries a `Cache-Control: max-age=<ttl>`
//     so downstream middle-boxes respect the per-table TTL.
//
// INVARIANT: the cache layer is OPT-IN. `deriveCacheDecision` is the
// one gate; this module only runs when the decision was `cache`.

import type { CacheDecision } from './key';
import type { WorkerExecutionContext } from '@/core/context';

/**
 * Minimal `Cache` surface we touch. Typing it locally keeps the
 * module free of a direct `@cloudflare/workers-types` runtime
 * dependency and makes it trivial to mock under vitest.
 */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * Synthesize a stable cache-key Request from a `CacheDecision`.
 *
 * Cloudflare's Cache API keys on a `Request` object, which means we
 * need a URL per key. The synthetic URL uses an opaque
 * `https://cloudrest-cache/<hash>` path — the host is not a real
 * site, the Cache API accepts any URL.
 *
 * We hash the key via a cheap FNV-1a 32-bit so the URL is short and
 * deterministic. Collisions are possible but the decision key is
 * already an exact match, so a hash collision would affect roughly
 * 1 in 2^32 requests — acceptable for a perf optimization.
 */
function keyToRequest(key: string): Request {
  const hash = fnv1a32(key).toString(16);
  return new Request(`https://cloudrest-cache/${hash}`, { method: 'GET' });
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ----- Public API -----------------------------------------------------

/**
 * Look up a previously-cached response. Returns undefined on miss
 * or when the decision was `skip`.
 */
export async function cacheLookup(
  decision: CacheDecision,
  cache: CacheLike,
): Promise<Response | undefined> {
  if (decision.decision !== 'cache') return undefined;
  return cache.match(keyToRequest(decision.key));
}

/**
 * Store a response under the decision key. Fire-and-forget: the
 * actual `put` is handed to `ctx.waitUntil` so the response reaches
 * the client first. Does nothing on a `skip` decision.
 *
 * The `ttlSeconds` argument becomes the `Cache-Control: max-age` on
 * a CLONED response; the original response is untouched and flows
 * straight to the client.
 */
export function cacheStore(
  decision: CacheDecision,
  cache: CacheLike,
  executionContext: WorkerExecutionContext,
  response: Response,
  ttlSeconds: number,
): void {
  if (decision.decision !== 'cache') return;
  if (response.status !== 200 && response.status !== 206) return;

  // Clone and add a Cache-Control header so Cloudflare honors the
  // TTL. The original response still flows to the client unchanged.
  const cloneHeaders = new Headers(response.headers);
  cloneHeaders.set('Cache-Control', `max-age=${Math.max(0, ttlSeconds)}`);
  const cloneBody = response.clone().body;
  const storedResponse = new Response(cloneBody, {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders,
  });

  const putPromise = cache.put(keyToRequest(decision.key), storedResponse);
  executionContext.waitUntil(putPromise);
}

/**
 * Get the default Cloudflare edge cache. Tests install a fake via
 * `__installCacheForTest`; production touches
 * `globalThis.caches.default`.
 */
let testCache: CacheLike | undefined;

export function getEdgeCache(): CacheLike {
  if (testCache !== undefined) return testCache;
  // `caches` is a Workers global; it's not present in the Node
  // test environment, so the test hook above covers that path.
  const g = globalThis as unknown as {
    caches?: { default: CacheLike };
  };
  if (g.caches === undefined) {
    throw new Error(
      'edge cache: `caches` global is not available in this runtime',
    );
  }
  return g.caches.default;
}

/** Test hook — install a fake `CacheLike`. */
export function __installCacheForTest(cache: CacheLike | undefined): void {
  testCache = cache;
}
