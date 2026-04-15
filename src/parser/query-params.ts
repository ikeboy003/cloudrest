// Top-level query-param dispatcher.
//
// INVARIANT: This file is THIN. Every grammar lives in its own file under
// parser/. This file's job is to route each URL parameter to its grammar
// module and assemble the ParsedQueryParams output. See ARCHITECTURE.md
// § Parser boundary.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import { parseDistinct } from './distinct';
import { parseFilter } from './filter';
import { parseHavingClauses } from './having';
import { parseLogicTree, type LogicOp } from './logic';
import { parseOrder } from './order';
import { parseSelect } from './select';
import { splitTopLevel, strictParseNonNegInt } from './tokenize';
import type { EmbedPath } from './types/embed';
import type { Filter } from './types/filter';
import type { HavingClause } from './types/having';
import type { LogicTree } from './types/logic';
import type { OrderTerm } from './types/order';
import type { ParsedQueryParams } from './types/query';
import type { SelectItem } from './types/select';
import type { NonnegRange } from '@/http/range';

/**
 * Parameter keys that never become filters or RPC params. The list is
 * deliberately explicit so a future new reserved key is easy to spot.
 */
const RESERVED = new Set([
  'select',
  'order',
  'limit',
  'offset',
  'columns',
  'on_conflict',
  'and',
  'or',
  'not.and',
  'not.or',
  'cursor',
  'having',
  // Vector and cursor verification live in planner/executor stages.
  'vector',
  'vector.column',
  'vector.op',
  // Search — same pattern as vector: parser owns extraction, planner
  // owns validation (bug #EE5).
  'search',
  'search.columns',
  'search.language',
  'search.rank',
]);

/**
 * Parse `URLSearchParams` into a typed `ParsedQueryParams`.
 *
 * This is the single entry point the handler uses after the HTTP
 * request has been parsed by `http/request.ts`.
 */
