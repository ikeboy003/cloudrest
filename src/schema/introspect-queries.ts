// Schema introspection SQL queries.
//
// These queries mirror PostgREST's `SchemaCache.hs` pg_catalog
// queries. A row-for-row rewrite would drift from PostgREST's
// behavior over time, so the queries are a verbatim port and only
// the row-parsing layer is rewritten against the rewrite's typed
// `Table` / `Relationship` / `Routine` shapes.
//
// INVARIANT: the exposed schemas are bound as
// `$1::regnamespace[]`, never inlined. The planner and schema
// coordinator pass `config.database.schemas` as a bound parameter.
//
// INVARIANT: these queries are executed through
// `runQuery`, not a bare `pg.Client`. See `schema/introspect.ts`.

// Recursive CTE shared across queries — resolves domain base types.
const BASE_TYPES_CTE = `
  base_types AS (
    WITH RECURSIVE
    recurse AS (
      SELECT oid, typbasetype,
        typnamespace AS base_namespace,
        COALESCE(NULLIF(typbasetype, 0), oid) AS base_type
      FROM pg_type
      UNION ALL
      SELECT t.oid, b.typbasetype,
        b.typnamespace AS base_namespace,
        COALESCE(NULLIF(b.typbasetype, 0), b.oid) AS base_type
      FROM recurse t
      JOIN pg_type b ON t.typbasetype = b.oid
      WHERE t.typbasetype != 0
    )
    SELECT oid, base_namespace, base_type
    FROM recurse WHERE typbasetype = 0
  )
`;

export const TABLES_SQL = `
WITH
${BASE_TYPES_CTE},
columns AS (
    SELECT
        c.oid AS relid,
        a.attname::name AS column_name,
        d.description AS description,
        CASE
          WHEN (t.typbasetype != 0) AND (ad.adbin IS NULL) THEN pg_get_expr(t.typdefaultbin, 0)
          WHEN a.attidentity = 'd' THEN format('nextval(%L)', seq.objid::regclass)
          WHEN a.attgenerated = 's' THEN null
          ELSE pg_get_expr(ad.adbin, ad.adrelid)::text
        END AS column_default,
        not (a.attnotnull OR t.typtype = 'd' AND t.typnotnull) AS is_nullable,
        CASE
            WHEN t.typtype = 'd' THEN
            CASE
                WHEN bt.base_namespace = 'pg_catalog'::regnamespace THEN format_type(bt.base_type, NULL::integer)
                ELSE format_type(a.atttypid, a.atttypmod)
            END
            ELSE
            CASE
                WHEN t.typnamespace = 'pg_catalog'::regnamespace THEN format_type(a.atttypid, NULL::integer)
                ELSE format_type(a.atttypid, a.atttypmod)
            END
        END::text AS data_type,
        format_type(a.atttypid, a.atttypmod)::text AS nominal_data_type,
        information_schema._pg_char_max_length(
            information_schema._pg_truetypid(a.*, t.*),
            information_schema._pg_truetypmod(a.*, t.*)
        )::integer AS character_maximum_length,
        bt.base_type,
        a.attnum::integer AS position,
        (a.attgenerated != '') AS is_generated
    FROM pg_attribute a
        LEFT JOIN pg_description AS d
            ON d.objoid = a.attrelid AND d.objsubid = a.attnum AND d.classoid = 'pg_class'::regclass
        LEFT JOIN pg_attrdef ad
            ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_type t ON a.atttypid = t.oid
        LEFT JOIN base_types bt ON t.oid = bt.oid
        LEFT JOIN pg_depend seq
            ON seq.refobjid = a.attrelid AND seq.refobjsubid = a.attnum AND seq.deptype = 'i'
    WHERE
        NOT pg_is_other_temp_schema(c.relnamespace)
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND c.relkind IN ('r', 'v', 'f', 'm', 'p')
        AND c.relnamespace = ANY($1::regnamespace[])
),
columns_agg AS (
  SELECT relid,
    json_agg(json_build_object(
      'column_name', column_name,
      'description', description,
      'is_nullable', is_nullable,
      'data_type', data_type,
      'nominal_data_type', nominal_data_type,
      'character_maximum_length', character_maximum_length,
      'column_default', column_default,
      'is_generated', is_generated,
      'enum_values', coalesce(
        (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = base_type),
        '[]'
      )
    ) ORDER BY position) AS columns
  FROM columns
  GROUP BY relid
),
tbl_pk_cols AS (
  SELECT
    r.oid AS relid,
    json_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS pk_cols
  FROM pg_class r
  JOIN pg_constraint c ON r.oid = c.conrelid
  JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'p'
    AND r.relkind IN ('r', 'p')
    AND r.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    AND NOT pg_is_other_temp_schema(r.relnamespace)
    AND NOT a.attisdropped
  GROUP BY r.oid
)
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  d.description AS table_description,
  c.relkind IN ('v','m') AS is_view,
  (c.relkind IN ('r','p') OR (c.relkind IN ('v','f') AND (pg_relation_is_updatable(c.oid::regclass, TRUE) & 8) = 8)) AS insertable,
  (c.relkind IN ('r','p') OR (c.relkind IN ('v','f') AND (pg_relation_is_updatable(c.oid::regclass, TRUE) & 4) = 4)) AS updatable,
  (c.relkind IN ('r','p') OR (c.relkind IN ('v','f') AND (pg_relation_is_updatable(c.oid::regclass, TRUE) & 16) = 16)) AS deletable,
  coalesce(tpks.pk_cols, '[]') AS pk_cols,
  coalesce(cols_agg.columns, '[]') AS columns
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0 AND d.classoid = 'pg_class'::regclass
LEFT JOIN tbl_pk_cols tpks ON c.oid = tpks.relid
LEFT JOIN columns_agg cols_agg ON c.oid = cols_agg.relid
WHERE c.relkind IN ('v','r','m','f','p')
  AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
  AND c.relnamespace = ANY($1::regnamespace[])
  AND NOT c.relispartition
  AND c.relname NOT LIKE E'\\\\_cloudrest\\\\_%'
ORDER BY table_schema, table_name
`;

