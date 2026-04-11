// Test helpers for building schema caches with routines.

import type { SchemaCache } from '../../src/schema/cache';
import type { Routine, RoutinesMap } from '../../src/schema/routine';
import { routineKey } from '../../src/schema/routine';

export function makeRoutine(spec: {
  readonly schema?: string;
  readonly name: string;
  readonly params?: readonly {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
    readonly variadic?: boolean;
  }[];
  readonly returnType?:
    | 'scalar-int'
    | 'scalar-text'
    | 'scalar-void'
    | 'setof-text'
    | 'composite';
  readonly volatility?: 'volatile' | 'stable' | 'immutable';
}): Routine {
  const schema = spec.schema ?? 'public';
  const params = (spec.params ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    typeModifier: p.type,
    required: p.required ?? true,
    variadic: p.variadic ?? false,
  }));
  const kindToReturnType = {
    'scalar-int': {
      kind: 'single' as const,
      pgType: {
        kind: 'scalar' as const,
        qi: { schema: 'pg_catalog', name: 'int4' },
      },
    },
    'scalar-text': {
      kind: 'single' as const,
      pgType: {
        kind: 'scalar' as const,
        qi: { schema: 'pg_catalog', name: 'text' },
      },
    },
    'scalar-void': {
      kind: 'single' as const,
      pgType: {
        kind: 'scalar' as const,
        qi: { schema: 'pg_catalog', name: 'void' },
      },
    },
    'setof-text': {
      kind: 'setOf' as const,
      pgType: {
        kind: 'scalar' as const,
        qi: { schema: 'pg_catalog', name: 'text' },
      },
    },
    composite: {
      kind: 'setOf' as const,
      pgType: {
        kind: 'composite' as const,
        qi: { schema, name: spec.name },
        isAlias: false,
      },
    },
  };
  return {
    schema,
    name: spec.name,
    description: null,
    params,
    returnType: kindToReturnType[spec.returnType ?? 'composite'],
    volatility: spec.volatility ?? 'volatile',
    hasVariadic: false,
  };
}

export function attachRoutines(
  cache: SchemaCache,
  routines: readonly Routine[],
): SchemaCache {
  const map = new Map<string, Routine[]>();
  for (const r of routines) {
    const key = routineKey({ schema: r.schema, name: r.name });
    const existing = map.get(key);
    if (existing) existing.push(r);
    else map.set(key, [r]);
  }
  return {
    ...cache,
    routines: map as RoutinesMap,
  };
}
