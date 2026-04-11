import { describe, expect, it } from 'vitest';

import { parseAcceptHeader, parseContentTypeHeader } from '@/http/media/parse';

describe('parseAcceptHeader', () => {
  it('treats missing Accept as */*', () => {
    const result = parseAcceptHeader(null);
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe('any');
  });

  it('treats empty Accept as */*', () => {
    expect(parseAcceptHeader('')[0]!.id).toBe('any');
    expect(parseAcceptHeader('   ')[0]!.id).toBe('any');
  });

  it('parses a single known media type', () => {
    const result = parseAcceptHeader('application/json');
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe('json');
    expect(result[0]!.quality).toBe(1);
  });

  it('parses text/csv', () => {
    const [csv] = parseAcceptHeader('text/csv');
    expect(csv!.id).toBe('csv');
  });

  it('sorts by quality descending', () => {
    const result = parseAcceptHeader('text/csv;q=0.5, application/json;q=0.9');
    expect(result[0]!.id).toBe('json');
    expect(result[1]!.id).toBe('csv');
  });

  it('keeps q=0 entries so the negotiator can honor them as exclusions', () => {
    // BUG FIX (#GG12): q=0 means "not acceptable". The previous
    // behavior dropped those entries, so a later `*/*` could
    // silently re-select the excluded type. They are now preserved
    // in the parsed list (with quality: 0) and the negotiator
    // enforces the exclusion.
    const result = parseAcceptHeader('text/csv;q=0, application/json');
    expect(result.length).toBe(2);
    // Sort order is quality desc, so json (q=1) comes first, csv
    // (q=0) last.
    expect(result[0]!.id).toBe('json');
    expect(result[1]!.id).toBe('csv');
    expect(result[1]!.quality).toBe(0);
  });

  it('clamps q > 1 to 1', () => {
    const result = parseAcceptHeader('application/json;q=5');
    expect(result[0]!.quality).toBe(1);
  });

  it('treats non-numeric q as 0 (kept for negotiator exclusion)', () => {
    // BUG FIX (#GG12): non-numeric q parses as 0 (per
    // parseQuality) and is retained so the negotiator can treat
    // it as an explicit exclusion, same as an explicit `q=0`.
    const result = parseAcceptHeader('application/json;q=abc');
    expect(result.length).toBe(1);
    expect(result[0]!.quality).toBe(0);
  });

  it('drops unknown media types (they cannot be served)', () => {
    const result = parseAcceptHeader('application/xml, application/json');
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe('json');
  });

  it('sorts concrete over wildcard at equal quality', () => {
    const result = parseAcceptHeader('*/*, application/json');
    expect(result[0]!.id).toBe('json');
    expect(result[1]!.id).toBe('any');
  });

  it('recognizes vnd.pgrst.object+json with nulls=stripped', () => {
    const [mt] = parseAcceptHeader(
      'application/vnd.pgrst.object+json;nulls=stripped',
    );
    expect(mt!.id).toBe('singular-stripped');
  });

  it('recognizes vnd.pgrst.array+json with nulls=stripped', () => {
    const [mt] = parseAcceptHeader(
      'application/vnd.pgrst.array+json;nulls=stripped',
    );
    expect(mt!.id).toBe('array-stripped');
  });

  it('recognizes plain vnd.pgrst.object+json', () => {
    const [mt] = parseAcceptHeader('application/vnd.pgrst.object+json');
    expect(mt!.id).toBe('singular');
  });

  // COMPAT: PostgREST aliases bare `application/vnd.pgrst.plan` to plan+text.
  it('aliases bare vnd.pgrst.plan to plan-text', () => {
    const [mt] = parseAcceptHeader('application/vnd.pgrst.plan');
    expect(mt!.id).toBe('plan-text');
  });

  it('aliases bare vnd.pgrst.array to array', () => {
    const [mt] = parseAcceptHeader('application/vnd.pgrst.array');
    expect(mt!.id).toBe('array');
  });

  it('accepts geojson', () => {
    const [mt] = parseAcceptHeader('application/geo+json');
    expect(mt!.id).toBe('geojson');
  });
});

describe('parseContentTypeHeader', () => {
  it('returns any for missing content type', () => {
    expect(parseContentTypeHeader(null).id).toBe('any');
  });

  it('parses application/json', () => {
    expect(parseContentTypeHeader('application/json').id).toBe('json');
  });

  it('falls back to any for unknown types', () => {
    // COMPAT: PostgREST lenient fallback for write content types.
    expect(parseContentTypeHeader('application/xml').id).toBe('any');
  });

  it('ignores parameters when matching', () => {
    expect(parseContentTypeHeader('application/json; charset=utf-8').id).toBe('json');
  });
});
