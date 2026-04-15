// PostGIS planner tests.
//
// Three concerns under test:
//   1. `geo.nearby` filters get lifted into `OrderTerm` entries with
//      `geoDistance` set, and removed from the filter list.
//   2. `geo.dwithin` / `geo.within` / `geo.intersects` filters
//      survive validation and stay on the plan.
//   3. The planner rejects geo operators on non-spatial columns at
//      plan time so the user sees PGRST100 instead of an obscure
//      `ST_DWithin(integer, ...)` error from Postgres.
//
// The fixture builds a `places` table with both a `geometry` and a
// `geography` column so the geoKinds map and the projection wrap
// path can be exercised here too.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '@/parser/query-params';
import { planRead } from '@/planner/plan-read';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { makeSchema } from '@tests/fixtures/schema';

const PLACES_SCHEMA = makeSchema([
  {
    name: 'places',
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      { name: 'name', type: 'text' },
      // Both bare and typmod-qualified type spellings are realistic
      // outputs from `format_type` on a real PostGIS column.
      { name: 'location', type: 'geometry(Point,4326)', geoKind: 'geometry' },
      { name: 'boundary', type: 'geography(Polygon,4326)', geoKind: 'geography' },
    ],
  },
]);

function plan(query: string) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(query)));
  return planRead({
    target: { schema: 'public', name: 'places' },
    parsed,
    preferences: { invalidPrefs: [] },
    schema: PLACES_SCHEMA,
    mediaType: 'json',
    topLevelRange: { offset: 0, limit: null },
    hasPreRequest: false,
    maxRows: null,
  });
}

describe('planRead — geo.nearby lifting', () => {
  it('moves a geo.nearby filter onto the order list and clears it from filters', () => {
    const r = expectOk(plan('location=geo.nearby(40.7,-74.0)'));
    expect(r.filters).toHaveLength(0);
    expect(r.order).toHaveLength(1);
    const term = r.order[0]!;
    expect(term.field.name).toBe('location');
    expect(term.geoDistance).toEqual({ lat: 40.7, lng: -74.0 });
    expect(term.direction).toBe('asc');
  });

  it('places nearby ordering BEFORE explicit user order so it is the primary sort', () => {
    const r = expectOk(plan('location=geo.nearby(40.7,-74.0)&order=name.asc'));
    expect(r.order).toHaveLength(2);
    expect(r.order[0]!.geoDistance).toBeDefined();
    expect(r.order[0]!.field.name).toBe('location');
    expect(r.order[1]!.geoDistance).toBeUndefined();
    expect(r.order[1]!.field.name).toBe('name');
  });

  it('rejects geo.nearby on a non-spatial column at plan time', () => {
    const r = expectErr(plan('name=geo.nearby(40.7,-74.0)'));
    expect(r.code).toBe('PGRST100');
    expect(r.details).toContain('not a geometry or geography column');
  });

  // A negated nearby has no meaningful geographic interpretation —
  // "not the closest" is undefined. The planner rejects it at plan
  // time so the user sees a clear PGRST100 instead of an opaque
  // builder defensive error or, worse, a silent pass.
  it('rejects a negated geo.nearby with PGRST100', () => {
    const r = expectErr(plan('location=not.geo.nearby(40.7,-74.0)'));
    expect(r.code).toBe('PGRST100');
    expect(r.details).toContain('geo.nearby cannot be negated');
  });
});

describe('planRead — geo filter validation', () => {
  it('accepts geo.dwithin on a geometry column', () => {
    const r = expectOk(plan('location=geo.dwithin(40.7,-74.0,500)'));
    expect(r.filters).toHaveLength(1);
    const op = r.filters[0]!.opExpr.operation;
    expect(op.type).toBe('geo');
    if (op.type === 'geo') {
      expect(op.operator).toBe('dwithin');
      expect(op.distance).toBe(500);
    }
  });

  it('accepts geo.within on a geography column with a GeoJSON arg', () => {
    const json =
      '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}';
    const r = expectOk(plan(`boundary=geo.within(${json})`));
    expect(r.filters).toHaveLength(1);
  });

  it('rejects geo.dwithin on a non-spatial column', () => {
    const r = expectErr(plan('id=geo.dwithin(40.7,-74.0,500)'));
    expect(r.code).toBe('PGRST100');
    expect(r.details).toContain('geo.dwithin requires a PostGIS spatial column');
  });

  it('rejects geo.intersects on a non-spatial column', () => {
    const r = expectErr(plan('name=geo.intersects(POINT(0 0))'));
    expect(r.code).toBe('PGRST100');
  });
});

describe('planRead — geoKinds map', () => {
  it('populates geoKinds for tables with spatial columns', () => {
    const r = expectOk(plan(''));
    expect(r.geoKinds).not.toBeNull();
    expect(r.geoKinds!.get('location')).toBe('geometry');
    expect(r.geoKinds!.get('boundary')).toBe('geography');
    // Non-spatial columns are absent.
    expect(r.geoKinds!.get('id')).toBeUndefined();
    expect(r.geoKinds!.get('name')).toBeUndefined();
  });
});
