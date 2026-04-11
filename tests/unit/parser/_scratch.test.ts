// SCRATCH — exploratory probes for parser behavior.
// Delete or convert into proper regression tests after the analysis pass.
//
// Organization: the original 100-test set from the first pass plus a
// "pass 2" set that targets specific bug suspicions I want to confirm
// empirically rather than reason about from source.
//
// Tests here use console.log so the full parsed shape is visible in the
// test output; asserting-as-you-go would hide the bugs we're hunting.

import { describe, expect, it } from 'vitest';
import { splitTopLevel, splitInValues, strictParseInt, strictParseNonNegInt } from '../../../src/parser/tokenize';
import { parseOpExpr } from '../../../src/parser/operators';
import { parseSelect } from '../../../src/parser/select';
import { parseOrder } from '../../../src/parser/order';
import { parseLogicTree } from '../../../src/parser/logic';
import { parseField } from '../../../src/parser/json-path';
import { parseHavingClauses } from '../../../src/parser/having';
import { parseFilter } from '../../../src/parser/filter';

const log = (label: string, value: unknown): void => {
  console.log(label, JSON.stringify(value));
};

// -----------------------------------------------------------------
// PASS 1 — original broad sweep
// -----------------------------------------------------------------

describe('scratch pass 1: tokenize', () => {
  it('splitTopLevel — orphan close paren does not crash', () => {
    log('orphan close:', splitTopLevel('a,b),c', ','));
  });

  it('splitTopLevel — negative depth state after orphan', () => {
    log('after orphan:', splitTopLevel('a),(b,c),d', ','));
  });

  it('splitTopLevel — empty input', () => {
    const r = splitTopLevel('', ',');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('splitTopLevel — trailing separator', () => {
    log('trailing:', splitTopLevel('a,b,', ','));
  });

  it('splitTopLevel — leading separator', () => {
    log('leading:', splitTopLevel(',a,b', ','));
  });

  it('splitTopLevel — all one character', () => {
    log('all separators:', splitTopLevel(',,,', ','));
  });

  it('splitTopLevel — double quote inside normal field (SQL style)', () => {
    log('stray quote:', splitTopLevel('a"b,c', ','));
  });

  it('splitTopLevel — separator as identifier content', () => {
    const r = splitTopLevel('"a,b",c', ',');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['"a,b"', 'c']);
  });

  it('splitInValues — trailing comma', () => {
    log('in trailing comma:', splitInValues('a,b,'));
  });

  it('splitInValues — empty string', () => {
    log('in empty:', splitInValues(''));
  });

  it('splitInValues — all empties', () => {
    log('in all empties:', splitInValues(',,,,'));
  });

  it('splitInValues — quoted empty string', () => {
    log('in quoted empty:', splitInValues('""'));
  });

  it('strictParseInt — leading zero', () => {
    expect(strictParseInt('007')).toBe(7);
  });

  it('strictParseInt — negative zero', () => {
    expect(strictParseInt('-0')).toBe(-0);
  });

  it('strictParseInt — empty string', () => {
    expect(strictParseInt('')).toBeNull();
  });

  it('strictParseInt — whitespace', () => {
    expect(strictParseInt(' 5 ')).toBeNull();
  });

  it('strictParseNonNegInt — negative', () => {
    expect(strictParseNonNegInt('-5')).toBeNull();
  });

  it('strictParseNonNegInt — zero', () => {
    expect(strictParseNonNegInt('0')).toBe(0);
  });

  it('strictParseNonNegInt — MAX_SAFE_INTEGER + 1', () => {
    expect(strictParseNonNegInt('9007199254740992')).toBeNull();
  });
});

describe('scratch pass 1: operators', () => {
  it('eq with empty string value', () => {
    log('eq empty:', parseOpExpr('eq.'));
  });

  it('in with no parens', () => {
    log('in no parens:', parseOpExpr('in.a,b,c'));
  });

  it('in with malformed parens', () => {
    log('in unclosed:', parseOpExpr('in.(a,b'));
  });

  it('is.NULL (uppercase)', () => {
    log('is NULL:', parseOpExpr('is.NULL'));
  });

  it('fts language injection attempt', () => {
    log('fts bad lang:', parseOpExpr("fts(english').word"));
  });

  it('unknown operator — too long', () => {
    log('too long op:', parseOpExpr('reallyreallylong.val'));
  });

  it('unknown operator — too short', () => {
    log('too short op:', parseOpExpr('a.val'));
  });

  it('in.() empty list', () => {
    log('in empty:', parseOpExpr('in.()'));
  });

  it('not.not.eq.5 — double negation', () => {
    log('double not:', parseOpExpr('not.not.eq.5'));
  });

  it('eq without dot at all', () => {
    log('eq alone:', parseOpExpr('eq'));
  });

  it('geo.dwithin with extra whitespace', () => {
    log('geo spaces:', parseOpExpr('geo.dwithin( 1 , 2 , 3 )'));
  });

  it('geo.intersects with nested parens (GeoJSON body)', () => {
    log('geo geojson:', parseOpExpr('geo.intersects.{"type":"Polygon","coordinates":[[[1,2],[3,4]]]}'));
  });

  it('fts with language containing injection', () => {
    log('fts inject:', parseOpExpr("fts(en').word"));
  });
});

describe('scratch pass 1: select', () => {
  it('empty select', () => {
    expect(parseSelect('')).toEqual({ ok: true, value: [] });
  });

  it('wildcard', () => {
    expect(parseSelect('*')).toMatchObject({ ok: true, value: [{ type: 'field' }] });
  });

  it('canonical avg(rating)', () => {
    log('canonical agg:', parseSelect('book_id,avg(rating)'));
  });

  it('avg with JSON path', () => {
    log('agg json path:', parseSelect('avg(data->>price)'));
  });

  it('embed with dot in inner select', () => {
    log('embed:', parseSelect('author(name)'));
  });

  it('embed with alias and hint', () => {
    log('embed alias+hint:', parseSelect('writer:author!fk_author(name)'));
  });

  it('embed with join type', () => {
    log('embed inner:', parseSelect('author!inner(name)'));
  });

  it('embed with inner limit=0', () => {
    log('embed limit zero:', parseSelect('author(limit=0,name)'));
  });

  it('embed with inner limit=abc', () => {
    log('embed bad limit:', parseSelect('author(limit=abc,name)'));
  });

  it('nested embed with stray close paren in inner', () => {
    log('embed stray close:', parseSelect('author(name,extra))'));
  });

  it('count() with alias', () => {
    log('count alias:', parseSelect('total:count()'));
  });

  it('avg(rating)::float with cast after closing paren', () => {
    log('agg cast after:', parseSelect('avg(rating)::float'));
  });

  it('spread on aggregate', () => {
    log('spread:', parseSelect('...author(name)'));
  });

  it('colon in JSON path value', () => {
    log('colon in value:', parseSelect('data->>"a:b"'));
  });

  it('empty item in comma list', () => {
    log('empty item:', parseSelect('a,,b'));
  });

  it('select with just a comma', () => {
    log('just comma:', parseSelect(','));
  });

  it('double colon cast without column (edge)', () => {
    log('cast alone:', parseSelect('::int'));
  });

  it('embed where relation name contains numbers', () => {
    log('numeric rel:', parseSelect('items2(name)'));
  });

  it('embed with SQL injection-looking table name', () => {
    log('inject rel:', parseSelect('users;DROP TABLE(name)'));
  });

  it('count(*) literal', () => {
    log('count star:', parseSelect('count(*)'));
  });

  it('alias ending with :: that looks like a cast', () => {
    log('alias conflict:', parseSelect('x::int:col'));
  });

  it('count() with any argument', () => {
    log('count with arg:', parseSelect('count(x)'));
  });
});

describe('scratch pass 1: order', () => {
  it('simple col.desc', () => {
    log('simple desc:', parseOrder('col.desc'));
  });

  it('json path order with desc', () => {
    log('json desc:', parseOrder('data->>price.desc'));
  });

  it('relation order', () => {
    log('rel desc:', parseOrder('author(name).desc'));
  });

  it('relation name with numbers', () => {
    log('rel2:', parseOrder('author2(name).desc'));
  });

  it('order with just direction', () => {
    log('just mod:', parseOrder('.desc'));
  });

  it('order with duplicate direction', () => {
    log('dup dir:', parseOrder('col.asc.desc'));
  });

  it('order with unknown modifier', () => {
    log('unknown mod:', parseOrder('col.foo'));
  });

  it('order empty', () => {
    expect(parseOrder('')).toEqual({ ok: true, value: [] });
  });

  it('order with trailing dot', () => {
    log('trailing dot:', parseOrder('col.'));
  });

  it('order with embedded table containing dot', () => {
    log('json full:', parseOrder("data->'a'->>'b'.desc.nullsfirst"));
  });

  it('relation order with nested paren content', () => {
    log('nested paren order:', parseOrder('rel(a(b)).desc'));
  });

  it('case sensitivity of modifiers', () => {
    log('uppercase desc:', parseOrder('col.DESC'));
  });

  it('arrow path with nullsfirst', () => {
    log('arrow nulls:', parseOrder('data->key.nullsfirst'));
  });
});

describe('scratch pass 1: logic', () => {
  it('flat and', () => {
    log('flat and:', parseLogicTree('and', false, '(col.eq.1,col2.gt.5)'));
  });

  it('nested or inside and (regression #70)', () => {
    log('nested:', parseLogicTree('and', false, '(col.eq.1,or(col2.gt.5,col3.lt.0))'));
  });

  it('empty group', () => {
    log('empty:', parseLogicTree('and', false, '()'));
  });

  it('deeply nested', () => {
    log('deep:', parseLogicTree('and', false, '(or(and(col.eq.1,col.eq.2),col.eq.3))'));
  });

  it('filter with dot in json path', () => {
    log('json filter:', parseLogicTree('and', false, '(data->>key.eq.value)'));
  });

  it('leaf that is not a filter at all', () => {
    log('bad leaf:', parseLogicTree('and', false, '(notafilter)'));
  });

  it('not.and nested', () => {
    log('not.and nested:', parseLogicTree('and', false, '(not.and(col.eq.1,col.eq.2))'));
  });

  it('not.not.and nested — double negation through prefix', () => {
    log('not not:', parseLogicTree('and', false, '(not.not.col.eq.5)'));
  });

  it('leaf that looks like a function call but is not and/or', () => {
    log('fake nested:', parseLogicTree('and', false, '(author(name))'));
  });

  it('unbalanced parens in nested content', () => {
    log('unbalanced:', parseLogicTree('and', false, '(or(col.eq.1)'));
  });
});

describe('scratch pass 1: json path', () => {
  it('plain column', () => {
    const r = parseField('col');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: 'col', jsonPath: [] });
  });

  it('single arrow', () => {
    log('arrow:', parseField('data->key'));
  });

  it('single double-arrow', () => {
    log('double arrow:', parseField('data->>key'));
  });

  it('quoted key', () => {
    log('quoted:', parseField('data->"weird key"'));
  });

  it('quoted key with escaped quote', () => {
    log('escaped quote:', parseField('data->"weird""key"'));
  });

  it('numeric index', () => {
    log('index:', parseField('arr->0'));
  });

  it('numeric string that is not an index', () => {
    log('quoted num:', parseField('arr->"0"'));
  });

  it('arrow with no key after', () => {
    log('dangling arrow:', parseField('col->'));
  });

  it('arrow then double arrow', () => {
    log('mixed arrows:', parseField('data->key->>val'));
  });

  it('three levels deep', () => {
    log('three levels:', parseField("data->'a'->'b'->>'c'"));
  });

  it('column name starting with ->', () => {
    log('starts with arrow:', parseField('->key'));
  });

  it('double arrow at start', () => {
    log('starts with double:', parseField('->>key'));
  });
});

