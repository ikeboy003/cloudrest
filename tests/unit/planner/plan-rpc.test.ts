// Stage 10 — RPC planner tests.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '@/parser/query-params';
import { planRpc } from '@/planner/plan-rpc';
import type { Payload } from '@/parser/payload';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { makeSchema } from '@tests/fixtures/schema';
import { attachRoutines, makeRoutine } from '@tests/fixtures/routines';

const SCHEMA = attachRoutines(makeSchema([]), [
  makeRoutine({
    name: 'greet',
    params: [{ name: 'name', type: 'text' }],
    returnType: 'scalar-text',
  }),
  makeRoutine({
    name: 'add',
    params: [
      { name: 'a', type: 'int4' },
      { name: 'b', type: 'int4' },
    ],
    returnType: 'scalar-int',
  }),
  makeRoutine({
    name: 'ping',
    params: [],
    returnType: 'scalar-text',
  }),
]);

function jsonPayload(obj: Record<string, unknown>): Payload {
  return {
    type: 'json',
    raw: JSON.stringify(obj),
    keys: new Set(Object.keys(obj)),
  };
}

function plan(
  target: { schema: string; name: string },
  payload: Payload | null,
  queryString = '',
) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(queryString)));
  return planRpc({
    target,
    parsed,
    payload,
    preferences: { invalidPrefs: [] },
    schema: SCHEMA,
    topLevelRange: { offset: 0, limit: null },
  });
}

describe('planRpc — routine lookup', () => {
  it('resolves a known routine', () => {
    const p = expectOk(
      plan({ schema: 'public', name: 'greet' }, jsonPayload({ name: 'a' })),
    );
    expect(p.routine.name).toBe('greet');
  });

  it('returns PGRST203 on an unknown routine', () => {
    const r = expectErr(
      plan({ schema: 'public', name: 'nope' }, jsonPayload({})),
    );
    expect(r.code).toBe('PGRST203');
  });
});

describe('planRpc — named args from body', () => {
  it('binds every param', () => {
    const p = expectOk(
      plan({ schema: 'public', name: 'add' }, jsonPayload({ a: 1, b: 2 })),
    );
    expect(p.callShape).toBe('named');
    expect(p.namedArgs.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('rejects an unknown parameter', () => {
    const r = expectErr(
      plan(
        { schema: 'public', name: 'add' },
        jsonPayload({ a: 1, b: 2, typo: 3 }),
      ),
    );
    expect(r.code).toBe('PGRST100');
    expect(r.message).toContain('typo');
  });

  it('rejects a missing required parameter', () => {
    const r = expectErr(
      plan({ schema: 'public', name: 'add' }, jsonPayload({ a: 1 })),
    );
    expect(r.code).toBe('PGRST100');
    expect(r.message).toContain('b');
  });
});

describe('planRpc — GET /rpc/fn with query args', () => {
  it('reads rpcParams off the URL', () => {
    const p = expectOk(
      plan({ schema: 'public', name: 'add' }, null, 'a=1&b=2'),
    );
    expect(p.callShape).toBe('named');
    expect(p.namedArgs.map(([k]) => k)).toEqual(['a', 'b']);
  });
});

describe('planRpc — no-arg routines', () => {
  it('plans a bare fn() call', () => {
    const p = expectOk(
      plan({ schema: 'public', name: 'ping' }, jsonPayload({})),
    );
    expect(p.callShape).toBe('none');
    expect(p.namedArgs).toEqual([]);
  });
});
