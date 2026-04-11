# CloudREST Architecture

CloudREST exposes a Postgres database as a PostgREST-compatible REST API, running as a Cloudflare Worker. This document is the map a new contributor should read before touching the source.

If you're looking for how to propose changes, run tests, or ship a PR, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Rewrite posture

The rewrite is staged architecture work, not a one-shot port.

Each stage must:

1. Leave the project buildable.
2. Keep tests passing.
3. Introduce a small number of named concepts.
4. Avoid copying old messy structure into new folders.
5. Preserve behavior intentionally, backed by tests or explicit notes.
6. Explain any intentional divergence from CloudREST v1 or PostgREST.

The earlier CloudREST prototype is source material, not architecture authority. Copy behavior when it is desired. Do not copy file shape, naming, hidden coupling, or post-hoc SQL mutation patterns.

---

## Request lifecycle

Every request flows through the same eight steps, in order. Each step has its own module boundary; no step reaches across more than one neighbor.

```
  incoming Request
        |
        v
  1. ROUTE       router/fetch.ts, router/routes.ts
        |         dispatch by method + path
        v
  2. PARSE       http/request.ts, parser/*
        |         headers, Accept, Prefer, query params, payload
        v
  3. VALIDATE    handlers/*, schema/*
        |         schema-aware checks (table exists, columns exist, role can X)
        v
  4. PLAN        planner/read-plan.ts, mutation-plan.ts, rpc-plan.ts
        |         typed ReadPlan / MutationPlan / RpcPlan
        v
  5. BUILD       builder/read.ts, mutation.ts, rpc.ts
        |         plan -> BuiltQuery { sql, params }
        v
  6. EXECUTE     executor/execute.ts, executor/transaction.ts
        |         BuiltQuery -> Result<QueryResult>
        v
  7. RESPOND     response/build.ts
        |         QueryResult + plan -> RawDomainResponse
        v
  8. FINALIZE    response/finalize.ts
        |         headers, GUC, metrics, cache, ETag, Content-Range
        v
  outgoing Response
```

Two rules this pipeline enforces:

1. **One direction only.** Parse never calls build. Build never calls parse. Execute never constructs SQL.
2. **No step edits the previous step's output in place.** Each step takes a typed input and returns a typed output. If you find yourself wanting to `.replace()` a string from a previous step, you are in the wrong module.
3. **No implicit side channels.** If a later step needs information, that information belongs in the typed output of an earlier step. Do not hide required state in globals, mutated request objects, or "everyone knows this was already normalized" assumptions.
4. **No convenience loops back upward.** A lower-level module cannot import a higher-level one for convenience. For example, `batch` should not import the top-level worker entry point just to reuse routing.

### Lifecycle contracts

Each lifecycle step owns a specific input and output shape.

| Step | Input | Output | Failure shape |
|---|---|---|---|
| Route | `Request`, `ExecutionContext`, config | `RouteMatch` | `CloudRestError` or early `Response` |
| Parse | `RouteMatch`, raw HTTP details | typed request pieces | `Result<T>` |
| Validate | parsed request, schema, config | validated request/context | `Result<T>` |
| Plan | validated request | `ReadPlan`, `MutationPlan`, `RpcPlan` | `Result<T>` |
| Build | typed plan | `BuiltQuery` | `Result<T>` only when construction can fail |
| Execute | `BuiltQuery`, execution options | `QueryResult` | `CloudRestError` |
| Respond | `QueryResult`, request/plan metadata | domain response | `CloudRestError` |
| Finalize | domain response, finalization context | `Response` | `Response` |

These contracts are part of the architecture. If a stage starts passing broad bags of unrelated values, introduce a named context type or split the stage.

---

## Module ownership map

