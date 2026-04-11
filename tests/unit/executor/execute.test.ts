// Stage 7 — `runQuery` / `mapOutcome` tests.
//
// `runTransaction` yields a four-branch `TransactionOutcome`; the
// `runQuery` wrapper collapses it to `Result<QueryResult, CloudRestError>`
// so handlers never need to switch on `kind`. PHASE_B Stage 7.

import { describe, expect, it } from 'vitest';

import { mapOutcome } from '@/executor/execute';
import type {
  QueryResult,
  TransactionOutcome,
} from '@/executor/types';
import { makeError } from '@/core/errors/types';

const SAMPLE_RESULT: QueryResult = {
  rows: [{ page_total: 1, body: '[{"id":1}]' }],
  responseHeaders: null,
  responseStatus: null,
  schemaVersion: null,
};

describe('mapOutcome', () => {
  it('commit → ok(result)', () => {
    const out: TransactionOutcome = { kind: 'commit', result: SAMPLE_RESULT };
    const r = mapOutcome(out);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value).toBe(SAMPLE_RESULT);
  });

  it('rollback → ok(result) — rows still flow', () => {
    const out: TransactionOutcome = { kind: 'rollback', result: SAMPLE_RESULT };
    const r = mapOutcome(out);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    // The rollback outcome is indistinguishable from commit at the
    // Result-level — handlers don't care which one happened.
    expect(r.value).toBe(SAMPLE_RESULT);
  });

  it('max-affected-violation → err(PGRST124)', () => {
    const out: TransactionOutcome = {
      kind: 'max-affected-violation',
      pageTotal: 42,
    };
    const r = mapOutcome(out);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected err');
    expect(r.error.code).toBe('PGRST124');
    expect(r.error.details).toContain('42');
  });

  it('pg-error → err(error)', () => {
    const err = makeError({
      code: '42P01',
      message: 'relation does not exist',
      details: null,
      httpStatus: 404,
    });
    const out: TransactionOutcome = { kind: 'pg-error', error: err };
    const r = mapOutcome(out);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected err');
    expect(r.error).toBe(err);
  });
});