describe('scratch pass 1: having', () => {
  it('simple count', () => {
    log('count gt:', parseHavingClauses('count().gt.5'));
  });

  it('sum with column', () => {
    log('sum:', parseHavingClauses('sum(total).gte.1000'));
  });

  it('multiple having', () => {
    log('multiple:', parseHavingClauses('count().gt.5,sum(total).gte.1000'));
  });

  it('unknown aggregate', () => {
    log('unknown agg:', parseHavingClauses('median(x).gt.5'));
  });

  it('aggregate with dot inside column', () => {
    log('gt decimal:', parseHavingClauses('avg(rating).gt.5.0'));
  });

  it('having with nested parens in column', () => {
    log('json having:', parseHavingClauses('sum(data->>"a,b").gt.5'));
  });

  it('not.count().gt.5 (negation prefix)', () => {
    log('not count:', parseHavingClauses('not.count().gt.5'));
  });

  it('having with spaces', () => {
    log('spaced:', parseHavingClauses('count() . gt . 5'));
  });

  it('empty aggregate argument with count', () => {
    log('count empty:', parseHavingClauses('count().gt.5'));
  });

  it('sum with count-style empty args', () => {
    log('sum empty:', parseHavingClauses('sum().gt.5'));
  });

  it('having with only an aggregate, no operator', () => {
    log('no op:', parseHavingClauses('count()'));
  });
});

