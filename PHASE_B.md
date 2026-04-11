# Phase B plan

Phase A (stages 0–6) established the substrate: core primitives, config, HTTP parsing, parser split, SqlBuilder, and the read builder. Phase B wires everything into a running Worker and hardens every security-critical path.

This file is the source of truth for Phase B. If a stage moves or splits, update this document in the same PR.

Conventions:
- Every stage names its **scope**, **modules**, **old sources consulted**, **old tests used as evidence**, and **critique findings it closes**.
- Every stage ends with `npm run typecheck && npm test` green.
- No stage mixes refactor and security fix in the same diff. Auth is the canonical example — Stage 8a moves files, Stage 11 changes behavior.

---

## Stage 6b — Complete the read planner

Phase A shipped the `ReadPlan` type and `buildReadQuery`, plus a Stage 6a `planRead` that handles root-level filters/order/select/distinct against a schema cache. Stage 6b finishes the planner so it can accept every query-param shape the parser emits.

**Scope.**
- Embed resolution: relationship lookup (`schema/relationship.ts`), embed plan tree, per-embed filter/order/range/logic attachment, join-type handling (`!inner`, `!left`), alias/hint resolution.
- Embedded filter/logic/order terms — consume `parsed.filtersNotRoot`, the non-root entries in `parsed.logic`, and non-root `parsed.order` entries.
- `?search=` / `?search.columns=` / `?search.language=` parsing into a `SearchPlan`, validated against the schema.
- `?vector=` / `?vector.column=` / `?vector.op=` parsing into a `VectorPlan`, validated against the schema.
- Select-list column validation including aggregate columns (`avg(rating)` requires `rating` on the table).
- Cursor-token decoding (signed and unsigned forms).

**Modules.**
- [src/planner/plan-read.ts](src/planner/plan-read.ts) — widen to consume embeds, search, vector.
- [src/planner/embed-plan.ts](src/planner/embed-plan.ts) — new: embed tree resolution.
- [src/planner/search.ts](src/planner/search.ts) — new: parse URL params into a `SearchPlan`.
- [src/planner/vector.ts](src/planner/vector.ts) — new: parse URL params into a `VectorPlan`.
- [src/schema/relationship.ts](src/schema/relationship.ts) — new: FK graph lookup used by embed planning.

**Old sources consulted.**
- [cloudrest-public/src/planner/read-plan.ts](../cloudrest-public/src/planner/read-plan.ts)
- [cloudrest-public/src/schema/relationship.ts](../cloudrest-public/src/schema/relationship.ts)
- [cloudrest-public/src/builder/embed.ts](../cloudrest-public/src/builder/embed.ts) — read for embed SQL shape, not for "how to inject"
- [cloudrest-public/src/builder/search.ts](../cloudrest-public/src/builder/search.ts) — read for parameter parsing only
- [cloudrest-public/src/builder/vector.ts](../cloudrest-public/src/builder/vector.ts) — read for parameter parsing only

**Old tests.**
- [cloudrest-public/tests/builder-query.test.ts](../cloudrest-public/tests/builder-query.test.ts) — embed-shape assertions become `buildReadQuery` contract tests against hand-built plans.
- [cloudrest-public/tests/nested-insert.test.ts](../cloudrest-public/tests/nested-insert.test.ts) — relationship resolution corner cases.
- [cloudrest-public/tests/vector.test.ts](../cloudrest-public/tests/vector.test.ts) — vector plan assertions (not builder-internal).

**New tests.**
- `tests/unit/planner/plan-read-embeds.test.ts` — embed resolution including hint/alias/join-type.
- `tests/unit/planner/search.test.ts` — URL params → `SearchPlan`.
- `tests/unit/planner/vector.test.ts` — URL params → `VectorPlan`.
- `tests/contract/parser-to-planner.test.ts` — the parser's output shape matches the planner's input.

**Critique findings closed.** IDENTIFIER-11 (search columns silently filtered — now rejected at plan time), follow-ups to #68/#72 for aggregate column validation.

