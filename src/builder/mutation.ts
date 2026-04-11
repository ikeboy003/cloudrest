// Mutation SQL builder — ONE renderer for INSERT / UPDATE / DELETE /
// UPSERT (READABILITY_REVIEW §8, critique #8).
//
// INVARIANT (CONSTITUTION §1.1, §1.6): a `MutationPlan.wrap` flag
// selects between the wrapped-result form and the CTE-only form.
// The old code had four parallel `buildXQuery` / `buildXCte` pairs;
// this module replaces them.
//
// INVARIANT (critique #76): `RETURNING` is emitted as
// `RETURNING "schema"."table".*` — schema-qualified. The old code's
// bare `RETURNING *` in UPDATE joined against `pgrst_body` produced
// duplicate column names in the result set.
//
// RUNTIME (CONSTITUTION §1.3 exception): the JSON body for
// `INSERT` / `UPDATE` is inlined via `pgFmtLit(body)::jsonb`, NOT
// bound via `SqlBuilder.addParam`. `postgres.js` sends every bind
// parameter as text, and `json_to_record($1::json)` (or
// `jsonb_to_record($1::jsonb)`) inside a prepared statement fails
// with Postgres error 22023 "cannot call populate_composite on a
// scalar" because the prepare step resolves the parameter type
// before the `::json` cast applies. PostgREST uses Hasql's
// `jsonLazyBytes` encoder to sidestep this; the Workers runtime
// has no equivalent. `pgFmtLit` is the same SECURITY-audited
// helper the old code uses and is hardened against both single-
// quote and backslash injection. See
// `cloudrest-public/src/builder/fragments.ts::inlineJsonLiteral`
// for the original source.

import { err, ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import type {
  DeletePlan,
  InsertPlan,
  MutationPlan,
  UpdatePlan,
} from '@/planner/mutation-plan';
import { renderFilter, renderLogicTree } from './fragments';
import {
  escapeIdent,
  pgFmtLit,
  qualifiedIdentifierToSql,
} from './identifiers';
import { SqlBuilder } from './sql';
import type { BuiltQuery } from './types';

/** Inline a JSON body as a Postgres `jsonb` literal. See file header. */
function inlineJsonbLiteral(body: string): string {
  return `${pgFmtLit(body)}::jsonb`;
}

// ----- Public entry point ----------------------------------------------

export function buildMutationQuery(
  plan: MutationPlan,
): Result<BuiltQuery, CloudRestError> {
  switch (plan.kind) {
    case 'insert':
      return buildInsert(plan);
    case 'update':
      return buildUpdate(plan);
    case 'delete':
      return buildDelete(plan);
  }
}

// ----- INSERT ----------------------------------------------------------

function buildInsert(plan: InsertPlan): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const tableSql = qualifiedIdentifierToSql(plan.target);

  let cte: string;
  if (plan.defaultValues) {
    cte = `WITH pgrst_source AS (INSERT INTO ${tableSql} DEFAULT VALUES ${renderReturning(plan)})`;
  } else if (plan.columns.length === 0) {
    // Payload had keys but none matched any column; return an empty
    // result instead of inserting defaults (prevents silent
    // "you sent garbage, I inserted a row" surprises).
    cte = `WITH pgrst_source AS (SELECT * FROM ${tableSql} WHERE false)`;
  } else {
    const colList = plan.columns.map((c) => escapeIdent(c.name)).join(', ');
    const typedCols = plan.columns
      .map((c) => `${escapeIdent(c.name)} ${c.type}`)
      .join(', ');
    // RUNTIME override: see file header. The JSON body is inlined
    // as a `::jsonb` literal via `pgFmtLit` because
    // `json_to_record($1::json)` cannot be prepared against a
    // postgres.js text-typed parameter.
    const bodyLiteral = inlineJsonbLiteral(plan.rawBody);
    const jsonFunc = plan.isArrayBody
      ? 'jsonb_to_recordset'
      : 'jsonb_to_record';
    const limitOne = plan.isArrayBody ? '' : ' LIMIT 1';
    const conflictClause = renderOnConflict(plan);

    cte =
      `WITH pgrst_source AS (` +
      `INSERT INTO ${tableSql} (${colList}) ` +
      `SELECT ${colList} FROM ${jsonFunc}(${bodyLiteral}) AS _(${typedCols})${limitOne}` +
      `${conflictClause} ${renderReturning(plan)})`;
  }

  return finalizeBuild(plan, cte, builder);
}

function renderOnConflict(plan: InsertPlan): string {
  if (!plan.onConflict) return '';
  const conflictCols = plan.onConflict.columns
    .map((c) => escapeIdent(c))
    .join(', ');
  if (plan.onConflict.resolution === 'ignoreDuplicates') {
    return ` ON CONFLICT(${conflictCols}) DO NOTHING`;
  }
  // merge-duplicates — exclude the conflict columns themselves from
  // the SET list (Postgres allows `id = EXCLUDED.id` but it's a
  // no-op and breaks partial indexes).
  const conflictSet = new Set(plan.onConflict.columns);
  const nonConflictCols = plan.columns.filter((c) => !conflictSet.has(c.name));
  if (nonConflictCols.length === 0) {
    return ` ON CONFLICT(${conflictCols}) DO NOTHING`;
  }
  const updateSets = nonConflictCols
    .map((c) => `${escapeIdent(c.name)} = EXCLUDED.${escapeIdent(c.name)}`)
    .join(', ');
  return ` ON CONFLICT(${conflictCols}) DO UPDATE SET ${updateSets}`;
}

