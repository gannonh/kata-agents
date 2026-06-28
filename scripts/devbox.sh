#!/usr/bin/env bash
# =============================================================================
# devbox.sh — spin up an isolated worktree in a headed dev container. One command.
#
#   ./scripts/devbox.sh my-feature            # create/boot a box for a branch
#   ./scripts/devbox.sh my-feature --attach   # re-enter a running box
#   ./scripts/devbox.sh my-feature --stop      # stop (keeps worktree + container)
#   ./scripts/devbox.sh my-feature --rm        # remove container, worktree, branch
#   ./scripts/devbox.sh --list                 # list devbox containers
#
# Built on the devcontainer standard: this script drives `devcontainer up`
# against a per-worktree folder, so each worktree is fully isolated (its own
# network namespace -> no port collisions) and gets the full dev toolchain:
# Node/Bun/pnpm, gh, ripgrep/fd/fzf/tmux, the Pi agent (with your config and
# extensions), and a headed display (Electron via noVNC in your browser).
#
# Config lives in .devcontainer/devcontainer.json (standard, also works in
# Codespaces/Cursor). Add tools there or in .devbox/Dockerfile.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
WORKTREES_DIR="${DEVBOX_WORKTREES_DIR:-$(dirname "$REPO_ROOT")}"

# .env source: explicit DEVBOX_ENV, else the dotfiles convention.
export DEVBOX_ENV="${DEVBOX_ENV:-${HOME}/dotfiles/repos/${REPO_NAME}/.env}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[devbox]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[devbox]${NC} %s\n" "$*" >&2; }
error() { printf "${RED}[devbox]${NC} %s\n" "$*" >&2; }
die()   { error "$*"; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 ($2)"; }

branch_to_path()  { echo "${WORKTREES_DIR}/${REPO_NAME}-${1}"; }
# devcontainer derives container names; we tag with an id label for lookup.
id_label()        { echo "devbox.branch=${1}"; }

DOCKER_TTY="-i"; [[ -t 0 ]] && DOCKER_TTY="-it"

# Resolve the running container id for a worktree by its id label.
container_for() {
  docker ps -q --filter "label=$(id_label "$1")" 2>/dev/null | head -1
}
container_for_all() {
  docker ps -aq --filter "label=$(id_label "$1")" 2>/dev/null | head -1
}

# --- commands ----------------------------------------------------------------
cmd_list() {
  info "devbox containers:"
  docker ps -a --filter "label=devbox.repo=${REPO_NAME}" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
}

cmd_stop() {
  local cid; cid="$(container_for_all "$1")"
  [[ -n "${cid}" ]] || { warn "no container for branch $1"; return; }
  docker stop "${cid}" >/dev/null
  info "stopped (worktree kept; --attach to resume)"
}

cmd_rm() {
  local branch="$1" path; path="$(branch_to_path "$branch")"
  local cid; cid="$(container_for_all "$branch")"
  [[ -n "${cid}" ]] && docker rm -f "${cid}" >/dev/null 2>&1 || true
  if [[ -d "${path}" ]]; then
    git -C "${REPO_ROOT}" worktree remove --force "${path}" 2>/dev/null || rm -rf "${path}"
    info "removed worktree ${path}"
  fi
  if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "${REPO_ROOT}" branch -D "${branch}" 2>/dev/null && info "deleted branch ${branch}"
  fi
  info "removed devbox for ${branch}"
}

cmd_up() {
  local branch="$1"; shift || true
  local attach=0
  [[ "${1:-}" == "--attach" || "${1:-}" == "-a" ]] && attach=1

  require_cmd docker "Docker / OrbStack"
  require_cmd devcontainer "npm i -g @devcontainers/cli"

  local path; path="$(branch_to_path "${branch}")"

  # Re-enter a running box.
  local cid; cid="$(container_for "${branch}")"
  if [[ -n "${cid}" ]]; then
    info "attaching to running box for ${branch}"
    exec docker exec ${DOCKER_TTY} -w /workspace -u node "${cid}" bash -l
  fi
  # Start a stopped box.
  cid="$(container_for_all "${branch}")"
  if [[ -n "${cid}" ]]; then
    info "starting stopped box for ${branch}"
    docker start "${cid}" >/dev/null
    # Re-run display stack after restart.
    docker exec -u node "${cid}" bash -lc 'nohup /usr/local/bin/devbox-start-display >/tmp/devbox-display.log 2>&1 &' || true
    exec docker exec ${DOCKER_TTY} -w /workspace -u node "${cid}" bash -l
  fi

  # Fresh box: create the worktree (reuse branch if it already exists).
  if [[ ! -d "${path}" ]]; then
    info "creating worktree ${branch} -> ${path}"
    git -C "${REPO_ROOT}" fetch origin main 2>/dev/null || true
    if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${branch}"; then
      git -C "${REPO_ROOT}" worktree add "${path}" "${branch}"
    else
      git -C "${REPO_ROOT}" worktree add -b "${branch}" "${path}" main
    fi
  else
    info "worktree exists at ${path}, reusing"
  fi

  [[ -f "${DEVBOX_ENV}" ]] || warn "no .env at ${DEVBOX_ENV} (set DEVBOX_ENV)"

  info "building + starting dev container (first run pulls base + provisions; takes a few min)"
  # devcontainer up reads .devcontainer/devcontainer.json from the worktree.
  # --id-label tags the container so we can find it again for attach/stop/rm.
  DEVBOX_ENV="${DEVBOX_ENV}" devcontainer up \
    --workspace-folder "${path}" \
    --id-label "$(id_label "${branch}")" \
    --id-label "devbox.repo=${REPO_NAME}" \
    2>&1 | sed 's/^/[devcontainer] /'

  cid="$(container_for "${branch}")"
  [[ -n "${cid}" ]] || die "container did not come up; check 'devcontainer up' output above"

  # OrbStack exposes container ports at <name>.orb.local:<port> (no publishing,
  # no collisions). Fall back to the container IP on non-OrbStack Docker.
  local cname; cname="$(docker inspect "${cid}" --format '{{.Name}}' | sed 's,^/,,')"
  local host="${cname}.orb.local"

  cat >&2 <<EOF

$(printf "${CYAN}")━━━ devbox ready ━━━$(printf "${NC}")
  branch:     ${branch}
  worktree:   ${path}
  Pi:         pi            (config + extensions copied from your ~/.pi)
  Electron:   bun run electron:dev
  noVNC:      http://${host}:6080/vnc.html
  Vite:       http://${host}:5173    (when running)
  Re-enter:   ./scripts/devbox.sh ${branch} --attach
  Stop:       ./scripts/devbox.sh ${branch} --stop
  Remove:     ./scripts/devbox.sh ${branch} --rm

EOF

  exec docker exec ${DOCKER_TTY} -w /workspace -u node "${cid}" bash -l
}

# --- dispatch ----------------------------------------------------------------
usage() { sed -n '3,17p' "$0" >&2; exit 1; }

normalize() {
  local a="$1" b="${2:-}"
  case "$a" in
    --stop|--rm|--list|--help|-l|-h) FLAG="$a"; BRANCH="$b" ;;
    --attach|-a) FLAG="$a"; BRANCH="$b" ;;
    -*) die "unknown option: $a" ;;
    *) BRANCH="$a"; FLAG="${b:-}" ;;
  esac
}

[[ $# -ge 1 ]] || usage
normalize "$1" "${2:-}"
case "${FLAG}" in
  "")          [[ -n "${BRANCH}" ]] || usage; cmd_up "${BRANCH}" ;;
  --attach|-a) [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --attach"; cmd_up "${BRANCH}" --attach ;;
  --list|-l)   cmd_list ;;
  --help|-h)   usage ;;
  --stop)      [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --stop"; cmd_stop "${BRANCH}" ;;
  --rm)        [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --rm"; cmd_rm "${BRANCH}" ;;
  *)           die "unknown flag: ${FLAG}" ;;
esac
