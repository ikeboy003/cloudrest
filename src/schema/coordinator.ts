// SchemaCoordinator Durable Object.
//
// RUNTIME: the DO owns schema lifecycle. It introspects pg_catalog,
// serializes the result via the codec, and writes it to KV. Workers
// read from KV — they never introspect directly.
//
// Refresh triggers:
//   1. First fetch (cold start) — ensureLoaded().
//   2. Alarm — fires every SCHEMA_REFRESH_INTERVAL seconds.
//   3. POST /reload — manual trigger from a Worker that detects a
//      schema version change.
//   4. LISTEN cloudrest_schema_changed — postgres.js subscribe on the
//      NOTIFY channel. DDL triggers in the DB fire the notification.
//
// INVARIANT: concurrent loads are deduplicated via a shared promise.
// INVARIANT: a failed introspection keeps the old cache; stale is
// better than empty.

import postgres from 'postgres';
import { encodeSchemaCache, decodeSchemaCache } from './codec';
import type { SchemaCache } from './cache';
import type { Table, Column } from './table';
import type { Relationship, RelationshipsMap } from './relationship';
import type { Routine, RoutinesMap } from './routine';
import { identifierKey } from './cache';
import { relationshipKey } from './relationship';
import { routineKey } from './routine';
import {
  TABLES_SQL,
  RELATIONSHIPS_SQL,
  FUNCTIONS_SQL,
} from './introspect-queries';

// Re-use the parsing helpers from introspect.ts would be ideal, but
// they are tightly coupled to the executor's transaction runner.
// The DO uses postgres.js directly with raw SQL, so we duplicate
// the row-parsing logic here. The canonical types (Table, Column,
// Relationship, Routine) are shared.

interface CoordinatorEnv {
  HYPERDRIVE: { connectionString: string };
  SCHEMA_CACHE?: KVNamespace;
  DB_SCHEMAS?: string;
  SCHEMA_REFRESH_INTERVAL?: string;
}

