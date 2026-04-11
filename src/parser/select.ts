// Select parser — `?select=col1,alias:col2,cast::type,agg(col),rel(inner)`.
//
// Grammar (informal):
//
//   select       := item (',' item)*
//   item         := aggregate | embed | field
//   aggregate    := ('count' | 'sum' | 'avg' | 'max' | 'min') '(' [column] ')'
//   embed        := '...'? (alias ':')? rel ('!' hint)? ('!' join)? '(' innerSelect? ')'
//   innerSelect  := ( 'limit=' N | 'offset=' N | 'order=' X | field )*
//   field        := (alias ':')? column ('::' cast)? ('.' aggregate '()' )?
//
// COMPAT (CONSTITUTION §12.5): The canonical aggregate form is
// `aggregate(column)`. The extension form `column.aggregate()` is
// accepted and parsed to the same AST node. Aggregate names are a closed
// allowlist; anything else inside parens is an embed.
//
// REGRESSION: critique #68 — `select=book_id,avg(rating)` must parse as
// a field list containing an aggregate, NOT an embed of a table named
// `avg`. The allowlist check below runs BEFORE the embed branch.

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
import { parseField } from './json-path';
import { parseOrder } from './order';
import { splitTopLevel, strictParseNonNegInt } from './tokenize';
import {
  AGGREGATE_FUNCTION_NAMES,
  type AggregateFunction,
  type JoinType,
  type SelectItem,
} from './types/select';
import type { OrderTerm } from './types/order';

const AGGREGATE_SET: ReadonlySet<string> = new Set<string>(AGGREGATE_FUNCTION_NAMES);

/**
 * Parse a `select=` value into a list of SelectItem.
 * Empty or whitespace input returns an empty list.
 * `select=*` returns a single wildcard field.
 */
