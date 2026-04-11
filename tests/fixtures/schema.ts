// Shared schema-cache fixtures for tests.
//
// Build a minimal SchemaCache without going through Postgres
// introspection. Every test that needs schema-aware behavior
// (planner, builder, handler) uses `makeSchema` below.

import type { SchemaCache } from '@/schema/cache';
import type { Column, Table } from '@/schema/table';
import { identifierKey } from '@/schema/cache';
import type {
  Relationship,
  RelationshipsMap,
} from '@/schema/relationship';
import { relationshipKey } from '@/schema/relationship';

export interface FixtureColumn {
  readonly name: string;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly isGeo?: boolean;
}

export interface FixtureTable {
  readonly schema?: string;
  readonly name: string;
  readonly columns: readonly FixtureColumn[];
  readonly primaryKey?: readonly string[];
  readonly isView?: boolean;
  readonly insertable?: boolean;
  readonly updatable?: boolean;
  readonly deletable?: boolean;
}

export function makeTable(spec: FixtureTable): Table {
  const schema = spec.schema ?? 'public';
  const columns = new Map<string, Column>();
  for (const col of spec.columns) {
    columns.set(col.name, {
      name: col.name,
      type: col.type ?? 'text',
      nominalType: col.type ?? 'text',
      nullable: col.nullable ?? true,
      maxLength: null,
      defaultValue: null,
      description: null,
      enumValues: [],
      generated: false,
      isGeo: col.isGeo ?? false,
    });
  }
  return {
    schema,
    name: spec.name,
    description: null,
    isView: spec.isView ?? false,
    insertable: spec.insertable ?? true,
    updatable: spec.updatable ?? true,
    deletable: spec.deletable ?? true,
    primaryKeyColumns: spec.primaryKey ?? [],
    columns,
  };
}

/**
 * Build a SchemaCache containing the given tables and (optionally) a
 * pre-built relationship list.
 */
export function makeSchema(
  tables: readonly FixtureTable[],
  relationships: readonly Relationship[] = [],
): SchemaCache {
  const map = new Map<string, Table>();
  for (const spec of tables) {
    const table = makeTable(spec);
    map.set(identifierKey({ schema: table.schema, name: table.name }), table);
  }
  return {
    tables: map,
    relationships: buildRelationshipsMap(relationships),
    routines: new Map(),
    loadedAt: 0,
    version: 1,
  };
}

function buildRelationshipsMap(
  rels: readonly Relationship[],
): RelationshipsMap {
  const map = new Map<string, Relationship[]>();
  for (const r of rels) {
    const key = relationshipKey(r.table, r.foreignTable.schema);
    const existing = map.get(key);
    if (existing) existing.push(r);
    else map.set(key, [r]);
  }
  return map;
}

/**
 * Default "books" fixture used across planner and builder tests.
 */
export const BOOKS_SCHEMA: SchemaCache = makeSchema([
  {
    name: 'books',
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'title', type: 'text' },
      { name: 'author_id', type: 'bigint' },
      { name: 'price', type: 'numeric' },
      { name: 'category', type: 'text' },
      { name: 'data', type: 'jsonb' },
      { name: 'embedding', type: 'vector' },
    ],
  },
]);

// ----- Relationship fixture builders -----------------------------------

/**
 * Build an M2O relationship: `fromTable.fromColumn` → `toTable.toColumn`.
 * (The FK lives on `fromTable`.)
 */
export function makeM2O(spec: {
  readonly from: string;
  readonly fromColumn: string;
  readonly to: string;
  readonly toColumn: string;
  readonly constraint?: string;
  readonly schema?: string;
  readonly toSchema?: string;
}): Relationship {
  const schema = spec.schema ?? 'public';
  const toSchema = spec.toSchema ?? schema;
  return {
    table: { schema, name: spec.from },
    foreignTable: { schema: toSchema, name: spec.to },
    isSelf: spec.from === spec.to,
    cardinality: {
      type: 'M2O',
      constraint: spec.constraint ?? `${spec.from}_${spec.fromColumn}_fkey`,
      columns: [[spec.fromColumn, spec.toColumn]],
    },
    tableIsView: false,
    foreignTableIsView: false,
  };
}

/**
 * Build an O2M relationship: `toTable.toColumn` → `fromTable.fromColumn`.
 * (The FK lives on `toTable`; from the "source" side's point of view
 * this is one-to-many.)
 */
export function makeO2M(spec: {
  readonly from: string;
  readonly fromColumn: string;
  readonly to: string;
  readonly toColumn: string;
  readonly constraint?: string;
  readonly schema?: string;
}): Relationship {
  const schema = spec.schema ?? 'public';
  return {
    table: { schema, name: spec.from },
    foreignTable: { schema, name: spec.to },
    isSelf: spec.from === spec.to,
    cardinality: {
      type: 'O2M',
      constraint: spec.constraint ?? `${spec.to}_${spec.toColumn}_fkey`,
      columns: [[spec.fromColumn, spec.toColumn]],
    },
    tableIsView: false,
    foreignTableIsView: false,
  };
}

/**
 * A books/authors/reviews fixture with a full relationship graph.
 * Used by embed planner tests.
 */
export const LIBRARY_SCHEMA: SchemaCache = makeSchema(
  [
    {
      name: 'books',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'title', type: 'text' },
        { name: 'author_id', type: 'bigint' },
        { name: 'price', type: 'numeric' },
        { name: 'category', type: 'text' },
        { name: 'rating', type: 'numeric' },
      ],
    },
    {
      name: 'authors',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'name', type: 'text' },
        { name: 'country', type: 'text' },
      ],
    },
    {
      name: 'reviews',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'book_id', type: 'bigint' },
        { name: 'rating', type: 'integer' },
        { name: 'body', type: 'text' },
      ],
    },
  ],
  [
    // books.author_id → authors.id (M2O from books' perspective)
    makeM2O({
      from: 'books',
      fromColumn: 'author_id',
      to: 'authors',
      toColumn: 'id',
      constraint: 'books_author_id_fkey',
    }),
    // authors → books (O2M from authors' perspective)
    makeO2M({
      from: 'authors',
      fromColumn: 'id',
      to: 'books',
      toColumn: 'author_id',
      constraint: 'books_author_id_fkey',
    }),
    // books → reviews (O2M)
    makeO2M({
      from: 'books',
      fromColumn: 'id',
      to: 'reviews',
      toColumn: 'book_id',
      constraint: 'reviews_book_id_fkey',
    }),
    // reviews → books (M2O)
    makeM2O({
      from: 'reviews',
      fromColumn: 'book_id',
      to: 'books',
      toColumn: 'id',
      constraint: 'reviews_book_id_fkey',
    }),
  ],
);
