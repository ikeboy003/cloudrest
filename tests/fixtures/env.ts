// Shared env fixture for tests.
//
// Construct a typed `Env` for test code without repeating the Cloudflare
// binding stubs in every test file. Override any field with the `overrides`
// parameter.

import type { Env } from '../../src/config/env';

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
    SCHEMA_CACHE: {} as KVNamespace,
    SCHEMA_COORDINATOR: {} as DurableObjectNamespace,
    ...overrides,
  };
}
