// Schema cache top-level type.
//
// The cache carries everything the planner needs to validate a parsed
// request against a real database: tables, relationships, and routines.
//
// Stage 6 populates `tables` only. Relationships and routines arrive
// with later stages (stage 6b for embeds, stage 10 for RPC).

import type { QualifiedIdentifier } from '../http/request';
import type { Table, TablesMap } from './table';

export interface SchemaCache {
  readonly tables: TablesMap;
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
