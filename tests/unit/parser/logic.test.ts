import { describe, expect, it } from 'vitest';

import { parseLogicTree } from '@/parser/logic';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

describe('parseLogicTree — flat', () => {
  it('parses a two-child and=(...)', () => {
    const tree = expectOk(parseLogicTree('and', false, '(price.gt.10,stock.gte.1)'));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      expect(tree.operator).toBe('and');
      expect(tree.children.length).toBe(2);
    }
  });

  it('parses an or=(...)', () => {
    const tree = expectOk(parseLogicTree('or', false, '(price.lt.5,price.gt.20)'));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      expect(tree.operator).toBe('or');
    }
  });

  it('rejects a missing outer parenthesis', () => {
    expectErr(parseLogicTree('and', false, 'price.gt.10'));
  });

  it('rejects an empty logic group', () => {
    expectErr(parseLogicTree('and', false, '()'));
  });
});

describe('parseLogicTree — nested (critique #70 regression)', () => {
  // REGRESSION: critique #70 — the old parser failed to recurse into
  // nested and/or because the helper stripped outer parens before
  // recursing.
  it('parses nested or(...) inside and=(...)', () => {
    const tree = expectOk(
      parseLogicTree('and', false, '(price.gt.10,or(stock.eq.0,discount.gt.50))'),
    );
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      expect(tree.children.length).toBe(2);
      const secondChild = tree.children[1]!;
      expect(secondChild.type).toBe('expr');
      if (secondChild.type === 'expr') {
        expect(secondChild.operator).toBe('or');
        expect(secondChild.children.length).toBe(2);
      }
    }
  });

  it('parses doubly-nested trees', () => {
    expectOk(parseLogicTree('or', false, '(a.eq.1,and(b.eq.2,or(c.eq.3,d.eq.4)))'));
  });
});

describe('parseLogicTree — negation', () => {
  it('honors root negation', () => {
    const tree = expectOk(parseLogicTree('and', true, '(price.gt.10,stock.gte.1)'));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      expect(tree.negated).toBe(true);
    }
  });

  it('merges not. prefix on a leaf filter', () => {
    const tree = expectOk(
      parseLogicTree('or', false, '(not.price.eq.10,name.ilike.*widget*)'),
    );
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      const first = tree.children[0]!;
      expect(first.type).toBe('stmnt');
      if (first.type === 'stmnt') {
        expect(first.filter.opExpr.negated).toBe(true);
      }
    }
  });

  it('negation on nested groups: not.and(...)', () => {
    const tree = expectOk(
      parseLogicTree('or', false, '(a.eq.1,not.and(b.eq.2,c.eq.3))'),
    );
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      const nested = tree.children[1]!;
      expect(nested.type).toBe('expr');
      if (nested.type === 'expr') {
        expect(nested.negated).toBe(true);
      }
    }
  });
});

// BUG FIX: the old parser used `indexOf('.')` to split a leaf
// `key.op.value` into key and op. That broke on multi-dot keys
// (JSON-path quoted segments, relation-qualified filters). The new
// parser scans for the operator-start token instead.
//
// Note on `actors.name.eq.John`: the split fix produces key=`actors.name`,
// value=`eq.John`. The resulting Field carries name=`actors.name` (not
// `name` with an embed path). PostgREST reserves the `actors.name.eq.X`
// form for the embedded `actors.and=(name.eq.X)` URL grammar, so an
// end-to-end test of that form lives at the dispatcher level.
describe('parseLogicTree — leaf filter split', () => {
  it('splits at the operator boundary even with multi-dot keys', () => {
    const tree = expectOk(parseLogicTree('and', false, '(actors.name.eq.John)'));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      const leaf = tree.children[0]!;
      expect(leaf.type).toBe('stmnt');
      if (leaf.type === 'stmnt') {
        // With the bug, the field would be just `actors` and the value
        // would be `name.eq.John` — which parseOpExpr would reject as
        // an unknown op. The fix walks to the `.eq` boundary.
        expect(leaf.filter.field.name).toBe('actors.name');
        if (leaf.filter.opExpr.operation.type === 'opQuant') {
          expect(leaf.filter.opExpr.operation.operator).toBe('eq');
          expect(leaf.filter.opExpr.operation.value).toBe('John');
        }
      }
    }
  });

  it('handles JSON-path keys with dots inside quoted segments', () => {
    const tree = expectOk(parseLogicTree('and', false, "(data->>'a.b'.eq.x)"));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      const leaf = tree.children[0]!;
      expect(leaf.type).toBe('stmnt');
      if (leaf.type === 'stmnt') {
        expect(leaf.filter.field.name).toBe('data');
        expect(leaf.filter.field.jsonPath).toHaveLength(1);
        if (leaf.filter.opExpr.operation.type === 'opQuant') {
          expect(leaf.filter.opExpr.operation.value).toBe('x');
        }
      }
    }
  });

  it('handles FTS with language inside leaf filter', () => {
    const tree = expectOk(parseLogicTree('and', false, '(body.fts(english).word)'));
    expect(tree.type).toBe('expr');
    if (tree.type === 'expr') {
      const leaf = tree.children[0]!;
      expect(leaf.type).toBe('stmnt');
      if (leaf.type === 'stmnt') {
        expect(leaf.filter.field.name).toBe('body');
        expect(leaf.filter.opExpr.operation.type).toBe('fts');
      }
    }
  });
});
