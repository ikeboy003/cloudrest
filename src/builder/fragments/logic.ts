// Logic tree rendering.
//
// Recursively renders an `and/or` tree into a parenthesized boolean
// expression. Leaves go through renderFilter.

import type { CloudRestError } from '../../core/errors';
import { ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { LogicTree } from '../../parser/types/logic';
import type { SqlBuilder } from '../sql';
import { renderFilter } from './filter';

export function renderLogicTree(
  target: QualifiedIdentifier,
  tree: LogicTree,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (tree.type === 'stmnt') return renderFilter(target, tree.filter, builder);

  const rendered: string[] = [];
  for (const child of tree.children) {
    const r = renderLogicTree(target, child, builder);
    if (!r.ok) return r;
    rendered.push(r.value);
  }
  const joiner = tree.operator === 'and' ? ' AND ' : ' OR ';
  const not = tree.negated ? 'NOT ' : '';
  return ok(`${not}(${rendered.join(joiner)})`);
}