export function parseQueryParams(
  params: URLSearchParams,
): Result<ParsedQueryParams, CloudRestError> {
  const filters: [EmbedPath, Filter][] = [];
  const filtersRoot: Filter[] = [];
  const filtersNotRoot: [EmbedPath, Filter][] = [];
  const filterFields = new Set<string>();
  const order: [EmbedPath, readonly OrderTerm[]][] = [];
  const logic: [EmbedPath, LogicTree][] = [];
  const rpcParams: [string, string][] = [];
  const ranges = new Map<string, NonnegRange>();
  const having: HavingClause[] = [];
  let select: readonly SelectItem[] = [];
  let columns: Set<string> | null = null;
  let onConflict: string[] | null = null;
  let distinct: readonly string[] | null = null;
  let cursor: string | null = null;
  let vectorValue: string | null = null;
  let vectorColumn: string | null = null;
  let vectorOp: string | null = null;
  let searchTerm: string | null = null;
  let searchColumns: string | null = null;
  let searchLanguage: string | null = null;
  let searchIncludeRank = false;
  // Track whether `search.rank` was SET separately from its boolean
  // value, so the side-param guard can flag `search.rank=false`
  // without a `search=` as malformed, and the strict validator
  // rejects unknown tokens (`search.rank=banana`).
  let searchRankExplicit = false;

  for (const [key, value] of params.entries()) {
    // ----- Reserved keys that own their own grammar -----
    if (key === 'select') {
      const result = parseSelect(value);
      if (!result.ok) return result;
      select = result.value;
      continue;
    }

    if (key === 'order') {
      const result = parseOrder(value);
      if (!result.ok) return result;
      order.push([[], result.value]);
      continue;
    }

    if (key === 'limit') {
      // INVARIANT: NonnegRange.limit is non-negative. Reject negative
      // or non-integer values rather than silently clamping. The old
      // parser accepted `limit=-5` which produced a NonnegRange that
      // violated its own contract.
      const n = strictParseNonNegInt(value);
      if (n === null) {
        return err(
          parseErrors.queryParam('limit', 'must be a non-negative integer'),
        );
      }
      const existing = ranges.get('limit') ?? { offset: 0, limit: null };
      ranges.set('limit', { offset: existing.offset, limit: n });
      continue;
    }

    if (key === 'offset') {
      const n = strictParseNonNegInt(value);
      if (n === null) {
        return err(
          parseErrors.queryParam('offset', 'must be a non-negative integer'),
        );
      }
      const existing = ranges.get('limit') ?? { offset: 0, limit: null };
      ranges.set('limit', { offset: n, limit: existing.limit });
      continue;
    }

    if (key === 'columns') {
      // `columns=a,,b` and `columns=a, ,b` are parse errors. Check each
      // trimmed item from the quote-aware split.
      if (value === '') {
        return err(
          parseErrors.queryParam('columns', 'empty column list'),
        );
      }
      const split = splitTopLevel(value, ',', { context: 'columns' });
      if (!split.ok) return split;
      const trimmedCols = split.value.map((s) => s.trim());
      for (const col of trimmedCols) {
        if (col === '') {
          return err(
            parseErrors.queryParam('columns', 'empty column (stray comma)'),
          );
        }
        // Columns must be plain SQL identifiers.
        if (!isPlainIdentifier(col)) {
          return err(
            parseErrors.queryParam(
              'columns',
              `invalid column name "${col}"`,
            ),
          );
        }
      }
      columns = new Set(trimmedCols);
      continue;
    }

    if (key === 'on_conflict') {
      // Same shape as `columns`.
      if (value === '') {
        return err(
          parseErrors.queryParam('on_conflict', 'empty column list'),
        );
      }
      const split = splitTopLevel(value, ',', { context: 'on_conflict' });
      if (!split.ok) return split;
      const trimmedCols = split.value.map((s) => s.trim());
      for (const col of trimmedCols) {
        if (col === '') {
          return err(
            parseErrors.queryParam('on_conflict', 'empty column (stray comma)'),
          );
        }
        // on_conflict entries must be plain SQL identifiers.
        if (!isPlainIdentifier(col)) {
          return err(
            parseErrors.queryParam(
              'on_conflict',
              `invalid column name "${col}"`,
            ),
          );
        }
      }
      onConflict = trimmedCols;
      continue;
    }

    if (key === 'having') {
      const result = parseHavingClauses(value);
      if (!result.ok) return result;
      having.push(...result.value);
      continue;
    }

    // Route to parser/distinct.ts and store the result on
    // ParsedQueryParams.distinct for the planner to consume.
    if (key === 'distinct') {
      const result = parseDistinct(value);
      if (!result.ok) return result;
      distinct = result.value;
      continue;
    }

    if (key === 'and' || key === 'or' || key === 'not.and' || key === 'not.or') {
      const negated = key.startsWith('not.');
      const op = (negated ? key.slice(4) : key) as LogicOp;
      const tree = parseLogicTree(op, negated, value);
      if (!tree.ok) return tree;
      logic.push([[], tree.value]);
      continue;
    }

    // ----- Embedded grammars keyed by dot paths -----
    const embedLogicMatch = key.match(/^(.+)\.(not\.(?:and|or)|(?:and|or))$/);
    if (embedLogicMatch) {
      const embedPath = embedLogicMatch[1]!.split('.');
      const pathCheck = validateEmbedPath(embedPath, key);
      if (!pathCheck.ok) return pathCheck;
      const logicKey = embedLogicMatch[2]!;
      const negated = logicKey.startsWith('not.');
      const logicOp = (negated ? logicKey.slice(4) : logicKey) as LogicOp;
      const tree = parseLogicTree(logicOp, negated, value);
      if (!tree.ok) return tree;
      logic.push([embedPath, tree.value]);
      continue;
    }

    if (key.includes('.') && key.endsWith('.order')) {
      const embedPath = key.slice(0, key.length - '.order'.length).split('.');
      const pathCheck = validateEmbedPath(embedPath, key);
      if (!pathCheck.ok) return pathCheck;
      const result = parseOrder(value);
      if (!result.ok) return result;
      order.push([embedPath, result.value]);
      continue;
    }

    if (key.includes('.') && (key.endsWith('.limit') || key.endsWith('.offset'))) {
      // REGRESSION: critique #69. Embedded range params (`?books.limit=2`)
      // must be collected here and consumed by the planner's embed code;
      // the old parser collected them but the planner never consumed them.
      const isLimit = key.endsWith('.limit');
      const suffix = isLimit ? '.limit' : '.offset';
      const embedPath = key.slice(0, key.length - suffix.length).split('.');
      const pathCheck = validateEmbedPath(embedPath, key);
      if (!pathCheck.ok) return pathCheck;
      const embedRangeKey = embedPath.join('\0');
      // INVARIANT: NonnegRange requires non-negative limit and offset.
      const n = strictParseNonNegInt(value);
      if (n === null) {
        return err(
          parseErrors.queryParam(key, 'must be a non-negative integer'),
        );
      }
      const existing = ranges.get(embedRangeKey) ?? { offset: 0, limit: null };
      ranges.set(
        embedRangeKey,
        isLimit
          ? { offset: existing.offset, limit: n }
          : { offset: Math.max(0, n), limit: existing.limit },
      );
      continue;
    }

    // ----- Cursor / vector (threaded through for downstream stages) -----
    // These keys land on `ParsedQueryParams` so the executor (cursor
    // HMAC) and the planner (vector search) can consume them.
    if (key === 'cursor') {
      cursor = value;
      continue;
    }
    if (key === 'vector') {
      vectorValue = value;
      continue;
    }
    if (key === 'vector.column') {
      vectorColumn = value;
      continue;
    }
    if (key === 'vector.op') {
      vectorOp = value;
      continue;
    }
    // Thread all four search keys through `ParsedQueryParams` the same
    // way as vector keys.
    if (key === 'search') {
      searchTerm = value;
      continue;
    }
    if (key === 'search.columns') {
      searchColumns = value;
      continue;
    }
    if (key === 'search.language') {
      searchLanguage = value;
      continue;
    }
    if (key === 'search.rank') {
      // Accept a closed set of truthy/falsy tokens and reject
      // everything else. Also mark the flag as explicitly set so the
      // side-param guard below can refuse `search.rank=false` without
      // a `search=` value.
      const lowered = value.toLowerCase();
      if (lowered === 'true' || lowered === '1' || lowered === 'yes') {
        searchIncludeRank = true;
      } else if (lowered === 'false' || lowered === '0' || lowered === 'no') {
        searchIncludeRank = false;
      } else {
        return err(
          parseErrors.queryParam(
            'search.rank',
            `expected a boolean (true/false/1/0/yes/no), got "${value}"`,
          ),
        );
      }
      searchRankExplicit = true;
      continue;
    }

    // ----- Other reserved keys (no grammar yet at this stage) -----
    if (RESERVED.has(key)) continue;

    // ----- Filter or RPC param -----
    const filterResult = parseFilter(key, value);
    if (!filterResult.ok) return filterResult;
    if (filterResult.value === null) {
      // Not a filter — record as RPC param.
      rpcParams.push([key, value]);
      continue;
    }

    const { path, filter } = filterResult.value;
    if (path.length === 0) {
      filtersRoot.push(filter);
      filterFields.add(filter.field.name);
    } else {
      filtersNotRoot.push([path, filter]);
    }
    filters.push([path, filter]);
  }

  // Canonical form (used by cursor HMAC and cache keys).
  const canonical = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // Either all vector inputs are absent, or the primary `vector` value
  // is required.
  if (vectorValue === null && (vectorColumn !== null || vectorOp !== null)) {
    return err(
      parseErrors.queryParam(
        'vector',
        '"vector.column" / "vector.op" require a "vector" value',
      ),
    );
  }
  const vector =
    vectorValue === null
      ? null
      : { value: vectorValue, column: vectorColumn, op: vectorOp };

  // Side params without a primary `search=` value are almost always a
  // user typo. Refuse the partial shape up front rather than silently
  // ignoring them. `search.rank` participates regardless of its
  // boolean value — the guard watches `searchRankExplicit` so
  // `search.rank=false` without a `search=` still errors, matching
  // the vector.* side param behavior.
  if (
    searchTerm === null &&
    (searchColumns !== null || searchLanguage !== null || searchRankExplicit)
  ) {
    return err(
      parseErrors.queryParam(
        'search',
        '"search.columns" / "search.language" / "search.rank" require a "search" value',
      ),
    );
  }
  const search =
    searchTerm === null
      ? null
      : {
          term: searchTerm,
          columns: searchColumns,
          language: searchLanguage,
          includeRank: searchIncludeRank,
        };

  return ok({
    canonical,
    rpcParams,
    ranges,
    order,
    logic,
    columns,
    select,
    filters,
    filtersRoot,
    filtersNotRoot,
    filterFields,
    onConflict,
    having,
    distinct,
    cursor,
    vector,
    search,
  });
}

