// Route table — pattern-match between `ParsedHttpRequest.action`
// and the handler that serves it. Adding a handler means adding a row here.

import type { HandlerContext } from '@/core/context';
import type { CloudRestError } from '@/core/errors';
import type { Result } from '@/core/result';
import type { Action, ParsedHttpRequest } from '@/http/request';
import { handleRead } from '@/handlers/read';
import { handleMutation } from '@/handlers/mutation';
import { handleRpc } from '@/handlers/rpc';
import { handleSchemaRoot } from '@/handlers/schema-root';

export type RouteHandler = (
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
) => Promise<Result<Response, CloudRestError>>;

/**
 * Pick the handler for a parsed request. Returns `null` when no
 * handler is registered for the action — the router treats that as
 * `PGRST501 Not implemented`.
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
    // Not yet implemented:
    case 'relationInfo':
    case 'routineInfo':
      return null;
  }
}
