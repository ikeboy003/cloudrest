// Mutation planner — turns (ParsedQueryParams + Payload + Preferences
// + SchemaCache) into a typed `MutationPlan`.
//
// INVARIANT (CONSTITUTION §1.5): schema-aware validation lives here.
// The builder trusts the plan and never revalidates column names.
//
// INVARIANT (critique #74): defaulted columns that are absent from
// the payload are EXCLUDED from the INSERT column list so the DB
// applies the DEFAULT. For `Prefer: missing=null`, the planner
// INCLUDES every non-defaulted column so `json_to_record` returns
// NULL — matching PostgREST's semantics.
//
// INVARIANT (critique #76): `RETURNING` fields are handled in the
// builder, not by string-surgery. The plan flags the preference;
// the builder emits `RETURNING table.*` explicitly.

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
import type {
  ConflictResolution,
  DeletePlan,
  InsertPlan,
  MutationPlan,
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
  const { rawBody, isArrayBody, payloadKeys, isEmptyPayload } = payload.value;

  // Validate any keys the client sent — unknown columns are a 400.
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
      : [...payloadKeys]
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

  // BUG FIX: an empty JSON array body (`[]`) has `isEmptyPayload=true`
  // AND `isArrayBody=true`. Without this guard the request would flow
  // through the `defaultValues` branch and the builder would emit
  // `INSERT ... DEFAULT VALUES`, inserting ONE default row for a
  // request the user sent as "insert zero rows". Only a non-array
  // empty payload (POST with no body, POST with `{}`) takes the
  // DEFAULT VALUES path; the array form falls through with
  // `columns: []`, and the builder's `WHERE false` escape hatch
  // produces the correct empty-result shape.
  const defaultValues =
    isEmptyPayload && !isArrayBody && selectedColumns.length === 0;

  return ok({
    kind: 'insert',
    target: input.target,
    rawBody,
    isArrayBody,
    columns: selectedColumns,
    defaultValues,
    onConflict: onConflict.value,
    primaryKeyColumns: table.primaryKeyColumns,
    returnPreference,
    wrap: input.wrap,
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

  // BUG FIX: PATCH with an array JSON body used to flow through
  // the builder as-is, where `json_to_record($1::json)` would
  // fail at Postgres runtime with an opaque parse error because
  // it expects a JSON object, not an array. PostgREST rejects
  // the same request at parse time with PGRST102. Mirror that
  // behavior — PATCH semantics are "apply ONE set of values to
  // ALL matched rows", which an array cannot express.
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

  // BUG FIX: embedded filters (`?authors.name=eq.Bob`) are not
  // supported on mutations. The parser collects them on
  // `filtersNotRoot` and the planner used to silently ignore that
  // list, which meant a request with ONLY embedded filters planned
  // with NO WHERE clause — a table-wide UPDATE/DELETE. Refuse the
  // request at plan time so the builder never sees a mutation
  // missing its WHERE.
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

  // BUG FIX: root logic trees (`?or=(...)`) used to reach the SQL
  // layer without any column validation — a typo inside a logic
  // tree surfaced as an opaque Postgres error. Walk the tree the
  // same way plan-read does so bad columns become clean PGRST204.
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
  // BUG FIX: reject embedded filters — see planUpdate for context.
  // A DELETE with only embedded filters would plan with NO WHERE
  // clause and wipe the table.
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

  // BUG FIX: validate root logic columns — see planUpdate.
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

/**
 * BUG FIX (#HH9): the old helper returned `true` for wildcard
 * filters, which left the planner accepting `*=eq.1` and leaving
 * the builder to reject it. Refuse at plan time so the error
 * originates from the schema layer where the user's request is
 * being interpreted. Return a discriminated result so the caller
 * can map the two failures distinctly.
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
