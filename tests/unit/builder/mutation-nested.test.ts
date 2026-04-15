// Nested-insert builder tests.
//
// The builder emits one `pgrst_child_N` CTE per entry, keyed off
// the parent's returned PK row.

import { describe, expect, it } from 'vitest';

import { buildMutationQuery } from '@/builder/mutation';
import type {
  InsertPlan,
  NestedInsertChild,
} from '@/planner/mutation-plan';
import { expectOk } from '@tests/fixtures/assert-result';

const ORDERS = { schema: 'public', name: 'orders' };
const LINE_ITEMS = { schema: 'public', name: 'line_items' };

function child(overrides: Partial<NestedInsertChild> = {}): NestedInsertChild {
  return {
    relation: 'line_items',
    target: LINE_ITEMS,
    columns: [
      { name: 'product', type: 'text', hasDefault: false, generated: false },
      { name: 'qty', type: 'int4', hasDefault: false, generated: false },
    ],
    rawBody: '[{"product":"A","qty":1},{"product":"B","qty":2}]',
    parentRefColumn: 'id',
    childFkColumn: 'order_id',
    ...overrides,
  };
}

function insertPlan(
  nestedInserts: readonly NestedInsertChild[] = [],
): InsertPlan {
  return {
    kind: 'insert',
    target: ORDERS,
    rawBody: '{"customer":"Alice"}',
    isArrayBody: false,
    columns: [
      {
        name: 'customer',
        type: 'text',
        hasDefault: false,
        generated: false,
      },
    ],
    defaultValues: false,
    onConflict: null,
    primaryKeyColumns: ['id'],
    returnPreference: 'full',
    wrap: 'result',
    nestedInserts,
    graphReturnEmbeds: [],
  };
}

describe('buildMutationQuery — nested insert', () => {
  it('emits no child CTE when nestedInserts is empty', () => {
    const built = expectOk(buildMutationQuery(insertPlan()));
    expect(built.sql).not.toContain('pgrst_child_');
  });

  it('emits a pgrst_child_0 CTE for a single nested relation', () => {
    const built = expectOk(buildMutationQuery(insertPlan([child()])));
    expect(built.sql).toContain('pgrst_child_0 AS (');
    expect(built.sql).toContain('INSERT INTO "public"."line_items"');
  });

  it('includes the parent FK column first in the child INSERT column list', () => {
    const built = expectOk(buildMutationQuery(insertPlan([child()])));
    expect(built.sql).toContain(
      '("order_id", "product", "qty")',
    );
  });

  it('reads the FK value from pgrst_source.<parentRefColumn>', () => {
    const built = expectOk(buildMutationQuery(insertPlan([child()])));
    expect(built.sql).toContain('pgrst_source."id"');
  });

  it('joins against jsonb_to_recordset of the child body', () => {
    const built = expectOk(buildMutationQuery(insertPlan([child()])));
    expect(built.sql).toContain(
      'FROM pgrst_source, jsonb_to_recordset(',
    );
    expect(built.sql).toContain('AS c("product" text, "qty" int4)');
  });

  it('the child body JSON is inlined as a jsonb literal', () => {
    const built = expectOk(buildMutationQuery(insertPlan([child()])));
    expect(built.sql).toContain(
      `'[{"product":"A","qty":1},{"product":"B","qty":2}]'::jsonb`,
    );
  });

  it('emits multiple pgrst_child_N CTEs when multiple children are present', () => {
    const second: NestedInsertChild = {
      ...child(),
      relation: 'shipments',
      target: { schema: 'public', name: 'shipments' },
      columns: [
        {
          name: 'carrier',
          type: 'text',
          hasDefault: false,
          generated: false,
        },
      ],
      rawBody: '[{"carrier":"ups"}]',
      childFkColumn: 'order_id',
    };
    const built = expectOk(
      buildMutationQuery(insertPlan([child(), second])),
    );
    expect(built.sql).toContain('pgrst_child_0 AS (');
    expect(built.sql).toContain('pgrst_child_1 AS (');
    expect(built.sql).toContain('INSERT INTO "public"."line_items"');
    expect(built.sql).toContain('INSERT INTO "public"."shipments"');
  });

  it('falls back to FK-only SELECT when the child has no other columns', () => {
    const built = expectOk(
      buildMutationQuery(
        insertPlan([
          child({
            columns: [],
            rawBody: '[{}]',
          }),
        ]),
      ),
    );
    expect(built.sql).toContain(
      'INSERT INTO "public"."line_items" ("order_id")',
    );
    expect(built.sql).toContain('FROM pgrst_source');
  });
});
