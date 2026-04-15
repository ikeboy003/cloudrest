// Realtime upgrade decision.
//
// Auth runs BEFORE the upgrade so a request with a bogus Bearer
// token is rejected before the socket is opened. The DO name
// includes `schema.table` so two schemas with same-named tables
// don't collide, and the subscription is validated against the
// schema cache at upgrade time — a request for a non-exposed table
// is refused with PGRST205, not deferred to the poller.
//
// This module does NOT do the actual WebSocket / SSE upgrade —
// that belongs at the runtime edge (the Worker entry point,
// `handleFetch`) because it needs the raw `Request` and the
// Cloudflare runtime's `WebSocketPair`. The module here is a pure
// decision function: "can this request open a realtime stream
// for this subscription?".

import { err, ok, type Result } from '@/core/result';
import { authErrors, schemaErrors, type CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import type { Subscription } from './subscription';
import { parseSubscriptionFromUrl } from './subscription';
import { findTable } from '@/schema/cache';

export interface RealtimeAccept {
  readonly kind: 'accept';
  readonly subscription: Subscription;
}

export type RealtimeDecision =
  | RealtimeAccept
  | { readonly kind: 'reject'; readonly error: CloudRestError };

/**
 * Classify a realtime-upgrade request.
 *
 * - Returns `accept` with the validated subscription when the
 *   request can proceed to upgrade the socket (or begin the SSE
 *   stream).
 * - Returns `reject` with a typed error when auth fails, the URL
 *   shape is invalid, or the subscription targets a non-exposed
 *   table.
 */
export function decideRealtimeUpgrade(
  url: URL,
  context: HandlerContext,
): Result<Subscription, CloudRestError> {
  // Auth check. `context.auth` is populated by the auth pipeline
  // before we get here; re-verify that the role is non-empty (anon
  // subscriptions are allowed iff `database.anonRole` is set).
  if (!context.auth.role || context.auth.role === '') {
    return err(authErrors.jwtTokenRequired());
  }

  const subscription = parseSubscriptionFromUrl(url);
  if (subscription === null) {
    return err(
      schemaErrors.tableNotFound(url.pathname, '', null),
    );
  }

  // Validate against the schema cache.
  const table = findTable(context.schema, {
    schema: subscription.schema,
    name: subscription.table,
  });
  if (table === undefined) {
    return err(
      schemaErrors.tableNotFound(
        subscription.table,
        subscription.schema,
        null,
      ),
    );
  }

  // The DO key derivation happens inside `subscriptionDoKey`
  // (called by the Durable Object binding code elsewhere). We
  // only return the validated subscription here; the caller is
  // responsible for handing it to `env.REALTIME_DO.get(...)`.
  return ok(subscription);
}
