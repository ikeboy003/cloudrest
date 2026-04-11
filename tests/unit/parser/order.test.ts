import { describe, expect, it } from 'vitest';

import { parseOrder } from '../../../src/parser/order';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('parseOrder', () => {
  it('parses a plain column', () => {
    const terms = expectOk(parseOrder('name'));
    expect(terms).toHaveLength(1);
    expect(terms[0]!.field.name).toBe('name');
    expect(terms[0]!.direction).toBeUndefined();
  });

  it('parses direction modifiers', () => {
    const terms = expectOk(parseOrder('name.desc'));
    expect(terms[0]!.direction).toBe('desc');
  });

  it('parses null-order modifiers', () => {
    const terms = expectOk(parseOrder('name.desc.nullslast'));
    expect(terms[0]!.direction).toBe('desc');
    expect(terms[0]!.nullOrder).toBe('nullslast');
  });

  it('parses multiple comma-separated terms', () => {
    const terms = expectOk(parseOrder('a.asc,b.desc'));
    expect(terms).toHaveLength(2);
    expect(terms[1]!.direction).toBe('desc');
  });

  it('parses a relation ordering', () => {
    const terms = expectOk(parseOrder('author(name).desc.nullslast'));
    expect(terms[0]!.relation).toBe('author');
    expect(terms[0]!.field.name).toBe('name');
    expect(terms[0]!.direction).toBe('desc');
  });

  it('parses a JSON-path field with modifiers', () => {
    const terms = expectOk(parseOrder('data->>name.desc.nullslast'));
    expect(terms[0]!.field.name).toBe('data');
    expect(terms[0]!.field.jsonPath).toHaveLength(1);
    expect(terms[0]!.direction).toBe('desc');
    expect(terms[0]!.nullOrder).toBe('nullslast');
  });

  it('rejects unknown modifiers', () => {
    expectErr(parseOrder('name.rocket'));
  });
});