export function parseSelect(raw: string): Result<readonly SelectItem[], CloudRestError> {
  if (!raw || raw.trim() === '') return ok([]);
  const trimmedRaw = raw.trim();
  if (trimmedRaw === '*') {
    return ok([{ type: 'field', field: { name: '*', jsonPath: [] } }]);
  }

  // BUG FIX: splitTopLevel drops the trailing empty after `a,`, so the
  // select loop cannot detect a trailing comma by itself. Check the raw
  // input for leading/trailing commas before splitting. The shared
  // tokenizer catches commas inside quoted regions, so this check is
  // structural only.
  if (trimmedRaw.startsWith(',') || trimmedRaw.endsWith(',')) {
    return err(
      parseErrors.queryParam('select', 'empty select item (stray comma)'),
    );
  }

  const items: SelectItem[] = [];
  const partsResult = splitTopLevel(raw, ',', { context: 'select' });
  if (!partsResult.ok) return partsResult;
  const parts = partsResult.value;

  for (const part of parts) {
    const trimmed = part.trim();
    // BUG FIX: empty select items are a parse error, not silent cleanup.
    // `select=a,,b` and `select=a,` now produce PGRST100 instead of
    // quietly yielding a two-item or one-item list.
    if (!trimmed) {
      return err(
        parseErrors.queryParam('select', 'empty select item (stray comma)'),
      );
    }

    const isSpread = trimmed.startsWith('...');
    const working = isSpread ? trimmed.slice(3) : trimmed;

    // REGRESSION: critique #68. Canonical aggregates (`avg(rating)`,
    // `alias:sum(total)`, `sum(total)::numeric`, `alias:avg(x)::float`)
    // take precedence over embed parsing. The detector peels off an
    // optional `alias:` prefix and an optional `::cast` suffix, then
    // checks whether the middle is `aggregate(args)` with args that
    // are empty/`*`/a simple column.
    //
    // Only applies when NOT a spread — `...rel(x)` is always an embed.
    if (!isSpread) {
      const aggItem = tryParseCanonicalAggregateField(trimmed);
      if (aggItem !== null) {
        if (!aggItem.ok) return aggItem;
        items.push(aggItem.value);
        continue;
      }
    }

    const parenStart = working.indexOf('(');
    if (parenStart > 0 && working.endsWith(')')) {
      const relPart = working.slice(0, parenStart);
      const innerContent = working.slice(parenStart + 1, -1);

      // Embed: rel(...), alias:rel(...), rel!hint(...), alias:rel!hint!inner(...)
      const relMatch = relPart.match(
        /^(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)(?:!([a-zA-Z_][a-zA-Z0-9_]*))?(?:!(inner|left))?$/,
      );
      if (relMatch) {
        const alias = relMatch[1];
        const relation = relMatch[2]!;
        let hint: string | undefined = relMatch[3];
        let joinType = relMatch[4] as JoinType | undefined;

        // `rel!inner(*)` / `rel!left(*)` — when the first `!`-segment is a
        // join qualifier and no second segment follows, treat it as the
        // join type rather than a FK hint.
        if (!joinType && (hint === 'inner' || hint === 'left')) {
          joinType = hint;
          hint = undefined;
        }

        let innerSelect: readonly SelectItem[] | undefined;
        let embedLimit: number | undefined;
        let embedOffset: number | undefined;
        let embedOrder: readonly OrderTerm[] | undefined;

        if (innerContent === '') {
          innerSelect = [];
        } else if (innerContent !== '*') {
          // BUG FIX (#Q): the outer parseSelect rejects leading/
          // trailing commas at the top level, but the embed-inner
          // branch used to split silently. `select=author(id,)` would
          // parse as `author(id)` instead of an error.
          if (innerContent.startsWith(',') || innerContent.endsWith(',')) {
            return err(
              parseErrors.queryParam(
                'select',
                `empty inner select item (stray comma) in "${working}"`,
              ),
            );
          }
          const innerPartsResult = splitTopLevel(innerContent, ',', {
            context: 'select',
          });
          if (!innerPartsResult.ok) return innerPartsResult;
          const innerParts = innerPartsResult.value;
          const fieldParts: string[] = [];
          for (const innerPart of innerParts) {
            const trimmedInner = innerPart.trim();
            if (trimmedInner === '') {
              return err(
                parseErrors.queryParam(
                  'select',
                  `empty inner select item (stray comma) in "${working}"`,
                ),
              );
            }
            if (trimmedInner.startsWith('limit=')) {
              const n = strictParseNonNegInt(trimmedInner.slice(6));
              if (n === null) {
                return err(
                  parseErrors.queryParam(
                    'select',
                    `invalid embed limit: "${trimmedInner}"`,
                  ),
                );
              }
              embedLimit = n;
            } else if (trimmedInner.startsWith('offset=')) {
              const n = strictParseNonNegInt(trimmedInner.slice(7));
              if (n === null) {
                return err(
                  parseErrors.queryParam(
                    'select',
                    `invalid embed offset: "${trimmedInner}"`,
                  ),
                );
              }
              embedOffset = n;
            } else if (trimmedInner.startsWith('order=')) {
              const orderResult = parseOrder(trimmedInner.slice(6));
              if (!orderResult.ok) return orderResult;
              embedOrder = orderResult.value;
            } else {
              fieldParts.push(trimmedInner);
            }
          }
          if (fieldParts.length > 0) {
            const inner = parseSelect(fieldParts.join(','));
            if (!inner.ok) return inner;
            innerSelect = inner.value;
          }
        }

        if (isSpread) {
          items.push({
            type: 'spread',
            relation,
            hint,
            joinType,
            innerSelect,
            embedLimit,
            embedOffset,
            embedOrder,
          });
        } else {
          items.push({
            type: 'relation',
            relation,
            alias,
            hint,
            joinType,
            innerSelect,
            embedLimit,
            embedOffset,
            embedOrder,
          });
        }
        continue;
      }
    }

    // Plain field (with optional alias/cast and extension-form aggregate).
    const fieldResult = parseFieldItem(trimmed);
    if (!fieldResult.ok) return fieldResult;
    items.push(fieldResult.value);
  }

  return ok(items);
}

/**
 * Detect canonical-aggregate field items and return a parsed SelectItem.
 *
 * Accepts:
 *   - `avg(rating)` / `count()` / `sum(col)`
 *   - `alias:avg(rating)`
 *   - `avg(rating)::float`
 *   - `alias:avg(rating)::float`
 *
 * Returns:
 *   - Ok(SelectItem) — if the token is a canonical aggregate
 *   - Err — if the token is a canonical aggregate but malformed (e.g. `sum()`)
 *   - null — if the token is NOT a canonical aggregate (caller should try
 *            other branches: embed or plain field)
 */
