# Governance

CloudREST is a single-maintainer project in active development. This document describes who makes decisions and how, so contributors know what to expect.

## Roles

### Maintainer

The maintainer has commit access and is responsible for:

- Reviewing and merging PRs
- Tagging releases
- Security response
- Keeping [ARCHITECTURE.md](ARCHITECTURE.md) and [CHANGELOG.md](CHANGELOG.md) accurate

Currently: [@ikeboy003](https://github.com/ikeboy003).

### Contributor

Anyone who opens an issue, submits a PR, or participates in Discussions. Contributors do not need any prior relationship with the project and are welcome at any experience level.

## Decision making

Small decisions — bug fixes, feature additions that cleanly fit an existing stage, documentation improvements — happen in the PR itself. Open a PR, it gets reviewed, it either lands or comes back with changes.

Bigger decisions — architectural changes, new top-level directories, changes to the public API, changes to the request lifecycle — need a discussion first:

1. Open an issue or Discussion describing the change and the reason for it
2. Wait for maintainer feedback before writing code
3. If the design is sound, submit the PR

"Bigger" is a judgement call. If you're unsure, err toward opening an issue first. Nobody has ever been annoyed by "please discuss this before you start."

## Release cadence

CloudREST is pre-1.0. Releases happen when a stage lands and ships a meaningful chunk of functionality. There is no fixed cadence. The changelog records what shipped.

Once the project reaches 1.0, releases will follow [semver](https://semver.org) and the public API will become stable.

## How stages become releases

Each stage from [ARCHITECTURE.md § Stage order](ARCHITECTURE.md#stage-order-summary) corresponds to one or more minor versions during the 0.x series. Stage 0 is v0.0.x. Stage 1 is v0.1.x. A stage cannot land while the project is not buildable or tests are failing.

## Conflict resolution

If the maintainer and a contributor disagree about a design choice:

1. First, make sure both sides understand the tradeoff. Most disagreements are "I didn't know about X."
2. If you still disagree, the maintainer decides.
3. If you think the maintainer is wrong, say so, publicly, in the issue thread. Dissent is welcome.
4. If a pattern of disagreement forms, open a meta-issue about governance itself.

This document will be updated if and when the project outgrows a single-maintainer model.