export const RELATIONSHIPS_SQL = `
WITH
pks_uniques_cols AS (
  SELECT conrelid,
    array_agg(key ORDER BY key) AS cols
  FROM pg_constraint,
  LATERAL unnest(conkey) AS _(key)
  WHERE contype IN ('p', 'u')
    AND connamespace <> 'pg_catalog'::regnamespace
  GROUP BY oid, conrelid
)
SELECT
  ns1.nspname AS table_schema,
  tab.relname AS table_name,
  ns2.nspname AS foreign_table_schema,
  other.relname AS foreign_table_name,
  traint.conrelid = traint.confrelid AS is_self,
  traint.conname AS constraint_name,
  json_agg(json_build_array(cols.attname, refs.attname) ORDER BY ord) AS cols_and_fcols,
  EXISTS(SELECT 1 FROM pks_uniques_cols puc WHERE puc.conrelid = traint.conrelid AND puc.cols = array_agg(cols.attnum ORDER BY cols.attnum)) AS one_to_one
FROM pg_constraint traint
JOIN LATERAL (
  SELECT col, ref, ord
  FROM unnest(traint.conkey, traint.confkey) WITH ORDINALITY AS _(col, ref, ord)
) AS fk_cols ON TRUE
JOIN pg_attribute cols ON cols.attrelid = traint.conrelid AND cols.attnum = fk_cols.col
JOIN pg_attribute refs ON refs.attrelid = traint.confrelid AND refs.attnum = fk_cols.ref
JOIN pg_namespace ns1 ON ns1.oid = traint.connamespace
JOIN pg_class tab ON tab.oid = traint.conrelid
JOIN pg_class other ON other.oid = traint.confrelid
JOIN pg_namespace ns2 ON ns2.oid = other.relnamespace
WHERE traint.contype = 'f'
  AND traint.conparentid = 0
  AND (ns1.oid = ANY($1::regnamespace[]) OR ns2.oid = ANY($1::regnamespace[]))
GROUP BY ns1.nspname, tab.relname, ns2.nspname, other.relname, traint.conrelid, traint.confrelid, traint.conname
ORDER BY traint.conrelid, traint.conname
`;

export const FUNCTIONS_SQL = `
WITH
${BASE_TYPES_CTE},
arguments AS (
  SELECT
    oid,
    json_agg(json_build_object(
      'name', COALESCE(name, ''),
      'type', type::regtype::text,
      'type_max_length', type::regtype::text,
      'is_required', idx <= (pronargs - pronargdefaults),
      'is_variadic', COALESCE(mode = 'v', FALSE)
    ) ORDER BY idx) AS args,
    CASE COUNT(*) - COUNT(name)
      WHEN 0 THEN true
      WHEN 1 THEN (array_agg(type))[1] IN ('bytea'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text'::regtype, 'xml'::regtype)
      ELSE false
    END AS callable
  FROM pg_proc,
       unnest(proargnames, proargtypes, proargmodes)
         WITH ORDINALITY AS _ (name, type, mode, idx)
  WHERE type IS NOT NULL
  GROUP BY oid
)
SELECT
  pn.nspname AS proc_schema,
  p.proname AS proc_name,
  d.description AS proc_description,
  COALESCE(a.args, '[]') AS args,
  tn.nspname AS return_schema,
  COALESCE(comp.relname, t.typname) AS return_name,
  p.proretset AS rettype_is_setof,
  (t.typtype = 'c' OR COALESCE(proargmodes::text[] && '{t,b,o}', false)) AS rettype_is_composite,
  bt.oid <> bt.base_type AS rettype_is_composite_alias,
  p.provolatile,
  p.provariadic > 0 AS hasvariadic
FROM pg_proc p
LEFT JOIN arguments a ON a.oid = p.oid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
JOIN base_types bt ON bt.oid = p.prorettype
JOIN pg_type t ON t.oid = bt.base_type
JOIN pg_namespace tn ON tn.oid = t.typnamespace
LEFT JOIN pg_class comp ON comp.oid = t.typrelid
LEFT JOIN pg_description AS d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
WHERE t.oid <> 'trigger'::regtype AND COALESCE(a.callable, true)
  AND prokind = 'f'
  AND p.pronamespace = ANY($1::regnamespace[])
`;
