// Route table — pattern-match between `ParsedHttpRequest.action`
// and the handler that serves it.
//
// INVARIANT (CONSTITUTION §1.8): routes are a TABLE, not a nested
// if/switch. Adding a handler means adding a row here. Stage 8
// ships only the `relationRead` row; later stages fill in the rest.
//
// The route function shape matches every handler: `(httpRequest,
// context) → Promise<Result<Response, CloudRestError>>`. This is the
// contract PHASE_B Stage 8 pins.

import type { HandlerContext } from '../core/context';
import type { CloudRestError } from '../core/errors';
import type { Result } from '../core/result';
import type { Action, ParsedHttpRequest } from '../http/request';
import { handleRead } from '../handlers/read';
import { handleMutation } from '../handlers/mutation';
import { handleRpc } from '../handlers/rpc';
import { handleSchemaRoot } from '../handlers/schema-root';

export type RouteHandler = (
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
) => Promise<Result<Response, CloudRestError>>;

/**
 * Pick the handler for a parsed request. Returns `null` when no
 * handler is registered for the action — the router treats that as
 * `PGRST501 Not implemented`.
 *
 * Stage 8 wires only `relationRead`. Stage 9 adds `relationMut`,
 * Stage 10 adds `routineCall`, Stage 12 adds realtime.
 */
export function pickRoute(action: Action): RouteHandler | null {
  switch (action.type) {
    case 'relationRead':
      return handleRead;
    case 'relationMut':
      return handleMutation;
    case 'routineCall':
      return handleRpc;
    case 'schemaRead':
    case 'schemaInfo':
      return handleSchemaRoot;
    // Future stages fill these in:
    case 'relationInfo':
    case 'routineInfo':
      return null;
  }
}
