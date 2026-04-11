// Schema introspection — builds a `SchemaCache` from a live Postgres
// database via the executor's transaction primitive.
//
// INVARIANT (CONSTITUTION §13.3): introspection uses the same
// Postgres client / transaction primitive that request queries use.
// It does NOT open its own `pg.Client`. The in-memory helpers
// (`emptySchemaCache`, `buildSchemaCacheFromTables`) stay in this
// module so tests can hydrate a cache without a DB.
//
// INVARIANT (CONSTITUTION §4.1): `introspectFromPostgres` runs its
// queries inside `runTransaction`, which always issues
// `SET LOCAL statement_timeout`. There is no opt-out.
//
// INVARIANT (CONSTITUTION §2.1): public entry points return
// `Result<SchemaCache, CloudRestError>`. No throw crosses the
// module boundary.
//
// RUNTIME: schema refresh will be driven by a Durable Object
// listening for Postgres `NOTIFY cloudrest_schema_changed` events.
// The DO holds a long-lived `LISTEN` connection (Workers can't) and
// invalidates the cache when a DDL trigger fires the notification.
// That coordinator lives in a later stage; this module only needs
// to load a snapshot on demand.

import { err, ok, type Result } from '../core/result';
import { serverErrors, type CloudRestError } from '../core/errors';
import type { AppConfig } from '../config/schema';
import type { Env } from '../config/env';
import { closeClient, getPostgresClient } from '../executor/client';
import { runTransaction } from '../executor/transaction';
import type { ExecutableQuery, TransactionOutcome } from '../executor/types';
import type { SchemaCache } from './cache';
import { identifierKey } from './cache';
import type { Column, Table } from './table';
import type {
  Cardinality,
  Relationship,
  RelationshipsMap,
} from './relationship';
import { relationshipKey } from './relationship';
import type {
  PgType,
  RetType,
  Routine,
  RoutineParam,
  RoutinesMap,
} from './routine';
import { routineKey } from './routine';
import type { QualifiedIdentifier } from '../http/request';
import {
  FUNCTIONS_SQL,
  RELATIONSHIPS_SQL,
  TABLES_SQL,
} from './introspect-queries';

// ----- In-memory helpers (unchanged from Stage 8) ----------------------

export function emptySchemaCache(): SchemaCache {
  return {
    tables: new Map<string, Table>(),
    relationships: new Map(),
    routines: new Map(),
    loadedAt: Date.now(),
    version: 0,
  };
}

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

// ----- Live introspection ----------------------------------------------

export interface IntrospectInput {
  readonly bindings: Env;
  readonly config: AppConfig;
}

/**
 * Load the schema cache from the live Postgres database.
 *
 * INVARIANT: every catalog query runs through `runTransaction` with
 * the exact same `statement_timeout` / pool config as request
 * traffic. The three catalog reads each run in their own transaction
 * so a DDL change between them surfaces as a mismatch at load time
 * (better than a partial cache that hides the drift).
 */
export async function introspectFromPostgres(
  input: IntrospectInput,
): Promise<Result<SchemaCache, CloudRestError>> {
  const pool = input.config.database.pool;
  const client = await getPostgresClient(input.bindings, {
    max: pool.maxConnections,
    idleTimeoutSeconds: pool.idleTimeoutSeconds,
    connectTimeoutMs: pool.poolTimeoutMs,
    preparedStatements: pool.preparedStatements,
  });

  try {
    // Exposed schemas as a Postgres text array, cast to
    // `regnamespace[]` inside each query. `config.database.schemas`
    // is validated at config-load time (non-empty, defaults to
    // `['public']`).
    const schemasArray = toPgTextArray(input.config.database.schemas);

    const tablesRowsResult = await runCatalogQuery(
      client,
      input.config,
      TABLES_SQL,
      [schemasArray],
    );
    if (!tablesRowsResult.ok) return tablesRowsResult;
    const tablesRows = tablesRowsResult.value;

    const relsRowsResult = await runCatalogQuery(
      client,
      input.config,
      RELATIONSHIPS_SQL,
      [schemasArray],
    );
    if (!relsRowsResult.ok) return relsRowsResult;
    const relsRows = relsRowsResult.value;

    const fnsRowsResult = await runCatalogQuery(
      client,
      input.config,
      FUNCTIONS_SQL,
      [schemasArray],
    );
    if (!fnsRowsResult.ok) return fnsRowsResult;
    const fnsRows = fnsRowsResult.value;

    const tables = parseTables(tablesRows);
    const relationships = parseRelationships(
      relsRows,
      tables,
      input.config.database.schemas,
    );
    const routines = parseRoutines(fnsRows);

    return ok({
      tables,
      relationships,
      routines,
      loadedAt: Date.now(),
      version: 1,
    });
  } finally {
    // RUNTIME: Workers can't share I/O across requests. The
    // introspector opens its own client and tears it down when
    // the pass is done.
    await closeClient(client);
  }
}

