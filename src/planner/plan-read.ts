// Read planner — turns a ParsedQueryParams + SchemaCache into a ReadPlan.
//
// INVARIANT (CONSTITUTION §1.5): the planner reads schema knowledge,
// validates column references, and emits a typed ReadPlan. It does not
// render SQL.
//
// Stage 6a scope: table resolution, root filter/logic/order column
// validation, distinct column validation, first-class search/vector/
// distinct wiring.
//
// Stage 6b extends that to every query-param shape the parser emits:
//  - embed resolution with relationship lookup, alias/hint, join-type;
//  - embedded filter/logic/order attached to the right subtree;
//  - ?search= / ?search.columns= / ?search.language= → SearchPlan;
//  - ?vector= / ?vector.column= / ?vector.op=   → VectorPlan;
//  - aggregate column validation (select=avg(rating) requires `rating`).

import { err, ok, type Result } from '../core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '../core/errors';
import type { QualifiedIdentifier } from '../http/request';
import type { Preferences } from '../http/preferences';
import type { MediaTypeId } from '../http/media/types';
import { ALL_ROWS, type NonnegRange } from '../http/range';
import type {
  EmbedPath,
  Filter,
  LogicTree,
  OrderTerm,
  ParsedQueryParams,
  SelectItem,
} from '../parser/types';
import type { SchemaCache } from '../schema/cache';
import { findTable } from '../schema/cache';
import type { Table } from '../schema/table';
import { findColumn } from '../schema/table';
import type { DistinctPlan, ReadPlan } from './read-plan';
import { planEmbeds, type EmbedNode } from './embed-plan';
import { planSearch } from './search';
import { planVector } from './vector';

export interface PlanReadInput {
  readonly target: QualifiedIdentifier;
  readonly parsed: ParsedQueryParams;
  readonly preferences: Preferences;
  readonly schema: SchemaCache;
  /** Chosen output media type. Stage 3 (http/media/negotiate) picks this. */
  readonly mediaType: MediaTypeId;
  /**
   * Top-level range, already intersected with any `?limit=` override
   * by the parser dispatcher.
   */
  readonly topLevelRange: NonnegRange;
  /** Whether the database config has a pre-request function. */
  readonly hasPreRequest: boolean;
  /** `config.database.maxRows`. */
  readonly maxRows: number | null;
  /**
   * Raw search params plucked off the URL. The parser owns extraction;
   * the planner owns validation. Optional — callers that don't care
   * (e.g. older tests) can omit it and search is simply not planned.
   */
  readonly search?: {
    readonly term: string | null;
    readonly columns: string | null;
    readonly language: string | null;
    readonly includeRank: boolean;
  };
}

/**
 * Plan a relation-read request.
 */
export function planRead(input: PlanReadInput): Result<ReadPlan, CloudRestError> {
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

  // ----- Root logic / order partitioning ------------------------------
  const rootLogic = collectRootLogic(input.parsed);
  const rootOrder = collectRootOrder(input.parsed);

  // ----- Root filter / logic column validation ------------------------
  for (const filter of input.parsed.filtersRoot) {
    const check = validateFilterColumn(table, filter);
    if (!check.ok) return check;
  }
  for (const tree of rootLogic) {
    const check = validateLogicColumns(table, tree);
    if (!check.ok) return check;
  }

  // ----- Root select validation ----------------------------------------
  // Field items are validated here; relation/spread items are walked by
  // planEmbeds below. Aggregate fields must reference a real column
  // (except `count(*)` which is a wildcard).
  for (const item of input.parsed.select) {
    if (item.type !== 'field') continue;
    const check = validateSelectFieldItem(table, item);
    if (!check.ok) return check;
  }

  // ----- Root ORDER BY column validation -------------------------------
  // Related-order terms (`order=author(name).desc`) are validated inside
  // planEmbeds once the embed set is known.
  for (const term of rootOrder) {
    if (term.relation !== undefined) continue;
    if (term.field.name !== '*' && !findColumn(table, term.field.name)) {
      return err(
        schemaErrors.columnNotFound(
          term.field.name,
          `${table.schema}.${table.name}`,
          suggestColumnName(table, term.field.name),
        ),
      );
    }
  }

  // ----- Embeds --------------------------------------------------------
  const embedResult = planEmbeds({
    rootTable: table,
    rootSelect: input.parsed.select,
    filtersNotRoot: input.parsed.filtersNotRoot,
    logicNotRoot: collectNonRoot(input.parsed.logic),
    orderNotRoot: collectNonRootOrder(input.parsed.order),
    ranges: input.parsed.ranges,
    rootOrder,
    schema: input.schema,
  });
  if (!embedResult.ok) return embedResult;
  const { embeds, rootFieldSelect } = embedResult.value;

  // ----- DISTINCT ------------------------------------------------------
  let distinct: DistinctPlan | undefined;
  if (input.parsed.distinct !== null) {
    for (const col of input.parsed.distinct) {
      if (!findColumn(table, col)) {
        return err(
          schemaErrors.columnNotFound(
            col,
            `${table.schema}.${table.name}`,
            suggestColumnName(table, col),
          ),
        );
      }
    }
    distinct = { columns: input.parsed.distinct };
  }

  // ----- Search --------------------------------------------------------
  const searchResult = planSearch(
    {
      term: input.search?.term ?? null,
      columns: input.search?.columns ?? null,
      language: input.search?.language ?? null,
      includeRank: input.search?.includeRank ?? false,
    },
    table,
  );
  if (!searchResult.ok) return searchResult;
  const search = searchResult.value ?? undefined;

  // ----- Vector --------------------------------------------------------
  const rawVector = input.parsed.vector
    ? {
        value: input.parsed.vector.value,
        column: input.parsed.vector.column,
        op: input.parsed.vector.op,
      }
    : null;
  const vectorResult = planVector(rawVector, table);
  if (!vectorResult.ok) return vectorResult;
  const vector = vectorResult.value ?? undefined;

  // ----- Effective range (maxRows clamp) -------------------------------
  const range = clampRangeToMaxRows(input.topLevelRange, input.maxRows);

  return ok({
    target: input.target,
    // `rootFieldSelect` is the parser's select with embed items
    // stripped out — they live on `embeds` instead. When there are no
    // embeds, `rootFieldSelect === input.parsed.select` by
    // construction. Feeding the field-only list avoids double-
    // processing in the builder.
    select: rootFieldSelect,
    filters: input.parsed.filtersRoot,
    logic: rootLogic,
    order: rootOrder,
    range,
    having: input.parsed.having,
    count: input.preferences.preferCount ?? null,
    mediaType: input.mediaType,
    hasPreRequest: input.hasPreRequest,
    maxRows: input.maxRows,
    distinct,
    search,
    vector,
    embeds,
  });
}

