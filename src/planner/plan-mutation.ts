// Mutation planner — turns (ParsedQueryParams + Payload + Preferences
// + SchemaCache) into a typed `MutationPlan`.
//
// Schema-aware validation lives here. The builder trusts the plan and
// never revalidates column names.
//
// Defaulted columns that are absent from the payload are EXCLUDED from
// the INSERT column list so the DB applies the DEFAULT. For
// `Prefer: missing=null`, the planner INCLUDES every non-defaulted
// column so `json_to_record` returns NULL — matching PostgREST's
// semantics.
//
// `RETURNING` fields are handled in the builder, not by string-surgery.
// The plan flags the preference; the builder emits `RETURNING table.*`
// explicitly.

import { err, ok, type Result } from '@/core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '@/core/errors';
import type { QualifiedIdentifier } from '@/http/request';
import type { Preferences } from '@/http/preferences';
import type {
  Filter,
  LogicTree,
  ParsedQueryParams,
} from '@/parser/types';
import type { Payload } from '@/parser/payload';
import type { SchemaCache } from '@/schema/cache';
import { findTable } from '@/schema/cache';
import type { Column, Table } from '@/schema/table';
import { findColumn } from '@/schema/table';
import { resolveRelationship } from '@/schema/relationship';
import type {
  ConflictResolution,
  DeletePlan,
  InsertPlan,
  MutationPlan,
  NestedInsertChild,
  OnConflictPlan,
  PlannedColumn,
  ReturnPreference,
  UpdatePlan,
  WrapShape,
} from './mutation-plan';

export interface PlanMutationInput {
  readonly target: QualifiedIdentifier;
  readonly mutation: 'create' | 'update' | 'delete' | 'singleUpsert';
  readonly parsed: ParsedQueryParams;
  readonly payload: Payload | null;
  readonly preferences: Preferences;
  readonly schema: SchemaCache;
  /** When true, the handler wants the CTE-only form (for a graph return). */
  readonly wrap: WrapShape;
}

export function planMutation(
  input: PlanMutationInput,
): Result<MutationPlan, CloudRestError> {
  const table = findTable(input.schema, input.target);
  if (!table) {
    return err(
      schemaErrors.tableNotFound(
        input.target.name,
        input.target.schema,
        suggestTableName(input.schema, input.target),
      ),
    );
  }

  // WRITABILITY gate — a view without `insertable: true` etc. refuses
  // the mutation before any column math.
  const writabilityError = checkWritability(table, input.mutation);
  if (writabilityError !== null) return err(writabilityError);

  const returnPreference = mapReturnPreference(input.preferences);

  switch (input.mutation) {
    case 'create':
    case 'singleUpsert':
      return planInsert(input, table, returnPreference);
    case 'update':
      return planUpdate(input, table, returnPreference);
    case 'delete':
      return planDelete(input, table, returnPreference);
  }
}

// ----- Insert ----------------------------------------------------------