/**
 * Run a single catalog query through the shared transaction runner
 * and collapse the `TransactionOutcome` branches into
 * `Result<rows, CloudRestError>`. Introspection never sets
 * `rollbackPreferred` or `maxAffected`, so only `commit` and
 * `pg-error` are meaningful outcomes.
 */
async function runCatalogQuery(
  client: Awaited<ReturnType<typeof getPostgresClient>>,
  config: AppConfig,
  sql: string,
  params: readonly unknown[],
): Promise<Result<readonly Readonly<Record<string, unknown>>[], CloudRestError>> {
  const built: ExecutableQuery = { sql, params, skipGucRead: true };
  const outcome: TransactionOutcome = await runTransaction({
    client,
    main: built,
    statementTimeoutMs: config.database.statementTimeoutMs,
    options: {},
  });
  switch (outcome.kind) {
    case 'commit':
    case 'rollback':
      return ok(outcome.result.rows);
    case 'pg-error':
      return err(outcome.error);
    case 'max-affected-violation':
      return err(
        serverErrors.client(
          'unexpected max-affected violation during introspection',
        ),
      );
  }
}

// ----- Text-array rendering --------------------------------------------

/**
 * SECURITY: schema names come from `config.database.schemas`, which
 * is validated at config load (non-empty, identifier-like). We still
 * escape defensively — the `regnamespace[]` cast requires a
 * well-formed array literal, and a schema name containing `{`, `"`,
 * or `,` would break the grammar.
 */
