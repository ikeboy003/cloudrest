// Schema introspection — builds a `SchemaCache` from a live Postgres
// database.
//
// STAGE 8 scope: define the interface and provide an in-memory
// fixture path. Real introspection against `pg_catalog` lands in
// Stage 17 when the schema coordinator wires KV + Durable Object.
//
// INVARIANT: every query the introspector issues must go through
// `runQuery` (Stage 7) — no bare postgres.js client. Stage 17
// enforces this when the real introspection lands.

import type { SchemaCache } from './cache';
import type { Table } from './table';
import { identifierKey } from './cache';

/**
 * Build an empty `SchemaCache` — no tables, no relationships.
 * Useful as a smoke-test default and for requests that only need
 * HTTP-level validation.
 */
export function emptySchemaCache(): SchemaCache {
  return {
    tables: new Map<string, Table>(),
    relationships: new Map(),
    routines: new Map(),
    loadedAt: Date.now(),
    version: 0,
  };
}

/**
 * Hydrate a `SchemaCache` from a pre-built list of tables. Used by
 * Stage 8 handler tests and by the realtime smoke path until Stage 17
 * lands the real introspection query.
 *
 * This is intentionally synchronous and pure — no DB access — so it
 * can live in the module graph for both production and tests.
 */
export function buildSchemaCacheFromTables(tables: readonly Table[]): SchemaCache {
  const tableMap = new Map<string, Table>();
  for (const t of tables) {
    tableMap.set(identifierKey({ schema: t.schema, name: t.name }), t);
  }
  return {
    tables: tableMap,
    relationships: new Map(),
    routines: new Map(),
    loadedAt: Date.now(),
    version: 1,
  };
}