// -----------------------------------------------------------------
// PASS 2 — probes targeting specific bug suspicions
// Each group below is hunting a class of bug I noticed in pass 1.
// -----------------------------------------------------------------

// BUG CATEGORY A: splitTopLevel negative-depth state is sticky.
// Observation: `splitTopLevel('a),(b,c),d', ',')` returned
// `['a),(b', 'c),d']` — depth went to -1 on the first `)`, then the
// `(` bumped it to 0, so the comma inside "b,c" became a split point.
// This means any stray close paren poisons the whole rest of the input.
describe('scratch pass 2: splitTopLevel negative-depth sticky state', () => {
  it('one stray `)` plus later balanced group', () => {
    // If depth were clamped to >= 0, we'd expect ['a)', '(b', 'c)', 'd'].
    log('A1 stray then group:', splitTopLevel('a),(b,c),d', ','));
  });

  it('two stray `)` in a row', () => {
    log('A2 two strays:', splitTopLevel('a)),b,c', ','));
  });

  it('stray close inside a legitimate group', () => {
    // (a,b),c — should split on the top-level comma between ) and c.
    // Works correctly here, posted for comparison.
    log('A3 normal:', splitTopLevel('(a,b),c', ','));
  });

  it('balanced group followed by stray close', () => {
    // (a,b),c) — the trailing ) sends depth to -1 at end but no more commas.
    log('A4 trailing stray:', splitTopLevel('(a,b),c)', ','));
  });

  it('nested stray close inside a group', () => {
    // (a,b)),c — inside the group depth drops from 1 to 0 early and then
    // to -1 at the second ), followed by a top-level comma.
    log('A5 inside group:', splitTopLevel('(a,b)),c', ','));
  });
});

// BUG CATEGORY B: eq.<empty> silently accepts empty-string filter.
// Observation: `parseOpExpr('eq.')` returns
// `{ type: 'opQuant', operator: 'eq', value: '' }` — accepted with no
// warning. Is this intended (matching an empty column) or a footgun?
describe('scratch pass 2: empty-string operator values', () => {
  it('eq.<empty>', () => {
    log('B1 eq empty:', parseOpExpr('eq.'));
  });

  it('gt.<empty>', () => {
    log('B2 gt empty:', parseOpExpr('gt.'));
  });

  it('like.<empty>', () => {
    log('B3 like empty:', parseOpExpr('like.'));
  });

  it('fts.<empty>', () => {
    log('B4 fts empty:', parseOpExpr('fts.'));
  });

  it('is.<empty>', () => {
    log('B5 is empty:', parseOpExpr('is.'));
  });

  it('in.<empty>', () => {
    log('B6 in empty:', parseOpExpr('in.'));
  });

  it('isdistinct.<empty>', () => {
    log('B7 isdistinct empty:', parseOpExpr('isdistinct.'));
  });
});

// BUG CATEGORY C: operator without a dot is ambiguous.
// Observation: `parseOpExpr('eq')` returns an eq operation with empty
// value — the dotIdx=-1 branch calls tryParseOperation('eq', '') and
// succeeds. But `parseOpExpr('eqq')` returns null (not a recognized op),
// and `parseOpExpr('reallyreallylong')` returns null too.
// This means any filter that happens to use a bare operator name as its
// value becomes an empty-value operation instead of an RPC param.
describe('scratch pass 2: bare-operator ambiguity', () => {
  it('bare `eq`', () => {
    log('C1 bare eq:', parseOpExpr('eq'));
  });

  it('bare `is`', () => {
    log('C2 bare is:', parseOpExpr('is'));
  });

  it('bare `in`', () => {
    log('C3 bare in:', parseOpExpr('in'));
  });

  it('bare `isdistinct`', () => {
    log('C4 bare isdistinct:', parseOpExpr('isdistinct'));
  });

  it('bare `fts`', () => {
    log('C5 bare fts:', parseOpExpr('fts'));
  });

  it('bare value `hello` (typo-shaped)', () => {
    // Short enough to pass the [a-z]{2,12} operator-shape gate —
    // does it return an error or null?
    log('C6 bare hello:', parseOpExpr('hello'));
  });
});

// BUG CATEGORY D: colon handling in select alias vs JSON path.
// Observation: `parseSelect('data->>"a:b"')` produced:
//   { name: 'b"', alias: 'data->>"a' }
// The alias detection grabs the first colon, even though the colon is
// inside a quoted JSON-path key. This corrupts the field entirely.
describe('scratch pass 2: colon inside JSON-path keys', () => {
  it('D1 colon inside quoted key', () => {
    log('D1:', parseSelect('data->>"a:b"'));
  });

  it('D2 colon inside single-quoted key', () => {
    log('D2:', parseSelect("data->>'a:b'"));
  });

  it('D3 alias + colon inside key', () => {
    log('D3:', parseSelect('x:data->>"a:b"'));
  });

  it('D4 URL where alias is the only sensible reading', () => {
    log('D4:', parseSelect('x:data'));
  });

  it('D5 colon after arrow but before key', () => {
    log('D5:', parseSelect('data->>:something'));
  });
});

// BUG CATEGORY E: `count(x)` is accepted as an aggregate function.
// Observation: `parseSelect('count(x)')` returns:
//   { type: 'field', field: { name: 'x' }, aggregateFunction: 'count' }
// But `count(x)` is not a canonical PostgREST form — `count()` is
// shorthand for `count(*)`. PostgREST accepts `count()` only, not
// `count(<column>)`. Is this a spec deviation?
describe('scratch pass 2: count() vs count(x)', () => {
  it('E1 count()', () => {
    log('E1:', parseSelect('count()'));
  });

  it('E2 count(*)', () => {
    log('E2:', parseSelect('count(*)'));
  });

  it('E3 count(x) — column name, possibly not standard', () => {
    log('E3:', parseSelect('count(x)'));
  });

  it('E4 count(data->>key) — with JSON path', () => {
    log('E4:', parseSelect('count(data->>key)'));
  });
});

