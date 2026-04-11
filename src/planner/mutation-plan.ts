// MutationPlan — typed description of an INSERT / UPDATE / DELETE /
// UPSERT request handed from the planner to the mutation builder.
//
// INVARIANT (CONSTITUTION §1.1, §1.6): every feature is a FIELD on
// the plan. The old code's `buildInsertQuery` vs `buildInsertCte`
// parallel pair is collapsed to a single renderer driven by a
// `wrap` flag on the plan.
//
// INVARIANT (critique #74): `missingColumns` on InsertPlan is the
// set of columns OMITTED from the payload that the planner wants
// the builder to omit from the INSERT column list (so the DB applies
// its DEFAULT). For `missing=null` the planner instead includes
// every non-defaulted column and lets the body's NULL flow through.

import type { QualifiedIdentifier } from '../http/request';
import type { Filter, LogicTree } from '../parser/types';

export type WrapShape = 'result' | 'cteOnly';

export type ReturnPreference = 'minimal' | 'headersOnly' | 'full';

/**
 * Column metadata the builder needs inline: name, Postgres type,
 * whether it's generated, whether it carries a DEFAULT expression.
 *
 * Matches a subset of `schema/table.ts::Column`. Kept separate so a
 * Stage 9 MutationPlan stays self-contained.
 */
export interface PlannedColumn {
  readonly name: string;
  readonly type: string;
  readonly hasDefault: boolean;
  readonly generated: boolean;
}

/**
 * ON CONFLICT resolution strategy for upserts.
 * `mergeDuplicates` → DO UPDATE SET col = EXCLUDED.col
 * `ignoreDuplicates` → DO NOTHING
 */
export type ConflictResolution = 'mergeDuplicates' | 'ignoreDuplicates';

export interface OnConflictPlan {
  readonly resolution: ConflictResolution;
  readonly columns: readonly string[];
}

// ----- Variants --------------------------------------------------------

export interface InsertPlan {
  readonly kind: 'insert';
  readonly target: QualifiedIdentifier;
  /** Raw JSON body (single row object or array of row objects). */
  readonly rawBody: string;
  /** Whether the body is a JSON array. */
  readonly isArrayBody: boolean;
  /** Columns the builder should emit in the INSERT column list. */
  readonly columns: readonly PlannedColumn[];
  /** Empty-body `DEFAULT VALUES` fallback (happens when payload is `{}`). */
  readonly defaultValues: boolean;
  readonly onConflict: OnConflictPlan | null;
  /** Primary-key column names — used to emit the Location header. */
  readonly primaryKeyColumns: readonly string[];
  readonly returnPreference: ReturnPreference;
  /** 'result' = full wrapped result; 'cteOnly' = just the CTE SQL. */
  readonly wrap: WrapShape;
}

export interface UpdatePlan {
  readonly kind: 'update';
  readonly target: QualifiedIdentifier;
  readonly rawBody: string;
  readonly columns: readonly PlannedColumn[];
  readonly filters: readonly Filter[];
  readonly logic: readonly LogicTree[];
  readonly returnPreference: ReturnPreference;
  readonly wrap: WrapShape;
}

export interface DeletePlan {
  readonly kind: 'delete';
  readonly target: QualifiedIdentifier;
  readonly filters: readonly Filter[];
  readonly logic: readonly LogicTree[];
  readonly returnPreference: ReturnPreference;
  readonly wrap: WrapShape;
}

export type MutationPlan = InsertPlan | UpdatePlan | DeletePlan;
