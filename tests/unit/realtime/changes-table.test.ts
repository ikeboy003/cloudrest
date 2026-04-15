// Changes-table migration / trigger rendering tests.

import { describe, expect, it } from 'vitest';

import {
  CHANGES_TABLE_MIGRATION,
  renderChangesTrigger,
} from '@/realtime/changes-table';

describe('CHANGES_TABLE_MIGRATION', () => {
  it('creates the cloudrest schema', () => {
    expect(CHANGES_TABLE_MIGRATION).toContain(
      'CREATE SCHEMA IF NOT EXISTS cloudrest',
    );
  });

  it('creates the _cloudrest_changes table with tenant_claims', () => {
    expect(CHANGES_TABLE_MIGRATION).toContain(
      'CREATE TABLE IF NOT EXISTS cloudrest._cloudrest_changes',
    );
    expect(CHANGES_TABLE_MIGRATION).toContain('tenant_claims  jsonb');
  });

  it('creates an index for the poller path', () => {
    expect(CHANGES_TABLE_MIGRATION).toContain(
      'CREATE INDEX IF NOT EXISTS cloudrest_changes_by_table',
    );
  });
});

describe('renderChangesTrigger', () => {
  it('emits CREATE TRIGGER and FUNCTION pair', () => {
    const sql = renderChangesTrigger({
      schema: 'public',
      table: 'books',
      primaryKeyColumns: ['id'],
    });
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).toContain('CREATE TRIGGER');
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE');
  });

  it('captures request.jwt.claims into tenant_claims', () => {
    const sql = renderChangesTrigger({
      schema: 'public',
      table: 'books',
      primaryKeyColumns: ['id'],
    });
    expect(sql).toContain("current_setting('request.jwt.claims', true)");
    expect(sql).toContain('tenant_claims');
  });

  it('writes only the primary key — never the full row', () => {
    const sql = renderChangesTrigger({
      schema: 'public',
      table: 'books',
      primaryKeyColumns: ['id'],
    });
    // Critique #27: no `to_jsonb(NEW)`.
    expect(sql).not.toContain('to_jsonb(NEW)');
    expect(sql).not.toContain('to_jsonb(OLD)');
    // The PK is inserted via jsonb_build_object.
    expect(sql).toContain('jsonb_build_object');
  });

  it('handles composite primary keys', () => {
    const sql = renderChangesTrigger({
      schema: 'public',
      table: 'order_items',
      primaryKeyColumns: ['order_id', 'line_no'],
    });
    expect(sql).toContain('"order_id"');
    expect(sql).toContain('"line_no"');
  });

  it('rejects an empty primary-key list', () => {
    expect(() =>
      renderChangesTrigger({
        schema: 'public',
        table: 'orphan',
        primaryKeyColumns: [],
      }),
    ).toThrow(/primary-key/);
  });
});
