// Top-level query-param dispatcher.
//
// INVARIANT: This file is THIN. Every grammar lives in its own file under
// parser/. This file's job is to route each URL parameter to its grammar
// module and assemble the ParsedQueryParams output. See ARCHITECTURE.md
// § Parser boundary.

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
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
import type { NonnegRange } from '../http/range';

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
      // BUG FIX (#M/#P): `columns=a,,b` used to silently become `a,b`,
      // and `columns=a, ,b` slipped past the old raw-string check via
      // the whitespace-only middle entry. Check each trimmed item from
      // the quote-aware split.
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
      }
      columns = new Set(trimmedCols);
      continue;
    }

    if (key === 'on_conflict') {
      // BUG FIX (#M/#P): same shape as `columns`.
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

    // BUG FIX: the old dispatcher listed `distinct` in the reserved set
    // and then never parsed it — the feature was only half-wired. Stage 4
    // now routes it to parser/distinct.ts and stores the result on
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
    // BUG FIX (#Z): these keys used to fall into the blanket `RESERVED`
    // drop below and disappear. They now land on `ParsedQueryParams`
    // so the executor (cursor HMAC) and the planner (vector search)
    // can consume them as those features come online.
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

  const vector =
    vectorValue === null
      ? null
      : { value: vectorValue, column: vectorColumn, op: vectorOp };

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
 * BUG FIX (#L): the old dispatcher passed these raw segments straight
 * to the planner and logic/order collectors.
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
  for (const segment of segments) {
    if (segment === '') {
      return err(
        parseErrors.queryParam(
          key,
          `empty embed path segment in "${key}"`,
        ),
      );
    }
  }
  return ok(null);
}
