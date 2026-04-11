// RPC planner — turns (routine, payload/rpcParams, preferences) into
// a typed `RpcPlan`.
//
// INVARIANT (CONSTITUTION §1.5): routine existence and parameter
// validity are checked HERE, not in the builder. A PGRST203 (no
// such routine) or PGRST202-style argument mismatch surfaces at
// plan time with a meaningful error.

import { err, ok, type Result } from '@/core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '@/core/errors';
import type { QualifiedIdentifier } from '@/http/request';
import type { Preferences } from '@/http/preferences';
import type { NonnegRange } from '@/http/range';
import type {
  Filter,
  LogicTree,
  OrderTerm,
  ParsedQueryParams,
  SelectItem,
} from '@/parser/types';
import type { Payload } from './../parser/payload';
import type { SchemaCache } from '@/schema/cache';
import {
  funcReturnsScalar,
  funcReturnsSetOfScalar,
  funcReturnsVoid,
  routineKey,
  type Routine,
} from '@/schema/routine';
import type { RpcCallShape, RpcPlan } from './rpc-plan';
import type { ReturnPreference } from './mutation-plan';

export interface PlanRpcInput {
  readonly target: QualifiedIdentifier;
  readonly parsed: ParsedQueryParams;
  readonly payload: Payload | null;
  readonly preferences: Preferences;
  readonly schema: SchemaCache;
  readonly topLevelRange: NonnegRange;
}

export function planRpc(input: PlanRpcInput): Result<RpcPlan, CloudRestError> {
  // ----- 1. Routine lookup --------------------------------------------
  const routineResult = resolveRoutine(input.target, input.schema);
  if (!routineResult.ok) return routineResult;
  const routine = routineResult.value;

  // ----- 2. Calling convention ----------------------------------------
  const convention = decideCallShape(routine, input.payload, input.parsed);
  if (!convention.ok) return convention;
  const { callShape, namedArgs, rawBody } = convention.value;

  // ----- 3. Root-level filter/logic/order/select partitioning -------
  const filters: readonly Filter[] = input.parsed.filtersRoot;
  const logic: readonly LogicTree[] = collectRootLogic(input.parsed);
  const order: readonly OrderTerm[] = collectRootOrder(input.parsed);
  // Drop any embed items — RPC result sets have no relationship
  // graph so embed projections aren't meaningful.
  const selectFields: readonly SelectItem[] = input.parsed.select.filter(
    (item) => item.type === 'field',
  );

  // ----- 4. Return preference ----------------------------------------
  const returnPreference: ReturnPreference =
    input.preferences.preferRepresentation ?? 'full';

  return ok({
    kind: 'rpc',
    target: input.target,
    routine,
    callShape,
    namedArgs,
    rawBody,
    filters,
    logic,
    order,
    range: input.topLevelRange,
    select: selectFields,
    returnPreference,
    returnsScalar: funcReturnsScalar(routine),
    returnsSetOfScalar: funcReturnsSetOfScalar(routine),
    returnsVoid: funcReturnsVoid(routine),
  });
}

// ----- Routine resolution ----------------------------------------------

function resolveRoutine(
  target: QualifiedIdentifier,
  schema: SchemaCache,
): Result<Routine, CloudRestError> {
  const key = routineKey(target);
  const candidates = schema.routines.get(key);
  if (candidates === undefined || candidates.length === 0) {
    return err(
      schemaErrors.noRpc(
        target.name,
        target.schema,
        suggestRoutineName(schema, target),
      ),
    );
  }
  // Stage 10 accepts exactly one candidate. Ambiguity (multiple
  // overloads) is a Stage 10.1 concern — PostgREST uses the named-
  // argument set to disambiguate, which requires a per-argument
  // type-compatibility check we defer.
  if (candidates.length > 1) {
    return err(
      schemaErrors.ambiguousRpc(
        `multiple overloads for ${target.schema}.${target.name}; stage 10 accepts a single definition only`,
      ),
    );
  }
  return ok(candidates[0]!);
}

function suggestRoutineName(
  schema: SchemaCache,
  target: QualifiedIdentifier,
): string | null {
  const candidates: string[] = [];
  for (const [, rs] of schema.routines) {
    for (const r of rs) {
      if (r.schema === target.schema) candidates.push(r.name);
    }
  }
  return fuzzyFind(target.name, candidates);
}

// ----- Call-shape decision --------------------------------------------

interface CallShapeResult {
  readonly callShape: RpcCallShape;
  readonly namedArgs: readonly (readonly [string, string])[];
  readonly rawBody: string | null;
}

