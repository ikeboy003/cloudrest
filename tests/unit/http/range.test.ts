import { describe, expect, it } from 'vitest';

import { parseRange, rangeStatusHeader } from '../../../src/http/range';

function headersOf(range?: string): Headers {
  const h = new Headers();
  if (range !== undefined) h.set('range', range);
  return h;
}

describe('parseRange — basic', () => {
  it('returns ALL_ROWS when no Range header is present', () => {
    const r = parseRange({ method: 'GET', headers: headersOf() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ offset: 0, limit: null });
  });

  it('parses 0-24 as offset 0 limit 25', () => {
    const r = parseRange({ method: 'GET', headers: headersOf('0-24') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ offset: 0, limit: 25 });
  });

  it('parses 5- as offset 5, open end', () => {
    const r = parseRange({ method: 'GET', headers: headersOf('5-') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ offset: 5, limit: null });
  });

  it('rejects malformed Range', () => {
    const r = parseRange({ method: 'GET', headers: headersOf('bananas') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST103');
  });

  it('rejects descending Range 10-5', () => {
    const r = parseRange({ method: 'GET', headers: headersOf('10-5') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST103');
  });

  it('rejects a Range header on non-GET/HEAD methods', () => {
    // BUG FIX (#GG13): the old behavior silently ignored a Range
    // header on POST/PUT/PATCH/DELETE, so a client sending
    // `Range: 0-24` on a PUT got the full mutation applied
    // instead of the PGRST114 "limit not allowed for PUT" it
    // would have gotten via `?limit=`. The parser now rejects
    // any Range header on write methods up front.
    const r = parseRange({ method: 'POST', headers: headersOf('0-24') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST114');
  });

  it('also rejects a Range header on PUT directly', () => {
    const r = parseRange({ method: 'PUT', headers: headersOf('0-24') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST114');
  });

  it('rejects PUT with a range override', () => {
    const r = parseRange({
      method: 'PUT',
      headers: new Headers(),
      limitOverride: { offset: 0, limit: 5 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST114');
  });
});

describe('rangeStatusHeader', () => {
  it('200 + Content-Range when the full result is returned from offset 0', () => {
    const status = rangeStatusHeader({ offset: 0, limit: null }, 10, 10);
    expect(status.status).toBe(200);
    expect(status.contentRange).toBe('0-9/10');
  });

  it('206 when the slice is a proper subset of a known total', () => {
    const status = rangeStatusHeader({ offset: 0, limit: 5 }, 5, 20);
    expect(status.status).toBe(206);
    expect(status.contentRange).toBe('0-4/20');
  });

  it('200 with */* content-range when the total is unknown', () => {
    const status = rangeStatusHeader({ offset: 0, limit: null }, 5, null);
    expect(status.status).toBe(200);
    expect(status.contentRange).toBe('0-4/*');
  });

  it('416 when offset exceeds known total', () => {
    const status = rangeStatusHeader({ offset: 100, limit: null }, 0, 20);
    expect(status.status).toBe(416);
  });

  it('200 with empty result when offset equals total', () => {
    const status = rangeStatusHeader({ offset: 20, limit: null }, 0, 20);
    expect(status.status).toBe(200);
  });

  // REGRESSION: critique #73 — pg_class.reltuples = -1 used to propagate
  // as Content-Range: */-1 and trip 416. Must clamp to null.
  it('clamps negative table totals to null', () => {
    const status = rangeStatusHeader({ offset: 0, limit: null }, 5, -1);
    expect(status.status).toBe(200);
    expect(status.contentRange).toBe('0-4/*');
  });

  it('clamps negative total on empty results too', () => {
    const status = rangeStatusHeader({ offset: 0, limit: null }, 0, -1);
    expect(status.status).toBe(200);
    expect(status.contentRange).toBe('*/*');
  });
});
