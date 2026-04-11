-- CloudREST example schema
--
-- A small bookstore data model used by every example in this directory.
-- Run once against a fresh database:
--
--   psql "$DATABASE_URL" -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;

-- Roles CloudREST uses for unauthenticated and authenticated requests.
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Clean slate for idempotent re-runs.
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS books CASCADE;
DROP TABLE IF EXISTS authors CASCADE;

CREATE TABLE authors (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  bio        text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id          serial PRIMARY KEY,
  title       text NOT NULL,
  author_id   int NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  price       numeric(10, 2) NOT NULL,
  stock       int NOT NULL DEFAULT 0,
  published   boolean NOT NULL DEFAULT false,
  summary     text,
  embedding   vector(3),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
  id         serial PRIMARY KEY,
  book_id    int NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  rating     int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed data.
INSERT INTO authors (name, bio) VALUES
  ('Frank Herbert',   'Author of the Dune series.'),
  ('Isaac Asimov',    'Biochemist and prolific science-fiction writer.'),
  ('Ursula K. Le Guin', 'Novelist whose work explored anarchist and feminist themes.');

INSERT INTO books (title, author_id, price, stock, published, summary, embedding) VALUES
  ('Dune',                  1, 18.99, 12, true,  'A desert planet and a prophecy.',     '[0.10, 0.20, 0.30]'),
  ('Dune Messiah',          1, 16.50,  6, true,  'The sequel to Dune.',                 '[0.11, 0.22, 0.33]'),
  ('Children of Dune',      1, 17.25,  0, false, 'Third book in the Dune series.',      '[0.12, 0.24, 0.36]'),
  ('Foundation',            2, 15.00, 25, true,  'A mathematician predicts the fall.',  '[0.80, 0.10, 0.05]'),
  ('I, Robot',              2, 14.50, 40, true,  'Nine stories about robots.',          '[0.75, 0.15, 0.10]'),
  ('The Left Hand of Darkness', 3, 16.00, 18, true, 'First contact on a wintry world.', '[0.30, 0.70, 0.40]'),
  ('The Dispossessed',      3, 17.00,  9, true,  'An ambiguous utopia.',                '[0.32, 0.68, 0.42]');

INSERT INTO reviews (book_id, rating, body) VALUES
  (1, 5, 'A genre-defining masterpiece.'),
  (1, 4, 'Dense but rewarding.'),
  (4, 5, 'Still holds up after all these years.'),
  (6, 5, 'Quietly revolutionary.'),
  (5, 4, 'Thought-provoking.');

-- A simple RPC example.
CREATE OR REPLACE FUNCTION top_rated_books(min_rating int DEFAULT 4)
RETURNS TABLE (id int, title text, avg_rating numeric)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.title, AVG(r.rating)::numeric
  FROM books b
  JOIN reviews r ON r.book_id = b.id
  GROUP BY b.id, b.title
  HAVING AVG(r.rating) >= min_rating
  ORDER BY AVG(r.rating) DESC;
$$;

-- Grants.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION top_rated_books(int) TO anon, authenticated;
