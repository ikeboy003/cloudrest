import { describe, expect, it } from 'vitest';

import type {
  HandlerContext,
  RequestContext,
  WorkerExecutionContext,
} from '../../../src/core/context';
import { testEnv } from '../../fixtures/env';

// These tests are type-level contracts: they ensure HandlerContext can be
// built without needing future stages' concrete types, and that widening
// a context still extends RequestContext.

function makeExecutionContext(): WorkerExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

describe('RequestContext / HandlerContext shape', () => {
  it('RequestContext holds the raw HTTP request and worker context', () => {
    const request = new Request('https://example.com/books?limit=1', {
      method: 'GET',
    });
    const context: RequestContext = {
      originalHttpRequest: request,
      executionContext: makeExecutionContext(),
      bindings: testEnv(),
    };
    expect(context.originalHttpRequest.method).toBe('GET');
    expect(typeof context.executionContext.waitUntil).toBe('function');
  });

  it('HandlerContext extends RequestContext', () => {
    // Cast-through-unknown is legal at Stage 1 only because the downstream
    // fields (config, schema, auth, timer) are placeholders. Stages 2–11
    // will tighten each field, and this test will then be updated to
    // construct them properly.
    const context = {
      originalHttpRequest: new Request('https://example.com/'),
      executionContext: makeExecutionContext(),
      bindings: testEnv(),
      config: undefined,
      schema: undefined,
      auth: undefined,
      timer: undefined,
    } as unknown as HandlerContext;
    expect(context.originalHttpRequest).toBeInstanceOf(Request);
  });
});
