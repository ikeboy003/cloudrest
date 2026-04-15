// Batch API dispatcher — `POST /_batch` and `POST /_batch/transaction`.
//
// SEMANTICS NOTE — `/_batch/transaction` vs `/_batch`:
//
//   Both endpoints dispatch operations sequentially through the
//   normal request pipeline (`inProcessDispatch`). Each operation
//   opens its own `postgres.js` client and runs inside its own DB
//   transaction — the rewrite's executor does not hold a
//   transaction open across handler calls because
//   `runQuery` tears down the client after every query (see
//   `executor/client.ts` for why this is mandatory under Workers).
//
//   The `transactional` flag therefore buys:
//     (a) ABORT-ON-FIRST-FAILURE — later ops are skipped when an
//         earlier op returns ≥ 400.
//     (b) `Prefer: return=representation` is forced on every op
//         so the reference resolver can read fields off each
//         response.
//     (c) Forward-only `$N.field` reference resolution across ops.
//
//   What it does NOT buy:
//     - Cross-op rollback. If op 0 creates a row and op 2 fails,
//       the row from op 0 remains committed.
//     - Repeatable-read isolation across ops.
//
//   A deployment that needs true cross-op atomicity should author
//   a Postgres function and call it via `POST /rpc/<name>`; that
//   runs under a single executor transaction.

import { err, ok, type Result } from '@/core/result';
import { makeError, type CloudRestError } from '@/core/errors/types';
import { parseErrors } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import { resolveReferences } from './refs';

export interface BatchOperation {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BatchResultEntry {
  readonly status: number;
  readonly body: unknown;
}

export interface BatchDispatchInput {
  readonly request: Request;
  readonly context: HandlerContext;
  /**
   * The in-process fetch handler. Batch operations re-enter the
   * router through this callback instead of a recursive Worker
   * fetch — no `module.default.fetch` in sight.
   */
  readonly inProcessDispatch: (subRequest: Request) => Promise<Response>;
  /** True = transactional semantics (abort on first failure, forward refs). */
  readonly transactional: boolean;
}

/**
 * Parse, validate, and execute a batch request. Returns:
 *   - `ok(Response)` on every path that should produce a
 *     well-formed HTTP response (success, partial failure, validated
 *     user error).
 *   - `err(CloudRestError)` for errors that propagate up the router
 *     stack (oversize body, invalid JSON).
 */
export async function dispatchBatch(
  input: BatchDispatchInput,
): Promise<Result<Response, CloudRestError>> {
  const { request, context, inProcessDispatch, transactional } = input;

  // Content-Length pre-check BEFORE buffering.
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const asNum = Number(contentLength);
    if (
      Number.isFinite(asNum) &&
      asNum > context.config.limits.maxBatchBodyBytes
    ) {
      return err(
        makeError({
          code: 'PGRST413',
          message: 'Batch body too large',
          details: `${asNum} > MAX_BATCH_BODY_BYTES ${context.config.limits.maxBatchBodyBytes}`,
          httpStatus: 413,
        }),
      );
    }
  }

  const raw = await request.text();
  if (
    new TextEncoder().encode(raw).length >
    context.config.limits.maxBatchBodyBytes
  ) {
    return err(
      makeError({
        code: 'PGRST413',
        message: 'Batch body too large',
        details: `encoded body exceeds MAX_BATCH_BODY_BYTES ${context.config.limits.maxBatchBodyBytes}`,
        httpStatus: 413,
      }),
    );
  }