export class SchemaCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: CoordinatorEnv;
  private cache: SchemaCache | null = null;
  private loadingPromise: Promise<void> | null = null;
  private lastLoadError: string | null = null;
  private listener: ReturnType<typeof postgres> | null = null;

  constructor(state: DurableObjectState, env: CoordinatorEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/schema') {
      await this.ensureLoaded();
      if (!this.cache) {
        return new Response(
          JSON.stringify({ error: 'Failed to load schema', detail: this.lastLoadError }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(encodeSchemaCache(this.cache), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/reload' && request.method === 'POST') {
      await this.ensureLoaded();
      if (this.lastLoadError) {
        return new Response(
          JSON.stringify({ status: 'error', detail: this.lastLoadError }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.doLoadSchema();
    await this.scheduleNextAlarm();
  }

  // ----- Internals -------------------------------------------------------

  private getRefreshIntervalSeconds(): number {
    const raw = this.env.SCHEMA_REFRESH_INTERVAL || '60';
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) || parsed < 1 ? 60 : parsed;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const interval = this.getRefreshIntervalSeconds();
    await this.state.storage.setAlarm(Date.now() + interval * 1000);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }
    this.loadingPromise = this.doLoadSchema();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async doLoadSchema(): Promise<void> {
    const schemas = (this.env.DB_SCHEMAS || 'public')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (schemas.length === 0) schemas.push('public');

    const schemasArray = `{${schemas.map((s) => `"${s}"`).join(',')}}`;

    let sql: ReturnType<typeof postgres> | null = null;
    try {
      sql = postgres(this.env.HYPERDRIVE.connectionString, {
        prepare: false,
        max: 1,
        idle_timeout: 5,
        connect_timeout: 30,
      });

      const [tablesRows, relsRows, fnsRows] = await Promise.all([
        sql.unsafe(TABLES_SQL, [schemasArray]),
        sql.unsafe(RELATIONSHIPS_SQL, [schemasArray]),
        sql.unsafe(FUNCTIONS_SQL, [schemasArray]),
      ]);

      const tables = parseTables(tablesRows);
      const relationships = parseRelationships(relsRows, tables, schemas);
      const routines = parseRoutines(fnsRows);

      this.cache = {
        tables,
        relationships,
        routines,
        loadedAt: Date.now(),
        version: this.cache ? this.cache.version + 1 : 1,
      };

      // Write to KV so Workers can hydrate without hitting the DO
      if (this.env.SCHEMA_CACHE) {
        await this.env.SCHEMA_CACHE.put('schema', encodeSchemaCache(this.cache));
      }

      this.lastLoadError = null;

      // Schedule alarm if not already set
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        await this.scheduleNextAlarm();
      }

      // RUNTIME: start LISTEN for schema change notifications.
      // postgres.js subscribe() holds an open connection — DOs can
      // do this because they are long-lived, unlike Workers.
      this.startListener();
    } catch (e) {
      this.lastLoadError = String(e);
      console.error('Schema introspection failed:', e);
      // Don't clear existing cache — serve stale data
    } finally {
      if (sql) {
        await sql.end({ timeout: 1 }).catch(() => {});
      }
    }
  }

  private startListener(): void {
    // Only start once
    if (this.listener) return;

    try {
      const sql = postgres(this.env.HYPERDRIVE.connectionString, {
        prepare: false,
        max: 1,
        idle_timeout: 0, // keep alive
        connect_timeout: 30,
      });

      sql.listen('cloudrest_schema_changed', async () => {
        console.log('Received NOTIFY cloudrest_schema_changed — reloading schema');
        await this.doLoadSchema();
      }).catch((err) => {
        console.error('LISTEN failed:', err);
        this.listener = null;
      });

      this.listener = sql;
    } catch (e) {
      console.error('Failed to start LISTEN:', e);
    }
  }
}

// ----- Row parsing (mirrors introspect.ts) --------------------------------
// These are duplicated from introspect.ts because the DO uses postgres.js
// directly rather than the executor's transaction runner.

interface RawTableRow {
  table_schema: string;
  table_name: string;
  table_description: string | null;
  is_view: boolean;
  insertable: boolean;
  updatable: boolean;
  deletable: boolean;
  pk_cols: unknown;
  columns: unknown;
}

interface RawColumnData {
  column_name: string;
  description: string | null;
  is_nullable: boolean;
  data_type: string;
  nominal_data_type: string;
  character_maximum_length: number | null;
  column_default: string | null;
  enum_values?: readonly string[];
  is_generated?: boolean;
}

function parseTables(
  rows: readonly Record<string, unknown>[],
): ReadonlyMap<string, Table> {
  const tables = new Map<string, Table>();
  for (const row of rows as unknown as readonly RawTableRow[]) {
    const pkCols = coerceStringArray(row.pk_cols);
    const rawCols = coerceArray<RawColumnData>(row.columns);

    const columns = new Map<string, Column>();
    for (const rc of rawCols) {
      const geoKind = classifyGeoKind(rc.data_type);
      columns.set(rc.column_name, {
        name: rc.column_name,
        type: rc.data_type,
        nominalType: rc.nominal_data_type,
        nullable: rc.is_nullable,
        maxLength: rc.character_maximum_length,
        defaultValue: rc.column_default,
        description: rc.description,
        enumValues: rc.enum_values ?? [],
        generated: rc.is_generated ?? false,
        geoKind,
        isGeo: geoKind !== null,
      });
    }

    tables.set(
      identifierKey({ schema: row.table_schema, name: row.table_name }),
      {
        schema: row.table_schema,
        name: row.table_name,
        description: row.table_description,
        isView: row.is_view,
        insertable: row.insertable,
        updatable: row.updatable,
        deletable: row.deletable,
        primaryKeyColumns: pkCols,
        columns,
      },
    );
  }
  return tables;
}

interface RawRelRow {
  table_schema: string;
  table_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  is_self: boolean;
  constraint_name: string;
  cols_and_fcols: unknown;
  one_to_one: boolean;
}

function parseRelationships(
  rows: readonly Record<string, unknown>[],
  tables: ReadonlyMap<string, Table>,
  schemas: readonly string[],
): RelationshipsMap {
  const forward: Relationship[] = [];
  for (const row of rows as unknown as readonly RawRelRow[]) {
    const colPairs = coerceArray<readonly [string, string]>(row.cols_and_fcols);
    const table = { schema: row.table_schema, name: row.table_name };
    const foreignTable = { schema: row.foreign_table_schema, name: row.foreign_table_name };
    const cardinality = row.one_to_one
      ? { type: 'O2O' as const, constraint: row.constraint_name, columns: colPairs, isParent: false }
      : { type: 'M2O' as const, constraint: row.constraint_name, columns: colPairs };

    forward.push({
      table,
      foreignTable,
      isSelf: row.is_self,
      cardinality,
      tableIsView: tables.get(identifierKey(table))?.isView ?? false,
      foreignTableIsView: tables.get(identifierKey(foreignTable))?.isView ?? false,
    });
  }

  const inverses: Relationship[] = [];
  for (const rel of forward) {
    const c = rel.cardinality;
    if (c.type === 'M2O') {
      inverses.push({
        table: rel.foreignTable,
        foreignTable: rel.table,
        isSelf: rel.isSelf,
        cardinality: {
          type: 'O2M',
          constraint: c.constraint,
          columns: c.columns.map(([a, b]) => [b, a] as const),
        },
        tableIsView: rel.foreignTableIsView,
        foreignTableIsView: rel.tableIsView,
      });
    } else if (c.type === 'O2O') {
      inverses.push({
        table: rel.foreignTable,
        foreignTable: rel.table,
        isSelf: rel.isSelf,
        cardinality: {
          type: 'O2O',
          constraint: c.constraint,
          columns: c.columns.map(([a, b]) => [b, a] as const),
          isParent: true,
        },
        tableIsView: rel.foreignTableIsView,
        foreignTableIsView: rel.tableIsView,
      });
    }
  }

  const allDirect = [...forward, ...inverses];
  const exposedSchemas = new Set(schemas);
  const map = new Map<string, Relationship[]>();
  for (const rel of allDirect) {
    if (!exposedSchemas.has(rel.foreignTable.schema)) continue;
    const key = relationshipKey(rel.table, rel.foreignTable.schema);
    const existing = map.get(key);
    if (existing) existing.push(rel);
    else map.set(key, [rel]);
  }
  return map;
}

interface RawFuncRow {
  proc_schema: string;
  proc_name: string;
  proc_description: string | null;
  args: unknown;
  return_schema: string;
  return_name: string;
  rettype_is_setof: boolean;
  rettype_is_composite: boolean;
  rettype_is_composite_alias: boolean;
  provolatile: string;
  hasvariadic: boolean;
}

interface RawArgData {
  name: string;
  type: string;
  type_max_length: string;
  is_required: boolean;
  is_variadic: boolean;
}

function parseRoutines(
  rows: readonly Record<string, unknown>[],
): RoutinesMap {
  const routines = new Map<string, Routine[]>();
  for (const row of rows as unknown as readonly RawFuncRow[]) {
    const rawArgs = coerceArray<RawArgData>(row.args);
    const params = rawArgs.map((a) => ({
      name: a.name,
      type: a.type,
      typeModifier: a.type_max_length,
      required: a.is_required,
      variadic: a.is_variadic,
    }));

    const retQi = { schema: row.return_schema, name: row.return_name };
    const pgType = row.rettype_is_composite
      ? { kind: 'composite' as const, qi: retQi, isAlias: row.rettype_is_composite_alias }
      : { kind: 'scalar' as const, qi: retQi };
    const returnType = row.rettype_is_setof
      ? { kind: 'setOf' as const, pgType }
      : { kind: 'single' as const, pgType };

    const volatility =
      row.provolatile === 'i' ? 'immutable'
        : row.provolatile === 's' ? 'stable'
          : 'volatile';

    const routine: Routine = {
      schema: row.proc_schema,
      name: row.proc_name,
      description: row.proc_description,
      params,
      returnType,
      volatility: volatility as 'immutable' | 'stable' | 'volatile',
      hasVariadic: row.hasvariadic,
    };

    const key = routineKey({ schema: row.proc_schema, name: row.proc_name });
    const existing = routines.get(key);
    if (existing) existing.push(routine);
    else routines.set(key, [routine]);
  }

  for (const [key, overloads] of routines) {
    routines.set(key, [...overloads].sort((a, b) => a.params.length - b.params.length));
  }
  return routines;
}

// ----- Coercion helpers --------------------------------------------------

function coerceArray<T>(value: unknown): readonly T[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as readonly T[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as readonly T[];
    } catch { /* fall through */ }
  }
  return [];
}

function coerceStringArray(value: unknown): readonly string[] {
  return coerceArray<unknown>(value).filter((v): v is string => typeof v === 'string');
}

function classifyGeoKind(dataType: string): 'geometry' | 'geography' | null {
  if (/^geometry(\(|$)/i.test(dataType)) return 'geometry';
  if (/^geography(\(|$)/i.test(dataType)) return 'geography';
  return null;
}
