# =============================================================================
# Kata Agents — headed dev box
#
# One container = one fully isolated worktree: its own network namespace
# (no port collisions between concurrent worktrees), its own Xvfb display,
# VNC server, and Electron instance. Multiple boxes run in parallel.
#
# Build:
#   docker build -t kata-devbox:latest -f .devbox/Dockerfile .devbox
#
# The image is intentionally generic (Node/Bun/desktop stack) so it is reusable
# across TypeScript/Electron projects. Repo-specific provisioning happens at
# container start via .devbox/provision.sh, not in the image.
# =============================================================================

FROM ubuntu:24.04

# Avoid interactive prompts during apt installs.
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# -----------------------------------------------------------------------------
# Base OS + display stack
#
# Xvfb       — virtual framebuffer (a "monitor" with no hardware)
# x11vnc     — VNC server that exposes the Xvfb display over the network
# novnc + websockify — browser viewer so you open Electron in a Mac browser tab
#                      at http://<container>.orb.local:6080 (no VNC client needed)
# fluxbox    — minimal window manager (Electron needs a WM to receive focus)
# xvfb-utils — xrandr for multi-resolution, xdpyinfo for health checks
# -----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      ripgrep \
      unzip \
      xz-utils \
      tzdata \
      sudo \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fluxbox \
      x11-utils \
      x11-xserver-utils \
      libgtk-3-0 \
      libnotify4 \
      libnss3 \
      libxss1 \
      libxtst6 \
      xdg-utils \
      libatspi2.0-0 \
      libdrm2 \
      libgbm1 \
      libasound2t64 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Node.js LTS (required by the WhatsApp worker subprocess; Bun cannot run it).
# Match the major pinned in Dockerfile.server.
# -----------------------------------------------------------------------------
ARG NODE_MAJOR=20
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Bun (primary runtime + package manager for this repo).
# Install into /opt so every user sees the same binary (the default installer
# drops it under the installing user's home, which the non-root node user
# could not read when installed as root during build).
# -----------------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
    && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
    && echo 'export BUN_INSTALL=/opt/bun' >> /etc/profile.d/bun.sh \
    && echo 'export PATH=$BUN_INSTALL/bin:$PATH' >> /etc/profile.d/bun.sh

# -----------------------------------------------------------------------------
# pnpm (your other projects use it; harmless here).
# -----------------------------------------------------------------------------
RUN corepack enable && corepack prepare pnpm@latest --activate

# -----------------------------------------------------------------------------
# Non-root user. Electron refuses several features as root; matching host UID
# keeps mounted-file ownership sane.
# -----------------------------------------------------------------------------
# macOS uses low GIDs (e.g. 20 = dialout on the host) that already exist in
# Ubuntu, so guard the group creation. The node user is added to whatever
# group resolves the host GID, keeping mounted-file ownership sane.
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN if ! getent group "${HOST_GID}" >/dev/null; then \
      groupadd --gid "${HOST_GID}" node; \
    fi \
    && if ! id -u "${HOST_UID}" >/dev/null 2>&1; then \
      useradd --uid "${HOST_UID}" --gid "${HOST_GID}" --create-home \
         --shell /bin/bash node; \
    fi \
    && echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER node
ENV HOME=/home/node
WORKDIR /workspace

# Copy the display launcher and provisioning script as the node user owns them.
COPY --chown=node:node start-display.sh provision.sh /home/node/
RUN sudo chmod +x /home/node/start-display.sh /home/node/provision.sh

# Defaults overridable at `docker run`.
ENV DISPLAY=:99
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV SCREEN_WIDTH=1600
ENV SCREEN_HEIGHT=1000
ENV SCREEN_DEPTH=24

EXPOSE 5900 6080

# Entrypoint: bring up the display stack, provision the repo, then hand off to
# the caller's command (default: bash) via the entrypoint args.
ENTRYPOINT ["/home/node/start-display.sh"]
CMD ["bash", "-l"]
