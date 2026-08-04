---
type: Spec
title: Allow new sessions to use existing managed worktrees
description: Expose ready Kata-managed worktrees of the current workspace + repository in the composer workspace controls so a new session can bind to one as a shared owner, preserving the existing ownership and cleanup safety model.
status: Implemented
tags: [git, worktrees, sessions, electron, server, shared-ownership]
timestamp: 2026-08-03T00:00:00Z
---

# Allow new sessions to use existing managed worktrees

Tracks [#33](https://github.com/gannonh/kata-agents/issues/33).

## Status

Implemented. A new empty session in a Git repository can discover the
workspace's ready managed worktrees for that repository from the composer
Workspace control and bind to one instead of creating a new worktree. Binding
adds the session as a shared owner; the checkout is never recreated, mutated,
reassigned, or deleted. Discovery is scoped to the session's workspace AND the
repository resolved from the composer working directory, so worktrees from
unrelated workspaces or repositories are never offered.

## Problem

A managed worktree created by one session was effectively private to that
session. There was no way to start another session in the same checkout, so
work in a `kata-agent/<token>` branch could not be continued by a second
session without recreating it.

## Design

### Discovery (read-only)

New RPC `git:listManagedWorktrees` takes `(sessionId, workingDirectory)`.
The server resolves the session's workspace and the working directory's
repository (Git common directory) and returns a `ManagedWorktreeSummary[]` for
records that are:

- `state === 'ready'` (preparing/missing/blocked/removing are never offered),
- owned by the same workspace (`workspaceIdOf(record)`, persisted field with a
  path-derived fallback for legacy records),
- in the same repository (`computeRepoKey` over the canonical common dir),
- not already owned by the requesting session.

The renderer never supplies a worktree path or ID for discovery.

### Binding (mutation, server-validated)

`CheckoutPrepareIntent` gains `managedWorktreeId?: string | null`. When set,
`prepareCheckout` re-validates on the server:

1. the record exists,
2. `state === 'ready'`,
3. `workspaceIdOf(record)` matches the session's workspace,
4. the record's Git common directory matches the intent directory's
   repository.

Only then does it add the session as an owner (`WorktreeRegistry.addOwner`,
idempotent) and bind checkout metadata — `mode: 'managed-worktree'`, the
existing `checkoutPath`, `repositoryRoot`, `baseRef`, and `expectedBranch` —
plus `workingDirectory`/`sdkCwd`, durably persisted. If binding fails, the
owner reference is rolled back so shared-owner counts stay accurate.

### Safety model preserved

- The checkout directory, branch, and registry record are never mutated for
  the new session — only `ownerSessionIds` grows.
- `inspectRemoval`/`removeWorktree` already block while `otherOwnerCount > 0`,
  and deletion without removal releases only the deleting session's owner
  reference, so a shared worktree survives the loss of any single owner.
- Startup reconciliation (`reconcile`) already repairs/drops owner references
  from persisted session checkouts, so restart/resume keeps shared identity.
- The persisted `SessionCheckoutV1.mode` stays `'managed-worktree'`, so the
  branch identity label, recovery states, and mutation identity guards apply
  unchanged. Every session bound to a worktree shows the same branch label;
  shared ownership is conveyed by a Users icon and a Shared worktree tooltip
  instead of replacing the branch with a generic label.
- Empty-session auto-delete (navigate-away cleanup) now skips sessions that
  prepared a managed worktree. Previously such a session was deleted with its
  clean checkout on navigate-away; with sharing, that would silently destroy a
  checkout another session is about to bind to. The session stays visible for
  explicit deletion, which offers the worktree-aware confirmation.
- After any session deletion, the renderer refreshes the remaining sessions'
  DTOs so derived shared-owner counts (and the shared indicator on the
  checkout badge) revert
  immediately instead of staying stale until the next list refresh.

### UI

The composer Workspace menu (empty Git session) adds **Existing worktree**
next to **Current checkout** and **New worktree**. It lists ready worktrees
(branch, base ref, shared-with count) in a searchable picker; **Use this
worktree** binds and locks the identity badge exactly like a prepared new
worktree. The prepare-before-send gate sends the bind intent before the first
message, so a message can never land in a different checkout than the user
chose.

## Acceptance criteria

- [x] A workspace with one or more Kata-managed worktrees exposes them when a
      new session is created (same workspace + repository only).
- [x] Selecting an existing worktree starts the new session in that checkout
      and persists the checkout identity (restart/resume returns to it).
- [x] Owner/shared-worktree semantics and cleanup guards stay correct: owner
      counts reflect all bound sessions; deleting one owner keeps the
      checkout; removal is blocked while another session owns it.
- [x] Worktrees from unrelated repositories or workspaces are not offered.
- [x] Focused unit coverage (server bind/list guards, send gate) and an
      Electron Playwright regression (`e2e/tests/git/existing-worktree.spec.ts`)
      cover discovery, selection, persistence, and shared ownership.

## Verification

- Unit: `packages/server-core/src/git/__tests__/prepare-checkout.test.ts`
  (bind, idempotence, workspace/repo/state rejections, owner rollback,
  discovery scoping), `git.test.ts` (RPC delegation),
  `checkout-controls.test.ts` (send gate with bind intent).
- E2E (macOS, `@git` tier) — **passing 2026-08-03**: session 1 creates a
  worktree; session 2 selects it from the workspace controls; both persisted
  checkouts share one `managedWorktreeId`/`checkoutPath`; deleting session 1
  keeps the checkout; deleting session 2 with removal cleans it up. The other
  `@git` specs (managed worktree flow, GitHub integration, branch badge
  refresh) remain green except `branch-badge-refresh.spec.ts`, which fails
  identically on the base SHA (pre-existing).
- `bun run lint:i18n:parity` and `bun run lint:i18n:sorted` pass with the new
  `git.workspace.*` keys in all 7 locales.
