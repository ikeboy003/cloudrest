// HTTP request parsing — lifecycle step 2.
//
// Converts a raw `Request` into a typed `ParsedHttpRequest` containing
// everything the planner and handler need from HTTP: the resource type,
// the action, the schema, media-type decisions, preferences, range, and
// headers/cookies.
//
// INVARIANT: This module only touches HTTP semantics. It does NOT look
// up tables, columns, relationships, or routines — schema-aware
// validation is the planner's job (stage 6+).
//
// INVARIANT: The raw Request is never mutated. Every derived value is
// returned in the parsed shape.

import type { AppConfig } from '../config/schema';
import { err, ok, type Result } from '../core/result';
import { mediaErrors, parseErrors, type CloudRestError } from '../core/errors';
import { parseAcceptHeader, parseContentTypeHeader } from './media/parse';
import type { MediaType } from './media/types';
import { parsePrefer, type Preferences } from './preferences';
import { ALL_ROWS, parseRange, type NonnegRange } from './range';

// ----- Resource and action types ---------------------------------------

/** A schema-qualified table or routine name. */
export interface QualifiedIdentifier {
  readonly schema: string;
  readonly name: string;
}

/**
 * The resource the request is addressing: a schema root, a relation
 * (table/view), or a routine (`/rpc/...`).
 */
export type Resource =
  | { readonly type: 'schema' }
  | { readonly type: 'relation'; readonly name: string }
  | { readonly type: 'routine'; readonly name: string };

export type MutationKind = 'create' | 'update' | 'delete' | 'singleUpsert';
export type RoutineInvocation = 'invoke' | 'invokeRead';

/**
 * The action this request performs on the resource.
 * INVARIANT: Action shape is flat; handlers pattern-match on `type`.
 */
export type Action =
  | {
      readonly type: 'relationRead';
      readonly target: QualifiedIdentifier;
      readonly headersOnly: boolean;
    }
  | {
      readonly type: 'relationMut';
      readonly target: QualifiedIdentifier;
      readonly mutation: MutationKind;
    }
  | {
      readonly type: 'relationInfo';
      readonly target: QualifiedIdentifier;
    }
  | {
      readonly type: 'routineCall';
      readonly target: QualifiedIdentifier;
      readonly invocation: RoutineInvocation;
    }
  | {
      readonly type: 'routineInfo';
      readonly target: QualifiedIdentifier;
    }
  | {
      readonly type: 'schemaRead';
      readonly schema: string;
      readonly headersOnly: boolean;
    }
  | { readonly type: 'schemaInfo'; readonly schema: string };

// ----- Parsed HTTP request shape ---------------------------------------

/**
 * `ParsedHttpRequest` — the output of HTTP parsing (lifecycle step 2).
 *
 * Contains only HTTP-level facts. Query-param grammar and payload AST
 * are parsed in stage 4 and attached by the handler as separate fields.
 */
export interface ParsedHttpRequest {
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly schema: string;
  readonly negotiatedByProfile: boolean;
  readonly resource: Resource;
  readonly action: Action;
  readonly acceptMediaTypes: readonly MediaType[];
  readonly rawAcceptHeader: string;
  readonly contentMediaType: MediaType;
  readonly preferences: Preferences;
  readonly topLevelRange: NonnegRange;
  /** Lower-cased header pairs, cookies excluded. */
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly (readonly [string, string])[];
}

// ----- Public API ------------------------------------------------------

/**
 * Parse the raw HTTP request into a ParsedHttpRequest.
 *
 * Errors surface as `CloudRestError`: invalid path, unknown schema
 * profile, unsupported method for the resource, malformed Range header.
 */
export function parseHttpRequest(
  config: AppConfig,
  request: Request,
): Result<ParsedHttpRequest, CloudRestError> {
  const url = new URL(request.url);
  const method = request.method;
  const pathSegments = decodePathSegments(url.pathname);

  const resourceResult = resolveResource(pathSegments);
  if (!resourceResult.ok) return resourceResult;
  const resource = resourceResult.value;

  const schemaResult = resolveSchema(config, request.headers, method);
  if (!schemaResult.ok) return schemaResult;
  const { schema, negotiatedByProfile } = schemaResult.value;

  const actionResult = resolveAction(resource, schema, method);
  if (!actionResult.ok) return actionResult;
  const action = actionResult.value;

  const preferences = parsePrefer(request.headers, {
    allowTxOverride:
      config.database.txEnd === 'commit-allow-override' ||
      config.database.txEnd === 'rollback-allow-override',
  });

  const rangeResult = parseRange({
    method,
    headers: request.headers,
    limitOverride: ALL_ROWS,
  });
  if (!rangeResult.ok) return rangeResult;
  const topLevelRange = rangeResult.value;

  const { headers, cookies } = extractHeadersAndCookies(request.headers);

  const rawAcceptHeader = request.headers.get('accept') ?? '*/*';
  const acceptMediaTypes = parseAcceptHeader(rawAcceptHeader);
  if (acceptMediaTypes.length === 0) {
    return err(mediaErrors.notAcceptable(rawAcceptHeader));
  }

  const contentMediaType = parseContentTypeHeader(
    request.headers.get('content-type'),
  );

  return ok({
    method,
    url,
    path: url.pathname,
    schema,
    negotiatedByProfile,
    resource,
    action,
    acceptMediaTypes,
    rawAcceptHeader,
    contentMediaType,
    preferences,
    topLevelRange,
    headers,
    cookies,
  });
}

