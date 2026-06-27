#!/usr/bin/env bash
# =============================================================================
# devbox.sh — spin up an isolated worktree in a headed container. One command.
#
#   ./scripts/devbox.sh                       # new worktree from main, interactive
#   ./scripts/devbox.sh my-feature            # named branch
#   ./scripts/devbox.sh my-feature --attach   # re-attach to an existing box
#   ./scripts/devbox.sh --list                # show running boxes
#   ./scripts/devbox.sh my-feature --stop     # stop a box (keeps the worktree)
#   ./scripts/devbox.sh my-feature --rm        # stop box AND remove the worktree
#
# What you get:
#   - A git worktree checked out from main under ../kata-agents-<branch>
#   - A Linux container with its own network namespace (NO port collisions
#     with other worktrees — each gets its own :5173, :9100, etc.)
#   - bun install + ensure:electron run automatically on first start
#   - A headed display: Electron runs inside the box; view it at
#     http://<container>.orb.local:6080/vnc.html (password: kata)
#   - A shell dropped inside the box, ready to `bun run electron:dev`
#
# Reusable across TypeScript/Electron projects: the image is generic; only
# .devbox/provision.sh is repo-specific.
# =============================================================================
set -euo pipefail

# `-it` only when stdin is a real TTY. Piped/non-interactive runs (CI,
# `echo exit | devbox.sh ...`) must use `-i` alone or docker exec hangs on
# TTY allocation.
DOCKER_TTY="-i"
[[ -t 0 ]] && DOCKER_TTY="-it"

# --- config ------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
IMAGE="kata-devbox:latest"
DOCKERFILE="${REPO_ROOT}/.devbox/Dockerfile"
WORKTREES_DIR="${DEVBOX_WORKTREES_DIR:-$(dirname "$REPO_ROOT")}"  # siblings of repo
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
ENV_SOURCE="${DEVBOX_ENV:-${HOME}/dotfiles/repos/${REPO_NAME}/.env}"

# Ports published to the host. Base offsets so multiple boxes can run side by
# side; the launcher picks the first free noVNC port for a new box.
NOVNC_BASE=6080
VNC_BASE=5900

# --- helpers -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[devbox]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[devbox]${NC} %s\n" "$*" >&2; }
error() { printf "${RED}[devbox]${NC} %s\n" "$*" >&2; }
die()   { error "$*"; exit 1; }

branch_to_container() { echo "devbox-${REPO_NAME}-${1//[^a-zA-Z0-9_.-]/-}" | tr '[:upper:]' '[:lower:]'; }
branch_to_path()      { echo "${WORKTREES_DIR}/${REPO_NAME}-${1}"; }

