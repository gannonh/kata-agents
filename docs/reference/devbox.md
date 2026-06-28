---
type: Reference
title: Devbox — isolated worktree dev environments
description: Single-command isolated devcontainers for concurrent Electron/Vite worktrees, with the full dev toolchain (Bun, gh, Pi agent) and a headed noVNC viewer.
tags: [devbox, devcontainer, docker, orbstack, electron, worktree, pi]
timestamp: 2026-06-28T01:00:00Z
---

# Devbox — isolated worktree dev environments

One command spins up a git worktree in a fully isolated Linux dev container with
its own network namespace (no port collisions between concurrent worktrees), the
full developer toolchain, your Pi agent (config + extensions), and a headed
display for running Electron. Built on the [devcontainer](https://containers.dev)
standard, so the same config also works in VS Code, GitHub Codespaces, and Cursor.

## The problem this solves

`electron:dev` and the dev servers hardcode ports (Vite `:5173`, RPC `:9100`).
Running multiple worktrees on the host means they fight over those ports. Each
devbox runs in its own container network namespace, so `:5173` in one box is
unrelated to `:5173` in another. Run three worktrees at once with zero collisions.

## Requirements

- Docker (tested with OrbStack; Docker Desktop works too)
- `@devcontainers/cli`: `npm i -g @devcontainers/cli`

## Quick start

From the repo root:

```bash
./scripts/devbox.sh my-feature
```

That will:

1. Create a worktree `../kata-agents-my-feature` from `main`
2. Build the image (first run only) and start the dev container via `devcontainer up`
3. Provision once: `bun install`, `ensure:electron`, link `.env`, copy your Pi
   config and reinstall your Pi extensions Linux-native
4. Drop you into a bash shell inside the box

Inside the box, everything is ready:

```bash
pi                      # your agent, with your extensions + auth
bun run electron:dev    # the app, headed (view via noVNC)
gh pr create            # gh, ripgrep, fd, fzf, tmux all present
```

## What's in the box

| Category | Tools |
|---|---|
| Runtime | Node 22, Bun, pnpm |
| Agent | Pi (`@earendil-works/pi-coding-agent`) + your extensions from `~/.pi` |
| Browser | Chromium 149 (headed via noVNC + `--headless=new` for testing the web UIs) |
| CLIs | gh, ripgrep, fd, fzf, tmux, jq, git |
| Display | Xvfb + x11vnc + noVNC + fluxbox (headed Electron) |

Base image: `mcr.microsoft.com/devcontainers/typescript-node:22` — the same
generic Node/TS devcontainer family Codespaces and Cursor build on.

## Viewing the headed GUI

Electron renders to a virtual framebuffer inside the box. View it in your Mac
browser at the URL the launcher prints:

```
http://<container-name>.orb.local:6080/vnc.html
```

OrbStack auto-exposes every container port at `<container-name>.orb.local:<port>`,
so there's nothing to publish and no host-port collisions. The Vite dev server is
similarly reachable at `http://<container-name>.orb.local:5173` when running.

The ready banner and `--list` render the noVNC URL as a clickable terminal
hyperlink (OSC 8) in Ghostty/iTerm. To get the link on demand:

```bash
./scripts/devbox.sh my-feature --url     # print the URL (bare, copy/pipe friendly)
./scripts/devbox.sh my-feature --open    # open it in your default browser
```

## Running multiple worktrees concurrently

```bash
./scripts/devbox.sh feature-a
./scripts/devbox.sh feature-b
./scripts/devbox.sh feature-c
```

Each is a separate container with its own `.orb.local` domain. List them:

```bash
./scripts/devbox.sh --list
```

## Lifecycle

| Action | Command |
|---|---|
| Re-enter a running box | `./scripts/devbox.sh <branch> --attach` |
| Print the noVNC URL (clickable) | `./scripts/devbox.sh <branch> --url` |
| Open the noVNC URL in a browser | `./scripts/devbox.sh <branch> --open` |
| Stop a box (keeps worktree + container) | `./scripts/devbox.sh <branch> --stop` |
| Remove container, worktree, and branch | `./scripts/devbox.sh <branch> --rm` |
| List boxes (with clickable URLs) | `./scripts/devbox.sh --list` |

Stopped boxes keep their filesystem and worktree. Re-attaching restarts the box
and re-runs only the display stack (provisioning runs once per container).

## Pi agent setup

On first provision, the launcher mounts your host `~/.pi` read-only and copies it
into the box, **excluding** `agent/sessions`, `agent/npm`, and `agent/cache` (the
bulky/macOS-native dirs — your 1.3GB `~/.pi` becomes a few hundred MB). It then
reads `~/.pi/agent/settings.json` and runs `pi install <spec>` for each entry in
`.packages[]`, rebuilding every extension Linux-native. Your `auth.json` carries
over, so all providers stay logged in — no re-auth per box.

If you re-authenticate or add an extension on the host, recreate the box
(`--rm` then launch again) to pick up the change.

## GitHub auth

The launcher forwards a GitHub token into the box so `gh` and `git push` work
without logging in per box. It runs `gh auth token` on the host (or honors an
exported `GH_TOKEN` / `GITHUB_TOKEN`) and persists it to
`/etc/profile.d/gh-token.sh` (owned `node:node`, mode 600) so every login shell
— initial, `--attach`, and restarts — is authed. Nothing is written to the repo;
the token flows from your host keyring into the container env.

Inside the box, `gh auth status` shows you logged in, and the git credential
helper is wired for HTTPS push. If the host `gh` isn't authed, the launcher
warns and you can run `gh auth login` in the box instead. Re-authing on the host
doesn't refresh existing boxes — recreate them to pick up a new token.

## Secrets

`.env` is never baked into the image. It's bind-mounted read-only from
`${DEVBOX_ENV}` (default `~/dotfiles/repos/<repo>/.env`) into `/home/node/.env`,
and provisioning symlinks it into `/workspace/.env`. Override:

```bash
DEVBOX_ENV=/path/to/.env ./scripts/devbox.sh my-feature
```

## Adding tools

Two standard hooks, both persist for every future box:

- **A maintained Feature** — add to `features` in `.devcontainer/devcontainer.json`.
  See [containers.dev/features](https://containers.dev/features). Example: add
  `"ghcr.io/devcontainers/features/aws-cli:1": {}` and it's installed next boot.
- **An apt/npm line** — add to `.devbox/Dockerfile` for anything without a Feature.

Per-repo setup commands (build, codegen) go in `postCreateCommand` (runs once) or
`.devbox/provision.sh`.

## Files

| Path | Purpose |
|---|---|
| `.devcontainer/devcontainer.json` | Standard devcontainer config: image, mounts, features, lifecycle hooks, ports |
| `.devbox/Dockerfile` | Image layered on the MS TS-Node base: dev CLIs + Pi + display stack |
| `.devbox/provision.sh` | `postCreateCommand`: repo deps, Electron, `.env`, Pi config + extension replay |
| `.devbox/start-display.sh` | `postStartCommand`: brings up Xvfb/x11vnc/noVNC/fluxbox |
| `scripts/devbox.sh` | Launcher: worktree + `devcontainer up` + lifecycle |

## Reusing across other TypeScript projects

1. Copy `.devcontainer/`, `.devbox/`, and `scripts/devbox.sh` into the target repo
2. Edit `.devbox/provision.sh` if setup differs (e.g. `pnpm install`, no `ensure:electron`)
3. Run `./scripts/devbox.sh <branch>`

The image and Pi steps are generic; only `provision.sh` knows the repo.

## Troubleshooting

**`Dev container config not found`** — the worktree was created from a commit
that predates `.devcontainer/`. Make sure these files are committed on `main`;
git worktrees only carry committed files.

**`fatal: a branch named 'X' already exists`** — handled automatically. The
launcher reuses an existing branch instead of failing. `--rm` deletes the branch.

**noVNC black screen** — the app hasn't painted yet. Start `bun run electron:dev`
inside the box and the screen populates.

## Notes

- Electron renders against software Xvfb (no GPU). Fine for dev work; not
  pixel-accurate vs. a native macOS build.
- For a native VNC client instead of the browser, point it at
  `<container-name>.orb.local:5900` (or `brew install --cask tigervnc-viewer`).

## Browser + OAuth

Chromium is installed and wrapped so every caller — `xdg-open`, Electron's
`shell.openExternal`, and direct `chromium` invocations — launches it with
`--no-sandbox` (required under Xvfb in a container). The `BROWSER=chromium` env
makes `xdg-open` route to it.

This is what makes provider OAuth work inside the box: when the app starts an
OAuth flow, it opens the consent page in Chromium (visible in noVNC), and the
`localhost:1455` callback resolves because Chromium and the callback server
share the container's network namespace.

Test the web UIs headlessly:

```bash
chromium --headless=new --no-sandbox --disable-gpu --dump-dom http://localhost:5175
```

Or open them in the headed Chromium via noVNC with `xdg-open http://localhost:5175`.
