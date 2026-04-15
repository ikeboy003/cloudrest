// HandlerContext — the single bundle of request-scoped dependencies that
// every handler receives.
//
// A handler's public signature is always `(request, context)`.
// Adding a dependency means adding a field here, not a positional parameter.

import type { AppConfig } from '@/config/schema';
import type { Env } from '@/config/env';
import type { RequestTimer } from '@/executor/timer';
import type { AuthClaims } from '@/auth/authenticate';
import type { SchemaCache as RealSchemaCache } from '@/schema/cache';

// Re-export the shape of worker bindings under the context-facing name.
export type { AppConfig } from '@/config/schema';
export type WorkerBindings = Env;

export type SchemaCache = RealSchemaCache;

export type AuthResult = AuthClaims;

export type { RequestTimer } from '@/executor/timer';

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
  /** Validated, grouped config. */
  readonly config: AppConfig;
  /** Schema introspection cache. */
  readonly schema: SchemaCache;
  /** Authenticated role and JWT claims. */
  readonly auth: AuthResult;
  /** Per-request timing recorder for Server-Timing. */
  readonly timer: RequestTimer;
}
