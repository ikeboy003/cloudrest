// Embed planner — walks the parser's select tree against the schema
// relationships and produces a typed tree of `EmbedNode`s for the
// builder to render as LATERAL joins (or correlated subqueries, for
// aggregate embeds).
//
// INVARIANT (CONSTITUTION §1.5): every embed is resolved, validated,
// and annotated with its join-shape BEFORE any SQL is emitted. The
// builder gets a fully typed plan and never needs to re-consult the
// schema cache.
//
// INVARIANT (#125): the depth guard (`MAX_EMBED_DEPTH`) caps
// recursion so circular or pathological relationship graphs cannot
// wedge the planner.

import { err, ok, type Result } from '../core/result';
import {
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '../core/errors';
import type { QualifiedIdentifier } from '../http/request';
import { ALL_ROWS, type NonnegRange } from '../http/range';
import type {
  EmbedPath,
  Filter,
  JoinType,
  LogicTree,
  OrderTerm,
  SelectItem,
} from '../parser/types';
import type { SchemaCache } from '../schema/cache';
import { findTable } from '../schema/cache';
import type { Table } from '../schema/table';
import { findColumn } from '../schema/table';
import type { Relationship } from '../schema/relationship';
import {
  relationshipIsToOne,
  resolveRelationship,
} from '../schema/relationship';

/** Maximum embed nesting depth. Matches old-code safety limit. */
export const MAX_EMBED_DEPTH = 8;

// ----- Embed plan types -------------------------------------------------

export interface EmbedNode {
  readonly relationship: Relationship;
  /** JSON-output name — explicit alias or the embed name. */
  readonly alias: string;
  readonly joinType: JoinType;
  readonly isSpread: boolean;
  /** True when the embed renders as a scalar (M2O / O2O). */
  readonly isToOne: boolean;
  /** True when every child select item is an aggregate — rendered as a correlated subquery. */
  readonly isAggregate: boolean;
  readonly child: ReadPlanSubtree;
}

export interface ReadPlanSubtree {
  readonly target: QualifiedIdentifier;
  readonly select: readonly SelectItem[];
  readonly filters: readonly Filter[];
  readonly logic: readonly LogicTree[];
  readonly order: readonly OrderTerm[];
  readonly range: NonnegRange;
  readonly embeds: readonly EmbedNode[];
}

// ----- Input shape ------------------------------------------------------

export interface PlanEmbedsInput {
  readonly rootTable: Table;
  readonly rootSelect: readonly SelectItem[];
  /** Flat list of every non-root filter with its path. */
  readonly filtersNotRoot: readonly (readonly [EmbedPath, Filter])[];
  /** Flat list of every non-root logic tree with its path. */
  readonly logicNotRoot: readonly (readonly [EmbedPath, LogicTree])[];
  /** Flat list of every non-root order group with its path. */
  readonly orderNotRoot: readonly (readonly [EmbedPath, readonly OrderTerm[]])[];
  /** `?foo.bar.limit=N` style range overrides, keyed by path joined with `\0`. */
  readonly ranges: ReadonlyMap<string, NonnegRange>;
  /** Root-level order terms — used to validate related-order references. */
  readonly rootOrder: readonly OrderTerm[];
  readonly schema: SchemaCache;
}

// ----- Planner ----------------------------------------------------------

/**
 * Walk the root select items, resolving every embed against the schema
 * relationships map. Returns the list of root-level embeds plus the
 * remaining (non-embed) select items — i.e. the pure field projection.
 */
export function planEmbeds(
  input: PlanEmbedsInput,
): Result<
  {
    readonly embeds: readonly EmbedNode[];
    readonly rootFieldSelect: readonly SelectItem[];
  },
  CloudRestError
> {
  const rootFieldSelect: SelectItem[] = [];
  const embeds: EmbedNode[] = [];

  for (const item of input.rootSelect) {
    if (item.type === 'field') {
      rootFieldSelect.push(item);
      continue;
    }
    const embedResult = resolveEmbed(item, input.rootTable, [], input, 1);
    if (!embedResult.ok) return embedResult;
    embeds.push(embedResult.value);
  }

  // Validate any root-level `order=relation(col)` references against the
  // now-known embed tree. To-many embeds are JSON arrays — ordering the
  // parent by them is meaningless — so reject with PGRST108.
  for (const term of input.rootOrder) {
    if (term.relation === undefined) continue;
    const match =
      embeds.find((e) => e.alias === term.relation) ??
      embeds.find((e) => e.child.target.name === term.relation);
    if (!match) {
      return err(
        parseErrors.queryParam(
          'order',
          `order refers to "${term.relation}" which is not an embedded relation on this request`,
        ),
      );
    }
    if (!match.isToOne) {
      return err({
        code: 'PGRST108',
        message: `Ordering by "${term.relation}" is not allowed — "${term.relation}" is a to-many embed`,
        details: 'Only to-one relationships can be used as ORDER BY targets',
        hint: null,
        httpStatus: 400,
      });
    }
  }

  return ok({ embeds, rootFieldSelect });
}

// ----- Recursive helper -------------------------------------------------

function resolveEmbed(
  item: Exclude<SelectItem, { type: 'field' }>,
  parentTable: Table,
  pathPrefix: readonly string[],
  input: PlanEmbedsInput,
  depth: number,
): Result<EmbedNode, CloudRestError> {
  if (depth > MAX_EMBED_DEPTH) {
    return err({
      code: 'PGRST125',
      message: `Embedding depth exceeds maximum of ${MAX_EMBED_DEPTH} levels`,
      details: `Path: ${pathPrefix.join(' → ')}`,
      hint: 'Reduce the nesting depth of your select parameter, or fetch nested resources in a separate request.',
      httpStatus: 400,
    });
  }

  const embedName = item.relation;
  const hint = item.hint;
  const joinType: JoinType = item.joinType ?? 'left';
  const isSpread = item.type === 'spread';
  const alias =
    item.type === 'relation' && item.alias !== undefined ? item.alias : embedName;

  const parentQi: QualifiedIdentifier = {
    schema: parentTable.schema,
    name: parentTable.name,
  };

  const resolution = resolveRelationship(
    parentQi,
    embedName,
    hint,
    input.schema.relationships,
  );

  if (resolution.kind === 'not-found') {
    return err({
      code: 'PGRST202',
      message: `Could not find a relationship between '${parentTable.name}' and '${embedName}' in the schema cache`,
      details: `Searched for a foreign-key relationship between '${parentTable.name}' and '${embedName}' in the schema '${parentTable.schema}'`,
      hint:
        hint !== undefined
          ? `Hint: ${hint}`
          : `If a new relationship was added, try reloading the schema cache.`,
      httpStatus: 400,
    });
  }
  if (resolution.kind === 'ambiguous') {
    const details = resolution.candidates
      .map((r) => {
        const card = r.cardinality;
        const cons =
          card.type === 'M2M'
            ? `${card.junction.constraint1}, ${card.junction.constraint2}`
            : card.constraint;
        return `Relationship: ${cons}`;
      })
      .join('; ');
    return err({
      code: 'PGRST200',
      message: `Could not embed because more than one relationship was found for '${parentTable.name}' and '${embedName}'`,
      details,
      hint: `Try disambiguating the embedding with a hint: ${embedName}!<constraint_name>(...)`,
      httpStatus: 300,
    });
  }

  const rel = resolution.relationship;
  const isToOne = relationshipIsToOne(rel);
  const childTable = findTable(input.schema, rel.foreignTable);
  if (!childTable) {
    // Should not happen if the relationships map is well-formed, but
    // surface as a schema error rather than crashing.
    return err(
      schemaErrors.tableNotFound(
        rel.foreignTable.name,
        rel.foreignTable.schema,
        null,
      ),
    );
  }

  const childPath: readonly string[] = [...pathPrefix, embedName];
  const childPathKey = childPath.join('\0');

  // Child filters / logic / order from query params that target this
  // exact path. Matching is strict: the depth and every segment must
  // line up.
  const childFilters: Filter[] = [];
  for (const [p, f] of input.filtersNotRoot) {
    if (pathMatches(p, childPath)) childFilters.push(f);
  }
  const childLogic: LogicTree[] = [];
  for (const [p, t] of input.logicNotRoot) {
    if (pathMatches(p, childPath)) childLogic.push(t);
  }
  const childOrderFromParams: OrderTerm[] = [];
  for (const [p, group] of input.orderNotRoot) {
    if (pathMatches(p, childPath)) {
      for (const term of group) childOrderFromParams.push(term);
    }
  }

  // Inline select `rel(a,b,c)` wins over an implicit `*`. An undefined
  // innerSelect means "no parens at all", which matches PostgREST's
  // default of selecting everything.
  const childSelectItems: readonly SelectItem[] =
    item.innerSelect !== undefined
      ? item.innerSelect
      : [{ type: 'field', field: { name: '*', jsonPath: [] } }];

  // Range precedence: inline `rel(limit=5,offset=0)` beats query-param
  // `?rel.limit=5`.
  let childRange: NonnegRange;
  if (item.embedLimit !== undefined || item.embedOffset !== undefined) {
    childRange = {
      offset: item.embedOffset ?? 0,
      limit: item.embedLimit ?? null,
    };
  } else {
    childRange = input.ranges.get(childPathKey) ?? ALL_ROWS;
  }

  const childOrder: readonly OrderTerm[] =
    item.embedOrder !== undefined && item.embedOrder.length > 0
      ? item.embedOrder
      : childOrderFromParams;

  // Recurse: split the child's own select list into fields + nested embeds.
  const childFieldSelect: SelectItem[] = [];
  const childEmbeds: EmbedNode[] = [];
  for (const childItem of childSelectItems) {
    if (childItem.type === 'field') {
      // Validate the column — wildcard and aggregate-only shapes are OK.
      if (
        childItem.field.name !== '*' &&
        childItem.aggregateFunction === undefined &&
        !findColumn(childTable, childItem.field.name)
      ) {
        return err(
          schemaErrors.columnNotFound(
            childItem.field.name,
            `${childTable.schema}.${childTable.name}`,
            null,
          ),
        );
      }
      childFieldSelect.push(childItem);
      continue;
    }
    const nested = resolveEmbed(
      childItem,
      childTable,
      childPath,
      input,
      depth + 1,
    );
    if (!nested.ok) return nested;
    childEmbeds.push(nested.value);
  }

  // Validate the child's own filter/logic/order columns.
  for (const f of childFilters) {
    const check = validateFilterColumn(childTable, f);
    if (!check.ok) return check;
  }
  for (const t of childLogic) {
    const check = validateLogicColumns(childTable, t);
    if (!check.ok) return check;
  }
  for (const term of childOrder) {
    if (term.relation !== undefined) continue; // deeper relation — only validated at its own depth
    if (term.field.name !== '*' && !findColumn(childTable, term.field.name)) {
      return err(
        schemaErrors.columnNotFound(
          term.field.name,
          `${childTable.schema}.${childTable.name}`,
          null,
        ),
      );
    }
  }

  // Detect aggregate embeds: every child-select field is an aggregate
  // and there are no nested embeds inside it. These render as correlated
  // scalar subqueries rather than LATERAL joins.
  const allAggregateFields =
    childFieldSelect.length > 0 &&
    childFieldSelect.every(
      (s) => s.type === 'field' && s.aggregateFunction !== undefined,
    );
  const isAggregate = allAggregateFields && childEmbeds.length === 0;

  const child: ReadPlanSubtree = {
    target: rel.foreignTable,
    select: childFieldSelect,
    filters: childFilters,
    logic: childLogic,
    order: childOrder,
    range: childRange,
    embeds: childEmbeds,
  };

  return ok({
    relationship: rel,
    alias,
    joinType,
    isSpread,
    isToOne,
    isAggregate,
    child,
  });
}

// ----- Path / validation helpers ----------------------------------------

function pathMatches(
  path: EmbedPath,
  target: readonly string[],
): boolean {
  if (path.length !== target.length) return false;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== target[i]) return false;
  }
  return true;
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
        null,
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
