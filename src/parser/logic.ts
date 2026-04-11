// Logic tree parser — parses `and=(...)` / `or=(...)` with nesting.
//
// REGRESSION: critique #70 — the old code rejected nested `and(...)` /
// `or(...)` calls because the recursive helper stripped the outer parens
// and then passed them to a function that required them. The fix is to
// re-wrap the inner content before recursing; this port preserves that
// fix.
//
// Accepts:
//   `(col.eq.1,col2.gt.5)`
//   `(not.col.eq.1,or(col2.gt.5,col3.lt.0))`
//   `(and(col.eq.1,col.eq.2),or(col.lt.10))`

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import { parseField } from './json-path';
import { parseOpExpr } from './operators';
import { splitTopLevel } from './tokenize';
import type { LogicTree } from './types/logic';

export type LogicOp = 'and' | 'or';

/**
 * Parse a logic-tree query-param value.
 * `value` must include the surrounding parentheses.
 */
export function parseLogicTree(
  op: LogicOp,
  negated: boolean,
  value: string,
): Result<LogicTree, CloudRestError> {
  if (!value.startsWith('(') || !value.endsWith(')')) {
    return err(
      parseErrors.queryParam(
        op,
        `logic tree must be wrapped in parentheses: ${op}=(...)`,
      ),
    );
  }

  const inner = value.slice(1, -1);
  if (!inner.trim()) {
    return err(parseErrors.queryParam(op, `empty logic group in "${op}=()"`));
  }

  const partsResult = splitTopLevel(inner, ',', { context: op });
  if (!partsResult.ok) return partsResult;
  const parts = partsResult.value;
  const children: LogicTree[] = [];

  // BUG FIX (#H): a stray comma inside the group (`and=(a.eq.1,,b.eq.2)`
  // or `and=(,)`) used to silently drop the empty child. splitTopLevel
  // is quote-aware so an empty entry here is unambiguously structural.
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      return err(
        parseErrors.queryParam(op, 'empty logic child (stray comma)'),
      );
    }

    // Nested logic: `and(...)` / `or(...)` / `not.and(...)` / `not.or(...)`.
    const parenIdx = trimmed.indexOf('(');
    if (parenIdx > 0 && trimmed.endsWith(')')) {
      const prefix = trimmed.slice(0, parenIdx);
      const nestedContent = trimmed.slice(parenIdx + 1, -1);
      let childNegated = false;
      let childOp = prefix;
      if (childOp.startsWith('not.')) {
        childNegated = true;
        childOp = childOp.slice(4);
      }

      if (childOp === 'and' || childOp === 'or') {
        // Re-wrap: parseLogicTree expects outer parens.
        const child = parseLogicTree(
          childOp,
          childNegated,
          `(${nestedContent})`,
        );
        if (!child.ok) return child;
        children.push(child.value);
        continue;
      }
    }

    // Leaf: a filter statement `col.op.value` or `not.col.op.value`.
    // The `not.` prefix only applies when `not` appears at the very
    // start of the token. It's a logic-level negation wrapper, not
    // the value-side `not.` that parseOpExpr handles.
    let filterNegated = false;
    let filterStr = trimmed;
    if (filterStr.startsWith('not.')) {
      filterNegated = true;
      filterStr = filterStr.slice(4);
      // BUG FIX (#I): chained `not.not.col.eq.5` is not a recognized
      // form — parseOpExpr handles a single value-side `not.` and the
      // logic-tree leaf handles a single wrapper `not.`. Anything more
      // is a parse error, not a field named `not.col`.
      if (filterStr.startsWith('not.')) {
        return err(
          parseErrors.queryParam(
            op,
            `chained "not." prefix not allowed in "${trimmed}"`,
          ),
        );
      }
    }

    // BUG FIX: the old parser used `indexOf('.')` to split the leaf
    // filter into key and value. That broke on relation-qualified
    // filters (`actors.name.eq.John`) and on JSON-path keys
    // (`data->>'a.b'.eq.x`). The rewrite uses the shared helper that
    // finds the correct field/op boundary by JSON-path-aware scanning.
    const leafResult = splitLogicLeaf(filterStr);
    if (!leafResult.ok) {
      return err(
        parseErrors.queryParam(op, `invalid logic tree filter: ${trimmed}`),
      );
    }
    const { key: filterKey, value: filterVal } = leafResult.value;

    const opResult = parseOpExpr(filterVal);
    if (!opResult.ok) return opResult;
    if (opResult.value === null) {
      return err(
        parseErrors.queryParam(op, `invalid filter in logic tree: ${trimmed}`),
      );
    }

    // Merge negations: `not.col.eq.5` flips the opExpr's negation.
    const mergedOpExpr = filterNegated
      ? { ...opResult.value, negated: !opResult.value.negated }
      : opResult.value;

    const fieldResult = parseField(filterKey);
    if (!fieldResult.ok) return fieldResult;

    children.push({
      type: 'stmnt',
      filter: { field: fieldResult.value, opExpr: mergedOpExpr },
    });
  }

  return ok({ type: 'expr', negated, operator: op, children });
}

