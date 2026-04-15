// End-to-end `POST /_batch` behavior tests.
//
// Drives `handleFetch` with a real schema cache + fake SQL client
// so we can verify the full batch path: parse, validate, resolve
// references, dispatch each sub-op through the in-process router,
// and return a combined result envelope.

import { afterEach, describe, expect, it } from 'vitest';

import { handleFetch } from '@/router/fetch';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '@/executor/client';
import { buildSchemaCacheFromTables } from '@/schema/introspect';
import { makeTable } from '@tests/fixtures/schema';
import { makeTestConfig } from '@tests/fixtures/config';
import { makeFakeSqlClient } from '@tests/fixtures/fake-sql';
import type { WorkerBindings } from '@/core/context';

const CONNECTION_STRING = 'postgres://fake/batch';

function makeBindings(): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: CONNECTION_STRING } as Hyperdrive,
    SCHEMA_CACHE: {} as KVNamespace,
    SCHEMA_COORDINATOR: {} as DurableObjectNamespace,
  } as unknown as WorkerBindings;
}

function makeExecutionContext() {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  };
}

const SCHEMA = buildSchemaCacheFromTables([
  makeTable({
    name: 'books',
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'int4', nullable: false },
      { name: 'title', type: 'text', nullable: false },
    ],
  }),
]);

async function postBatch(
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  __installClientForTest(
    CONNECTION_STRING,
    makeFakeSqlClient({
      mainRows: [
        {
          total_result_set: null,
          page_total: 1,
          body: '[{"id":1,"title":"Hello"}]',
        },
      ],
    }),
  );
  const request = new Request('https://api.test/_batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return handleFetch(
    request,
    makeBindings(),
    makeExecutionContext(),
    { config: makeTestConfig(), schema: SCHEMA },
  );
}

afterEach(() => {
  __resetClientsForTest();
});

describe('POST /_batch — happy path', () => {
  it('returns 200 with a results array for all successful operations', async () => {
    const response = await postBatch(
      JSON.stringify([
        { method: 'POST', path: '/books', body: { title: 'One' } },
        { method: 'POST', path: '/books', body: { title: 'Two' } },
      ]),
    );
    expect(response.status).toBe(200);
    const results = (await response.json()) as {
      status: number;
      body: unknown;
    }[];
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.status).toBe(201);
  });

  it('returns an empty array for an empty batch', async () => {
    const response = await postBatch('[]');
    expect(response.status).toBe(200);
    const results = await response.json();
    expect(results).toEqual([]);
  });
});

describe('POST /_batch — validation', () => {
  it('rejects a non-array JSON body', async () => {
    const response = await postBatch('{"bad":"body"}');
    expect(response.status).toBe(400);
    const err = (await response.json()) as { code: string };
    expect(err.code).toBe('PGRST102');
  });

  it('rejects a batch that exceeds MAX_BATCH_OPS', async () => {
    const ops = Array.from({ length: 60 }, () => ({
      method: 'POST',
      path: '/books',
      body: { title: 'x' },
    }));
    const response = await postBatch(JSON.stringify(ops));
    expect(response.status).toBe(400);
  });

  it('rejects an operation with a missing method', async () => {
    const response = await postBatch(
      JSON.stringify([{ path: '/books', body: {} }]),
    );
    expect(response.status).toBe(400);
  });

  it('rejects recursive /_batch calls', async () => {
    const response = await postBatch(
      JSON.stringify([{ method: 'POST', path: '/_batch', body: [] }]),
    );
    expect(response.status).toBe(400);
    const err = (await response.json()) as { code: string; message: string };
    expect(err.message).toContain('/_batch');
  });
});

describe('POST /_batch — partial failure', () => {
  it('returns 207 when at least one operation fails', async () => {
    const response = await postBatch(
      JSON.stringify([
        { method: 'POST', path: '/books', body: { title: 'ok' } },
        // Invalid column — planner returns PGRST204.
        { method: 'POST', path: '/books', body: { nonexistent: 1 } },
      ]),
    );
    expect(response.status).toBe(207);
    const results = (await response.json()) as {
      status: number;
      body: unknown;
    }[];
    expect(results[0]!.status).toBe(201);
    expect(results[1]!.status).toBe(400);
  });
});

describe('POST /_batch/transaction — reference resolution', () => {
  it('walks `$N.field` references into later operations', async () => {
    // First op creates a book; second op references `$0.id`.
    // The fake SQL client returns the same row shape for every
    // call, so `$0.id` resolves to `1`.
    __installClientForTest(
      CONNECTION_STRING,
      makeFakeSqlClient({
        mainRows: [
          {
            total_result_set: null,
            page_total: 1,
            body: '[{"id":1,"title":"Root"}]',
          },
        ],
      }),
    );
    const request = new Request('https://api.test/_batch/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { method: 'POST', path: '/books', body: { title: 'Root' } },
        { method: 'GET', path: '/books?id=eq.$0.id' },
      ]),
    });
    const response = await handleFetch(
      request,
      makeBindings(),
      makeExecutionContext(),
      { config: makeTestConfig(), schema: SCHEMA },
    );
    expect(response.status).toBe(200);
    const results = (await response.json()) as {
      status: number;
      body: unknown;
    }[];
    expect(results).toHaveLength(2);
    expect(results[1]!.status).toBe(200);
  });
});
