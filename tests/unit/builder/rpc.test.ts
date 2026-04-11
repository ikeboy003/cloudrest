// Stage 10 — RPC builder tests.
//
// Pins the call-shape emission: named args, single unnamed, none.
// All argument values go through addParam.

import { describe, expect, it } from 'vitest';

import { buildRpcQuery } from '@/builder/rpc';
import type { RpcPlan } from '@/planner/rpc-plan';
import { makeRoutine } from '@tests/fixtures/routines';
import { expectOk } from '@tests/fixtures/assert-result';

function plan(overrides: Partial<RpcPlan> = {}): RpcPlan {
  const routine = makeRoutine({
    name: 'greet',
    params: [{ name: 'name', type: 'text' }],
    returnType: 'scalar-text',
  });
  return {
    kind: 'rpc',
    target: { schema: 'public', name: 'greet' },
    routine,
    callShape: 'named',
    namedArgs: [['name', 'alice']],
    rawBody: null,
    filters: [],
    logic: [],
    order: [],
    range: { offset: 0, limit: null },
    select: [],
    returnPreference: 'full',
    returnsScalar: true,
    returnsSetOfScalar: false,
    returnsVoid: false,
    ...overrides,
  };
}

describe('buildRpcQuery — named args', () => {
  it('emits `name := $1::text` with a bound parameter', () => {
    const built = expectOk(buildRpcQuery(plan()));
    expect(built.sql).toContain('"public"."greet"("name" := $1::text)');
    expect(built.params).toEqual(['alice']);
  });

  it('wraps a scalar return in pgrst_scalar', () => {
    const built = expectOk(buildRpcQuery(plan()));
    expect(built.sql).toContain('AS pgrst_scalar');
    expect(built.sql).toContain("coalesce(json_agg(t.pgrst_scalar)->0, 'null')::text");
  });
});

describe('buildRpcQuery — no-arg call', () => {
  it('emits fn() with no binds', () => {
    const built = expectOk(
      buildRpcQuery(
        plan({
          target: { schema: 'public', name: 'ping' },
          routine: makeRoutine({
            name: 'ping',
            params: [],
            returnType: 'scalar-text',
          }),
          callShape: 'none',
          namedArgs: [],
        }),
      ),
    );
    expect(built.sql).toContain('"public"."ping"()');
    expect(built.params).toEqual([]);
  });
});

describe('buildRpcQuery — single unnamed arg', () => {
  it('emits fn($1::type) with the raw body bound', () => {
    const routine = makeRoutine({
      name: 'echo_json',
      params: [{ name: '', type: 'json' }],
      returnType: 'scalar-text',
    });
    const built = expectOk(
      buildRpcQuery(
        plan({
          target: { schema: 'public', name: 'echo_json' },
          routine,
          callShape: 'singleUnnamed',
          namedArgs: [],
          rawBody: '{"x":1}',
        }),
      ),
    );
    expect(built.sql).toContain('"public"."echo_json"($1::json)');
    expect(built.params).toEqual(['{"x":1}']);
  });
});

describe('buildRpcQuery — composite + setOf returns', () => {
  it('composite: unpacks record columns with SELECT * FROM fn(...)', () => {
    const routine = makeRoutine({
      name: 'get_books',
      params: [],
      returnType: 'composite',
    });
    const built = expectOk(
      buildRpcQuery(
        plan({
          target: { schema: 'public', name: 'get_books' },
          routine,
          callShape: 'none',
          namedArgs: [],
          returnsScalar: false,
          returnsSetOfScalar: false,
        }),
      ),
    );
    // New shape: one subquery, bare `SELECT * FROM fn()` so the
    // function's record columns expose as row columns for
    // downstream filter/order/limit (LOCAL_SCOPE).
    expect(built.sql).toContain('SELECT * FROM "public"."get_books"()');
    expect(built.sql).toContain("coalesce(json_agg(t), '[]')::text");
  });

  it('setOf scalar: aggregates pgrst_scalar as a JSON array', () => {
    const built = expectOk(
      buildRpcQuery(
        plan({
          returnsScalar: false,
          returnsSetOfScalar: true,
        }),
      ),
    );
    expect(built.sql).toContain("coalesce(json_agg(t.pgrst_scalar), '[]')::text");
  });
});
