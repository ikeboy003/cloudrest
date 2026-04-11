// Schema cache serialization codec.
//
// STAGE 17 (critique #60):
//   - `SchemaCache` has a `Map` of tables (each with a `Map` of
//     columns) and a `Map` of relationships. JSON.stringify of
//     these collapses to `{}` — the old code did exactly that and
//     the persisted cache was corrupt, but the hot path always
//     re-introspected so the bug hid.
//   - This codec serializes every non-JSON type EXPLICITLY so the
//     round-trip is a no-op modulo insertion order.
//
// Format: a plain JS object with these keys:
//   version      — monotonic integer bumped by the coordinator
//   loadedAt     — epoch ms
//   tables       — array of `[key, table]`
//   relationships — array of `[key, relationships[]]`
//   routines     — array of `[key, routine[]]`
//
// The `Column.columns` Map inside a `Table` is serialized as
// an array of `[name, column]` entries.

import type { Column, Table } from './table';
import type { Relationship, RelationshipsMap } from './relationship';
import type { Routine, RoutinesMap } from './routine';
import type { SchemaCache } from './cache';

// ----- Wire shapes -----------------------------------------------------

interface WireColumn extends Omit<Column, never> {}

interface WireTable
  extends Omit<Table, 'columns' | 'primaryKeyColumns'> {
  readonly primaryKeyColumns: readonly string[];
  readonly columns: ReadonlyArray<readonly [string, WireColumn]>;
}

interface WireSchemaCache {
  readonly codecVersion: 1;
  readonly loadedAt: number;
  readonly version: number;
  readonly tables: ReadonlyArray<readonly [string, WireTable]>;
  readonly relationships: ReadonlyArray<readonly [string, readonly Relationship[]]>;
  readonly routines: ReadonlyArray<readonly [string, readonly Routine[]]>;
}

// ----- Encode ----------------------------------------------------------

export function encodeSchemaCache(cache: SchemaCache): string {
  const wire: WireSchemaCache = {
    codecVersion: 1,
    loadedAt: cache.loadedAt,
    version: cache.version,
    tables: [...cache.tables.entries()].map(
      ([key, table]) =>
        [
          key,
          {
            schema: table.schema,
            name: table.name,
            description: table.description,
            isView: table.isView,
            insertable: table.insertable,
            updatable: table.updatable,
            deletable: table.deletable,
            primaryKeyColumns: [...table.primaryKeyColumns],
            columns: [...table.columns.entries()],
          },
        ] as const,
    ),
    relationships: [...cache.relationships.entries()].map(
      ([key, rels]) => [key, [...rels]] as const,
    ),
    routines: [...cache.routines.entries()].map(
      ([key, rs]) => [key, [...rs]] as const,
    ),
  };
  return JSON.stringify(wire);
}

// ----- Decode ----------------------------------------------------------

export function decodeSchemaCache(raw: string): SchemaCache {
  const parsed = JSON.parse(raw) as WireSchemaCache;
  if (parsed.codecVersion !== 1) {
    throw new Error(
      `unsupported schema cache codec version ${parsed.codecVersion}`,
    );
  }
  const tables = new Map<string, Table>();
  for (const [key, wire] of parsed.tables) {
    const columns = new Map<string, Column>(wire.columns);
    tables.set(key, {
      schema: wire.schema,
      name: wire.name,
      description: wire.description,
      isView: wire.isView,
      insertable: wire.insertable,
      updatable: wire.updatable,
      deletable: wire.deletable,
      primaryKeyColumns: wire.primaryKeyColumns,
      columns,
    });
  }
  const relationships: RelationshipsMap = new Map(parsed.relationships);
  const routines: RoutinesMap = new Map(parsed.routines);
  return {
    tables,
    relationships,
    routines,
    loadedAt: parsed.loadedAt,
    version: parsed.version,
  };
}
