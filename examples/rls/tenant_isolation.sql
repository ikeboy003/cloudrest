-- Multi-tenant row isolation via RLS.
--
-- Pattern: every tenant-scoped table has a `tenant_id` column, and RLS
-- restricts SELECT/INSERT/UPDATE/DELETE to rows that match the current
-- tenant. CloudREST sets `request.jwt.claims` before each query, so we
-- read the tenant from the JWT and compare.
--
-- Usage:
--   psql "$DATABASE_URL" -f tenant_isolation.sql
--
-- Then mint JWTs with `tenant_id` in the payload:
--   { "role": "authenticated", "tenant_id": "acme-corp", ... }

-- Example tenant-scoped table
CREATE TABLE IF NOT EXISTS tenant_notes (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_notes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tenant_notes_id_seq TO authenticated;

ALTER TABLE tenant_notes ENABLE ROW LEVEL SECURITY;

-- Helper: read the tenant_id claim from the current JWT.
-- Returns NULL for anonymous requests, which makes all policies deny.
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id',
    ''
  )
$$;

-- Read policy: you can only see rows for your tenant.
DROP POLICY IF EXISTS tenant_notes_select ON tenant_notes;
CREATE POLICY tenant_notes_select ON tenant_notes
  FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- Write policy: you can only insert into your own tenant, and the policy
-- enforces it again on UPDATE to prevent moving a row between tenants.
DROP POLICY IF EXISTS tenant_notes_insert ON tenant_notes;
CREATE POLICY tenant_notes_insert ON tenant_notes
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_notes_update ON tenant_notes;
CREATE POLICY tenant_notes_update ON tenant_notes
  FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_notes_delete ON tenant_notes;
CREATE POLICY tenant_notes_delete ON tenant_notes
  FOR DELETE TO authenticated
  USING (tenant_id = current_tenant_id());

-- Seed data for demonstration
INSERT INTO tenant_notes (tenant_id, body) VALUES
  ('acme-corp',    'Acme: quarterly planning'),
  ('acme-corp',    'Acme: hire backend lead'),
  ('globex',       'Globex: launch spearphish campaign'),
  ('globex',       'Globex: Q4 earnings call notes')
ON CONFLICT DO NOTHING;
