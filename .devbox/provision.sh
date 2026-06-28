#!/usr/bin/env bash
# =============================================================================
# provision.sh — repo + agent setup, run once at container create
# (devcontainer.json postCreateCommand). Idempotent.
#
# Repo-specific: this file knows the Kata layout. For another project, adjust
# the deps and Electron steps. The Pi steps are generic and reusable.
# =============================================================================
set -euo pipefail

cd /workspace
log() { printf '[provision] %s\n' "$*" >&2; }

# --- 1. Repo dependencies -----------------------------------------------------
# node_modules persists in the bind-mounted worktree, so skip when populated.
if [[ -f bun.lock && ! -d node_modules/bun ]]; then
  log "bun install"
  bun install
elif [[ -f bun.lock ]]; then
  log "node_modules present, skipping bun install"
elif [[ -f pnpm-lock.yaml && ! -d node_modules/.pnpm ]]; then
  log "pnpm install"
  pnpm install --frozen-lockfile
elif [[ -f package-lock.json && ! -d node_modules/.package-lock.json ]]; then
  log "npm ci"
  npm ci
fi

# --- 2. Kata-specific: Electron runtime ---------------------------------------
if [[ -f package.json ]] && grep -q '"ensure:electron"' package.json; then
  log "ensuring Electron runtime"
  bun run ensure:electron || log "warn: ensure:electron failed (Electron GUI may not launch)"
fi

# --- 3. .env link -------------------------------------------------------------
if [[ -f "${HOME}/.env" ]] && [[ ! -e /workspace/.env ]]; then
  ln -s "${HOME}/.env" /workspace/.env
  log "linked .env -> ${HOME}/.env"
fi

# --- 4. Pi config + extensions ------------------------------------------------
# Copy the host ~/.pi (mounted read-only at /tmp/host-pi) into the box, EXCLUDING
# the bulky / macOS-native dirs (sessions, npm node_modules, cache). Then replay
# the user's extension set from settings.json so they build Linux-native.
HOST_PI=/tmp/host-pi
BOX_PI="${HOME}/.pi"
if [[ -d "${HOST_PI}" ]] && [[ ! -d "${BOX_PI}" ]]; then
  log "copying Pi config from host (excluding sessions/npm/cache)"
  mkdir -p "${BOX_PI}"
  # rsync preserves the tree while pruning the heavy dirs.
  rsync -a \
    --exclude 'agent/sessions/' \
    --exclude 'agent/npm/' \
    --exclude 'agent/cache/' \
    "${HOST_PI}/" "${BOX_PI}/"

  # Replay extensions from settings.json .packages[] (Linux-native rebuild).
  SETTINGS="${BOX_PI}/agent/settings.json"
  if [[ -f "${SETTINGS}" ]] && command -v pi >/dev/null 2>&1; then
    mapfile -t specs < <(jq -r '.packages[]?' "${SETTINGS}" 2>/dev/null || true)
    if [[ "${#specs[@]}" -gt 0 ]]; then
      log "reinstalling ${#specs[@]} Pi extensions"
      for spec in "${specs[@]}"; do
        [[ -z "${spec}" ]] && continue
        log "  pi install ${spec}"
        pi install "${spec}" --approve >/tmp/pi-install.log 2>&1 \
          || log "  warn: failed to install ${spec} (see /tmp/pi-install.log)"
      done
    fi
  fi
else
  log "Pi config already present or host ~/.pi not mounted — skipping"
fi

log "provisioning complete"
