#!/usr/bin/env bash
# =============================================================================
# devbox.sh — spin up an isolated worktree in a headed dev container. One command.
#
#   ./scripts/devbox.sh my-feature            # create/boot a box for a branch
#   ./scripts/devbox.sh my-feature --attach   # re-enter a running box
#   ./scripts/devbox.sh my-feature --url       # print the noVNC URL (clickable)
#   ./scripts/devbox.sh my-feature --open      # open the noVNC URL in a browser
#   ./scripts/devbox.sh my-feature --stop      # stop (keeps worktree + container)
#   ./scripts/devbox.sh my-feature --rm        # remove container, worktree, branch
#   ./scripts/devbox.sh --list                 # list devbox containers + URLs
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

# OSC 8 terminal hyperlink: renders as clickable text in Ghostty/iTerm/etc.
# Falls back to the raw URL on terminals that don't support it.
hyperlink() {
  local url="$1" text="${2:-$1}"
  printf '\e]8;;%s\e\\%s\e]8;;\e\\' "${url}" "${text}"
}

# noVNC URL for a running box's container.
novnc_url_for() {
  local cid="$1" cname
  cname="$(docker inspect "${cid}" --format '{{.Name}}' | sed 's,^/,,')"
  echo "http://${cname}.orb.local:6080/vnc.html"
}

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
  local rows; rows="$(docker ps -a --filter "label=devbox.repo=${REPO_NAME}" \
    --format '{{.Label "devbox.branch"}}\t{{.Names}}\t{{.State}}')"
  [[ -n "${rows}" ]] || { echo "  (none)" >&2; return; }
  while IFS=$'\t' read -r branch name state; do
    [[ -z "${name}" ]] && continue
    if [[ "${state}" == "running" ]]; then
      local u="http://${name}.orb.local:6080/vnc.html"
      printf '  %-22s %-9s ' "${branch}" "${state}" >&2
      hyperlink "${u}" "${u}" >&2
      printf '\n' >&2
    else
      printf '  %-22s %-9s (stopped — start with: devbox.sh %s)\n' "${branch}" "${state}" "${branch}" >&2
    fi
  done <<< "${rows}"
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
    # Re-run display stack after restart. setsid so it survives this exec
    # session closing (a backgrounded job would be reaped).
    docker exec -u node "${cid}" bash -lc 'setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true' || true
    sleep 2
    exec docker exec ${DOCKER_TTY} -w /workspace -u node "${cid}" bash -l
  fi

  # Fresh box: create the worktree (reuse branch if it already exists).
  # --relative-paths makes the worktree's .git pointer use relative paths, so it
  # resolves both on the host and inside the container (where the main repo's
  # .git is mounted via --mount-git-worktree-common-dir). Without it, .git holds
  # an absolute host path and `git` fails inside the box ("not a git repository").
  if [[ ! -d "${path}" ]]; then
    info "creating worktree ${branch} -> ${path}"
    git -C "${REPO_ROOT}" fetch origin main 2>/dev/null || true
    if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${branch}"; then
      git -C "${REPO_ROOT}" worktree add --relative-paths "${path}" "${branch}"
    else
      git -C "${REPO_ROOT}" worktree add --relative-paths -b "${branch}" "${path}" main
    fi
  else
    info "worktree exists at ${path}, reusing"
  fi

  [[ -f "${DEVBOX_ENV}" ]] || warn "no .env at ${DEVBOX_ENV} (set DEVBOX_ENV)"

  # GitHub auth: pull a token from the host gh (keyring) so gh + git push work
  # in the box. Nothing is written to disk — it flows keyring -> container env.
  # Honor an explicit GH_TOKEN/GITHUB_TOKEN if already exported.
  local gh_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ -z "${gh_token}" ]] && command -v gh >/dev/null 2>&1; then
    gh_token="$(gh auth token 2>/dev/null || true)"
  fi
  local gh_env_args=()
  if [[ -n "${gh_token}" ]]; then
    gh_env_args=(--remote-env "GH_TOKEN=${gh_token}")
    info "forwarding GitHub token from host gh"
  else
    warn "no GitHub token (host gh not authed); gh/git push will need 'gh auth login' in the box"
  fi

  info "building + starting dev container (first run pulls base + provisions; takes a few min)"
  # devcontainer up reads .devcontainer/devcontainer.json from the worktree.
  # --id-label tags the container so we can find it again for attach/stop/rm.
  # Make git work inside the box. A worktree's .git points (relatively, via
  # --relative-paths above) at the main repo's .git, which lives beside the
  # worktree on the host. The worktree mounts at /workspace, so the relative
  # pointer ../<repo>/.git resolves to /<repo>/.git in the box — mount the main
  # .git there (read-write: commits need to write refs/index/objects).
  DEVBOX_ENV="${DEVBOX_ENV}" devcontainer up \
    --workspace-folder "${path}" \
    --id-label "$(id_label "${branch}")" \
    --id-label "devbox.repo=${REPO_NAME}" \
    --mount "type=bind,source=${REPO_ROOT}/.git,target=/${REPO_NAME}/.git" \
    "${gh_env_args[@]}" \
    2>&1 | sed 's/^/[devcontainer] /'

  cid="$(container_for "${branch}")"
  [[ -n "${cid}" ]] || die "container did not come up; check 'devcontainer up' output above"

  # Persist GH_TOKEN into the box so every shell (this one, future --attach, and
  # restarts) is authed without re-passing it. /etc/profile sources profile.d
  # for login shells; the file must be readable by the non-root 'node' user, so
  # own it node:node mode 600 (secret, readable only by the user who needs it).
  if [[ -n "${gh_token}" ]]; then
    printf 'export GH_TOKEN=%q\n' "${gh_token}" \
      | docker exec -i -u root "${cid}" bash -c 'cat > /etc/profile.d/gh-token.sh && chown node:node /etc/profile.d/gh-token.sh && chmod 600 /etc/profile.d/gh-token.sh'
  fi

  # OrbStack exposes container ports at <name>.orb.local:<port> (no publishing,
  # no collisions). Fall back to the container IP on non-OrbStack Docker.
  local cname; cname="$(docker inspect "${cid}" --format '{{.Name}}' | sed 's,^/,,')"
  local host="${cname}.orb.local"
  local novnc="http://${host}:6080/vnc.html"
  local vite="http://${host}:5173"

  {
    printf "\n${CYAN}━━━ devbox ready ━━━${NC}\n"
    printf "  branch:     %s\n" "${branch}"
    printf "  worktree:   %s\n" "${path}"
    printf "  Pi:         pi            (config + extensions copied from your ~/.pi)\n"
    printf "  Electron:   bun run electron:dev\n"
    printf "  noVNC:      "; hyperlink "${novnc}" "${novnc}"; printf "\n"
    printf "  Vite:       "; hyperlink "${vite}" "${vite}"; printf "    (when running)\n"
    printf "  Re-enter:   ./scripts/devbox.sh %s --attach\n" "${branch}"
    printf "  URL/open:   ./scripts/devbox.sh %s --url   (add --open to launch a browser)\n" "${branch}"
    printf "  Stop:       ./scripts/devbox.sh %s --stop\n" "${branch}"
    printf "  Remove:     ./scripts/devbox.sh %s --rm\n\n" "${branch}"
  } >&2

  exec docker exec ${DOCKER_TTY} -w /workspace -u node "${cid}" bash -l
}

