// HandlerContext — the single bundle of request-scoped dependencies that
// every handler receives. This exists to kill the 10-positional-parameter
// pattern the old code suffered from (see CRITIQUE.md #2 on READABILITY).
//
// INVARIANT: A handler's public signature is always `(request, context)`.
// Adding a dependency means adding a field here, not a positional parameter.
//
// Each field below is typed against the stage that first populates it.
// Stages 2–8 widen these placeholders into real types. Placeholders exist
// as `unknown` so that a too-early consumer is a type error, not a silent
// `any` that compiles and explodes at runtime.
//
// See ARCHITECTURE.md § Lifecycle contracts for how this context flows
// through the eight-step lifecycle.

// ----- Placeholder types ------------------------------------------------
//
// These are replaced by real imports as each stage lands. The placeholder
// strategy is deliberate: we want `context.schema` (etc.) to fail
// typecheck before its stage lands, not compile as `any`.

// AppConfig is real as of stage 2; see config/schema.ts.
export type { AppConfig } from '../config/schema';

/** Populated in stage 8 (schema/cache). */
export type SchemaCache = { readonly __stage8Placeholder: unique symbol };

/** Populated in stage 11 (auth security). */
export type AuthResult = { readonly __stage11Placeholder: unique symbol };

/** Populated in stage 7 (executor/timing). */
export type RequestTimer = { readonly __stage7Placeholder: unique symbol };

/**
 * The raw Cloudflare Worker bindings. This is the one place env is read
 * from; every other module receives it via HandlerContext or AppConfig.
 */
export type { Env as WorkerBindings } from '../config/env';

/**
 * Cloudflare Worker execution context. Exposes `waitUntil` for deferred
 * work and `passThroughOnException` for realtime/admin.
 *
 * RUNTIME: promises not handed to `waitUntil` are cancelled when the
 * outer fetch returns. Fire-and-forget is a bug.
 */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// ----- Contexts ---------------------------------------------------------

/**
 * The incoming HTTP request plus its execution context. Routes and global
 * middleware (CORS, rate limit) receive this.
 */
export interface RequestContext {
  /** The raw inbound HTTP request — never mutated, never replaced. */
  readonly originalHttpRequest: Request;
  /** Cloudflare Worker execution context for deferred work. */
  readonly executionContext: WorkerExecutionContext;
  /** Raw Cloudflare bindings. */
  readonly bindings: WorkerBindings;
}

/**
 * HandlerContext — the shared request-scoped dependency bundle handlers use.
 *
 * Every handler signature is `handle<Name>(parsedRequest, context: HandlerContext)`.
 * No positional dependency list. Adding a handler dependency means widening
 * this type, not every call site.
 */
export interface HandlerContext extends RequestContext {
  /** Validated, grouped config. Populated by stage 2. */
  readonly config: AppConfig;
  /** Schema introspection cache. Populated by stage 8. */
  readonly schema: SchemaCache;
  /** Authenticated role and JWT claims. Populated by stage 11. */
  readonly auth: AuthResult;
  /** Per-request timing recorder for Server-Timing. Populated by stage 7. */
  readonly timer: RequestTimer;
}
