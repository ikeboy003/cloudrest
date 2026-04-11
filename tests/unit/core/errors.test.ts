import { describe, expect, it } from 'vitest';

import {
  applyVerbosity,
  authErrors,
  fuzzyFind,
  mediaErrors,
  mutationErrors,
  parseErrors,
  schemaErrors,
  serverErrors,
  sqlStateToHttpStatus,
} from '../../../src/core/errors';

describe('parseErrors', () => {
  it('queryParam emits PGRST100 with 400', () => {
    const e = parseErrors.queryParam('order', 'expected column');
    expect(e.code).toBe('PGRST100');
    expect(e.httpStatus).toBe(400);
    expect(e.message).toContain('"order" parse error');
    expect(e.details).toBe('expected column');
  });

  it('invalidRange emits PGRST103 with 416', () => {
    const e = parseErrors.invalidRange('0-9 / 2');
    expect(e.code).toBe('PGRST103');
    expect(e.httpStatus).toBe(416);
  });

  it('invalidPreferences wraps detail with a strict prefix', () => {
    const e = parseErrors.invalidPreferences('banana=1');
    expect(e.code).toBe('PGRST122');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toBe('Invalid preferences: banana=1');
    expect(e.message).toBe('Invalid preferences given with handling=strict');
  });

  it('aggregatesNotAllowed emits PGRST123 with 400', () => {
    const e = parseErrors.aggregatesNotAllowed();
    expect(e.code).toBe('PGRST123');
    expect(e.httpStatus).toBe(400);
  });

  it('invalidRpcMethod emits PGRST101 with 405', () => {
    const e = parseErrors.invalidRpcMethod('GET');
    expect(e.code).toBe('PGRST101');
    expect(e.httpStatus).toBe(405);
    expect(e.message).toContain('GET');
  });
});

describe('mediaErrors', () => {
  it('unacceptableSchema emits PGRST106 with 406', () => {
    const e = mediaErrors.unacceptableSchema('secret', ['public', 'api']);
    expect(e.code).toBe('PGRST106');
    expect(e.httpStatus).toBe(406);
    expect(e.details).toContain('public');
    expect(e.details).toContain('api');
  });

  it('notAcceptable carries a hint about supported types', () => {
    const e = mediaErrors.notAcceptable('application/xml');
    expect(e.code).toBe('PGRST107');
    expect(e.httpStatus).toBe(406);
    expect(e.hint).toContain('application/json');
  });

  it('singularityError reports row count in details', () => {
    const e = mediaErrors.singularityError(3);
    expect(e.code).toBe('PGRST116');
    expect(e.details).toContain('3');
  });
});

describe('schemaErrors', () => {
  it('tableNotFound suggests a fuzzy match when given', () => {
    const e = schemaErrors.tableNotFound('boks', 'public', 'books');
    expect(e.code).toBe('PGRST205');
    expect(e.httpStatus).toBe(404);
    expect(e.hint).toContain('books');
  });

  it('tableNotFound has a default hint when no suggestion', () => {
    const e = schemaErrors.tableNotFound('foo', 'public');
    expect(e.hint).toContain('reloading');
  });

  it('columnNotFound emits PGRST204 with 400', () => {
    const e = schemaErrors.columnNotFound('titel', 'books', 'title');
    expect(e.code).toBe('PGRST204');
    expect(e.httpStatus).toBe(400);
    expect(e.hint).toContain('title');
  });

  it('ambiguousRelationship uses 300 Multiple Choices', () => {
    const e = schemaErrors.ambiguousRelationship('two matching FKs');
    expect(e.code).toBe('PGRST200');
    expect(e.httpStatus).toBe(300);
  });
});

