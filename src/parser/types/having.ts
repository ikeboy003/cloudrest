// HAVING clause AST.
//
// HAVING takes `?having=count().gt.5,sum(total).gte.1000` — one clause
// per comma-separated entry, each with an aggregate function, optional
// field (count() has no field), and an OpExpr filter.
//
// BUG FIX (#22): the `field` slot used to be `string | undefined`,
// which meant JSON paths inside having arguments could not be parsed
// consistently with select/filter/order. It now carries a `Field` AST.

import type { AggregateFunction } from './select';
import type { Field } from './field';
import type { OpExpr } from './filter';

export interface HavingClause {
  readonly aggregate: AggregateFunction;
  readonly field?: Field;
  readonly opExpr: OpExpr;
}