/**
 * Validate the embed-path prefix of an embedded query param like
 * `books.order`, `authors.limit`, `posts.and=(...)`. The raw split uses
 * `key.split('.')`, which produces empty segments for malformed shapes
 * like `.order`, `a..order`, `.limit`, or `a..and=(...)`. Those empty
 * segments silently become invalid embed references later; reject here
 * instead so users see a PGRST100 for the typo.
 *
 * Validates embed-path segments are non-empty plain SQL identifiers.
 */
function validateEmbedPath(
  segments: readonly string[],
  key: string,
): Result<null, CloudRestError> {
  if (segments.length === 0) {
    return err(
      parseErrors.queryParam(key, `missing embed path in "${key}"`),
    );
  }
  // Segments must be plain SQL identifiers.
  for (const segment of segments) {
    if (segment === '') {
      return err(
        parseErrors.queryParam(
          key,
          `empty embed path segment in "${key}"`,
        ),
      );
    }
    if (!isPlainIdentifier(segment)) {
      return err(
        parseErrors.queryParam(
          key,
          `invalid embed path segment "${segment}" in "${key}"`,
        ),
      );
    }
  }
  return ok(null);
}

/**
 * True if `raw` is a plain SQL identifier: letters/digits/underscore,
 * with a non-digit first character. Shared gate for column lists
 * (columns, on_conflict, distinct) and embed path segments.
 */
function isPlainIdentifier(raw: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw);
}
