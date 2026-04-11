// Operator mnemonics, cast allowlist, and array-literal helper.
//
// INVARIANT: These tables are closed allowlists. Adding an operator or
// cast type is a one-line change here, a matching parser entry, and a
// test. No runtime string construction.
//
// SECURITY: SAFE_CAST_TYPES is the ONLY place the rewrite recognizes
// user-provided cast types. The isValidCast check happens before the
// type name reaches any SQL fragment.

import type {
  FtsOperator,
  IsVal,
  QuantOperator,
  SimpleOperator,
} from '../../parser/types';

export const SIMPLE_OPS: Record<SimpleOperator, string> = {
  neq: '<>',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxr: '&<',
  nxl: '&>',
  adj: '-|-',
};

export const QUANT_OPS: Record<QuantOperator, string> = {
  eq: '=',
  gte: '>=',
  gt: '>',
  lte: '<=',
  lt: '<',
  like: 'like',
  ilike: 'ilike',
  match: '~',
  imatch: '~*',
};

export const FTS_OPS: Record<FtsOperator, string> = {
  fts: '@@ to_tsquery',
  plfts: '@@ plainto_tsquery',
  phfts: '@@ phraseto_tsquery',
  wfts: '@@ websearch_to_tsquery',
};

export const IS_VALUES: Record<IsVal, string> = {
  null: 'NULL',
  not_null: 'NOT NULL',
  true: 'TRUE',
  false: 'FALSE',
  unknown: 'UNKNOWN',
};

/**
 * Closed allowlist of Postgres cast types allowed in `?select=col::type`.
 * User strings never reach the cast directly.
 */
const SAFE_CAST_TYPES: ReadonlySet<string> = new Set([
  'text',
  'int',
  'int2',
  'int4',
  'int8',
  'integer',
  'smallint',
  'bigint',
  'float',
  'float4',
  'float8',
  'real',
  'double precision',
  'numeric',
  'decimal',
  'bool',
  'boolean',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'uuid',
  'json',
  'jsonb',
  'bytea',
  'varchar',
  'char',
  'character varying',
  'inet',
  'cidr',
  'macaddr',
  'money',
  'oid',
  'regclass',
  'regtype',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'tsquery',
  'tsvector',
  'xml',
  'int[]',
  'text[]',
  'boolean[]',
  'uuid[]',
  'jsonb[]',
  'integer[]',
  'bigint[]',
  'float8[]',
  'numeric[]',
  'varchar[]',
  'timestamptz[]',
  'date[]',
]);

export function isValidCast(cast: string): boolean {
  return SAFE_CAST_TYPES.has(cast.toLowerCase().trim());
}

/**
 * Build a Postgres array literal: `{"val1","val2","val3"}`.
 * Backslashes and quotes are escaped; the result is bound via
 * SqlBuilder.addParam, so direct interpolation is not a goal here —
 * this is belt-and-suspenders to keep the output parseable by Postgres.
 */
export function buildPgArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((v) => {
    const slashEscaped = v.replace(/\\/g, '\\\\');
    return '"' + slashEscaped.replace(/"/g, '\\"') + '"';
  });
  return '{' + escaped.join(',') + '}';
}
