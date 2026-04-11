import { describe, expect, it } from 'vitest';

import { formatBody, type FormatBodyResult } from '../../../src/http/media/format';

/**
 * Most tests want to assert "got a body string". `formatBody` now
 * returns a discriminated result, so this helper unwraps the `ok`
 * case and throws if the formatter surfaced a cardinality error.
 */
function body(result: FormatBodyResult): string {
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  return result.body;
}

describe('formatBody — JSON passthrough', () => {
  it('returns raw for json', () => {
    const raw = '[{"id":1,"name":"foo"}]';
    expect(body(formatBody('json', raw))).toBe(raw);
    expect(body(formatBody('any', raw))).toBe(raw);
    expect(body(formatBody('array', raw))).toBe(raw);
  });
});

describe('formatBody — singular', () => {
  // BUG FIX (#GG9): singular requires EXACTLY one row. The previous
  // tests pinned the broken behavior of returning the first row for
  // multi-row inputs and `null` for empty inputs.
  it('returns the one row unwrapped when exactly 1 row matches', () => {
    const raw = '[{"id":1}]';
    expect(body(formatBody('singular', raw))).toBe('{"id":1}');
  });

  it('reports a cardinality error for 2+ rows', () => {
    const raw = '[{"id":1},{"id":2}]';
    const result = formatBody('singular', raw);
    expect(result.kind).toBe('singular-cardinality');
    if (result.kind === 'singular-cardinality') {
      expect(result.rowCount).toBe(2);
    }
  });

  it('reports a cardinality error for 0 rows', () => {
    const result = formatBody('singular', '[]');
    expect(result.kind).toBe('singular-cardinality');
    if (result.kind === 'singular-cardinality') {
      expect(result.rowCount).toBe(0);
    }
  });

  it('passes through non-array input', () => {
    expect(body(formatBody('singular', '"already a scalar"'))).toBe(
      '"already a scalar"',
    );
  });
});

describe('formatBody — ndjson', () => {
  // BUG FIX (#GG10): the old formatter just passed the JSON array
  // through. ndjson is newline-delimited JSON, not a JSON array.
  it('emits one JSON value per line with no trailing newline', () => {
    const raw = '[{"id":1},{"id":2},{"id":3}]';
    expect(body(formatBody('ndjson', raw))).toBe(
      '{"id":1}\n{"id":2}\n{"id":3}',
    );
  });

  it('emits empty string for empty array', () => {
    expect(body(formatBody('ndjson', '[]'))).toBe('');
  });
});

describe('formatBody — stripped nulls', () => {
  it('removes null properties from array rows', () => {
    const raw = '[{"id":1,"name":null},{"id":2,"name":"bar"}]';
    expect(body(formatBody('array-stripped', raw))).toBe(
      '[{"id":1},{"id":2,"name":"bar"}]',
    );
  });

  it('strips then unwraps for singular-stripped', () => {
    const raw = '[{"id":1,"name":null}]';
    expect(body(formatBody('singular-stripped', raw))).toBe('{"id":1}');
  });

  it('leaves non-object rows alone', () => {
    expect(body(formatBody('array-stripped', '[1,2,null]'))).toBe('[1,2,null]');
  });
});

describe('formatBody — csv', () => {
  it('produces a header row + data rows', () => {
    const raw = '[{"id":1,"name":"foo"},{"id":2,"name":"bar"}]';
    expect(body(formatBody('csv', raw))).toBe('id,name\n1,foo\n2,bar');
  });

  it('handles sparse rows by unioning keys', () => {
    const raw = '[{"id":1},{"id":2,"note":"x"}]';
    const csv = body(formatBody('csv', raw));
    expect(csv.split('\n')[0]).toBe('id,note');
    expect(csv).toContain('2,x');
  });

  it('escapes commas, quotes, and newlines', () => {
    const raw = '[{"n":"a,b"},{"n":"has \\"quote\\""},{"n":"line1\\nline2"}]';
    const csv = body(formatBody('csv', raw));
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"has ""quote"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('emits empty string for empty input array', () => {
    expect(body(formatBody('csv', '[]'))).toBe('');
  });

  it('represents null and undefined as empty cells', () => {
    const raw = '[{"a":1,"b":null}]';
    const csv = body(formatBody('csv', raw));
    expect(csv).toBe('a,b\n1,');
  });
});

describe('formatBody — geojson', () => {
  it('wraps rows in a FeatureCollection, auto-detecting the geometry column', () => {
    const raw =
      '[{"id":1,"geom":{"type":"Point","coordinates":[0,0]},"name":"origin"}]';
    const parsed = JSON.parse(body(formatBody('geojson', raw)));
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features.length).toBe(1);
    expect(parsed.features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [0, 0],
    });
    expect(parsed.features[0].properties).toEqual({ id: 1, name: 'origin' });
  });

  it('emits an empty FeatureCollection for empty rows', () => {
    const parsed = JSON.parse(body(formatBody('geojson', '[]')));
    expect(parsed.features).toEqual([]);
  });
});
