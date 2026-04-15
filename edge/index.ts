// Edge cache worker — runs at the user's nearest PoP.
//
// No auth, no DB, no schema. Just cache lookup/store and proxy
// to the DB worker on MISS. Mutations (POST/PATCH/DELETE) always
// bypass the cache and proxy directly.

interface Env {
  DB_WORKER_URL: string;
  CACHE_TTL: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const method = request.method;
    const isRead = method === 'GET' || method === 'HEAD';

    // Mutations always bypass cache
    if (!isRead) {
      return proxyToOrigin(request, env);
    }

    // Skip cache for authorized requests — RLS means different
    // users see different data. Let the DB worker handle it.
    if (request.headers.get('Authorization')) {
      return proxyToOrigin(request, env);
    }

    const cache = caches.default;
    const cacheKey = buildCacheKey(request);

    // Cache lookup
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-Cache', 'HIT');
      resp.headers.set('X-Edge-PoP', request.cf?.colo as string ?? 'unknown');
      return resp;
    }

    // Cache MISS — proxy to DB worker
    const origin = await proxyToOrigin(request, env);

    // Only cache successful GET responses
    if (origin.status >= 200 && origin.status < 300) {
      const ttl = parseInt(env.CACHE_TTL || '60', 10);
      const toCache = origin.clone();
      const headers = new Headers(toCache.headers);
      headers.set('Cache-Control', `public, max-age=${ttl}`);
      const stored = new Response(toCache.body, {
        status: toCache.status,
        headers,
      });
      ctx.waitUntil(cache.put(cacheKey, stored));
    }

    const resp = new Response(origin.body, origin);
    resp.headers.set('X-Cache', 'MISS');
    resp.headers.set('X-Edge-PoP', request.cf?.colo as string ?? 'unknown');
    return resp;
  },
};

function proxyToOrigin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = new URL(env.DB_WORKER_URL);
  url.hostname = origin.hostname;
  url.protocol = origin.protocol;
  return fetch(new Request(url.toString(), request));
}

function buildCacheKey(request: Request): Request {
  const url = new URL(request.url);
  // Sort query params for canonical form
  const sorted = new URLSearchParams([...url.searchParams.entries()].sort());
  url.search = sorted.toString();
  // Vary by Accept header so JSON/CSV don't collide
  const accept = request.headers.get('Accept') || '';
  if (accept) url.searchParams.set('_cr_accept', accept);
  return new Request(url.toString(), { method: 'GET' });
}