// ----- Root / non-root partitioning -------------------------------------

function collectRootLogic(parsed: ParsedQueryParams): readonly LogicTree[] {
  const out: LogicTree[] = [];
  for (const [path, tree] of parsed.logic) {
    if (path.length === 0) out.push(tree);
  }
  return out;
}

function collectRootOrder(parsed: ParsedQueryParams): readonly OrderTerm[] {
  const out: OrderTerm[] = [];
  for (const [path, group] of parsed.order) {
    if (path.length !== 0) continue;
    for (const term of group) out.push(term);
  }
  return out;
}

function collectNonRoot(
  logic: readonly (readonly [EmbedPath, LogicTree])[],
): readonly (readonly [EmbedPath, LogicTree])[] {
  const out: (readonly [EmbedPath, LogicTree])[] = [];
  for (const entry of logic) {
    if (entry[0].length > 0) out.push(entry);
  }
  return out;
}

function collectNonRootOrder(
  order: readonly (readonly [EmbedPath, readonly OrderTerm[]])[],
): readonly (readonly [EmbedPath, readonly OrderTerm[]])[] {
  const out: (readonly [EmbedPath, readonly OrderTerm[]])[] = [];
  for (const entry of order) {
    if (entry[0].length > 0) out.push(entry);
  }
  return out;
}

// ----- Column validation helpers ---------------------------------------

function validateSelectFieldItem(
  table: Table,
  item: Extract<SelectItem, { type: 'field' }>,
): Result<null, CloudRestError> {
  const name = item.field.name;
  // Bare `*` and `count(*)` (which the parser emits as an aggregate
  // field whose field.name is '*') both pass. Any other aggregate
  // must reference a real column — the parser already rejects
  // `sum(*)` / `avg(*)` etc. at parse time.
  if (name === '*') return ok(null);
  if (!findColumn(table, name)) {
    return err(
      schemaErrors.columnNotFound(
        name,
        `${table.schema}.${table.name}`,
        suggestColumnName(table, name),
      ),
    );
  }
  return ok(null);
}

function validateFilterColumn(
  table: Table,
  filter: Filter,
): Result<null, CloudRestError> {
  const name = filter.field.name;
  if (name === '*') return ok(null);
  if (!findColumn(table, name)) {
    return err(
      schemaErrors.columnNotFound(
        name,
        `${table.schema}.${table.name}`,
        suggestColumnName(table, name),
      ),
    );
  }
  return ok(null);
}

function validateLogicColumns(
  table: Table,
  tree: LogicTree,
): Result<null, CloudRestError> {
  if (tree.type === 'stmnt') return validateFilterColumn(table, tree.filter);
  for (const child of tree.children) {
    const check = validateLogicColumns(table, child);
    if (!check.ok) return check;
  }
  return ok(null);
}

// ----- Range clamp ------------------------------------------------------

/**
 * Intersect a range with `config.database.maxRows`. Null = unlimited.
 *
 * If the planned limit exceeds maxRows, clamp down. This is the
 * planner-level enforcement of the config; the builder still emits
 * whatever the plan says.
 */
function clampRangeToMaxRows(
  range: NonnegRange,
  maxRows: number | null,
): NonnegRange {
  if (maxRows === null) return range;
  if (range.limit === null) return { offset: range.offset, limit: maxRows };
  return { offset: range.offset, limit: Math.min(range.limit, maxRows) };
}

// ----- Suggestions ------------------------------------------------------

function suggestTableName(
  schema: SchemaCache,
  target: QualifiedIdentifier,
): string | null {
  const candidates: string[] = [];
  for (const table of schema.tables.values()) {
    if (table.schema === target.schema) candidates.push(table.name);
  }
  return fuzzyFind(target.name, candidates);
}

function suggestColumnName(table: Table, name: string): string | null {
  return fuzzyFind(name, [...table.columns.keys()]);
}

// Re-export ALL_ROWS for handlers that need it as a default.
export { ALL_ROWS };

// Re-export EmbedNode for downstream consumers that only want the root
// type barrel.
export type { EmbedNode };
