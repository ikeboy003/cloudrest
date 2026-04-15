// Outbound webhook dispatch.
//
// INVARIANT: this module NEVER does DNS. The SSRF guard classifies
// on the URL form alone; a hostile server that answers with a
// private IP via CNAME would still resolve at the Workers edge,
// which bypasses our check. Redirects are disabled so that hop is
// also guarded.

import type { WorkerExecutionContext } from '@/core/context';
import { checkWebhookUrl } from './ssrf-guard';
import { signWebhook } from './sign';
import type { WebhookBinding } from './config';

export interface DispatchInput {
  readonly binding: WebhookBinding;
  readonly table: string;
  readonly mutation: string;
  /** Raw JSON body the receiver will see. */
  readonly body: string;
  /** HMAC secret. Null = no signature header. */
  readonly secret: string | null;
  /** Idempotency key — unique per logical event. */
  readonly idempotencyKey: string;
}

export interface DispatchResult {
  readonly ok: boolean;
  /** Reason the dispatch was refused BEFORE any network I/O. */
  readonly refusal: string | null;
}

const MAX_ATTEMPTS = 3;

/**
 * Dispatch a single webhook. The first attempt is awaited so the
 * caller sees any synchronous failure (URL rejected, HMAC
 * computation error). Any retries run under `ctx.waitUntil` so the
 * main response doesn't wait on the backoff.
 */
export async function dispatchWebhook(
  input: DispatchInput,
  executionContext: WorkerExecutionContext,
): Promise<DispatchResult> {
  const ssrf = checkWebhookUrl(input.binding.url);
  if (!ssrf.allowed) {
    return { ok: false, refusal: `ssrf:${ssrf.reason}` };
  }

  // Filter the body through the column allowlist when configured.
  const filteredBody = applyColumnAllowlist(
    input.body,
    input.binding.allowedColumns,
  );

  const timestamp = new Date().toISOString();
  const headers = await buildHeaders({
    secret: input.secret,
    timestamp,
    table: input.table,
    mutation: input.mutation,
    body: filteredBody,
    idempotencyKey: input.idempotencyKey,
    attempt: 1,
  });

  let firstResponse: Response | null = null;
  try {
    firstResponse = await fetch(input.binding.url, {
      method: 'POST',
      headers,
      body: filteredBody,
      redirect: 'manual',
    });
  } catch {
    // Network error on the first attempt — schedule retries under
    // waitUntil and return refusal=false so the caller knows the
    // immediate dispatch didn't succeed.
    scheduleRetries(input, filteredBody, timestamp, executionContext);
    return { ok: false, refusal: 'network-error' };
  }

  // 2xx / 3xx (redirect-manual gives us the 3xx) → done.
  if (firstResponse.status < 500 && firstResponse.status !== 429) {
    return { ok: firstResponse.ok, refusal: null };
  }

  // 5xx / 429 — schedule retries.
  scheduleRetries(input, filteredBody, timestamp, executionContext);
  return { ok: false, refusal: `status-${firstResponse.status}` };
}

// ----- Retries ---------------------------------------------------------

function scheduleRetries(
  input: DispatchInput,
  filteredBody: string,
  timestamp: string,
  ctx: WorkerExecutionContext,
): void {
  ctx.waitUntil(runRetries(input, filteredBody, timestamp));
}

async function runRetries(
  input: DispatchInput,
  filteredBody: string,
  timestamp: string,
): Promise<void> {
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const delay = 500 * 2 ** (attempt - 2); // 500ms, 1s, 2s
    await sleep(delay);
    const headers = await buildHeaders({
      secret: input.secret,
      timestamp,
      table: input.table,
      mutation: input.mutation,
      body: filteredBody,
      idempotencyKey: input.idempotencyKey,
      attempt,
    });
    try {
      const resp = await fetch(input.binding.url, {
        method: 'POST',
        headers,
        body: filteredBody,
        redirect: 'manual',
      });
      if (resp.status < 500 && resp.status !== 429) return;
    } catch {
      // keep retrying
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Headers + signing ----------------------------------------------

interface HeaderInput {
  readonly secret: string | null;
  readonly timestamp: string;
  readonly table: string;
  readonly mutation: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
}

async function buildHeaders(
  input: HeaderInput,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CloudREST-Table': input.table,
    'X-CloudREST-Mutation': input.mutation,
    'X-CloudREST-Timestamp': input.timestamp,
    'X-CloudREST-Idempotency-Key': input.idempotencyKey,
    'X-CloudREST-Attempt': String(input.attempt),
  };
  if (input.secret !== null) {
    const sig = await signWebhook({
      secret: input.secret,
      timestamp: input.timestamp,
      table: input.table,
      mutation: input.mutation,
      body: input.body,
    });
    headers['X-CloudREST-Signature'] = sig.header;
  }
  return headers;
}

// ----- Column allowlist ------------------------------------------------

/**
 * Filter the body so only allowlisted columns appear in each row.
 * The body is expected to be a JSON array (mutation result shape);
 * an empty allowlist is a no-op.
 */
function applyColumnAllowlist(
  body: string,
  allowed: readonly string[],
): string {
  if (allowed.length === 0) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed)) return body;
  const allowedSet = new Set(allowed);
  const filteredRows = parsed.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (allowedSet.has(k)) out[k] = v;
    }
    return out;
  });
  return JSON.stringify(filteredRows);
}

// ----- Fan-out helper --------------------------------------------------

/**
 * Dispatch every binding that matches `(table, mutation)`. Each
 * binding is independent — a refusal on one doesn't skip the
 * others. The caller uses this from the mutation handler after a
 * successful commit.
 */
export function dispatchMatchingWebhooks(input: {
  readonly bindings: readonly WebhookBinding[];
  readonly table: string;
  readonly mutation: 'create' | 'update' | 'delete' | 'upsert';
  readonly body: string;
  readonly secret: string | null;
  readonly idempotencyKey: string;
  readonly ctx: WorkerExecutionContext;
}): void {
  for (const binding of input.bindings) {
    if (binding.table !== input.table) continue;
    if (binding.mutation !== '*' && binding.mutation !== input.mutation) {
      continue;
    }
    // Fire-and-forget via waitUntil. Errors are absorbed inside
    // dispatchWebhook — nothing escapes this loop.
    input.ctx.waitUntil(
      dispatchWebhook(
        {
          binding,
          table: input.table,
          mutation: input.mutation,
          body: input.body,
          secret: input.secret,
          idempotencyKey: input.idempotencyKey,
        },
        input.ctx,
      ).then(() => undefined),
    );
  }
}