function toPgTextArray(names: readonly string[]): string {
  const parts = names.map((name) => {
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  return `{${parts.join(',')}}`;
}

// ----- Row parsing: tables ---------------------------------------------

interface RawTableRow {
  readonly table_schema: string;
  readonly table_name: string;
  readonly table_description: string | null;
  readonly is_view: boolean;
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly deletable: boolean;
  readonly pk_cols: unknown;
  readonly columns: unknown;
}

interface RawColumnData {
  readonly column_name: string;
  readonly description: string | null;
  readonly is_nullable: boolean;
  readonly data_type: string;
  readonly nominal_data_type: string;
  readonly character_maximum_length: number | null;
  readonly column_default: string | null;
  readonly enum_values?: readonly string[];
  readonly is_generated?: boolean;
}

function parseTables(
  rows: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<string, Table> {
  const tables = new Map<string, Table>();
  for (const row of rows as unknown as readonly RawTableRow[]) {
    const pkCols = coerceStringArray(row.pk_cols);
    const rawCols = coerceArray<RawColumnData>(row.columns);

    const columns = new Map<string, Column>();
    for (const rc of rawCols) {
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
        isGeo: /^(geometry|geography)$/i.test(rc.data_type),
      });
    }

    const table: Table = {
      schema: row.table_schema,
      name: row.table_name,
      description: row.table_description,
      isView: row.is_view,
      insertable: row.insertable,
      updatable: row.updatable,
      deletable: row.deletable,
      primaryKeyColumns: pkCols,
      columns,
    };
    tables.set(
      identifierKey({ schema: row.table_schema, name: row.table_name }),
      table,
    );
  }
  return tables;
}

// ----- Row parsing: relationships --------------------------------------

interface RawRelRow {
  readonly table_schema: string;
  readonly table_name: string;
  readonly foreign_table_schema: string;
  readonly foreign_table_name: string;
  readonly is_self: boolean;
  readonly constraint_name: string;
  readonly cols_and_fcols: unknown;
  readonly one_to_one: boolean;
}

function parseRelationships(
  rows: readonly Readonly<Record<string, unknown>>[],
  tables: ReadonlyMap<string, Table>,
  schemas: readonly string[],
): RelationshipsMap {
  const forward: Relationship[] = [];
  for (const row of rows as unknown as readonly RawRelRow[]) {
    const colPairs = coerceArray<readonly [string, string]>(row.cols_and_fcols);
    const table: QualifiedIdentifier = {
      schema: row.table_schema,
      name: row.table_name,
    };
    const foreignTable: QualifiedIdentifier = {
      schema: row.foreign_table_schema,
      name: row.foreign_table_name,
    };

    const tableInfo = tables.get(identifierKey(table));
    const foreignInfo = tables.get(identifierKey(foreignTable));

    const cardinality: Cardinality = row.one_to_one
      ? {
          type: 'O2O',
          constraint: row.constraint_name,
          columns: colPairs,
          isParent: false,
        }
      : { type: 'M2O', constraint: row.constraint_name, columns: colPairs };

    forward.push({
      table,
      foreignTable,
      isSelf: row.is_self,
      cardinality,
      tableIsView: tableInfo?.isView ?? false,
      foreignTableIsView: foreignInfo?.isView ?? false,
    });
  }

  // Inverses: M2O → O2M, O2O (isParent=false) → O2O (isParent=true).
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

  // COMPAT: M2M inference — a junction table with two M2O FKs whose
  // columns are a subset of the junction's PK becomes two M2M
  // relationships (one in each direction) between the endpoints.
  const m2mRels: Relationship[] = [];
  const relsByTableKey = new Map<string, Relationship[]>();
  for (const r of allDirect) {
    if (r.cardinality.type !== 'M2O') continue;
    const key = identifierKey(r.table);
    const existing = relsByTableKey.get(key);
    if (existing) existing.push(r);
    else relsByTableKey.set(key, [r]);
  }

  for (const [junctionKey, junctionRels] of relsByTableKey) {
    const first = junctionRels[0];
    if (first === undefined) continue;
    const junctionQi = first.table;
    const junctionInfo = tables.get(junctionKey);
    if (!junctionInfo) continue;
    const pkCols = new Set(junctionInfo.primaryKeyColumns);

    for (let i = 0; i < junctionRels.length; i++) {
      for (let j = i + 1; j < junctionRels.length; j++) {
        const r1 = junctionRels[i]!;
        const r2 = junctionRels[j]!;
        const c1 = r1.cardinality as Extract<Cardinality, { type: 'M2O' }>;
        const c2 = r2.cardinality as Extract<Cardinality, { type: 'M2O' }>;

        const fkCols = new Set<string>();
        for (const [col] of c1.columns) fkCols.add(col);
        for (const [col] of c2.columns) fkCols.add(col);
        const isSubset = [...fkCols].every((col) => pkCols.has(col));
        if (!isSubset) continue;

        const r1ForeignInfo = tables.get(identifierKey(r1.foreignTable));
        const r2ForeignInfo = tables.get(identifierKey(r2.foreignTable));

        m2mRels.push({
          table: r1.foreignTable,
          foreignTable: r2.foreignTable,
          isSelf:
            identifierKey(r1.foreignTable) === identifierKey(r2.foreignTable),
          cardinality: {
            type: 'M2M',
            junction: {
              table: junctionQi,
              constraint1: c1.constraint,
              constraint2: c2.constraint,
              sourceColumns: c1.columns.map(([a, b]) => [b, a] as const),
              targetColumns: c2.columns.map(([a, b]) => [b, a] as const),
            },
          },
          tableIsView: r1ForeignInfo?.isView ?? false,
          foreignTableIsView: r2ForeignInfo?.isView ?? false,
        });
        m2mRels.push({
          table: r2.foreignTable,
          foreignTable: r1.foreignTable,
          isSelf:
            identifierKey(r1.foreignTable) === identifierKey(r2.foreignTable),
          cardinality: {
            type: 'M2M',
            junction: {
              table: junctionQi,
              constraint1: c2.constraint,
              constraint2: c1.constraint,
              sourceColumns: c2.columns.map(([a, b]) => [b, a] as const),
              targetColumns: c1.columns.map(([a, b]) => [b, a] as const),
            },
          },
          tableIsView: r2ForeignInfo?.isView ?? false,
          foreignTableIsView: r1ForeignInfo?.isView ?? false,
        });
      }
    }
  }

  const finalRels = [...allDirect, ...m2mRels];

  // COMPAT: only expose relationships whose foreign table lives in
  // an exposed schema. Matches PostgREST's visibility rule.
  const map = new Map<string, Relationship[]>();
  const exposedSchemas = new Set(schemas);
  for (const rel of finalRels) {
    if (!exposedSchemas.has(rel.foreignTable.schema)) continue;
    const key = relationshipKey(rel.table, rel.foreignTable.schema);
    const existing = map.get(key);
    if (existing) existing.push(rel);
    else map.set(key, [rel]);
  }
  return map;
}

// ----- Row parsing: routines -------------------------------------------

interface RawFuncRow {
  readonly proc_schema: string;
  readonly proc_name: string;
  readonly proc_description: string | null;
  readonly args: unknown;
  readonly return_schema: string;
  readonly return_name: string;
  readonly rettype_is_setof: boolean;
  readonly rettype_is_composite: boolean;
  readonly rettype_is_composite_alias: boolean;
  readonly provolatile: string;
  readonly hasvariadic: boolean;
}

interface RawArgData {
  readonly name: string;
  readonly type: string;
  readonly type_max_length: string;
  readonly is_required: boolean;
  readonly is_variadic: boolean;
}

function parseRoutines(
  rows: readonly Readonly<Record<string, unknown>>[],
): RoutinesMap {
  const routines = new Map<string, Routine[]>();
  for (const row of rows as unknown as readonly RawFuncRow[]) {
    const rawArgs = coerceArray<RawArgData>(row.args);
    const params: RoutineParam[] = rawArgs.map((a) => ({
      name: a.name,
      type: a.type,
      typeModifier: a.type_max_length,
      required: a.is_required,
      variadic: a.is_variadic,
    }));

    const retQi: QualifiedIdentifier = {
      schema: row.return_schema,
      name: row.return_name,
    };
    const pgType: PgType = row.rettype_is_composite
      ? { kind: 'composite', qi: retQi, isAlias: row.rettype_is_composite_alias }
      : { kind: 'scalar', qi: retQi };
    const returnType: RetType = row.rettype_is_setof
      ? { kind: 'setOf', pgType }
      : { kind: 'single', pgType };

    const volatility =
      row.provolatile === 'i'
        ? 'immutable'
        : row.provolatile === 's'
          ? 'stable'
          : 'volatile';

    const routine: Routine = {
      schema: row.proc_schema,
      name: row.proc_name,
      description: row.proc_description,
      params,
      returnType,
      volatility,
      hasVariadic: row.hasvariadic,
    };

    const key = routineKey({ schema: row.proc_schema, name: row.proc_name });
    const existing = routines.get(key);
    if (existing) existing.push(routine);
    else routines.set(key, [routine]);
  }

  // COMPAT: PostgREST sorts overloads by fewest params so the first
  // matching candidate is the simplest one.
  for (const [key, overloads] of routines) {
    routines.set(
      key,
      [...overloads].sort((a, b) => a.params.length - b.params.length),
    );
  }
  return routines;
}

// ----- Coercion helpers ------------------------------------------------

/**
 * RUNTIME: `postgres.js` returns JSON columns as either a parsed
 * value or a raw string depending on column type detection. Normalize
 * both shapes so callers never have to.
 */
function coerceArray<T>(value: unknown): readonly T[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as readonly T[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as readonly T[];
    } catch {
      // fall through
    }
  }
  return [];
}

function coerceStringArray(value: unknown): readonly string[] {
  const arr = coerceArray<unknown>(value);
  return arr.filter((v): v is string => typeof v === 'string');
}
