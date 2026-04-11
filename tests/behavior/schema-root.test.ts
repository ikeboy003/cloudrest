// Stage 10 — end-to-end GET / (OpenAPI root) behavior.

import { afterEach, describe, expect, it } from 'vitest';

import { handleFetch } from '../../src/router/fetch';
import {
  __installClientForTest,
  __resetClientsForTest,
} from '../../src/executor/client';
import { buildSchemaCacheFromTables } from '../../src/schema/introspect';
import { makeTable } from '../fixtures/schema';
import { makeTestConfig } from '../fixtures/config';
import { makeFakeSqlClient } from '../fixtures/fake-sql';
import { attachRoutines, makeRoutine } from '../fixtures/routines';
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

const SCHEMA = attachRoutines(
  buildSchemaCacheFromTables([
    makeTable({
      name: 'books',
      primaryKey: ['id'],
      columns: [{ name: 'id', type: 'bigint', nullable: false }],
    }),
    makeTable({
      name: 'authors',
      primaryKey: ['id'],
      columns: [{ name: 'id', type: 'bigint', nullable: false }],
    }),
  ]),
  [
    makeRoutine({
      name: 'ping',
      params: [],
      returnType: 'scalar-text',
    }),
  ],
);

afterEach(() => {
  __resetClientsForTest();
});

describe('GET / — OpenAPI schema root', () => {
  it('returns 200 with an OpenAPI document', async () => {
    __installClientForTest(CONNECTION_STRING, makeFakeSqlClient());
    const request = new Request('https://api.test/', {
      method: 'GET',
      headers: { Accept: 'application/openapi+json' },
    });
    const response = await handleFetch(
      request,
      makeBindings(),
      makeExecutionContext(),
      { config: makeTestConfig(), schema: SCHEMA },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(
      'application/openapi+json',
    );
    const json = (await response.json()) as Record<string, unknown>;
    expect(json['openapi']).toBe('3.0.0');
    const paths = json['paths'] as Record<string, unknown>;
    expect(paths['/books']).toBeDefined();
    expect(paths['/authors']).toBeDefined();
    expect(paths['/rpc/ping']).toBeDefined();
  });
});