// BUG CATEGORY F: select regex for embed accepts inner/left only as
// second segment. `alias:rel!hint(...)` works. But what about
// `alias:rel!inner!hint(...)` (join type BEFORE hint)?
// And what about `rel!unknown(...)` — unknown second-segment word?
describe('scratch pass 2: embed join/hint combinations', () => {
  it('F1 rel!inner', () => {
    log('F1:', parseSelect('rel!inner(name)'));
  });

  it('F2 rel!left', () => {
    log('F2:', parseSelect('rel!left(name)'));
  });

  it('F3 rel!hint!inner', () => {
    log('F3:', parseSelect('rel!fk_myhint!inner(name)'));
  });

  it('F4 rel!inner!hint — reverse order', () => {
    log('F4:', parseSelect('rel!inner!fk_myhint(name)'));
  });

  it('F5 rel!unknown — not inner/left and not a hint-looking token', () => {
    // The regex accepts any [a-zA-Z_]\w* so it becomes a hint, but a
    // future reader may mistakenly think `rel!unknown(*)` is an error.
    log('F5:', parseSelect('rel!unknown(name)'));
  });

  it('F6 rel!full(name) — join type "full" isn\'t allowed', () => {
    log('F6:', parseSelect('rel!full(name)'));
  });

  it('F7 empty hint — rel!(name)', () => {
    log('F7:', parseSelect('rel!(name)'));
  });

  it('F8 multiple bangs', () => {
    log('F8:', parseSelect('rel!a!b!c(name)'));
  });
});

// BUG CATEGORY G: select items with stray close paren at top level.
// Observation: `parseSelect('author(name,extra))')` returned:
//   [{ type: 'relation', innerSelect: [name, extra) ] }]
// i.e., the trailing `)` was shoved into a field name `extra)`. The
// embed detection uses endsWith(')') so the trailing paren made the
// whole thing look balanced. This is an injection surface if the
// field name flows into SQL as an identifier without escaping.
describe('scratch pass 2: unbalanced parens in select', () => {
  it('G1 extra close paren inside inner', () => {
    log('G1:', parseSelect('author(name,extra))'));
  });

  it('G2 embed followed by top-level stray close', () => {
    log('G2:', parseSelect('author(name),extra)'));
  });

  it('G3 open paren without close', () => {
    log('G3:', parseSelect('author(name,extra'));
  });

  it('G4 multiple nested unbalanced', () => {
    log('G4:', parseSelect('a(b(c))'));
  });

  it('G5 close paren before open', () => {
    log('G5:', parseSelect(')author(name)'));
  });
});

// BUG CATEGORY H: order parser on json paths uses substring `->` to
// detect json — but the `->` could appear anywhere. Does the modifier
// extraction walk work when the column name itself has `->>` and the
// value contains multiple known-modifier-looking dots?
describe('scratch pass 2: order parser edge cases', () => {
  it('H1 json path with just the column', () => {
    log('H1:', parseOrder('data->>key'));
  });

  it('H2 json path with desc', () => {
    log('H2:', parseOrder('data->>key.desc'));
  });

  it('H3 json path where key is literally "desc"', () => {
    // data->>"desc" — the key name is the word "desc". If the order
    // modifier walker lowercases segments and compares to the allowlist,
    // it may pop "desc" out of the field name and treat it as a direction.
    log('H3:', parseOrder('data->>"desc"'));
  });

  it('H4 json path where key is "asc"', () => {
    log('H4:', parseOrder('data->>asc'));
  });

  it('H5 relation with spaces in modifier', () => {
    log('H5:', parseOrder('rel(name) .desc'));
  });

  it('H6 trailing dot after json', () => {
    log('H6:', parseOrder('data->>key.'));
  });

  it('H7 relation order with nested paren — the [^)] regex problem', () => {
    log('H7:', parseOrder('rel(func(arg)).desc'));
  });

  it('H8 multiple order terms with one bad', () => {
    log('H8:', parseOrder('col.desc,col2.badmod'));
  });

  it('H9 empty term between commas', () => {
    log('H9:', parseOrder('col.desc,,col2.asc'));
  });
});

// BUG CATEGORY I: logic tree leaf with `not.not.col.eq.5`.
// Observation: returns error "unknown operator 'col'". The leaf parser
// strips one `not.`, then finds `not.col.eq.5` — splits on first dot
// to `not` / `col.eq.5`, tries to parse `not` as an operator, fails.
// PostgREST doesn't support chained `not.not` so this is arguably
// correct, but the error message is nonsense.
describe('scratch pass 2: logic leaf edge cases', () => {
  it('I1 not.not.col.eq.5', () => {
    log('I1 not not:', parseLogicTree('and', false, '(not.not.col.eq.5)'));
  });

  it('I2 leaf with column name containing `not`', () => {
    log('I2:', parseLogicTree('and', false, '(not_a_col.eq.5)'));
  });

  it('I3 leaf with just a dot', () => {
    log('I3:', parseLogicTree('and', false, '(.)'));
  });

  it('I4 leaf with column but no operator', () => {
    log('I4:', parseLogicTree('and', false, '(col)'));
  });

  it('I5 unbalanced inner paren — `(or(col.eq.1)`', () => {
    // The outer parses as a leaf `or(col.eq.1` — no close paren,
    // so parenIdx > 0 and endsWith(')') is false, falls to leaf branch.
    log('I5 unbalanced:', parseLogicTree('and', false, '(or(col.eq.1)'));
  });
});

// BUG CATEGORY J: having parser pattern uses [^)] inside parens.
// Observation: `parseHavingClauses('sum(data->>"a,b").gt.5')` actually
// worked because the regex still matched — but what about a column
// name that contains a close paren via quoted key?
describe('scratch pass 2: having regex limits', () => {
  it('J1 sum(data->>"a,b")', () => {
    log('J1:', parseHavingClauses('sum(data->>"a,b").gt.5'));
  });

  it('J2 column name with literal close paren in quoted key', () => {
    log('J2:', parseHavingClauses('sum(data->>"a)b").gt.5'));
  });

  it('J3 nested aggregate — sum(max(x))', () => {
    log('J3:', parseHavingClauses('sum(max(x)).gt.5'));
  });

  it('J4 multiple havings with a bad one in the middle', () => {
    log('J4:', parseHavingClauses('count().gt.5,median(x).lt.5,sum(y).gt.0'));
  });

  it('J5 having with not. on operator', () => {
    log('J5:', parseHavingClauses('count().not.eq.5'));
  });
});

