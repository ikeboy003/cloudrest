// `_cloudrest_changes` table — the append-only change-log the
// realtime poller reads.
//
// The schema includes `tenant_claims jsonb` so the poller can
// enforce per-request RLS without re-querying the user's table.
// The trigger captures `current_setting('request.jwt.claims', true)`
// so the JWT context flows from the mutation into the change event.
// The change-log trigger writes the primary key (plus an op-type
// tag), NOT `to_jsonb(NEW)`, so a leaked change-log doesn't expose
// row contents to anyone with SELECT on the changes table.
//
// This module renders the migration SQL as a plain string so a
// deployment can copy-paste it or call it from a setup script.
// The rewrite does not attempt to auto-apply the migration at
// startup and would require write access to the `cloudrest` schema.

/**
 * The migration DDL for `_cloudrest_changes`. Idempotent — safe
 * to run multiple times.
 */
export const CHANGES_TABLE_MIGRATION = `
-- CloudREST realtime change log.
CREATE SCHEMA IF NOT EXISTS cloudrest;

CREATE TABLE IF NOT EXISTS cloudrest._cloudrest_changes (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  schema_name    text        NOT NULL,
  table_name     text        NOT NULL,
  op             text        NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  pk             jsonb       NOT NULL,
  tenant_claims  jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloudrest_changes_by_table
  ON cloudrest._cloudrest_changes (schema_name, table_name, id);

CREATE INDEX IF NOT EXISTS cloudrest_changes_occurred_at
  ON cloudrest._cloudrest_changes (occurred_at);
`;

/**
 * Render a trigger that writes a change-log entry for a given
 * (schema, table, pk-columns) tuple.
 *
 * IMPORTANT: the trigger captures `current_setting('request.jwt.claims', true)`
 * into `tenant_claims`. The request prelude sets that GUC on every
 * authenticated request, so the change row knows the caller
 * without the trigger reaching into any other table.
 *
 * The primary-key columns are inlined as identifiers — the caller
 * is expected to have verified them against the schema cache
 * first.
 */
export function renderChangesTrigger(input: {
  readonly schema: string;
  readonly table: string;
  readonly primaryKeyColumns: readonly string[];
}): string {
  if (input.primaryKeyColumns.length === 0) {
    throw new Error(
      'renderChangesTrigger: primary-key columns are required',
    );
  }
  const triggerName = `cloudrest_changes_${input.schema}_${input.table}`;
  const qualifiedTable = `"${input.schema.replace(/"/g, '""')}"."${input.table.replace(/"/g, '""')}"`;

  // Build a jsonb_build_object literal `('k', NEW."k", ...)` for
  // both NEW and OLD. The trigger emits a row on every op but
  // the pk comes from NEW for INSERT/UPDATE and OLD for DELETE.
  const newPk = input.primaryKeyColumns
    .map((c) => `'${c.replace(/'/g, "''")}', NEW."${c.replace(/"/g, '""')}"`)
    .join(', ');
  const oldPk = input.primaryKeyColumns
    .map((c) => `'${c.replace(/'/g, "''")}', OLD."${c.replace(/"/g, '""')}"`)
    .join(', ');

  return `
CREATE OR REPLACE FUNCTION cloudrest.${triggerName}() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claims_json jsonb;
BEGIN
  BEGIN
    claims_json := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN others THEN
    claims_json := '{}'::jsonb;
  END;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO cloudrest._cloudrest_changes (schema_name, table_name, op, pk, tenant_claims)
    VALUES ('${input.schema}', '${input.table}', 'DELETE', jsonb_build_object(${oldPk}), claims_json);
    RETURN OLD;
  ELSE
    INSERT INTO cloudrest._cloudrest_changes (schema_name, table_name, op, pk, tenant_claims)
    VALUES ('${input.schema}', '${input.table}', TG_OP, jsonb_build_object(${newPk}), claims_json);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS ${triggerName} ON ${qualifiedTable};
CREATE TRIGGER ${triggerName}
AFTER INSERT OR UPDATE OR DELETE ON ${qualifiedTable}
FOR EACH ROW EXECUTE FUNCTION cloudrest.${triggerName}();
`;
}
