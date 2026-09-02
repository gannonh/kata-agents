#!/usr/bin/env bash
set -euo pipefail

# Copy a skill onto disk. Best-effort: a registry or network hiccup for a single
# skill must not abort dependency setup (this script runs from worktree:setup and
# from the Cloud Agent environment install).
add_skill() {
  if ! npx --yes skills add "$@" -y --copy --agent claude-code cursor codex; then
    echo "install-skills: skipped 'skills add $*' (command failed)" >&2
  fi
}

# Shared workflow skills from @gannonh/agent-setup. Callers must cd to the
# worktree root first; `npx skills add` writes into the current project.
if ! npx --yes @gannonh/agent-setup --skills; then
  echo "install-skills: skipped @gannonh/agent-setup shared skills (command failed)" >&2
fi

# plan-build-verify is required for spec-driven work but not yet in @gannonh/agent-setup's skill pack.
add_skill gannonh/skills --skill plan-build-verify

# Project-specific third party
add_skill https://github.com/mintlify/docs --skill mintlify
