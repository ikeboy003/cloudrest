// OpenAPI 3.0 document shape — the minimum subset the generator
// emits. Keeping the shape typed (instead of `any`) lets the
// generator's output be lint-checked for drift and gives consumers
// (the schema-root handler, admin tools) a stable contract.

export interface OpenApiDocument {
  readonly openapi: '3.0.3';
  readonly info: OpenApiInfo;
  readonly paths: Record<string, OpenApiPathItem>;
  readonly components: OpenApiComponents;
  readonly security: readonly Record<string, readonly unknown[]>[];
}

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly put?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
}

export interface OpenApiOperation {
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly summary?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Record<string, OpenApiResponse>;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'query' | 'header' | 'path';
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface OpenApiRequestBody {
  readonly required?: boolean;
  readonly content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiMediaType {
  readonly schema: JsonSchema;
}

export interface OpenApiComponents {
  readonly schemas: Record<string, JsonSchema>;
  readonly securitySchemes: Record<string, OpenApiSecurityScheme>;
}

export interface OpenApiSecurityScheme {
  readonly type: 'http';
  readonly scheme: 'bearer';
  readonly bearerFormat?: string;
  readonly description?: string;
}

/**
 * JSON Schema subset. We don't tighten it further because several
 * fields (`oneOf`, `items`, `properties`) recurse and narrow
 * `type: 'string'` literals are painful to widen later.
 */
export interface JsonSchema {
  readonly type?:
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array'
    | 'object';
  readonly format?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly items?: JsonSchema;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly oneOf?: readonly JsonSchema[];
  readonly nullable?: boolean;
  readonly $ref?: string;
}
