import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '@/parser/query-params';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

function parse(query: string) {
  return parseQueryParams(new URLSearchParams(query));
}

describe('parseQueryParams — dispatch', () => {
  it('routes select, order, limit, offset', () => {
    const value = expectOk(parse('select=id,name&order=name.asc&limit=10&offset=5'));
    expect(value.select).toHaveLength(2);
    expect(value.order[0]![1]).toHaveLength(1);
    expect(value.ranges.get('limit')).toEqual({ offset: 5, limit: 10 });
  });

  // REGRESSION: the old parser rejected bare lowercase RPC values as
  // "unknown operators" because parseOpExpr ran typo detection on
  // tokens without a `.` separator. The rewrite returns null for
  // no-dot values so they fall through to rpcParams.
  it('collects RPC params for non-filter values', () => {
    const value = expectOk(parse('page=Hello%20World&size=big'));
    expect(value.rpcParams).toContainEqual(['page', 'Hello World']);
    expect(value.rpcParams).toContainEqual(['size', 'big']);
    expect(value.filtersRoot).toHaveLength(0);
  });

  it('parses root filters', () => {
    const value = expectOk(parse('price=gt.10'));
    expect(value.filtersRoot).toHaveLength(1);
    expect(value.filters).toHaveLength(1);
    expect(value.filterFields.has('price')).toBe(true);
  });

  it('parses embedded filters', () => {
    const value = expectOk(parse('posts.comments.id=eq.1'));
    expect(value.filtersNotRoot).toHaveLength(1);
    expect(value.filtersNotRoot[0]![0]).toEqual(['posts', 'comments']);
  });

  // REGRESSION: critique #69 — ?books.limit=2 must be stored under the
  // embed range key so the planner (stage 6) can consume it.
  it('stores embed range params under a \\0-joined key', () => {
    const value = expectOk(parse('books.limit=2&books.offset=4'));
    expect(value.ranges.get('books')).toEqual({ offset: 4, limit: 2 });
  });

  it('parses and=(...) at root', () => {
    const value = expectOk(parse('and=(a.eq.1,b.gt.2)'));
    expect(value.logic).toHaveLength(1);
    expect(value.logic[0]![1].type).toBe('expr');
  });

  // REGRESSION: critique #71 — `?limit=1e2` must be rejected, not
  // silently parsed to 100.
  it('rejects non-canonical integer forms for limit', () => {
    expectErr(parse('limit=1e2'));
    expectErr(parse('offset=1.5'));
  });

  // BUG FIX: the old parser accepted `limit=-5` and stored it in a
  // NonnegRange, violating its own contract. Now rejected at parse
  // time on every range knob (root + embedded).
  it('rejects negative limit/offset (root)', () => {
    const err1 = expectErr(parse('limit=-5'));
    expect(err1.code).toBe('PGRST100');
    const err2 = expectErr(parse('offset=-1'));
    expect(err2.code).toBe('PGRST100');
  });

  it('rejects negative embedded limit/offset', () => {
    const err1 = expectErr(parse('books.limit=-3'));
    expect(err1.code).toBe('PGRST100');
    const err2 = expectErr(parse('books.offset=-1'));
    expect(err2.code).toBe('PGRST100');
  });

  it('parses columns into a Set', () => {
    const value = expectOk(parse('columns=id,name,title'));
    expect(value.columns).toBeInstanceOf(Set);
    expect(value.columns!.has('id')).toBe(true);
    expect(value.columns!.has('title')).toBe(true);
  });

  it('parses on_conflict', () => {
    const value = expectOk(parse('on_conflict=email'));
    expect(value.onConflict).toEqual(['email']);
  });

  it('produces a canonical sorted query string', () => {
    const value = expectOk(parse('b=2&a=1&c=3'));
    expect(value.canonical).toBe('a=1&b=2&c=3');
  });

  it('rejects typo-shaped operators as PGRST100', () => {
    const error = expectErr(parse('price=ltee.5'));
    expect(error.code).toBe('PGRST100');
  });

  it('parses having clauses', () => {
    const value = expectOk(parse('having=count().gt.5'));
    expect(value.having).toHaveLength(1);
  });

  // BUG FIX: the old dispatcher listed `distinct` in the reserved set
  // but never called parseDistinct — the feature was half-wired.
  it('parses ?distinct into ParsedQueryParams.distinct', () => {
    const value = expectOk(parse('distinct=category,vendor'));
    expect(value.distinct).toEqual(['category', 'vendor']);
  });

  it('leaves distinct null when absent', () => {
    const value = expectOk(parse('select=id'));
    expect(value.distinct).toBeNull();
  });
});
