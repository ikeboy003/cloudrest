// Stage 10 — end-to-end RPC behavior tests.
//
// Closes critique #48: POST /rpc/fn with an empty body is
// interpreted as `{}` by the RPC HANDLER, not by the generic
// payload parser.

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
import { attachRoutines, makeRoutine } from '@tests/fixtures/routines';
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

const BOOKS_TABLE = makeTable({
  name: 'books',
  primaryKey: ['id'],
  columns: [{ name: 'id', type: 'bigint', nullable: false }],
});

const SCHEMA = attachRoutines(
  buildSchemaCacheFromTables([BOOKS_TABLE]),
  [
    makeRoutine({
      name: 'ping',
      params: [],
      returnType: 'scalar-text',
    }),
    makeRoutine({
      name: 'greet',
      params: [{ name: 'name', type: 'text' }],
      returnType: 'scalar-text',
    }),
  ],
);

async function fetchRpc(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
  } = {},
) {
  const client = makeFakeSqlClient({
    mainRows: [{ total_result_set: null, page_total: 1, body: '"ok"' }],
  });
  __installClientForTest(CONNECTION_STRING, client);
  const request = new Request(`https://api.test${path}`, {
    method: options.method ?? 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const response = await handleFetch(
    request,
    makeBindings(),
    makeExecutionContext(),
    { config: makeTestConfig(), schema: SCHEMA },
  );
  return { response, client };
}

afterEach(() => {
  __resetClientsForTest();
});

describe('POST /rpc/ping — critique #48 empty-body shortcut', () => {
  it('treats an empty body as `{}` and dispatches as a no-arg call', async () => {
    const { response, client } = await fetchRpc('/rpc/ping');
    expect(response.status).toBe(200);
    const mainCall = client.calls.find((c) => c.sql.includes('"ping"()'));
    expect(mainCall).toBeDefined();
  });

  it('POST /rpc/ping with an empty JSON body also works', async () => {
    const { response, client } = await fetchRpc('/rpc/ping', { body: '{}' });
    expect(response.status).toBe(200);
    const mainCall = client.calls.find((c) => c.sql.includes('"ping"()'));
    expect(mainCall).toBeDefined();
  });
});

describe('POST /rpc/greet — named args from body', () => {
  it('binds every parameter via $N', async () => {
    const { response, client } = await fetchRpc('/rpc/greet', {
      body: '{"name":"alice"}',
    });
    expect(response.status).toBe(200);
    const mainCall = client.calls.find((c) =>
      c.sql.includes('"public"."greet"'),
    );
    expect(mainCall).toBeDefined();
    expect(mainCall!.sql).toContain('"name" := $1::text');
    expect(mainCall!.params).toEqual(['alice']);
  });

  it('rejects an unknown parameter with PGRST100', async () => {
    const { response } = await fetchRpc('/rpc/greet', {
      body: '{"nonexistent":"x"}',
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST100');
  });

  it('rejects an unknown routine with PGRST203', async () => {
    const { response } = await fetchRpc('/rpc/nope', { body: '{}' });
    expect(response.status).toBe(404);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['code']).toBe('PGRST203');
  });
});

describe('GET /rpc/greet — query-string args', () => {
  it('reads named args off the URL', async () => {
    const { response, client } = await fetchRpc('/rpc/greet?name=alice', {
      method: 'GET',
      headers: { 'Content-Type': '' },
    });
    expect(response.status).toBe(200);
    const mainCall = client.calls.find((c) => c.sql.includes('"greet"'));
    expect(mainCall).toBeDefined();
    expect(mainCall!.params).toContain('alice');
  });
});