// BUG CATEGORY K: filter parser uses key.split('.') for the embed path.
// But column names can contain dots if they're JSON paths? No — JSON
// paths use `->` not `.`. Still, a column name is the LAST segment, so
// any intermediate segments become the embed path. What happens with
// a field that happens to collide with a known nested name?
describe('scratch pass 2: filter parser path extraction', () => {
  it('K1 single-segment filter', () => {
    log('K1:', parseFilter('id', 'eq.5'));
  });

  it('K2 two-segment (embed.field)', () => {
    log('K2:', parseFilter('posts.id', 'eq.5'));
  });

  it('K3 three-segment (embed.embed.field)', () => {
    log('K3:', parseFilter('posts.comments.id', 'eq.5'));
  });

  it('K4 empty key', () => {
    log('K4:', parseFilter('', 'eq.5'));
  });

  it('K5 key with only a dot', () => {
    log('K5:', parseFilter('.', 'eq.5'));
  });

  it('K6 key with leading dot', () => {
    log('K6:', parseFilter('.id', 'eq.5'));
  });

  it('K7 key with trailing dot', () => {
    log('K7:', parseFilter('id.', 'eq.5'));
  });

  it('K8 key with consecutive dots', () => {
    log('K8:', parseFilter('a..b', 'eq.5'));
  });

  it('K9 key that looks like a JSON path (the parser does not unwrap ->)', () => {
    log('K9:', parseFilter('data->>key', 'eq.5'));
  });

  it('K10 key that is actually a JSON-path field', () => {
    log('K10:', parseFilter('data->>price', 'gt.5'));
  });
});

// BUG CATEGORY L: splitInValues drops the quoted empty string.
// Observation: `splitInValues('""')` returned [] — the filter dropped
// a legitimate empty-string value. This means `in.("")` would be
// equivalent to `in.()`, which is wrong — one is "match the empty
// string", the other is "match nothing".
describe('scratch pass 2: splitInValues empty-string semantics', () => {
  it('L1 single quoted empty', () => {
    log('L1:', splitInValues('""'));
  });

  it('L2 quoted empty then value', () => {
    log('L2:', splitInValues('"",a'));
  });

  it('L3 value then quoted empty', () => {
    log('L3:', splitInValues('a,""'));
  });

  it('L4 two quoted empties', () => {
    log('L4:', splitInValues('"",""'));
  });

  it('L5 mix of empty, quoted empty, unquoted value', () => {
    log('L5:', splitInValues(',"",a'));
  });
});

// BUG CATEGORY M: select alias regex detects `::` before `:`.
// Observation: `parseSelect('x::int:col')` returned cast='int:col'.
// The indexOf(':') finds the first `:`, but then the next-char check
// for `::` catches it and skips. But it doesn't keep searching — so a
// later real alias after the cast is missed.
describe('scratch pass 2: select cast/alias disambiguation', () => {
  it('M1 cast before alias', () => {
    log('M1:', parseSelect('x::int'));
  });

  it('M2 alias before cast', () => {
    log('M2:', parseSelect('alias:x::int'));
  });

  it('M3 both (legit PostgREST form)', () => {
    log('M3:', parseSelect('alias:col::int'));
  });

  it('M4 cast followed by alias-looking tail', () => {
    log('M4:', parseSelect('col::type:alias'));
  });

  it('M5 double cast', () => {
    log('M5:', parseSelect('col::int::float'));
  });
});

// BUG CATEGORY N: json path parser allows name starting with `->`.
// Observation: `parseField('->key')` returned { name: '->key' }. The
// split-ahead regex /(?=->)/ keeps the `->` with the next segment, so
// if the input STARTS with `->`, there's nothing to split and the
// whole string becomes the column name.
describe('scratch pass 2: json path with leading arrow', () => {
  it('N1 leading arrow', () => {
    log('N1:', parseField('->key'));
  });

  it('N2 leading double-arrow', () => {
    log('N2:', parseField('->>key'));
  });

  it('N3 only arrow', () => {
    log('N3:', parseField('->'));
  });

  it('N4 only double-arrow', () => {
    log('N4:', parseField('->>'));
  });

  it('N5 empty string', () => {
    log('N5:', parseField(''));
  });
});

// BUG CATEGORY O: `not.in.()` matches everything, `in.()` matches
// nothing. This is the PostgREST semantic the old parser got right.
// Does this new parser preserve it? parseOpExpr returns `{ negated,
// operation: { type: 'in', values: [] } }` for both — negation is
// tracked, but does any downstream code treat empty `in` as "always
// false" and the negation flip it?
describe('scratch pass 2: in.() and not.in.() semantics', () => {
  it('O1 in.()', () => {
    log('O1:', parseOpExpr('in.()'));
  });

  it('O2 not.in.()', () => {
    log('O2:', parseOpExpr('not.in.()'));
  });

  it('O3 in.(a) single element', () => {
    log('O3:', parseOpExpr('in.(a)'));
  });

  it('O4 in.(,) — comma with empties on both sides', () => {
    log('O4:', parseOpExpr('in.(,)'));
  });

  it('O5 in.(a,)', () => {
    log('O5:', parseOpExpr('in.(a,)'));
  });

  it('O6 in.("")', () => {
    log('O6 in quoted empty:', parseOpExpr('in.("")'));
  });
});

// BUG CATEGORY P: fts with language regex pattern. The regex is
// /^(fts|plfts|phfts|wfts)\((\w+)\)$/i — `\w+` is `[A-Za-z0-9_]+`.
// PostgREST accepts language names that match the Postgres text search
// config names; those are generally snake_case. What about a hyphen?
// PostgREST doesn't allow hyphens. Does our grammar produce a helpful
// error or silently fall through to null?
describe('scratch pass 2: fts language edge cases', () => {
  it('P1 fts(english)', () => {
    log('P1:', parseOpExpr('fts(english).word'));
  });

  it('P2 fts(en_US)', () => {
    log('P2:', parseOpExpr('fts(en_US).word'));
  });

  it('P3 fts(en-US) — hyphen is not \\w', () => {
    log('P3:', parseOpExpr('fts(en-US).word'));
  });

  it('P4 fts() — empty language', () => {
    log('P4:', parseOpExpr('fts().word'));
  });

  it('P5 fts(english — unclosed', () => {
    log('P5:', parseOpExpr('fts(english.word'));
  });

  it('P6 fts(english) with no value', () => {
    log('P6:', parseOpExpr('fts(english).'));
  });
});

