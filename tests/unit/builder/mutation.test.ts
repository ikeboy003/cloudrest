// Stage 9 — mutation builder tests.
//
// Pins the critique-closing invariants:
//   #8 / READABILITY §8: ONE builder, driven by `plan.wrap`.
//   #76: `RETURNING` is schema-qualified (`"public"."books".*`).
//   CONSTITUTION §1.3: the JSON body is bound via $1::json, not
//     inlined via pgFmtLit.

import { describe, expect, it } from 'vitest';

import { buildMutationQuery } from '../../../src/builder/mutation';
import type {
  DeletePlan,
  InsertPlan,
  UpdatePlan,
} from '../../../src/planner/mutation-plan';
import { expectOk } from '../../fixtures/assert-result';

const BOOKS = { schema: 'public', name: 'books' };

function insertPlan(overrides: Partial<InsertPlan> = {}): InsertPlan {
  return {
    kind: 'insert',
    target: BOOKS,
    rawBody: '{"title":"Hello"}',
    isArrayBody: false,
    columns: [{ name: 'title', type: 'text', hasDefault: false, generated: false }],
    defaultValues: false,
    onConflict: null,
    primaryKeyColumns: ['id'],
    returnPreference: 'full',
    wrap: 'result',
    ...overrides,
  };
}

function updatePlan(overrides: Partial<UpdatePlan> = {}): UpdatePlan {
  return {
    kind: 'update',
    target: BOOKS,
    rawBody: '{"title":"Hello"}',
    columns: [{ name: 'title', type: 'text', hasDefault: false, generated: false }],
    filters: [],
    logic: [],
    returnPreference: 'full',
    wrap: 'result',
    ...overrides,
  };
}

function deletePlan(overrides: Partial<DeletePlan> = {}): DeletePlan {
  return {
    kind: 'delete',
    target: BOOKS,
    filters: [],
    logic: [],
    returnPreference: 'full',
    wrap: 'result',
    ...overrides,
  };
}

// ----- INSERT ----------------------------------------------------------

describe('buildMutationQuery — INSERT', () => {
  it('emits a CTE wrapped with the standard result envelope', () => {
    const built = expectOk(buildMutationQuery(insertPlan()));
    expect(built.sql).toContain('WITH pgrst_source AS (INSERT INTO "public"."books"');
    expect(built.sql).toContain('json_to_record($1::json)');
    expect(built.sql).toContain('RETURNING "public"."books".*');
    expect(built.sql).toContain('coalesce(json_agg(pgrst_source)');
  });

  it('binds the body via $1 — no pgFmtLit inlining (CONSTITUTION §1.3)', () => {
    const built = expectOk(buildMutationQuery(insertPlan()));
    expect(built.params).toEqual(['{"title":"Hello"}']);
    expect(built.sql).not.toContain("E'");
    expect(built.sql).not.toContain("'{\"title\"");
  });

  it('uses json_to_recordset for an array body (no LIMIT 1 on the json source)', () => {
    const built = expectOk(
      buildMutationQuery(
        insertPlan({
          rawBody: '[{"title":"A"},{"title":"B"}]',
          isArrayBody: true,
        }),
      ),
    );
    expect(built.sql).toContain('json_to_recordset($1::json)');
    // The array form has no `LIMIT 1` suffix on the json_to_recordset
    // call. The Location-header subquery uses `LIMIT 1` for its own
    // reason (fetching one row to render the header), so we target
    // the `AS _(...)` alias shape specifically.
    expect(built.sql).not.toMatch(/AS _\([^)]*\) LIMIT 1/);
  });

  it('falls back to DEFAULT VALUES when the payload is empty and columns is empty', () => {
    const built = expectOk(
      buildMutationQuery(
        insertPlan({ columns: [], defaultValues: true, rawBody: '{}' }),
      ),
    );
    expect(built.sql).toContain('INSERT INTO "public"."books" DEFAULT VALUES');
    expect(built.params).toEqual([]);
  });

  it('emits ON CONFLICT DO UPDATE when mergeDuplicates is set', () => {
    const built = expectOk(
      buildMutationQuery(
        insertPlan({
          columns: [
            { name: 'id', type: 'bigint', hasDefault: false, generated: false },
            { name: 'title', type: 'text', hasDefault: false, generated: false },
          ],
          onConflict: { resolution: 'mergeDuplicates', columns: ['id'] },
          rawBody: '{"id":1,"title":"X"}',
        }),
      ),
    );
    expect(built.sql).toContain('ON CONFLICT("id") DO UPDATE SET');
    expect(built.sql).toContain('"title" = EXCLUDED."title"');
    // The conflict column itself is excluded from the SET list.
    expect(built.sql).not.toContain('"id" = EXCLUDED."id"');
  });

  it('emits ON CONFLICT DO NOTHING when ignoreDuplicates is set', () => {
    const built = expectOk(
      buildMutationQuery(
        insertPlan({
          onConflict: { resolution: 'ignoreDuplicates', columns: ['id'] },
        }),
      ),
    );
    expect(built.sql).toContain('ON CONFLICT("id") DO NOTHING');
  });

  it('wrap=cteOnly returns just the CTE (READABILITY §8)', () => {
    const built = expectOk(
      buildMutationQuery(insertPlan({ wrap: 'cteOnly' })),
    );
    expect(built.sql).toContain('WITH pgrst_source AS (');
    // No outer SELECT wrapper.
    expect(built.sql).not.toContain('coalesce(json_agg(');
    expect(built.sql).not.toContain('total_result_set');
  });
});

// ----- UPDATE ----------------------------------------------------------

describe('buildMutationQuery — UPDATE', () => {
  it('emits schema-qualified RETURNING (#76 — no duplicate columns)', () => {
    const built = expectOk(buildMutationQuery(updatePlan()));
    expect(built.sql).toContain('RETURNING "public"."books".*');
    // NO bare `RETURNING *` in the main CTE body.
    expect(built.sql).not.toMatch(/RETURNING \*\)/);
  });

  it('joins against json_to_record with a typed column list', () => {
    const built = expectOk(buildMutationQuery(updatePlan()));
    expect(built.sql).toContain('FROM json_to_record($1::json) AS pgrst_body');
    expect(built.sql).toContain('"title" = pgrst_body."title"');
  });

  it('returns an empty-select shape when no columns are updatable', () => {
    const built = expectOk(
      buildMutationQuery(updatePlan({ columns: [] })),
    );
    expect(built.sql).toContain(
      'WITH pgrst_source AS (SELECT * FROM "public"."books" WHERE false)',
    );
    expect(built.params).toEqual([]);
  });
});

// ----- DELETE ----------------------------------------------------------

describe('buildMutationQuery — DELETE', () => {
  it('emits DELETE FROM with a RETURNING clause', () => {
    const built = expectOk(buildMutationQuery(deletePlan()));
    expect(built.sql).toContain(
      'DELETE FROM "public"."books" RETURNING "public"."books".*',
    );
  });

  it('wrap=cteOnly returns just the CTE', () => {
    const built = expectOk(
      buildMutationQuery(deletePlan({ wrap: 'cteOnly' })),
    );
    expect(built.sql).toContain('WITH pgrst_source AS (DELETE FROM');
    expect(built.sql).not.toContain('total_result_set');
  });
});
