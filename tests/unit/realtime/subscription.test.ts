// Subscription parsing + DO key tests.

import { describe, expect, it } from 'vitest';

import {
  parseSubscriptionFromUrl,
  subscriptionDoKey,
} from '@/realtime/subscription';

describe('parseSubscriptionFromUrl', () => {
  it('parses /_realtime/<schema>/<table>', () => {
    const url = new URL('https://api.test/_realtime/public/books');
    const sub = parseSubscriptionFromUrl(url);
    expect(sub).toEqual({
      schema: 'public',
      table: 'books',
      since: null,
    });
  });

  it('parses the since cursor', () => {
    const url = new URL('https://api.test/_realtime/public/books?since=42');
    const sub = parseSubscriptionFromUrl(url);
    expect(sub!.since).toBe(42);
  });

  it('rejects a since cursor that is not a non-negative integer', () => {
    expect(
      parseSubscriptionFromUrl(
        new URL('https://api.test/_realtime/public/books?since=-1'),
      ),
    ).toBeNull();
    expect(
      parseSubscriptionFromUrl(
        new URL('https://api.test/_realtime/public/books?since=abc'),
      ),
    ).toBeNull();
  });

  it('rejects the wrong path shape', () => {
    expect(
      parseSubscriptionFromUrl(new URL('https://api.test/_realtime/')),
    ).toBeNull();
    expect(
      parseSubscriptionFromUrl(
        new URL('https://api.test/_realtime/public'),
      ),
    ).toBeNull();
    expect(
      parseSubscriptionFromUrl(
        new URL('https://api.test/_realtime/public/books/extra'),
      ),
    ).toBeNull();
  });
});

describe('subscriptionDoKey', () => {
  it('includes schema and table so cross-schema tables do not collide', () => {
    const a = subscriptionDoKey({
      schema: 'public',
      table: 'orders',
      since: null,
    });
    const b = subscriptionDoKey({
      schema: 'analytics',
      table: 'orders',
      since: null,
    });
    expect(a).not.toBe(b);
  });

  it('does not vary with the since cursor', () => {
    const a = subscriptionDoKey({
      schema: 'public',
      table: 'orders',
      since: null,
    });
    const b = subscriptionDoKey({
      schema: 'public',
      table: 'orders',
      since: 42,
    });
    expect(a).toBe(b);
  });
});
