// Filter AST types.
//
// A Filter is a Field + an OpExpr. OpExpr wraps an Operation plus a
// negation flag (set by `not.` prefixes). Operation is the full
// tagged-union of everything the filter grammar can express: simple
// operators, quantified operators, IN, IS, IS DISTINCT FROM, FTS, geo.

import type { Field } from './field';

// ----- Operator allowlists ---------------------------------------------
//
// INVARIANT: these are closed allowlists. Adding an operator means
// adding the token here and wiring it in parser/operators.ts and the
// builder. A typo-in-query at runtime produces PGRST100, not a silent
// pass-through.

export type SimpleOperator =
  | 'neq'
  | 'cs'
  | 'cd'
  | 'ov'
  | 'sl'
  | 'sr'
  | 'nxr'
  | 'nxl'
  | 'adj';

export type QuantOperator =
  | 'eq'
  | 'gte'
  | 'gt'
  | 'lte'
  | 'lt'
  | 'like'
  | 'ilike'
  | 'match'
  | 'imatch';

export type FtsOperator = 'fts' | 'plfts' | 'phfts' | 'wfts';

export type OpQuantifier = 'any' | 'all';

export type IsVal = 'null' | 'not_null' | 'true' | 'false' | 'unknown';

export type GeoOperator = 'dwithin' | 'within' | 'intersects' | 'nearby';

// ----- Operation union --------------------------------------------------

export type Operation =
  | { readonly type: 'op'; readonly operator: SimpleOperator; readonly value: string }
  | {
      readonly type: 'opQuant';
      readonly operator: QuantOperator;
      readonly quantifier?: OpQuantifier;
      readonly value: string;
    }
  | { readonly type: 'in'; readonly values: readonly string[] }
  | { readonly type: 'is'; readonly value: IsVal }
  | { readonly type: 'isDistinctFrom'; readonly value: string }
  | {
      readonly type: 'fts';
      readonly operator: FtsOperator;
      readonly language?: string;
      readonly value: string;
    }
  | {
      readonly type: 'geo';
      readonly operator: GeoOperator;
      readonly lat: number;
      readonly lng: number;
      readonly distance?: number;
      readonly geojson?: string;
    };

export interface OpExpr {
  readonly negated: boolean;
  readonly operation: Operation;
}

export interface Filter {
  readonly field: Field;
  readonly opExpr: OpExpr;
}
