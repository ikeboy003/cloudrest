// OpenAPI 3.0 document generator.
//
// Pure function of `(SchemaCache, AppConfig) → OpenApiDocument`.
// Called by `handlers/schema-root.ts` to answer `GET /`.
//
// INVARIANT: NO database access. The schema cache is the only source
// of truth; the generator never reaches into `runQuery`.

import type { AppConfig } from '@/config/schema';
import type { SchemaCache } from '@/schema/cache';
import { columnToJsonSchema } from './column-schema';
import { buildRpcPaths } from './rpc-paths';
import { buildTablePaths } from './table-paths';
import type {
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiResponse,
} from './types';

// ----- Constants ------------------------------------------------------

const CLOUDREST_ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'Machine-readable error code (PGRST1XX, SQLSTATE, etc.)',
    },
    message: {
      type: 'string',
      description: 'Human-readable error message',
    },
    details: {
      type: 'string',
      nullable: true,
      description: 'Additional detail about the error',
    },
    hint: {
      type: 'string',
      nullable: true,
      description: 'Suggestion for resolving the error',
    },
  },
  required: ['code', 'message'],
};

const STANDARD_ERROR_RESPONSES: Record<string, OpenApiResponse> = {
  '400': {
    description: 'Bad Request',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '401': {
    description: 'Unauthorized — JWT missing or invalid',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '403': {
    description: 'Forbidden — insufficient privilege',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '404': {
    description: 'Not Found — table, function, or resource not found',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '406': {
    description: 'Not Acceptable — media type or schema not available',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '409': {
    description: 'Conflict — unique or foreign key violation',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
  '500': {
    description: 'Internal Server Error',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CloudRestError' },
      },
    },
  },
};

// ----- Public API ------------------------------------------------------

export function generateOpenApiDocument(
  schema: SchemaCache,
  config: AppConfig,
): OpenApiDocument {
  const componentSchemas: Record<string, JsonSchema> = {
    CloudRestError: CLOUDREST_ERROR_SCHEMA,
  };
  const paths: Record<string, OpenApiPathItem> = {};

  const multipleSchemas = config.database.schemas.length > 1;
  const profileParams: readonly OpenApiParameter[] = multipleSchemas
    ? [
        {
          name: 'Accept-Profile',
          in: 'header',
          schema: { type: 'string' },
          description: 'Request schema',
        },
        {
          name: 'Content-Profile',
          in: 'header',
          schema: { type: 'string' },
          description: 'Request schema for write operations',
        },
      ]
    : [];

  // ----- Tables -------------------------------------------------------
  for (const table of schema.tables.values()) {
    const componentKey = `${table.schema}.${table.name}`;
    componentSchemas[componentKey] = buildTableSchemaComponent(table);
    const { pathKey, pathItem } = buildTablePaths(
      table,
      `#/components/schemas/${componentKey}`,
    );
    paths[pathKey] = withStandardErrorsAndProfiles(
      pathItem,
      profileParams,
    );
  }

  // ----- Routines ------------------------------------------------------
  for (const [, overloads] of schema.routines) {
    if (overloads.length === 0) continue;
    const { pathKey, pathItem } = buildRpcPaths(overloads);
    if (paths[pathKey] !== undefined) {
      // Shouldn't happen for RPC paths — but merge rather than
      // clobber so two overload groups don't silently lose data.
      paths[pathKey] = mergePathItems(paths[pathKey]!, pathItem);
    } else {
      paths[pathKey] = withStandardErrorsAndProfiles(
        pathItem,
        profileParams,
      );
    }
  }

  // ----- Root path ----------------------------------------------------
  paths['/'] = withStandardErrorsAndProfiles(
    {
      get: {
        tags: ['Introspection'],
        operationId: 'root_get',
        summary: 'OpenAPI specification for this API',
        parameters: [
          {
            name: 'Accept',
            in: 'header',
            schema: { type: 'string' },
            description:
              'application/openapi+json or application/json',
          },
        ],
        responses: {
          '200': {
            description: 'OpenAPI 3.0 specification',
            content: {
              'application/openapi+json': { schema: {} },
              'application/json': { schema: {} },
            },
          },
        },
      },
    },
    [],
  );

  // ----- Security schemes ---------------------------------------------
  const hasJwt = config.auth.jwtSecret !== null;
  const securitySchemes: Record<
    string,
    import('./types').OpenApiSecurityScheme
  > = {};
  if (hasJwt) {
    securitySchemes['JWT'] = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Roles are determined by the jwt.role claim',
    };
  }
  const security = hasJwt ? [{ JWT: [] }] : [];

  return {
    openapi: '3.0.3',
    info: {
      title: 'CloudREST API',
      version: '1.0.0',
      description:
        'Auto-generated from database schema. Use the Accept-Profile / Content-Profile headers to switch schemas.',
    },
    paths,
    components: { schemas: componentSchemas, securitySchemes },
    security,
  };
}

// ----- Helpers ---------------------------------------------------------

function buildTableSchemaComponent(
  table: import('@/schema/table').Table,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [colName, col] of table.columns) {
    const baseSchema = columnToJsonSchema(col);
    const withDefault =
      col.defaultValue !== null
        ? { ...baseSchema, default: col.defaultValue }
        : baseSchema;
    properties[colName] = withDefault;
    // A column is required in POST bodies when it is NOT nullable
    // and has no default value. DB-generated defaults (serial,
    // identity, now()) are considered defaults so the client can
    // omit them.
    if (!col.nullable && col.defaultValue === null) {
      required.push(colName);
    }
  }

  const schema: JsonSchema = { type: 'object', properties };
  const withRequired =
    required.length > 0 ? { ...schema, required } : schema;
  return table.description !== null
    ? { ...withRequired, description: table.description }
    : withRequired;
}

/**
 * Inject the shared error responses and profile params into every
 * operation on a path item. Used so every path item shares the same
 * 400/401/.../500 contract without the generator typing it out per
 * operation.
 */
function withStandardErrorsAndProfiles(
  path: OpenApiPathItem,
  profileParams: readonly OpenApiParameter[],
): OpenApiPathItem {
  const rewritten: Record<string, OpenApiOperation> = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const op = path[method];
    if (op === undefined) continue;
    rewritten[method] = withStandardErrorsAndProfileParams(op, profileParams);
  }
  return rewritten as OpenApiPathItem;
}

function withStandardErrorsAndProfileParams(
  op: OpenApiOperation,
  profileParams: readonly OpenApiParameter[],
): OpenApiOperation {
  const responses: Record<string, OpenApiResponse> = { ...op.responses };
  for (const [code, resp] of Object.entries(STANDARD_ERROR_RESPONSES)) {
    if (responses[code] === undefined) responses[code] = resp;
  }
  const parameters =
    profileParams.length > 0
      ? [...(op.parameters ?? []), ...profileParams]
      : op.parameters;
  return { ...op, parameters, responses };
}

/** Shallow-merge two path items — used for overload-group collisions. */
function mergePathItems(
  a: OpenApiPathItem,
  b: OpenApiPathItem,
): OpenApiPathItem {
  return { ...a, ...b };
}
