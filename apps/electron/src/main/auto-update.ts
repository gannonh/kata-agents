/**
 * Auto-update controller using electron-updater.
 *
 * Stateful desktop update UX modeled on kata-code's DesktopUpdates. The
 * installed build supplies the default channel; a persisted user preference
 * can override it from Settings (AC6). Background checks run after launch and
 * on a poll interval, but the app does NOT auto-download — the user clicks
 * "Update available" / "Download" to fetch, and "Restart to update" to install
 * (AC1, AC3, AC4).
 *
 * Every updater event is reduced into a `DesktopUpdateState` and broadcast to
 * all renderer windows as the canonical source for the sidebar pill and
 * Settings action button (AC9). See
 * `docs/specs/2026-06-20-update-ux-parity-with-kata-code-design.md`.
 *
 * Platform behavior is unchanged from the prior implementation:
 * - macOS: Downloads zip, extracts and swaps app bundle atomically
 * - Windows: Downloads NSIS installer, runs silently on quit
 * - Linux: Downloads AppImage, replaces current file
 */

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { mainLog } from './logger'
import { resolveSelectedChannel, resolveUpdateChannel, type UpdateChannel } from './update-channel'
import { getUpdateChannel, setUpdateChannel as persistUpdateChannel } from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '../shared/types'
import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from '../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnChannelReset,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from './update-state'

// Background-check timing. Startup check is delayed so the app settles before
// hitting the network; the poll cadence matches kata-code's 4-minute interval.
const STARTUP_CHECK_DELAY_MS = 15_000
const POLL_INTERVAL_MS = 4 * 60_000

// Module state ----------------------------------------------------------------

function getInstalledAppVersion(): string {
  return app.getVersion()
}

// Channel is resolved in configureUpdates(); initial sentinel uses the packaged
// Electron app version, not a workspace package version.
let updateState: DesktopUpdateState = createInitialDesktopUpdateState(getInstalledAppVersion(), 'latest')

let eventSink: EventSink | null = null

// In-flight guards prevent concurrent check/download/install actions and the
// channel-switch lock (AC7). Each is a boolean ref rather than a richer mutex
// because the state machine already encodes "is an action active".
let checkInFlight = false
let downloadInFlight = false
let installInFlight = false
let configured = false
let quitting = false

// Flag to prevent force-exit during quitAndInstall (read by index.ts).
let __isUpdating = false

// Hook fired immediately before quitAndInstall, while BrowserWindows still
// exist. electron-updater destroys windows between quitAndInstall and
// before-quit firing, so the regular before-quit save site would see an empty
// array (AC4: multi-window state preservation).
let beforeUpdateQuitHook: (() => void) | null = null

// Poll timer handle, cleared on quit.
let pollTimer: ReturnType<typeof setInterval> | null = null

// Configuration -------------------------------------------------------------

function broadcastState(): void {
  if (!eventSink) return
  const snapshot = { ...updateState }
  eventSink(RPC_CHANNELS.update.STATE_CHANGED, { to: 'all' }, snapshot)
}

function setState(next: DesktopUpdateState): void {
  updateState = next
  broadcastState()
}

function updateStateBy(
  reducer: (current: DesktopUpdateState) => DesktopUpdateState,
): DesktopUpdateState {
  const next = reducer(updateState)
  setState(next)
  return next
}

// Exported API --------------------------------------------------------------

export function setAutoUpdateEventSink(sink: EventSink): void {
  eventSink = sink
}

export function setBeforeUpdateQuitHook(fn: () => void): void {
  beforeUpdateQuitHook = fn
}

export function isUpdating(): boolean {
  return __isUpdating
}

export function getUpdateState(): DesktopUpdateState {
  return { ...updateState }
}

/**
 * Whether any update action is active, used to block channel changes (AC7).
 */
function activeAction(): 'check' | 'download' | 'install' | null {
  if (installInFlight) return 'install'
  if (downloadInFlight) return 'download'
  if (checkInFlight) return 'check'
  return null
}

// Configuration --------------------------------------------------------------

