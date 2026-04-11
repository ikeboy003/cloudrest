// CORS — preflight handling + `Access-Control-*` response headers.
//
// STAGE 16 FIXES (critiques #54, #55):
//   #54 — preflight requests return 403 when `cors.allowedOrigins`
//         is null. The old code's "missing config means allow" was
//         a security mis-default.
//   #55 — `Vary: Origin` is emitted on every non-wildcard response
//         regardless of the `credentials` flag. Without Vary,
//         intermediary caches serve the wrong Allow-Origin to the
//         wrong client.
//
// INVARIANT (CONSTITUTION §10.1): CORS is OPT-IN. A deployment
// with no `CORS_ALLOWED_ORIGINS` env var gets NO cross-origin
// access — every preflight returns 403.

import type { CorsConfig } from '@/config/schema';

export interface CorsDecision {
  readonly allowed: boolean;
  /** Resolved Allow-Origin value: the request origin, `*`, or null. */
  readonly allowOrigin: string | null;
  /** Whether `Vary: Origin` must appear on the response. */
  readonly vary: boolean;
}

/**
 * Decide whether to allow a cross-origin request and what
 * `Access-Control-Allow-Origin` value to emit.
 *
 * - `cors.allowedOrigins === null` → deny.
 * - `['*']` → wildcard, no Vary needed.
 * - explicit list → echo the matching origin and set Vary.
 */
export function decideCors(
  cors: CorsConfig,
  requestOrigin: string | null,
): CorsDecision {
  if (cors.allowedOrigins === null) {
    return { allowed: false, allowOrigin: null, vary: false };
  }
  if (cors.allowedOrigins.length === 1 && cors.allowedOrigins[0] === '*') {
    return { allowed: true, allowOrigin: '*', vary: false };
  }
  if (requestOrigin === null) {
    // A same-origin request or a non-browser client — CORS rules
    // don't apply. Leave the headers alone.
    return { allowed: true, allowOrigin: null, vary: true };
  }
  if (cors.allowedOrigins.includes(requestOrigin)) {
    return { allowed: true, allowOrigin: requestOrigin, vary: true };
  }
  return { allowed: false, allowOrigin: null, vary: true };
}

/**
 * Render a preflight response. Callers pass a `decideCors` result
 * and the method/headers the client requested. A denied decision
 * becomes a bare 403.
 */
export function renderPreflight(
  decision: CorsDecision,
  requestedMethod: string | null,
  requestedHeaders: string | null,
): Response {
  if (!decision.allowed) {
    return new Response(null, { status: 403 });
  }
  const headers = new Headers();
  if (decision.allowOrigin !== null) {
    headers.set('Access-Control-Allow-Origin', decision.allowOrigin);
  }
  if (decision.vary) {
    headers.set('Vary', 'Origin');
  }
  headers.set(
    'Access-Control-Allow-Methods',
    requestedMethod ?? 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS',
  );
  headers.set(
    'Access-Control-Allow-Headers',
    requestedHeaders ?? 'Authorization, Content-Type, Prefer, Range',
  );
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/**
 * Mutate a non-preflight response's headers in place to add the
 * CORS bits. Called from `router/fetch.ts` right before the
 * response leaves the router.
 */
export function applyCorsToResponse(
  response: Response,
  decision: CorsDecision,
): Response {
  if (!decision.allowed || decision.allowOrigin === null) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', decision.allowOrigin);
  if (decision.vary) {
    const existing = headers.get('Vary');
    if (existing === null) {
      headers.set('Vary', 'Origin');
    } else if (!existing.split(',').map((s) => s.trim()).includes('Origin')) {
      headers.set('Vary', `${existing}, Origin`);
    }
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
