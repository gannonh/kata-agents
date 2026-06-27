#!/usr/bin/env bash
# =============================================================================
# start-display.sh — container entrypoint.
#
# Brings up the headed display stack (Xvfb + x11vnc + noVNC + fluxbox), runs
# repo provisioning once, then hands control to the command passed as args
# (default: bash -l). The display stack keeps running in the background; when
# the foreground command exits, the container exits.
#
# Why each piece exists:
#   Xvfb      — virtual framebuffer. Electron needs a DISPLAY to render to,
#               even though there's no physical monitor.
#   fluxbox   — window manager. Electron/Chromium needs a WM to receive focus
#               and window events; without it windows may not paint.
#   x11vnc    — exposes the Xvfb display over VNC (port 5900).
#   websockify — bridges VNC -> WebSocket so noVNC works in a browser tab
#               (port 6080). This is how Cursor exposes its cloud desktop too.
# =============================================================================
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_W="${SCREEN_WIDTH:-1600}"
SCREEN_H="${SCREEN_HEIGHT:-1000}"
SCREEN_D="${SCREEN_DEPTH:-24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

log() { printf '[display] %s\n' "$*" >&2; }

# --- 1. Virtual framebuffer ---------------------------------------------------
# -ac disables access control (fine inside an isolated container).
# -nolisten tcp keeps X from listening on TCP; x11vnc handles networking.
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "starting Xvfb on ${DISPLAY} (${SCREEN_W}x${SCREEN_H}x${SCREEN_D})"
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN_W}x${SCREEN_H}x${SCREEN_D}" \
       -ac -nolisten tcp &
  # Give X a moment to come up before anything tries to connect.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

# --- 2. Window manager --------------------------------------------------------
if ! pgrep -x fluxbox >/dev/null 2>&1; then
  log "starting fluxbox"
  (DISPLAY="${DISPLAY}" fluxbox >/tmp/fluxbox.log 2>&1 &)
fi

# --- 3. VNC server ------------------------------------------------------------
# -forever keeps x11vnc alive across client disconnects.
# -shared allows multiple viewers (handy when pairing / screenshotting).
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  log "starting x11vnc on ${VNC_PORT}"
  mkdir -p "${HOME}/.vnc"
  # Self-signed password file lets clients connect with a known password
  # ('kata'). Set VNC_PASSWORD at run time to override.
  VNC_PASSWORD="${VNC_PASSWORD:-kata}"
  x11vnc -storepasswd "${VNC_PASSWORD}" "${HOME}/.vnc/passwd" >/dev/null 2>&1
  (x11vnc -display "${DISPLAY}" -rfbauth "${HOME}/.vnc/passwd" \
          -rfbport "${VNC_PORT}" -shared -forever -nopw 2>/tmp/x11vnc.log &)
fi

# --- 4. noVNC (browser viewer) ------------------------------------------------
if ! pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null 2>&1; then
  log "starting noVNC on http://localhost:${NOVNC_PORT}/vnc.html"
  # websockify ships with the noVNC web root in its package on Ubuntu.
  NOVNC_WEB=/usr/share/novnc
  (websockify --web="${NOVNC_WEB}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
              >/tmp/novnc.log 2>&1 &)
fi

log "display ready: VNC :${VNC_PORT}  noVNC http://localhost:${NOVNC_PORT}/vnc.html"

# --- 5. Repo provisioning (idempotent) ---------------------------------------
# Only runs once per container — flagged by a marker file so re-attaching to an
# existing box is instant.
MARKER="${HOME}/.devbox-provisioned"
if [[ ! -f "${MARKER}" ]] && [[ -f /home/node/provision.sh ]]; then
  log "first-run provisioning"
  bash /home/node/provision.sh || log "warn: provision.sh exited non-zero (continuing)"
  touch "${MARKER}"
else
  log "already provisioned — skipping"
fi

# --- 6. Hand off to the caller's command -------------------------------------
log "handing off to: $*"
exec "$@"
