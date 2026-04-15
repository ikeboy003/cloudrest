// Nested-insert planner tests.
//
// Detects the `POST /orders` with `{ customer: 'x', line_items: [...] }`
// shape, strips the nested key from the parent body, builds a
// `NestedInsertChild`, and leaves the flat parent body for the
// builder.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '@/parser/query-params';
import { planMutation } from '@/planner/plan-mutation';
import type { Payload } from '@/parser/payload';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { makeSchema, makeO2M } from '@tests/fixtures/schema';

const SCHEMA = makeSchema(
  [
    {
      name: 'orders',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'customer', type: 'text' },
        { name: 'total', type: 'numeric' },
      ],
    },
    {
      name: 'line_items',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'order_id', type: 'bigint', nullable: false },
        { name: 'product', type: 'text' },
        { name: 'qty', type: 'int4' },
      ],
    },
  ],
  [
    makeO2M({
      from: 'orders',
      fromColumn: 'id',
      to: 'line_items',
      toColumn: 'order_id',
    }),
  ],
);

function jsonPayload(obj: Record<string, unknown>): Payload {
  return {
    type: 'json',
    raw: JSON.stringify(obj),
    keys: new Set(Object.keys(obj)),
  };
}

function plan(body: Record<string, unknown>) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
  return planMutation({
    target: { schema: 'public', name: 'orders' },
    mutation: 'create',
    parsed,
    payload: jsonPayload(body),
    preferences: { invalidPrefs: [] },
    schema: SCHEMA,
    wrap: 'result',
  });
}

describe('planMutation — nested insert detection', () => {
  it('detects a single child array matching an O2M relation', () => {
    const p = expectOk(
      plan({
        customer: 'Alice',
        total: 100,
        line_items: [
          { product: 'A', qty: 1 },
          { product: 'B', qty: 2 },
        ],
      }),
    );
    expect(p.kind).toBe('insert');
    if (p.kind !== 'insert') throw new Error('unreachable');
    expect(p.nestedInserts).toHaveLength(1);
    const child = p.nestedInserts![0]!;
    expect(child.relation).toBe('line_items');
    expect(child.target.name).toBe('line_items');
    expect(child.parentRefColumn).toBe('id');
    expect(child.childFkColumn).toBe('order_id');
    // Child columns are the body columns minus the FK.
    expect(child.columns.map((c) => c.name)).toEqual(['product', 'qty']);
  });

  it('strips nested keys from the parent body', () => {
    const p = expectOk(
      plan({
        customer: 'Alice',
        line_items: [{ product: 'A', qty: 1 }],
      }),
    );
    if (p.kind !== 'insert') throw new Error('unreachable');
    // Parent body only has `customer` now.
    const parsed = JSON.parse(p.rawBody);
    expect(parsed).toEqual({ customer: 'Alice' });
    // And only `customer` is in the parent INSERT column list.
    expect(p.columns.map((c) => c.name)).toEqual(['customer']);
  });

  it('wraps a single-object child in an array', () => {
    const p = expectOk(
      plan({
        customer: 'Bob',
        line_items: { product: 'single', qty: 5 },
      }),
    );
    if (p.kind !== 'insert') throw new Error('unreachable');
    expect(p.nestedInserts).toHaveLength(1);
    // The child body is always a JSON array so the builder can use
    // jsonb_to_recordset unconditionally.
    const childBody = JSON.parse(p.nestedInserts![0]!.rawBody);
    expect(Array.isArray(childBody)).toBe(true);
    expect(childBody).toHaveLength(1);
  });

  it('leaves unknown-relation object values alone', () => {
    // `foo` is neither a column on orders nor a known relation —
    // the key stays in the flat body so column validation rejects
    // it with PGRST204.
    const r = expectErr(plan({ customer: 'x', foo: { bar: 1 } }));
    expect(r.code).toBe('PGRST204');
  });

  it('rejects unknown child columns with PGRST204', () => {
    const r = expectErr(
      plan({
        customer: 'x',
        line_items: [{ typo_column: 1, product: 'A' }],
      }),
    );
    expect(r.code).toBe('PGRST204');
  });

  it('no nested detection when the parent body is an array', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const payload: Payload = {
      type: 'json',
      raw: JSON.stringify([
        { customer: 'A', line_items: [{ product: 'X' }] },
        { customer: 'B', line_items: [{ product: 'Y' }] },
      ]),
      keys: new Set(['customer', 'line_items']),
    };
    // An array parent with a `line_items` key will hit column
    // validation for `line_items` and fail — we don't do
    // indexed nested inserts.
    const r = expectErr(
      planMutation({
        target: { schema: 'public', name: 'orders' },
        mutation: 'create',
        parsed,
        payload,
        preferences: { invalidPrefs: [] },
        schema: SCHEMA,
        wrap: 'result',
      }),
    );
    expect(r.code).toBe('PGRST204');
  });
});
