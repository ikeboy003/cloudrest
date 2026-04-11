// Schema cache: routine (function) definitions used for `/rpc/*`.
//
// INVARIANT (CONSTITUTION §1.5): routine records are typed, not bags
// of strings. The old code's `pd*` / `pp*` Haskell-record prefixes
// are dropped — the rewrite uses plain `name`, `schema`, `params`.
//
// INVARIANT (critique #48): the routine lookup is deterministic.
// Ambiguous routines (multiple overloads with the same name but
// incompatible parameter sets) are a PGRST201 error at the planner,
// not a silent last-wins.

import type { QualifiedIdentifier } from '../http/request';

// ----- Types -----------------------------------------------------------

export type PgType =
  | { readonly kind: 'scalar'; readonly qi: QualifiedIdentifier }
  | {
      readonly kind: 'composite';
      readonly qi: QualifiedIdentifier;
      readonly isAlias: boolean;
    };

export type RetType =
  | { readonly kind: 'single'; readonly pgType: PgType }
  | { readonly kind: 'setOf'; readonly pgType: PgType };

export type FuncVolatility = 'volatile' | 'stable' | 'immutable';

export interface RoutineParam {
  readonly name: string;
  readonly type: string;
  /** Optional Postgres type modifier string, e.g. `varchar(255)`. */
  readonly typeModifier: string;
  readonly required: boolean;
  readonly variadic: boolean;
}

export interface Routine {
  readonly schema: string;
  readonly name: string;
  readonly description: string | null;
  readonly params: readonly RoutineParam[];
  readonly returnType: RetType;
  readonly volatility: FuncVolatility;
  readonly hasVariadic: boolean;
}

export type RoutinesMap = ReadonlyMap<string, readonly Routine[]>;

// ----- Helpers ---------------------------------------------------------

export function funcReturnsScalar(r: Routine): boolean {
  return r.returnType.kind === 'single' && r.returnType.pgType.kind === 'scalar';
}

export function funcReturnsSetOfScalar(r: Routine): boolean {
  return r.returnType.kind === 'setOf' && r.returnType.pgType.kind === 'scalar';
}

export function funcReturnsSingle(r: Routine): boolean {
  return r.returnType.kind === 'single';
}

export function funcReturnsVoid(r: Routine): boolean {
  if (r.returnType.kind !== 'single') return false;
  const t = r.returnType.pgType;
  return (
    t.kind === 'scalar' &&
    t.qi.schema === 'pg_catalog' &&
    t.qi.name === 'void'
  );
}

/**
 * Canonical lookup key: `schema\0name`. Uses a NUL separator so
 * `public.my.function` and `public.my\0function` cannot collide.
 */
export function routineKey(id: QualifiedIdentifier): string {
  return `${id.schema}\0${id.name}`;
}