function planInsert(
  input: PlanMutationInput,
  table: Table,
  returnPreference: ReturnPreference,
): Result<InsertPlan, CloudRestError> {
  const payload = normalizeJsonPayload(input.payload);
  if (!payload.ok) return payload;
  const { isArrayBody } = payload.value;

  const nestedResult = planNestedInserts(input, table, payload.value);
  if (!nestedResult.ok) return nestedResult;
  const { parentRawBody, parentPayloadKeys, nestedInserts } = nestedResult.value;

  // Validate any keys the client sent — unknown columns are a 400.
  for (const key of parentPayloadKeys) {
    if (!findColumn(table, key)) {
      return err(
        schemaErrors.columnNotFound(
          key,
          `${table.schema}.${table.name}`,
          fuzzyFind(key, [...table.columns.keys()]),
        ),
      );
    }
  }

  const missing = input.preferences.preferMissing ?? 'default';

  // ----- #74 column selection -----
  //
  // `missing=default`: emit only the columns the client sent, minus
  //   generated columns. Postgres applies DEFAULTs for the rest.
  // `missing=null`:    emit every non-generated column. Columns not
  //   present in the payload flow through `json_to_record` as NULL
  //   — but if a column has a DEFAULT, we STILL emit it so the
  //   caller gets an explicit NULL override (that matches the old
  //   behavior for `missing=null`).
  const selectedColumns: PlannedColumn[] = [];
  const columnsToEmit =
    missing === 'null'
      ? [...table.columns.values()]
      : [...parentPayloadKeys]
          .map((k) => findColumn(table, k))
          .filter((c): c is Column => c !== undefined);

  for (const col of columnsToEmit) {
    if (col.generated) continue;
    selectedColumns.push({
      name: col.name,
      type: col.type,
      hasDefault: col.defaultValue !== null,
      generated: col.generated,
    });
  }

  // on_conflict validation.
  const onConflict = resolveOnConflict(
    input.mutation,
    input.parsed.onConflict,
    table,
    input.preferences,
  );
  if (!onConflict.ok) return onConflict;

  // An empty JSON array body (`[]`) has `isEmptyPayload=true`
  // AND `isArrayBody=true`. Without this guard the request would flow
  // through the `defaultValues` branch and the builder would emit
  // `INSERT ... DEFAULT VALUES`, inserting ONE default row for a
  // request the user sent as "insert zero rows". Only a non-array
  // empty payload (POST with no body, POST with `{}`) takes the
  // DEFAULT VALUES path; the array form falls through with
  // `columns: []`, and the builder's `WHERE false` escape hatch
  // produces the correct empty-result shape.
  const defaultValues =
    !isArrayBody && parentPayloadKeys.size === 0 && selectedColumns.length === 0;

  return ok({
    kind: 'insert',
    target: input.target,
    rawBody: parentRawBody,
    isArrayBody,
    columns: selectedColumns,
    defaultValues,
    onConflict: onConflict.value,
    primaryKeyColumns: table.primaryKeyColumns,
    returnPreference,
    wrap: input.wrap,
    nestedInserts,
  });
}

// ----- Update ----------------------------------------------------------

function planUpdate(
  input: PlanMutationInput,
  table: Table,
  returnPreference: ReturnPreference,
): Result<UpdatePlan, CloudRestError> {
  const payload = normalizeJsonPayload(input.payload);
  if (!payload.ok) return payload;
  const { rawBody, payloadKeys, isArrayBody } = payload.value;

  // PATCH with an array JSON body is rejected — PATCH semantics are
  // "apply ONE set of values to ALL matched rows", which an array
  // cannot express. PostgREST rejects the same with PGRST102.
  if (isArrayBody) {
    return err(
      parseErrors.invalidBody(
        'PATCH body must be a JSON object, not an array',
      ),
    );
  }

  for (const key of payloadKeys) {
    if (!findColumn(table, key)) {
      return err(
        schemaErrors.columnNotFound(
          key,
          `${table.schema}.${table.name}`,
          fuzzyFind(key, [...table.columns.keys()]),
        ),
      );
    }
  }

  // Embedded filters (`?authors.name=eq.Bob`) are not supported on
  // mutations. A request with ONLY embedded filters would plan with
  // NO WHERE clause — a table-wide UPDATE/DELETE. Refuse at plan
  // time so the builder never sees a mutation missing its WHERE.
  const embeddedCheck = rejectEmbeddedFilters(input.parsed);
  if (embeddedCheck !== null) return err(embeddedCheck);

  // Filters / logic (root only — embedded filters are rejected
  // above).
  const filters: readonly Filter[] = input.parsed.filtersRoot;
  const logic: readonly LogicTree[] = collectRootLogic(input.parsed);

  for (const filter of filters) {
    const check = validateRootFilter(table, filter);
    if (!check.ok) {
      if (check.reason.kind === 'wildcard-not-allowed') {
        return err(
          parseErrors.queryParam(
            'filter',
            'wildcard "*" is not a valid filter column',
          ),
        );
      }
      return err(
        schemaErrors.columnNotFound(
          filter.field.name,
          `${table.schema}.${table.name}`,
          fuzzyFind(filter.field.name, [...table.columns.keys()]),
        ),
      );
    }
  }

  // Validate root logic tree columns so a typo inside a logic tree
  // surfaces as PGRST204 instead of an opaque Postgres error.
  for (const tree of logic) {
    const check = validateLogicTreeColumns(table, tree);
    if (!check.ok) return check;
  }

  const missing = input.preferences.preferMissing ?? 'default';

  const updatableColumns: PlannedColumn[] = [];
  const columnsToEmit =
    missing === 'null'
      ? [...table.columns.values()]
      : [...payloadKeys]
          .map((k) => findColumn(table, k))
          .filter((c): c is Column => c !== undefined);

  for (const col of columnsToEmit) {
    if (col.generated) continue;
    updatableColumns.push({
      name: col.name,
      type: col.type,
      hasDefault: col.defaultValue !== null,
      generated: col.generated,
    });
  }

  return ok({
    kind: 'update',
    target: input.target,
    rawBody,
    columns: updatableColumns,
    filters,
    logic,
    returnPreference,
    wrap: input.wrap,
  });
}

