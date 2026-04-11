// Stage 8 — end-to-end behavior test for `GET /{relation}`.
//
// Wires the real pipeline (parse → plan → build → execute → finalize)
// against a fake `SqlClient` that replays scripted rows. PHASE_B
// Stage 8: "the new pipeline first meets the old test corpus".
//
// This is not a per-module test — `plan-read.test.ts` and friends
// cover the individual steps. The purpose here is to pin the glue:
// the router wires handlers correctly, the handler threads its
// context through, and the finalizer produces a well-formed
// `Response`.

import { afterEach, describe, expect, it } from 'vitest';

import { handleFetch } from '../../src/router/fetch';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '../../src/executor/client';
import { buildSchemaCacheFromTables } from '../../src/schema/introspect';
import { makeTable, makeTestConfig } from '../fixtures/config-and-schema';
import { makeFakeSqlClient } from '../fixtures/fake-sql';
import type { WorkerBindings } from '../../src/core/context';

// ----- Test bindings ----------------------------------------------------

const CONNECTION_STRING = 'postgres://fake/test';

function makeBindings(): WorkerBindings {
  // Shape matches the Env interface we care about. Most fields are
  // only accessed at later stages and can be undefined/typed-any.
  return {
    HYPERDRIVE: { connectionString: CONNECTION_STRING } as Hyperdrive,
    SCHEMA_CACHE: {} as KVNamespace,
    SCHEMA_COORDINATOR: {} as DurableObjectNamespace,
  } as unknown as WorkerBindings;
}

function makeExecutionContext(): {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
} {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  };
}

const BOOKS_TABLE = makeTable({
  name: 'books',
  primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'bigint', nullable: false },
    { name: 'title', type: 'text' },
    { name: 'price', type: 'numeric' },
    { name: 'category', type: 'text' },
  ],
});

const BOOKS_SCHEMA = buildSchemaCacheFromTables([BOOKS_TABLE]);

// ----- Helpers ----------------------------------------------------------

async function fetchWith(
  url: string,
  options: {
    readonly mainRows?: readonly Record<string, unknown>[];
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const client = makeFakeSqlClient({
    mainRows:
      options.mainRows ??
      [
        {
          total_result_set: 2,
          page_total: 2,
          body: '[{"id":1,"title":"A"},{"id":2,"title":"B"}]',
        },
      ],
  });
  __installClientForTest(CONNECTION_STRING, client);

  const request = new Request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  return handleFetch(request, makeBindings(), makeExecutionContext(), {
    config: makeTestConfig(),
    schema: BOOKS_SCHEMA,
  });
}

afterEach(() => {
  __resetClientsForTest();
});

// ----- Happy path -------------------------------------------------------

describe('GET /books — happy path', () => {
  it('returns 200 and the body from the main query', async () => {
    const response = await fetchWith('https://api.test/books');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('[{"id":1,"title":"A"},{"id":2,"title":"B"}]');
  });

  it('sets Content-Type from negotiation', async () => {
    const response = await fetchWith('https://api.test/books');
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('sets Content-Range from the main query row counts', async () => {
    const response = await fetchWith('https://api.test/books');
    expect(response.headers.get('Content-Range')).toBe('0-1/2');
  });

  it('sets a weak ETag on the response', async () => {
    const response = await fetchWith('https://api.test/books');
    const etag = response.headers.get('ETag');
    expect(etag).not.toBeNull();
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
  });
});

// ----- HEAD support -----------------------------------------------------

describe('HEAD /books — headers only', () => {
  it('returns no body but preserves Content-Length', async () => {
    const client = makeFakeSqlClient({
      mainRows: [
        {
          total_result_set: 2,
          page_total: 2,
          body: '[{"id":1,"title":"A"},{"id":2,"title":"B"}]',
        },
      ],
    });
    __installClientForTest(CONNECTION_STRING, client);

    const request = new Request('https://api.test/books', {
      method: 'HEAD',
      headers: { Accept: 'application/json' },
    });
    const response = await handleFetch(
      request,
      makeBindings(),
      makeExecutionContext(),
      {
        config: makeTestConfig(),
        schema: BOOKS_SCHEMA,
      },
    );

    expect(response.status).toBe(200);
    // Body is stripped.
    const body = await response.text();
    expect(body).toBe('');
    expect(response.headers.get('Content-Length')).not.toBeNull();
  });
});

// ----- Filters and errors ----------------------------------------------

describe('GET /books — filters and validation', () => {
  it('rejects a filter on an unknown column with PGRST204', async () => {
    const response = await fetchWith('https://api.test/books?nonexistent=eq.1');
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST204');
  });

  it('rejects a GET on an unknown relation with PGRST205', async () => {
    const response = await fetchWith('https://api.test/boks');
    expect(response.status).toBe(404);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST205');
  });

  it('surfaces a pg-level error from the fake client as a typed HTTP response', async () => {
    const client = makeFakeSqlClient({
      errorOnMatch: 'FROM "public"."books"',
      errorValue: {
        code: '42P01',
        message: 'relation "books" does not exist',
      },
    });
    __installClientForTest(CONNECTION_STRING, client);
    const request = new Request('https://api.test/books', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const response = await handleFetch(
      request,
      makeBindings(),
      makeExecutionContext(),
      { config: makeTestConfig(), schema: BOOKS_SCHEMA },
    );
    expect(response.status).toBe(404);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('42P01');
  });
});

// ----- Executor interaction ---------------------------------------------

describe('GET /books — executor integration', () => {
  it('issues SET LOCAL statement_timeout as part of the transaction prelude', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ total_result_set: 0, page_total: 0, body: '[]' }],
    });
    __installClientForTest(CONNECTION_STRING, client);
    const request = new Request('https://api.test/books', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    await handleFetch(request, makeBindings(), makeExecutionContext(), {
      config: makeTestConfig(),
      schema: BOOKS_SCHEMA,
    });
    const timeoutCall = client.calls.find((c) =>
      c.sql.includes('statement_timeout'),
    );
    expect(timeoutCall).toBeDefined();
  });

  it('renders the main query with the builder-emitted SQL shape', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ total_result_set: 0, page_total: 0, body: '[]' }],
    });
    __installClientForTest(CONNECTION_STRING, client);
    const request = new Request('https://api.test/books?select=id,title', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    await handleFetch(request, makeBindings(), makeExecutionContext(), {
      config: makeTestConfig(),
      schema: BOOKS_SCHEMA,
    });
    const mainCall = client.calls.find(
      (c) =>
        c.sql.includes('FROM "public"."books"') &&
        c.sql.includes('json_agg'),
    );
    expect(mainCall).toBeDefined();
    // The select list propagated through.
    expect(mainCall!.sql).toContain('"public"."books"."id"');
    expect(mainCall!.sql).toContain('"public"."books"."title"');
  });
});

