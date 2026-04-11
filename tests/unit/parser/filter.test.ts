import { describe, expect, it } from 'vitest';

import { parseFilter } from '../../../src/parser/filter';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('parseFilter', () => {
  it('parses a root-level filter', () => {
    const result = expectOk(parseFilter('price', 'gt.10'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.path).toEqual([]);
      expect(result.filter.field.name).toBe('price');
      expect(result.filter.opExpr.operation.type).toBe('opQuant');
      if (result.filter.opExpr.operation.type === 'opQuant') {
        expect(result.filter.opExpr.operation.operator).toBe('gt');
        expect(result.filter.opExpr.operation.value).toBe('10');
      }
    }
  });

  it('parses an embedded-path filter', () => {
    const result = expectOk(parseFilter('posts.comments.id', 'eq.1'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.path).toEqual(['posts', 'comments']);
      expect(result.filter.field.name).toBe('id');
    }
  });

  it('parses a JSON-path filter', () => {
    const result = expectOk(parseFilter("data->'owner'->>'name'", 'eq.Ada'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.path).toEqual([]);
      expect(result.filter.field.name).toBe('data');
      expect(result.filter.field.jsonPath).toHaveLength(2);
    }
  });

  it('returns null for values that are not filters', () => {
    expect(expectOk(parseFilter('page', '123'))).toBeNull();
  });

  it('parses a negated filter', () => {
    const result = expectOk(parseFilter('name', 'not.ilike.*draft*'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.filter.opExpr.negated).toBe(true);
    }
  });

  // BUG FIX: the old parser split the key on every `.`, breaking JSON
  // path filters whose keys contain arrows or whose quoted keys
  // contain literal dots.
  it('treats arrow tokens as part of the field, not embed separators', () => {
    const result = expectOk(parseFilter("data->'owner'->>'name'", 'eq.Ada'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.path).toEqual([]);
      expect(result.filter.field.name).toBe('data');
      expect(result.filter.field.jsonPath).toHaveLength(2);
    }
  });

  it('handles dots inside quoted JSON-path keys', () => {
    const result = expectOk(parseFilter("data->>'a.b'", 'eq.x'));
    expect(result).not.toBeNull();
    if (result) {
      // No embed path — the dot is inside the quoted JSON key.
      expect(result.path).toEqual([]);
      expect(result.filter.field.name).toBe('data');
      expect(result.filter.field.jsonPath).toHaveLength(1);
    }
  });

  it('combines an embed path with a JSON-path field', () => {
    const result = expectOk(parseFilter("posts.data->>'owner'", 'eq.Ada'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.path).toEqual(['posts']);
      expect(result.filter.field.name).toBe('data');
      expect(result.filter.field.jsonPath).toHaveLength(1);
    }
  });

  // BUG FIX (#24): empty embed segments are malformed and must produce
  // PGRST100 instead of silently collapsing.
  it('rejects a leading dot (empty embed segment)', () => {
    expectErr(parseFilter('.id', 'eq.1'));
  });

  it('rejects a doubled dot (empty middle segment)', () => {
    expectErr(parseFilter('a..b', 'eq.1'));
  });
});
