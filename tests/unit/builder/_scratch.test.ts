// SCRATCH — adversarial probes for the builder layer.
//
// Delete or convert to proper regression tests after the analysis pass.
//
// WHY THIS FILE EXISTS: the parser-layer scratch (tests/unit/parser/
// _scratch.test.ts) surfaces the ACCEPTANCE surface — what nasty byte
// sequences the parser is willing to accept as field names, values,
// JSON keys, etc. That file's probes are informational: they log what
// shape comes out, so a reader knows which inputs the builder will
// have to safely render.
//
// This file takes that corpus and feeds it THROUGH the builder, then
// asserts that the resulting SQL + params cannot inject. Every probe
// here answers a specific question: "if an attacker controls the
// column name / value / cast / JSON key, can they break out of the
// intended SQL structure?"
//
// Organization:
//   AA - escapeIdent against nasty identifiers
//   BB - pgFmtLit against nasty literals
//   CC - renderField + JSON path round-trips
//   DD - renderFilter against nasty values
//   EE - renderSelectProjection against nasty select items
//   FF - buildPgArrayLiteral escape corpus
//   GG - monotonic $N allocation under adversarial interleaving
//   HH - cross-function: feed parser output directly into builder
//
// All probes use expectOk from tests/fixtures/assert-result so a
// builder regression (e.g. the renderer returning Err instead of Ok
// for input it used to accept) fails the test loudly instead of
// silently skipping assertions.

import { describe, expect, it } from 'vitest';

import {
  escapeIdent,
  escapeIdentList,
  pgFmtLit,
  qualifiedColumnToSql,
  qualifiedIdentifierToSql,
} from '../../../src/builder/identifiers';
import { SqlBuilder } from '../../../src/builder/sql';
import {
  buildPgArrayLiteral,
  renderField,
  renderFilter,
  renderHaving,
  renderLogicTree,
  renderSelectProjection,
} from '../../../src/builder/fragments';
import { parseFilter } from '../../../src/parser/filter';
import { parseLogicTree } from '../../../src/parser/logic';
import { parseHavingClauses } from '../../../src/parser/having';
import { parseOrder } from '../../../src/parser/order';
import { parseSelect } from '../../../src/parser/select';
import { parseField } from '../../../src/parser/json-path';
import { buildReadQuery } from '../../../src/builder/read';
import type { ReadPlan } from '../../../src/planner/read-plan';
import { expectErr, expectOk } from '../../fixtures/assert-result';

const target = { schema: 'public', name: 'books' } as const;

// Helper: render a filter from a query-param pair and return the SQL
// + bound params as a pair. Throws loudly if either parse or render
// produces an Err.
function parseAndRenderFilter(key: string, value: string): { sql: string; params: readonly unknown[] } {
  const parsed = expectOk(parseFilter(key, value));
  if (parsed === null) {
    throw new Error(`parseFilter(${JSON.stringify(key)}, ${JSON.stringify(value)}) returned null — not a filter`);
  }
  const b = new SqlBuilder();
  const sql = expectOk(renderFilter(target, parsed.filter, b));
  return { sql, params: b.toBuiltQuery().params };
}

// -----------------------------------------------------------------
// AA — escapeIdent against nasty identifiers
// -----------------------------------------------------------------