// BUG CATEGORY Q: quantifier operator like `eq(any)` — does every
// recognized operator work with a quantifier? The regex is
// /^(\w+)\((any|all)\)$/ so any word char works. Then the op name is
// checked against QUANT_OPS — only eq/gte/gt/lte/lt/like/ilike/match/
// imatch are in that set. So `neq(any)` is NOT in QUANT_OPS and
// becomes... what? Let's find out.
describe('scratch pass 2: quantifier support coverage', () => {
  it('Q1 eq(any)', () => {
    log('Q1:', parseOpExpr('eq(any).5'));
  });

  it('Q2 neq(any) — simple op, not in QUANT_OPS', () => {
    log('Q2:', parseOpExpr('neq(any).5'));
  });

  it('Q3 in(any) — nonsense but what happens', () => {
    log('Q3:', parseOpExpr('in(any).(1,2)'));
  });

  it('Q4 fts(any) — fts is FTS_OPS but the regex grabs it as quant shape', () => {
    // The quantMatch regex is /^(\w+)\((any|all)\)$/ — it also matches
    // `fts(any)` because "any" is a legal \w+. But fts has its own
    // language syntax `fts(english)`. Collision?
    log('Q4:', parseOpExpr('fts(any).word'));
  });

  it('Q5 eq(maybe) — bad quantifier', () => {
    log('Q5:', parseOpExpr('eq(maybe).5'));
  });
});

// BUG CATEGORY R: tokenize.splitTopLevel quote tracking skips past ``
// closing quote character. Let me verify a doubled-quote inside a
// quoted identifier stays inside the identifier.
describe('scratch pass 2: splitTopLevel quote state', () => {
  it('R1 simple quoted identifier', () => {
    log('R1:', splitTopLevel('"a","b"', ','));
  });

  it('R2 quoted identifier with comma inside', () => {
    log('R2:', splitTopLevel('"a,b","c"', ','));
  });

  it('R3 quoted identifier with doubled quote inside', () => {
    log('R3:', splitTopLevel('"a""b","c"', ','));
  });

  it('R4 unbalanced open quote — what happens at EOF?', () => {
    log('R4:', splitTopLevel('"unclosed,a,b', ','));
  });

  it('R5 quote inside parens', () => {
    log('R5:', splitTopLevel('f("a,b"),g', ','));
  });

  it('R6 escaped quote at end of identifier', () => {
    log('R6:', splitTopLevel('"a""","b"', ','));
  });
});

// BUG CATEGORY S: geo.dwithin uses Number() which accepts "Infinity",
// "1e2", hex, etc. Is Number.isFinite the right gate, and does it
// catch everything a user might try to inject into a geo query?
describe('scratch pass 2: geo numeric parsing permissiveness', () => {
  it('S1 integer args', () => {
    log('S1:', parseOpExpr('geo.dwithin(1,2,3)'));
  });

  it('S2 float args', () => {
    log('S2:', parseOpExpr('geo.dwithin(40.7128,-74.0060,500.5)'));
  });

  it('S3 scientific notation', () => {
    // Number('1e2') === 100. Probably fine but worth noting.
    log('S3:', parseOpExpr('geo.dwithin(1e2,2,3)'));
  });

  it('S4 hex notation', () => {
    // Number('0x10') === 16. Undesirable.
    log('S4:', parseOpExpr('geo.dwithin(0x10,2,3)'));
  });

  it('S5 Infinity', () => {
    // isFinite catches this — but only if it gets past Number().
    log('S5:', parseOpExpr('geo.dwithin(Infinity,2,3)'));
  });

  it('S6 NaN-producing string', () => {
    log('S6:', parseOpExpr('geo.dwithin(not_a_number,2,3)'));
  });

  it('S7 empty arg', () => {
    log('S7:', parseOpExpr('geo.dwithin(,,)'));
  });

  it('S8 arg count wrong', () => {
    log('S8:', parseOpExpr('geo.dwithin(1,2)'));
  });
});

// BUG CATEGORY T: parseHavingClauses uses splitTopLevel on raw, then
// trims each part. But the regex PATTERN is anchored to ^ and $, so
// a clause with leading whitespace should fail. Let me verify.
describe('scratch pass 2: having whitespace handling', () => {
  it('T1 leading whitespace in clause', () => {
    log('T1:', parseHavingClauses('  count().gt.5  '));
  });

  it('T2 whitespace inside parens (trimmed?)', () => {
    log('T2:', parseHavingClauses('count( ).gt.5'));
  });

  it('T3 whitespace in column name', () => {
    log('T3:', parseHavingClauses('sum( total ).gt.5'));
  });
});

// -----------------------------------------------------------------
// PASS 3 — injection-adjacent probes.
//
// Goal: surface what character sequences the parser ACCEPTS as
// identifiers (field names, table names, keys, aliases). The parser
// itself doesn't render SQL, so these probes cannot catch SQL
// injection — that lives in the builder layer. What they CAN catch:
//
//   1. Acceptance bugs: a field parser that accepts newlines, null
//      bytes, or SQL comment sequences without complaint. Those
//      characters should never appear in a real column name, and
//      every one the parser accepts becomes a liability at the
//      builder layer.
//
//   2. Shape bugs: a parser that silently truncates, splits, or
//      reorders nasty input. If the parser accepts `a"; DROP` as a
//      single column name, that's *fine* — the builder can still
//      escape it — but we need to know that so builder tests can
//      pass that exact string through.
//
//   3. Confusion bugs: a parser that treats an attacker-controlled
//      string differently depending on length, case, or substring
//      content.
//
// If any of these probes reveal the parser *rejecting* unsafe-but-
// syntactically-sensible input, good — the builder has less work.
// If any reveal the parser *accepting* something truly surprising,
// we either tighten the parser or add a builder-layer escape test.
// -----------------------------------------------------------------

describe('scratch pass 3: field/identifier acceptance surface', () => {
  it('U1 field name with single double-quote', () => {
    log('U1:', parseField('a"b'));
  });

  it('U2 field name with semicolon', () => {
    // Column names with ; aren't valid SQL but the parser doesn't know.
    log('U2:', parseField('a;DROP'));
  });

  it('U3 field name with SQL comment', () => {
    log('U3:', parseField('a-- comment'));
  });

  it('U4 field name with block comment', () => {
    log('U4:', parseField('a/*comment*/'));
  });

  it('U5 field name with newline', () => {
    log('U5:', parseField('a\nb'));
  });

  it('U6 field name with null byte', () => {
    log('U6:', parseField('a\x00b'));
  });

  it('U7 field name with backslash', () => {
    log('U7:', parseField('a\\b'));
  });

  it('U8 field name with unicode right-to-left override', () => {
    // U+202E — changes visual display, an identifier that shows as
    // `gniterht` but encodes as `thretning`.
    log('U8:', parseField('a\u202eb'));
  });

  it('U9 field name that is just backticks', () => {
    log('U9:', parseField('`col`'));
  });

  it('U10 empty field name', () => {
    log('U10:', parseField(''));
  });

  it('U11 field name with tab', () => {
    log('U11:', parseField('a\tb'));
  });

  it('U12 field name that equals a SQL keyword', () => {
    // `select`, `from`, `where` are legal Postgres column names when
    // quoted but reserved otherwise. Parser doesn't care, builder
    // has to escape.
    for (const kw of ['select', 'from', 'where', 'table', 'column']) {
      log(`U12 kw ${kw}:`, parseField(kw));
    }
  });
});

