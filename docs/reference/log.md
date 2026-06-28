# Reference Update Log

## 2026-06-27

* **Added**: [devbox.md](devbox.md) — runbook for `scripts/devbox.sh`, the single-command isolated worktree dev container. Covers the port-isolation problem it solves (concurrent Electron/Vite worktrees collide on `:5173`/`:9100`), the headed noVNC viewer, lifecycle (`--attach`/`--stop`/`--rm`/`--list`; `--rm` also deletes the branch), branch reuse on crashed runs, secrets handling, and reuse across other TypeScript projects.

## 2026-06-19

* **Migration**: Moved `docs/cli.md` → [cli.md](cli.md); added OKF frontmatter.