/**
 * Configure the updater and start background checks. Idempotent. Called once
 * on app launch from index.ts. Sets the initial state (enabled/disabled),
 * wires electron-updater events, applies the persisted channel preference,
 * and starts the startup + poll checks.
 *
 * Dev mock feed (AC13 verification): setting KATA_UPDATES_MOCK=1 (with optional
 * KATA_UPDATES_MOCK_PORT) redirects the updater to a localhost generic provider
 * so update-available/download/downloaded transitions can be exercised without
 * a real GitHub release.
 */
export async function configureUpdates(): Promise<void> {
  if (configured) return
  configured = true

  const installedVersion = getInstalledAppVersion()
  const resolved = resolveSelectedChannel(installedVersion, getUpdateChannel(installedVersion))

  const mockUpdates = process.env.KATA_UPDATES_MOCK === '1'

  try {
    if (mockUpdates) {
      const mockPort = process.env.KATA_UPDATES_MOCK_PORT ?? '0'
      const mockPortNumber = Number(mockPort)
      if (!Number.isInteger(mockPortNumber) || mockPortNumber < 0 || mockPortNumber > 65535) {
        throw new Error(`Invalid KATA_UPDATES_MOCK_PORT: ${mockPort}`)
      }
      const mockFeedUrl = `http://127.0.0.1:${mockPortNumber}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: mockFeedUrl,
      } as any)
      mainLog.info('[auto-update] using mock update feed', { port: mockPortNumber })
    } else {
      applyAutoUpdaterChannel(resolved.channel)
    }
  } catch (err) {
    // Missing app-update.yml / not packaged: surface as disabled, but keep the
    // app running. The renderer treats `enabled=false` as "hide the pill".
    mainLog.warn('[auto-update] feed unavailable, updates disabled:', err instanceof Error ? err.message : err)
    setState({ ...updateState, enabled: false, status: 'disabled' })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  attachUpdaterEventHandlers()

  setState({
    ...createInitialDesktopUpdateState(installedVersion, resolved.channel),
    enabled: true,
    status: 'idle',
  })

  mainLog.info('[auto-update] Configured', {
    channel: resolved.channel,
    configuredByUser: resolved.configuredByUser,
    autoDownload: false,
  })

  // Startup check (delayed) + recurring poll.
  scheduleStartupCheck()
  startPolling()
}

function applyAutoUpdaterChannel(channel: UpdateChannel): void {
  const allowsPrerelease = channel === 'nightly'
  const installedChannel = resolveUpdateChannel(getInstalledAppVersion())
  autoUpdater.channel = channel
  autoUpdater.allowPrerelease = allowsPrerelease
  // Allow downgrade when on nightly, or when a nightly build is tracking stable
  // so startup/poll checks can offer a lower stable release (AC6).
  autoUpdater.allowDowngrade =
    allowsPrerelease || (channel === 'latest' && installedChannel === 'nightly')
}

function scheduleStartupCheck(): void {
  setTimeout(() => {
    checkForUpdate('startup').catch((err) => {
      mainLog.error('[auto-update] startup check failed:', err instanceof Error ? err.message : err)
    })
  }, STARTUP_CHECK_DELAY_MS)
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    checkForUpdate('poll').catch((err) => {
      mainLog.error('[auto-update] poll check failed:', err instanceof Error ? err.message : err)
    })
  }, POLL_INTERVAL_MS)
}

/**
 * Stop background checks and mark quitting. Called from index.ts on
 * before-quit so a poll never fires mid-shutdown.
 */
export function stopUpdates(): void {
  quitting = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// electron-updater event handlers ------------------------------------------

function attachUpdaterEventHandlers(): void {
  autoUpdater.on('checking-for-update', () => {
    mainLog.info('[auto-update] checking for updates')
  })

  autoUpdater.on('update-available', (info) => {
    // Belt-and-suspenders channel guard: the channel-specific manifest should
    // already exclude other channels, but never let a nightly version surface
    // to a stable install (or vice versa).
    if (info.version && resolveSelectedChannel(info.version).channel !== updateState.channel) {
      mainLog.info(
        `[auto-update] ignoring update ${info.version}: does not match selected channel ${updateState.channel}`,
      )
      const checkedAt = new Date().toISOString()
      updateStateBy((s) => reduceDesktopUpdateStateOnNoUpdate(s, checkedAt))
      return
    }

    mainLog.info(`[auto-update] update available: ${updateState.currentVersion} → ${info.version}`)
    const checkedAt = new Date().toISOString()
    updateStateBy((s) => reduceDesktopUpdateStateOnUpdateAvailable(s, info.version, checkedAt))
  })

  autoUpdater.on('update-not-available', (info) => {
    mainLog.info(`[auto-update] up to date (${info?.version ?? '?'})`)
    const checkedAt = new Date().toISOString()
    updateStateBy((s) => reduceDesktopUpdateStateOnNoUpdate(s, checkedAt))
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent)
    updateStateBy((s) => reduceDesktopUpdateStateOnDownloadProgress(s, percent))
  })

  autoUpdater.on('update-downloaded', (info) => {
    mainLog.info(`[auto-update] update downloaded: v${info.version}`)
    updateStateBy((s) => reduceDesktopUpdateStateOnDownloadComplete(s, info.version))
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    mainLog.error('[auto-update] error:', message)

    if (installInFlight) {
      updateStateBy((s) => reduceDesktopUpdateStateOnInstallFailure(s, message))
      installInFlight = false
      __isUpdating = false
      return
    }
    if (downloadInFlight) {
      updateStateBy((s) => reduceDesktopUpdateStateOnDownloadFailure(s, message))
      downloadInFlight = false
    } else {
      const checkedAt = new Date().toISOString()
      updateStateBy((s) => reduceDesktopUpdateStateOnCheckFailure(s, message, checkedAt))
    }
  })
}

// Actions -------------------------------------------------------------------

export interface CheckOptions {
  /** Why the check was triggered (startup/poll/menu/settings/channel-change). */
  reason?: string
}

/**
 * Check for updates without downloading (AC1). Returns the resulting state so
 * the renderer/main can react.
 */
export async function checkForUpdate(reason: string = 'manual'): Promise<DesktopUpdateCheckResult> {
  if (quitting) return { checked: false, state: getUpdateState() }
  if (!configured) return { checked: false, state: getUpdateState() }
  if (checkInFlight) return { checked: false, state: getUpdateState() }

  const current = updateState
  if (current.status === 'downloading' || current.status === 'downloaded') {
    mainLog.info('[auto-update] skipping check while update active', { reason, status: current.status })
    return { checked: false, state: getUpdateState() }
  }

  checkInFlight = true
  const checkedAt = new Date().toISOString()
  updateStateBy((s) => reduceDesktopUpdateStateOnCheckStart(s, checkedAt))
  mainLog.info('[auto-update] checking for updates', { reason })

  try {
    await autoUpdater.checkForUpdates()
    return { checked: true, state: getUpdateState() }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Check failed'
    // electron-updater emits 'error' before rejecting; skip duplicate reducer.
    if (updateState.status === 'checking') {
      const failedAt = new Date().toISOString()
      updateStateBy((s) => reduceDesktopUpdateStateOnCheckFailure(s, message, failedAt))
    }
    mainLog.error('[auto-update] check failed:', message)
    return { checked: true, state: getUpdateState() }
  } finally {
    checkInFlight = false
  }
}

/**
 * Download the currently-available update (AC3). The renderer's sidebar pill
 * starts a download by calling this; progress is broadcast via state changes.
 */
export async function downloadUpdate(): Promise<DesktopUpdateActionResult> {
  if (!configured) return { accepted: false, completed: false, state: getUpdateState() }
  if (downloadInFlight) return { accepted: false, completed: false, state: getUpdateState() }
  const canDownload =
    updateState.status === 'available' ||
    (updateState.status === 'error' && updateState.availableVersion !== null)
  if (!canDownload) {
    return { accepted: false, completed: false, state: getUpdateState() }
  }

  downloadInFlight = true
  updateStateBy((s) => reduceDesktopUpdateStateOnDownloadStart(s))
  mainLog.info('[auto-update] downloading update')

  try {
    await autoUpdater.downloadUpdate()
    return { accepted: true, completed: true, state: getUpdateState() }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed'
    // electron-updater emits 'error' before rejecting; skip duplicate reducer.
    if (downloadInFlight) {
      updateStateBy((s) => reduceDesktopUpdateStateOnDownloadFailure(s, message))
    }
    mainLog.error('[auto-update] download failed:', message)
    return { accepted: true, completed: false, state: getUpdateState() }
  } finally {
    downloadInFlight = false
  }
}

/**
 * Switch update tracks (AC6). Persists the choice, reconfigures the updater,
 * resets stale state from the previous channel, and runs a check on the new
 * channel. Blocked while a check/download/install is active (AC7).
 */
export async function setUpdateChannel(
  channel: UpdateChannel,
): Promise<DesktopUpdateState> {
  const active = activeAction()
  if (active) {
    throw new Error('UPDATE_ACTION_IN_PROGRESS')
  }
  if (channel === updateState.channel) return getUpdateState()

  persistUpdateChannel(channel)
  applyAutoUpdaterChannel(channel)

  updateStateBy((s) => reduceDesktopUpdateStateOnChannelReset(s, channel))
  mainLog.info('[auto-update] switched update track', { channel })

  // Immediately check the new channel. Allow a one-time downgrade so a stable
  // build that switched to nightly can pick up a lower nightly version, matching
  // kata-code's channel-change semantics.
  const previousAllowDowngrade = autoUpdater.allowDowngrade
  autoUpdater.allowDowngrade = true
  try {
    await checkForUpdate('channel-change')
  } finally {
    autoUpdater.allowDowngrade = previousAllowDowngrade
  }
  return getUpdateState()
}

/**
 * Install the downloaded update and restart (AC4). Prompts handled by the
 * renderer before calling this; the pre-update window-state hook is run while
 * windows still exist.
 */
export async function installUpdate(): Promise<DesktopUpdateActionResult> {
  if (quitting) return { accepted: false, completed: false, state: getUpdateState() }
  if (!configured) return { accepted: false, completed: false, state: getUpdateState() }
  if (installInFlight) return { accepted: false, completed: false, state: getUpdateState() }
  if (updateState.status !== 'downloaded') {
    mainLog.warn('[auto-update] install requested but no update downloaded')
    return { accepted: false, completed: false, state: getUpdateState() }
  }

  installInFlight = true
  __isUpdating = true

  // Diagnostic correlation with before-quit's [update-flow] log. If these
  // window counts diverge, electron-updater is destroying windows between
  // here and before-quit firing.
  mainLog.info('[update-flow] installUpdate pre-quit', {
    electronWindowCount: BrowserWindow.getAllWindows().length,
    status: updateState.status,
    downloadedVersion: updateState.downloadedVersion,
  })

  try {
    beforeUpdateQuitHook?.()
  } catch (err) {
    mainLog.error('[auto-update] beforeUpdateQuit hook failed:', err)
  }

  try {
    // isSilent=false shows the installer UI on Windows if needed (fallback);
    // isForceRunAfter=true ensures the app relaunches after install.
    autoUpdater.quitAndInstall(false, true)
    return { accepted: true, completed: false, state: getUpdateState() }
  } catch (error) {
    installInFlight = false
    __isUpdating = false
    const message = error instanceof Error ? error.message : 'Install failed'
    updateStateBy((s) => reduceDesktopUpdateStateOnInstallFailure(s, message))
    mainLog.error('[auto-update] quitAndInstall failed:', message)
    return { accepted: true, completed: false, state: getUpdateState() }
  }
}

/**
 * Path to the updater diagnostics log file, exposed to Settings (AC9).
 */
export function getUpdateLogPath(): string | null {
  try {
    // electron-log resolves the active file transport path.
    const file = log.transports?.file?.getFile?.()
    return file?.path ?? null
  } catch {
    return null
  }
}