describe('scratch pass 3: alias/cast acceptance surface', () => {
  it('V1 alias with nested colon', () => {
    // `a:b:c` — first colon splits to alias=`a`, remaining=`b:c`.
    log('V1:', parseSelect('a:b:c'));
  });

  it('V2 alias with semicolon', () => {
    log('V2:', parseSelect('evil;alias:col'));
  });

  it('V3 alias containing spaces', () => {
    log('V3:', parseSelect('my alias:col'));
  });

  it('V4 cast with semicolon', () => {
    log('V4:', parseSelect('col::int;DROP'));
  });

  it('V5 cast containing comment', () => {
    log('V5:', parseSelect('col::int/*comment*/'));
  });

  it('V6 alias starting with non-ASCII', () => {
    log('V6:', parseSelect('альáс:col'));
  });

  it('V7 empty alias (`:col`)', () => {
    log('V7:', parseSelect(':col'));
  });

  it('V8 empty cast (`col::`)', () => {
    log('V8:', parseSelect('col::'));
  });

  it('V9 cast to a quoted type', () => {
    log('V9:', parseSelect('col::"weird type"'));
  });

  it('V10 cast with spaces', () => {
    log('V10:', parseSelect('col::double precision'));
  });

  it('V11 column name that looks like an aggregate call', () => {
    // `avg_rating` starts with `avg` — is it caught by the aggregate
    // allowlist?
    log('V11:', parseSelect('avg_rating'));
  });

  it('V12 cast with a newline', () => {
    log('V12:', parseSelect('col::\nint'));
  });
});

describe('scratch pass 3: embed/relation acceptance surface', () => {
  it('W1 table name with unicode combining marks', () => {
    log('W1:', parseSelect('rel\u0301(name)'));
  });

  it('W2 table name with null byte', () => {
    // The relation regex is /^[a-zA-Z_]\w*$/ — null byte shouldn\'t match.
    log('W2:', parseSelect('rel\x00(name)'));
  });

  it('W3 table name starting with a digit', () => {
    log('W3:', parseSelect('1rel(name)'));
  });

  it('W4 hint with semicolon', () => {
    log('W4:', parseSelect('rel!fk_evil;DROP(name)'));
  });

  it('W5 alias with SQL comment', () => {
    log('W5:', parseSelect('my--alias:rel(name)'));
  });

  it('W6 relation with path traversal', () => {
    log('W6:', parseSelect('../other(name)'));
  });

  it('W7 schema-qualified relation', () => {
    // `public.users(name)` — the dot in the relation name. Does the
    // embed regex reject it or accept it?
    log('W7:', parseSelect('public.users(name)'));
  });

  it('W8 table name that is a PostgreSQL reserved word', () => {
    log('W8:', parseSelect('order(id)'));
  });
});

describe('scratch pass 3: JSON path key acceptance surface', () => {
  it('X1 key with single quote inside double quotes', () => {
    log('X1:', parseField(`data->"a'b"`));
  });

  it('X2 key with newline inside double quotes', () => {
    log('X2:', parseField('data->"a\nb"'));
  });

  it('X3 key with a closing double quote not escaped', () => {
    // `data->"a"b"` — the parser should treat this as key `a`
    // followed by garbage or reject it.
    log('X3:', parseField('data->"a"b"'));
  });

  it('X4 key that is a SQL comment', () => {
    log('X4:', parseField(`data->"/* comment */"`));
  });

  it('X5 key containing JSON path metacharacters', () => {
    log('X5:', parseField(`data->"->->->"`));
  });

  it('X6 key containing array index syntax', () => {
    log('X6:', parseField(`data->"[0]"`));
  });

  it('X7 chained empty keys', () => {
    log('X7:', parseField('data->->->'));
  });

  it('X8 key with backslash-escape attempt', () => {
    log('X8:', parseField('data->"a\\"b"'));
  });

  it('X9 key with percent signs (LIKE metacharacters)', () => {
    log('X9:', parseField('data->"%admin%"'));
  });

  it('X10 quoted key containing a dollar sign', () => {
    // Relevant for the shift-param-refs code path — if a key
    // contains `$1`, does the downstream rewriter get confused?
    log('X10:', parseField('data->"$1::text"'));
  });
});

describe('scratch pass 3: operator-value acceptance surface', () => {
  it('Y1 like value with SQL LIKE metacharacters', () => {
    // `%` and `_` in LIKE are treated by SQL, not the parser. Parser
    // should pass through verbatim.
    log('Y1:', parseOpExpr('like.%admin%'));
  });

  it('Y2 ilike with double-quote in value', () => {
    log('Y2:', parseOpExpr('ilike.*a"b*'));
  });

  it('Y3 eq with newline in value', () => {
    log('Y3:', parseOpExpr('eq.a\nb'));
  });

  it('Y4 eq with null byte in value', () => {
    log('Y4:', parseOpExpr('eq.a\x00b'));
  });

  it('Y5 eq with very long value (1 MB)', () => {
    const big = 'a'.repeat(1_000_000);
    const r = parseOpExpr(`eq.${big}`);
    log('Y5 big eq:', { ok: r.ok });
  });

  it('Y6 eq value that is a dollar-sign placeholder', () => {
    // Relevant for later: a filter value of `$1` would be a literal
    // "$1" in SQL, not a bind-param reference. The parser doesn\'t
    // care, but we want to know the value survives verbatim.
    log('Y6:', parseOpExpr('eq.$1'));
  });

  it('Y7 eq value with E-string prefix', () => {
    // Postgres E-strings: `E'\\n'` interprets backslashes. A filter
    // value containing `E'...'` could be dangerous if a builder
    // inlines it. Parser should not decode the E.
    log('Y7:', parseOpExpr("eq.E'\\n'"));
  });

  it('Y8 match value with regex metacharacters', () => {
    log('Y8:', parseOpExpr('match.^(admin|root)$'));
  });

  it('Y9 in.() values with commas and quotes (CSV attack)', () => {
    log('Y9:', parseOpExpr('in.("a,b","c""d",e)'));
  });

  it('Y10 in.() value containing close paren', () => {
    // The parser\'s `in` handler slices by `val.endsWith(")")` ->
    // if the in value itself contains `)`, does it confuse the end?
    log('Y10:', parseOpExpr('in.("a)b",c)'));
  });
});