**Builder impact.** `builder/read.ts` must widen to render embeds. The embed subquery shape matches PostgREST: `LATERAL`-joined aggregates for to-many, scalar correlated subqueries for to-one. Search/vector/distinct are already first-class.

---

## Stage 7 — Executor boundary

Phase A has no DB execution path. Stage 7 is the first time the Worker opens a Postgres connection.

**Scope.**
- One long-lived postgres.js client per isolate (`getPostgresClient(env)` memoized).
- `runQuery(context, built, options): Promise<Result<QueryResult, CloudRestError>>` — the single query function every handler uses.
- `TransactionOutcome` explicit union — `Commit | Rollback | MaxAffectedViolation | PgError`. No thrown sentinel objects in the public signature; if the underlying lib requires throwing to unwind, the throw is private to `executor/transaction.ts` and caught once.
- `SET LOCAL statement_timeout = ${config.database.statementTimeoutMs}` on every transaction.
- `SET LOCAL ROLE` + pre-request SQL prelude, driven by handler-supplied options.
- One `parseResponseGucHeaders` helper in `response/guc.ts`, used by both read and mutation paths (critique #6).
- `QueryResult` type — rows plus parsed `response.headers` / `response.status` GUCs.

**Modules.**
- [src/executor/client.ts](src/executor/client.ts)
- [src/executor/execute.ts](src/executor/execute.ts)
- [src/executor/transaction.ts](src/executor/transaction.ts)
- [src/executor/statement-timeout.ts](src/executor/statement-timeout.ts) — could be inlined; break out only if it justifies its own file.
- [src/response/guc.ts](src/response/guc.ts)

**Old sources consulted.**
- [cloudrest-public/src/executor.ts](../cloudrest-public/src/executor.ts) — every line. This is the biggest "do not copy the shape" file.
- [cloudrest-public/src/response.ts](../cloudrest-public/src/response.ts) — GUC header parsing at both line 112 and the one `index.ts` inlined.

**Old tests.**
- [cloudrest-public/tests/executor.test.ts](../cloudrest-public/tests/executor.test.ts) — port, but rewrite assertions to target the `TransactionOutcome` union rather than the thrown-sentinel shape.
- [cloudrest-public/tests/tx-policy-matrix-critical.test.ts](../cloudrest-public/tests/tx-policy-matrix-critical.test.ts) — port as-is (behavior, not implementation).

**New tests.**
- `tests/unit/executor/transaction-outcomes.test.ts` — every branch of `TransactionOutcome` is exercised.
- `tests/unit/executor/statement-timeout.test.ts` — timeout is always set, value comes from config.
- `tests/contract/guc-parser.test.ts` — identical inputs produce identical header mutations and identical errors for read and mutation paths.

**Critique findings closed.** #4, #6, #63, #64, #65, #66, #67.

---

## Stage 8 — First end-to-end slice: `GET /{relation}`

First stage that produces a real HTTP response. Wires router → handler → parser → planner → builder → executor → response.

**Scope.**
- `router/fetch.ts` — top-level dispatch (under 200 lines). Reads config, parses HTTP, authenticates (stub), resolves action, calls the right handler.
- `router/routes.ts` — pattern-match route table.
- `handlers/read.ts` — eight lines of orchestration, matching the ARCHITECTURE.md lifecycle diagram exactly.
- `response/build.ts` — `QueryResult + ReadPlan → RawDomainResponse`.
- `response/finalize.ts` — one finalization pipeline. Every response exits through this: GUC, Server-Timing, cache headers, Content-Range, ETag, Content-Length.
- `schema/*` ported from the old code with minimal changes. Auth is a stub that extracts a bearer token without verifying.

**Sub-stage 8a (file moves only).** Split [cloudrest-public/src/auth.ts](../cloudrest-public/src/auth.ts) into `auth/authenticate.ts`, `auth/jwt.ts`, `auth/jwks.ts`, `auth/pem.ts`, `auth/claims.ts`, `auth/base64.ts` — preserving behavior exactly. No security fixes here. Stage 11 changes behavior.

**Modules.**
- [src/router/fetch.ts](src/router/fetch.ts), [src/router/routes.ts](src/router/routes.ts)
- [src/handlers/read.ts](src/handlers/read.ts)
- [src/response/build.ts](src/response/build.ts), [src/response/finalize.ts](src/response/finalize.ts)
- [src/schema/cache.ts](src/schema/cache.ts), [src/schema/introspect.ts](src/schema/introspect.ts), [src/schema/identifiers.ts](src/schema/identifiers.ts), [src/schema/routine.ts](src/schema/routine.ts), [src/schema/table.ts](src/schema/table.ts) — some of these may already exist as stubs from Stage 6b.
- [src/auth/*.ts](src/auth/) — file split only.

**Old sources consulted.**
- [cloudrest-public/src/index.ts](../cloudrest-public/src/index.ts) — fetch handler and the GET-relation path. Used as a checklist, not a template.
- [cloudrest-public/src/response.ts](../cloudrest-public/src/response.ts)
- [cloudrest-public/src/auth.ts](../cloudrest-public/src/auth.ts) (Stage 8a).

**Old tests.**
- [cloudrest-public/tests/index.fetch.test.ts](../cloudrest-public/tests/index.fetch.test.ts) — port the GET-relation cases as `tests/behavior/read.test.ts`, swapping the executor for a `fakeExecutor` fixture.
- [cloudrest-public/tests/request.test.ts](../cloudrest-public/tests/request.test.ts) — the GET portions.

**New tests.**
- `tests/behavior/read.test.ts` — end-to-end, real parser/planner/builder, fake executor.
- `tests/contract/no-post-hoc-sql-edits.test.ts` — structural assertion: `handlers/read.ts` + downstream never call `.replace()` on any `BuiltQuery.sql`.

**Critique findings closed.** #1 (index.ts monolith), the READABILITY_REVIEW "big four" — GUC duplication, handler positional parameter bloat, post-hoc SQL, request variable names.

**Behavior preservation matters most here.** This is where the new pipeline first meets the old test corpus. Every GET-relation assertion must pass or be deliberately replaced with a better one.

---

## Stage 9 — Mutation handler

**Scope.**
- `MutationPlan` type (Insert/Update/Delete/Upsert variants) with `columns`, `onConflict`, `returning`, `payload`, `missing` handling fields.
- `planMutation` — schema-aware column validation, `missing=default` vs `missing=null` handling (critique #74: defaulted columns excluded from the INSERT when absent from the payload), `on_conflict` validation.
- `builder/mutation.ts` — **one** mutation plan renderer that emits either the wrapped-result form or the CTE-only form via a single option, NOT two parallel code paths (READABILITY_REVIEW §8, critique #8).
- `RETURNING *` uses the schema-qualified form to avoid the duplicate-columns bug (critique #76).
- `handlers/mutation.ts` — thin orchestration matching the read handler's shape.
- Payload parser wired in: `parsePayload` handles JSON, CSV, form-urlencoded, with the Stage 4 hardening (critique #44 body size pre-check, #46 form duplicate keys, #47 CSV NULL).

**Modules.**
- [src/planner/mutation-plan.ts](src/planner/mutation-plan.ts)
- [src/planner/plan-mutation.ts](src/planner/plan-mutation.ts)
- [src/builder/mutation.ts](src/builder/mutation.ts)
- [src/handlers/mutation.ts](src/handlers/mutation.ts)
- [src/parser/payload.ts](src/parser/payload.ts) — ported with hardening; the file exists in parser/ as scaffolding but is empty at the end of Phase A.

**Old sources consulted.**
- [cloudrest-public/src/builder/mutations.ts](../cloudrest-public/src/builder/mutations.ts)
- [cloudrest-public/src/parser/payload.ts](../cloudrest-public/src/parser/payload.ts)

**Old tests.**
- [cloudrest-public/tests/builder-mutations-rpc-prequery.test.ts](../cloudrest-public/tests/builder-mutations-rpc-prequery.test.ts) — mutation portion.
- [cloudrest-public/tests/nested-insert.test.ts](../cloudrest-public/tests/nested-insert.test.ts)
- [cloudrest-public/tests/payload-form-critical.test.ts](../cloudrest-public/tests/payload-form-critical.test.ts)
- [cloudrest-public/tests/preferences-payload.test.ts](../cloudrest-public/tests/preferences-payload.test.ts)

**New tests.** Regression tests for #44, #46, #47, #74, #76, each comment-linked to the critique finding.

**Critique findings closed.** #44, #46, #47, #74, #76, READABILITY_REVIEW §8.

---

## Stage 10 — RPC handler

**Scope.**
- `RpcPlan` type — routine lookup, parameter binding, SETOF vs scalar return.
- `planRpc` — routine validation, volatility handling, parameter type checks.
- `builder/rpc.ts` — single routine invocation renderer.
- `handlers/rpc.ts` — the `POST /rpc/foo` empty-body `{}` shortcut lives HERE, not in the generic payload parser (critique #48).
- `handlers/schema-root.ts` — `GET /` OpenAPI root.

**Modules.**
- [src/planner/rpc-plan.ts](src/planner/rpc-plan.ts), [src/planner/plan-rpc.ts](src/planner/plan-rpc.ts)
- [src/builder/rpc.ts](src/builder/rpc.ts)
- [src/handlers/rpc.ts](src/handlers/rpc.ts), [src/handlers/schema-root.ts](src/handlers/schema-root.ts)

**Old sources consulted.**
- [cloudrest-public/src/builder/rpc.ts](../cloudrest-public/src/builder/rpc.ts)
- [cloudrest-public/src/openapi.ts](../cloudrest-public/src/openapi.ts)

**Critique findings closed.** #48, partial #15 (IDENTIFIER list from earlier review).

---

## Stage 11 — Auth security fixes

Auth-hardening stage. File splits happened in Stage 8a; this is the behavior-change diff that's safe to review in isolation.

**Scope (every item closes a security finding).**
- §11.1: `alg=none` explicit reject at the top of `verifyAndDecode`.
- §11.2: JWT cache keyed by `SHA-256(token)`, not the raw token.
- §11.3: JWT cache respects `exp` and has a bounded no-exp TTL.
- §11.4: Negative cache for invalid tokens with shorter TTL.
- §11.5: JWKS cache versioned by fetch timestamp, not clear-on-refresh.
- §11.6: JWKS URL scheme allowlist (`https` only).
- §11.7: Claim path parse errors surface at config-load time (already landed in Stage 2's `validateRoleClaim`; Stage 11 wires the full auth walker to use the validated path).
- §11.8: `CLIENT_ERROR_VERBOSITY=minimal` applied at response finalization.
- §11.9: `Bearer` WWW-Authenticate challenges match PostgREST for PGRST301/302/303.

**Modules.**
- [src/auth/authenticate.ts](src/auth/authenticate.ts), [src/auth/jwt.ts](src/auth/jwt.ts), [src/auth/jwks.ts](src/auth/jwks.ts), [src/auth/claims.ts](src/auth/claims.ts)
- [src/response/finalize.ts](src/response/finalize.ts) — Bearer challenge headers.

**Old tests.**
- [cloudrest-public/tests/auth.test.ts](../cloudrest-public/tests/auth.test.ts) — port as behavior evidence; add new assertions for every finding.

**Critique findings closed.** #15, #16, #17, #18, #19, #20, #21, #22, #23.

---

## Stage 12 — Realtime auth + schema-aware routing

**Scope.**
- Realtime WebSocket upgrade goes through `router/fetch.ts` and the full auth pipeline BEFORE the DO upgrade completes.
- SSE stream (`handleSSEStream`) does the same.
- `realtime/poll.ts` opens its DB connection through `runQuery` with `SET LOCAL ROLE` and `request.jwt.claims` set — not a bare postgres.js connection.
- `_cloudrest_changes` table schema adds `tenant_claims jsonb` and the example trigger captures `current_setting('request.jwt.claims', true)`.
- Durable Object name and subscription filters include the schema (`public.orders` ≠ `analytics.orders`).
- Default change-log trigger writes primary key only, not `to_jsonb(NEW)`.

**Modules.**
- [src/realtime/route.ts](src/realtime/route.ts), [src/realtime/poll.ts](src/realtime/poll.ts)
- Migration in `examples/rls/` for the new table shape.

**Old sources consulted.**
- [cloudrest-public/src/realtime.ts](../cloudrest-public/src/realtime.ts), [cloudrest-public/src/realtime-poll.ts](../cloudrest-public/src/realtime-poll.ts)

**Critique findings closed.** #24, #25, #26, #27, #28, #29, #30, #82.

---

## Stage 13 — Edge cache correctness

**Scope.**
- Cache key includes the caller's role fingerprint and relevant JWT claims. Not just Accept/Range.
- Caching is opt-in per table (config registry). Default = no caching.
- `shouldCache` considers whether pre-request hooks are configured (if yes, never cache).
- `ctx.waitUntil` vs inline put is a deliberate policy, not a call-site accident.

**Modules.**
- [src/cache/key.ts](src/cache/key.ts), [src/cache/store.ts](src/cache/store.ts)

**Old tests.**
- [cloudrest-public/tests/edge-cache-critical.test.ts](../cloudrest-public/tests/edge-cache-critical.test.ts)

**Critique findings closed.** #31, #32, #33.

---

## Stage 14 — Webhooks

**Scope.**
- SSRF protection resolves the hostname and rejects RFC 1918 / link-local / loopback / Cloudflare IP ranges.
- Redirects disabled (`redirect: 'manual'`); every hop is re-validated.
- HMAC signature covers `timestamp + "." + table + "." + mutation + "." + body`, not just body.
- `X-CloudREST-Idempotency-Key` and `X-CloudREST-Attempt` on every request.
- Retry loop runs under `ctx.waitUntil`, not bare fire-and-forget.
- Per-table column allowlist on what appears in the webhook payload (critique #39).

**Modules.**
- [src/webhooks/dispatch.ts](src/webhooks/dispatch.ts), [src/webhooks/sign.ts](src/webhooks/sign.ts), [src/webhooks/ssrf-guard.ts](src/webhooks/ssrf-guard.ts)

**Critique findings closed.** #34, #35, #36, #37, #38, #39.

---

## Stage 15 — Batch API

**Scope.**
- Reference resolver walks the parsed JSON body and substitutes at the AST node level. No string `replace`.
- `MAX_BATCH_OPS` and `MAX_BATCH_BODY_BYTES` move to `config.limits.batch`.
- `Content-Length` is checked before `request.text()` buffers the body.
- Sub-request batching re-uses the main pipeline via a typed in-process dispatch, not by recursively calling `module.default.fetch`.

**Modules.**
- [src/batch/dispatch.ts](src/batch/dispatch.ts), [src/batch/refs.ts](src/batch/refs.ts)

**Critique findings closed.** #49, #50, #51, #52, #53.

---

## Stage 16 — Rate limit, CORS, admin auth

**Scope.**
- Rate limit: keep the in-memory per-isolate limiter but document it honestly in config and `ARCHITECTURE.md`. Add the Durable Object counter option.
- CORS: Stage 2 already made it opt-in at config load. Stage 16 wires the runtime side — preflights return 403 when `cors.allowedOrigins` is null, `Vary: Origin` on every non-wildcard response regardless of credentials.
- Admin auth: every `/_admin/*` route requires `ADMIN_AUTH_TOKEN` via constant-time comparison.
- `DB_DEBUG_ENABLED=true` emits `X-CloudREST-Debug: enabled` response header and logs a boot-time warning.

**Modules.**
- [src/router/cors.ts](src/router/cors.ts), [src/router/rate-limit.ts](src/router/rate-limit.ts)
- [src/handlers/admin/*.ts](src/handlers/admin/)

**Critique findings closed.** #54, #55, #56, #58, #59, #83, #84.

---

## Stage 17 — Schema coordinator

**Scope.**
- Typed codec for `SchemaCache` serde (`Map`, `Set`, and every non-JSON type explicit).
- Schema reload is atomic: `this.cache` is set after `writeSchemaToKV` completes, in one step.
- Schema introspection goes through `runQuery`, not a bare `pg.Client`.
- CloudREST bookkeeping tables live in a `cloudrest` schema, not the user's `public`.
- `_cloudrest_changes` has a retention policy via DO alarm.

**Modules.**
- [src/schema/coordinator.ts](src/schema/coordinator.ts), [src/schema/codec.ts](src/schema/codec.ts)
- Migration to move the bookkeeping tables.

**Critique findings closed.** #60, #61, #62, #80, #81.

---

## Stage 18 — Observability and admin split

**Scope.**
- Split [cloudrest-public/src/admin.ts](../cloudrest-public/src/admin.ts) into `admin/routes.ts`, `admin/metrics.ts`, `admin/fingerprints.ts`, `admin/slow-queries.ts`, `admin/index-hints.ts`.
- Split timing/fingerprint infra into `observability/`.
- Server-Timing emission lives in `response/finalize.ts`, fed by a `RequestTimer` that travels on `HandlerContext`.

**Modules.**
- [src/admin/*.ts](src/admin/), [src/observability/*.ts](src/observability/)

**Critique findings closed.** READABILITY_REVIEW §12.

---

## Stage 19 — Dead-code removal and final architecture pass

**Scope.**
- Delete stub files that never got populated in the rewrite (the Phase A planner `plan-read.ts` stub will have been replaced in 6b; anything else is fair game for removal).
- `src/handlers/` empty directory — delete (critique #88).
- Confirm no comment in `src/` matches `Task \d|Feature \d|TODO\(.*\d{4}-\d{2}` (constitution §15.1).
- `ARCHITECTURE.md` final pass: every "Where do I add X?" answer points to a real module.
- Migration ledger: every old test is either ported, rewritten, or explicitly marked as "deleted because it encoded bug #N".
- One round of `npx depcruise` (or equivalent) to catch any circular imports.

**Modules.** None — this is cleanup.

**Critique findings closed.** #88, #89, any remaining M-severity items.

---

## Out of this plan

Items the critique flagged that the rewrite does NOT address, and why:

- **#7** (task-number comments): addressed in constitution §15.1; enforcement is code review.
- **#85** (ETag canonicalization): lands with Stage 8 (`response/finalize.ts`) since that's where ETags are computed. If it slips, add a follow-up stage.
- **#86** (Content-Length via double-encode): minor perf, not correctness. Stage 8 picks up the cheap fix.
- **#87** (CSV re-parse): perf, not correctness. Stage 8 or 18.
- **Dependency audit on `pgvector`** and other unpinned deps: follow-up.
- **Live differential testing against real PostgREST**: not a code change — a test strategy. Separate effort.

---

## Stage gate reminder

Before starting any Phase B stage:

1. Name the stage in one sentence.
2. List modules that will be created or changed.
3. List old source files consulted.
4. List old tests used as evidence.
5. State expected behavior changes. Default is none.

Before finishing:

1. `npm run typecheck` clean.
2. `npm test` green.
3. `ARCHITECTURE.md` divergence section updated for any behavior change.
4. New regression tests comment-link their critique finding numbers.
5. No file over 500 lines (constitution §17.2).