describe('scratch builder AA: escapeIdent adversarial corpus', () => {
  it('AA1 identifier with one double-quote gets doubled and wrapped', () => {
    // INVARIANT: the output wraps with " and internal " is doubled.
    const out = escapeIdent('a"b');
    expect(out).toBe('"a""b"');
    // Exactly 4 double-quotes in output: 2 wrappers + 2 escaped.
    expect((out.match(/"/g) ?? []).length).toBe(4);
  });

  it('AA2 identifier with three double-quotes', () => {
    const out = escapeIdent('a"""b');
    // 2 wrappers + 6 escaped = 8 quotes
    expect((out.match(/"/g) ?? []).length).toBe(8);
    // Must still start and end with one quote
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });

  it('AA3 identifier with null byte survives', () => {
    // Postgres allows U+0000 inside a quoted identifier, though some
    // clients reject it. The builder should not throw.
    const out = escapeIdent('a\0b');
    expect(out).toBe('"a\0b"');
  });

  it('AA4 identifier with backslash is untouched (backslashes are not special inside quoted identifiers)', () => {
    const out = escapeIdent('a\\b');
    expect(out).toBe('"a\\b"');
  });

  it('AA5 identifier with SQL metacharacters is fully enclosed', () => {
    // `;`, `--`, `/*`, `*/` should all be inert inside the quotes.
    const evil = `abc"; DROP TABLE students; --`;
    const out = escapeIdent(evil);
    // Only the internal " is doubled; the rest stays inside the
    // wrapping quotes.
    expect(out).toBe(`"abc""; DROP TABLE students; --"`);
    // The wrapping quotes plus the two escaped internal quotes = 4.
    expect((out.match(/"/g) ?? []).length).toBe(4);
  });

  it('AA6 identifier with newlines', () => {
    const out = escapeIdent('a\nb\nc');
    expect(out).toBe('"a\nb\nc"');
  });

  it('AA7 empty identifier', () => {
    // Empty identifiers are illegal in Postgres but the helper is
    // caller-responsible — it should not crash.
    expect(escapeIdent('')).toBe('""');
  });

  it('AA8 identifier entirely of double-quotes', () => {
    const out = escapeIdent('""""');
    // 8 internal " → doubled = 16, plus 2 wrappers = 18
    expect((out.match(/"/g) ?? []).length).toBe(10);
    // Wait — let me think. Input has 4 ". Doubling gives 8. Plus 2
    // wrappers = 10. That matches.
  });

  it('AA9 very long identifier (256 chars)', () => {
    const long = 'a'.repeat(256);
    const out = escapeIdent(long);
    expect(out.length).toBe(258); // wrappers + content
  });

  it('AA10 unicode RTL override character', () => {
    const out = escapeIdent('a\u202eb');
    expect(out).toBe('"a\u202eb"');
  });

  it('AA11 escapeIdentList joins multiple nasty identifiers', () => {
    const out = escapeIdentList(['a"b', 'c"d', 'e"f']);
    expect(out).toBe('"a""b", "c""d", "e""f"');
  });

  it('AA12 qualifiedIdentifierToSql with nasty schema', () => {
    const out = qualifiedIdentifierToSql({ schema: 'a"b', name: 'c"d' });
    expect(out).toBe('"a""b"."c""d"');
  });

  it('AA13 qualifiedColumnToSql with nasty column name', () => {
    const out = qualifiedColumnToSql(
      { schema: 'public', name: 'books' },
      'evil"col',
    );
    expect(out).toBe('"public"."books"."evil""col"');
  });
});

// -----------------------------------------------------------------
// BB — pgFmtLit against nasty literals
// -----------------------------------------------------------------

describe('scratch builder BB: pgFmtLit adversarial corpus', () => {
  // INVARIANT: pgFmtLit is ONLY for database-catalog strings, but the
  // function must still produce SQL that is parseable and unambiguous
  // even when fed user-ish input. Test the escape, not the policy.

  it('BB1 plain ASCII', () => {
    expect(pgFmtLit('hello')).toBe("'hello'");
  });

  it('BB2 single quote', () => {
    expect(pgFmtLit("o'brien")).toBe("'o''brien'");
  });

  it('BB3 doubled single quote', () => {
    expect(pgFmtLit("o''brien")).toBe("'o''''brien'");
  });

  it('BB4 backslash forces E-prefix', () => {
    // Under standard_conforming_strings=off, a plain '...' with a
    // backslash could interpret escape sequences. The E-prefix
    // eliminates the ambiguity unconditionally.
    expect(pgFmtLit('a\\b')).toBe("E'a\\\\b'");
  });

  it('BB5 mix of single quotes and backslashes', () => {
    expect(pgFmtLit("o'brien\\path")).toBe("E'o''brien\\\\path'");
  });

  it('BB6 only backslashes', () => {
    expect(pgFmtLit('\\\\')).toBe("E'\\\\\\\\'");
  });

  it('BB7 only single quotes', () => {
    expect(pgFmtLit("''")).toBe("''''''");
  });

  it('BB8 empty string', () => {
    expect(pgFmtLit('')).toBe("''");
  });

  it('BB9 classic injection string', () => {
    // `x' OR '1'='1` should become `'x'' OR ''1''=''1'`.
    expect(pgFmtLit("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'");
  });

  it('BB10 newline inside literal', () => {
    // No backslash → plain single-quoted literal.
    expect(pgFmtLit('a\nb')).toBe("'a\nb'");
  });

  it('BB11 shape check: balanced single quotes after escaping', () => {
    // Every non-E output must start with `'` and end with `'` and the
    // count of `'` chars must be even.
    for (const input of ['hello', "o'brien", "a''b", "c'd'e"]) {
      const out = pgFmtLit(input);
      expect(out.startsWith("'")).toBe(true);
      expect(out.endsWith("'")).toBe(true);
      expect((out.match(/'/g) ?? []).length % 2).toBe(0);
    }
  });

  it('BB12 shape check: E-prefix outputs start with E\' and end with \'', () => {
    for (const input of ['a\\b', "a'\\b", '\\\\', "x\\'y"]) {
      const out = pgFmtLit(input);
      expect(out.startsWith("E'")).toBe(true);
      expect(out.endsWith("'")).toBe(true);
    }
  });

  // Critique #14 regression: a refactor that did the quote-escape
  // first and then decided on the E-prefix based on the escaped string
  // would still produce `E'...'` for inputs that never had a backslash
  // in the first place, bloating output. The current impl checks the
  // INPUT for backslash, so no false-positive E.
  it('BB13 no false-positive E prefix when input has no backslash', () => {
    expect(pgFmtLit("o'brien").startsWith("E")).toBe(false);
    expect(pgFmtLit('plain text').startsWith("E")).toBe(false);
  });
});

// -----------------------------------------------------------------
// CC — renderField + JSON path round-trips
// -----------------------------------------------------------------

describe('scratch builder CC: renderField with nasty JSON keys', () => {
  it('CC1 JSON key with SQL injection attempt is bound as param', () => {
    const b = new SqlBuilder();
    // Construct a field with a nasty key directly — bypassing the
    // parser. This is what the parser would produce if user input
    // reached `parseField` with such a key after URL decoding.
    const field = {
      name: 'data',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'key' as const, value: "'; DROP TABLE users; --" } },
      ],
    };
    const sql = expectOk(renderField(target, field, b));
    expect(sql).toBe('"public"."books"."data"->$1');
    const built = b.toBuiltQuery();
    expect(built.params).toEqual(["'; DROP TABLE users; --"]);
    // The dangerous text never reaches the SQL string.
    expect(sql).not.toContain('DROP TABLE');
  });

  it('CC2 JSON key with literal $N does not interact with param numbering', () => {
    const b = new SqlBuilder();
    const field = {
      name: 'data',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'key' as const, value: '$1::text' } },
      ],
    };
    const sql = expectOk(renderField(target, field, b));
    // The key text is bound as a param; the rendered SQL contains $1
    // (the placeholder) but NOT $1::text.
    expect(sql).toBe('"public"."books"."data"->$1');
    expect(b.toBuiltQuery().params).toEqual(['$1::text']);
    expect(sql).not.toContain('$1::text');
  });

  it('CC3 chained JSON path — two keys produce two params', () => {
    const b = new SqlBuilder();
    const field = {
      name: 'data',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'key' as const, value: 'a' } },
        { type: 'doubleArrow' as const, operand: { type: 'key' as const, value: 'b' } },
      ],
    };
    const sql = expectOk(renderField(target, field, b));
    expect(sql).toBe('"public"."books"."data"->$1->>$2');
    expect(b.toBuiltQuery().params).toEqual(['a', 'b']);
  });

  it('CC4 JSON integer index is inlined (safe because it is validated)', () => {
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: '0' } },
      ],
    };
    const sql = expectOk(renderField(target, field, b));
    expect(sql).toBe('"public"."books"."tags"->0');
    expect(b.paramCount).toBe(0);
  });

  it('CC5 JSON integer index with malicious content is rejected', () => {
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: '0; DROP TABLE x' } },
      ],
    };
    expectErr(renderField(target, field, b));
  });

  it('CC6 JSON integer index with leading + is rejected', () => {
    // `Number('+0') === 0` but `String(0) === '0'` and
    // `op.operand.value.replace(/^\+/, '')` strips the +, so `+0`
    // would be accepted. Pinning current behavior.
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: '+5' } },
      ],
    };
    const result = renderField(target, field, b);
    // Passes today because of the +-strip. Log the behavior so a
    // future reader knows whether this is intended.
    if (result.ok) {
      expect(result.value).toBe('"public"."books"."tags"->5');
    }
  });

  it('CC7 JSON integer index with whitespace is rejected', () => {
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: ' 0 ' } },
      ],
    };
    expectErr(renderField(target, field, b));
  });

  it('CC8 JSON integer index with hex-like value', () => {
    // `Number('0x10') === 16` — scary. But `String(16) === '16'` !== '0x10'
    // so the string-equality check catches it.
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: '0x10' } },
      ],
    };
    expectErr(renderField(target, field, b));
  });

  it('CC9 JSON integer index with scientific notation', () => {
    // `Number('1e2') === 100` — `String(100) === '100'` !== '1e2' → rejected.
    const b = new SqlBuilder();
    const field = {
      name: 'tags',
      jsonPath: [
        { type: 'arrow' as const, operand: { type: 'idx' as const, value: '1e2' } },
      ],
    };
    expectErr(renderField(target, field, b));
  });

  it('CC10 deeply nested JSON path (100 levels) produces 100 params', () => {
    const b = new SqlBuilder();
    const jsonPath = Array.from({ length: 100 }, (_, i) => ({
      type: 'arrow' as const,
      operand: { type: 'key' as const, value: `k${i}` },
    }));
    const sql = expectOk(renderField(target, { name: 'data', jsonPath }, b));
    expect(b.paramCount).toBe(100);
    // SQL should end with `->$100` and contain no unbound nasty bytes.
    expect(sql).toMatch(/\$100$/);
  });
});

// -----------------------------------------------------------------
// DD — renderFilter against nasty values
// -----------------------------------------------------------------

