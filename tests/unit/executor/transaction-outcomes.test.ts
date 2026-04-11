// Stage 7 — transaction outcome tests.
//
// Each branch of `TransactionOutcome` is exercised against a fake
// SqlClient: commit, rollback (via Prefer), rollback (via page-total
// mismatch), max-affected-violation, and pg-error. The tests also
// assert that `SET LOCAL statement_timeout` is issued on every
// transaction — critique #65.

import { describe, expect, it } from 'vitest';

import { runTransaction } from '@/executor/transaction';
import type { ExecutableQuery } from '@/executor/types';
import { makeFakeSqlClient } from '@tests/fixtures/fake-sql';

const MAIN: ExecutableQuery = {
  sql: 'SELECT * FROM "public"."books"',
  params: [],
};

const MAIN_WITH_PARAMS: ExecutableQuery = {
  sql: 'SELECT * FROM "public"."books" WHERE "id" = $1',
  params: [42],
};

describe('runTransaction — commit branch', () => {
  it('returns commit with the main-query rows', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ total_result_set: 1, page_total: 1, body: '[{"id":1}]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {},
    });
    expect(outcome.kind).toBe('commit');
    if (outcome.kind !== 'commit') throw new Error('expected commit');
    expect(outcome.result.rows).toHaveLength(1);
    expect(outcome.result.rows[0]!.body).toBe('[{"id":1}]');
  });

  it('issues SET LOCAL statement_timeout on every transaction', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 2500,
      options: {},
    });
    const timeoutCall = client.calls.find((c) =>
      c.sql.includes('statement_timeout'),
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall!.sql).toContain("'2500ms'");
  });

  it('threads params through to the main query call', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: MAIN_WITH_PARAMS,
      statementTimeoutMs: 5000,
      options: {},
    });
    const mainCall = client.calls.find((c) => c.sql.includes('WHERE "id"'));
    expect(mainCall).toBeDefined();
    expect(mainCall!.params).toEqual([42]);
  });
});

describe('runTransaction — rollback branches', () => {
  it('rolls back when Prefer: tx=rollback is set', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ page_total: 3, body: '[]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { rollbackPreferred: true },
    });
    expect(outcome.kind).toBe('rollback');
    // Rows still flow through — the outcome carries them.
    if (outcome.kind !== 'rollback') throw new Error('expected rollback');
    expect(outcome.result.rows[0]!.page_total).toBe(3);
  });

  it('rolls back when page_total differs from rollbackOnPageTotalMismatch', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ page_total: 2, body: '[]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { rollbackOnPageTotalMismatch: 1 },
    });
    expect(outcome.kind).toBe('rollback');
  });

  it('commits when page_total matches rollbackOnPageTotalMismatch', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ page_total: 1, body: '[]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { rollbackOnPageTotalMismatch: 1 },
    });
    expect(outcome.kind).toBe('commit');
  });
});

describe('runTransaction — max-affected-violation branch', () => {
  it('returns max-affected-violation when page_total exceeds the limit', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ page_total: 50, body: '[]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { maxAffected: 10 },
    });
    expect(outcome.kind).toBe('max-affected-violation');
    if (outcome.kind !== 'max-affected-violation') {
      throw new Error('expected max-affected-violation');
    }
    expect(outcome.pageTotal).toBe(50);
  });

  it('commits when page_total is within the limit', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ page_total: 5, body: '[]' }],
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { maxAffected: 10 },
    });
    expect(outcome.kind).toBe('commit');
  });
});

describe('runTransaction — pg-error branch', () => {
  it('surfaces a postgres error object as a CloudRestError', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: 'FROM "public"."books"',
      errorValue: {
        code: '42P01',
        message: 'relation "books" does not exist',
      },
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {},
    });
    expect(outcome.kind).toBe('pg-error');
    if (outcome.kind !== 'pg-error') throw new Error('expected pg-error');
    expect(outcome.error.code).toBe('42P01');
    expect(outcome.error.httpStatus).toBe(404);
  });

  it('wraps unknown thrown values as a connection error', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: 'FROM "public"."books"',
      errorValue: new Error('socket hangup'),
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {},
    });
    expect(outcome.kind).toBe('pg-error');
    if (outcome.kind !== 'pg-error') throw new Error('expected pg-error');
    expect(outcome.error.code).toBe('08000');
  });
});

describe('runTransaction — no thrown sentinel in the public signature', () => {
  it('never surfaces the internal sentinel object to callers', async () => {
    const client = makeFakeSqlClient({ mainRows: [{ page_total: 5 }] });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { rollbackPreferred: true },
    });
    // Outcome is a discriminated union — no `__cloudrestSentinel`
    // field should be visible on any branch.
    expect(JSON.stringify(outcome)).not.toContain('__cloudrestSentinel');
  });
});

