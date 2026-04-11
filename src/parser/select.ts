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
  if (raw.trim() === '*') {
    return ok([{ type: 'field', field: { name: '*', jsonPath: [] } }]);
  }

  const items: SelectItem[] = [];
  const parts = splitTopLevel(raw, ',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const isSpread = trimmed.startsWith('...');
    const working = isSpread ? trimmed.slice(3) : trimmed;

    const parenStart = working.indexOf('(');
    if (parenStart > 0 && working.endsWith(')')) {
      const relPart = working.slice(0, parenStart);
      const innerContent = working.slice(parenStart + 1, -1);

      // REGRESSION: critique #68. Aggregate-shaped tokens go through the
      // field-parser branch so `avg(rating)` produces an aggregate field,
      // not an embed of a table named `avg`. Canonical form takes any
      // column name inside the parens (including `*` for count), as long
      // as it contains no further parens or commas.
      if (AGGREGATE_SET.has(relPart) && isCanonicalAggregateArgs(innerContent)) {
        const item = parseCanonicalAggregate(relPart as AggregateFunction, innerContent);
        if (!item.ok) return item;
        items.push(item.value);
        continue;
      }

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
          const innerParts = splitTopLevel(innerContent, ',');
          const fieldParts: string[] = [];
          for (const innerPart of innerParts) {
            const trimmedInner = innerPart.trim();
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
 * Canonical aggregate form: `avg(rating)`, `count()`, `sum(col)`.
 * The argument string is already known to be empty or a simple column
 * reference with no commas or parens.
 */
function parseCanonicalAggregate(
  fn: AggregateFunction,
  argument: string,
): Result<SelectItem, CloudRestError> {
  const trimmed = argument.trim();

  if (fn === 'count' && trimmed === '') {
    // `count()` with no argument is shorthand for COUNT(*).
    return ok({
      type: 'field',
      field: { name: '*', jsonPath: [] },
      aggregateFunction: 'count',
    });
  }

  if (trimmed === '') {
    return err(
      parseErrors.queryParam(
        'select',
        `${fn}() requires a column argument`,
      ),
    );
  }

  // COMPAT: PostgREST allows `avg(rating)::float` — the cast sits after
  // the closing paren, outside this function. Casts *inside* aren't
  // accepted to keep the grammar unambiguous.
  return ok({
    type: 'field',
    field: parseField(trimmed),
    aggregateFunction: fn,
  });
}

/**
 * True if `raw` is an empty string or a simple column reference suitable
 * as a canonical aggregate argument: no commas, no parens, no dots that
 * look like a sub-grammar.
 */
function isCanonicalAggregateArgs(raw: string): boolean {
  if (raw === '' || raw === '*') return true;
  // Allow JSON paths inside aggregates (`avg(data->'price')`).
  if (/[(),]/.test(raw)) return false;
  return true;
}

/**
 * Parse a single `select=` item that is not an embed or a canonical
 * aggregate: plain column, alias, cast, or extension-form aggregate
 * (`column.avg()`).
 */
function parseFieldItem(raw: string): Result<SelectItem, CloudRestError> {
  let alias: string | undefined;
  let remaining = raw;

  const colonIdx = remaining.indexOf(':');
  if (colonIdx > 0 && colonIdx + 1 < remaining.length && remaining[colonIdx + 1] !== ':') {
    alias = remaining.slice(0, colonIdx);
    remaining = remaining.slice(colonIdx + 1);
  }

  // `alias:count()` — the alias-stripped remainder may itself be a
  // canonical aggregate.
  if (remaining === 'count()') {
    return ok({
      type: 'field',
      field: { name: '*', jsonPath: [] },
      alias,
      aggregateFunction: 'count',
    });
  }

  let cast: string | undefined;
  const castIdx = remaining.indexOf('::');
  if (castIdx > 0) {
    cast = remaining.slice(castIdx + 2);
    remaining = remaining.slice(0, castIdx);
  }

  // Extension form: `column.avg()` / `column.sum()` / etc.
  let aggregateFunction: AggregateFunction | undefined;
  const aggMatch = remaining.match(/\.(sum|avg|max|min|count)\(\)$/);
  if (aggMatch) {
    aggregateFunction = aggMatch[1] as AggregateFunction;
    remaining = remaining.slice(0, remaining.length - aggMatch[0].length);
  }

  return ok({
    type: 'field',
    field: parseField(remaining),
    alias,
    cast,
    aggregateFunction,
    aggregateCast: aggregateFunction ? cast : undefined,
  });
}
