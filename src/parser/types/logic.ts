// Logic tree AST.
//
// A LogicTree is either an `and`/`or` expression with child trees or a
// leaf filter statement. Recursive nesting is unlimited; stage 4's
// parser accepts `and=(..., or(..., and(...)))` etc.

import type { Filter } from './filter';

export type LogicTree =
  | {
      readonly type: 'expr';
      readonly negated: boolean;
      readonly operator: 'and' | 'or';
      readonly children: readonly LogicTree[];
    }
  | { readonly type: 'stmnt'; readonly filter: Filter };