| Folder | Owns | Does not own |
|---|---|---|
| `router/` | Top-level dispatch, CORS, rate limit, route matching | Business logic, SQL, response shaping |
| `core/` | `Result<T>`, `CloudRestError`, `HandlerContext`, comment conventions | Anything domain-specific |
| `config/` | Env shape, grouped `AppConfig`, hard validation | Runtime config changes |
| `http/` | HTTP-level parsing: request, media, preferences, range | Query grammar, payload AST |
| `http/media/` | All media parsing, negotiation, and formatting | SQL, query planning |
| `parser/` | Query-param grammars, payload parsers, AST construction | SQL, schema validation, execution |
| `planner/` | Typed plans (`ReadPlan`, `MutationPlan`, `RpcPlan`) | SQL string construction |
| `builder/` | Plan -> `BuiltQuery`; identifier/literal primitives | Request parsing, DB execution |
| `executor/` | Postgres client, transactions, statement timeouts | SQL construction, response shaping |
| `handlers/` | Thin orchestration: parse -> plan -> build -> execute -> respond | Reimplementing any of the above |
| `response/` | Body building, header finalization, GUC | Business logic, SQL |
| `auth/` | JWT, JWKS, claims, role extraction | Non-auth caches, metrics |
| `schema/` | Catalog introspection, schema cache, relationships | Request handling |
| `observability/` | Timing, fingerprints | Admin route shapes |
| `admin/` | `/_admin/*` route handlers, each concern in its own file | Core request pipeline |
| `realtime/` | Realtime route + poller | Non-realtime handlers |

When a change does not obviously belong to any of these, the change is probably introducing a new concept. Name it and give it its own folder before writing the code.

---

## Boundary rules

### Router boundary

The router can:

- match path and method
- run global edge concerns like CORS and rate-limit decisions
- dispatch to handlers
- return intentionally early for liveness/admin/preflight routes

The router cannot:

- parse query grammar
- validate schema columns
- build SQL
- know mutation/RPC/read internals
- finalize domain responses beyond truly global headers

### Handler boundary

Handlers are orchestration glue. A good handler reads like:

1. receive typed request plus `HandlerContext`
2. validate request-specific constraints
3. build plan
4. build query
5. execute
6. build response
7. request finalization work

Handlers should not become miniature versions of old `index.ts`. If a handler contains a parser, SQL string manipulation, response-header policy, executor sentinel handling, or metrics aggregation, the handler is doing too much.

### Parser boundary

Parser modules can accept raw strings, headers, `URLSearchParams`, and request bodies. They emit typed AST/request structures.

Parser modules cannot:

- look at schema cache
- build SQL
- choose HTTP status codes except parse-specific errors
- run DB or Worker APIs

### Planner boundary

Planner modules convert parsed request shapes plus schema knowledge into typed plans.

Planner modules can:

- resolve relationships
- resolve routines
- attach schema-derived metadata
- reject requests that are invalid only once schema is known

Planner modules cannot:

- render SQL
- mutate parser output
- perform DB execution

### Builder boundary

Builder modules turn plans into SQL plus params. They own SQL shape.

Builder modules cannot:

- parse URLs
- read headers
- inspect raw `Request`
- call DB clients
- patch SQL generated by another builder after the fact

Features like search, vector, distinct, embed ordering, range, count strategy, and media-sensitive body shaping must be plan fields or builder options, not ad hoc string replacements after build.

### Executor boundary

The executor is the only place that talks to Postgres.

Executor modules can:

- manage clients and transactions
- apply role/pre-request/GUC SQL supplied by builders
- translate Postgres errors into `CloudRestError`
- expose explicit transaction outcomes

Executor modules cannot:

- construct domain SQL
- decide response media type
- know router paths

### Response boundary

Response modules convert query results and response metadata into HTTP responses.

Response modules can:

- format JSON/CSV/GeoJSON/etc.
- apply content negotiation decisions
- apply Content-Range, ETag, Preference-Applied, and GUC header policy

Response modules cannot:

- build SQL
- query schema
- call the DB

---

## "Where do I add X?"

The blunt answer table. If one of these is wrong or missing after a stage lands, the stage is not done.

