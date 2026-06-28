# Reference Update Log

## 2026-06-28b

* **devbox git + GitHub auth**: documented in [devbox.md](devbox.md). Worktrees are created with `--relative-paths` and the main `.git` is mounted into the box so `git` works inside (commits, diffs, push). A GitHub token is forwarded from the host `gh` (or `GH_TOKEN`/`GITHUB_TOKEN`) and persisted to `/etc/profile.d/gh-token.sh` (node:node 600) so `gh` and HTTPS `git push` are authed in every shell. Electron launches with `--no-sandbox` in-container (gated by `KATA_ELECTRON_NO_SANDBOX`).

## 2026-06-28

* **Reworked devbox onto the devcontainer standard**: [devbox.md](devbox.md) rewritten. The box now builds on `mcr.microsoft.com/devcontainers/typescript-node` and is driven by `@devcontainers/cli` (`devcontainer up`) via `.devcontainer/devcontainer.json`. Adds the full dev toolchain (gh, ripgrep, fd, fzf, tmux) and the Pi agent: host `~/.pi` is copied in (minus sessions/npm/cache) and extensions are reinstalled Linux-native from `settings.json`. Headed GUI is reached via OrbStack's `<container>.orb.local:6080` instead of published host ports.

## 2026-06-27

* **Added**: [devbox.md](devbox.md) — runbook for `scripts/devbox.sh`, the single-command isolated worktree dev container. Covers the port-isolation problem it solves (concurrent Electron/Vite worktrees collide on `:5173`/`:9100`), the headed noVNC viewer, lifecycle (`--attach`/`--stop`/`--rm`/`--list`; `--rm` also deletes the branch), branch reuse on crashed runs, secrets handling, and reuse across other TypeScript projects.

## 2026-06-19

* **Migration**: Moved `docs/cli.md` → [cli.md](cli.md); added OKF frontmatter.
