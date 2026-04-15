// `extractTotalCost` tests.

import { describe, expect, it } from 'vitest';

import { extractTotalCost } from '@/cost-guard/extract-cost';

describe('extractTotalCost', () => {
  it('returns 0 for an empty row set', () => {
    expect(extractTotalCost([])).toBe(0);
  });

  it('reads Total Cost from a pre-parsed QUERY PLAN object', () => {
    const rows = [
      {
        'QUERY PLAN': [
          { Plan: { 'Total Cost': 123.45, 'Node Type': 'Seq Scan' } },
        ],
      },
    ];
    expect(extractTotalCost(rows)).toBe(123.45);
  });

  it('reads Total Cost from a JSON-string QUERY PLAN', () => {
    const rows = [
      {
        'QUERY PLAN': JSON.stringify([
          { Plan: { 'Total Cost': 99.9 } },
        ]),
      },
    ];
    expect(extractTotalCost(rows)).toBe(99.9);
  });

  it('returns 0 when the row shape is unexpected', () => {
    expect(extractTotalCost([{ 'QUERY PLAN': null }])).toBe(0);
    expect(extractTotalCost([{ 'QUERY PLAN': 'not-json' }])).toBe(0);
    expect(extractTotalCost([{ other: 'thing' }])).toBe(0);
  });

  it('returns 0 when Plan has no Total Cost', () => {
    const rows = [{ 'QUERY PLAN': [{ Plan: {} }] }];
    expect(extractTotalCost(rows)).toBe(0);
  });
});