function tryParseCanonicalAggregateField(
  raw: string,
): Result<SelectItem, CloudRestError> | null {
  // Strip optional `alias:` prefix, honoring quotes so colons inside
  // quoted JSON keys don't split incorrectly.
  const aliasSplit = splitAliasPrefix(raw);
  const alias = aliasSplit.alias;
  let working = aliasSplit.rest;

  // Strip optional trailing `::cast`. The aggregate body is the middle
  // piece that must end with `)`.
  let aggregateCast: string | undefined;
  const castIdx = findLastUnquotedCast(working);
  if (castIdx > 0 && working.endsWith(')') === false) {
    aggregateCast = working.slice(castIdx + 2);
    working = working.slice(0, castIdx);
  }

  // The remaining token must match `AGG(args)`.
  if (!working.endsWith(')')) return null;
  const parenStart = working.indexOf('(');
  if (parenStart <= 0) return null;
  const fnName = working.slice(0, parenStart);
  if (!AGGREGATE_SET.has(fnName)) return null;

  // BUG FIX (#T): alias must be a plain identifier for aggregates too.
  if (alias !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    return err(
      parseErrors.queryParam('select', `invalid alias: "${alias}"`),
    );
  }

  // BUG FIX (#K): reject an empty trailing `::` on an aggregate form.
  // `avg(x)::` would otherwise produce a SelectItem with `cast: ""`.
  if (aggregateCast !== undefined && aggregateCast.trim() === '') {
    return err(
      parseErrors.queryParam('select', `empty cast after "${fnName}()"`),
    );
  }

  // BUG FIX (#S/#U): aggregate cast must not be chained (`avg(x)::int::float`)
  // and must be a legal SQL type name (rejects semicolons, comments,
  // and other unsafe characters). Surrounding whitespace is trimmed —
  // `max(price)::  FLOAT8  ` is a tolerated shape.
  if (aggregateCast !== undefined) {
    if (findFirstUnquotedCast(aggregateCast) !== -1) {
      return err(
        parseErrors.queryParam('select', `chained cast not allowed: "${raw}"`),
      );
    }
    const trimmedAggCast = aggregateCast.trim();
    if (!isValidCastName(trimmedAggCast)) {
      return err(
        parseErrors.queryParam('select', `invalid cast type: "${aggregateCast}"`),
      );
    }
    aggregateCast = trimmedAggCast;
  }

  // Canonical aggregate arguments: empty, `*` (count only), or a
  // simple column reference (possibly with a JSON path).
  //
  // BUG FIX (#J): the old fallthrough returned `null` here so that a
  // malformed aggregate like `avg(a,b)` would be reinterpreted as an
  // embed on a relation named `avg`. Aggregate-shaped garbage must be
  // an error, not a silent reinterpretation.
  //
  // BUG FIX (#AA5): the old guard `/[(),]/.test(innerContent)` falsely
  // rejected quoted JSON keys that contain commas or parens
  // (`avg(data->>"a,b")`, `avg(data->>"a)b")`). Scan with quote
  // awareness and reject only top-level commas and unbalanced parens.
  const innerContent = working.slice(parenStart + 1, -1).trim();
  if (hasUnquotedCommaOrUnbalancedParens(innerContent)) {
    return err(
      parseErrors.queryParam(
        'select',
        `invalid aggregate argument in "${fnName}(${innerContent})"`,
      ),
    );
  }

  const fn = fnName as AggregateFunction;

  // `count()` is shorthand for COUNT(*). `sum()` / `avg()` / etc. with
  // no argument are errors.
  if (innerContent === '') {
    if (fn !== 'count') {
      return err(
        parseErrors.queryParam('select', `${fn}() requires a column argument`),
      );
    }
    return ok({
      type: 'field',
      field: { name: '*', jsonPath: [] },
      alias,
      aggregateFunction: 'count',
      aggregateCast,
    });
  }

  // BUG FIX (#AA3): only `count(*)` is meaningful — `sum(*)`, `avg(*)`,
  // etc. are nonsense. `count(*)` normalizes to the same shape as
  // `count()`.
  if (innerContent === '*') {
    if (fn !== 'count') {
      return err(
        parseErrors.queryParam(
          'select',
          `${fn}(*) is not a valid aggregate — only count(*) is supported`,
        ),
      );
    }
    return ok({
      type: 'field',
      field: { name: '*', jsonPath: [] },
      alias,
      aggregateFunction: 'count',
      aggregateCast,
    });
  }

  const fieldResult = parseField(innerContent);
  if (!fieldResult.ok) return fieldResult;
  return ok({
    type: 'field',
    field: fieldResult.value,
    alias,
    aggregateFunction: fn,
    aggregateCast,
  });
}

