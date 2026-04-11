// ParsedQueryParams — the aggregate output of parser/query-params.ts.
//
// INVARIANT: This is the typed contract handed from the parser to the
// planner (stage 6). Every field here has a specific owner module that
// emitted it, and the planner reads it as-is.

import type { EmbedPath } from './embed';
import type { Filter } from './filter';
import type { HavingClause } from './having';
import type { LogicTree } from './logic';
import type { OrderTerm } from './order';
import type { SelectItem } from './select';
import type { NonnegRange } from '../../http/range';

export interface ParsedQueryParams {
  /** Canonical (sorted, encoded) query string used for cache keys and cursor tokens. */
  readonly canonical: string;
  /** Non-filter, non-reserved key/value pairs. The planner treats these as RPC params. */
  readonly rpcParams: readonly (readonly [string, string])[];
  /**
   * Per-embed-path range overrides. Key is the embed path joined with `\0`;
   * the root range lives under the key `"limit"`.
   */
  readonly ranges: ReadonlyMap<string, NonnegRange>;
  /** Per-embed-path order terms; empty path is the root. */
  readonly order: readonly (readonly [EmbedPath, readonly OrderTerm[]])[];
  /** Per-embed-path logic trees. */
  readonly logic: readonly (readonly [EmbedPath, LogicTree])[];
  /** Explicit `?columns=` restriction for mutations. Null = all columns. */
  readonly columns: ReadonlySet<string> | null;
  /** Parsed select items. Empty array = implicit `*`. */
  readonly select: readonly SelectItem[];
  /** All filters, flat. Each entry carries its embed path (empty = root). */
  readonly filters: readonly (readonly [EmbedPath, Filter])[];
  readonly filtersRoot: readonly Filter[];
  readonly filtersNotRoot: readonly (readonly [EmbedPath, Filter])[];
  readonly filterFields: ReadonlySet<string>;
  /** `?on_conflict=a,b` column list for upsert resolution. */
  readonly onConflict: readonly string[] | null;
  readonly having: readonly HavingClause[];
  /**
   * `?distinct=col1,col2` column list for `SELECT DISTINCT ON (...)`.
   * Null = no DISTINCT; empty array = `DISTINCT` with no ON clause.
   */
  readonly distinct: readonly string[] | null;
  /**
   * `?cursor=...` opaque cursor token. Verification and decoding live
   * in the executor (HMAC). The parser just threads the value through.
   *
   * BUG FIX (#Z): the old dispatcher marked `cursor` as reserved and
   * silently dropped it. Planner/executor can now see the value via
   * this field once they are ready to consume it.
   */
  readonly cursor: string | null;
  /**
   * `?vector=...&vector.column=...&vector.op=...` vector search inputs.
   * The parser threads the raw values through; the planner validates
   * the column against the schema and chooses the distance function.
   *
   * BUG FIX (#Z): the old dispatcher marked these reserved and
   * silently dropped them.
   */
  readonly vector: {
    readonly value: string;
    readonly column: string | null;
    readonly op: string | null;
  } | null;
  /**
   * `?search=...&search.columns=...&search.language=...&search.rank=...`
   * full-text-search inputs. Parser owns extraction; the planner
   * owns column validation.
   *
   * BUG FIX (#EE5): search keys used to only reach the planner via
   * a side-channel `PlanReadInput.search` that the handler had to
   * pluck manually. The parser-to-planner contract now threads
   * them through `ParsedQueryParams` for consistency with vector.
   */
  readonly search: {
    readonly term: string;
    readonly columns: string | null;
    readonly language: string | null;
    readonly includeRank: boolean;
  } | null;
}
