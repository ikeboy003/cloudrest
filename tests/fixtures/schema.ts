// Shared schema-cache fixtures for tests.
//
// Build a minimal SchemaCache without going through Postgres
// introspection. Every test that needs schema-aware behavior
// (planner, builder, handler) uses `makeSchema` below.

import type { SchemaCache } from '../../src/schema/cache';
import type { Column, Table } from '../../src/schema/table';
import { identifierKey } from '../../src/schema/cache';

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
 * Build a SchemaCache containing the given tables.
 */
export function makeSchema(tables: readonly FixtureTable[]): SchemaCache {
  const map = new Map<string, Table>();
  for (const spec of tables) {
    const table = makeTable(spec);
    map.set(identifierKey({ schema: table.schema, name: table.name }), table);
  }
  return {
    tables: map,
    loadedAt: 0,
    version: 1,
  };
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
    ],
  },
]);
