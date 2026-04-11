// Stage 11 §11.9 — end-to-end WWW-Authenticate Bearer challenge.
//
// The challenge header comes out of `router/fetch.ts::formatError`.
// These tests drive a real `handleFetch` with malformed / missing /
// expired tokens and pin the header shape.

import { afterEach, describe, expect, it } from 'vitest';

import { handleFetch } from '@/router/fetch';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '@/executor/client';
import {
  __resetJwtCacheForTest,
  __resetJwksCacheForTest,
  __resetPemCacheForTest,
} from '@/auth';
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
    columns: [{ name: 'id', type: 'bigint', nullable: false }],
  }),
]);

async function fetchWith(
  headers: Record<string, string>,
  opts: { readonly anonRole?: string } = {},
): Promise<Response> {
  __installClientForTest(CONNECTION_STRING, makeFakeSqlClient());
  const request = new Request('https://api.test/books', {
    method: 'GET',
    headers,
  });
  const config = makeTestConfig({
    database: {
      ...makeTestConfig().database,
      anonRole: opts.anonRole ?? 'anon',
    },
    auth: { ...makeTestConfig().auth, jwtSecret: 'test-secret' },
  });
  return handleFetch(
    request,
    makeBindings(),
    makeExecutionContext(),
    { config, schema: SCHEMA },
  );
}

afterEach(() => {
  __resetClientsForTest();
  __resetJwtCacheForTest();
  __resetJwksCacheForTest();
  __resetPemCacheForTest();
});

describe('§11.9 — WWW-Authenticate Bearer challenge', () => {
  it('emits `Bearer invalid_token` for a malformed JWT (PGRST301)', async () => {
    const response = await fetchWith({
      Accept: 'application/json',
      Authorization: 'Bearer not-a-jwt',
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate');
    expect(challenge).not.toBeNull();
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('error="invalid_token"');
  });

  it('emits `Bearer insufficient_scope` when anon is disabled and no token is sent (PGRST302)', async () => {
    const response = await fetchWith(
      { Accept: 'application/json' },
      { anonRole: '' },
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate');
    expect(challenge).toContain('error="insufficient_scope"');
  });

  it('does NOT add a challenge header on non-auth errors (e.g. PGRST205)', async () => {
    __installClientForTest(CONNECTION_STRING, makeFakeSqlClient());
    const request = new Request('https://api.test/nonexistent_table', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const response = await handleFetch(
      request,
      makeBindings(),
      makeExecutionContext(),
      { config: makeTestConfig(), schema: SCHEMA },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });
});
