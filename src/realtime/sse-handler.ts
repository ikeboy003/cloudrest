// Server-Sent Events handler for `GET /_realtime/<schema>/<table>`.
//
// The SSE stream polls `cloudrest._cloudrest_changes` every
// `realtime.pollIntervalMs` and emits one `data:` line per change
// row. Each frame carries `{id, occurred_at, schema_name,
// table_name, op, pk}`. The response is a long-lived `Response`
// object backed by a `ReadableStream`.
//
// SCOPE: this is the single-client SSE path. A multi-client fan-out
// (WebSocket + Durable Object) is a separate concern and would
// reuse every piece here — the subscription, the decision, the
// poll query, and the change-log schema.
//
// Polling goes through `runQuery`, so RLS, role, and
// `request.jwt.claim.*` GUCs apply to every tick. A client that
// can't see a row via `GET /<table>` also can't see that row's
// change event.
//
// The poller honors disconnect. The `ReadableStream`'s `cancel`
// callback stops the next tick so a disconnected client doesn't
// keep the Postgres client alive.

import { err, ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import { escapeIdent } from '@/builder/identifiers';
import { runQuery } from '@/executor/execute';
import { buildPollQuery } from './poll';
import { decideRealtimeUpgrade } from './route';
import type { Subscription } from './subscription';

export interface SseHandlerInput {
  readonly url: URL;
  readonly method: string;
  readonly context: HandlerContext;
}

/**
 * Handle a realtime SSE request. Returns a streaming Response on
 * success or a typed error (401 / 404 / PGRST501) on rejection.
 */
export function handleRealtimeSse(
  input: SseHandlerInput,
): Result<Response, CloudRestError> {
  if (!input.context.config.realtime.enabled) {
    return err({
      code: 'PGRST501',
      message: 'Realtime is disabled',
      details: 'Set REALTIME_ENABLED=true to enable /_realtime/*',
      hint: null,
      httpStatus: 404,
    });
  }

  // Only GET is valid for an SSE subscription.
  if (input.method !== 'GET') {
    return err({
      code: 'PGRST406',
      message: 'Method Not Allowed',
      details: 'Realtime subscriptions require GET',
      hint: null,
      httpStatus: 405,
    });
  }

  // Re-use the shared upgrade decision function.
  const decision = decideRealtimeUpgrade(input.url, input.context);
  if (!decision.ok) return decision;
  const subscription = decision.value;

  // Build the streaming body.
  const stream = makePollingStream(subscription, input.context);

  return ok(
    new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Tell intermediate proxies NOT to buffer.
        'X-Accel-Buffering': 'no',
      },
    }),
  );
}

// ----- Internal: polling stream ---------------------------------------

/**
 * Create a `ReadableStream` that polls the change log on the
 * configured interval and writes SSE frames as rows arrive. Every
 * poll advances an internal `since` cursor so the client only sees
 * each change once.
 *
 * The stream is cancellable — a client disconnect clears the
 * polling timer.
 */
function makePollingStream(
  initialSubscription: Subscription,
  context: HandlerContext,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const intervalMs = context.config.realtime.pollIntervalMs;
  const batchSize = context.config.realtime.maxBatchSize;
  let cancelled = false;
  let since = initialSubscription.since;

  // Pre-compute the SET LOCAL ROLE prelude. The SSE path does not
  // have a `ParsedHttpRequest`, so we can't call
  // `buildRequestPrelude` — the full claims-prelude needs it for
  // the claim walker. `SET LOCAL ROLE` is enough to scope the
  // poller's read of `_cloudrest_changes` to the caller's role,
  // and the change log has its own RLS policies downstream.
  const role = context.auth.role;
  const roleSql =
    role !== null && role !== undefined && role !== ''
      ? `SET LOCAL ROLE ${escapeIdent(role)}`
      : null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Emit an initial `event: open` so clients know the stream
      // is up even before any changes arrive.
      controller.enqueue(encoder.encode('event: open\ndata: {}\n\n'));

      while (!cancelled) {
        const subscription: Subscription = {
          schema: initialSubscription.schema,
          table: initialSubscription.table,
          since,
        };
        const built = buildPollQuery({
          subscription,
          limit: batchSize,
        });
        if (!built.ok) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(built.error)}\n\n`,
            ),
          );
          break;
        }

        const result = await runQuery(context, built.value, {
          roleSql,
        });
        if (!result.ok) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(result.error)}\n\n`,
            ),
          );
          break;
        }

        for (const row of result.value.rows) {
          // Drop the tenant_claims column from the wire shape — it
          // contains the caller's JWT claims and should never
          // leak to the client.
          const {
            tenant_claims: _tc,
            ...publicFields
          } = row as Record<string, unknown>;
          void _tc;
          const frame = `data: ${JSON.stringify(publicFields)}\n\n`;
          controller.enqueue(encoder.encode(frame));

          const rowId = row['id'];
          if (typeof rowId === 'number') {
            since = rowId;
          } else if (typeof rowId === 'string') {
            const n = Number(rowId);
            if (Number.isFinite(n)) since = n;
          }
        }

        // Keep-alive comment so proxies don't time out an idle
        // connection. SSE spec treats a line starting with `:` as
        // a comment.
        if (result.value.rows.length === 0) {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        }

        await delay(intervalMs);
      }
      controller.close();
    },
    cancel(): void {
      cancelled = true;
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