describe('authErrors', () => {
  it('jwtDecodeError emits PGRST301 with 401', () => {
    const e = authErrors.jwtDecodeError('Expected 3 parts in JWT; got 2');
    expect(e.code).toBe('PGRST301');
    expect(e.httpStatus).toBe(401);
    expect(e.message).toContain('Expected 3 parts');
  });

  it('jwtTokenRequired emits PGRST302 with 401', () => {
    const e = authErrors.jwtTokenRequired();
    expect(e.code).toBe('PGRST302');
    expect(e.httpStatus).toBe(401);
  });

  it('jwtExpired and jwtClaimsError both use PGRST303', () => {
    expect(authErrors.jwtExpired().code).toBe('PGRST303');
    expect(authErrors.jwtClaimsError('bad claim').code).toBe('PGRST303');
  });

  it('jwtSecretMissing is a server error (500)', () => {
    const e = authErrors.jwtSecretMissing();
    expect(e.httpStatus).toBe(500);
  });

  // SECURITY: alg=none rejection must be an available error code now so
  // that the stage-11 implementation has a callable factory. See
  // CONSTITUTION §5.1.
  it('algNotAllowed is available for use by stage-11 auth code', () => {
    const e = authErrors.algNotAllowed('none');
    expect(e.code).toBe('PGRST304');
    expect(e.httpStatus).toBe(401);
    expect(e.message).toContain('none');
  });

  // SECURITY: JWKS scheme allowlist error. See CONSTITUTION §5.5.
  it('jwksSchemeNotAllowed is a 500 config error', () => {
    const e = authErrors.jwksSchemeNotAllowed('file');
    expect(e.code).toBe('PGRST305');
    expect(e.httpStatus).toBe(500);
  });
});

describe('mutationErrors', () => {
  it('gucHeaders emits PGRST111 with 500', () => {
    const e = mutationErrors.gucHeaders();
    expect(e.code).toBe('PGRST111');
    expect(e.httpStatus).toBe(500);
  });

  it('maxAffectedViolation reports the count in details', () => {
    const e = mutationErrors.maxAffectedViolation(7);
    expect(e.code).toBe('PGRST124');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toContain('7');
  });
});

describe('serverErrors.pgError', () => {
  it('maps unique violation (23505) to 409', () => {
    expect(serverErrors.pgError('23505', 'duplicate key', null).httpStatus).toBe(409);
  });

  it('maps undefined table (42P01) to 404', () => {
    expect(
      serverErrors.pgError('42P01', 'relation does not exist', null).httpStatus,
    ).toBe(404);
  });

  it('maps statement timeout (57014) to 504', () => {
    expect(serverErrors.pgError('57014', 'canceling statement', null).httpStatus).toBe(
      504,
    );
  });

  it('maps connection failure (08006) to 503', () => {
    expect(serverErrors.pgError('08006', 'conn failed', null).httpStatus).toBe(503);
  });

  it('falls back to 500 for unknown SQLSTATE', () => {
    expect(serverErrors.pgError('ZZ999', 'weird', null).httpStatus).toBe(500);
  });

  it('class prefix fallbacks: 23xxx -> 409, 42xxx -> 400', () => {
    expect(sqlStateToHttpStatus('23ABC')).toBe(409);
    expect(sqlStateToHttpStatus('42XYZ')).toBe(400);
    expect(sqlStateToHttpStatus('08ABC')).toBe(503);
    expect(sqlStateToHttpStatus('P0ABC')).toBe(400);
  });

  it('preserves details and hint on pgError', () => {
    const e = serverErrors.pgError('23505', 'duplicate', 'Key=(1)', 'use upsert');
    expect(e.details).toBe('Key=(1)');
    expect(e.hint).toBe('use upsert');
  });
});

describe('applyVerbosity', () => {
  it('keeps details and hint on verbose', () => {
    const original = parseErrors.queryParam('order', 'expected column');
    const out = applyVerbosity(original, 'verbose');
    expect(out.details).toBe('expected column');
  });

  it('strips details and hint on minimal', () => {
    const original = schemaErrors.columnNotFound('foo', 'bar', 'baz');
    const out = applyVerbosity(original, 'minimal');
    expect(out.details).toBeNull();
    expect(out.hint).toBeNull();
    expect(out.code).toBe(original.code);
    expect(out.httpStatus).toBe(original.httpStatus);
    expect(out.message).toBe(original.message);
  });
});

describe('CloudRestError objects are frozen', () => {
  it('cannot be mutated', () => {
    const e = parseErrors.queryParam('order', 'bad');
    expect(() => {
      (e as { message: string }).message = 'mutated';
    }).toThrow();
  });
});

describe('fuzzyFind', () => {
  it('finds an exact match', () => {
    expect(fuzzyFind('books', ['books', 'authors'])).toBe('books');
  });

  it('finds a close match', () => {
    expect(fuzzyFind('boks', ['books', 'authors'])).toBe('books');
  });

  it('returns null when no candidate is close enough', () => {
    expect(fuzzyFind('entirely-different', ['books'], 2)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(fuzzyFind('x', [])).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyFind('BOOKS', ['books'])).toBe('books');
  });
});
