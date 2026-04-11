// Stage 9 — end-to-end mutation behavior tests.
//
// Drives `handleFetch` with a fake postgres client through a real
// parse → plan → build → execute → finalize pipeline for
// POST / PATCH / DELETE requests.

import { afterEach, describe, expect, it } from 'vitest';

import { handleFetch } from '../../src/router/fetch';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '../../src/executor/client';
import { buildSchemaCacheFromTables } from '../../src/schema/introspect';
import { makeTable } from '../fixtures/schema';
import { makeTestConfig } from '../fixtures/config';
import { makeFakeSqlClient, type FakeSqlClient } from '../fixtures/fake-sql';
import type { WorkerBindings } from '../../src/core/context';

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

const BOOKS_TABLE = makeTable({
  name: 'books',
  primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'bigint', nullable: false },
    { name: 'title', type: 'text' },
    { name: 'author_id', type: 'bigint' },
    { name: 'price', type: 'numeric' },
  ],
});

const SCHEMA = buildSchemaCacheFromTables([BOOKS_TABLE]);

async function request(opts: {
  readonly method: string;
  readonly path?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly client?: FakeSqlClient;
}): Promise<{ response: Response; client: FakeSqlClient }> {
  const client =
    opts.client ??
    makeFakeSqlClient({
      mainRows: [
        {
          total_result_set: null,
          page_total: 1,
          body: '[{"id":1,"title":"Hello"}]',
        },
      ],
    });
  __installClientForTest(CONNECTION_STRING, client);
  const req = new Request(`https://api.test${opts.path ?? '/books'}`, {
    method: opts.method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  });
  const response = await handleFetch(
    req,
    makeBindings(),
    makeExecutionContext(),
    { config: makeTestConfig(), schema: SCHEMA },
  );
  return { response, client };
}

afterEach(() => {
  __resetClientsForTest();
});

describe('POST /books — insert', () => {
  it('returns 201 and the inserted rows when Prefer: return=representation', async () => {
    const { response, client } = await request({
      method: 'POST',
      body: '{"title":"Hello"}',
      headers: { Prefer: 'return=representation' },
    });
    expect(response.status).toBe(201);
    const mainCall = client.calls.find((c) => c.sql.includes('INSERT INTO'));
    expect(mainCall).toBeDefined();
    expect(mainCall!.sql).toContain('"public"."books"');
    expect(mainCall!.sql).toContain('json_to_record($1::json)');
    expect(mainCall!.params).toEqual(['{"title":"Hello"}']);
  });

  it('rejects an unknown column in the payload with PGRST204', async () => {
    const { response } = await request({
      method: 'POST',
      body: '{"nonexistent":1}',
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST204');
  });

  it('rejects an oversized body with PGRST413 BEFORE reading it (#44)', async () => {
    // The pre-check reads Content-Length and refuses without
    // consuming the body. The fake config's maxBodyBytes default
    // is 1 MiB in makeTestConfig; set content-length explicitly.
    const client = makeFakeSqlClient();
    __installClientForTest(CONNECTION_STRING, client);
    const req = new Request('https://api.test/books', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '9999999999', // 10 GB declared
      },
      body: '{}',
    });
    const response = await handleFetch(
      req,
      makeBindings(),
      makeExecutionContext(),
      { config: makeTestConfig(), schema: SCHEMA },
    );
    expect(response.status).toBe(413);
  });
});

describe('PATCH /books — update', () => {
  it('returns 200 and builds an UPDATE CTE', async () => {
    const { response, client } = await request({
      method: 'PATCH',
      path: '/books?id=eq.1',
      body: '{"title":"Hello"}',
    });
    expect(response.status).toBe(200);
    const mainCall = client.calls.find((c) => c.sql.includes('UPDATE'));
    expect(mainCall).toBeDefined();
    expect(mainCall!.sql).toContain('"public"."books"');
    // Minimal-return PATCH emits `RETURNING 1` — Prefer:
    // return=representation is what switches to the schema-qualified
    // return clause.
    expect(mainCall!.sql).toContain('RETURNING 1');
  });

  it('emits RETURNING "public"."books".* with Prefer: return=representation', async () => {
    const { client } = await request({
      method: 'PATCH',
      path: '/books?id=eq.1',
      body: '{"title":"Hello"}',
      headers: { Prefer: 'return=representation' },
    });
    const mainCall = client.calls.find((c) => c.sql.includes('UPDATE'));
    expect(mainCall!.sql).toContain('RETURNING "public"."books".*');
  });
});

