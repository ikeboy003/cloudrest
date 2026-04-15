// Order AST type.
//
// `relation` is set only for `order=rel(col).desc` form — ordering of a
// to-one embedded relation.

import type { Field } from './field';

export type OrderDirection = 'asc' | 'desc';
export type NullOrder = 'nullsfirst' | 'nullslast';

export interface GeoDistanceOrder {
  readonly column: string;
  readonly lat: number;
  readonly lon: number;
}

export interface OrderTerm {
  readonly relation?: string;
  readonly field: Field;
  readonly direction?: OrderDirection;
  readonly nullOrder?: NullOrder;
  /** PostGIS distance ordering. */
  readonly geoDistance?: GeoDistanceOrder;
}
