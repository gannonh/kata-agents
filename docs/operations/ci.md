---
type: Operations
title: CI Pipeline
description: GitHub Actions CI for Kata Agents — the validate:ci gate on pull requests and pushes to main, plus the manual server-integration workflow.
tags: [ci, github-actions, bun, validate]
timestamp: 2026-06-19T00:00:00Z
---

# CI Pipeline

## `ci.yml` — validation gate

Runs on every `pull_request`, on `push` to `main`, and on manual
`workflow_dispatch`. Concurrency cancels superseded runs on the same ref.

Steps (Ubuntu):

1. Checkout.
2. Setup Bun `1.3.10`.
3. Install `uv` (`astral-sh/setup-uv`) — the doc-tools smoke tests run the
   bundled Python tools through `uv` (PEP 723 inline deps), so `uv` must be on
   `PATH`.
4. Reject Windows-illegal filenames (`< > : " | ? *`).
5. `bun install --frozen-lockfile`.
6. `bun run validate:ci`.

## `validate:ci` legs

`validate:ci` = `validate:dev` + i18n checks:

| Leg | What it checks |
| --- | --- |
| `typecheck:all` | `tsc --noEmit` across core, shared, server-core, server, session-tools-core, pi-agent-server, electron, ui. Requires the root `tsconfig.base.json`. |
| `test:shared:all` | Shared-package unit tests (llm-connections, models-pi, config). |
| `test:doc-tools` | Python smoke tests for the document tools, run via `uv`. |
| `lint:i18n:parity` | Every locale has the same keys as `en.json` (plural variants allowed to diverge). |
| `lint:i18n:sorted` | Locale files are alphabetically sorted. |

### Removed gate: `lint:i18n:coverage`

`lint:i18n:coverage` was removed from `validate:ci`. Its script
(`scripts/check-i18n-coverage.ts`) never existed and there was no reference
model for what "coverage" should assert. A scanner over the ~5000 `t(...)` call
sites (mixed with test `it(...)`/`test(...)` and dynamic template keys) would be
high-false-positive and make CI flaky. Key correctness is still guarded by
`lint:i18n:parity` (no missing/extra keys), `lint:i18n:sorted`, and the
pre-commit `lint:i18n:staged` hardcoded-string check. Re-introducing a coverage
check is deferred; document the intended semantics before re-adding it.

## `validate-server.yml` — manual integration

Manual `workflow_dispatch` only. 3-OS matrix (Ubuntu/macOS/Windows) running
`apps/cli/src/index.ts --validate-server`. Uses the existing secrets
`CRAFT_ANTHROPIC_API_KEY` and `STITCH_API_KEY` (kept as-is; secret-key renames
are Project D, not B).
