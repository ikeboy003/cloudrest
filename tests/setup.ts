// Vitest global setup — makes the Workers-runtime globals that the
// source code assumes available inside the Node-based test runner.
//
// RUNTIME: Node 19+ exposes `crypto` as a global; Node 18 does not.
// The CI matrix runs on 18 / 20 / 22 so the test code cannot just
// assume `globalThis.crypto` is present. We install the Web Crypto
// implementation from `node:crypto` onto `globalThis.crypto` when
// it is missing. Node 20+ is a no-op.
//
// INVARIANT: this file is loaded by vitest ONCE per worker before
// any test module imports. It must not import from `@/` or
// `@tests/` — setup runs outside the path-alias graph and any
// breakage here cascades to every test run.

import { webcrypto } from 'node:crypto';

if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
