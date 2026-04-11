import { describe, expect, it } from 'vitest';

import { parseField } from '../../../src/parser/json-path';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('parseField', () => {
  it('parses a plain column name', () => {
    expect(expectOk(parseField('title'))).toEqual({ name: 'title', jsonPath: [] });
  });

  it('parses a single arrow + key', () => {
    expect(expectOk(parseField('data->key'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'key', value: 'key' } }],
    });
  });

  it('parses a doubleArrow (text extraction) + key', () => {
    expect(expectOk(parseField('data->>name'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'doubleArrow', operand: { type: 'key', value: 'name' } }],
    });
  });

  it('parses a chain of arrow + doubleArrow', () => {
    expect(expectOk(parseField("data->'owner'->>'name'"))).toEqual({
      name: 'data',
      jsonPath: [
        { type: 'arrow', operand: { type: 'key', value: 'owner' } },
        { type: 'doubleArrow', operand: { type: 'key', value: 'name' } },
      ],
    });
  });

  it('detects integer array index (arrow)', () => {
    expect(expectOk(parseField('data->0'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'idx', value: '0' } }],
    });
  });

  it('accepts double-quoted keys and strips quotes', () => {
    expect(expectOk(parseField('data->"key"'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'key', value: 'key' } }],
    });
  });

  it('handles doubled-inner-quote escape', () => {
    expect(expectOk(parseField('data->"k""v"'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'key', value: 'k"v' } }],
    });
  });

  // BUG FIX: the old parser did `raw.split(/(?=->)/)` which split at
  // every `->`, including inside quoted keys. The new parser scans
  // character by character and treats `->` / `->>` inside quoted
  // regions as part of the key.
  it('keeps arrow tokens inside single-quoted keys', () => {
    expect(expectOk(parseField("data->'a->b'"))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'key', value: 'a->b' } }],
    });
  });

  it('keeps arrow tokens inside double-quoted keys', () => {
    expect(expectOk(parseField('data->"a->b"'))).toEqual({
      name: 'data',
      jsonPath: [{ type: 'arrow', operand: { type: 'key', value: 'a->b' } }],
    });
  });

  it('handles mixed quoted+unquoted chain with arrow tokens inside', () => {
    expect(expectOk(parseField("data->'a->b'->>'c'"))).toEqual({
      name: 'data',
      jsonPath: [
        { type: 'arrow', operand: { type: 'key', value: 'a->b' } },
        { type: 'doubleArrow', operand: { type: 'key', value: 'c' } },
      ],
    });
  });

  // BUG FIX #17: quoted numeric keys stay as keys, not array indices.
  it('quoted numeric JSON keys stay as key operands, not idx', () => {
    const field = expectOk(parseField('data->"0"'));
    expect(field.jsonPath).toHaveLength(1);
    expect(field.jsonPath[0]!.operand).toEqual({ type: 'key', value: '0' });
  });

  it('unquoted digit keys become idx operands', () => {
    const field = expectOk(parseField('data->0'));
    expect(field.jsonPath[0]!.operand).toEqual({ type: 'idx', value: '0' });
  });

  // BUG FIX #18: malformed arrows are now rejected instead of silently accepted.
  it('rejects a dangling arrow with no key', () => {
    expectErr(parseField('data->'));
  });

  it('rejects a dangling doubleArrow with no key', () => {
    expectErr(parseField('data->>'));
  });

  it('rejects an arrow with no field name', () => {
    expectErr(parseField('->key'));
  });

  it('rejects an unterminated quoted key', () => {
    expectErr(parseField("data->'oops"));
  });
});