// ----- Output media formatters (#bug2) ---------------------------------
//
// Previously the handler only set Content-Type from the negotiated
// media; the body was passed through untouched. CSV, NDJSON, and
// singular all produced JSON with a wrong Content-Type.

describe('GET /books — output media transformation', () => {
  it('formats the body as CSV when Accept: text/csv', async () => {
    const response = await fetchWith('https://api.test/books', {
      headers: { Accept: 'text/csv' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    const body = await response.text();
    expect(body).toContain('id,title');
    expect(body).toContain('1,A');
    expect(body).toContain('2,B');
    expect(body).not.toContain('[{');
  });

  it('formats the body as NDJSON when Accept: application/x-ndjson', async () => {
    const response = await fetchWith('https://api.test/books', {
      headers: { Accept: 'application/x-ndjson' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(
      'application/x-ndjson',
    );
    const body = await response.text();
    expect(body).toBe('{"id":1,"title":"A"}\n{"id":2,"title":"B"}');
  });

  it('unwraps a single row for application/vnd.pgrst.object+json', async () => {
    const response = await fetchWith('https://api.test/books', {
      headers: { Accept: 'application/vnd.pgrst.object+json' },
      mainRows: [
        {
          total_result_set: 1,
          page_total: 1,
          body: '[{"id":1,"title":"A"}]',
        },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('{"id":1,"title":"A"}');
  });

  it('returns PGRST116 when singular sees 2+ rows', async () => {
    const response = await fetchWith('https://api.test/books', {
      headers: { Accept: 'application/vnd.pgrst.object+json' },
    });
    expect(response.status).toBe(406);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST116');
  });

  it('returns PGRST116 when singular sees 0 rows', async () => {
    const response = await fetchWith('https://api.test/books', {
      headers: { Accept: 'application/vnd.pgrst.object+json' },
      mainRows: [{ total_result_set: 0, page_total: 0, body: '[]' }],
    });
    expect(response.status).toBe(406);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST116');
  });
});