/**
 * Parse a single `select=` item that is not an embed or a canonical
 * aggregate: plain column, alias, cast, or extension-form aggregate
 * (`column.avg()`).
 *
 * BUG FIX: alias and cast splitting used `indexOf(':')` / `indexOf('::')`
 * with no quote awareness. `data->>"a:b"` was misparsed as alias
 * `data->>"a` and field `b"`. The rewrite scans with quote tracking.
 *
 * BUG FIX: the resulting field name must be a valid identifier
 * (letters/digits/underscore) or `*`. `select=::int` and other shaped
 * garbage are now rejected.
 */
function parseFieldItem(raw: string): Result<SelectItem, CloudRestError> {
  const aliasSplit = splitAliasPrefix(raw);
  const alias = aliasSplit.alias;
  // BUG FIX (#T): the old parser returned whatever preceded `:` as the
  // alias with no validation, so aliases containing semicolons, spaces,
  // or other junk would pass. Relation aliases are regex-gated already
  // — match that rule for plain field aliases too.
  if (alias !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    return err(
      parseErrors.queryParam('select', `invalid alias: "${alias}"`),
    );
  }
  let remaining = aliasSplit.rest;

  let cast: string | undefined;
  const castIdx = findFirstUnquotedCast(remaining);
  if (castIdx > 0) {
    const rawCast = remaining.slice(castIdx + 2);
    remaining = remaining.slice(0, castIdx);
    // BUG FIX (#K): `col::` must not produce `cast: ""`. The cast type
    // is required when the `::` is present.
    if (rawCast.trim() === '') {
      return err(
        parseErrors.queryParam('select', `empty cast in "${raw}"`),
      );
    }
    // BUG FIX (#S): reject chained casts like `col::int::float`. The
    // grammar permits exactly one optional `::cast` suffix.
    if (findFirstUnquotedCast(rawCast) !== -1) {
      return err(
        parseErrors.queryParam('select', `chained cast not allowed: "${raw}"`),
      );
    }
    // BUG FIX (#U): cast name must be a plain SQL type identifier —
    // letters/digits/underscore, optionally with a parenthesized
    // precision like `numeric(10,2)` or a trailing `[]` array marker.
    // Trim surrounding whitespace first (the builder also trims, so
    // `col::  int  ` is a tolerated shape), then reject anything that
    // contains semicolons, comments, or other unsafe characters.
    const trimmedCast = rawCast.trim();
    if (!isValidCastName(trimmedCast)) {
      return err(
        parseErrors.queryParam('select', `invalid cast type: "${rawCast}"`),
      );
    }
    cast = trimmedCast;
  }

  // Extension form: `column.avg()` / `column.sum()` / etc.
  let aggregateFunction: AggregateFunction | undefined;
  const aggMatch = remaining.match(/\.(sum|avg|max|min|count)\(\)$/);
  if (aggMatch) {
    aggregateFunction = aggMatch[1] as AggregateFunction;
    remaining = remaining.slice(0, remaining.length - aggMatch[0].length);
  }

  // BUG FIX: validate that what remains is a legal field reference.
  // This rejects `select=::int` (remaining == ''),
  // `select=(name)` (leading paren), etc.
  if (!isValidFieldReference(remaining)) {
    return err(
      parseErrors.queryParam('select', `invalid field name: "${remaining}"`),
    );
  }

  // BUG FIX (#AA2/#AA3): the wildcard `*` is only meaningful as a bare
  // select item. `*::int`, `*.avg()`, and `alias:*` are all nonsense —
  // the wildcard has no column identity to cast, aggregate over, or
  // alias. Reject the combinations here.
  if (remaining === '*') {
    if (cast !== undefined) {
      return err(
        parseErrors.queryParam('select', `wildcard "*" cannot have a cast`),
      );
    }
    if (aggregateFunction !== undefined) {
      return err(
        parseErrors.queryParam(
          'select',
          `wildcard "*" cannot have an aggregate function`,
        ),
      );
    }
    if (alias !== undefined) {
      return err(
        parseErrors.queryParam('select', `wildcard "*" cannot have an alias`),
      );
    }
  }

  const fieldResult = parseField(remaining);
  if (!fieldResult.ok) return fieldResult;

  return ok({
    type: 'field',
    field: fieldResult.value,
    alias,
    cast,
    aggregateFunction,
    aggregateCast: aggregateFunction ? cast : undefined,
  });
}