cmd_url() {
  local branch="$1" open=0
  [[ "${2:-}" == "--open" || "${2:-}" == "-o" ]] && open=1
  local cid; cid="$(container_for "${branch}")"
  [[ -n "${cid}" ]] || die "no running box for ${branch} (start it with: devbox.sh ${branch})"
  local url; url="$(novnc_url_for "${cid}")"
  if [[ "${open}" -eq 1 ]]; then
    info "opening ${url}"
    open "${url}" 2>/dev/null || die "could not open browser (URL: ${url})"
  else
    # Bare URL on stdout (copy/pipe friendly); clickable hint on stderr.
    echo "${url}"
    [[ -t 2 ]] && { printf '  ' >&2; hyperlink "${url}" "open in browser" >&2; printf '\n' >&2; }
  fi
}

# --- dispatch ----------------------------------------------------------------
usage() { sed -n '3,17p' "$0" >&2; exit 1; }

normalize() {
  local a="$1" b="${2:-}"
  case "$a" in
    --stop|--rm|--list|--help|-l|-h) FLAG="$a"; BRANCH="$b" ;;
    --attach|-a|--url|--open|-o) FLAG="$a"; BRANCH="$b" ;;
    -*) die "unknown option: $a" ;;
    *) BRANCH="$a"; FLAG="${b:-}" ;;
  esac
}

[[ $# -ge 1 ]] || usage
normalize "$1" "${2:-}"
case "${FLAG}" in
  "")          [[ -n "${BRANCH}" ]] || usage; cmd_up "${BRANCH}" ;;
  --attach|-a) [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --attach"; cmd_up "${BRANCH}" --attach ;;
  --url)       [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --url [--open]"; cmd_url "${BRANCH}" "${3:-}" ;;
  --open|-o)   [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --open"; cmd_url "${BRANCH}" --open ;;
  --list|-l)   cmd_list ;;
  --help|-h)   usage ;;
  --stop)      [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --stop"; cmd_stop "${BRANCH}" ;;
  --rm)        [[ -n "${BRANCH}" ]] || die "usage: devbox.sh <branch> --rm"; cmd_rm "${BRANCH}" ;;
  *)           die "unknown flag: ${FLAG}" ;;
esac
