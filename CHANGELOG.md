# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Stage 0 scaffold: buildable workspace, no-op worker entry point, smoke test, architecture documentation.
- `examples/` directory with schema, curl scripts, JavaScript clients, and RLS patterns. These target the API the rewrite is building toward and will pass stage by stage as features land.
- `docs/DEVELOPMENT.md` — local development loop using podman + pgvector, including how to mint a dev JWT.
- `scripts/dev-db.sh` — helper for starting, stopping, and resetting a local Postgres container loaded with the example schema.

### Fixed

- Smoke test import path — removed the explicit `.ts` extension so `npm run typecheck` passes under strict TypeScript without `allowImportingTsExtensions`.
