// ReadPlan — typed description of a read query, handed from the planner
// to the read builder.
//
// INVARIANT: Every feature of a read query is a FIELD on ReadPlan, not a
// post-hoc SQL rewrite. CONSTITUTION §1.1 and §1.6.
//
// In particular: search, vector, and distinct are first-class plan
// fields. The old code applied them by string surgery on an already-
// built `query.sql`; the rewrite emits them as part of the single
// render pass in builder/read.ts. See critique findings #2, #12, #72,
// #77, #78.

import type { QualifiedIdentifier } from '@/http/request';
import type { CountPreference } from '@/http/preferences';
import type { MediaTypeId } from '@/http/media/types';
import type { NonnegRange } from '@/http/range';
import type {
  Filter,
  HavingClause,
  LogicTree,
  OrderTerm,
  SelectItem,
} from '@/parser/types';
import type { EmbedNode } from './embed-plan';

// ----- Feature plan fields ---------------------------------------------

export type VectorOp = 'l2' | 'cosine' | 'inner_product' | 'l1';

/**
 * Full-text search. Stage 6 renders this as part of the WHERE clause
 * (via `to_tsvector(...) @@ websearch_to_tsquery(...)`), binds the term
 * and the language through `SqlBuilder.addParam`, and — when requested —
 * also adds a `ts_rank(...) AS relevance` projection.
 *
 * SECURITY (#10): the language token goes through addParam, not inlined.
 */
export interface SearchPlan {
  readonly term: string;
  /** Non-empty list of columns to search over. The planner validates them. */
  readonly columns: readonly string[];
  /** IANA/Postgres tsvector language. Null = `'simple'`. */
  readonly language: string;
  /** When true, add `ts_rank(...) AS relevance` to the projection. */
  readonly includeRank: boolean;
}

/**
 * Vector similarity search. Stage 6 renders this as a distance
 * expression, selects it as `distance`, and uses it as the primary
 * ORDER BY (unless a user-supplied ORDER BY takes precedence — in
 * which case `distance` is appended as a tie-breaker).
 *
 * SECURITY (#77, #78): the vector value is bound through
 * SqlBuilder.addParam; no post-hoc `$N` rewriting ever happens.
 */
export interface VectorPlan {
  readonly queryVector: readonly number[];
  readonly column: string;
  readonly op: VectorOp;
}

/**
 * `DISTINCT ON (col1, col2, ...)`. An empty array produces a bare
 * `SELECT DISTINCT` (no ON clause).
 */
export interface DistinctPlan {
  readonly columns: readonly string[];
}

// ----- ReadPlan ---------------------------------------------------------

/**
 * `ReadPlan` — the typed input to `builder/read.ts`.
 *
 * Every field is readonly. The planner produces a ReadPlan; the builder
 * consumes it; nothing in between modifies it.
 */
export interface ReadPlan {
  /** The table being read. */
  readonly target: QualifiedIdentifier;

  /** Projection. Empty = `SELECT "schema"."table".*`. */
  readonly select: readonly SelectItem[];

  /** Root-level filters. Embedded filters are attached to their embed (future). */
  readonly filters: readonly Filter[];

  /** Root-level logic trees (and/or expressions). */
  readonly logic: readonly LogicTree[];

  /** ORDER BY terms at the root level. */
  readonly order: readonly OrderTerm[];

  /** Effective range (offset + optional limit) after `?limit=`, Range header, and config.maxRows. */
  readonly range: NonnegRange;

  /** HAVING clauses for aggregate queries. */
  readonly having: readonly HavingClause[];

  /** `Prefer: count=` strategy. Null = no total count query. */
  readonly count: CountPreference | null;

  /** Chosen output media type id — affects result shape and optional row-limit. */
  readonly mediaType: MediaTypeId;

  /** Whether the server has a pre-request function configured. */
  readonly hasPreRequest: boolean;

  /** Config-level `DB_MAX_ROWS` ceiling; null = unlimited. */
  readonly maxRows: number | null;

  /** First-class search plan, or undefined. */
  readonly search?: SearchPlan;

  /** First-class vector-similarity plan, or undefined. */
  readonly vector?: VectorPlan;

  /** First-class distinct plan, or undefined. */
  readonly distinct?: DistinctPlan;

  /**
   * Root-level embeds — each entry is a fully resolved `EmbedNode`
   * carrying its relationship, join-shape, and (recursively) its own
   * subtree. Empty array = no embeds.
   *
   * Builder renders these as LATERAL joins, row_to_json / json_agg
   * aggregates, or correlated scalar subqueries (for aggregate embeds).
   */
  readonly embeds: readonly EmbedNode[];
}
