// Top-level HTTP dispatch — the Worker's `fetch` entry point.
//
// This file is the canonical router. It:
//   1. Loads config (once per isolate).
//   2. Parses the HTTP request (`http/request.ts`).
//   3. Authenticates.
//   4. Resolves the handler from the route table.
//   5. Invokes the handler with a populated `HandlerContext`.
//   6. Formats any `CloudRestError` into a final HTTP response.

import type { AppConfig } from '@/config/schema';
import type {
  HandlerContext,
  WorkerBindings,
  WorkerExecutionContext,
} from '@/core/context';
import type { CloudRestError } from '@/core/errors';
import { applyVerbosity } from '@/core/errors/types';
import { parseHttpRequest } from '@/http/request';
import { createRequestTimer } from '@/executor/timer';
import { authenticate } from '@/auth/authenticate';
import { pickRoute } from './routes';
import type { SchemaCache } from '@/schema/cache';
import { dispatchBatch } from '@/batch/dispatch';

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

  // 2. Authenticate.
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

  if (parsed.value.action.type === 'batchDispatch') {
    const batchResult = await dispatchBatch({
      request,
      context,
      transactional: parsed.value.action.transactional,
      inProcessDispatch: (subRequest) =>
        handleFetch(subRequest, bindings, executionContext, deps),
    });
    stopTotal();
    if (!batchResult.ok) {
      return formatError(batchResult.error, deps.config);
    }
    return batchResult.value;
  }

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
 * SECURITY:
 *  - `CLIENT_ERROR_VERBOSITY=minimal` applied via `applyVerbosity` —
 *    minimal strips `details` and `hint` so a public-facing deployment
 *    doesn't leak internal error detail.
 *  - `WWW-Authenticate: Bearer` challenge on the three auth codes
 *    PostgREST uses. The `error` / `error_description` parameters
 *    match RFC 6750 §3.
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
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
  });
  const challenge = bearerChallengeFor(effective);
  if (challenge !== null) {
    headers.set('WWW-Authenticate', challenge);
  }
  return new Response(body, {
    status: effective.httpStatus,
    headers,
  });
}

/**
 * Return the RFC 6750 Bearer challenge string for the auth-family
 * PGRST codes, or null for every other error.
 *
 * - `invalid_token`    for decode failures (PGRST301) and claim
 *                      problems / expired tokens (PGRST303).
 * - `insufficient_scope` for anonymous-access-disabled (PGRST302).
 *
 * The `error_description` parameter is escaped so embedded quotes
 * cannot break the header framing.
 */
function bearerChallengeFor(error: CloudRestError): string | null {
  let errorToken: string;
  switch (error.code) {
    case 'PGRST301':
    case 'PGRST303':
    case 'PGRST304':
      errorToken = 'invalid_token';
      break;
    case 'PGRST302':
      errorToken = 'insufficient_scope';
      break;
    default:
      return null;
  }
  const descr = error.message.replace(/["\\]/g, (c) => `\\${c}`);
  return `Bearer realm="cloudrest", error="${errorToken}", error_description="${descr}"`;
}
