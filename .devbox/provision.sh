#!/usr/bin/env bash
# =============================================================================
# provision.sh — repo setup, run once per container (inside the box).
#
# This is the container-side mirror of scripts/worktree-setup.sh. Kept separate
# so the image stays generic across projects — only this file knows about the
# Kata repo layout. For a different project, swap this script.
#
# Assumes the repo is mounted at /workspace (done by scripts/devbox.sh).
# =============================================================================
set -euo pipefail

cd /workspace

log() { printf '[provision] %s\n' "$*" >&2; }

# --- 1. Dependencies ----------------------------------------------------------
# Skip when node_modules is already populated (the worktree persists on the host
# across container rebuilds, so re-creating a box is instant).
if [[ -f bun.lock && ! -d node_modules/bun ]]; then
  log "bun install"
  bun install
elif [[ -f bun.lock ]]; then
  log "node_modules present, skipping bun install"
elif [[ -f pnpm-lock.yaml && ! -d node_modules/.pnpm ]]; then
  log "pnpm install"
  pnpm install --frozen-lockfile
elif [[ -f pnpm-lock.yaml ]]; then
  log "node_modules present, skipping pnpm install"
elif [[ -f package-lock.json && ! -d node_modules/.package-lock.json ]]; then
  log "npm ci"
  npm ci
fi

# --- 2. Kata-specific: ensure Electron runtime --------------------------------
if [[ -f package.json ]] && grep -q '"ensure:electron"' package.json; then
  log "ensuring Electron runtime"
  bun run ensure:electron || log "warn: ensure:electron failed (Electron GUI may not launch)"
fi

# --- 3. .env from the central dotfiles store ----------------------------------
# The host .env is bind-mounted to /home/node/.env by devbox.sh so secrets
# never get baked into the image. Link it into the workspace.
if [[ -f "${HOME}/.env" ]] && [[ ! -e /workspace/.env ]]; then
  ln -s "${HOME}/.env" /workspace/.env
  log "linked .env -> ${HOME}/.env"
fi

log "provisioning complete"
