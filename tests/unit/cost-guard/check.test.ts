// `checkQueryCost` integration tests.
//
// Drives the guard against a fake `SqlClient` that scripts
// `EXPLAIN (FORMAT JSON)` row sets. Verifies the three outcomes:
//   - disabled (maxCost=0 → always allow)
//   - under budget (cost < max → allow)
//   - over budget (cost > max → PGRST118)
// plus the fail-open behavior when EXPLAIN itself errors.

import { afterEach, describe, expect, it } from 'vitest';

import { checkQueryCost } from '@/cost-guard/check';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '@/executor/client';
import { makeFakeSqlClient } from '@tests/fixtures/fake-sql';
import { makeTestConfig } from '@tests/fixtures/config';
import type { AppConfig } from '@/config/schema';
import type { AuthClaims } from '@/auth/authenticate';
import type { BuiltQuery } from '@/builder/types';
import type { HandlerContext, WorkerBindings } from '@/core/context';
import { createRequestTimer } from '@/executor/timer';

const CONNECTION_STRING = 'postgres://fake/cost-guard';

const BUILT: BuiltQuery = {
  sql: 'SELECT * FROM "public"."books" WHERE "id" = $1',
  params: [42],
};

function makeBindings(): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: CONNECTION_STRING } as Hyperdrive,
    SCHEMA_CACHE: {} as KVNamespace,
    SCHEMA_COORDINATOR: {} as DurableObjectNamespace,
  } as unknown as WorkerBindings;
}

function makeCtx(config: AppConfig): HandlerContext {
  const auth: AuthClaims = { role: 'anon', claims: {} };
  return {
    originalHttpRequest: new Request('https://api.test/'),
    executionContext: {
      waitUntil: () => {},
      passThroughOnException: () => {},
    },
    bindings: makeBindings(),
    config,
    // Real schema cache isn't needed — cost guard doesn't touch it.
    schema: {
      tables: new Map(),
      relationships: new Map(),
      routines: new Map(),
      loadedAt: 0,
      version: 0,
    },
    auth,
    timer: createRequestTimer(() => 0),
  };
}

function configWithMax(max: number): AppConfig {
  const base = makeTestConfig();
  return {
    ...base,
    limits: {
      ...base.limits,
      maxQueryCost: max,
    },
  };
}

afterEach(() => {
  __resetClientsForTest();
});

describe('checkQueryCost — disabled', () => {
  it('short-circuits when maxQueryCost is 0', async () => {
    // No fake client installed — if the guard actually tried to
    // execute, the real postgres() factory would throw against a
    // fake connection string.
    __installClientForTest(CONNECTION_STRING, makeFakeSqlClient());
    const result = await checkQueryCost(
      makeCtx(configWithMax(0)),
      BUILT,
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ allowed: true, cost: 0 });
  });
});

describe('checkQueryCost — under budget', () => {
  it('returns allowed with the extracted cost', async () => {
    const client = makeFakeSqlClient({
      mainRows: [
        {
          'QUERY PLAN': [{ Plan: { 'Total Cost': 50 } }],
        },
      ],
    });
    __installClientForTest(CONNECTION_STRING, client);
    const result = await checkQueryCost(
      makeCtx(configWithMax(100)),
      BUILT,
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ allowed: true, cost: 50 });
    // The EXPLAIN call was issued.
    const explainCall = client.calls.find((c) =>
      c.sql.includes('EXPLAIN (FORMAT JSON)'),
    );
    expect(explainCall).toBeDefined();
  });

  it('inlines bind params into the EXPLAIN SQL', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 5 } }] }],
    });
    __installClientForTest(CONNECTION_STRING, client);
    await checkQueryCost(
      makeCtx(configWithMax(100)),
      BUILT,
      {},
    );
    const explainCall = client.calls.find((c) =>
      c.sql.includes('EXPLAIN (FORMAT JSON)'),
    );
    expect(explainCall!.sql).toContain('"id" = 42');
    expect(explainCall!.sql).not.toContain('$1');
  });
});

describe('checkQueryCost — over budget', () => {
  it('returns PGRST118 when the planner cost exceeds the limit', async () => {
    const client = makeFakeSqlClient({
      mainRows: [
        { 'QUERY PLAN': [{ Plan: { 'Total Cost': 9999 } }] },
      ],
    });
    __installClientForTest(CONNECTION_STRING, client);
    const result = await checkQueryCost(
      makeCtx(configWithMax(1000)),
      BUILT,
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PGRST118');
    expect(result.error.httpStatus).toBe(413);
    expect(result.error.details).toContain('9999');
    expect(result.error.details).toContain('1000');
  });
});

describe('checkQueryCost — fail open on EXPLAIN error', () => {
  it('allows the request through when EXPLAIN throws', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: 'EXPLAIN',
      errorValue: { code: '42601', message: 'syntax error' },
    });
    __installClientForTest(CONNECTION_STRING, client);
    const result = await checkQueryCost(
      makeCtx(configWithMax(100)),
      BUILT,
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ allowed: true, cost: 0 });
  });
});