| I want to add... | Files I edit |
|---|---|
| A new filter operator (`eq`, `like`, `cs`, ...) | `parser/operators.ts`, `builder/fragments.ts`, test in `tests/unit/parser/operators.test.ts` |
| A new response media type (e.g. Parquet) | `http/media/types.ts` (register), `http/media/format.ts` (formatter) |
| A new `Prefer` header key | `http/preferences.ts`, and the handler that consumes it |
| A new admin endpoint | `handlers/admin/<name>.ts`, wired in `router/routes.ts` |
| A new env var | `config/env.ts`, `config/schema.ts`, `config/load.ts` (validation) |
| A new error | Appropriate namespace in `core/errors.ts` (`parseErrors`, `authErrors`, ...) |
| A new aggregate function | Allowlist in `parser/select.ts`, mapping in `builder/read.ts` |
| A new query feature (search, vector, distinct, ...) | `parser/*` (parse), `planner/read-plan.ts` (plan field), `builder/read.ts` (render). **Never post-hoc SQL edit.** |
| A new JWT algorithm | `auth/jwt.ts`, explicit allowlist update in `auth/authenticate.ts` |
| A new row-level security mechanism | `executor/transaction.ts` pre-request SQL path |

---

## Naming standard

Prefer names that carry domain meaning without requiring a local glossary.

| Avoid | Prefer |
|---|---|
| `qi` | `qualifiedIdentifier`, `qualifiedTable`, `targetTable` |
| `b` | `sqlBuilder`, `builder` |
| `qp` | `queryParams` |
| `ot` | `orderTerm` |
| `lt` | `logicTree` |
| `mt` | `mediaType` |
| `ctx` in broad code | `executionContext`, `handlerContext` |
| `env` outside Worker entry | `bindings`, `workerEnv`, or typed config when possible |

Short names are allowed in tiny, obvious scopes, such as callbacks or mathematical helpers. They are not allowed for concepts that appear across modules.

Type names should describe the lifecycle layer:

- `ParsedRequest`
- `ValidatedRequest`
- `ReadPlan`
- `BuiltQuery`
- `QueryResult`
- `DomainResponse`
- `FinalizedResponse`

If a type's name does not reveal its layer, rename it before exporting it.

---

## Public API policy

The rewrite should avoid accidental public API.

Rules:

1. `src/index.ts` exports only intentional public entry points.
2. Internal modules should not be re-exported from the package root unless explicitly documented.
3. Test helpers live under test helper modules, not public runtime modules.
4. If a type is exported only because another internal module needs it, export it from a specific internal domain module, not the top-level package.
5. Any public export must be stable enough to document.

Categories:

| Category | Example | Stability |
|---|---|---|
| Public package API | Worker default export, documented helpers | stable |
| Internal runtime API | planner/builder types | can change between releases |
| Test-only API | fixtures, fake executor | not shipped as public API |

---

## Comment convention

Source comments fall into exactly four grep-able categories. Anything else is either trivial and should be deleted, or it belongs in a doc file.

| Prefix | Meaning | Example |
|---|---|---|
| `INVARIANT:` | A rule that must remain true for the code to be correct. Breaking this is a bug. | `INVARIANT: addParam is monotonic; never rewrite $N after allocation.` |
| `COMPAT:` | A behavior that matches (or deliberately diverges from) PostgREST. | `COMPAT: PostgREST returns 416 when the range is unsatisfiable.` |
| `RUNTIME:` | A Cloudflare Worker or Postgres runtime constraint. | `RUNTIME: ctx.waitUntil is required; promises after the response are cancelled.` |
| `SECURITY:` | A security-critical rule. Breaking this is a vulnerability. | `SECURITY: backslash detection must run before E-prefix decision.` |

Task numbers, feature numbers, PR references, and dated chronology ("as of 2025-03") are not allowed in source. Put them in git log or CHANGELOG.md.

---

## PostgREST compatibility policy

CloudREST follows PostgREST behavior unless one of the following applies:

1. **Runtime constraint.** The behavior cannot be implemented on Cloudflare Workers (no long-lived connections, no filesystem, no forked processes). Mark the divergence with `RUNTIME:`.
2. **Security constraint.** The PostgREST default is unsafe for an internet-facing Worker. Mark with `SECURITY:` and document in "Intentional divergences" below.
3. **Explicit CloudREST extension.** A feature that PostgREST does not have (realtime, vector search, edge cache). Document it under "Extensions."

If the answer is not one of the three, match PostgREST, even when you think PostgREST is wrong. Divergences without justification are forbidden.

### Canonical query forms

