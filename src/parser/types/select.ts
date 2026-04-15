// Select AST types.
//
// A SelectItem is one entry in the `select=` list. It is either a field
// reference (possibly aliased, cast, or aggregated), an embedded relation,
// or a spread of an embedded relation.
//
// Aggregate function names are a closed allowlist. Adding a new aggregate
// requires adding it here AND in parser/select.ts AND in the builder.

import type { Field } from './field';
import type { OrderTerm } from './order';

export type AggregateFunction = 'sum' | 'avg' | 'max' | 'min' | 'count';

export const AGGREGATE_FUNCTION_NAMES: readonly AggregateFunction[] = [
  'sum',
  'avg',
  'max',
  'min',
  'count',
];

export type JoinType = 'inner' | 'left';

export interface FieldSelectItem {
  readonly type: 'field';
  readonly field: Field;
  readonly alias?: string;
  readonly cast?: string;
  readonly aggregateFunction?: AggregateFunction;
  readonly aggregateCast?: string;
}

export interface RelationSelectItem {
  readonly type: 'relation';
  readonly relation: string;
  readonly alias?: string;
  readonly hint?: string;
  readonly joinType?: JoinType;
  readonly innerSelect?: readonly SelectItem[];
  readonly embedLimit?: number;
  readonly embedOffset?: number;
  readonly embedOrder?: readonly OrderTerm[];
}

export interface SpreadSelectItem {
  readonly type: 'spread';
  readonly relation: string;
  readonly hint?: string;
  readonly joinType?: JoinType;
  readonly innerSelect?: readonly SelectItem[];
  readonly embedLimit?: number;
  readonly embedOffset?: number;
  readonly embedOrder?: readonly OrderTerm[];
}

export type SelectItem = FieldSelectItem | RelationSelectItem | SpreadSelectItem;
