import { describe, expect, it } from 'vitest';

import {
  escapeIdent,
  escapeIdentList,
  pgFmtLit,
  qualifiedColumnToSql,
  qualifiedIdentifierToSql,
} from '../../../src/builder/identifiers';

describe('escapeIdent', () => {
  it('wraps plain identifiers in double quotes', () => {
    expect(escapeIdent('books')).toBe('"books"');
  });

  it('doubles internal double quotes', () => {
    expect(escapeIdent('a"b')).toBe('"a""b"');
  });
});

describe('escapeIdentList', () => {
  it('joins multiple identifiers with commas', () => {
    expect(escapeIdentList(['public', 'books'])).toBe('"public", "books"');
  });
});

describe('qualifiedIdentifierToSql', () => {
  it('formats schema.name', () => {
    expect(qualifiedIdentifierToSql({ schema: 'public', name: 'books' })).toBe(
      '"public"."books"',
    );
  });

  it('omits schema when empty', () => {
    expect(qualifiedIdentifierToSql({ schema: '', name: 'tmp' })).toBe('"tmp"');
  });
});

describe('qualifiedColumnToSql', () => {
  it('formats schema.table.column', () => {
    expect(
      qualifiedColumnToSql({ schema: 'public', name: 'books' }, 'title'),
    ).toBe('"public"."books"."title"');
  });

  it('formats schema.table.* for wildcard', () => {
    expect(qualifiedColumnToSql({ schema: 'public', name: 'books' }, '*')).toBe(
      '"public"."books".*',
    );
  });
});

// SECURITY: the backslash check MUST run on the input string, not the
// post-quote-escaped string. Critique #14.
describe('pgFmtLit — security invariants', () => {
  it("wraps plain strings in ''", () => {
    expect(pgFmtLit("O'Reilly")).toBe("'O''Reilly'");
  });

  it('doubles single quotes', () => {
    expect(pgFmtLit("a'b'c")).toBe("'a''b''c'");
  });

  it('prefixes E when input contains a backslash', () => {
    expect(pgFmtLit('path\\to\\file')).toBe("E'path\\\\to\\\\file'");
  });

  it('handles a mix of quotes and backslashes', () => {
    expect(pgFmtLit("a'b\\c")).toBe("E'a''b\\\\c'");
  });

  // SECURITY: a refactor that flipped the order of escape steps in the
  // old helper would produce `E''...`. The rewrite's test anchors the
  // ordering by asserting shape, not implementation.
  it('produces exactly one leading quote', () => {
    const result = pgFmtLit('a\\b');
    expect(result.startsWith("E'")).toBe(true);
    // There must be exactly 2 unescaped single quotes: the opener and
    // the closer. Escaped single quotes come as `''`.
    const unescapedQuotes = result.replace(/''/g, '').match(/'/g)?.length ?? 0;
    expect(unescapedQuotes).toBe(2);
  });
});