| Concept | Canonical syntax | Notes |
|---|---|---|
| Aggregates in `select` | `select=avg(rating)`, `select=total:sum(rating)`, `select=avg(rating)::float` | PostgREST form. `column.aggregate()` is accepted as a CloudREST extension and parsed to the same AST node. |
| Aggregates in `having` | `having=avg(rating).gte.4` | PostgREST form. |
| Aggregates in `order` | `order=avg(rating).desc` | PostgREST form. |

The aggregate name set is a closed allowlist (`avg`, `count`, `sum`, `min`, `max`). Aggregate parsing in `select` runs before embed parsing so that `select=book_id,avg(rating)` is not mistaken for an embed of a table named `avg`.

### Intentional divergences from CloudREST v1 (pre-rewrite)

Behaviors the rewrite deliberately changes. Each item links to the critique finding that justifies it.

#### Config: no silent fallback on invalid env values (stage 2)

- **Previous behavior.** `readConfig` silently fell back to defaults when an env var failed to parse. `MAX_QUERY_COST=notanumber` became `0` (cost guard disabled). `DB_TX_END=rollback-always` became `commit`. Malformed `APP_SETTINGS` JSON silently became `{}`. Malformed `JWT_ROLE_CLAIM` silently used the entire JWT as the role.
- **New behavior.** `loadConfig` collects every parse error into a `ConfigError[]` and returns it as the `Err` branch of a `Result`. A boot-time worker that sees any errors must refuse to serve traffic.
- **Reason.** Critique findings #5, #23, #40, #41, #42, #43. Silent fallback is how the old code hid misconfiguration until something exploded in production.
- **Test.** [tests/unit/config/load.test.ts](./tests/unit/config/load.test.ts) "hard validation (no silent fallback)" and "JWT_ROLE_CLAIM validation" blocks.
- **Scope.** CloudREST v1 only. PostgREST has its own config validation rules; the CloudREST rewrite matches the spirit but not the exact error shape.

#### Config: CORS defaults off (stage 2)

- **Previous behavior.** `CORS_ALLOWED_ORIGINS` unset defaulted to `*` (PostgREST-compatible).
- **New behavior.** `CORS_ALLOWED_ORIGINS` unset leaves `cors.allowedOrigins` as `null`. The router treats null as "no CORS headers, 403 on preflight" (wired in stage 16).
- **Reason.** Critique #57. `*` is not a safe default for an internet-facing Worker running over a user's RLS-protected database.
- **Test.** [tests/unit/config/load.test.ts](./tests/unit/config/load.test.ts) "CORS default".
- **Scope.** Both CloudREST v1 and PostgREST.

#### Range: clamp negative table totals to null (stage 3)

- **Previous behavior.** `pg_class.reltuples = -1` (for tables never analyzed) propagated into `Content-Range: */-1`, which tripped the 416 branch on the next request.
- **New behavior.** `rangeStatusHeader` clamps any negative total to `null` at the boundary. Downstream code never sees a negative total.
- **Reason.** Critique finding #73.
- **Test.** [tests/unit/http/range.test.ts](./tests/unit/http/range.test.ts) "clamps negative table totals to null".
- **Scope.** CloudREST v1 only.

#### Preferences: never silently drop tx= (stage 3)

- **Previous behavior.** `Prefer: tx=rollback` was silently swallowed when `DB_TX_END=commit` (no `-allow-override`). Dry-run clients thought they were rolling back; the server was committing.
- **New behavior.** Forbidden `tx=` tokens go into `Preferences.invalidPrefs`. Stage 8's finalizer emits a `Warning` header under lenient handling and a PGRST122 400 under strict handling.
- **Reason.** Critique finding #75.
- **Test.** [tests/unit/http/preferences.test.ts](./tests/unit/http/preferences.test.ts) "tx (critique #75 regression)".
- **Scope.** CloudREST v1 only.

#### Parser: aggregate parsing runs before embed parsing (stage 4)