// ----- Delete ----------------------------------------------------------

function planDelete(
  input: PlanMutationInput,
  table: Table,
  returnPreference: ReturnPreference,
): Result<DeletePlan, CloudRestError> {
  // Reject embedded filters — a DELETE with only embedded filters
  // would plan with NO WHERE clause and wipe the table.
  const embeddedCheck = rejectEmbeddedFilters(input.parsed);
  if (embeddedCheck !== null) return err(embeddedCheck);

  const filters: readonly Filter[] = input.parsed.filtersRoot;
  const logic: readonly LogicTree[] = collectRootLogic(input.parsed);

  for (const filter of filters) {
    const check = validateRootFilter(table, filter);
    if (!check.ok) {
      if (check.reason.kind === 'wildcard-not-allowed') {
        return err(
          parseErrors.queryParam(
            'filter',
            'wildcard "*" is not a valid filter column',
          ),
        );
      }
      return err(
        schemaErrors.columnNotFound(
          filter.field.name,
          `${table.schema}.${table.name}`,
          fuzzyFind(filter.field.name, [...table.columns.keys()]),
        ),
      );
    }
  }

  // Validate root logic columns — see planUpdate.
  for (const tree of logic) {
    const check = validateLogicTreeColumns(table, tree);
    if (!check.ok) return check;
  }

  return ok({
    kind: 'delete',
    target: input.target,
    filters,
    logic,
    returnPreference,
    wrap: input.wrap,
  });
}

// ----- Helpers ---------------------------------------------------------

function mapReturnPreference(preferences: Preferences): ReturnPreference {
  return preferences.preferRepresentation ?? 'minimal';
}

function collectRootLogic(parsed: ParsedQueryParams): readonly LogicTree[] {
  const out: LogicTree[] = [];
  for (const [path, tree] of parsed.logic) {
    if (path.length === 0) out.push(tree);
  }
  return out;
}

interface NestedInsertPlanningResult {
  readonly parentRawBody: string;
  readonly parentPayloadKeys: ReadonlySet<string>;
  readonly nestedInserts: readonly NestedInsertChild[];
}

function planNestedInserts(
  input: PlanMutationInput,
  table: Table,
  payload: NormalizedJson,
): Result<NestedInsertPlanningResult, CloudRestError> {
  if (payload.isArrayBody) {
    return ok({
      parentRawBody: payload.rawBody,
      parentPayloadKeys: payload.payloadKeys,
      nestedInserts: [],
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(payload.rawBody);
  } catch {
    return err(parseErrors.invalidBody('Invalid JSON in request body'));
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return ok({
      parentRawBody: payload.rawBody,
      parentPayloadKeys: payload.payloadKeys,
      nestedInserts: [],
    });
  }

  const parentBody: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const nestedInserts: NestedInsertChild[] = [];

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (findColumn(table, key)) continue;
    const relationship = resolveRelationship(
      { schema: table.schema, name: table.name },
      key,
      undefined,
      input.schema.relationships,
    );
    if (relationship.kind !== 'found') continue;
    const rel = relationship.relationship;
    if (rel.cardinality.type !== 'O2M') continue;

    const childTable = findTable(input.schema, rel.foreignTable);
    if (!childTable) {
      return err(
        schemaErrors.tableNotFound(
          rel.foreignTable.name,
          rel.foreignTable.schema,
          null,
        ),
      );
    }

    const rows = normalizeNestedRows(value);
    if (rows === null) continue;
    const [parentRefColumn, childFkColumn] = rel.cardinality.columns[0] ?? [];
    if (parentRefColumn === undefined || childFkColumn === undefined) {
      return err(
        parseErrors.invalidBody(
          `nested insert relationship "${key}" has no foreign-key columns`,
        ),
      );
    }

    const childRows = rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      delete out[childFkColumn];
      return out;
    });
    const childKeys = new Set<string>();
    for (const row of childRows) {
      for (const childKey of Object.keys(row)) childKeys.add(childKey);
    }

    const childColumns: PlannedColumn[] = [];
    for (const childKey of childKeys) {
      const col = findColumn(childTable, childKey);
      if (!col) {
        return err(
          schemaErrors.columnNotFound(
            childKey,
            `${childTable.schema}.${childTable.name}`,
            fuzzyFind(childKey, [...childTable.columns.keys()]),
          ),
        );
      }
      if (col.generated) continue;
      childColumns.push({
        name: col.name,
        type: col.type,
        hasDefault: col.defaultValue !== null,
        generated: col.generated,
      });
    }

    nestedInserts.push({
      relation: key,
      target: rel.foreignTable,
      parentRefColumn,
      childFkColumn,
      columns: childColumns,
      rawBody: JSON.stringify(childRows),
    });
    delete parentBody[key];
  }

  return ok({
    parentRawBody: nestedInserts.length > 0 ? JSON.stringify(parentBody) : payload.rawBody,
    parentPayloadKeys:
      nestedInserts.length > 0
        ? new Set(Object.keys(parentBody))
        : payload.payloadKeys,
    nestedInserts,
  });
}

