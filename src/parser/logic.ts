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

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
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

  const parts = splitTopLevel(inner, ',');
  const children: LogicTree[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

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
    let filterNegated = false;
    let filterStr = trimmed;
    if (filterStr.startsWith('not.')) {
      filterNegated = true;
      filterStr = filterStr.slice(4);
    }

    const filterDotIdx = filterStr.indexOf('.');
    if (filterDotIdx === -1) {
      return err(parseErrors.queryParam(op, `invalid logic tree filter: ${trimmed}`));
    }

    const filterKey = filterStr.slice(0, filterDotIdx);
    const filterVal = filterStr.slice(filterDotIdx + 1);
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

    children.push({
      type: 'stmnt',
      filter: { field: parseField(filterKey), opExpr: mergedOpExpr },
    });
  }

  return ok({ type: 'expr', negated, operator: op, children });
}
