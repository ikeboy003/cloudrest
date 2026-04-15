// Per-request GUC rendering for `config.database.appSettings` and
// `config.database.extraSearchPath`.
//
// INVARIANT: values reach SQL through bind parameters, never via
// string concatenation. `set_config($1, $2, true)` with two
// bound params per setting, so a hostile key ending in `')--` cannot
// terminate the literal.
//
// The OUTPUT shape is a `BuiltQuery`-compatible `{ sql, params }`
// pair so the transaction runner can feed it straight into
// `tx.unsafe(sql, params)` — the same path the main query takes.

import type { DatabaseConfig } from '@/config/schema';

export interface AppSettingsBuilt {
  readonly sql: string;
  readonly params: readonly string[];
}

/**
 * Build a combined prelude statement that issues `set_config` for:
 *  1. `search_path` — a single literal built from `schemas` joined
 *     with `extraSearchPath`. Identifier safety is the caller's
 *     problem; schemas come from the config load step where a parse
 *     error is already surfaced.
 *  2. Every key in `appSettings` as a plain GUC.
 *
 * Returns `null` when there is nothing to issue — the transaction
 * runner skips the step entirely.
 *
 * The shape is:
 *
 *   SELECT set_config($1, $2, true),
 *          set_config($3, $4, true),
 *          ...
 *
 * which postgres.js executes as one round-trip.
 */
export function buildAppSettingsPrelude(
  db: Pick<DatabaseConfig, 'schemas' | 'extraSearchPath' | 'appSettings'>,
): AppSettingsBuilt | null {
  const pairs: [string, string][] = [];

  // search_path — always set when we have at least one schema, which
  // is always true because config.load.ts defaults to ['public'].
  if (db.schemas.length > 0 || db.extraSearchPath.length > 0) {
    const combined = [...db.schemas, ...db.extraSearchPath]
      .map((s) => quoteSearchPathItem(s))
      .join(', ');
    pairs.push(['search_path', combined]);
  }

  for (const [key, value] of Object.entries(db.appSettings)) {
    pairs.push([key, value]);
  }

  if (pairs.length === 0) return null;

  const setConfigs: string[] = [];
  const params: string[] = [];
  for (const [key, value] of pairs) {
    const keyParam = `$${params.length + 1}`;
    params.push(key);
    const valueParam = `$${params.length + 1}`;
    params.push(value);
    setConfigs.push(`set_config(${keyParam}, ${valueParam}, true)`);
  }

  return {
    sql: `SELECT ${setConfigs.join(', ')}`,
    params,
  };
}

/**
 * Quote a schema name for inclusion in a `search_path` list. Postgres
 * expects identifiers double-quoted with internal quotes doubled. The
 * whole quoted form is then safe to embed in the GUC value (which
 * reaches Postgres via a bind parameter, not string concatenation).
 */
function quoteSearchPathItem(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
