// `parseWebhookBindings` tests.

import { describe, expect, it } from 'vitest';

import { parseWebhookBindings } from '@/webhooks/config';

describe('parseWebhookBindings', () => {
  it('returns empty for undefined / empty input', () => {
    expect(parseWebhookBindings(undefined)).toEqual([]);
    expect(parseWebhookBindings('')).toEqual([]);
  });

  it('parses a single binding', () => {
    const bindings = parseWebhookBindings(
      'orders.create:https://slack.example/hook',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({
      table: 'orders',
      mutation: 'create',
      url: 'https://slack.example/hook',
      allowedColumns: [],
    });
  });

  it('parses multiple bindings separated by commas', () => {
    const bindings = parseWebhookBindings(
      'orders.create:https://a.example/x,orders.update:https://b.example/y',
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.mutation).toBe('create');
    expect(bindings[1]!.mutation).toBe('update');
  });

  it('accepts the wildcard mutation', () => {
    const bindings = parseWebhookBindings(
      'orders.*:https://hook.example/all',
    );
    expect(bindings[0]!.mutation).toBe('*');
  });

  it('drops unknown mutations', () => {
    const bindings = parseWebhookBindings(
      'orders.delete:https://a.example,orders.garbage:https://b.example',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.mutation).toBe('delete');
  });

  it('drops malformed entries without a colon', () => {
    const bindings = parseWebhookBindings('noColon,orders.create:https://x');
    expect(bindings).toHaveLength(1);
  });

  it('parses the column allowlist syntax', () => {
    const bindings = parseWebhookBindings(
      'orders.create[id,total,customer]:https://hook.example',
    );
    expect(bindings[0]!.allowedColumns).toEqual(['id', 'total', 'customer']);
  });

  it('allows URLs that contain a port (first colon is the separator)', () => {
    const bindings = parseWebhookBindings(
      'orders.create:https://hook.example:8443/receive',
    );
    expect(bindings[0]!.url).toBe('https://hook.example:8443/receive');
  });
});
