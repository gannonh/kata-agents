---
type: ValidationEvidence
title: Git and GitHub worktrees V1 — validation evidence
description: Playground captures of the production Git workspace surfaces plus the test coverage standing in for server-side invariants with no visual surface.
tags: [git, github, worktrees, validation, evidence, electron]
timestamp: 2026-07-29T00:00:00Z
---

# Git and GitHub worktrees V1 — validation evidence

Captured from the production renderer components in the repository playground
with `KATA_FEATURE_GIT_WORKSPACE_V1=1`. The fixture drives the same checkout
control, composer, Changes panel, Git action control, and delete dialog used by
the Electron app.

Reproduce with:

```bash
bun run playground:dev   # → http://localhost:5173/playground.html
# Category "Git Workspace" → "Git Workspace acceptance" → pick a variant
```

The visual pass is paired with `e2e/tests/git/managed-worktree.spec.ts`, a
real-Electron, real-Git test that creates a disposable repository and managed
worktree, reviews an external file change, commits it, verifies the repository
state, and confirms destructive worktree removal. That harness intentionally
remains macOS-only and fails loud on unsupported hosts.

## Vertical slices

### 1. Start isolated

![New worktree and base-ref selection](01-start-isolated.png)

### 2. Review changes

![Managed-worktree identity and changed-file summary](02-review-changes.png)

### 3. Share work

![Commit and push control with actionable missing-gh guidance](03-share-work.png)

### 4. Manage lifecycle

Managed-worktree removal is a separate choice from deleting the session, and a
removal that would discard work names the counts first.

![Explicit destructive worktree-removal confirmation](04-manage-lifecycle.png)

Default state (removal not chosen — the checkout is preserved), dark theme:

![Delete dialog with the worktree preserved by default](06-manage-lifecycle-dark.png)

### 5. A bound checkout owns the working directory

Two real composers. The unbound session can still pick a working directory; the
session bound to a managed worktree shows its locked checkout identity instead,
because Git actions, the Changes surface, and `sdkCwd` all resolve from the
persisted checkout. `SessionManager.updateWorkingDirectory` rejects the change
server-side as well, so no entry point can split "where the agent edits" from
"what Kata inspects and commits".

![Composer with and without a bound checkout](05-checkout-directory-lock.png)

## Behavior that is verified by tests rather than screenshots

Most of the resolved review findings are invariants with no visual surface.
Each has real-repository coverage:

| Behavior | Test |
|---|---|
| Session deletion quiesces the agent, then deletes, then removes the checkout | `packages/server-core/src/git/__tests__/lifecycle.test.ts` — "stops a processing agent before the checkout is inspected or removed" |
| A blocked removal changes nothing: session and checkout both survive | same file — "a blocked removal changes nothing at all" |
| Every removal guard can be evaluated without mutating anything | `packages/server-core/src/git/__tests__/remove-worktree-safety.test.ts` — "dry run" |
| Status omits staged changes the working tree has reverted, keeps working-tree mode changes, and keeps entries on an unborn branch | `packages/server-core/src/git/__tests__/repository-service.test.ts` — "HEAD→working-tree consistency" |
| A selected file named with pathspec magic cannot stage unrelated files | `packages/server-core/src/git/__tests__/action-service.test.ts` — "literal pathspecs" |
| A prepared-but-empty session still gets the managed-worktree confirmation | `apps/electron/src/renderer/components/app-shell/__tests__/worktree-removal.test.ts` — `resolveDeleteConfirmation` |
| A bound checkout rejects working-directory changes | `packages/server-core/src/git/__tests__/lifecycle.test.ts` — "bound checkouts are authoritative" |
| Unattended deletion cleans up an unused worktree, and keeps both session and checkout when it holds work | `packages/server-core/src/git/__tests__/lifecycle.test.ts` — "removeManagedWorktree is safe for any caller" |
| Removal waits for the backend to report idle, and refuses rather than racing an agent that never stops | `packages/server-core/src/git/__tests__/lifecycle.test.ts` — "removal waits for real agent quiescence" |
| Reconciliation reclaims unowned clean checkouts and retains unowned ones holding work | `packages/server-core/src/git/__tests__/reconcile.test.ts` — "reclaiming leaked (unowned) checkouts" |

## Automated coverage

- `packages/server-core/src/handlers/rpc/headless-server-flow.test.ts`: real
  repository/server lifecycle and session-addressed removal.
- `e2e/tests/git/managed-worktree.spec.ts`: real Electron/Git vertical flow,
  including four screenshot attachments when run on a macOS GUI host.
- `packages/server-core/src/git/__tests__/repository-service.test.ts`: PR title
  and body defaults from the latest commit subject and repository template.
- `apps/electron/src/renderer/atoms/__tests__/git-status.test.ts`: IPC status
  reaches the same provider-backed Jotai store rendered by Git surfaces.

## Host limitations

- The real Electron Playwright harness is macOS-only. It is implemented and
  discovered on this Linux host; the captures above come from the production
  renderer components that flow drives.
- This host has no authenticated `gh` session, so only the non-mutating
  missing-CLI guidance was exercised live (visible in slice 3). Authenticated
  GitHub mutation paths stay covered by deterministic adapter tests against a
  fake `gh` executable.
