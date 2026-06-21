/**
 * Desktop update state hook.
 *
 * Subscribes to the main-process update controller's broadcast
 * `DesktopUpdateState` and exposes it plus pure helpers for the sidebar pill
 * and Settings action button. Mirrors kata-code's `useDesktopUpdateState` +
 * `desktopUpdate.logic`, retargeted to Kata Agents' ElectronAPI.
 *
 * Manual-download parity (AC1, AC3, AC4): the app does NOT auto-download.
 * `Update available` starts the download; `Restart to update` installs after a
 * confirmation dialog.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { DesktopUpdateState } from '../../shared/types'

export type UpdateButtonAction = 'download' | 'install' | 'none'

export interface UseDesktopUpdateResult {
  /** Current update state from the controller (null before first hydration). */
  state: DesktopUpdateState | null
  /** Whether the sidebar/settings should surface an action button. */
  showButton: boolean
  /** Whether the action button should be disabled. */
  buttonDisabled: boolean
  /** Resolved click action for the current state. */
  action: UpdateButtonAction
  /** Start a download (AC3). */
  downloadUpdate: () => Promise<void>
  /** Install the downloaded update (AC4). The renderer shows a confirm first. */
  installUpdate: () => Promise<void>
  /** Manually check for updates (Settings Check Now / sidebar fallback). */
  checkForUpdates: () => Promise<void>
}

/**
 * Resolved click action for the current state. Drives the sidebar pill label
 * and the Settings button text. Kept pure (exported) so it is unit-testable.
 */
export function resolveUpdateButtonAction(state: DesktopUpdateState | null): UpdateButtonAction {
  if (!state) return 'none'
  if (state.downloadedVersion) return 'install'
  if (state.status === 'available') return 'download'
  if (state.status === 'error' && state.errorContext === 'download' && state.availableVersion) {
    return 'download'
  }
  return 'none'
}

/**
 * Whether the sidebar/settings should show the action button at all (AC2).
 * Hidden when updates are disabled, idle, up to date, or in a state with no
 * actionable step.
 */
export function shouldShowUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false
  if (state.status === 'downloading') return true
  return resolveUpdateButtonAction(state) !== 'none'
}

export function isUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === 'downloading'
}

export function useDesktopUpdate(): UseDesktopUpdateResult {
  const { t } = useTranslation()
  const [state, setState] = useState<DesktopUpdateState | null>(null)

  // Hydrate on mount and subscribe to state broadcasts.
  useEffect(() => {
    let disposed = false
    window.electronAPI.getUpdateState().then((initial) => {
      if (!disposed) setState(initial)
    })
    const unsubscribe = window.electronAPI.onUpdateState((next) => {
      setState(next)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const action = resolveUpdateButtonAction(state)
  const showButton = shouldShowUpdateButton(state)
  const buttonDisabled = isUpdateButtonDisabled(state)

  const downloadUpdate = useCallback(async () => {
    try {
      const result = await window.electronAPI.downloadUpdate()
      if (!result.completed && result.state?.message) {
        toast.error(t('update.downloadFailedTitle'), {
          description: result.state.message,
        })
      } else if (result.completed) {
        toast.success(t('update.downloadedTitle'), {
          description: t('update.downloadedRestartDescription'),
        })
      }
    } catch (error) {
      toast.error(t('update.downloadFailedTitle'), {
        description: error instanceof Error ? error.message : t('update.unknownError'),
      })
    }
  }, [t])

  const installUpdate = useCallback(async () => {
    const version = state?.downloadedVersion ?? state?.availableVersion
    const confirmed = window.confirm(
      t('update.installConfirm', { version: version ?? '' }),
    )
    if (!confirmed) return
    try {
      await window.electronAPI.installUpdate()
    } catch (error) {
      toast.error(t('update.installFailedTitle'), {
        description: error instanceof Error ? error.message : t('update.unknownError'),
      })
    }
  }, [state, t])

  const checkForUpdates = useCallback(async () => {
    try {
      const result = await window.electronAPI.checkForUpdates()
      if (!result.checked) {
        // Check was suppressed (e.g. an action is in flight or updates disabled).
        return
      }
      if (result.state.status === 'up-to-date') {
        toast.success(t('update.upToDateTitle'), {
          description: t('update.upToDateDescription', { version: result.state.currentVersion }),
        })
      } else if (result.state.status === 'error') {
        toast.error(t('update.checkFailedTitle'), {
          description: result.state.message ?? t('update.unknownError'),
        })
      }
    } catch (error) {
      toast.error(t('update.checkFailedTitle'), {
        description: error instanceof Error ? error.message : t('update.unknownError'),
      })
    }
  }, [t])

  return {
    state,
    showButton,
    buttonDisabled,
    action,
    downloadUpdate,
    installUpdate,
    checkForUpdates,
  }
}