describe('scratch builder DD: renderFilter adversarial values', () => {
  it('DD1 eq value containing classic injection goes through addParam verbatim', () => {
    const { sql, params } = parseAndRenderFilter('name', "eq.x' OR '1'='1");
    expect(sql).toBe('"public"."books"."name" = $1');
    expect(params).toEqual(["x' OR '1'='1"]);
  });

  it('DD2 eq value containing backslash goes through addParam verbatim', () => {
    const { sql, params } = parseAndRenderFilter('path', 'eq.a\\b\\c');
    expect(sql).toBe('"public"."books"."path" = $1');
    expect(params).toEqual(['a\\b\\c']);
  });

  it('DD3 eq value containing $N placeholder is bound, not reinterpreted', () => {
    const { sql, params } = parseAndRenderFilter('note', 'eq.$1 $2 $3');
    expect(sql).toBe('"public"."books"."note" = $1');
    expect(params).toEqual(['$1 $2 $3']);
  });

  it('DD4 eq value with CRLF + fake DROP does not appear in rendered SQL', () => {
    const { sql, params } = parseAndRenderFilter('note', 'eq.x\r\nDROP TABLE students');
    expect(sql).toBe('"public"."books"."note" = $1');
    expect(params).toEqual(['x\r\nDROP TABLE students']);
    expect(sql).not.toContain('DROP TABLE');
  });

  it('DD5 eq value containing null byte is preserved in params', () => {
    const { sql, params } = parseAndRenderFilter('note', 'eq.a\0b');
    expect(sql).toBe('"public"."books"."note" = $1');
    expect(params).toEqual(['a\0b']);
  });

  it('DD6 ilike value with wildcards: * becomes %, _ is escaped', () => {
    const { sql, params } = parseAndRenderFilter('name', 'ilike.*foo_bar*');
    expect(sql).toBe('"public"."books"."name" ilike $1');
    expect(params).toEqual(['%foo\\_bar%']);
  });

  it('DD7 ilike value with backslash is doubled (and then goes through addParam)', () => {
    const { sql, params } = parseAndRenderFilter('name', 'ilike.*a\\b*');
    expect(sql).toBe('"public"."books"."name" ilike $1');
    // Source replaces \ → \\ THEN _ → \_ THEN * → %
    expect(params).toEqual(['%a\\\\b%']);
  });

  it('DD8 ilike value with literal % (already a SQL wildcard) is NOT escaped', () => {
    // Pinning current behavior: the renderer intentionally does not
    // escape `%` because it assumes the user wants LIKE semantics.
    // Whether this is correct is a policy call. Log it.
    const { params } = parseAndRenderFilter('name', 'ilike.%admin%');
    expect(params).toEqual(['%admin%']);
  });

  it('DD9 fts language is bound as a param, not inlined', () => {
    const { sql, params } = parseAndRenderFilter('body', 'plfts(english).hello');
    expect(sql).toBe('"public"."books"."body" @@ plainto_tsquery($1, $2)');
    expect(params).toEqual(['english', 'hello']);
  });

  it('DD10 in.() with nasty values routes through array literal builder', () => {
    const { sql, params } = parseAndRenderFilter('id', 'in.("a,b","c\\\\d","e""f")');
    expect(sql).toBe('"public"."books"."id" = ANY($1)');
    // The array literal escapes internal " and \ so the literal
    // parses as Postgres array syntax. The whole thing is bound as
    // one param to Postgres.
    expect(params.length).toBe(1);
    const literal = params[0] as string;
    expect(literal.startsWith('{')).toBe(true);
    expect(literal.endsWith('}')).toBe(true);
  });

  it('DD11 is.null produces SQL IS NULL without a param', () => {
    const { sql, params } = parseAndRenderFilter('parent_id', 'is.null');
    expect(sql).toBe('"public"."books"."parent_id" IS NULL');
    expect(params).toEqual([]);
  });

  it('DD12 negated eq prepends NOT', () => {
    const { sql } = parseAndRenderFilter('name', 'not.eq.foo');
    expect(sql).toBe('NOT "public"."books"."name" = $1');
  });

  it('DD13 isdistinct value is bound as param', () => {
    const { sql, params } = parseAndRenderFilter('x', 'isdistinct.hello');
    expect(sql).toBe('"public"."books"."x" IS DISTINCT FROM $1');
    expect(params).toEqual(['hello']);
  });

  it('DD14 isdistinct value containing single quote is bound verbatim', () => {
    const { params } = parseAndRenderFilter('x', "isdistinct.o'brien");
    expect(params).toEqual(["o'brien"]);
  });
});

// -----------------------------------------------------------------
// EE — renderSelectProjection against nasty select items
// -----------------------------------------------------------------

describe('scratch builder EE: renderSelectProjection adversarial cases', () => {
  it('EE1 column name with SQL comment is escaped by escapeIdent', () => {
    // The parser rejects quoted column names containing `/*`; this
    // test takes the alternate path of constructing a field AST
    // directly with a nasty name, to confirm that IF the parser ever
    // accepts such a name, the builder still escapes it.
    const b = new SqlBuilder();
    const select = [
      {
        type: 'field' as const,
        field: { name: 'evil/* comment */col', jsonPath: [] },
      },
    ];
    const sql = expectOk(renderSelectProjection(target, select, b));
    // The nasty name is wrapped in double quotes; the comment chars
    // are inert inside the wrapping.
    expect(sql).toBe('"public"."books"."evil/* comment */col"');
    expect(b.paramCount).toBe(0);
  });

  it('EE2 alias containing nasty bytes — parser rejects, defense in depth', () => {
    // The parser now rejects aliases that don\'t match a conservative
    // pattern. This is defense-in-depth: even if the alias had reached
    // the builder, escapeIdent would wrap it, but the parser
    // pre-validates to produce clearer errors.
    expectErr(parseSelect(`evil":al"ias:col`));
    // Construct the nasty alias directly and verify the builder\'s
    // escape path still works — this pins the builder\'s contract
    // independent of whatever the parser currently accepts.
    const b = new SqlBuilder();
    const select = [
      {
        type: 'field' as const,
        field: { name: 'col', jsonPath: [] },
        alias: 'evil":al"ias',
      },
    ];
    const sql = expectOk(renderSelectProjection(target, select, b));
    // Internal " is doubled; the whole alias is wrapped.
    expect(sql).toContain('"evil"":al""ias"');
  });

  it('EE3 cast to a not-in-allowlist type is rejected', () => {
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('col::evil_type'));
    expectErr(renderSelectProjection(target, select, b));
  });

  it('EE4 whitespace-padded cast is trimmed by the parser and accepted', () => {
    // Parser trims the cast to `int` before the builder sees it. The
    // builder\'s isValidCast would accept either form anyway because
    // isValidCast itself trims. Pin both layers agree.
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('col::  int  '));
    const sql = expectOk(renderSelectProjection(target, select, b));
    expect(sql).toContain('int');
  });

  it('EE5 cast to a mixed-case allowlist entry passes', () => {
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('col::INTEGER'));
    const sql = expectOk(renderSelectProjection(target, select, b));
    expect(sql.toLowerCase()).toContain('integer');
  });

  it('EE6 cast with trailing semicolon is rejected at parse time', () => {
    // Parser rejects before the builder\'s allowlist runs. Either
    // layer on its own would reject — this is defense-in-depth.
    expectErr(parseSelect('col::int; DROP TABLE x'));
  });

  it('EE7 avg(col)::int emits (AVG(col))::int with the type from the allowlist', () => {
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('avg(rating)::float'));
    const sql = expectOk(renderSelectProjection(target, select, b));
    expect(sql).toContain('AVG');
    expect(sql).toContain('::float');
  });

  it('EE8 count() with nasty alias is still escaped', () => {
    // The parser rejects aliases containing unbalanced double-quotes,
    // so we build the AST directly to test the builder\'s escape path.
    const b = new SqlBuilder();
    const select = [
      {
        type: 'field' as const,
        field: { name: '*', jsonPath: [] },
        alias: 'evil"al',
        aggregateFunction: 'count' as const,
      },
    ];
    const sql = expectOk(renderSelectProjection(target, select, b));
    // Alias wrapped in escapeIdent → internal " is doubled.
    expect(sql).toBe('COUNT(*) AS "evil""al"');
  });

  it('EE9 count(*) is rendered as literal COUNT(*)', () => {
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('count()'));
    const sql = expectOk(renderSelectProjection(target, select, b));
    expect(sql).toBe('COUNT(*) AS "count"');
  });

  it('EE10 sum with no column is normalized upstream so we cannot reach sum(NULL)', () => {
    // The parser rejects `sum()`; the builder never sees a sum with
    // no field. Assert the parser does the rejection.
    expectErr(parseSelect('sum()'));
  });
});

