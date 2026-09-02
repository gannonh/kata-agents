#!/usr/bin/env bash
# Worktree setup — run from the worktree root after `git worktree add`.
#
#   git worktree add ../kata-agents-feature main
#   cd ../kata-agents-feature
#   ./scripts/worktree-setup.sh
#
# Installs deps, ensures the Electron runtime, and symlinks .env from the central
# dotfiles store. Idempotent: safe to re-run.

set -euo pipefail

# Resolve the worktree root from the script location so it works regardless of
# the caller's CWD within the worktree.
WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="/Volumes/EVO/dev/kata-agents"

bun install
bun run ensure:electron
bun run electron:build
ln -sf $PROJECT_ROOT/.env $WORKTREE_ROOT/.env 
(cd "$WORKTREE_ROOT" && ./scripts/install-skills.sh)
