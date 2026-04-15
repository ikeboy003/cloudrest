// Build OpenAPI path items for RPC routines.
//
// Mirrors `buildRoutinePaths` from the old openapi.ts. Every routine
// gets a `/rpc/{name}` path with a POST operation (and a GET for
// stable/immutable routines so they're discoverable without a body).
// Overloads collapse into a `oneOf` on the request body.

import type { Routine } from '@/schema/routine';
import type {
  JsonSchema,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
} from './types';
import { pgTypeToJsonSchema } from './column-schema';

export interface RpcPathsResult {
  readonly pathKey: string;
  readonly pathItem: OpenApiPathItem;
}

export function buildRpcPaths(overloads: readonly Routine[]): RpcPathsResult {
  const first = overloads[0]!;
  const pathKey = `/rpc/${first.name}`;
  const tag = 'RPC';

  // Build a oneOf over every overload's parameter object.
  const overloadSchemas: readonly JsonSchema[] = overloads.map((routine) => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const param of routine.params) {
      const base = pgTypeToJsonSchema(param.type);
      properties[param.name] = {
        ...base,
        description: `PostgreSQL type: ${param.type}`,
      };
      if (param.required) required.push(param.name);
    }
    const schema: JsonSchema = { type: 'object', properties };
    const withRequired =
      required.length > 0 ? { ...schema, required } : schema;
    return routine.description !== null
      ? { ...withRequired, description: routine.description }
      : withRequired;
  });

  const bodySchema: JsonSchema =
    overloadSchemas.length === 1
      ? overloadSchemas[0]!
      : { oneOf: overloadSchemas };

  // GET is only meaningful for stable/immutable routines — a volatile
  // function should be POST-only so it doesn't get cached.
  const stable = overloads.find((r) => r.volatility !== 'volatile');

  let get: OpenApiOperation | undefined;
  if (stable) {
    const parameters: OpenApiParameter[] = stable.params.map((p) => ({
      name: p.name,
      in: 'query',
      schema: pgTypeToJsonSchema(p.type),
      required: p.required,
      description: `PostgreSQL type: ${p.type}`,
    }));
    get = {
      tags: [tag],
      summary:
        stable.description !== null
          ? stable.description
          : `Call ${stable.name}`,
      parameters,
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': { schema: buildRpcResponseSchema(stable) },
          },
        },
      },
    };
  }

  const post: OpenApiOperation = {
    tags: [tag],
    summary:
      first.description !== null ? first.description : `Call ${first.name}`,
    requestBody: {
      required: false,
      content: { 'application/json': { schema: bodySchema } },
    },
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json': { schema: buildRpcResponseSchema(first) },
        },
      },
    },
  };

  return {
    pathKey,
    pathItem: get !== undefined ? { get, post } : { post },
  };
}

// ----- Return-type schema ---------------------------------------------

function buildRpcResponseSchema(routine: Routine): JsonSchema {
  const ret = routine.returnType;
  const pgType = ret.pgType;

  if (pgType.kind === 'scalar') {
    const scalarSchema = pgTypeToJsonSchema(pgType.qi.name);
    return ret.kind === 'single'
      ? scalarSchema
      : { type: 'array', items: scalarSchema };
  }

  // Composite. We don't have column details for the composite type
  // here (it's typically a table row-type or custom composite), so
  // emit an object with the composite name as description.
  const compositeSchema: JsonSchema = {
    type: 'object',
    description: `Composite type: ${pgType.qi.schema}.${pgType.qi.name}`,
  };
  return ret.kind === 'single'
    ? compositeSchema
    : { type: 'array', items: compositeSchema };
}
