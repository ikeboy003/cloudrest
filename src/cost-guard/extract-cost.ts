// Pull the Postgres planner's `Total Cost` estimate out of an
// `EXPLAIN (FORMAT JSON)` row set.
//
// The output shape is:
//
//   [{ "QUERY PLAN": [{ "Plan": { "Total Cost": N, ... } }] }]
//
// postgres.js may return the `QUERY PLAN` column as an already-
// parsed object or as a JSON string depending on the type OID the
// driver saw. Handle both.
//
// Returns 0 on any shape the walker doesn't recognize — that maps
// to "cost unknown" in the caller, which is the safe default for a
// guard (allowing the query through rather than blocking on a
// parsing issue).

import type { ResultRow } from '@/executor/types';

export function extractTotalCost(rows: readonly ResultRow[]): number {
  if (rows.length === 0) return 0;
  const first = rows[0] as Record<string, unknown>;
  let plan: unknown = first['QUERY PLAN'];
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      return 0;
    }
  }
  if (!Array.isArray(plan) || plan.length === 0) return 0;
  const top = plan[0] as { Plan?: { ['Total Cost']?: number } };
  const cost = top?.Plan?.['Total Cost'];
  return typeof cost === 'number' ? cost : 0;
}