function decideCallShape(
  routine: Routine,
  payload: Payload | null,
  parsed: ParsedQueryParams,
): Result<CallShapeResult, CloudRestError> {
  // ----- Body-derived named args --------------------------------------
  // POST with a JSON object body — every top-level key becomes a
  // named argument. The JSON body is stringified as an argument
  // value so the builder can bind it via a bound parameter (not
  // inlined).
  if (payload !== null && payload.type === 'json') {
    // Single unnamed positional arg path — `fn(x text)` called with
    // `POST /rpc/fn` and a raw JSON body that isn't an object with
    // matching keys. PostgREST detects this via an unnamed single
    // parameter; we mirror that check.
    const firstParam = routine.params[0];
    const isSingleUnnamed =
      routine.params.length === 1 &&
      firstParam !== undefined &&
      firstParam.name === '';
    if (isSingleUnnamed) {
      return ok({
        callShape: 'singleUnnamed',
        namedArgs: [],
        rawBody: payload.raw,
      });
    }

    // Decode the top-level body keys (parser already validated
    // "array of homogeneous objects" / single object).
    const decoded = safeJsonDecode(payload.raw);
    if (decoded === null || Array.isArray(decoded) || typeof decoded !== 'object') {
      return err(
        parseErrors.invalidBody(
          'RPC call body must be a JSON object with keys matching routine parameter names',
        ),
      );
    }
    const args = extractNamedArgs(
      decoded as Record<string, unknown>,
      routine,
    );
    if (!args.ok) return args;
    return ok({
      callShape: args.value.length === 0 ? 'none' : 'named',
      namedArgs: args.value,
      rawBody: null,
    });
  }

  // ----- URL-encoded body → named args --------------------------------
  if (payload !== null && payload.type === 'urlEncoded') {
    const asObject: Record<string, unknown> = {};
    for (const [k, v] of payload.pairs) asObject[k] = v;
    const args = extractNamedArgs(asObject, routine);
    if (!args.ok) return args;
    return ok({
      callShape: args.value.length === 0 ? 'none' : 'named',
      namedArgs: args.value,
      rawBody: null,
    });
  }

  // ----- GET /rpc/fn?arg=value ----------------------------------------
  if (payload === null) {
    // The parser puts "non-filter, non-reserved" key=value pairs into
    // `rpcParams`. Stage 4 already split filters out; rpcParams is
    // the remaining set.
    const asObject: Record<string, unknown> = {};
    for (const [k, v] of parsed.rpcParams) asObject[k] = v;
    if (Object.keys(asObject).length === 0) {
      return ok({ callShape: 'none', namedArgs: [], rawBody: null });
    }
    const args = extractNamedArgs(asObject, routine);
    if (!args.ok) return args;
    return ok({
      callShape: args.value.length === 0 ? 'none' : 'named',
      namedArgs: args.value,
      rawBody: null,
    });
  }

  return err(
    parseErrors.invalidBody(
      `RPC call cannot use payload type "${payload.type}"`,
    ),
  );
}

function safeJsonDecode(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Validate that every supplied key is a known parameter and that
 * every required parameter was supplied. Values are stringified for
 * binding.
 */
function extractNamedArgs(
  args: Record<string, unknown>,
  routine: Routine,
): Result<readonly (readonly [string, string])[], CloudRestError> {
  const paramByName = new Map<string, (typeof routine.params)[number]>();
  for (const p of routine.params) paramByName.set(p.name, p);

  // Unknown keys — the caller mistyped a parameter.
  for (const key of Object.keys(args)) {
    if (!paramByName.has(key)) {
      return err(
        parseErrors.queryParam(
          'rpc',
          `unknown parameter "${key}" for routine "${routine.schema}.${routine.name}"`,
        ),
      );
    }
  }

  // Missing required — the caller omitted a required parameter.
  for (const p of routine.params) {
    if (p.required && !(p.name in args)) {
      return err(
        parseErrors.queryParam(
          'rpc',
          `missing required parameter "${p.name}" for routine "${routine.schema}.${routine.name}"`,
        ),
      );
    }
  }

  const out: (readonly [string, string])[] = [];
  // Emit in parameter order — Postgres accepts named args in any
  // order, but stable emission makes SQL output deterministic for
  // snapshot-style tests.
  for (const p of routine.params) {
    if (!(p.name in args)) continue;
    const raw = args[p.name];
    out.push([p.name, stringifyArg(raw)]);
  }
  return ok(out);
}

function stringifyArg(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ----- Root partitioning -----------------------------------------------

function collectRootLogic(parsed: ParsedQueryParams): readonly LogicTree[] {
  const out: LogicTree[] = [];
  for (const [path, tree] of parsed.logic) {
    if (path.length === 0) out.push(tree);
  }
  return out;
}

function collectRootOrder(parsed: ParsedQueryParams): readonly OrderTerm[] {
  const out: OrderTerm[] = [];
  for (const [path, group] of parsed.order) {
    if (path.length !== 0) continue;
    for (const term of group) out.push(term);
  }
  return out;
}
