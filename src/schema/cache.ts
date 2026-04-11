// Schema cache top-level type.
//
// The cache carries everything the planner needs to validate a parsed
// request against a real database: tables, relationships, and routines.
//
// Stage 6a populated `tables`. Stage 6b adds `relationships` for embed
// planning. Routines arrive with Stage 10.

import type { QualifiedIdentifier } from '../http/request';
import type { Table, TablesMap } from './table';
import type { RelationshipsMap } from './relationship';
import type { RoutinesMap } from './routine';

export interface SchemaCache {
  readonly tables: TablesMap;
  /** FK graph used by embed planning. Empty map = no relationships. */
  readonly relationships: RelationshipsMap;
  /** `/rpc/*` routine definitions keyed by `routineKey`. Populated by Stage 10. */
  readonly routines: RoutinesMap;
  /** Epoch-ms of when the cache was loaded. */
  readonly loadedAt: number;
  /** Monotonic version counter, bumped on reload. */
  readonly version: number;
}

/**
 * Build the canonical lookup key for a qualified identifier.
 * Uses a null byte as a delimiter because Postgres identifiers cannot
 * contain \0 — this guarantees `schema="a.b",name="c"` is distinct from
 * `schema="a",name="b.c"`.
 */
export function identifierKey(id: QualifiedIdentifier): string {
  return `${id.schema}\0${id.name}`;
}

/**
 * Look up a table in the schema cache by qualified identifier.
 * Returns undefined when the table is not exposed.
 */
export function findTable(
  cache: SchemaCache,
  id: QualifiedIdentifier,
): Table | undefined {
  return cache.tables.get(identifierKey(id));
}
