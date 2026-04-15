// `dispatchWebhook` tests.
//
// Stubs the global `fetch` so we can inspect every request the
// dispatcher issues, including the header shape, body filtering,
// retry behavior, and SSRF refusal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchWebhook } from '@/webhooks/dispatch';
import type { WebhookBinding } from '@/webhooks/config';

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: RecordedCall[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () =>
  new Response('', { status: 200 });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((url: string | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.url;
    calls.push({ url: urlStr, init: init ?? {} });
    return fetchImpl(urlStr, init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  fetchImpl = async () => new Response('', { status: 200 });
});

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    pending,
  };
}

const BINDING: WebhookBinding = {
  table: 'orders',
  mutation: 'create',
  url: 'https://hook.example.com/receive',
  allowedColumns: [],
};

describe('dispatchWebhook — happy path', () => {
  it('POSTs to the binding URL with the canonical headers', async () => {
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: BINDING,
        table: 'orders',
        mutation: 'create',
        body: '[{"id":1}]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-CloudREST-Table']).toBe('orders');
    expect(headers['X-CloudREST-Mutation']).toBe('create');
    expect(headers['X-CloudREST-Idempotency-Key']).toBe('evt-1');
    expect(headers['X-CloudREST-Attempt']).toBe('1');
    expect(headers['X-CloudREST-Timestamp']).toBeDefined();
    expect((calls[0]!.init as { redirect?: string }).redirect).toBe('manual');
  });

  it('includes an X-CloudREST-Signature header when a secret is set', async () => {
    const ctx = makeCtx();
    await dispatchWebhook(
      {
        binding: BINDING,
        table: 'orders',
        mutation: 'create',
        body: '[{"id":1}]',
        secret: 'test-secret',
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-CloudREST-Signature']).toMatch(/^sha256=[0-9a-f]{64}\./);
  });
});

describe('dispatchWebhook — SSRF refusal', () => {
  it('refuses a loopback URL without any network I/O', async () => {
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: { ...BINDING, url: 'https://127.0.0.1/hook' },
        table: 'orders',
        mutation: 'create',
        body: '[]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('ssrf:loopback');
    expect(calls).toHaveLength(0);
  });

  it('refuses a private-network URL', async () => {
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: { ...BINDING, url: 'https://10.0.0.1/hook' },
        table: 'orders',
        mutation: 'create',
        body: '[]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('ssrf:private-network');
  });
});

describe('dispatchWebhook — column allowlist', () => {
  it('drops unknown columns from every row', async () => {
    const ctx = makeCtx();
    await dispatchWebhook(
      {
        binding: { ...BINDING, allowedColumns: ['id'] },
        table: 'orders',
        mutation: 'create',
        body: '[{"id":1,"secret":"pii"},{"id":2,"secret":"pii"}]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    const sentBody = calls[0]!.init.body as string;
    expect(sentBody).toContain('"id"');
    expect(sentBody).not.toContain('"secret"');
  });
});

describe('dispatchWebhook — retries', () => {
  it('schedules retries under ctx.waitUntil on a 5xx', async () => {
    fetchImpl = async () => new Response('err', { status: 503 });
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: BINDING,
        table: 'orders',
        mutation: 'create',
        body: '[]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('status-503');
    expect(ctx.pending).toHaveLength(1);
  });

  it('does NOT retry on a 4xx (other than 429)', async () => {
    fetchImpl = async () => new Response('nope', { status: 400 });
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: BINDING,
        table: 'orders',
        mutation: 'create',
        body: '[]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(ctx.pending).toHaveLength(0);
  });

  it('schedules retries on a network error', async () => {
    fetchImpl = async () => {
      throw new Error('econnrefused');
    };
    const ctx = makeCtx();
    const result = await dispatchWebhook(
      {
        binding: BINDING,
        table: 'orders',
        mutation: 'create',
        body: '[]',
        secret: null,
        idempotencyKey: 'evt-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('network-error');
    expect(ctx.pending).toHaveLength(1);
  });
});
