import { describe, expect, it } from 'vitest';

import { parseAcceptHeader } from '@/http/media/parse';
import { negotiateOutputMedia } from '@/http/media/negotiate';

function negotiate(accept: string, offered: Parameters<typeof negotiateOutputMedia>[0]['offered']) {
  return negotiateOutputMedia({
    accept: parseAcceptHeader(accept),
    offered,
    rawAcceptHeader: accept,
  });
}

describe('negotiateOutputMedia', () => {
  it('returns the first offered when the client says */*', () => {
    const r = negotiate('*/*', ['json', 'csv']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('json');
  });

  it('honors quality order', () => {
    const r = negotiate('text/csv;q=0.5, application/json;q=0.9', ['json', 'csv']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('json');
  });

  it('falls through to the next accepted type when the first is not offered', () => {
    const r = negotiate('application/xml, text/csv', ['json', 'csv']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('csv');
  });

  it('returns 406 when nothing matches', () => {
    const r = negotiate('application/xml', ['json', 'csv']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PGRST107');
      expect(r.error.httpStatus).toBe(406);
      expect(r.error.details).toContain('application/xml');
    }
  });

  it('returns 406 when the handler offers nothing', () => {
    const r = negotiate('application/json', []);
    expect(r.ok).toBe(false);
  });

  it('prefers stripped over plain when both are offered and client asked for stripped', () => {
    const r = negotiate(
      'application/vnd.pgrst.array+json;nulls=stripped',
      ['array-stripped', 'array', 'json'],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('array-stripped');
  });
});
