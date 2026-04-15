// Realtime subscription shape.
//
// A subscription is `(schema, table, since?)` — the client tells us
// which table to watch and optionally a starting change-log ID.
// The DO name is derived by `subscriptionDoKey` so two schemas
// with a same-named table land on different Durable Objects (e.g.
// `public.orders` and `analytics.orders` are distinct).

export interface Subscription {
  readonly schema: string;
  readonly table: string;
  /** Last change-log ID the client saw. Null = from now on. */
  readonly since: number | null;
}

/**
 * Canonical key used to look up / name a subscription's Durable
 * Object. The key is stable for a given `(schema, table)` pair and
 * never contains the `since` cursor (per-client state lives inside
 * the DO).
 */
export function subscriptionDoKey(sub: Subscription): string {
  return `rt.${sub.schema}.${sub.table}`;
}

/**
 * Parse a subscription from the realtime upgrade URL. Shape:
 *   /_realtime/<schema>/<table>?since=<N>
 *
 * Returns null when the URL doesn't match the expected shape.
 */
export function parseSubscriptionFromUrl(
  url: URL,
): Subscription | null {
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 3) return null;
  if (segments[0] !== '_realtime') return null;
  const schema = segments[1]!;
  const table = segments[2]!;
  if (schema === '' || table === '') return null;

  const sinceRaw = url.searchParams.get('since');
  let since: number | null = null;
  if (sinceRaw !== null) {
    const n = Number(sinceRaw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) since = n;
    else return null;
  }
  return { schema, table, since };
}
