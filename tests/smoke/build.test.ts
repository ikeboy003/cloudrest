// Smoke test: the Worker entry point exports the `fetch` method
// Cloudflare expects. Real end-to-end behavior is covered by
// `tests/behavior/*` which drives `handleFetch` directly with fake
// bindings — this file only verifies the shape so a refactor of
// `src/index.ts` can't silently break the Worker signature.

import { describe, expect, it } from 'vitest';
import worker from '@/index';

describe('stage 0 scaffold', () => {
  it('exports a default with a fetch handler', () => {
    expect(typeof worker.fetch).toBe('function');
  });
});
