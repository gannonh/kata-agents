/**
 * Pure reducer helpers for the desktop update state machine.
 *
 * Modeled on kata-code's `apps/desktop/src/updates/updateMachine.ts`, retargeted
 * to Kata Agents' Bun/TypeScript toolchain. These helpers are intentionally
 * free of Electron imports so they can be unit-tested in isolation.
 *
 * Why pure reducers: the sidebar update pill and Settings action button both
 * derive their label and enabled state from `DesktopUpdateState`. Centralizing
 * every transition here guarantees a failed download never clears the
 * available version (which would hide the retry button), and a channel switch
 * never leaves a stale "downloaded" state from the wrong feed.
 *
 * See `docs/specs/2026-06-20-update-ux-parity-with-kata-code-design.md` AC6/AC12.
 */

export type {
  DesktopUpdateChannel,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from '../shared/types'

import type {
  DesktopUpdateChannel,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from '../shared/types'

function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateStatus {
  return currentState.availableVersion ? 'available' : 'error'
}

function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null
}

/**
 * Initial state for a freshly configured updater. Starts disabled until the
 * controller confirms the feed is available; the controller flips `enabled`
 * and `status` to `idle` once configured.
 */
export function createInitialDesktopUpdateState(
  currentVersion: string,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    status: 'disabled',
    channel,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Begin a check: clear any prior error/progress and stamp the check time. */
export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: 'checking',
    checkedAt,
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Check failed: surface the error with `check` context and allow retry. */
export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
): DesktopUpdateState {
  // Preserve `available` when we still know the version so the download CTA
  // stays visible after a transient check failure (poll/manual re-check).
  const status: DesktopUpdateStatus = state.availableVersion ? 'available' : 'error'
  return {
    ...state,
    status,
    message,
    checkedAt,
    downloadPercent: null,
    errorContext: 'check',
    canRetry: true,
  }
}

/** An update is available: record its version and clear any stale download. */
export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: 'available',
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** No update available: clear any prior available version (we're up to date). */
export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: 'up-to-date',
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Download started: reset progress to 0 and clear errors. */
export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloading',
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/** Download progress: update percent and ensure status is `downloading`. */
export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloading',
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}

/**
 * Download failed: return to `available` if we still know the version (so the
 * pill can offer the download again), otherwise surface a hard error.
 */
export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    errorContext: 'download',
    canRetry: getCanRetryAfterDownloadFailure(state),
  }
}

/** Download complete: mark `downloaded` at 100% with retry allowed (for reinstall). */
export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloaded',
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  }
}

/**
 * Install failed: stay `downloaded` so the sidebar pill keeps offering
 * "Restart to update" and the user can retry the install.
 */
export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: 'downloaded',
    message,
    errorContext: 'install',
    canRetry: true,
  }
}

/**
 * Reset state when switching update tracks (AC6). Clears any stale
 * available/downloaded/version/error metadata so a pill from the previous
 * channel's feed never surfaces on the new channel. `currentVersion` and
 * `enabled` are preserved (this is not an enable/disable event).
 */
export function reduceDesktopUpdateStateOnChannelReset(
  state: DesktopUpdateState,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    ...state,
    channel,
    status: 'idle',
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  }
}
