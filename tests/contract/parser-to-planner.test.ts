// Contract test: the parser's ParsedQueryParams output shape matches
// the planner's input expectations.
//
// This test asserts on the hand-off between the two subsystems: every
// field the planner reads must exist on every parser output. It is the
// backstop against a parser refactor that drops a field the planner
// silently depends on.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '../../src/parser/query-params';
import { planRead } from '../../src/planner/plan-read';
import { expectOk } from '../fixtures/assert-result';
import { LIBRARY_SCHEMA } from '../fixtures/schema';

function runThrough(query: string) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(query)));
  return {
    parsed,
    planResult: planRead({
      target: { schema: 'public', name: 'books' },
      parsed,
      preferences: { invalidPrefs: [] },
      schema: LIBRARY_SCHEMA,
      mediaType: 'json',
      topLevelRange: { offset: 0, limit: null },
      hasPreRequest: false,
      maxRows: null,
    }),
  };
}

describe('parser → planner contract', () => {
  it('exposes every field the planner reads', () => {
    const { parsed } = runThrough('');
    // The planner reads each of these fields. If one is removed from
    // the parser, this test will fail at type-check time, not at
    // runtime.
    expect(parsed).toHaveProperty('filtersRoot');
    expect(parsed).toHaveProperty('filtersNotRoot');
    expect(parsed).toHaveProperty('logic');
    expect(parsed).toHaveProperty('order');
    expect(parsed).toHaveProperty('ranges');
    expect(parsed).toHaveProperty('select');
    expect(parsed).toHaveProperty('distinct');
    expect(parsed).toHaveProperty('having');
    expect(parsed).toHaveProperty('vector');
  });

  it('plans an empty query without error', () => {
    const { planResult } = runThrough('');
    expect(planResult.ok).toBe(true);
  });

  it('threads a root filter through to the plan', () => {
    const { planResult } = runThrough('price=gt.10');
    const plan = expectOk(planResult);
    expect(plan.filters).toHaveLength(1);
    expect(plan.filters[0]!.field.name).toBe('price');
  });

  it('threads a root order term through to the plan', () => {
    const { planResult } = runThrough('order=price.desc');
    const plan = expectOk(planResult);
    expect(plan.order).toHaveLength(1);
    expect(plan.order[0]!.field.name).toBe('price');
  });

  it('threads an embed with its filter / order / range into the plan subtree', () => {
    const { planResult } = runThrough(
      'select=id,reviews(id,rating)&reviews.rating=gt.3&reviews.order=rating.desc&reviews.limit=5',
    );
    const plan = expectOk(planResult);
    const reviews = plan.embeds[0]!;
    expect(reviews.child.filters).toHaveLength(1);
    expect(reviews.child.order).toHaveLength(1);
    expect(reviews.child.range.limit).toBe(5);
  });
});
