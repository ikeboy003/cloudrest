// Read planner — turns a ParsedQueryParams + SchemaCache into a ReadPlan.
//
// INVARIANT (CONSTITUTION §1.5): the planner reads schema knowledge,
// validates column references, and emits a typed ReadPlan. It does not
// render SQL.
//
// Stage 6a scope: table resolution, root filter/logic/order column
// validation, distinct column validation, first-class search/vector/
// distinct wiring. Embeds and relationships land in stage 6b.

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
  Filter,
  LogicTree,
  OrderTerm,
  ParsedQueryParams,
} from '../parser/types';
import type { SchemaCache } from '../schema/cache';
import { findTable } from '../schema/cache';
import type { Table } from '../schema/table';
import { findColumn } from '../schema/table';
import type { DistinctPlan, ReadPlan } from './read-plan';

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

  // Stage 6a: no embeds yet. Reject anything that needs embed support.
  if (input.parsed.filtersNotRoot.length > 0) {
    return err(
      parseErrors.notImplemented(
        'embedded filters require embed planning (stage 6b)',
      ),
    );
  }

  const rootLogicResult = rootLogicTrees(input.parsed);
  if (!rootLogicResult.ok) return rootLogicResult;

  // Validate root filter columns.
  for (const filter of input.parsed.filtersRoot) {
    const check = validateFilterColumn(table, filter);
    if (!check.ok) return check;
  }
  for (const tree of rootLogicResult.value) {
    const check = validateLogicColumns(table, tree);
    if (!check.ok) return check;
  }

  // Validate select items and reject embed items.
  for (const item of input.parsed.select) {
    if (item.type === 'relation' || item.type === 'spread') {
      return err(
        parseErrors.notImplemented(
          'embedded relations require embed planning (stage 6b)',
        ),
      );
    }
    if (item.aggregateFunction !== undefined) continue; // aggregate-only — no direct column check
    if (item.field.name === '*') continue;
    if (!findColumn(table, item.field.name)) {
      return err(
        schemaErrors.columnNotFound(
          item.field.name,
          `${table.schema}.${table.name}`,
          suggestColumnName(table, item.field.name),
        ),
      );
    }
  }

  // Root ORDER BY — no embed-qualified terms at stage 6a.
  const rootOrderResult = rootOrderTerms(input.parsed);
  if (!rootOrderResult.ok) return rootOrderResult;
  for (const term of rootOrderResult.value) {
    if (term.relation !== undefined) {
      return err(
        parseErrors.notImplemented(
          'related-order requires embed planning (stage 6b)',
        ),
      );
    }
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

  // DISTINCT columns — critique IDENTIFIER-5 fix: validate before SQL.
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

  // Effective range: intersect the topLevelRange with maxRows.
  const range = clampRangeToMaxRows(input.topLevelRange, input.maxRows);

  return ok({
    target: input.target,
    select: input.parsed.select,
    filters: input.parsed.filtersRoot,
    logic: rootLogicResult.value,
    order: rootOrderResult.value,
    range,
    having: input.parsed.having,
    count: input.preferences.preferCount ?? null,
    mediaType: input.mediaType,
    hasPreRequest: input.hasPreRequest,
    maxRows: input.maxRows,
    distinct,
    // Stage 6a does not populate search/vector; stage 6b wires the parser.
  });
}

// ----- Helpers ---------------------------------------------------------

function rootLogicTrees(
  parsed: ParsedQueryParams,
): Result<readonly LogicTree[], CloudRestError> {
  const trees: LogicTree[] = [];
  for (const [path, tree] of parsed.logic) {
    if (path.length !== 0) {
      return err(
        parseErrors.notImplemented(
          'embedded logic trees require embed planning (stage 6b)',
        ),
      );
    }
    trees.push(tree);
  }
  return ok(trees);
}

function rootOrderTerms(
  parsed: ParsedQueryParams,
): Result<readonly OrderTerm[], CloudRestError> {
  const terms: OrderTerm[] = [];
  for (const [path, group] of parsed.order) {
    if (path.length !== 0) {
      return err(
        parseErrors.notImplemented(
          'embedded order terms require embed planning (stage 6b)',
        ),
      );
    }
    for (const term of group) terms.push(term);
  }
  return ok(terms);
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
