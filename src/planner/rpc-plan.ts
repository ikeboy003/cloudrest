// RpcPlan — typed description of a `POST /rpc/fn` (or `GET /rpc/fn`)
// handed from the planner to the RPC builder.
//
// INVARIANT (CONSTITUTION §1.1): every feature is a field. There
// are no "maybe this, maybe that" side channels — the planner
// decides the calling convention (named args vs single JSON body
// vs no args) and the builder renders it directly.
//
// Stage 10 scope: scalar, setOf-scalar, composite, and setOf-
// composite returns. Filter/order/range layering on top of the
// RPC result set is supported through the same fields the read
// plan uses.

import type { QualifiedIdentifier } from '@/http/request';
import type {
  Filter,
  LogicTree,
  OrderTerm,
  SelectItem,
} from '@/parser/types';
import type { NonnegRange } from '@/http/range';
import type { Routine } from '@/schema/routine';
import type { ReturnPreference } from './mutation-plan';

/**
 * Calling convention the builder should emit.
 *
 * - `named`:         `fn(arg1 := $1, arg2 := $2)` — classic POST with
 *                    a JSON object body, or a GET with query params.
 * - `singleUnnamed`: `fn($1::type)` — POST with a raw scalar/JSON
 *                    body and a single unnamed parameter.
 * - `none`:          `fn()` — no arguments.
 */
export type RpcCallShape = 'named' | 'singleUnnamed' | 'none';

export interface RpcPlan {
  readonly kind: 'rpc';
  readonly target: QualifiedIdentifier;
  readonly routine: Routine;

  /** Call shape decided by the planner. */
  readonly callShape: RpcCallShape;

  /**
   * Arguments for the `named` shape. Keys are parameter names; values
   * are raw strings (from query params) or JSON-encoded strings (from
   * the body). The builder binds each value via `SqlBuilder.addParam`
   * with an explicit type cast.
   */
  readonly namedArgs: readonly (readonly [string, string])[];

  /**
   * Body payload for the `singleUnnamed` shape. Null for other
   * shapes.
   */
  readonly rawBody: string | null;

  /**
   * Optional filter/logic/order/range/select layered on top of
   * the RPC result set — PostgREST's "pre-query" story. The
   * planner populates these for composite-return routines; the
   * builder ignores filters/select for scalar-return routines
   * because there are no columns to project or filter over.
   */
  readonly filters: readonly Filter[];
  readonly logic: readonly LogicTree[];
  readonly order: readonly OrderTerm[];
  readonly range: NonnegRange;
  /**
   * `?select=col1,col2` projection. Empty array = `*` (all
   * record columns). Field-only items; embeds on RPC results
   * are not supported.
   */
  readonly select: readonly SelectItem[];

  /** `Prefer: return=representation` vs `minimal`. */
  readonly returnPreference: ReturnPreference;

  /** Pre-computed flags the builder reads — avoids repeating the
   * `funcReturnsScalar(...)` check in two places. */
  readonly returnsScalar: boolean;
  readonly returnsSetOfScalar: boolean;
  readonly returnsVoid: boolean;
}
