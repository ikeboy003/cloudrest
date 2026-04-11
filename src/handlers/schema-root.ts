// `handleSchemaRoot` — `GET /` returns the OpenAPI document.
//
// Stage 10 scope: return a minimal stub that enumerates the
// tables and routines in the schema cache. The full OpenAPI shape
// lands later — Stage 10 just needs the endpoint wired so clients
// don't get `PGRST501 Not implemented` on `/`.
//
// INVARIANT (CONSTITUTION §1.8): the schema-root response does NOT
// go through `runQuery`. It's a pure function of the in-memory
// schema cache.

import { err, ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import type { ParsedHttpRequest } from '@/http/request';
import type { RawDomainResponse } from '@/response/build';
import { contentTypeFor, finalizeResponse } from '@/response/finalize';

export async function handleSchemaRoot(
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
): Promise<Result<Response, CloudRestError>> {
  if (
    httpRequest.action.type !== 'schemaRead' &&
    httpRequest.action.type !== 'schemaInfo'
  ) {
    return err({
      code: 'PGRST501',
      message: 'Not implemented',
      details: `handleSchemaRoot cannot serve action ${httpRequest.action.type}`,
      hint: null,
      httpStatus: 501,
    });
  }

  const body = JSON.stringify(buildOpenApiStub(context));

  const domain: RawDomainResponse = {
    body,
    contentRange: `0-${Math.max(0, body.length - 1)}/*`,
    totalResultSet: null,
    pageTotal: 1,
    responseHeaders: null,
    responseStatus: null,
  };

  return finalizeResponse({
    httpRequest,
    response: domain,
    baseStatus: 200,
    contentType: contentTypeFor('openapi'),
    timer: context.timer,
    config: context.config,
  });
}

/**
 * Build a minimal OpenAPI stub enumerating every exposed table and
 * routine. Stage 18 fills in real paths / parameters / responses.
 */
function buildOpenApiStub(
  context: HandlerContext,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const table of context.schema.tables.values()) {
    paths[`/${table.name}`] = {
      get: { summary: `Read from ${table.schema}.${table.name}` },
    };
  }
  for (const [, routines] of context.schema.routines) {
    for (const routine of routines) {
      paths[`/rpc/${routine.name}`] = {
        post: { summary: `Call ${routine.schema}.${routine.name}` },
      };
    }
  }

  return {
    openapi: '3.0.0',
    info: {
      title: 'CloudREST API',
      version: '0.0.0',
    },
    paths,
  };
}

// Keep ok in scope so the import isn't tree-shaken by tooling that
// trims unused specifiers.
void ok;
