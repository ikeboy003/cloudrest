// Stage 9 — mutation planner tests.
//
// Closes critique #74 (missing=default excludes defaulted columns
// from the INSERT column list) and pins on_conflict validation.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '../../../src/parser/query-params';
import { planMutation } from '../../../src/planner/plan-mutation';
import type { Payload } from '../../../src/parser/payload';
import { expectErr, expectOk } from '../../fixtures/assert-result';
import { makeSchema } from '../../fixtures/schema';

const SCHEMA = makeSchema([
  {
    name: 'books',
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'title', type: 'text' },
      { name: 'author_id', type: 'bigint' },
      { name: 'price', type: 'numeric' },
      { name: 'category', type: 'text' },
    ],
  },
]);

// Mark `id` as generated+defaulted at the fixture level so the #74
// tests cover the real case.
(() => {
  const t = SCHEMA.tables.get('public\u0000books')!;
  const id = t.columns.get('id')!;
  (id as { defaultValue: string | null }).defaultValue = 'nextval(...)';
  (id as { generated: boolean }).generated = false;
  const title = t.columns.get('title')!;
  (title as { defaultValue: string | null }).defaultValue = null;
})();

function jsonPayload(obj: Record<string, unknown>): Payload {
  const raw = JSON.stringify(obj);
  return {
    type: 'json',
    raw,
    keys: new Set(Object.keys(obj)),
  };
}

describe('planMutation — INSERT column selection (#74)', () => {
  it('default: emits only the columns the client sent', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: jsonPayload({ title: 'Hello', author_id: 1 }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(plan.kind).toBe('insert');
    if (plan.kind !== 'insert') throw new Error('unreachable');
    expect(plan.columns.map((c) => c.name)).toEqual(['title', 'author_id']);
    // `id` is defaulted and not in the payload — must NOT be in the
    // INSERT column list.
    expect(plan.columns.map((c) => c.name)).not.toContain('id');
  });

  it('missing=null: emits every non-generated column', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: jsonPayload({ title: 'Hello' }),
        preferences: { invalidPrefs: [], preferMissing: 'null' },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    if (plan.kind !== 'insert') throw new Error('unreachable');
    // Every column in the fixture is non-generated, so all five
    // appear.
    expect(plan.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'title', 'author_id', 'price', 'category']),
    );
  });

  it('rejects an unknown column in the payload', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: jsonPayload({ typo_column: 1 }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });
});

describe('planMutation — on_conflict validation', () => {
  it('defaults singleUpsert to the primary key', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'singleUpsert',
        parsed,
        payload: jsonPayload({ id: 1, title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    if (plan.kind !== 'insert') throw new Error('unreachable');
    expect(plan.onConflict).not.toBeNull();
    expect(plan.onConflict!.columns).toEqual(['id']);
    expect(plan.onConflict!.resolution).toBe('mergeDuplicates');
  });

  it('rejects an unknown on_conflict column', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('on_conflict=nope')),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });
});

describe('planMutation — UPDATE / DELETE column validation', () => {
  it('UPDATE rejects a filter on an unknown column', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('typo=eq.1')),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });

  it('DELETE requires no payload', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('id=eq.1')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'delete',
        parsed,
        payload: null,
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(plan.kind).toBe('delete');
    if (plan.kind !== 'delete') throw new Error('unreachable');
    expect(plan.filters).toHaveLength(1);
  });
});

describe('planMutation — embedded filters are refused (#bug1)', () => {
  // A request with ONLY an embedded filter used to plan with no
  // WHERE clause — a table-wide UPDATE/DELETE. Refuse at plan time.

  it('UPDATE rejects an embedded filter', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('authors.name=eq.Bob')),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST100');
    expect(r.message).toContain('authors.name');
  });

  it('DELETE rejects an embedded filter', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('authors.name=eq.Bob')),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'delete',
        parsed,
        payload: null,
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST100');
  });

  it('UPDATE rejects an embedded logic tree', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('authors.and=(name.eq.Bob)')),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST100');
  });

  it('UPDATE still accepts a root filter alongside an embedded ban', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('id=eq.1')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(plan.kind).toBe('update');
  });
});

describe('planMutation — root logic-tree column validation (#bug6)', () => {
  // Previously typos inside a logic tree slipped past the planner
  // and surfaced as opaque database errors.

  it('UPDATE rejects a typo inside a root OR tree', () => {
    const parsed = expectOk(
      parseQueryParams(
        new URLSearchParams('or=(does_not_exist.eq.1,id.eq.1)'),
      ),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });

  it('DELETE rejects a typo inside a nested AND tree', () => {
    const parsed = expectOk(
      parseQueryParams(
        new URLSearchParams('and=(id.eq.1,or(typo.eq.2,id.eq.3))'),
      ),
    );
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'delete',
        parsed,
        payload: null,
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });

  it('UPDATE accepts a well-formed root OR tree', () => {
    const parsed = expectOk(
      parseQueryParams(new URLSearchParams('or=(id.eq.1,title.eq.Hi)')),
    );
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'update',
        parsed,
        payload: jsonPayload({ title: 'X' }),
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(plan.kind).toBe('update');
  });
});

describe('planMutation — empty JSON array inserts zero rows (#bug5)', () => {
  // `POST /books` with body `[]` used to become `INSERT ... DEFAULT
  // VALUES` — one row where the user asked for zero. Must instead
  // fall through to the builder's `WHERE false` no-op.

  it('empty array body does NOT set defaultValues', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: { type: 'json', raw: '[]', keys: new Set() },
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    if (plan.kind !== 'insert') throw new Error('unreachable');
    expect(plan.defaultValues).toBe(false);
    expect(plan.isArrayBody).toBe(true);
    expect(plan.columns).toHaveLength(0);
  });

  it('empty object body still uses DEFAULT VALUES (POST with no body shape)', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const plan = expectOk(
      planMutation({
        target: { schema: 'public', name: 'books' },
        mutation: 'create',
        parsed,
        payload: null,
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    if (plan.kind !== 'insert') throw new Error('unreachable');
    expect(plan.defaultValues).toBe(true);
    expect(plan.isArrayBody).toBe(false);
  });
});
