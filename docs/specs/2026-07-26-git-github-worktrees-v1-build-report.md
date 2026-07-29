---
type: BuildReport
title: Git and GitHub V1 with managed worktrees — build report
description: Build completion report mapping AC1–AC21 to implementation and tests for the flag-gated Git/GitHub worktrees feature, covering Phase 3 blocker fixes and Phase 4 lifecycle management.
tags: [git, github, worktrees, electron, server, sessions, build]
timestamp: 2026-07-29T00:00:00Z
---

# Git and GitHub V1 with managed worktrees — build report

## Spec

- [2026-07-26-git-github-worktrees-v1-design.md](./2026-07-26-git-github-worktrees-v1-design.md) (Status: Implemented)
- ADR: [2026-07-29-server-owned-managed-worktrees.md](../adrs/2026-07-29-server-owned-managed-worktrees.md)

Feature is gated behind `KATA_FEATURE_GIT_WORKSPACE_V1` and **off by default**.
This build did not change the flag default.

## SHAs

- Branch: `cursor/git-github-worktrees-v1-9140`
- Pull request: [#20](https://github.com/gannonh/kata-agents/pull/20)

## Scope of this build

Two sequential jobs on top of the already-landed Phases 1–3:

- **Job A** — fix Phase 3 "Important" blockers (AC13/AC14/AC15 hardening + stale test suite).
- **Job B** — deliver Phase 4 (Manage lifecycle, AC17–AC21) plus docs, release notes, and this report.

## Job A — Phase 3 blocker fixes

1. **Reject commits in conflicted / merge-in-progress states (AC14).**
   `RepositoryService.detectOperationInProgress` probes `MERGE_HEAD`,
   `rebase-merge`/`rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` via
   `git rev-parse --git-path` (worktree-safe) and populates
   `GitStatusSnapshot.operationInProgress` + `blockedReason`.
   `GitActionService.commit` refuses when an operation is in progress or any
   entry is conflicted — V1 never creates a merge commit.
   Tests: `packages/server-core/src/git/__tests__/action-service.test.ts`
   (conflicted + merge-in-progress, incl. "after conflicts staged");
   `repository-service.test.ts` operation detection.
2. **Managed-worktree identity revalidation on mutations (AC17/AC20).**
   `checkManagedCheckoutIdentity` (pure) + `resolveMutationContext` in
   `handlers/rpc/git.ts` verify, before commit/pull/push/PR, that the live
   checkout is a Git repo, its Git common directory matches the registry
   record, its top-level equals the persisted checkout path, and the live
   branch equals the expected managed branch. Mismatch throws a visible
   recoverable error and never mutates.
   Tests: `handlers/rpc/git.test.ts` (identity unit table + mutation-blocking),
   `handlers/rpc/headless-server-flow.test.ts` (real external branch switch).
3. **`gh` capability guidance in the UI (AC15).** `githubSetupGuidance`
   (pure) maps a `GitHubCapabilityStatus` to an actionable label + the server's
   detail; `GitActionControl.tsx` renders a GitHub setup affordance (icon +
   tooltip) when `gh` is missing/unauthenticated and there is shareable work,
   without changing repository state. i18n: `git.github.installRequired`,
   `git.github.authRequired` (7 locales).
   Tests: `git-action-labels.test.ts`.
4. **PR base-ref authority (AC15).** `createPullRequest` uses the managed
   worktree's persisted base ref when present and ignores a client-supplied
   `baseRef`; current/legacy sessions may pass one, else the detected default
   ref is used.
   Tests: `handlers/rpc/git.test.ts` ("uses persisted base ref and ignores a
   client override").
5. **Stale RPC suite rewritten (AC12–AC16).** `handlers/rpc/git.test.ts` now
   exercises the real handlers (mutation lock, identity guard, base authority,
   diff resolution, subscription refresh) instead of Phase 3 stubs.
6. **PR defaults completed (AC15).** `RepositoryService` now returns the latest
   commit subject and a bounded repository pull-request template from GitHub's
   supported root, `.github`, or `docs` locations. `GitActionControl` uses those
   values as the editable PR title/body defaults instead of the session name and
   an always-empty body.
   Tests: `git/__tests__/repository-service.test.ts`.
7. **Renderer store integration fixed (AC9/AC11).** Imperative Git status and
   pending-comment updates previously targeted Jotai's global default store
   while the renderer consumed a separate provider-created store. A single
   exported `appStore` now backs both the provider and IPC/action updates, so
   external status refreshes and feedback mutations reach visible components.
   Tests: `atoms/__tests__/git-status.test.ts`,
   `atoms/__tests__/git-comments.test.ts`, `feedback-send.test.ts`.

### Job A correctness fix (found during Job B)

The identity guard originally compared the live top-level against
`checkout.repositoryRoot` (the source repo root). A linked worktree's
`git rev-parse --show-toplevel` is the worktree directory, not the source root,
so **every** managed-worktree mutation would have been wrongly blocked. Fixed to
compare the live top-level against `checkout.checkoutPath` and rely on the shared
Git common directory as the stable cross-worktree identity. Caught by the new
headless-server flow test.
Commit: `d3b56b6`.

## Job B — Phase 4 lifecycle

1. **Local/remote parity (AC17).** All Git/worktree/`gh` RPC channels are
   remote-eligible and resolve identity server-side by session ID (no client
   paths). Added a serial headless-server flow
   (`handlers/rpc/headless-server-flow.test.ts`) that wires the real handlers to
   a real SessionManager + GitServices over a real repo and drives
   discover → prepare worktree → commit → identity-block → session-addressed
   removal, representing remote filesystem ownership.
2. **Archive preserves worktree (AC18).** Verified via
   `git/__tests__/lifecycle.test.ts` (checkout, registry record, and ownership
   all survive `archiveSession`).
3. **Delete session UX (AC18/AC19).** `deleteSession` drops only the owner
   reference; the checkout is never removed implicitly. New
   `DeleteSessionDialog.tsx` + pure `worktree-removal.ts`
   (`summarizeWorktreeRemoval`, `canOfferWorktreeRemoval`) present managed-worktree
   removal as a separate choice: blocked while another owner remains, a
   destructive confirmation naming uncommitted-file / unpushed-commit counts,
   branch pruned only with no unique work. Wired into `App.tsx` for
   managed-worktree sessions (native confirm retained for others). i18n:
   `git.delete.*` (7 locales).
   Tests: `app-shell/__tests__/worktree-removal.test.ts`,
   `git/__tests__/remove-worktree-safety.test.ts` (destructive force),
   `git/__tests__/lifecycle.test.ts`,
   `git/__tests__/managed-worktree-service.test.ts` (shared-owner block).
4. **Recovery states (AC20).** Pure `resolveCheckoutRecovery` classifies
   `ok | missing | branch-drift | blocked` from the persisted checkout + live
   context (suppressed while context loads to avoid false drift on resume).
   `WorkspaceCheckoutBadge.tsx` renders a visible recovery/blocked badge; the
   server-side mutation guard enforces the same drift. Kata never silently
   switches directory. i18n: `git.workspace.recovery.*` (7 locales).
   Tests: `input/__tests__/checkout-controls.test.ts`.
5. **Documentation & release.**
   - `docs/architecture/system-overview.md` — added "Git & GitHub worktrees (preview)".
   - `apps/online-docs/core-concepts/git-worktrees.mdx` (+ nav in `docs.json`) — user-facing guide.
   - `apps/online-docs/server/headless.mdx` — remote-server Git/`gh` requirements.
   - `apps/electron/resources/release-notes/next.md` — flag-gated feature bullet.
   - `docs/specs/index.md`, spec status → Implemented, logs updated, this report.
6. **E2E and visual evidence (AC21).**
   `e2e/tests/git/managed-worktree.spec.ts` is now an executable serial
   real-Electron/real-Git flow rather than `test.fixme` placeholders. It creates
   a disposable repository, prepares a managed worktree, verifies persisted
   identity, reviews an external change, confirms missing-`gh` guidance is
   non-mutating, commits through the UI, validates the real Git state, and
   confirms destructive removal while preserving a unique branch. Stable test
   selectors were added only at feature boundaries. A production-component
   playground fixture and four checked-in screenshots cover the four vertical
   slices; see
   [`docs/validation/git-github-worktrees-v1/`](../validation/git-github-worktrees-v1/README.md).
7. **Tests** for delete-time cleanup safety, shared-owner block, archive
   preservation, and recovery badges as listed above.

## AC status summary

| AC | Area | Status | Primary evidence |
|----|------|--------|------------------|
| 1–8 | Slice 1 Start isolated | Implemented (Phase 1) | `prepare-checkout.test.ts`, `managed-worktree-service.test.ts`, `checkout-controls.test.ts` |
| 9–11 | Slice 2 Review changes | Implemented (Phase 2) | Changes panel, diff, pending-comment suites |
| 12 | Action-state resolver | Implemented | `@kata-sh/shared/git` resolver truth-table tests |
| 13 | Selected-file commit / push / ff pull | Implemented | `action-service.test.ts` |
| 14 | No force/reset/rebase/merge; block conflicted/merge-in-progress | Implemented (Job A1) | `action-service.test.ts`, `repository-service.test.ts` |
| 15 | GitHub PR gating, base-ref authority, setup guidance, PR defaults | Implemented (Job A3/A4/A6) | `git.test.ts`, `repository-service.test.ts`, `git-action-labels.test.ts`, `github-cli-service.test.ts` |
| 16 | Multi-stage partial success | Implemented | `git.test.ts` PR sequence, `action-service.test.ts` |
| 17 | Local/remote parity, server-owned commands | Implemented (Job B1) | `headless-server-flow.test.ts` |
| 18 | Archive preserves; delete = separate choices | Implemented (Job B2/B3) | `lifecycle.test.ts`, `worktree-removal.test.ts` |
| 19 | Removal block on shared owner; destructive confirm; branch prune | Implemented (Job B3/B7) | `remove-worktree-safety.test.ts`, `managed-worktree-service.test.ts` |
| 20 | Recovery/blocked states; never silent switch | Implemented (Job A2/B4) | `checkout-controls.test.ts`, `git.test.ts`, `headless-server-flow.test.ts` |
| 21 | Automated verification, real-Git lifecycle flow, visual evidence | Implemented | `headless-server-flow.test.ts`; `managed-worktree.spec.ts`; `docs/validation/git-github-worktrees-v1/` |

## Verification run

- Targeted server, renderer, and shared Git matrix → 249 pass, 0 fail,
  including provider-store integration.
- `bun run typecheck:all` → pass across core, shared, server, Electron, and UI.
- `bun run lint:i18n:parity` + `bun run lint:i18n:sorted` → pass
  (English plus 6 translated locales).
- `bun run e2e -- --list --grep @git` → executable `@git` lifecycle test discovered.
- `NODE_OPTIONS=--max-old-space-size=4096 bunx vite build --config apps/electron/vite.config.ts` → production renderer/playground build passes.

## Environment-conditioned checks

1. **Authenticated GitHub mutation.** The opt-in create/view-PR cleanup pass
   requires `gh` to be installed and authenticated on the workspace-owning
   machine. This validation host intentionally covered the required missing-`gh`
   guidance path. Deterministic adapter/RPC tests still cover authenticated
   capability, argument construction, PR parsing, push-before-create, base-ref
   authority, partial failure, and sanitization.
2. **Real Electron execution host.** The local E2E harness is intentionally
   macOS GUI-only. The completed `@git` test is discovered by Playwright here
   and captures four attachments when run on its supported host; server-owned
   lifecycle behavior runs cross-platform in the serial headless-server test.
