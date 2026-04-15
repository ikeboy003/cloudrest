// HMAC signature tests.

import { describe, expect, it } from 'vitest';

import { signWebhook } from '@/webhooks/sign';

describe('signWebhook', () => {
  const INPUT = {
    secret: 'test-secret',
    timestamp: '2026-01-01T00:00:00.000Z',
    table: 'orders',
    mutation: 'create',
    body: '[{"id":1}]',
  };

  it('returns a sha256=<hex>.<timestamp> header', async () => {
    const sig = await signWebhook(INPUT);
    expect(sig.header.startsWith('sha256=')).toBe(true);
    expect(sig.header.endsWith(`.${INPUT.timestamp}`)).toBe(true);
    expect(sig.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await signWebhook(INPUT);
    const b = await signWebhook(INPUT);
    expect(a.hex).toBe(b.hex);
  });

  it('changes when the body changes', async () => {
    const a = await signWebhook(INPUT);
    const b = await signWebhook({ ...INPUT, body: '[{"id":2}]' });
    expect(a.hex).not.toBe(b.hex);
  });

  it('changes when the timestamp changes (replay protection)', async () => {
    const a = await signWebhook(INPUT);
    const b = await signWebhook({
      ...INPUT,
      timestamp: '2026-01-02T00:00:00.000Z',
    });
    expect(a.hex).not.toBe(b.hex);
  });

  it('changes when the table/mutation changes', async () => {
    const a = await signWebhook(INPUT);
    const b = await signWebhook({ ...INPUT, table: 'other' });
    const c = await signWebhook({ ...INPUT, mutation: 'update' });
    expect(a.hex).not.toBe(b.hex);
    expect(a.hex).not.toBe(c.hex);
  });
});
