// Map a Postgres column type to a JSON Schema fragment.
//
// Mirrors `colTypeToJsonSchema` from the old openapi.ts. The mapping
// is a switch on lowercased, canonical type names — the same set
// PostgREST recognizes. Unknown types fall through to `string`,
// which is PostgREST's behavior.
//
// INVARIANT: This function is PURE. It does not consult the schema
// cache beyond the column it was handed.

import type { Column } from '@/schema/table';
import type { JsonSchema } from './types';

const INT32_TYPES = new Set([
  'int2',
  'int4',
  'integer',
  'smallint',
  'serial',
  'serial4',
]);
const INT64_TYPES = new Set(['int8', 'bigint', 'bigserial', 'serial8']);
const FLOAT32_TYPES = new Set(['float4', 'real']);
const FLOAT64_TYPES = new Set(['float8', 'double precision']);
const DECIMAL_TYPES = new Set(['numeric', 'decimal', 'money']);
const BOOL_TYPES = new Set(['bool', 'boolean']);
const TIMESTAMP_TYPES = new Set([
  'timestamp',
  'timestamptz',
  'timestamp with time zone',
  'timestamp without time zone',
]);
const TIME_TYPES = new Set([
  'time',
  'timetz',
  'time with time zone',
  'time without time zone',
]);
const JSON_TYPES = new Set(['json', 'jsonb']);

export function columnToJsonSchema(col: Column): JsonSchema {
  const t = col.type.toLowerCase();

  // Enums always win over the base type.
  if (col.enumValues.length > 0) {
    const schema: JsonSchema = {
      type: 'string',
      enum: [...col.enumValues],
    };
    return col.description !== null
      ? { ...schema, description: col.description }
      : schema;
  }

  const base = resolveBase(t, col);
  return col.description !== null
    ? { ...base, description: col.description }
    : base;
}

function resolveBase(t: string, col: Column): JsonSchema {
  if (INT32_TYPES.has(t)) return { type: 'integer', format: 'int32' };
  if (INT64_TYPES.has(t)) return { type: 'integer', format: 'int64' };
  if (FLOAT32_TYPES.has(t)) return { type: 'number', format: 'float' };
  if (FLOAT64_TYPES.has(t)) return { type: 'number', format: 'double' };
  if (DECIMAL_TYPES.has(t)) return { type: 'number' };
  if (BOOL_TYPES.has(t)) return { type: 'boolean' };
  if (t === 'date') return { type: 'string', format: 'date' };
  if (TIMESTAMP_TYPES.has(t)) return { type: 'string', format: 'date-time' };
  if (TIME_TYPES.has(t)) return { type: 'string', format: 'time' };
  if (t === 'interval') return { type: 'string' };
  if (t === 'uuid') return { type: 'string', format: 'uuid' };
  if (JSON_TYPES.has(t)) return {};
  if (t === 'bytea') return { type: 'string', format: 'byte' };

  // Array — either `<type>[]` or `_<type>` (Postgres internal form).
  if (t.endsWith('[]') || t.startsWith('_')) {
    const elemType = t.endsWith('[]') ? t.slice(0, -2) : t.slice(1);
    // Synthesize a plain-typed column to reuse the scalar path.
    const elemCol: Column = {
      ...col,
      type: elemType,
      nominalType: elemType,
      enumValues: [],
      maxLength: null,
    };
    return { type: 'array', items: columnToJsonSchema(elemCol) };
  }

  // Default: string, respecting max length.
  const base: JsonSchema = { type: 'string' };
  return col.maxLength !== null
    ? { ...base, maxLength: col.maxLength }
    : base;
}

/**
 * Map a bare Postgres type string (no Column context) to a JSON
 * Schema fragment. Used for RPC parameter / return types, where we
 * only have the declared type name.
 */
export function pgTypeToJsonSchema(pgType: string): JsonSchema {
  const t = pgType.toLowerCase().split('(')[0]!.trim();
  if (
    t === 'int2' ||
    t === 'int4' ||
    t === 'integer' ||
    t === 'smallint' ||
    t === 'int8' ||
    t === 'bigint'
  ) {
    return { type: 'integer' };
  }
  if (
    t === 'float4' ||
    t === 'float8' ||
    t === 'real' ||
    t === 'numeric' ||
    t === 'decimal'
  ) {
    return { type: 'number' };
  }
  if (t === 'bool' || t === 'boolean') return { type: 'boolean' };
  if (t === 'json' || t === 'jsonb') return {};
  return { type: 'string' };
}
