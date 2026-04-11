// Stage 18 — Server-Timing emission.
//
// The `RequestTimer` exists in Stage 7 and `finalizeResponse`
// emits a `Server-Timing` header when
// `config.observability.serverTimingEnabled` is true. This test
// exercises the full end-to-end path so a regression anywhere in
// the chain (timer → finalizer → response) fails here.

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

const CONNECTION_STRING = 'postgres://fake/test';

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
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'title', type: 'text' },
    ],
  }),
]);

afterEach(() => __resetClientsForTest());

async function fetchBooks(config = makeTestConfig()) {
  __installClientForTest(
    CONNECTION_STRING,
    makeFakeSqlClient({
      mainRows: [{ total_result_set: 0, page_total: 0, body: '[]' }],
    }),
  );
  const request = new Request('https://api.test/books', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return handleFetch(request, makeBindings(), makeExecutionContext(), {
    config,
    schema: SCHEMA,
  });
}

describe('Server-Timing header emission', () => {
  it('is absent when serverTimingEnabled is false', async () => {
    const response = await fetchBooks();
    expect(response.headers.get('Server-Timing')).toBeNull();
  });

  it('appears when serverTimingEnabled is true', async () => {
    const config = makeTestConfig();
    const withTiming = {
      ...config,
      observability: {
        ...config.observability,
        serverTimingEnabled: true,
      },
    };
    const response = await fetchBooks(withTiming);
    const header = response.headers.get('Server-Timing');
    expect(header).not.toBeNull();
    // Each phase is `name;dur=NNN`. The handler records `total`
    // at a minimum; `parse` comes from the router.
    expect(header).toMatch(/\w+;dur=\d/);
  });
});
