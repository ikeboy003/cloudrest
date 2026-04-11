-- Owner-only edits via RLS.
--
-- Pattern: anyone can read any row, but only the row's owner can update or
-- delete it. Useful for things like comments, posts, or profile fields —
-- the public can browse, only the author can modify.
--
-- Usage:
--   psql "$DATABASE_URL" -f owner_edit.sql
--
-- JWTs must carry a `sub` claim identifying the user:
--   { "role": "authenticated", "sub": "user-42", ... }

CREATE TABLE IF NOT EXISTS user_posts (
  id         bigserial PRIMARY KEY,
  owner      text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON user_posts TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON user_posts TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE user_posts_id_seq TO authenticated;

ALTER TABLE user_posts ENABLE ROW LEVEL SECURITY;

-- Helper: read the sub claim.
CREATE OR REPLACE FUNCTION current_user_sub()
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )
$$;

-- Everyone — even anonymous — can read.
DROP POLICY IF EXISTS user_posts_public_read ON user_posts;
CREATE POLICY user_posts_public_read ON user_posts
  FOR SELECT TO anon, authenticated
  USING (true);

-- Authenticated users can insert posts, but only as themselves.
DROP POLICY IF EXISTS user_posts_insert ON user_posts;
CREATE POLICY user_posts_insert ON user_posts
  FOR INSERT TO authenticated
  WITH CHECK (owner = current_user_sub());

-- Only the owner can update; the WITH CHECK clause prevents changing
-- the owner to someone else.
DROP POLICY IF EXISTS user_posts_update ON user_posts;
CREATE POLICY user_posts_update ON user_posts
  FOR UPDATE TO authenticated
  USING      (owner = current_user_sub())
  WITH CHECK (owner = current_user_sub());

-- Only the owner can delete.
DROP POLICY IF EXISTS user_posts_delete ON user_posts;
CREATE POLICY user_posts_delete ON user_posts
  FOR DELETE TO authenticated
  USING (owner = current_user_sub());

-- Seed data
INSERT INTO user_posts (owner, title, body) VALUES
  ('alice', 'Hello from Alice', 'first post'),
  ('bob',   'Hello from Bob',   'also first post')
ON CONFLICT DO NOTHING;