  // Parse the JSON body. Accept either a bare array or an object
  // with an `operations` key (transaction form).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(parseErrors.invalidBody('Invalid JSON in batch request body'));
  }
  let operations: BatchOperation[];
  if (Array.isArray(parsed)) {
    operations = parsed as BatchOperation[];
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { operations?: unknown }).operations)
  ) {
    operations = (parsed as { operations: BatchOperation[] }).operations;
  } else {
    return err(
      parseErrors.invalidBody(
        'Batch body must be a JSON array or { "operations": [...] }',
      ),
    );
  }

  if (operations.length > context.config.limits.maxBatchOps) {
    return err(
      parseErrors.invalidBody(
        `Batch body exceeds maximum of ${context.config.limits.maxBatchOps} operations`,
      ),
    );
  }

  if (operations.length === 0) {
    return ok(emptyBatchResponse());
  }

  // Shape validation — every operation needs a method and path,
  // and cannot recurse into /_batch.
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    if (typeof op.method !== 'string' || op.method === '') {
      return err(
        parseErrors.invalidBody(
          `Batch operation at index ${i} is missing a valid "method"`,
        ),
      );
    }
    if (typeof op.path !== 'string' || op.path === '') {
      return err(
        parseErrors.invalidBody(
          `Batch operation at index ${i} is missing a valid "path"`,
        ),
      );
    }
    if (op.path.startsWith('/_batch')) {
      return err(
        parseErrors.invalidBody(
          `Batch operation at index ${i}: /_batch cannot be invoked recursively`,
        ),
      );
    }
  }

  const results: BatchResultEntry[] = [];
  const resolvedBodies: unknown[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;

    // Resolve `$N.field` references against previous results.
    const resolvedPath = await resolvePath(op.path, resolvedBodies, i);
    if (!resolvedPath.ok) return resolvedPath;
    const resolvedBody =
      op.body === undefined
        ? undefined
        : resolveReferences(op.body, resolvedBodies, i);
    if (resolvedBody !== undefined && !resolvedBody.ok) {
      return resolvedBody;
    }

    const subRequest = buildSubRequest(
      request,
      op,
      resolvedPath.value,
      resolvedBody !== undefined ? resolvedBody.value : undefined,
      transactional,
    );

    const subResponse = await inProcessDispatch(subRequest);
    const subBody = await readBody(subResponse);
    results.push({ status: subResponse.status, body: subBody });

    // Store the first row / whole object for reference resolution.
    resolvedBodies.push(normalizeForReference(subBody));

    if (transactional && subResponse.status >= 400) break;
  }

  const hasFailure = results.some((r) => r.status >= 400);
  const status = hasFailure ? 207 : 200;
  return ok(
    new Response(JSON.stringify(results), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ----- Helpers --------------------------------------------------------

function resolvePath(
  path: string,
  resolved: readonly unknown[],
  opIndex: number,
): Promise<Result<string, CloudRestError>> {
  const r = resolveReferences(path, resolved, opIndex);
  if (!r.ok) return Promise.resolve(r);
  if (typeof r.value !== 'string') {
    return Promise.resolve(
      err(
        parseErrors.invalidBody(
          `batch operation ${opIndex}: path references must resolve to a string`,
        ),
      ),
    );
  }
  return Promise.resolve(ok(r.value));
}

function buildSubRequest(
  parentRequest: Request,
  op: BatchOperation,
  resolvedPath: string,
  resolvedBody: unknown,
  transactional: boolean,
): Request {
  const base = 'https://cloudrest-batch.internal';
  const url = new URL(resolvedPath, base);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Forward auth / profile / preference headers from the parent
  // request — sub-operations run in the same identity context.
  for (const name of [
    'Authorization',
    'Accept-Profile',
    'Content-Profile',
    'Prefer',
    'Accept',
  ]) {
    const val = parentRequest.headers.get(name);
    if (val !== null) headers.set(name, val);
  }
  if (op.headers !== undefined) {
    for (const [k, v] of Object.entries(op.headers)) headers.set(k, v);
  }
  // Transactional form — force `return=representation` so the
  // reference resolver can read fields off every response.
  if (transactional) {
    const existing = headers.get('Prefer') ?? '';
    if (!existing.includes('return=')) {
      headers.set(
        'Prefer',
        existing === '' ? 'return=representation' : `${existing}, return=representation`,
      );
    }
  }

  const init: RequestInit = {
    method: op.method.toUpperCase(),
    headers,
  };
  if (resolvedBody !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body =
      typeof resolvedBody === 'string'
        ? resolvedBody
        : JSON.stringify(resolvedBody);
  }
  return new Request(url.toString(), init);
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function normalizeForReference(body: unknown): unknown {
  if (Array.isArray(body) && body.length > 0) return body[0];
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body;
  }
  return null;
}

function emptyBatchResponse(): Response {
  return new Response('[]', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