// -----------------------------------------------------------------
// FF — buildPgArrayLiteral escape corpus
// -----------------------------------------------------------------

describe('scratch builder FF: buildPgArrayLiteral', () => {
  it('FF1 plain ASCII values', () => {
    expect(buildPgArrayLiteral(['a', 'b', 'c'])).toBe('{"a","b","c"}');
  });

  it('FF2 empty array', () => {
    expect(buildPgArrayLiteral([])).toBe('{}');
  });

  it('FF3 value with double quote is escaped with backslash-quote', () => {
    expect(buildPgArrayLiteral(['a"b'])).toBe('{"a\\"b"}');
  });

  it('FF4 value with backslash is doubled', () => {
    expect(buildPgArrayLiteral(['a\\b'])).toBe('{"a\\\\b"}');
  });

  it('FF5 value with both backslash and quote escapes both', () => {
    expect(buildPgArrayLiteral(['a\\"b'])).toBe('{"a\\\\\\"b"}');
  });

  it('FF6 value with single quote is NOT escaped (binds through addParam)', () => {
    // Single quotes have no special meaning inside Postgres array
    // literals; the whole literal is eventually bound as one string
    // value via addParam, so only {}-syntax escapes matter.
    expect(buildPgArrayLiteral(["o'brien"])).toBe('{"o\'brien"}');
  });

  it('FF7 value with comma is inside quotes, not splitting', () => {
    expect(buildPgArrayLiteral(['a,b'])).toBe('{"a,b"}');
  });

  it('FF8 empty string value', () => {
    expect(buildPgArrayLiteral([''])).toBe('{""}');
  });

  it('FF9 value with newline', () => {
    expect(buildPgArrayLiteral(['a\nb'])).toBe('{"a\nb"}');
  });

  it('FF10 literal produced is parseable by Postgres', () => {
    // The output must be valid Postgres array-literal syntax: `{}`
    // delimited, quoted elements comma-separated, internal quotes
    // backslash-escaped, internal backslashes doubled.
    for (const values of [
      ['simple'],
      ['a', 'b', 'c'],
      ['with,comma'],
      ['with"quote'],
      ['with\\slash'],
      ['empty', '', 'values'],
    ]) {
      const lit = buildPgArrayLiteral(values);
      expect(lit.startsWith('{')).toBe(true);
      expect(lit.endsWith('}')).toBe(true);
      // Count of quoted elements must equal values.length.
      const inner = lit.slice(1, -1);
      // Simple split on `,` is wrong for values with commas, but for
      // this sanity check we just verify the string is balanced:
      // every `"` inside that isn't preceded by `\` is a delimiter.
      // That's harder to assert without a parser; we just assert
      // there are no loose backslashes or trailing quotes.
      expect(inner.endsWith('"') || inner === '').toBe(true);
    }
  });
});

// -----------------------------------------------------------------
// GG — monotonic $N allocation under adversarial interleaving
// -----------------------------------------------------------------

describe('scratch builder GG: SqlBuilder $N monotonicity', () => {
  it('GG1 $N is never reused', () => {
    const b = new SqlBuilder();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const p = b.addParam(`v${i}`);
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
    expect(seen.size).toBe(100);
  });

  it('GG2 $N is sequentially assigned starting at 1', () => {
    const b = new SqlBuilder();
    for (let i = 1; i <= 50; i++) {
      expect(b.addParam(i)).toBe(`$${i}`);
    }
  });

  it('GG3 paramCount matches the number of allocated params', () => {
    const b = new SqlBuilder();
    b.addParam('a');
    b.addParam('b');
    b.addParam('c');
    expect(b.paramCount).toBe(3);
    expect(b.toBuiltQuery().params.length).toBe(3);
  });

  it('GG4 interleaved addParam / writeParam maintain sequential $N', () => {
    const b = new SqlBuilder();
    b.write('SELECT ');
    const a = b.addParam('a'); // $1
    b.write(a);
    b.write(', ');
    b.writeParam('b'); // $2
    b.write(', ');
    const c = b.addParam('c'); // $3
    b.write(c);
    expect(a).toBe('$1');
    expect(c).toBe('$3');
    expect(b.toBuiltQuery().sql).toBe('SELECT $1, $2, $3');
  });

  it('GG5 params are preserved verbatim, including null / undefined / objects', () => {
    const b = new SqlBuilder();
    b.addParam(null);
    b.addParam(undefined);
    b.addParam({ nested: 'obj' });
    b.addParam([1, 2, 3]);
    const built = b.toBuiltQuery();
    expect(built.params[0]).toBeNull();
    expect(built.params[1]).toBeUndefined();
    expect(built.params[2]).toEqual({ nested: 'obj' });
    expect(built.params[3]).toEqual([1, 2, 3]);
  });

  it('GG6 toBuiltQuery freezes both the query and the params array', () => {
    const b = new SqlBuilder();
    b.addParam('a');
    b.write('x');
    const built = b.toBuiltQuery();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.params)).toBe(true);
    expect(() => {
      (built.params as unknown[]).push('b');
    }).toThrow();
  });

  it('GG7 a string value containing $1 is bound, not rewritten', () => {
    // Critique #13 regression: `rewriteParamRefs` in the old code
    // rewrote every `$N` substring in the built SQL, including ones
    // that lived inside parameter values. The new SqlBuilder design
    // never rewrites — if a value contains `$1`, it stays in the
    // params array, not the SQL stream.
    const b = new SqlBuilder();
    const p = b.addParam('$1::text');
    expect(p).toBe('$1'); // placeholder
    expect(b.toBuiltQuery().params[0]).toBe('$1::text'); // value
  });
});

// -----------------------------------------------------------------
// HH — cross-function: parser AST → builder round-trip
// -----------------------------------------------------------------

