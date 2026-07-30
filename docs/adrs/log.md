# ADR Update Log

## 2026-07-29

* **ADR revised (reclamation)**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — an unowned worktree is now recoverable *because* startup reconciliation reclaims it, not by assumption. Reconciliation removes unowned checkouts that are clean (reusing `removeWorktree`'s guards, never forcing) and retains unowned checkouts holding work, marking them `blocked`. This closes the leak left by the window between the removal dry run and the removal itself ([#22](https://github.com/gannonh/kata-agents/issues/22)); previously the ADR called that leak an acceptable worst case, which was wrong because nothing reclaimed it.

* **ADR extended**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — recorded three decisions that came out of the PR #20 review: session deletion and managed-worktree removal are one ordered server operation (quiesce → dry-run guards → delete → remove, with a blocked removal changing nothing, and unattended deletes requesting non-forced removal because nothing reclaims an unowned checkout later); a bound checkout owns the session's working directory and `updateWorkingDirectory` rejects changes for it; and the Changes surface is a single HEAD→working-tree view that status entries must agree with, with an unborn branch treated as "unknown" rather than "no delta".

* **ADR accepted**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — server-owned managed Git worktrees for Git/GitHub V1 (Phase 1 build).

## 2026-06-22

* **ADR accepted**: [2026-06-22-kata-identity-hard-cutover.md](2026-06-22-kata-identity-hard-cutover.md) — hard-cutover Kata identity contract.

## 2026-06-19

* **Initialization**: Created ADR section. No decisions recorded yet.