- **Previous behavior.** `select=book_id,avg(rating)` parsed as an embed of a table named `avg`, producing "relation not found" errors instead of an aggregate.
- **New behavior.** `parser/select.ts` checks the closed aggregate allowlist (`sum`, `avg`, `max`, `min`, `count`) before the embed branch. Canonical form `aggregate(column)` is accepted; extension form `column.aggregate()` is still accepted and parsed to the same AST node.
- **Reason.** Critique finding #68.
- **Test.** [tests/unit/parser/select.test.ts](./tests/unit/parser/select.test.ts) "parses canonical avg(rating) as a field aggregate, not an embed".
- **Scope.** Neither CloudREST v1 nor PostgREST — this fixes a CloudREST bug.

#### Builder: search/vector/distinct are first-class plan fields (stage 6)

- **Previous behavior.** The old `buildReadQuery` produced a base SQL string with no search, vector, or distinct clauses; `index.ts` then ran `String.prototype.replace` / regex / paren-depth scanners to inject those features into the already-built SQL. `injectVectorIntoInnerSubquery` in [src/builder/vector.ts](../cloudrest-public/src/builder/vector.ts) and the FTS / distinct patches in [src/index.ts](../cloudrest-public/src/index.ts) are the canonical examples.
- **New behavior.** `ReadPlan` carries `search`, `vector`, and `distinct` as typed fields. `builder/read.ts` renders the whole query in a single pass — projection, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, DISTINCT, search match, vector distance — with every user-controlled value bound via `SqlBuilder.addParam`. No file downstream of the builder modifies the returned SQL.
- **Reason.** Critique findings #2 (SQL post-hoc surgery), #10 (search language inlined), #12 (FTS second-FROM), #72 (vector `distance` column validator ordering), #77 and #78 (vector `$N` rewriting bugs). CONSTITUTION §1.1, §1.3, §1.6.
- **Test.** [tests/unit/builder/read.test.ts](./tests/unit/builder/read.test.ts) — specifically the `search is a first-class plan field`, `vector is a first-class plan field`, and `distinct as a first-class plan field` blocks, plus the `does not require a post-build SQL rewrite` constitution regression test.
- **Scope.** CloudREST v1 only. The SQL shape matches PostgREST's for the same plan; the internal implementation is different.

#### Parser: embed range params are stored for planner consumption (stage 4)

- **Previous behavior.** `?books.limit=2` was parsed into `ranges` but the planner never consumed it; the inline `books(limit=2)` form was the only one that worked.
- **New behavior.** Stage 4's dispatcher stores embed range params under the `\0`-joined embed path key; stage 6's planner consumes them.
- **Reason.** Critique finding #69.
- **Test.** [tests/unit/parser/query-params.test.ts](./tests/unit/parser/query-params.test.ts) "stores embed range params under a \\0-joined key".
- **Scope.** CloudREST v1 only.

#### Config: debug mode defaults off (stage 2)

- **Previous behavior.** `DB_DEBUG_ENABLED` defaulted unset, which was treated as "off", but there was no boot-time warning when it was set.
- **New behavior.** Same default, but values other than exactly `"true"`/`"false"` are a `ConfigError`. The boot-time warning for enabled debug lands with stage 11.
- **Reason.** Critique #84.
- **Test.** [tests/unit/config/load.test.ts](./tests/unit/config/load.test.ts) happy-path defaults block.
- **Scope.** CloudREST v1 only.

When adding an intentional divergence, include:

1. Previous CloudREST v1 behavior.
2. New behavior.
3. Reason for change.
4. Test that pins the new behavior.
5. Whether the divergence is from CloudREST v1 only, PostgREST only, or both.

### Extensions

CloudREST-only features, not in PostgREST.

_(Populated as each stage lands.)_

For each extension, document:

1. User-facing syntax.
2. Parser module.
3. Plan field.
4. Builder implementation.
5. Tests.
6. Interaction with cache, auth, and media negotiation if relevant.

---

## Test layout

```
tests/
  smoke/        Can the project build and load?
  unit/         Pure functions, one module at a time. Mirrors src/ layout.
  contract/     Module-boundary tests. Parser output -> planner input, etc.
  behavior/     End-to-end against a fake executor. Real request/response shapes.
  compat/       Explicit PostgREST parity assertions.
  fixtures/     Shared test data (JWTs, SQL responses, schemas).
```

Rules:

1. **Unit tests do not mock neighbors.** If a unit test for `parser/filter.ts` has to mock `parser/operators.ts`, the split is wrong.
2. **Contract tests are not optional.** Every module boundary that carries a typed shape gets at least one "the shape the producer emits is the shape the consumer expects" test.
3. **Behavior tests use the real pipeline.** They swap out the executor for a fake, not the parser or builder.
4. **Compat tests name the PostgREST behavior.** Comments read `COMPAT: PostgREST ...` so a reader can find the upstream reference.
5. **Security regression tests name their source.** A test guarding against a previously-fixed CVE or reported bug starts with a comment like `// REGRESSION: CVE-YYYY-NNNNN — ...` or `// REGRESSION: issue #123 — ...` so a reader can find the original report.

---

## Stage order (summary)

The summary below is the default order. If a stage needs to move, update this document and explain why in the PR. Do not rely on a chat transcript as the source of truth.

0. **Scaffold.** Buildable workspace, no-op worker, smoke test, this document.
1. **Core primitives.** `Result<T>`, `CloudRestError` with grouped factories, `HandlerContext`.
2. **Config.** Grouped `AppConfig`, hard validation, no silent fallback.
3. **HTTP parsing layer.** Request, media (parse/negotiate/format), preferences, range.
4. **Parser split.** One file per grammar, shared tokenizer, hardened payload parser.
5. **SqlBuilder primitives.** Shared `BuiltQuery`, identifier/literal helpers with security invariants.
6. **Read planner + builder.** Search, vector, distinct are first-class plan fields. No post-hoc SQL edits.
7. **Executor boundary.** Explicit `TransactionOutcome`, statement timeout, long-lived client, one GUC parser.
8. **First end-to-end slice.** `GET /{relation}` wired through the whole pipeline.
9. **Mutation handler.**
10. **RPC handler.**
11. **Auth security fixes.**
12. **Realtime auth + schema-aware routing.**
13. **Edge cache correctness.**
14. **Webhooks.**
15. **Batch.**
16. **Rate limit, CORS defaults, admin auth.**
17. **Schema coordinator.**
18. **Observability/admin split.**
19. **Dead-code removal and final architecture pass.**

Each stage must leave the project buildable and all tests passing.

### Stage gate checklist

Before starting a stage:

1. Name the stage in one sentence.
2. List modules that will be created or changed.
3. List old source files that will be consulted.
4. List old tests that will be used as behavioral evidence.
5. State any expected behavior changes. The default is none.

Before finishing a stage:

1. The project builds.
2. Tests pass.
3. New module boundaries are documented by filenames and types.
4. No new catch-all file was created.
5. No stage introduced post-hoc SQL patching.
6. No handler grew into request lifecycle soup.
7. Any divergence is recorded in this file.
8. Any old tests ported/replaced are recorded in the migration ledger.

---

## Anti-patterns banned by this architecture

These are old-code failure modes the rewrite should not repeat.

1. **Monolith-by-accretion.** Do not let `index.ts`, handlers, or admin modules become dumping grounds.
2. **Parse/build mixing.** Do not parse `URLSearchParams` inside builder modules.
3. **Post-build SQL surgery.** Do not call `.replace()` on generated SQL to inject features.
4. **Long positional context.** Do not pass 8-10 dependencies into handlers.
5. **Structural error guessing.** Do not rely on checks like `'code' in result` at major boundaries.
6. **Thrown magic objects without names.** If transaction control needs thrown values, define named signal types and helpers.
7. **Feature chronology comments.** No `Task N`, `Feature N`, or implementation diary comments.
8. **Duplicate policy.** GUC headers, forbidden headers, response finalization, and execution ceremony must have one home.
9. **Accidental public exports.** Do not export internals from package root for test convenience.
10. **Abbreviation culture.** Avoid names that require private author context to decode.

---

## Contributor orientation

A new contributor should be able to answer these questions quickly:

1. Where is a request routed?
2. Where is a query parameter parsed?
3. Where is schema validation performed?
4. Where is a query plan created?
5. Where is SQL rendered?
6. Where is the DB called?
7. Where is the HTTP response finalized?
8. Where is PostgREST compatibility documented?
9. Where are old tests mapped to new tests?
10. What is public API?

If the answer to any question becomes "grep the whole repo," the architecture has started to drift.