first_free_port() {
  local base="$1"
  for port in $(seq "$base" $((base + 50))); do
    if ! lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 \
       && ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${port}->"; then
      echo "$port"; return 0
    fi
  done
  die "no free port near ${base} (tried 50)"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

ensure_image() {
  if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    info "building image ${IMAGE} (first run only)"
    docker build \
      --build-arg "HOST_UID=${HOST_UID}" \
      --build-arg "HOST_GID=${HOST_GID}" \
      -t "${IMAGE}" -f "${DOCKERFILE}" "${REPO_ROOT}/.devbox"
  fi
}

# --- commands ----------------------------------------------------------------
cmd_list() {
  info "running devboxes:"
  docker ps --filter "name=devbox-${REPO_NAME}-" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
}

cmd_stop() {
  local name; name="$(branch_to_container "$1")"
  if docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
    docker stop "${name}" >/dev/null
    info "stopped ${name} (worktree kept; re-run with --attach to resume)"
  else
    warn "no container named ${name}"
  fi
}

cmd_rm() {
  local branch="$1"
  local name; name="$(branch_to_container "$branch")"
  local path; path="$(branch_to_path "$branch")"
  docker rm -f "${name}" >/dev/null 2>&1 || true
  if [[ -d "${path}" ]]; then
    git -C "${REPO_ROOT}" worktree remove --force "${path}" 2>/dev/null \
      || rm -rf "${path}"
    info "removed worktree ${path}"
  fi
  info "removed ${name}"
}

cmd_up() {
  local branch="$1"; shift || true
  local attach=0
  while (($#)); do
    case "$1" in
      --attach|-a) attach=1 ;;
      *) die "unknown flag: $1" ;;
    esac
    shift
  done

  require_cmd docker
  ensure_image

  local name; name="$(branch_to_container "${branch}")"
  local path; path="$(branch_to_path "${branch}")"

  # Re-attach to an existing running box.
  if docker ps --format '{{.Names}}' | grep -qx "${name}"; then
    if [[ "${attach}" -eq 1 ]] || [[ -t 0 ]]; then
      info "attaching to running box ${name}"
      exec docker exec ${DOCKER_TTY} "${name}" bash -l
    fi
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
    info "starting existing stopped box ${name}"
    docker start "${name}" >/dev/null
    exec docker exec ${DOCKER_TTY} "${name}" bash -l
  fi

  # Fresh box: create the worktree from main.
  if [[ ! -d "${path}" ]]; then
    info "creating worktree ${branch} -> ${path}"
    git -C "${REPO_ROOT}" fetch origin main 2>/dev/null || true
    git -C "${REPO_ROOT}" worktree add -b "${branch}" "${path}" main
  else
    info "worktree exists at ${path}, reusing"
  fi

  # Pick host ports that don't collide with other boxes.
  local novnc_port vnc_port
  novnc_port="$(first_free_port "${NOVNC_BASE}")"
  vnc_port="$(first_free_port "${VNC_BASE}")"

  # Secret handling: never bake into the image. Bind-mount the host .env
  # read-only into the non-root user's home; provision.sh links it into /workspace.
  local env_args=()
  if [[ -f "${ENV_SOURCE}" ]]; then
    env_args=(-v "${ENV_SOURCE}:/home/node/.env:ro")
    info "mounting .env from ${ENV_SOURCE}"
  else
    warn "no .env at ${ENV_SOURCE} — set DEVBOX_ENV or create the file"
  fi

  info "launching container ${name}"
  docker run -d \
    --name "${name}" \
    --user "${HOST_UID}:${HOST_GID}" \
    -v "${path}:/workspace" \
    "${env_args[@]}" \
    -p "${novnc_port}:6080" \
    -p "${vnc_port}:5900" \
    -e "DEVBOX_BRANCH=${branch}" \
    --label "devbox.repo=${REPO_NAME}" \
    --label "devbox.branch=${branch}" \
    --label "devbox.worktree=${path}" \
    "${IMAGE}"

  # Wait for first-run provisioning to finish (bun install + ensure:electron can
  # take a couple minutes cold). Poll the handoff marker; print a heartbeat so
  # the user knows it isn't stuck.
  info "first-run provisioning (bun install, ensure:electron) — cold start takes a couple minutes:"
  local waited=0
  while ! docker logs "${name}" 2>&1 | grep -q '\[display\] handing off to:'; do
    sleep 2; waited=$((waited + 2))
    # Re-print every 10s so the terminal stays alive under herdr/tmux.
    [[ $((waited % 10)) -eq 0 ]] && printf '[devbox] still provisioning (%ss)…\n' "$waited" >&2
    [[ $waited -ge 600 ]] && { warn "provisioning did not finish within 600s; attaching anyway"; break; }
  done

  cat >&2 <<EOF

${CYAN}━━━ devbox ready ━━━${NC}
  branch:     ${branch}
  worktree:   ${path}
  container:  ${name}
  Electron:   bun run electron:dev   (inside the box)
  noVNC:      http://localhost:${novnc_port}/vnc.html   (password: kata)
  VNC:        localhost:${vnc_port}   (password: kata)

  Type ${GREEN}exit${NC} to leave the shell (container keeps running).
  Re-enter with: ${GREEN}./scripts/devbox.sh ${branch} --attach${NC}
  Stop with:     ${GREEN}./scripts/devbox.sh ${branch} --stop${NC}
  Remove with:   ${GREEN}./scripts/devbox.sh ${branch} --rm${NC}

EOF

  exec docker exec ${DOCKER_TTY} "${name}" bash -l
}

# --- arg parsing -------------------------------------------------------------
usage() {
  sed -n '3,21p' "$0" >&2
  exit 1
}

# Both forms are accepted: `devbox.sh <flag> <branch>` and `devbox.sh <branch> <flag>`.
normalize() {
  # $1 flag, $2 branch  OR  $1 branch, $2 flag
  local a="$1" b="${2:-}"
  case "$a" in
    --stop|--rm|--list|--help|-l|-h) FLAG="$a"; BRANCH="$b" ;;
    -*) die "unknown option: $a" ;;
    *) BRANCH="$a"; FLAG="$b" ;;
  esac
}

[[ $# -ge 1 ]] || usage
normalize "$1" "${2:-}"
case "${FLAG}" in
  "")           [[ -n "${BRANCH}" ]] || usage; cmd_up "${BRANCH}" ;;
  --attach|-a)  [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --attach"; cmd_up "${BRANCH}" --attach ;;
  --list|-l)    cmd_list ;;
  --help|-h)    usage ;;
  --stop)       [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --stop"; cmd_stop "${BRANCH}" ;;
  --rm)         [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --rm"; cmd_rm "${BRANCH}" ;;
  *)            die "unknown flag: ${FLAG}" ;;
esac
