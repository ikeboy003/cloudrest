// HAVING clause AST.
//
// HAVING takes `?having=count().gt.5,sum(total).gte.1000` — one clause
// per comma-separated entry, each with an aggregate function, optional
// field (count() has no field), and an OpExpr filter.
//
// The `field` slot carries a `Field` AST so JSON paths inside having
// arguments parse consistently with select/filter/order.

import type { AggregateFunction } from './select';
import type { Field } from './field';
import type { OpExpr } from './filter';

export interface HavingClause {
  readonly aggregate: AggregateFunction;
  readonly field?: Field;
  readonly opExpr: OpExpr;
}