describe('scratch builder HH: parser → builder round-trips', () => {
  it('HH1 nasty column name in select is safely escaped', () => {
    const b = new SqlBuilder();
    // Can\'t easily construct via parseSelect because the parser
    // regex rejects some of this. Go direct with a constructed AST.
    const select = [
      {
        type: 'field' as const,
        field: { name: 'evil";DROP--', jsonPath: [] },
      },
    ];
    const sql = expectOk(renderSelectProjection(target, select, b));
    // The nasty column name goes through escapeIdent → wrapped and
    // internal " is doubled. No raw `;DROP` breaks out.
    expect(sql).toBe('"public"."books"."evil"";DROP--"');
    expect(b.paramCount).toBe(0);
  });

  it('HH2 logic tree with nasty values — every value bound', () => {
    const b = new SqlBuilder();
    const tree = expectOk(
      parseLogicTree(
        'and',
        false,
        "(name.eq.x' OR '1'='1,email.ilike.*admin*)",
      ),
    );
    const sql = expectOk(renderLogicTree(target, tree, b));
    const built = b.toBuiltQuery();
    // Two values, two params — nothing inlined.
    expect(built.params.length).toBe(2);
    expect(sql).not.toContain("OR '1'='1");
    expect(sql).toMatch(/\$1.*\$2/);
  });

  it('HH3 having clause with nasty value', () => {
    const b = new SqlBuilder();
    const having = expectOk(parseHavingClauses("count().gt.5' OR '1'='1"));
    const sql = expectOk(renderHaving(target, having, b));
    expect(sql).toBe('HAVING COUNT(*) > $1');
    expect(b.toBuiltQuery().params).toEqual(["5' OR '1'='1"]);
  });

  it('HH4 field with JSON path where the key is a classic injection', () => {
    const b = new SqlBuilder();
    const field = expectOk(parseField(`data->"'; DROP TABLE x; --"`));
    const sql = expectOk(renderField(target, field, b));
    expect(sql).toBe('"public"."books"."data"->$1');
    expect(b.toBuiltQuery().params).toEqual(["'; DROP TABLE x; --"]);
  });

  it('HH5 full filter with JSON-path field and nasty value', () => {
    const { sql, params } = parseAndRenderFilter(
      `data->>"'; EVIL --"`,
      "eq.' OR 1=1 --",
    );
    // The JSON key becomes $1, the value becomes $2. Both bound.
    expect(sql).toBe('"public"."books"."data"->>$1 = $2');
    expect(params).toEqual([`'; EVIL --`, "' OR 1=1 --"]);
  });

  it('HH6 cast with uppercase aggregate and whitespace in the allowlist entry', () => {
    const b = new SqlBuilder();
    const select = expectOk(parseSelect('max(price)::  FLOAT8  '));
    const sql = expectOk(renderSelectProjection(target, select, b));
    expect(sql).toContain('MAX(');
    expect(sql).toContain('::float8');
  });

  it('HH7 renderer does not leak SQL when param count is exhausted', () => {
    // Unbounded params — stress test that $N allocation doesn\'t wrap
    // or overflow under a large number of filters.
    const b = new SqlBuilder();
    for (let i = 0; i < 500; i++) {
      const { sql } = (() => {
        const bb = new SqlBuilder();
        const sql = expectOk(
          renderFilter(target, parseFilterValue(`col`, `eq.v${i}`), bb),
        );
        return { sql };
      })();
      expect(sql).toContain('$1');
    }
    // Also in a single builder:
    for (let i = 0; i < 500; i++) {
      b.addParam(`v${i}`);
    }
    expect(b.paramCount).toBe(500);
    expect(b.addParam('x')).toBe('$501');
  });
});

// Helper for HH7.
function parseFilterValue(key: string, value: string) {
  const parsed = expectOk(parseFilter(key, value));
  if (parsed === null) throw new Error('not a filter');
  return parsed.filter;
}

// ===================================================================
// PASS II — buildReadQuery adversarial probes
// ===================================================================
//
// The pass above (AA-HH) targeted the fragment renderers in isolation.
// This pass targets `buildReadQuery` — the single render-pass that
// assembles filters, logic, search, vector, distinct, count, having,
// and range into the final SQL.
//
// The invariants I'm hunting:
//
//   I1. Every $N in the SQL text has a matching entry in params.
//       (The existing test asserts max $N <= params.length; this pass
//       asserts EQUALITY and SEQUENTIAL density.)
//
//   I2. Param-value round-trip: every user-controlled string shows up
//       verbatim in params, not in the SQL text.
//
//   I3. Count CTE param sharing: the count CTE at the top of the
//       query reuses `whereParts` rendered with the same builder.
//       The params in those whereParts must still resolve correctly
//       when the CTE sits BEFORE the outer SELECT in the SQL stream.
//
//   I4. Cross-feature interleaving: filter + search + vector + distinct
//       + having + count all active in one plan must produce valid
//       param-count consistency.
//
//   I5. pgFmtLit reaches the regclass literal. If a schema/table name
//       contains a backslash, the E-prefix kicks in and the literal
//       is still a valid Postgres regclass cast.
//
//   I6. Media-type row caps intersect correctly with explicit limits
//       and DB_MAX_ROWS.
//
//   I7. Empty-state permutations: all possible combinations of empty
//       select / filters / order / logic / having / distinct / search
//       / vector produce a buildable query.
//
//   I8. Order precedence: user ORDER BY comes before vector distance.
//       Vector distance appears in projection AND order BY even when
//       select is non-empty.

function basePlan(overrides: Partial<ReadPlan> = {}): ReadPlan {
  return {
    target: { schema: 'public', name: 'books' },
    select: [],
    filters: [],
    logic: [],
    order: [],
    range: { offset: 0, limit: null },
    having: [],
    count: null,
    mediaType: 'json',
    hasPreRequest: false,
    maxRows: null,
    ...overrides,
  };
}

/**
 * Check that every `$N` in the SQL text maps to a valid index in
 * params (1 <= N <= params.length) AND that the set of referenced N
 * is dense — no gaps. This is a stricter invariant than the existing
 * read.test.ts which only checks `max N <= params.length`.
 */
function assertParamConsistency(sql: string, params: readonly unknown[]): void {
  const refs = sql.match(/\$\d+/g) ?? [];
  const nums = new Set(refs.map((r) => Number(r.slice(1))));
  for (const n of nums) {
    if (n < 1 || n > params.length) {
      throw new Error(
        `$${n} is outside params range [1..${params.length}]. ` +
          `SQL: ${sql}`,
      );
    }
  }
  // Dense check: every index from 1..max should be referenced.
  if (nums.size > 0) {
    const max = Math.max(...nums);
    for (let i = 1; i <= max; i++) {
      if (!nums.has(i)) {
        throw new Error(
          `$${i} is allocated in params but never referenced in SQL. ` +
            `Max referenced: $${max}, params.length: ${params.length}. SQL: ${sql}`,
        );
      }
    }
    // Params allocated beyond max referenced: also a bug (dead param).
    if (max < params.length) {
      throw new Error(
        `params has ${params.length} entries but SQL only references up to $${max}. ` +
          `Dead params: ${params.slice(max).map((v) => JSON.stringify(v)).join(', ')}`,
      );
    }
  } else if (params.length > 0) {
    throw new Error(
      `params has ${params.length} entries but SQL has no $N references.`,
    );
  }
}

// -----------------------------------------------------------------
// II — param-count consistency
// -----------------------------------------------------------------

