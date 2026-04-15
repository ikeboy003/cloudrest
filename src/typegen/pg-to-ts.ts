// Map a Postgres type name (and optional column context) to a
// TypeScript type expression.
//
// Enums on the column win over the base type — they become a
// union of quoted string literals.
//
// Array types (`text[]`, `_text`) recurse on the element type. Any
// unknown type falls through to `string`, which is what the
// postgres.js driver hands back for domains and user-defined
// scalars anyway.

import type { Column } from '@/schema/table';

const NUMBER_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'integer',
  'smallint',
  'bigint',
  'float4',
  'float8',
  'real',
  'double precision',
  'numeric',
  'decimal',
  'serial',
  'bigserial',
  'smallserial',
  'oid',
]);

const BOOL_TYPES = new Set(['bool', 'boolean']);
const JSON_TYPES = new Set(['json', 'jsonb']);
const VECTOR_TYPES = new Set(['vector', 'halfvec', 'sparsevec']);
const STRING_TYPES = new Set([
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'name',
  'bpchar',
  'uuid',
  'citext',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'money',
  'xml',
  'bytea',
  'bit',
  'varbit',
  'tsvector',
  'tsquery',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'int4range',
  'int8range',
  'numrange',
  'tsrange',
  'tstzrange',
  'daterange',
  'int4multirange',
  'int8multirange',
  'nummultirange',
  'tsmultirange',
  'tstzmultirange',
  'datemultirange',
  'ltree',
  'lquery',
  'ltxtquery',
]);
const GEO_TYPES = new Set(['geometry', 'geography']);

export function pgTypeToTs(pgType: string, column?: Column): string {
  if (column !== undefined && column.enumValues.length > 0) {
    return column.enumValues
      .map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(' | ');
  }

  const t = pgType.trim();
  if (NUMBER_TYPES.has(t)) return 'number';
  if (BOOL_TYPES.has(t)) return 'boolean';
  if (JSON_TYPES.has(t)) return 'Record<string, unknown>';
  if (STRING_TYPES.has(t)) return 'string';
  if (VECTOR_TYPES.has(t)) return 'number[]';
  if (GEO_TYPES.has(t)) return 'Record<string, unknown>';
  if (t === 'hstore') return 'Record<string, string>';

  // Array forms.
  if (t.endsWith('[]')) return `${pgTypeToTs(t.slice(0, -2))}[]`;
  if (t.startsWith('_')) return `${pgTypeToTs(t.slice(1))}[]`;

  // Unknown / user-defined — fall through to string.
  return 'string';
}