describe('runTransaction — step order (ported from old executor.test.ts)', () => {
  it('runs role → timeout → prequery → preRequest → main in order', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: { sql: 'SELECT 1 FROM pg_catalog.pg_namespace', params: [] },
      statementTimeoutMs: 5000,
      options: {
        roleSql: 'SET LOCAL ROLE "anon"',
        preQuerySql: "SELECT set_config('request.method', 'GET', true)",
        preRequestSql: 'SELECT "public"."__prerequest__"()',
      },
    });
    // First call should be the role, then the timeout, then the
    // prequery, then the pre-request, then the main query.
    const sqls = client.calls.map((c) => c.sql);
    const roleIdx = sqls.findIndex((s) => s.startsWith('SET LOCAL ROLE'));
    const timeoutIdx = sqls.findIndex((s) =>
      s.includes('statement_timeout'),
    );
    const prequeryIdx = sqls.findIndex((s) => s.includes('set_config'));
    const preRequestIdx = sqls.findIndex((s) => s.includes('__prerequest__'));
    const mainIdx = sqls.findIndex((s) => s.includes('pg_namespace'));
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeLessThan(timeoutIdx);
    expect(timeoutIdx).toBeLessThan(prequeryIdx);
    expect(prequeryIdx).toBeLessThan(preRequestIdx);
    expect(preRequestIdx).toBeLessThan(mainIdx);
  });

  it('skips the role step when roleSql is null', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { roleSql: null },
    });
    expect(
      client.calls.some((c) => /^\s*SET LOCAL ROLE/.test(c.sql)),
    ).toBe(false);
  });

  it('skips the preQuery step when preQuerySql is empty string', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: { preQuerySql: '' },
    });
    expect(
      client.calls.some((c) => c.sql.includes('set_config')),
    ).toBe(false);
  });

  it('accepts a bound-params preQuery shape', async () => {
    const client = makeFakeSqlClient();
    await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {
        preQuerySql: {
          sql: 'SELECT set_config($1, $2, true)',
          params: ['search_path', '"public"'],
        },
      },
    });
    const prequery = client.calls.find((c) => c.sql.includes('set_config'));
    expect(prequery).toBeDefined();
    expect(prequery!.params).toEqual(['search_path', '"public"']);
  });

  it('returns empty-body shape when the main query yields zero rows', async () => {
    const client = makeFakeSqlClient({ mainRows: [] });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {},
    });
    expect(outcome.kind).toBe('commit');
    if (outcome.kind !== 'commit') throw new Error('expected commit');
    expect(outcome.result.rows).toEqual([]);
    expect(outcome.result.responseHeaders).toBeNull();
    expect(outcome.result.responseStatus).toBeNull();
  });
});

describe('runTransaction — connection failure', () => {
  it('maps an ECONNREFUSED-style throw from begin() to a pg-error outcome', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: 'SELECT',
      errorValue: new Error('ECONNREFUSED'),
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {},
    });
    expect(outcome.kind).toBe('pg-error');
    if (outcome.kind !== 'pg-error') throw new Error('expected pg-error');
    expect(outcome.error.httpStatus).toBeGreaterThanOrEqual(500);
  });
});

describe('runTransaction — schema-version check error handling', () => {
  // Closes the "silently swallowed" bug: the version-check step may
  // only swallow `42P01` (undefined_table). Any other error must
  // propagate so downstream statements don't fail opaquely with
  // 25P02 "in_failed_sql_transaction".

  it('swallows a 42P01 (undefined_table) from the version check', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: '__schema_version__',
      errorValue: { code: '42P01', message: 'relation does not exist' },
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {
        versionSql: 'SELECT version FROM __schema_version__',
      },
    });
    // The main query still runs; version is null.
    expect(outcome.kind).toBe('commit');
    if (outcome.kind !== 'commit') throw new Error('expected commit');
    expect(outcome.result.schemaVersion).toBeNull();
  });

  it('propagates any non-42P01 error from the version check', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: '__schema_version__',
      errorValue: { code: '42703', message: 'column "version" does not exist' },
    });
    const outcome = await runTransaction({
      client,
      main: MAIN,
      statementTimeoutMs: 5000,
      options: {
        versionSql: 'SELECT version FROM __schema_version__',
      },
    });
    expect(outcome.kind).toBe('pg-error');
    if (outcome.kind !== 'pg-error') throw new Error('expected pg-error');
    expect(outcome.error.code).toBe('42703');
  });
});