// ----- UPDATE ----------------------------------------------------------

function buildUpdate(plan: UpdatePlan): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const tableSql = qualifiedIdentifierToSql(plan.target);

  let cte: string;
  if (plan.columns.length === 0) {
    cte = `WITH pgrst_source AS (SELECT * FROM ${tableSql} WHERE false)`;
  } else {
    const setClauses = plan.columns
      .map(
        (c) =>
          `${escapeIdent(c.name)} = pgrst_body.${escapeIdent(c.name)}`,
      )
      .join(', ');
    const typedCols = plan.columns
      .map((c) => `${escapeIdent(c.name)} ${c.type}`)
      .join(', ');
    // RUNTIME override: see file header. JSON body is inlined.
    const bodyLiteral = inlineJsonbLiteral(plan.rawBody);

    const wherePartsResult = renderWhereParts(
      plan.target,
      plan.filters,
      plan.logic,
      builder,
    );
    if (!wherePartsResult.ok) return wherePartsResult;
    const whereStr = wherePartsResult.value;

    cte =
      `WITH pgrst_source AS (` +
      `UPDATE ${tableSql} SET ${setClauses} ` +
      `FROM jsonb_to_record(${bodyLiteral}) AS pgrst_body(${typedCols})` +
      `${whereStr} ${renderReturning(plan)})`;
  }

  return finalizeBuild(plan, cte, builder);
}

// ----- DELETE ----------------------------------------------------------

function buildDelete(plan: DeletePlan): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const tableSql = qualifiedIdentifierToSql(plan.target);

  const wherePartsResult = renderWhereParts(
    plan.target,
    plan.filters,
    plan.logic,
    builder,
  );
  if (!wherePartsResult.ok) return wherePartsResult;
  const whereStr = wherePartsResult.value;

  const cte =
    `WITH pgrst_source AS (` +
    `DELETE FROM ${tableSql}${whereStr} ${renderReturning(plan)})`;

  return finalizeBuild(plan, cte, builder);
}

// ----- Shared helpers --------------------------------------------------

/**
 * BUG FIX (#76): `RETURNING *` on an UPDATE/INSERT that joins against
 * a JSON source relation duplicates every column the client sent —
 * once from the table, once from `pgrst_body` / `_`. The schema-
 * qualified form is the minimal fix and is consistent with PostgREST.
 */
function renderReturning(plan: MutationPlan): string {
  if (
    plan.returnPreference === 'full' ||
    plan.returnPreference === 'headersOnly'
  ) {
    return `RETURNING ${qualifiedIdentifierToSql(plan.target)}.*`;
  }
  return 'RETURNING 1';
}

function renderWhereParts(
  target: InsertPlan['target'],
  filters: readonly Parameters<typeof renderFilter>[1][],
  logic: readonly Parameters<typeof renderLogicTree>[1][],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const parts: string[] = [];
  for (const f of filters) {
    const rendered = renderFilter(target, f, builder);
    if (!rendered.ok) return rendered;
    parts.push(rendered.value);
  }
  for (const t of logic) {
    const rendered = renderLogicTree(target, t, builder);
    if (!rendered.ok) return rendered;
    parts.push(rendered.value);
  }
  return ok(parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '');
}

/**
 * Wrap the mutation CTE with the standard result shape, unless the
 * plan asked for the CTE-only form (used by Stage 9+ graph-return).
 */
function finalizeBuild(
  plan: MutationPlan,
  cte: string,
  builder: SqlBuilder,
): Result<BuiltQuery, CloudRestError> {
  if (plan.wrap === 'cteOnly') {
    builder.write(cte);
    return ok(builder.toBuiltQuery());
  }

  const bodyExpr =
    plan.returnPreference === 'full'
      ? `coalesce(json_agg(pgrst_source), '[]')::text`
      : `'[]'::text`;

  const locationExpr = renderLocationExpr(plan);

  const wrapper =
    `${cte} SELECT ` +
    `null::bigint AS total_result_set, ` +
    `pg_catalog.count(pgrst_source) AS page_total, ` +
    `${locationExpr} AS header, ` +
    `${bodyExpr} AS body, ` +
    `nullif(current_setting('response.headers', true), '') AS response_headers, ` +
    `nullif(current_setting('response.status',  true), '') AS response_status ` +
    `FROM pgrst_source`;

  builder.write(wrapper);
  return ok(builder.toBuiltQuery());
}

/**
 * Render the Location-header array expression. Empty for UPDATE/DELETE;
 * INSERT with a primary key emits a `key=value` array of PK columns.
 */
function renderLocationExpr(plan: MutationPlan): string {
  if (plan.kind !== 'insert') return `array[]::text[]`;
  if (plan.primaryKeyColumns.length === 0) return `array[]::text[]`;
  const pkLiterals = plan.primaryKeyColumns
    .map((c) => `'${c.replace(/'/g, "''")}'`)
    .join(',');
  return (
    `(SELECT array_agg(json_data.key || '=' || coalesce('eq.' || json_data.value, 'is.null')) ` +
    `FROM (SELECT row_to_json(pgrst_source.*) AS row FROM pgrst_source LIMIT 1) data ` +
    `CROSS JOIN json_each_text(data.row) AS json_data ` +
    `WHERE json_data.key IN (${pkLiterals}))`
  );
}