describe('DELETE /books — delete', () => {
  it('returns 204 and builds a DELETE CTE', async () => {
    const { response, client } = await request({
      method: 'DELETE',
      path: '/books?id=eq.1',
    });
    expect(response.status).toBe(204);
    const mainCall = client.calls.find((c) => c.sql.includes('DELETE FROM'));
    expect(mainCall).toBeDefined();
    expect(mainCall!.sql).toContain('"public"."books"');
    expect(mainCall!.sql).toContain('"public"."books"."id" =');
  });
});

// ----- PUT with ?limit= is refused (#bug3) -----------------------------

describe('PUT /books — limit/offset rejection', () => {
  it('refuses PUT /books?limit=1 with PGRST114', async () => {
    const { response } = await request({
      method: 'PUT',
      path: '/books?id=eq.1&limit=1',
      body: '{"id":1,"title":"X"}',
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST114');
  });

  it('refuses PUT /books?offset=5 with PGRST114', async () => {
    const { response } = await request({
      method: 'PUT',
      path: '/books?id=eq.1&offset=5',
      body: '{"id":1,"title":"X"}',
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST114');
  });
});

// ----- Prefer: max-affected threading (#bug4) --------------------------

describe('PATCH /books — Prefer: max-affected', () => {
  it('returns PGRST124 when the query affects more rows than allowed', async () => {
    // Fake client reports `page_total: 5`, which exceeds
    // `max-affected=2`. The executor must roll back and surface a
    // typed PGRST124 — the old handler silently ignored the
    // preference and a table-wide PATCH returned 200.
    const client = makeFakeSqlClient({
      mainRows: [
        {
          total_result_set: null,
          page_total: 5,
          body: '[]',
        },
      ],
    });
    const { response } = await request({
      method: 'PATCH',
      path: '/books?id=gt.0',
      body: '{"title":"X"}',
      headers: { Prefer: 'max-affected=2' },
      client,
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST124');
  });

  it('succeeds when the query stays within the max-affected budget', async () => {
    const client = makeFakeSqlClient({
      mainRows: [
        {
          total_result_set: null,
          page_total: 1,
          body: '[]',
        },
      ],
    });
    const { response } = await request({
      method: 'PATCH',
      path: '/books?id=eq.1',
      body: '{"title":"X"}',
      headers: { Prefer: 'max-affected=2' },
      client,
    });
    expect(response.status).toBe(200);
  });
});

// ----- Embedded filter rejection (#bug1) --------------------------------

describe('PATCH/DELETE /books — embedded filter rejection', () => {
  it('refuses PATCH with only an embedded filter (PGRST100, no SQL runs)', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ total_result_set: null, page_total: 1, body: '[]' }],
    });
    const { response } = await request({
      method: 'PATCH',
      path: '/books?authors.name=eq.Bob',
      body: '{"title":"X"}',
      client,
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST100');
    // Critical: no UPDATE must have been issued to the database.
    const updateCall = client.calls.find((c) => c.sql.includes('UPDATE'));
    expect(updateCall).toBeUndefined();
  });

  it('refuses DELETE with only an embedded filter', async () => {
    const client = makeFakeSqlClient({
      mainRows: [{ total_result_set: null, page_total: 1, body: '[]' }],
    });
    const { response } = await request({
      method: 'DELETE',
      path: '/books?authors.name=eq.Bob',
      client,
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST100');
    const deleteCall = client.calls.find((c) => c.sql.includes('DELETE FROM'));
    expect(deleteCall).toBeUndefined();
  });
});
