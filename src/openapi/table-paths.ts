// Build OpenAPI path items for a single table.
//
// Mirrors `buildTablePaths` from the old openapi.ts. Every table
// gets a `GET`/`POST`/`PATCH`/`PUT`/`DELETE` operation gated on the
// table's `insertable` / `updatable` / `deletable` flags. Column
// filters become query parameters, one per column.

import type { Table } from '@/schema/table';
import type { JsonSchema, OpenApiParameter, OpenApiPathItem } from './types';

// ----- Common parameter builders --------------------------------------

/**
 * Common GET/read query parameters: select, order, limit, offset,
 * range headers, and `Prefer`.
 */
const COMMON_GET_PARAMS: readonly OpenApiParameter[] = [
  {
    name: 'select',
    in: 'query',
    schema: { type: 'string' },
    description:
      'Columns and embedded resources to select, e.g. col1,col2,rel(*)',
  },
  {
    name: 'order',
    in: 'query',
    schema: { type: 'string' },
    description: 'Order by columns, e.g. col.desc.nullslast',
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer' },
    description: 'Maximum number of rows to return',
  },
  {
    name: 'offset',
    in: 'query',
    schema: { type: 'integer' },
    description: 'Number of rows to skip',
  },
  {
    name: 'Range',
    in: 'header',
    schema: { type: 'string' },
    description: 'Pagination range header, e.g. 0-9',
  },
  {
    name: 'Range-Unit',
    in: 'header',
    schema: { type: 'string' },
    description: 'Range unit (default: items)',
  },
  {
    name: 'Prefer',
    in: 'header',
    schema: { type: 'string' },
    description: 'Preferences: count=exact|planned|estimated, etc.',
  },
];

/** Per-column filter params — one entry per column on the table. */
function buildColumnFilterParams(table: Table): readonly OpenApiParameter[] {
  const out: OpenApiParameter[] = [];
  for (const [colName, col] of table.columns) {
    const baseDesc = `Filter on ${colName} (${col.type})`;
    const desc =
      col.description !== null
        ? `${baseDesc}: ${col.description}`
        : `${baseDesc}, e.g. eq.value, lt.10, in.(a,b)`;
    out.push({
      name: colName,
      in: 'query',
      schema: { type: 'string' },
      description: desc,
    });
  }
  return out;
}

// ----- Path builder ----------------------------------------------------

export interface TablePathsResult {
  readonly pathKey: string;
  readonly pathItem: OpenApiPathItem;
}

/**
 * Build the `/{table}` path item. The `schemaRef` argument points
 * at the component schema the generator put in `components.schemas`
 * — e.g. `#/components/schemas/public.books`.
 */
export function buildTablePaths(
  table: Table,
  schemaRef: string,
): TablePathsResult {
  const colFilterParams = buildColumnFilterParams(table);
  const tag = table.name;
  const itemSchema: JsonSchema = { $ref: schemaRef };
  const arraySchema: JsonSchema = { type: 'array', items: itemSchema };

  const path: OpenApiPathItem = {
    // GET — read
    get: {
      tags: [tag],
      operationId: `${table.name}_get`,
      summary:
        table.description !== null
          ? table.description
          : `Read rows from ${table.name}`,
      parameters: [...COMMON_GET_PARAMS, ...colFilterParams],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': { schema: arraySchema },
            'text/csv': { schema: { type: 'string' } },
            'application/vnd.pgrst.object+json': { schema: itemSchema },
          },
        },
        '206': { description: 'Partial Content (range request)' },
      },
    },
    // POST — create
    post: table.insertable
      ? {
          tags: [tag],
          operationId: `${table.name}_post`,
          summary: `Create rows in ${table.name}`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { oneOf: [itemSchema, arraySchema] },
              },
              'text/csv': { schema: { type: 'string' } },
            },
          },
          parameters: [
            {
              name: 'columns',
              in: 'query',
              schema: { type: 'string' },
              description: 'Columns to insert (comma-separated)',
            },
            {
              name: 'select',
              in: 'query',
              schema: { type: 'string' },
              description: 'Columns to return',
            },
            {
              name: 'Prefer',
              in: 'header',
              schema: { type: 'string' },
              description:
                'Preferences: return=representation|headers-only|minimal, resolution=merge-duplicates|ignore-duplicates',
            },
          ],
          responses: {
            '201': { description: 'Created' },
            '200': { description: 'OK (when returning representation)' },
          },
        }
      : undefined,
    // PATCH — update
    patch: table.updatable
      ? {
          tags: [tag],
          operationId: `${table.name}_patch`,
          summary: `Update rows in ${table.name}`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { oneOf: [itemSchema, arraySchema] },
              },
              'text/csv': { schema: { type: 'string' } },
            },
          },
          parameters: [
            ...colFilterParams,
            {
              name: 'columns',
              in: 'query',
              schema: { type: 'string' },
              description: 'Columns to update (comma-separated)',
            },
            {
              name: 'select',
              in: 'query',
              schema: { type: 'string' },
              description: 'Columns to return',
            },
            {
              name: 'Prefer',
              in: 'header',
              schema: { type: 'string' },
              description:
                'Preferences: return=representation|headers-only|minimal',
            },
          ],
          responses: {
            '200': { description: 'OK' },
            '204': { description: 'No Content' },
          },
        }
      : undefined,
    // PUT — single-row upsert
    put:
      table.insertable && table.primaryKeyColumns.length > 0
        ? {
            tags: [tag],
            operationId: `${table.name}_put`,
            summary: `Upsert a single row in ${table.name}`,
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: itemSchema },
              },
            },
            parameters: [
              {
                name: 'Prefer',
                in: 'header',
                schema: { type: 'string' },
                description:
                  'Preferences: return=representation|headers-only|minimal',
              },
            ],
            responses: {
              '200': { description: 'OK' },
              '201': { description: 'Created' },
              '204': { description: 'No Content' },
            },
          }
        : undefined,
    // DELETE
    delete: table.deletable
      ? {
          tags: [tag],
          operationId: `${table.name}_delete`,
          summary: `Delete rows from ${table.name}`,
          parameters: [
            ...colFilterParams,
            {
              name: 'select',
              in: 'query',
              schema: { type: 'string' },
              description: 'Columns to return',
            },
            {
              name: 'Prefer',
              in: 'header',
              schema: { type: 'string' },
              description:
                'Preferences: return=representation|headers-only|minimal',
            },
          ],
          responses: {
            '200': { description: 'OK' },
            '204': { description: 'No Content' },
          },
        }
      : undefined,
  };

  return {
    pathKey: `/${table.name}`,
    pathItem: path,
  };
}