// ----- Internal helpers -------------------------------------------------

function decodePathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function resolveResource(
  segments: readonly string[],
): Result<Resource, CloudRestError> {
  if (segments.length === 0) return ok({ type: 'schema' });
  if (segments.length === 1) {
    const name = segments[0]!;
    return ok({ type: 'relation', name });
  }
  if (segments.length === 2 && segments[0] === 'rpc') {
    const name = segments[1]!;
    return ok({ type: 'routine', name });
  }
  return err(parseErrors.invalidResourcePath());
}

function resolveSchema(
  config: AppConfig,
  headers: Headers,
  method: string,
): Result<{ schema: string; negotiatedByProfile: boolean }, CloudRestError> {
  const isWrite = ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method);
  const headerName = isWrite ? 'content-profile' : 'accept-profile';
  const profileHeader = headers.get(headerName);

  if (profileHeader) {
    if (!config.database.schemas.includes(profileHeader)) {
      return err(
        mediaErrors.unacceptableSchema(profileHeader, config.database.schemas),
      );
    }
    return ok({ schema: profileHeader, negotiatedByProfile: true });
  }

  const first = config.database.schemas[0];
  if (first === undefined) {
    // INVARIANT: loadConfig always populates at least one schema.
    return err(parseErrors.invalidResourcePath());
  }
  return ok({
    schema: first,
    negotiatedByProfile: config.database.schemas.length !== 1,
  });
}

function resolveAction(
  resource: Resource,
  schema: string,
  method: string,
): Result<Action, CloudRestError> {
  const target = (name: string): QualifiedIdentifier => ({ schema, name });

  switch (resource.type) {
    case 'schema':
      switch (method) {
        case 'GET':
          return ok({ type: 'schemaRead', schema, headersOnly: false });
        case 'HEAD':
          return ok({ type: 'schemaRead', schema, headersOnly: true });
        case 'OPTIONS':
          return ok({ type: 'schemaInfo', schema });
        default:
          return err(parseErrors.unsupportedMethod(method));
      }
    case 'relation':
      switch (method) {
        case 'GET':
          return ok({
            type: 'relationRead',
            target: target(resource.name),
            headersOnly: false,
          });
        case 'HEAD':
          return ok({
            type: 'relationRead',
            target: target(resource.name),
            headersOnly: true,
          });
        case 'POST':
          return ok({
            type: 'relationMut',
            target: target(resource.name),
            mutation: 'create',
          });
        case 'PUT':
          return ok({
            type: 'relationMut',
            target: target(resource.name),
            mutation: 'singleUpsert',
          });
        case 'PATCH':
          return ok({
            type: 'relationMut',
            target: target(resource.name),
            mutation: 'update',
          });
        case 'DELETE':
          return ok({
            type: 'relationMut',
            target: target(resource.name),
            mutation: 'delete',
          });
        case 'OPTIONS':
          return ok({ type: 'relationInfo', target: target(resource.name) });
        default:
          return err(parseErrors.unsupportedMethod(method));
      }
    case 'routine':
      switch (method) {
        case 'GET':
        case 'HEAD':
          return ok({
            type: 'routineCall',
            target: target(resource.name),
            invocation: 'invokeRead',
          });
        case 'POST':
          return ok({
            type: 'routineCall',
            target: target(resource.name),
            invocation: 'invoke',
          });
        case 'OPTIONS':
          return ok({ type: 'routineInfo', target: target(resource.name) });
        default:
          return err(parseErrors.invalidRpcMethod(method));
      }
  }
}

function extractHeadersAndCookies(source: Headers): {
  headers: readonly (readonly [string, string])[];
  cookies: readonly (readonly [string, string])[];
} {
  const headers: (readonly [string, string])[] = [];
  const cookies: (readonly [string, string])[] = [];

  for (const [rawKey, value] of source.entries()) {
    const key = rawKey.toLowerCase();
    if (key === 'cookie') {
      for (const pair of value.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          cookies.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
        }
      }
    } else {
      headers.push([key, value]);
    }
  }

  return { headers, cookies };
}