function normalizeNestedRows(value: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    if (value.every(isPlainObject)) {
      return value as readonly Record<string, unknown>[];
    }
    return null;
  }
  if (isPlainObject(value)) {
    return [value as Record<string, unknown>];
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Refuse wildcard filters at plan time so the error originates from
 * the schema layer where the user's request is being interpreted.
 * Return a discriminated result so the caller can map the two
 * failures distinctly.
 */
type FilterValidationFailure =
  | { readonly kind: 'column-not-found' }
  | { readonly kind: 'wildcard-not-allowed' };

function validateRootFilter(
  table: Table,
  filter: Filter,
): { readonly ok: true } | { readonly ok: false; readonly reason: FilterValidationFailure } {
  if (filter.field.name === '*') {
    return { ok: false, reason: { kind: 'wildcard-not-allowed' } };
  }
  if (findColumn(table, filter.field.name) === undefined) {
    return { ok: false, reason: { kind: 'column-not-found' } };
  }
  return { ok: true };
}

/**
 * Recursively validate every column reference inside a root logic
 * tree (`?or=(...)` / `?and=(...)`). Mirrors plan-read's walker so
 * a typo inside a nested OR surfaces as PGRST204 at plan time, not
 * as an opaque database error.
 */
function validateLogicTreeColumns(
  table: Table,
  tree: LogicTree,
): Result<null, CloudRestError> {
  if (tree.type === 'stmnt') {
    const check = validateRootFilter(table, tree.filter);
    if (check.ok) return ok(null);
    if (check.reason.kind === 'wildcard-not-allowed') {
      return err(
        parseErrors.queryParam(
          'filter',
          'wildcard "*" is not a valid filter column',
        ),
      );
    }
    return err(
      schemaErrors.columnNotFound(
        tree.filter.field.name,
        `${table.schema}.${table.name}`,
        fuzzyFind(tree.filter.field.name, [...table.columns.keys()]),
      ),
    );
  }
  for (const child of tree.children) {
    const check = validateLogicTreeColumns(table, child);
    if (!check.ok) return check;
  }
  return ok(null);
}

/**
 * Refuse a mutation that carries embedded filters or embedded
 * logic trees — `?authors.name=eq.Bob` on a `PATCH /books`. The
 * parser captures these on `filtersNotRoot` / `logic[path.length>0]`
 * but the mutation planner has no mechanism to apply them to the
 * target's WHERE clause. Silently dropping them is a SQL-safety
 * bug: a request that looks scoped to a subset of rows would
 * instead plan with no WHERE at all and touch every row in the
 * table. Surface the shape as PGRST100 so clients get a clear
 * failure instead of a destructive success.
 *
 * Returns `null` when the request is free of embedded filter
 * shapes, otherwise a typed error ready for `err()`.
 */
function rejectEmbeddedFilters(
  parsed: ParsedQueryParams,
): CloudRestError | null {
  if (parsed.filtersNotRoot.length > 0) {
    const first = parsed.filtersNotRoot[0]!;
    const path = first[0].join('.');
    const field = first[1].field.name;
    return parseErrors.queryParam(
      `${path}.${field}`,
      'embedded filters are not supported on mutations',
    );
  }
  for (const [path] of parsed.logic) {
    if (path.length > 0) {
      return parseErrors.queryParam(
        `${path.join('.')}.and/or`,
        'embedded logic trees are not supported on mutations',
      );
    }
  }
  return null;
}

function suggestTableName(
  schema: SchemaCache,
  target: QualifiedIdentifier,
): string | null {
  const candidates: string[] = [];
  for (const t of schema.tables.values()) {
    if (t.schema === target.schema) candidates.push(t.name);
  }
  return fuzzyFind(target.name, candidates);
}

function checkWritability(
  table: Table,
  mutation: 'create' | 'update' | 'delete' | 'singleUpsert',
): CloudRestError | null {
  const qualifiedName = `${table.schema}.${table.name}`;
  switch (mutation) {
    case 'create':
    case 'singleUpsert':
      if (!table.insertable) {
        return schemaErrors.mutationNotAllowed(qualifiedName, 'INSERT');
      }
      return null;
    case 'update':
      if (!table.updatable) {
        return schemaErrors.mutationNotAllowed(qualifiedName, 'UPDATE');
      }
      return null;
    case 'delete':
      if (!table.deletable) {
        return schemaErrors.mutationNotAllowed(qualifiedName, 'DELETE');
      }
      return null;
  }
}

// ----- JSON payload normalization --------------------------------------

interface NormalizedJson {
  readonly rawBody: string;
  readonly isArrayBody: boolean;
  readonly payloadKeys: ReadonlySet<string>;
  readonly isEmptyPayload: boolean;
}

function normalizeJsonPayload(
  payload: Payload | null,
): Result<NormalizedJson, CloudRestError> {
  if (payload === null) {
    // An empty body on POST means "DEFAULT VALUES insert".
    return ok({
      rawBody: '{}',
      isArrayBody: false,
      payloadKeys: new Set<string>(),
      isEmptyPayload: true,
    });
  }
  if (payload.type === 'json') {
    return ok({
      rawBody: payload.raw,
      isArrayBody: payload.raw.trimStart().startsWith('['),
      payloadKeys: payload.keys,
      isEmptyPayload: payload.keys.size === 0,
    });
  }
  if (payload.type === 'urlEncoded') {
    const asObject: Record<string, string> = {};
    for (const [k, v] of payload.pairs) asObject[k] = v;
    return ok({
      rawBody: JSON.stringify(asObject),
      isArrayBody: false,
      payloadKeys: payload.keys,
      isEmptyPayload: payload.keys.size === 0,
    });
  }
  return err(
    parseErrors.invalidBody(
      `cannot plan a mutation from payload type "${payload.type}"`,
    ),
  );
}

// ----- on_conflict resolution ------------------------------------------

function resolveOnConflict(
  mutation: 'create' | 'update' | 'delete' | 'singleUpsert',
  onConflictColumns: readonly string[] | null,
  table: Table,
  preferences: Preferences,
): Result<OnConflictPlan | null, CloudRestError> {
  if (mutation !== 'singleUpsert' && onConflictColumns === null) {
    return ok(null);
  }

  // `Prefer: resolution=merge-duplicates / ignore-duplicates`
  const resolutionPref = preferences.preferResolution ?? 'mergeDuplicates';
  const resolution: ConflictResolution =
    resolutionPref === 'ignoreDuplicates'
      ? 'ignoreDuplicates'
      : 'mergeDuplicates';

  // PUT (singleUpsert) without ?on_conflict= defaults to the PK.
  let columns: readonly string[];
  if (onConflictColumns !== null) {
    columns = onConflictColumns;
  } else {
    if (table.primaryKeyColumns.length === 0) {
      return err(
        parseErrors.queryParam(
          'on_conflict',
          `table "${table.schema}.${table.name}" has no primary key; ?on_conflict= is required`,
        ),
      );
    }
    columns = table.primaryKeyColumns;
  }

  // Validate every on_conflict column.
  for (const c of columns) {
    if (!findColumn(table, c)) {
      return err(
        schemaErrors.columnNotFound(
          c,
          `${table.schema}.${table.name}`,
          fuzzyFind(c, [...table.columns.keys()]),
        ),
      );
    }
  }

  return ok({ resolution, columns });
}
