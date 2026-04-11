// HAVING clause AST.
//
// HAVING takes `?having=count().gt.5,sum(total).gte.1000` — one clause
// per comma-separated entry, each with an aggregate function, optional
// field (count() has no field), and an OpExpr filter.

import type { AggregateFunction } from './select';
import type { OpExpr } from './filter';

export interface HavingClause {
  readonly aggregate: AggregateFunction;
  readonly field?: string;
  readonly opExpr: OpExpr;
}
