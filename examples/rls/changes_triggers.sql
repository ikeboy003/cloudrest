-- Opt-in change tracking for realtime subscriptions.
--
-- CloudREST's realtime feature (WebSocket + SSE) polls a table called
-- `_cloudrest_changes` for new rows. CloudREST bootstraps the table itself
-- on first boot, but it's up to you to decide which of YOUR tables should
-- feed it. This file defines a trigger function and an example trigger you
-- can adapt.
--
-- Usage:
--
--   psql "$DATABASE_URL" -f changes_triggers.sql
--
-- To track another table, repeat the `CREATE TRIGGER ... ON your_table`
-- block at the bottom with your table's name.

-- 1. The shared trigger function. Writes one row per DML operation into the
--    change log. Uses pg_trigger_depth() to avoid recursing into itself if
--    anything ever writes to _cloudrest_changes as part of a trigger chain.
CREATE OR REPLACE FUNCTION _cloudrest_emit_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  row_pk jsonb;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Capture the primary-key projection of the affected row. Works for any
  -- single- or multi-column PK as long as it's named in the CREATE TRIGGER
  -- call via `WHEN` or passed in `TG_ARGV`. This simple version just uses
  -- the whole row as the "row_id" — adapt if you only want specific columns.
  IF TG_OP = 'DELETE' THEN
    row_pk := to_jsonb(OLD);
  ELSE
    row_pk := to_jsonb(NEW);
  END IF;

  INSERT INTO _cloudrest_changes (table_name, operation, row_id)
  VALUES (TG_TABLE_NAME, TG_OP, row_pk);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 2. Attach the trigger to the example `reviews` table.
--    Repeat this block for any other table you want to stream.
DROP TRIGGER IF EXISTS _cloudrest_reviews_changes ON reviews;
CREATE TRIGGER _cloudrest_reviews_changes
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION _cloudrest_emit_change();

-- Confirm it worked:
--   SELECT event_object_table, trigger_name
--   FROM information_schema.triggers
--   WHERE trigger_name LIKE '\_cloudrest\_%';