/**
 * Strip an optional `alias:` prefix from a select token. The split
 * respects single- and double-quoted regions so `data->>"a:b"` is not
 * split at the inner `:`. A bare `::` (cast-at-start) is not a split
 * point either.
 */
function splitAliasPrefix(raw: string): { alias?: string; rest: string } {
  const pos = findFirstUnquotedAliasColon(raw);
  if (pos === -1) return { rest: raw };
  return { alias: raw.slice(0, pos), rest: raw.slice(pos + 1) };
}

function findFirstUnquotedAliasColon(str: string): number {
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuotedRegion(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuotedRegion(str, i, '"');
      continue;
    }
    if (ch === ':') {
      // BUG FIX (#R): `::` is a cast marker. If we hit one BEFORE a
      // lone `:`, the token has no alias at all — `col::type:alias`
      // is not an alias of `col::type`, it is a malformed token.
      // The old code skipped past `::` and kept looking for an alias
      // colon further right, which misparsed the shape.
      if (str[i + 1] === ':') {
        return -1;
      }
      // An alias must have a non-empty name on the left.
      if (i === 0) return -1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Find the first unquoted `::` in `str`. Returns -1 if none.
 * Used by parseFieldItem to strip a single `::cast` suffix.
 */
function findFirstUnquotedCast(str: string): number {
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuotedRegion(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuotedRegion(str, i, '"');
      continue;
    }
    if (ch === ':' && str[i + 1] === ':') return i;
    i += 1;
  }
  return -1;
}

/**
 * Find the LAST unquoted `::` in `str`. Returns -1 if none.
 * Used by tryParseCanonicalAggregateField to strip a trailing
 * `::cast` off an aggregate expression like `avg(x)::float`.
 */
function findLastUnquotedCast(str: string): number {
  let last = -1;
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuotedRegion(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuotedRegion(str, i, '"');
      continue;
    }
    if (ch === ':' && str[i + 1] === ':') {
      last = i;
      i += 2;
      continue;
    }
    i += 1;
  }
  return last;
}

function skipQuotedRegion(str: string, start: number, quoteChar: string): number {
  let i = start + 1;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === quoteChar) {
      if (str[i + 1] === quoteChar) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return str.length;
}

/**
 * True if `raw` is a legal SQL cast type name.
 *
 * Allowed shapes:
 *   - plain identifier:             `int`, `text`, `float8`
 *   - identifier with precision:    `numeric(10,2)`, `varchar(255)`
 *   - identifier with array marker: `int[]`, `text[]`
 *   - with a schema prefix:         `public.my_type`
 *
 * Rejects semicolons, spaces, comments, newlines, and anything else
 * that could pollute generated SQL.
 */
export function isValidCastName(raw: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?(?:\(\d+(?:,\d+)?\))?(?:\[\])?$/.test(
    raw,
  );
}

/**
 * True if `raw` is a legal CloudREST field reference: either `*`, a
 * plain identifier (letters, digits, underscore, optionally starting
 * with underscore/letter), or an identifier followed by a JSON path
 * (`col`, `data->key`, `data->'owner'->>'name'`, `data->0`). Quoted
 * identifiers are not yet supported at the grammar level.
 */
function isValidFieldReference(raw: string): boolean {
  if (raw === '*' || raw === '') {
    // `*` is the wildcard; empty is malformed.
    return raw === '*';
  }
  // Find the prefix up to the first `->`, if any.
  const arrowIdx = raw.indexOf('->');
  const head = arrowIdx === -1 ? raw : raw.slice(0, arrowIdx);
  // Field name must be a plain identifier.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(head)) return false;
  // The tail (if any) is a JSON path. parseField will consume it; we
  // only need to ensure the tail starts with `->` and contains no
  // top-level junk.
  if (arrowIdx === -1) return true;
  const tail = raw.slice(arrowIdx);
  // Quick structural check: tail must start with `->` or `->>`.
  return tail.startsWith('->');
}
