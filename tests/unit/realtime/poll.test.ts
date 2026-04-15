// Poll query builder tests.

import { describe, expect, it } from 'vitest';

import { buildPollQuery } from '@/realtime/poll';
import { expectOk } from '@tests/fixtures/assert-result';

describe('buildPollQuery', () => {
  it('emits the standard SELECT with all bind params', () => {
    const built = expectOk(
      buildPollQuery({
        subscription: { schema: 'public', table: 'books', since: 10 },
        limit: 50,
      }),
    );
    expect(built.sql).toContain(
      'FROM cloudrest._cloudrest_changes',
    );
    expect(built.sql).toContain('schema_name = $1');
    expect(built.sql).toContain('table_name = $2');
    expect(built.sql).toContain('id > $3');
    expect(built.sql).toContain('ORDER BY id ASC LIMIT 50');
    expect(built.params).toEqual(['public', 'books', 10]);
  });

  it('defaults a null `since` to 0', () => {
    const built = expectOk(
      buildPollQuery({
        subscription: { schema: 'public', table: 'books', since: null },
        limit: 50,
      }),
    );
    expect(built.params[2]).toBe(0);
  });

  it('clamps limit between 1 and 1000', () => {
    const low = expectOk(
      buildPollQuery({
        subscription: { schema: 'public', table: 'books', since: null },
        limit: 0,
      }),
    );
    expect(low.sql).toContain('LIMIT 1');

    const high = expectOk(
      buildPollQuery({
        subscription: { schema: 'public', table: 'books', since: null },
        limit: 9999,
      }),
    );
    expect(high.sql).toContain('LIMIT 1000');
  });

  it('never inlines schema or table names (identifier safety)', () => {
    const built = expectOk(
      buildPollQuery({
        subscription: { schema: "evil'schema", table: 'books', since: 0 },
        limit: 50,
      }),
    );
    // The hostile schema name goes through addParam, NOT
    // identifier inlining, so the SQL has no raw quote escape.
    expect(built.sql).not.toContain("evil'schema");
    expect(built.params).toContain("evil'schema");
  });
});