/**
 * Split a logic-tree leaf filter `key.op.value` into `{ key, value }`,
 * where `value` is the `op.value` half expected by `parseOpExpr`.
 *
 * Allows for:
 *   - relation-qualified keys: `actors.name.eq.John`
 *   - JSON-path keys: `data->>'a.b'.eq.x`
 *   - FTS with language: `data.fts(english).word`
 *
 * BUG FIX (#14): the old scan took the LEFTMOST dot whose suffix looked
 * like an operator, so a column named like an op token in an embed path
 * (`actors.eq.name.eq.John`) would split at the wrong place. The
 * rewrite scans RIGHT-TO-LEFT for the last valid op-start.
 *
 * BUG FIX (#AA17): the previous iteration of this helper also tried to
 * extend the split leftward through a preceding `.not` segment so that
 * `col.not.eq.5` would produce `{key: 'col', value: 'not.eq.5'}`.
 * PostgREST's logic-tree grammar does not use that value-side form —
 * the canonical way to negate a leaf inside `and=(...)` is the
 * wrapper form `not.col.eq.5`, already handled by the outer
 * `filterStr.startsWith('not.')` strip. The extension rule was
 * therefore solving a non-problem while actively breaking columns
 * literally named `not` (`actors.not.eq.1` became field `actors`).
 * Drop the extension.
 */
function splitLogicLeaf(
  filterStr: string,
): Result<{ key: string; value: string }, CloudRestError> {
  const dotPositions = findUnquotedDotPositions(filterStr);

  // Walk right-to-left: the rightmost dot whose suffix is a valid
  // operator expression is the correct split point.
  for (let i = dotPositions.length - 1; i >= 0; i--) {
    const pos = dotPositions[i]!;
    const candidateValue = filterStr.slice(pos + 1);
    if (!looksLikeOpStart(candidateValue)) continue;

    const key = filterStr.slice(0, pos);
    if (key.length === 0) {
      // A leading-op filter like `.eq.5` has no field — treat as an
      // explicit parse error rather than producing an empty key.
      return err(
        parseErrors.queryParam('filter', `missing field in logic leaf: "${filterStr}"`),
      );
    }
    return ok({ key, value: candidateValue });
  }
  return err(parseErrors.queryParam('filter', `cannot locate operator in "${filterStr}"`));
}

/**
 * Return all positions of `.` characters in `str` that are NOT inside a
 * quoted region, in left-to-right order. Also skips dots that appear
 * inside a JSON-path arrow span (`data->>'a.b'` — the dot after 'a is
 * inside the quoted key, which the quote tracker already handles).
 */
function findUnquotedDotPositions(str: string): number[] {
  const positions: number[] = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuoted(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(str, i, '"');
      continue;
    }
    if (ch === '(') {
      // Skip parenthesized regions like `fts(english)` — dots inside
      // an operator's quantifier/language argument must not split.
      i = skipParens(str, i);
      continue;
    }
    if (ch === '.') positions.push(i);
    i += 1;
  }
  return positions;
}

function skipQuoted(str: string, start: number, quoteChar: string): number {
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

function skipParens(str: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return str.length;
}

/**
 * Known operator-start tokens. Used by splitLogicLeaf to decide
 * whether a suffix after a `.` is an operator expression.
 *
 * INVARIANT: this list must stay in sync with operators.ts. It is a
 * superset check — a candidate starts with one of these tokens and
 * either ends there, has a `.` next, or has a `(` next (quantifier
 * or FTS language).
 */
const KNOWN_OP_TOKENS: readonly string[] = [
  'not',
  // quant ops
  'eq',
  'neq',
  'gte',
  'gt',
  'lte',
  'lt',
  'like',
  'ilike',
  'match',
  'imatch',
  // simple ops
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
  // collection / is / isdistinct
  'in',
  'is',
  'isdistinct',
  // fts
  'fts',
  'plfts',
  'phfts',
  'wfts',
  // geo
  'geo',
];

function looksLikeOpStart(candidate: string): boolean {
  for (const token of KNOWN_OP_TOKENS) {
    if (!candidate.startsWith(token)) continue;
    const nextCh = candidate[token.length];
    // End-of-string, `.`, or `(` all mark a valid operator boundary.
    if (nextCh === undefined || nextCh === '.' || nextCh === '(') {
      return true;
    }
  }
  return false;
}