describe('scratch pass 3: cross-grammar confusion probes', () => {
  it('Z1 filter value with comma that looks like an IN list', () => {
    // `size=1,2,3` has no operator prefix, so it should be an RPC
    // param. The parser should NOT try to parse it as `in`.
    log('Z1:', parseFilter('size', '1,2,3'));
  });

  it('Z2 filter value with dot that looks like an op.value form', () => {
    log('Z2:', parseFilter('page', 'abc.def'));
  });

  it('Z3 filter value containing `and=(...)` shape', () => {
    // A value that LOOKS like a logic tree but lives at the filter
    // layer — should not be parsed as logic.
    log('Z3:', parseFilter('name', 'and.(fake)'));
  });

  it('Z4 key that contains embedded operator keyword', () => {
    // `not.col` as a key — if the parser assumes leading `not.` on a
    // KEY means negation-of-filter, that\'s a bug.
    log('Z4:', parseFilter('not.col', 'eq.5'));
  });

  it('Z5 key that is exactly "or"', () => {
    // `or=eq.5` — `or` is reserved for logic trees. Does the parser
    // reject this or treat `or` as a column?
    log('Z5:', parseFilter('or', 'eq.5'));
  });

  it('Z6 key that is exactly "select"', () => {
    log('Z6:', parseFilter('select', 'eq.5'));
  });

  it('Z7 key with embed path containing a dot-in-key', () => {
    // Ambiguity: `posts.comments.id=eq.5` is path=[posts,comments],
    // field=id. But what if a key is `a.b.c.d.e` with NO embeds?
    // Parser has no way to know — it assumes all dots are path.
    log('Z7:', parseFilter('a.b.c.d.e', 'eq.5'));
  });

  it('Z8 select with a column name that contains a comma (quoted)', () => {
    log('Z8:', parseSelect('"weird,col"'));
  });

  it('Z9 order on a column that is an aggregate name', () => {
    // `order=avg.desc` — the token `avg` is parsed as a column, not
    // as an aggregate. Good; pinning the behavior.
    log('Z9:', parseOrder('avg.desc'));
  });

  it('Z10 logic tree with a filter value that contains dots', () => {
    log('Z10:', parseLogicTree('and', false, '(version.eq.1.2.3)'));
  });
});

// -----------------------------------------------------------------
// PASS 4 — things the builder will have to escape.
//
// These probes feed the parser with inputs that are LEGAL ASTs but
// contain strings that must be safely escaped by the builder. The
// parser outputs here form a natural corpus for the builder-level
// escape tests. If the parser REJECTS any of them, note it — a
// rejection here is "the parser did the escape work for us."
// -----------------------------------------------------------------

describe('scratch pass 4: builder escape corpus — field names', () => {
  it('AA1 double-quoted identifier with escaped quote', () => {
    // `"evil""col"` — Postgres identifier escape form.
    log('AA1:', parseSelect('"evil""col"'));
  });

  it('AA2 mixed-case identifier', () => {
    log('AA2:', parseSelect('CamelCaseCol'));
  });

  it('AA3 identifier with leading underscore', () => {
    log('AA3:', parseSelect('_private_col'));
  });

  it('AA4 identifier with high-bit chars', () => {
    log('AA4:', parseSelect('café'));
  });

  it('AA5 identifier that is all digits', () => {
    // Postgres allows quoted identifiers that are all digits.
    log('AA5:', parseSelect('"123"'));
  });

  it('AA6 very long identifier', () => {
    const long = 'a'.repeat(128); // Postgres NAMEDATALEN is 63 by default
    log('AA6 len:', { len: long.length, r: parseSelect(long).ok });
  });

  it('AA7 identifier containing surrogate pair', () => {
    log('AA7:', parseSelect('🔥col'));
  });

  it('AA8 zero-width space in identifier', () => {
    log('AA8:', parseSelect('a\u200bb'));
  });
});

describe('scratch pass 4: builder escape corpus — values', () => {
  it('BB1 value with single quote', () => {
    log('BB1:', parseOpExpr("eq.o'brien"));
  });

  it('BB2 value with doubled single quote', () => {
    log('BB2:', parseOpExpr("eq.o''brien"));
  });

  it('BB3 value that looks like a SQL injection', () => {
    // This is the classic. The builder must escape it. The parser
    // should accept it as a literal value string.
    log('BB3:', parseOpExpr("eq.x' OR '1'='1"));
  });

  it('BB4 value with NULL bytes', () => {
    log('BB4:', parseOpExpr('eq.x\x00y'));
  });

  it('BB5 value with CRLF injection', () => {
    log('BB5:', parseOpExpr('eq.x\r\nDROP TABLE students'));
  });

  it('BB6 value that is a Postgres dollar-quoted string', () => {
    log('BB6:', parseOpExpr("eq.$$foo$$"));
  });

  it('BB7 value with E-string form', () => {
    log('BB7:', parseOpExpr("eq.E'\\x00'"));
  });

  it('BB8 value with format-string placeholders', () => {
    // `%s`, `%d` — irrelevant to Postgres but relevant if anything
    // ever JS-templates the value into SQL.
    log('BB8:', parseOpExpr('eq.%s%d'));
  });
});

describe('scratch pass 4: builder escape corpus — JSON path keys', () => {
  it('CC1 key with literal single quote', () => {
    log('CC1:', parseField("data->\"o'brien\""));
  });

  it('CC2 key with doubled double quote (escape form)', () => {
    log('CC2:', parseField('data->"a""b"'));
  });

  it('CC3 key with SQL keyword', () => {
    log('CC3:', parseField('data->"SELECT"'));
  });

  it('CC4 key that is empty string', () => {
    log('CC4:', parseField('data->""'));
  });

  it('CC5 key that looks like a numeric index but is quoted', () => {
    log('CC5:', parseField('data->"0"'));
  });

  it('CC6 key containing SQL comment syntax', () => {
    log('CC6:', parseField('data->"/* evil */"'));
  });

  it('CC7 deeply nested path', () => {
    const deep = 'data' + '->"x"'.repeat(100);
    const r = parseField(deep);
    log('CC7 depth:', {
      len: deep.length,
      path: r.ok ? r.value.jsonPath.length : 'err',
    });
  });
});