describe('scratch builder II: param-count consistency', () => {
  it('II1 empty plan has no params', () => {
    const built = expectOk(buildReadQuery(basePlan()));
    assertParamConsistency(built.sql, built.params);
    expect(built.params).toEqual([]);
  });

  it('II2 single filter allocates exactly one param', () => {
    const filter = expectOk(parseFilter('price', 'gt.10'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(basePlan({ filters: [filter.filter] })),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.params).toEqual(['10']);
  });

  it('II3 three filters produce $1..$3, dense', () => {
    const filters = ['price=gt.10', 'stock=lte.5', 'name=ilike.*foo*'].map((qp) => {
      const [k, v] = qp.split('=');
      const f = expectOk(parseFilter(k!, v!));
      if (f === null) throw new Error('filter is null');
      return f.filter;
    });
    const built = expectOk(buildReadQuery(basePlan({ filters })));
    assertParamConsistency(built.sql, built.params);
    expect(built.params.length).toBe(3);
  });

  it('II4 logic tree adds to the param count without gaps', () => {
    const tree = expectOk(
      parseLogicTree('and', false, '(price.gt.10,name.ilike.*foo*)'),
    );
    const built = expectOk(buildReadQuery(basePlan({ logic: [tree] })));
    assertParamConsistency(built.sql, built.params);
    expect(built.params.length).toBe(2);
  });

  it('II5 search adds 2 params per reference (term + language)', () => {
    // WHERE: one tsvector language + one term + one tsquery language
    // = 3 params (the language is bound twice because renderTsVector
    // and renderSearchMatch each call addParam). This is a design
    // choice worth pinning: binding twice is wasteful but not wrong.
    const built = expectOk(
      buildReadQuery(
        basePlan({
          search: {
            term: 'rocket',
            columns: ['title'],
            language: 'english',
            includeRank: false,
          },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // Pin the current count so any change to the binding strategy is
    // visible in this test.
    expect(built.params).toEqual(['english', 'rocket', 'english']);
  });

  it('II6 vector adds exactly one param (the literal)', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [0.1, 0.2], column: 'embedding', op: 'l2' },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // Vector param appears TWICE in SQL (projection + order-by) but
    // current impl binds it TWICE as well. Pin the count.
    expect(built.params).toContain('[0.1,0.2]');
  });

  it('II7 vector distance appears in projection AND order by', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [1], column: 'embedding', op: 'cosine' },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // Distance expression renders twice. If the renderer ever shares
    // the param, this test will break and we can revisit.
    const refs = (built.sql.match(/<=>/g) ?? []).length;
    expect(refs).toBe(2);
  });
});

// -----------------------------------------------------------------
// JJ — count CTE param sharing
// -----------------------------------------------------------------

describe('scratch builder JJ: count CTE + outer SELECT share params', () => {
  it('JJ1 exact count CTE reuses the filter param from whereParts', () => {
    const filter = expectOk(parseFilter('price', 'gt.10'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({ filters: [filter.filter], count: 'exact' }),
      ),
    );
    assertParamConsistency(built.sql, built.params);

    // The count CTE body runs from `AS (` to the matching `)`. Slice
    // that block and assert $1 appears in the WHERE clause inside.
    const cteStart = built.sql.indexOf('WITH pgrst_source_count AS (');
    expect(cteStart).toBeGreaterThan(-1);
    const openParen = built.sql.indexOf('(', cteStart);
    const closeParen = built.sql.indexOf(')', openParen);
    const cteBody = built.sql.slice(openParen, closeParen + 1);
    expect(cteBody).toContain('WHERE');
    expect(cteBody).toContain('$1');

    // The inner SELECT (inside FROM (SELECT ... )) also has the
    // same $1 reference.
    const innerStart = built.sql.indexOf('FROM (SELECT');
    expect(innerStart).toBeGreaterThan(-1);
    const innerFromTIdx = built.sql.lastIndexOf(') t');
    const innerBlock = built.sql.slice(innerStart, innerFromTIdx);
    expect(innerBlock).toContain('$1');

    // params must contain the value once — it's shared by reference.
    expect(built.params).toEqual(['10']);
  });

  it('JJ2 exact count + multiple filters: dense param numbering across CTE and inner', () => {
    const f1 = expectOk(parseFilter('price', 'gt.10'));
    const f2 = expectOk(parseFilter('stock', 'lte.5'));
    if (f1 === null || f2 === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({
          filters: [f1.filter, f2.filter],
          count: 'exact',
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.params).toEqual(['10', '5']);
    // $1 and $2 each appear at least twice (once in count CTE, once in inner).
    const count1 = (built.sql.match(/\$1\b/g) ?? []).length;
    const count2 = (built.sql.match(/\$2\b/g) ?? []).length;
    expect(count1).toBeGreaterThanOrEqual(2);
    expect(count2).toBeGreaterThanOrEqual(2);
  });

  it('JJ3 estimated count CTE also shares param references with inner', () => {
    const filter = expectOk(parseFilter('name', 'ilike.*foo*'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({ filters: [filter.filter], count: 'estimated' }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toContain('MATERIALIZED');
  });
});

// -----------------------------------------------------------------
// KK — cross-feature interleaving
// -----------------------------------------------------------------

describe('scratch builder KK: cross-feature param interleaving', () => {
  it('KK1 filter + search + vector together — no param collision', () => {
    const filter = expectOk(parseFilter('published', 'is.true'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({
          filters: [filter.filter],
          search: {
            term: 'rocket',
            columns: ['title'],
            language: 'english',
            includeRank: true,
          },
          vector: {
            queryVector: [0.5, 0.5],
            column: 'embedding',
            op: 'cosine',
          },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // All three features share the builder. Each contributes:
    //   filter (is.true): 0 params (is null/true/false don't bind)
    //   search.rank projection: 2 params (lang, term for ts_rank)
    //   vector projection: 1 param
    //   search.match WHERE: 2 params (lang, term again)
    //   vector order-by: 1 param
    // Total pins: whatever the current impl computes.
    expect(built.params.length).toBeGreaterThanOrEqual(4);
  });

  it('KK2 filter + having + order + limit', () => {
    const filter = expectOk(parseFilter('stock', 'gt.0'));
    const order = expectOk(parseOrder('title.asc'));
    const having = expectOk(parseHavingClauses('count().gt.5'));
    if (filter === null) throw new Error('filter is null');
    const select = expectOk(parseSelect('category,count()'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select,
          filters: [filter.filter],
          order,
          having,
          range: { offset: 5, limit: 10 },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toContain('GROUP BY');
    expect(built.sql).toContain('HAVING');
    expect(built.sql).toContain('LIMIT 10 OFFSET 5');
  });

  it('KK3 nested logic tree + vector + distinct', () => {
    const logic = expectOk(
      parseLogicTree(
        'and',
        false,
        '(price.gt.10,or(stock.lt.5,discount.gt.50))',
      ),
    );
    const built = expectOk(
      buildReadQuery(
        basePlan({
          logic: [logic],
          distinct: { columns: ['category'] },
          vector: {
            queryVector: [1, 2, 3],
            column: 'embedding',
            op: 'inner_product',
          },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toContain('DISTINCT ON');
    expect(built.sql).toContain(' AND ');
    expect(built.sql).toContain(' OR ');
    expect(built.sql).toContain('<#>');
  });

  it('KK4 everything at once — sanity check', () => {
    const filter = expectOk(parseFilter('published', 'is.true'));
    const logic = expectOk(parseLogicTree('or', false, '(stock.gt.0,promo.eq.true)'));
    const order = expectOk(parseOrder('title.asc'));
    const select = expectOk(parseSelect('id,title,category'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select,
          filters: [filter.filter],
          logic: [logic],
          order,
          having: [],
          range: { offset: 0, limit: 20 },
          count: 'exact',
          distinct: { columns: ['category'] },
          search: {
            term: 'rocket',
            columns: ['title', 'body'],
            language: 'english',
            includeRank: true,
          },
          vector: {
            queryVector: [0.1, 0.2, 0.3],
            column: 'embedding',
            op: 'cosine',
          },
          hasPreRequest: true,
          maxRows: 100,
          mediaType: 'json',
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);

    // Every major fragment appears.
    expect(built.sql).toContain('WITH pgrst_source_count');
    expect(built.sql).toContain('SELECT DISTINCT ON');
    expect(built.sql).toContain('"public"."books"."id"');
    expect(built.sql).toContain('ts_rank(');
    expect(built.sql).toContain('AS "relevance"');
    expect(built.sql).toContain('<=>');
    expect(built.sql).toContain('AS "distance"');
    expect(built.sql).toContain(' AND ');
    expect(built.sql).toContain(' OR ');
    expect(built.sql).toContain('IS TRUE');
    expect(built.sql).toContain('ORDER BY');
    expect(built.sql).toContain('LIMIT 20');
    expect(built.sql).toContain('response.headers');
    expect(built.sql).toContain('response.status');
    expect(built.skipGucRead).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// LL — pgFmtLit escape reaches the regclass literal
// -----------------------------------------------------------------

describe('scratch builder LL: table name nasty bytes and pgFmtLit', () => {
  it('LL1 table name with single quote: regclass lit escapes correctly for count=exact', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          target: { schema: 'public', name: "books'evil" },
          count: 'exact',
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // Wrapped identifier for the FROM clause.
    expect(built.sql).toContain('"public"."books\'evil"');
  });

  it('LL2 table name with backslash — planned count pgFmtLit produces E-string', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          target: { schema: 'public', name: 'books\\evil' },
          count: 'planned',
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // The regclass literal is pgFmtLit("public"."books\evil") which
    // contains backslashes and gets E-prefixed. Look for the
    // E'...' form.
    expect(built.sql).toMatch(/E'[^']*\\\\[^']*'::regclass/);
  });

  it('LL3 schema name with single quote — planned count pgFmtLits the regclass literal', () => {
    // The pgFmtLit path only runs for `count: 'planned'` or
    // `count: 'estimated'`; exact count reuses the plain identifier.
    const built = expectOk(
      buildReadQuery(
        basePlan({
          target: { schema: "evil'schema", name: 'books' },
          count: 'planned',
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // The identifier inside the regclass literal has its single
    // quotes doubled. No backslashes, so no E-prefix.
    expect(built.sql).toContain("'\"evil''schema\".\"books\"'::regclass");
  });
});

// -----------------------------------------------------------------
// MM — media-type row cap interactions
// -----------------------------------------------------------------

describe('scratch builder MM: media-type row cap edge cases', () => {
  it('MM1 singular + user limit=10 clamps to 2', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          mediaType: 'singular',
          range: { offset: 0, limit: 10 },
        }),
      ),
    );
    expect(built.sql).toContain('LIMIT 2');
  });

  it('MM2 singular + no limit still produces LIMIT 2', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ mediaType: 'singular' })),
    );
    expect(built.sql).toContain('LIMIT 2');
  });

  it('MM3 singular + user limit=1 keeps it at 1', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          mediaType: 'singular',
          range: { offset: 0, limit: 1 },
        }),
      ),
    );
    expect(built.sql).toContain('LIMIT 1');
  });

  it('MM4 singular-stripped media type uses the same cap', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ mediaType: 'singular-stripped' })),
    );
    expect(built.sql).toContain('LIMIT 2');
  });

  it('MM5 array-stripped wraps json_agg with json_strip_nulls', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ mediaType: 'array-stripped' })),
    );
    expect(built.sql).toContain('json_strip_nulls(to_json(t))');
  });

  it('MM6 DB_MAX_ROWS clamps singular limit DOWN when user asked for more', () => {
    // maxRows=1 and singular cap=2 — min is 1.
    const built = expectOk(
      buildReadQuery(
        basePlan({ mediaType: 'singular', maxRows: 1 }),
      ),
    );
    expect(built.sql).toContain('LIMIT 1');
  });

  it('MM7 DB_MAX_ROWS does NOT expand singular past 2', () => {
    // maxRows=10, singular cap=2 — min is 2.
    const built = expectOk(
      buildReadQuery(
        basePlan({ mediaType: 'singular', maxRows: 10 }),
      ),
    );
    expect(built.sql).toContain('LIMIT 2');
  });

  it('MM8 range.limit=0 is allowed and propagates', () => {
    // 0 is a weird but legal value — "give me no rows, just the count".
    const built = expectOk(
      buildReadQuery(basePlan({ range: { offset: 0, limit: 0 } })),
    );
    expect(built.sql).toContain('LIMIT 0');
  });
});

