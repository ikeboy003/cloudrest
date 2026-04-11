# Contributing

Thanks for your interest in contributing to CloudREST.

## Before you start

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. It describes the request lifecycle, the module ownership map, and the stage order the rewrite is landing in. Most questions of the form "where should this code go?" are answered there.

The rewrite is intentionally landing in small, reviewable stages. **Please open an issue before starting work on anything bigger than a single stage.** If your change doesn't cleanly fit into one of the stages listed at the bottom of ARCHITECTURE.md, that's a signal to discuss the design first.

## Ground rules

- Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Check existing issues before opening a new one.
- Keep PRs focused. One stage, one concern, one set of tests.

## Development setup

```sh
git clone https://github.com/ikeboy003/cloudrest.git
cd cloudrest
npm install
npm run typecheck     # TypeScript strict checks
npm run test          # vitest
npm run dev           # wrangler dev against a local postgres
```

## Pull requests

1. Fork the repo and create a topic branch from `main`.
2. Make your change with tests. Every stage must leave the project buildable and every test passing.
3. Name the tier you added tests at in the PR description (smoke, unit, contract, behavior, compat).
4. If your change preserves or intentionally diverges from PostgREST behavior, say so in the PR and annotate the code with a `COMPAT:` comment.
5. Open a PR describing the change and the reason for it.

## Commit style

- Use the imperative mood in subject lines ("add filter operator" not "added filter operator")
- Keep subject lines under 72 characters
- Explain the *why* in the body, not the *what* — the diff shows the what
- Don't add `Co-Authored-By` trailers unless explicitly agreed

## Tests

Tests live under `tests/` and mirror the `src/` layout. The categories are:

- `tests/smoke/` — can the project build and load?
- `tests/unit/` — pure functions, one module at a time
- `tests/contract/` — module-boundary tests (parser output → planner input, etc.)
- `tests/behavior/` — end-to-end against a fake executor
- `tests/compat/` — explicit PostgREST parity assertions
- `tests/fixtures/` — shared test data

Unit tests must not mock neighboring modules. If you find yourself mocking `parser/operators.ts` to test `parser/filter.ts`, the module split is wrong and should be fixed first.

## License of contributions

By submitting a contribution, you agree that your contribution may be licensed under the [AGPL-3.0-only](LICENSE) project license and under commercial licenses offered by Divitiae Holdings LLC.
