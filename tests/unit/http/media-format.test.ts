import { describe, expect, it } from 'vitest';

import { formatBody } from '../../../src/http/media/format';

describe('formatBody — JSON passthrough', () => {
  it('returns raw for json', () => {
    const raw = '[{"id":1,"name":"foo"}]';
    expect(formatBody('json', raw)).toBe(raw);
    expect(formatBody('any', raw)).toBe(raw);
    expect(formatBody('array', raw)).toBe(raw);
  });
});

describe('formatBody — singular', () => {
  it('returns the first row unwrapped', () => {
    const raw = '[{"id":1},{"id":2}]';
    expect(formatBody('singular', raw)).toBe('{"id":1}');
  });

  it('returns null for empty array', () => {
    expect(formatBody('singular', '[]')).toBe('null');
  });

  it('passes through non-array input', () => {
    expect(formatBody('singular', '"already a scalar"')).toBe('"already a scalar"');
  });
});

describe('formatBody — stripped nulls', () => {
  it('removes null properties from array rows', () => {
    const raw = '[{"id":1,"name":null},{"id":2,"name":"bar"}]';
    expect(formatBody('array-stripped', raw)).toBe('[{"id":1},{"id":2,"name":"bar"}]');
  });

  it('strips then unwraps for singular-stripped', () => {
    const raw = '[{"id":1,"name":null}]';
    expect(formatBody('singular-stripped', raw)).toBe('{"id":1}');
  });

  it('leaves non-object rows alone', () => {
    expect(formatBody('array-stripped', '[1,2,null]')).toBe('[1,2,null]');
  });
});

describe('formatBody — csv', () => {
  it('produces a header row + data rows', () => {
    const raw = '[{"id":1,"name":"foo"},{"id":2,"name":"bar"}]';
    expect(formatBody('csv', raw)).toBe('id,name\n1,foo\n2,bar');
  });

  it('handles sparse rows by unioning keys', () => {
    const raw = '[{"id":1},{"id":2,"note":"x"}]';
    const csv = formatBody('csv', raw);
    expect(csv.split('\n')[0]).toBe('id,note');
    expect(csv).toContain('2,x');
  });

  it('escapes commas, quotes, and newlines', () => {
    const raw = '[{"n":"a,b"},{"n":"has \\"quote\\""},{"n":"line1\\nline2"}]';
    const csv = formatBody('csv', raw);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"has ""quote"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('emits empty string for empty input array', () => {
    expect(formatBody('csv', '[]')).toBe('');
  });

  it('represents null and undefined as empty cells', () => {
    const raw = '[{"a":1,"b":null}]';
    const csv = formatBody('csv', raw);
    expect(csv).toBe('a,b\n1,');
  });
});

describe('formatBody — geojson', () => {
  it('wraps rows in a FeatureCollection, auto-detecting the geometry column', () => {
    const raw =
      '[{"id":1,"geom":{"type":"Point","coordinates":[0,0]},"name":"origin"}]';
    const parsed = JSON.parse(formatBody('geojson', raw));
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features.length).toBe(1);
    expect(parsed.features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [0, 0],
    });
    expect(parsed.features[0].properties).toEqual({ id: 1, name: 'origin' });
  });

  it('emits an empty FeatureCollection for empty rows', () => {
    const parsed = JSON.parse(formatBody('geojson', '[]'));
    expect(parsed.features).toEqual([]);
  });
});