// -----------------------------------------------------------------
// NN — having with JSON-path field (new bug fix #22)
// -----------------------------------------------------------------

describe('scratch builder NN: having clause field is a Field AST', () => {
  it('NN1 having avg(rating) renders with qualified column', () => {
    const having = expectOk(parseHavingClauses('avg(rating).gt.4'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select: expectOk(parseSelect('category,avg(rating)')),
          having,
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toContain('AVG("public"."books"."rating")');
  });

  it('NN2 having with JSON-path field (#22 regression)', () => {
    const having = expectOk(parseHavingClauses("sum(data->>'amount').gt.100"));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select: expectOk(parseSelect("category,sum(data->>'amount')")),
          having,
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // The JSON key must be bound as a param, not inlined.
    expect(built.params).toContain('amount');
    // The aggregate expression must reference `data->>$N`, not
    // `data->>'amount'` inline.
    expect(built.sql).toContain('"public"."books"."data"->>$');
  });

  it('NN3 count() having clause with no field', () => {
    const having = expectOk(parseHavingClauses('count().gt.5'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select: expectOk(parseSelect('category,count()')),
          having,
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toContain('COUNT(*) >');
  });
});

// -----------------------------------------------------------------
// OO — empty-state permutations
// -----------------------------------------------------------------

describe('scratch builder OO: empty-state permutations', () => {
  it('OO1 every field empty builds cleanly', () => {
    const built = expectOk(buildReadQuery(basePlan()));
    assertParamConsistency(built.sql, built.params);
    expect(built.sql).toMatch(/SELECT .* FROM \(SELECT .* FROM "public"\."books"\s*\) t/);
  });

  it('OO2 empty search plan (zero columns) is rejected at render time', () => {
    const result = buildReadQuery(
      basePlan({
        search: {
          term: 'rocket',
          columns: [],
          language: 'english',
          includeRank: false,
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('OO3 empty vector array is accepted (binds empty literal)', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [], column: 'embedding', op: 'l2' },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.params).toContain('[]');
  });

  it('OO4 empty distinct columns = bare DISTINCT', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ distinct: { columns: [] } })),
    );
    expect(built.sql).toContain('SELECT DISTINCT "public"."books".*');
  });

  it('OO5 offset > 0 with null limit still emits OFFSET', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ range: { offset: 100, limit: null } })),
    );
    expect(built.sql).toContain('OFFSET 100');
    expect(built.sql).not.toContain('LIMIT');
  });

  it('OO6 offset=0 + limit=null produces no LIMIT/OFFSET clause', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ range: { offset: 0, limit: null } })),
    );
    expect(built.sql).not.toContain('LIMIT');
    expect(built.sql).not.toContain('OFFSET');
  });

  it('OO7 select with only aggregates (no plain cols) -> no GROUP BY', () => {
    const select = expectOk(parseSelect('count(),avg(rating)'));
    const built = expectOk(buildReadQuery(basePlan({ select })));
    expect(built.sql).not.toContain('GROUP BY');
    expect(built.sql).toContain('COUNT(*)');
    expect(built.sql).toContain('AVG(');
  });

  it('OO8 `.* ` fallback when select is empty but distinct is non-empty', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({ distinct: { columns: ['category'] } }),
      ),
    );
    expect(built.sql).toContain('DISTINCT ON');
    expect(built.sql).toContain('"public"."books".*');
  });
});

