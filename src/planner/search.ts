// Full-text search planner — parses `?search=`, `?search.columns=`,
// and `?search.language=` into a typed `SearchPlan`.
//
// INVARIANT: the planner validates the column list
// against the schema BEFORE handing off to the builder. The old code
// silently dropped unknown columns and could degrade a request into a
// match-nothing tsvector (IDENTIFIER-11). The rewrite rejects unknown
// columns outright with PGRST204.
//
// INVARIANT (#10): the language token is narrowed to a safe character
// class (`[a-zA-Z0-9_-]+`). Anything else is a PGRST100 parse error,
// not a silent downgrade to `'simple'`.

import { err, ok, type Result } from '@/core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '@/core/errors';
import type { Table } from '@/schema/table';
import { findColumn } from '@/schema/table';
import type { SearchPlan } from './read-plan';

const SAFE_LANGUAGE_RE = /^[a-zA-Z0-9_-]+$/;

export interface RawSearchParams {
  readonly term: string | null;
  readonly columns: string | null;
  readonly language: string | null;
  /** `?search.rank=true` opts into the `ts_rank(...) AS relevance` projection. */
  readonly includeRank: boolean;
}

/**
 * Plan a search clause against a concrete table.
 *
 * Returns `null` (wrapped in ok) when no `?search=` param is present —
 * search is an optional request feature.
 */
export function planSearch(
  params: RawSearchParams,
  table: Table,
): Result<SearchPlan | null, CloudRestError> {
  if (params.term === null) return ok(null);

  // Column list — required. The old code defaulted to "no columns" and
  // produced a match-nothing tsvector; the rewrite requires an explicit
  // list so the user gets a 400 if they forget it.
  const columns = splitColumnList(params.columns);
  if (columns.length === 0) {
    return err(
      parseErrors.queryParam(
        'search.columns',
        'search requires at least one column in ?search.columns=',
      ),
    );
  }

  // Reject unknown columns with PGRST204 + fuzzy hint. This is the
  // IDENTIFIER-11 fix: no silent filtering.
  for (const col of columns) {
    if (!findColumn(table, col)) {
      return err(
        schemaErrors.columnNotFound(
          col,
          `${table.schema}.${table.name}`,
          fuzzyFind(col, [...table.columns.keys()]),
        ),
      );
    }
  }

  const language = params.language ?? 'simple';
  if (!SAFE_LANGUAGE_RE.test(language)) {
    return err(
      parseErrors.queryParam(
        'search.language',
        `invalid language token: "${language}"`,
      ),
    );
  }

  return ok({
    term: params.term,
    columns,
    language,
    includeRank: params.includeRank,
  });
}

function splitColumnList(raw: string | null): readonly string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}
