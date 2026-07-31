---
type: Spec
title: Awaitable agent teardown quiescence contract
description: Replace inferred agent-idle polling with a backend-owned teardown contract before destructive managed-worktree operations.
status: Approved
approved_at: 2026-07-31T01:35:49Z
tags: [agents, backends, git, worktrees, sessions, safety]
timestamp: 2026-07-30T00:00:00Z
---

# Awaitable agent teardown quiescence contract

## Status

Approved — Build authorized by the user on 2026-07-31. This document is the
first commit on the long-lived feature branch for [issue #21](https://github.com/gannonh/kata-agents/issues/21).

## Goal

Give `SessionManager` one awaitable backend contract that means:

1. the active `chat()` generator has fully unwound;
2. the backend has stopped every child process that could still write into the
   session checkout; and
3. the caller may inspect or remove the checkout without relying on polling,
   an idle flag, or a fixed grace delay.

This closes the final teardown race deferred from Git/GitHub V1. It does not
change the feature flag, the removal fingerprint, or the deletion transaction.

## Source of truth

- [Issue #21](https://github.com/gannonh/kata-agents/issues/21)
- [Git/GitHub V1 design](2026-07-26-git-github-worktrees-v1-design.md)
- [Server-owned managed-worktree ADR](../adrs/2026-07-29-server-owned-managed-worktrees.md)
- `packages/shared/src/agent/backend/types.ts`
- `packages/shared/src/agent/base-agent.ts`
- `packages/shared/src/agent/claude-agent.ts`
- `packages/shared/src/agent/pi-agent.ts`
- `packages/pi-agent-server/src/index.ts`
- `packages/server-core/src/sessions/SessionManager.ts`
- `packages/server-core/src/git/__tests__/lifecycle.test.ts`

## Verified current state

- `AgentBackend.forceAbort(reason)` is synchronous. It requests cancellation
  but cannot tell a caller when teardown has finished.
- `ClaudeAgent.forceAbort()` aborts its SDK `AbortController` and immediately
  clears `currentQuery`. The surrounding `for await` loop can still be
  unwinding while `isProcessing()` already returns `false`.
- The Claude SDK `Query` is an async generator. Its transport performs a
  graceful-close sequence before its forwarded process signal fires, so the
  reliable application-visible boundary is completion of the consumed query
  generator, not clearing the query reference.
- `PiAgent.forceAbort()` immediately clears `_isProcessing`, completes the
  main-process event queue, and sends an `abort` message to a persistent Pi
  subprocess. The main-process generator can therefore finish before the child
  handles the abort.
- Pi already has `killSubprocessGracefully()` for idle runtime restart. It sends
  shutdown, sends `SIGTERM`, waits for the child `exit` event, escalates to
  `SIGKILL`, and currently logs rather than fails when exit is still
  unconfirmed.
- `SessionManager.waitForAgentQuiescence()` polls the session and backend
  processing flags for up to five seconds. It begins with a 100 ms floor delay
  intended to let a final subprocess write land.
- Managed-worktree removal refuses to proceed when this inferred barrier times
  out. Plain session deletion still proceeds without touching the checkout.
- Startup reconciliation from issue #22 reclaims clean unowned worktrees, so a
  refused or interrupted removal remains recoverable.

## Settled design

### Required backend API

Add this required lifecycle method to `AgentBackend`:

```ts
quiesceForTeardown(reason: AbortReason): Promise<void>
```

The method is for irreversible teardown boundaries, not ordinary user stop,
handoff, redirect, or source-activation restart.

Its contract is:

- request a hard abort using existing backend semantics;
- resolve only after all active `chat()` invocations have fully unwound;
- stop and await the exit of any backend-owned child process that could still
  access the checkout;
- be safe to call when already idle;
- be safe to call more than once; and
- reject when exit cannot be confirmed.

Keep `forceAbort(reason): void` unchanged. Converting it to an async method
would spread an unrelated semantic change through stop, redirect, auth,
plan-submission, and source-activation paths.

### Shared turn barrier

`BaseAgent.chat()` is the common lifecycle boundary for Claude and Pi. Add a
generation-safe active-chat counter and a reusable idle promise around the
existing `yield* this.chatImpl(...)` call.

- Increment before work that can enter `chatImpl`.
- Decrement in `finally`.
- Resolve the current idle promise only when the count reaches zero.
- Create a new pending idle promise on the next zero-to-one transition.
- Capture the idle promise before requesting abort, so a synchronous
  `forceAbort()` state clear cannot skip the turn being stopped.
- Count nested calls correctly. Claude recovery currently re-enters `chat()`,
  so a single mutable “current turn promise” is not sufficient.

`BaseAgent.quiesceForTeardown()` captures that promise, calls `forceAbort()`,
and awaits the captured barrier. This is sufficient for Claude because its
per-turn SDK subprocess is owned by the consumed `Query`; the barrier does not
resolve until query iteration and SDK cleanup have completed.

### Pi process exit

`PiAgent.quiesceForTeardown()` first awaits the shared turn barrier, then shuts
down the persistent Pi child and waits for its `exit` event.

Refactor the existing graceful-stop helper so strict teardown can distinguish
confirmed exit from an exhausted `SIGTERM`/`SIGKILL` sequence. Strict
quiescence must reject if exit remains unconfirmed. `disposeForRestart()` may
reuse the same helper, but it must not weaken the strict result used before
checkout removal.

No new Pi JSONL acknowledgement is required. Confirmed operating-system process
exit is the relevant boundary: after it, the child cannot issue a later write,
and the authoritative worktree snapshot will observe any complete or partial
write already present.

### Session deletion integration

Replace `waitForAgentQuiescence()` and its 100 ms polling floor with a bounded
await of `agent.quiesceForTeardown(AbortReason.UserStop)`.

- When managed-worktree removal is requested, call the contract whenever an
  agent instance exists, even if session/backend flags currently report idle.
  This stops an idle persistent Pi child before its checkout is removed.
- When plain session deletion encounters a processing agent, use the same
  contract for orderly teardown.
- Keep the existing five-second SessionManager ceiling. A rejection or timeout
  blocks managed-worktree removal and therefore that combined deletion.
- Plain session deletion still proceeds after a teardown failure because it
  never removes the checkout.
- The existing later `dispose()` call remains best-effort and idempotent. It
  cleans watchers, callbacks, and pools after the destructive boundary; it is
  not the worktree-removal safety signal.
- Remove `AGENT_QUIESCE_POLL_MS`, the polling loop, and comments that describe
  the 100 ms delay as protection.

The order remains:

1. await backend teardown quiescence;
2. stage session storage;
3. inspect, fingerprint, and remove the checkout under the repository lock;
4. finish best-effort runtime cleanup; and
5. finalize session deletion.

## Approaches considered

### 1. Required `quiesceForTeardown()` contract — selected

This gives destructive callers one narrow, explicit guarantee while preserving
all existing synchronous abort call sites. `BaseAgent` can own the shared
generator barrier, and Pi can add its persistent-process requirement.

### 2. Make `forceAbort()` return `Promise<void>` — rejected

This looks smaller at the interface but changes the meaning of every existing
hard-abort caller. Many call sites intentionally fire synchronously and then
let the session loop drain. Mixing “abort requested” and “safe for filesystem
destruction” in one method would invite callers to await or ignore it
inconsistently.

### 3. Keep polling and add an optional `whenIdle()` hint — rejected

An optional method preserves the current fallback and therefore preserves the
false-safety path issue #21 exists to remove. There are only two production
backends; both must implement the real contract.

## Scope

- Add the required backend teardown contract.
- Add the shared nested-turn barrier.
- Implement Claude quiescence through query-generator completion.
- Implement Pi quiescence through turn completion plus confirmed child exit.
- Replace SessionManager polling and the 100 ms floor.
- Add deterministic backend and managed-worktree lifecycle tests.
- Update the managed-worktree ADR and OKF logs after implementation.

## Out of scope

- Changing ordinary `forceAbort`, `abort`, `interruptForHandoff`, or `redirect`
  semantics.
- Enabling `KATA_FEATURE_GIT_WORKSPACE_V1` by default.
- Changing worktree removal fingerprints, confirmation copy, registry
  ownership, or the staged deletion transaction.
- Adding worktree handoff, snapshots, automatic cleanup, or conversation-fork
  isolation from issue #17.
- Adding a general process supervisor or rewriting Pi's JSONL protocol.
- Adding UI or i18n unless implementation exposes a new user-facing error.
- Treating cleanup logging as proof of quiescence.

## Acceptance criteria

1. `AgentBackend` requires
   `quiesceForTeardown(reason: AbortReason): Promise<void>`, and every production
   backend plus test backend implements or inherits it without using an optional
   fallback.
2. The shared turn barrier resolves only after every active/nested
   `BaseAgent.chat()` invocation has left its `finally` block. A test proves
   synchronous processing-state changes cannot resolve the barrier early.
3. Claude teardown resolves only after its SDK `Query` iteration has completed
   following abort. Clearing `currentQuery` is not treated as completion.
4. Pi teardown resolves only after the exact child captured for teardown emits
   `exit`. The helper escalates from `SIGTERM` to `SIGKILL` and rejects when exit
   still cannot be confirmed.
5. Calling teardown while idle or calling it repeatedly is safe. Pi does not
   kill or clear a newly spawned replacement child captured after teardown
   began.
6. `SessionManager.deleteSession()` awaits teardown before any
   managed-worktree inspection, staging, fingerprint comparison, or removal,
   including when an idle Pi backend still owns a persistent subprocess.
7. SessionManager applies a five-second ceiling. A backend rejection or timeout
   preserves the session, checkout, registry record, and staged-storage state
   when worktree removal was requested.
8. Plain session deletion remains possible after teardown rejection or timeout
   and never removes the checkout.
9. A deterministic lifecycle test schedules a checkout write before abort and
   completes it before backend quiescence. Removal-risk inspection observes the
   resulting state, so stale confirmation blocks removal and both the checkout
   and file survive.
10. `waitForAgentQuiescence`, `AGENT_QUIESCE_POLL_MS`, and the 100 ms floor are
    removed. No `isProcessing()` polling decides whether destructive checkout
    work may begin.
11. Existing hard-abort, handoff, redirect, source-activation, runtime-restart,
    deletion transaction, and removal-confirmation tests remain green.
12. The ADR describes the implemented guarantee rather than the former
    turn-loop inference, and documentation validation plus `git diff --check`
    pass.

## Implementation plan

### Phase 1 — Shared contract and nested-turn barrier

Files:

- `packages/shared/src/agent/backend/types.ts`
- `packages/shared/src/agent/base-agent.ts`
- `packages/shared/src/agent/__tests__/test-utils.ts`
- `packages/shared/src/agent/__tests__/base-agent.test.ts`

Tasks:

1. Add the required interface method with the exact contract above.
2. Add private active-chat counting and idle-promise state to `BaseAgent`.
3. Wrap the complete public `chat()` body in the counter lifecycle. Do not put
   the counter only around `chatImpl`, because missing-skill and setup exits
   must also settle correctly.
4. Implement the default abort-and-wait behavior.
5. Extend `TestAgent` and add tests for idle calls, active calls, repeated calls,
   and nested `chat()` re-entry.

Gate:

```bash
cd packages/shared
bun test src/agent/__tests__/base-agent.test.ts
bun run tsc --noEmit
```

Commit:

```text
feat(agent): add teardown quiescence contract
```

### Phase 2 — Backend-specific teardown

Files:

- `packages/shared/src/agent/claude-agent.ts`
- `packages/shared/src/agent/pi-agent.ts`
- focused tests under `packages/shared/src/agent/__tests__/`

Tasks:

1. Confirm Claude uses the BaseAgent barrier without clearing or replacing the
   captured completion promise inside `forceAbort()`.
2. Add a controlled-query test proving Claude quiescence stays pending after
   the abort request and resolves only when query iteration finishes.
3. Refactor Pi's child-stop helper around a captured `ChildProcess`.
4. Preserve identity checks before clearing `this.subprocess`, so teardown of an
   old child cannot clear a replacement.
5. Make strict teardown reject after the `SIGKILL` wait expires without an
   `exit` event.
6. Reuse the helper from `disposeForRestart()` without changing runtime-restart
   behavior.
7. Add fake-child tests for normal exit, delayed exit, escalation, exhausted
   exit, idle/no-child, and replacement-child safety.

Gate:

```bash
cd packages/shared
bun test src/agent/__tests__/base-agent.test.ts \
  src/agent/__tests__/claude-agent-quiescence.test.ts \
  src/agent/__tests__/pi-agent-quiescence.test.ts
bun run tsc --noEmit
```

Commit:

```text
feat(agent): await provider process teardown
```

### Phase 3 — SessionManager destructive boundary

Files:

- `packages/server-core/src/sessions/SessionManager.ts`
- `packages/server-core/src/git/__tests__/lifecycle.test.ts`

Tasks:

1. Replace the polling helper with a timeout wrapper around
   `quiesceForTeardown`.
2. Attach both resolve and reject handlers before racing the timeout so a late
   backend rejection cannot become unhandled.
3. Call teardown for any agent before requested worktree removal, and for a
   processing agent during plain deletion.
4. Preserve the current blocked result and retry guidance when teardown cannot
   be confirmed.
5. Rewrite polling-specific tests around controllable teardown promises.
6. Add the idle-Pi-child call test, rejection/timeout atomicity tests,
   plain-delete test, and final-write/stale-confirmation regression test.

Gate:

```bash
bun test packages/server-core/src/git/__tests__/lifecycle.test.ts \
  packages/server-core/src/git/__tests__/remove-worktree-safety.test.ts
cd packages/server-core
bun run tsc --noEmit
```

Commit:

```text
fix(git): require backend quiescence before removal
```

### Phase 4 — Documentation and full verification

Files:

- `docs/adrs/2026-07-29-server-owned-managed-worktrees.md`
- `docs/adrs/log.md`
- `docs/specs/2026-07-30-agent-quiescence-contract-design.md`
- `docs/specs/index.md`
- `docs/specs/log.md`
- `docs/log.md`

Tasks:

1. Replace the ADR's deferred turn-loop-barrier language with the implemented
   backend guarantee and failure behavior.
2. Set this spec to `Implemented` only after all acceptance criteria pass.
3. Add a build report or an implementation/evidence section mapping every
   acceptance criterion to tests.
4. Update the roadmap and logs. Do not add release notes unless implementation
   changes visible behavior or copy.
5. Run the complete affected matrix.

Gate:

```bash
bun test packages/shared/src/agent/__tests__ \
  packages/server-core/src/git/__tests__ \
  packages/server-core/src/handlers/rpc/git.test.ts \
  packages/server-core/src/handlers/rpc/headless-server-flow.test.ts
cd packages/shared && bun run tsc --noEmit
cd packages/server-core && bun run tsc --noEmit
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run test:doc-tools
git diff --check
```

Use the repository's actual documentation validation command if
`bun run test:doc-tools` has changed by Build time.

## Test design notes

- Do not use real sleeps to prove ordering. Use deferred promises and explicit
  fake child `exit` events.
- The final-write regression should hold the teardown promise, write into the
  real disposable checkout, then release teardown. Assert that removal
  inspection occurs afterwards.
- Tests must distinguish “abort requested,” “chat generator unwound,” and
  “child exit observed.” Conflating those states would recreate the bug.
- Timeout tests may inject a short timeout through the existing private helper
  seam; do not make production timeout behavior globally shorter.
- Assert negative state: no checkout removal, no owner removal, no session
  deletion, and no staged transaction residue after a blocked destructive
  operation.

## Risks and mitigations

- **Nested Claude retry overwrites the active promise.** Use a counter and
  zero-to-one idle-promise generation in `BaseAgent`.
- **A stale Pi exit handler clears a replacement child.** Capture the child and
  compare identity before clearing shared fields.
- **Timeout leaves a late rejection.** Attach settlement handlers before
  `Promise.race`.
- **Teardown gets reused for ordinary handoff.** Keep the method name and docs
  explicitly tied to irreversible teardown.
- **Plain deletion becomes undeletable.** Preserve the existing rule that only
  requested checkout removal requires confirmed quiescence.
- **The 100 ms delay is removed before the real signal exists.** Delete it only
  in Phase 3 after both backend implementations and tests pass.

## Build handoff for a lesser model

1. Work only on `agent/issue-21-agent-quiescence`; do not create another branch
   or PR.
2. Read `AGENTS.md`, `packages/shared/CLAUDE.md`, this spec, issue #21, and the
   managed-worktree ADR before editing.
3. Confirm this spec says `Approved` in both status locations before editing.
4. Execute Phases 1–4 in order. Do not combine the three implementation commits
   into one work-in-progress commit.
5. Run each phase gate before its commit. Fix failures attributable to the
   phase before continuing.
6. Do not change the selected API, weaken strict Pi exit confirmation, restore
   polling, add a fallback backend, or broaden scope without updating this spec
   and requesting approval.
7. Preserve unrelated working-tree changes. Never use `--no-verify`.
8. Update the draft PR after each phase with the commit, tests run, and any
   blocker.
9. Finish with the full verification gate and an acceptance-criteria evidence
   table. Keep the PR draft until review comments and CI are green.

## Approval decision

Approve this spec to authorize Build with the selected
`quiesceForTeardown(reason)` contract and the four implementation phases above.
Requested changes after approval return the spec to Draft and must be
incorporated before continuing implementation.
