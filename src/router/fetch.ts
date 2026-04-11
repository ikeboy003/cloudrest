// Top-level HTTP dispatch — the Worker's `fetch` entry point.
//
// INVARIANT (CONSTITUTION §1.8, PHASE_B Stage 8): this file is the
// canonical router. It:
//   1. Loads config (once per isolate).
//   2. Parses the HTTP request (`http/request.ts`).
//   3. Authenticates (Stage 8a stub → Stage 11 hardened).
//   4. Resolves the handler from the route table.
//   5. Invokes the handler with a populated `HandlerContext`.
//   6. Formats any `CloudRestError` into a final HTTP response.
//
// This file MUST stay under 200 lines. If a concern grows beyond a
// few lines, it moves to its own module. The old `index.ts` monolith
// is the anti-example.
//
// Stage 8 scope: happy path for `GET /{relation}` plus top-level
// error formatting. Stages 11/13/16 layer CORS, rate-limit, cache on
// top without changing this file's structure.

import type { AppConfig } from '../config/schema';
import type {
  HandlerContext,
  WorkerBindings,
  WorkerExecutionContext,
} from '../core/context';
import type { CloudRestError } from '../core/errors';
import { applyVerbosity } from '../core/errors/types';
import { parseHttpRequest } from '../http/request';
import { createRequestTimer } from '../executor/timer';
import { authenticate } from '../auth/authenticate';
import { pickRoute } from './routes';
import type { SchemaCache } from '../schema/cache';

export interface FetchDependencies {
  readonly config: AppConfig;
  readonly schema: SchemaCache;
}

/**
 * Handle one HTTP request. The `deps` argument carries pre-loaded
 * AppConfig and SchemaCache so tests can inject them directly
 * instead of wiring env parsing + KV coordinator.
 */
export async function handleFetch(
  request: Request,
  bindings: WorkerBindings,
  executionContext: WorkerExecutionContext,
  deps: FetchDependencies,
): Promise<Response> {
  const timer = createRequestTimer();
  const stopTotal = timer.start('total');

  // 1. HTTP parse.
  const stopParse = timer.start('parse');
  const parsed = parseHttpRequest(deps.config, request);
  stopParse();
  if (!parsed.ok) {
    stopTotal();
    return formatError(parsed.error, deps.config);
  }

  // 2. Authenticate (Stage 8a stub — see `src/auth/authenticate.ts`).
  const authResult = await authenticate(request.headers, deps.config);
  if (!authResult.ok) {
    stopTotal();
    return formatError(authResult.error, deps.config);
  }

  // 3. Build the handler context.
  const context: HandlerContext = {
    originalHttpRequest: request,
    executionContext,
    bindings,
    config: deps.config,
    schema: deps.schema,
    auth: authResult.value,
    timer,
  };

  // 4. Route.
  const handler = pickRoute(parsed.value.action);
  if (handler === null) {
    stopTotal();
    return formatError(
      {
        code: 'PGRST501',
        message: 'Not implemented',
        details: `no handler for action ${parsed.value.action.type}`,
        hint: null,
        httpStatus: 501,
      },
      deps.config,
    );
  }

  // 5. Invoke.
  const handlerResult = await handler(parsed.value, context);
  stopTotal();
  if (!handlerResult.ok) {
    return formatError(handlerResult.error, deps.config);
  }
  return handlerResult.value;
}

// ----- Error formatting ------------------------------------------------

/**
 * Render a `CloudRestError` as a JSON HTTP response. Every `Result`
 * failure in the pipeline flows through here; no handler returns a
 * raw `Response` for its own errors.
 *
 * Stage 11 widens this with:
 *  - `CLIENT_ERROR_VERBOSITY=minimal` — already applied below via
 *    `applyVerbosity`;
 *  - Bearer challenge headers on PGRST301/302/303.
 */
function formatError(error: CloudRestError, config: AppConfig): Response {
  const effective = applyVerbosity(
    error,
    config.observability.clientErrorVerbosity,
  );
  const body = JSON.stringify({
    code: effective.code,
    message: effective.message,
    details: effective.details,
    hint: effective.hint,
  });
  return new Response(body, {
    status: effective.httpStatus,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
