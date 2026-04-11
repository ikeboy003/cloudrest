// Stage 7 — statement-timeout helper tests.
//
// Closes critique #65: every transaction issues `SET LOCAL
// statement_timeout = '<config>ms'`. The test for the "always issued"
// part lives in transaction-outcomes.test.ts; this file pins the
// renderer's own behavior.

import { describe, expect, it } from 'vitest';

import { renderStatementTimeoutSql } from '../../../src/executor/statement-timeout';

describe('renderStatementTimeoutSql', () => {
  it('renders the config value as a SET LOCAL statement', () => {
    expect(renderStatementTimeoutSql(5000)).toBe(
      "SET LOCAL statement_timeout = '5000ms'",
    );
  });

  it('inlines the number (postgres SET does not accept bind params)', () => {
    const sql = renderStatementTimeoutSql(12345);
    expect(sql).not.toContain('$1');
    expect(sql).toContain('12345');
  });

  it('refuses to disable the timeout when given 0', () => {
    const sql = renderStatementTimeoutSql(0);
    expect(sql).toBe("SET LOCAL statement_timeout = '1ms'");
  });

  it('refuses to disable the timeout when given a negative value', () => {
    const sql = renderStatementTimeoutSql(-1);
    expect(sql).toBe("SET LOCAL statement_timeout = '1ms'");
  });

  it('refuses to disable the timeout when given a non-integer', () => {
    const sql = renderStatementTimeoutSql(5000.5);
    expect(sql).toBe("SET LOCAL statement_timeout = '1ms'");
  });

  it('refuses NaN', () => {
    const sql = renderStatementTimeoutSql(Number.NaN);
    expect(sql).toBe("SET LOCAL statement_timeout = '1ms'");
  });
});
