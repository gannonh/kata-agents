---
type: Reference
title: Devbox — isolated worktree environments
description: Single-command isolated Linux containers for concurrent Electron/Vite worktrees with per-container port isolation and a headed noVNC viewer.
tags: [devbox, docker, orbstack, electron, worktree, port-isolation]
timestamp: 2026-06-27T15:55:00Z
---

# Devbox — isolated worktree environments

A single command that spins up a git worktree in a fully isolated Linux container,
with its own network namespace (no port collisions between concurrent worktrees),
its own headed display, and automatic provisioning. Designed for running several
Electron/Vite worktrees of this repo in parallel on one Mac.

## The problem this solves

`electron:dev` and the dev servers hardcode ports (Vite `:5173`, RPC `:9100`).
Running two worktrees at once on the host means they fight over those ports. The
devbox puts each worktree inside its own container, where `:5173` is scoped to
that container's loopback only. Three worktrees up = three independent `:5173`s.

## Requirements

- Docker (tested with OrbStack 2.2.1; Docker Desktop works too)
- The repo checked out at the location you run the script from

## Quick start

From the repo root:

```bash
./scripts/devbox.sh my-feature
```

That will:

1. Create a worktree `../kata-agents-my-feature` from `main`
2. Build the `kata-devbox:latest` image (first run only)
3. Launch a container with isolated networking
4. Run provisioning once: `bun install`, `ensure:electron`, link `.env`
5. Drop you into a bash shell inside the box

Inside the box, start the app as normal:

```bash
bun run electron:dev
```

## Viewing the headed GUI

Electron runs inside the container against a virtual framebuffer. View it from
your Mac browser at the URL the launcher prints (default first box):

```
http://localhost:6080/vnc.html
```

Password: `kata`. Override with the `VNC_PASSWORD` env var at launch.

A native VNC client can also connect to `localhost:5900`.

## Running multiple worktrees concurrently

Each box gets its own host-side noVNC/VNC port, picked from a free range:

```bash
./scripts/devbox.sh feature-a   # -> :6080
./scripts/devbox.sh feature-b   # -> :6081
./scripts/devbox.sh feature-c   # -> :6082
```

List running boxes:

```bash
./scripts/devbox.sh --list
```

## Lifecycle

| Action | Command |
|---|---|
| Re-enter a running box | `./scripts/devbox.sh <branch> --attach` |
| Stop a box (keeps the worktree) | `./scripts/devbox.sh <branch> --stop` |
| Stop box AND remove the worktree | `./scripts/devbox.sh <branch> --rm` |
| List running boxes | `./scripts/devbox.sh --list` |

Stopped boxes keep their container filesystem and worktree. Re-attaching is
instant (provisioning only runs once per container).

## Secrets

`.env` is **never** baked into the image. The launcher bind-mounts it read-only
from the central dotfiles store (`~/dotfiles/repos/<repo>/.env`, matching what
`scripts/worktree-setup.sh` already expects) into `/home/node/.env`, and
provisioning symlinks it into `/workspace/.env`. Override the source path:

```bash
DEVBOX_ENV=/path/to/.env ./scripts/devbox.sh my-feature
```

## Files

| Path | Purpose |
|---|---|
| `.devbox/Dockerfile` | Generic image: Ubuntu + Node LTS + Bun + pnpm + ripgrep + Xvfb + x11vnc + noVNC + fluxbox |
| `.devbox/start-display.sh` | Container entrypoint: brings up the display stack, provisions, hands off |
| `.devbox/provision.sh` | Repo-specific setup (bun install, ensure:electron, .env link). Swap this for other repos |
| `scripts/devbox.sh` | The launcher |

## Reusing across other TypeScript projects

The image is intentionally repo-agnostic. To adapt for another repo:

1. Copy `.devbox/` and `scripts/devbox.sh` into the target repo
2. Edit `.devbox/provision.sh` if the project's setup differs (e.g. `pnpm install` instead of `bun install`, or no `ensure:electron` step)
3. Run `./scripts/devbox.sh <branch>`

Nothing else needs to change.

## Troubleshooting

**`euid != euid != 0,directory /tmp/.X11-unix` warning** — harmless. Xvfb still starts and the display works. The socket dir ownership warning appears because the container runs as a non-root user.

**noVNC page loads but shows a black screen** — the window manager or app hasn't painted yet. Start the Electron app inside the box (`bun run electron:dev`) and the screen will populate.

**Port already in use** — the launcher auto-picks the first free port near 6080/5900. If the range is exhausted, stop unused boxes with `--stop`.

## Notes

- Electron renders against a software Xvfb (no GPU). Fine for dev work and
  functional UI; not pixel-accurate vs. a native macOS build.
- The dev server is reachable from inside the box only by default. To expose it
  to the host, add a port mapping or use the container's OrbStack DNS name
  (`http://<container-name>.orb.local:5173`).