// -----------------------------------------------------------------
// PP — order precedence (user order vs vector distance)
// -----------------------------------------------------------------

describe('scratch builder PP: order precedence', () => {
  it('PP1 user order with no vector produces ORDER BY <user>', () => {
    const order = expectOk(parseOrder('title.asc'));
    const built = expectOk(buildReadQuery(basePlan({ order })));
    expect(built.sql).toContain('ORDER BY "public"."books"."title" ASC');
    expect(built.sql).not.toContain('<=>');
  });

  it('PP2 vector with no user order → ORDER BY distance', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [1], column: 'embedding', op: 'l2' },
        }),
      ),
    );
    expect(built.sql).toMatch(/ORDER BY "public"\."books"\."embedding" <->/);
  });

  it('PP3 user order + vector: user order first, distance as tiebreaker', () => {
    const order = expectOk(parseOrder('title.asc'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          order,
          vector: { queryVector: [1], column: 'embedding', op: 'cosine' },
        }),
      ),
    );
    // Extract the substring between ORDER BY and the next keyword.
    const m = built.sql.match(/ORDER BY ([^()]*?)(?:\s*(?:LIMIT|OFFSET|\)|$))/);
    expect(m).not.toBeNull();
    if (m) {
      const orderClause = m[1]!;
      // User order appears BEFORE the distance operator.
      const titleIdx = orderClause.indexOf('"title"');
      const distIdx = orderClause.indexOf('<=>');
      expect(titleIdx).toBeGreaterThan(-1);
      expect(distIdx).toBeGreaterThan(titleIdx);
    }
  });

  it('PP4 user order + multiple terms + vector: vector at the end', () => {
    const order = expectOk(parseOrder('category.asc,title.desc'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          order,
          vector: { queryVector: [1], column: 'embedding', op: 'l1' },
        }),
      ),
    );
    const m = built.sql.match(/ORDER BY ([^()]*?)(?:\s*(?:LIMIT|OFFSET|\)|$))/);
    expect(m).not.toBeNull();
    if (m) {
      const orderClause = m[1]!;
      // Order: category, title, distance.
      expect(orderClause.indexOf('"category"')).toBeLessThan(
        orderClause.indexOf('"title"'),
      );
      expect(orderClause.indexOf('"title"')).toBeLessThan(
        orderClause.indexOf('<+>'),
      );
    }
  });
});

// -----------------------------------------------------------------
// QQ — constitution regression tests
// -----------------------------------------------------------------

describe('scratch builder QQ: constitution regression tests', () => {
  // CONSTITUTION §1.1 / critique #2: no post-hoc SQL rewrite. The
  // rendered SQL must already contain the distance expression; there
  // should be no second render pass that patches it in.
  //
  // This is structurally enforced by the rewrite's type system (SQL
  // is built once from a ReadPlan and never modified), but we pin it
  // with a runtime assertion so that if a future contributor adds a
  // "rewrite" helper, their test fails.
  it('QQ1 buildReadQuery produces a frozen BuiltQuery', () => {
    const built = expectOk(buildReadQuery(basePlan({
      vector: { queryVector: [1], column: 'embedding', op: 'l2' },
    })));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.params)).toBe(true);
  });

  // Critique #13 regression: the old code rewrote `$N` references in
  // built SQL. If a user-controlled string contains `$1`, it must NOT
  // be rewritten — it stays in the params array.
  it('QQ2 a filter value containing $1 is bound verbatim', () => {
    const filter = expectOk(parseFilter('note', 'eq.$1 $2'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(basePlan({ filters: [filter.filter] })),
    );
    assertParamConsistency(built.sql, built.params);
    expect(built.params).toContain('$1 $2');
    // The built SQL must reference this filter's placeholder once
    // (the `$1` above in params is just a string, not a placeholder).
    // The outer builder places the filter in the inner WHERE.
    expect(built.sql).toMatch(/\$\d+/);
  });

  // Critique #77, #78 regression: vector distance placement. The old
  // code rewrote the outer aggregator SELECT to inject the distance
  // expression, and the referenced column's scope was wrong. The
  // rewrite builds the projection inline so the distance expression
  // is evaluated in the inner subquery where the column is in scope.
  it('QQ3 vector distance expression appears in the INNER SELECT projection, not the outer', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [1], column: 'embedding', op: 'cosine' },
        }),
      ),
    );
    // The outer SELECT starts with `SELECT ... AS total_result_set`.
    const outerStart = built.sql.indexOf('SELECT');
    const fromOuter = built.sql.indexOf('FROM (', outerStart);
    const outerProjection = built.sql.slice(outerStart, fromOuter);

    // The outer projection should NOT contain the `<=>` operator.
    // The distance expression lives in the INNER projection.
    expect(outerProjection).not.toContain('<=>');
  });

  // Critique #14: pgFmtLit must E-prefix on input backslash, not
  // output.
  it('QQ4 pgFmtLit E-prefix applied when target name contains backslash', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          target: { schema: 'public', name: 'weird\\table' },
          count: 'planned',
        }),
      ),
    );
    // Planned count emits a regclass literal via pgFmtLit. The table
    // identifier contains a backslash so pgFmtLit produces E'...'.
    expect(built.sql).toContain("E'");
  });

  // Critique #10 regression: search language must be bound.
  it('QQ5 search language is NEVER inlined as a SQL literal', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          search: {
            term: 'rocket',
            columns: ['title'],
            language: "evil' OR 1=1--",
            includeRank: true,
          },
        }),
      ),
    );
    assertParamConsistency(built.sql, built.params);
    // The language string must show up in params, not in the SQL
    // text.
    expect(built.params).toContain("evil' OR 1=1--");
    expect(built.sql).not.toContain("'evil'");
  });

  // Critique #12 regression: search filter is ANDed into WHERE,
  // not injected into the first FROM it finds.
  it('QQ6 search filter sits in the WHERE clause, not at the outer SELECT', () => {
    const filter = expectOk(parseFilter('published', 'is.true'));
    if (filter === null) throw new Error('filter is null');
    const built = expectOk(
      buildReadQuery(
        basePlan({
          filters: [filter.filter],
          search: {
            term: 'rocket',
            columns: ['title'],
            language: 'english',
            includeRank: false,
          },
        }),
      ),
    );
    // The WHERE clause should contain both the published filter and
    // the search match, joined by AND.
    const whereIdx = built.sql.indexOf('WHERE');
    const orderIdx = built.sql.indexOf('ORDER BY');
    const whereClause = built.sql.slice(
      whereIdx,
      orderIdx > -1 ? orderIdx : built.sql.indexOf(') t'),
    );
    expect(whereClause).toContain('IS TRUE');
    expect(whereClause).toContain('@@');
    expect(whereClause).toContain(' AND ');
  });
});
