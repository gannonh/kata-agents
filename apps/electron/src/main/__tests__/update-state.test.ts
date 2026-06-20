import { describe, expect, test } from 'bun:test'
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
  type DesktopUpdateState,
} from '../update-state'

// Pure reducer tests for the desktop update state machine (AC12).
//
// Why this matters: the sidebar pill and Settings button both derive their
// label/action from `status`, `availableVersion`, and `downloadedVersion`. A
// wrong transition (e.g. a failed download clearing `availableVersion`) would
// hide the retry button at exactly the moment the user needs it. Each test
// pins a transition that the UI or the controller depends on.

const CURRENT_VERSION = '0.10.3'
const CHECKED_AT = '2026-06-20T12:00:00.000Z'

function initialState(channel: 'latest' | 'nightly' = 'latest'): DesktopUpdateState {
  return createInitialDesktopUpdateState(CURRENT_VERSION, channel)
}

describe('createInitialDesktopUpdateState', () => {
  test('disabled by default with no update metadata', () => {
    const state = initialState()
    expect(state.enabled).toBe(false)
    expect(state.status).toBe('disabled')
    expect(state.channel).toBe('latest')
    expect(state.currentVersion).toBe(CURRENT_VERSION)
    expect(state.availableVersion).toBeNull()
    expect(state.downloadedVersion).toBeNull()
    expect(state.downloadPercent).toBeNull()
    expect(state.checkedAt).toBeNull()
    expect(state.message).toBeNull()
    expect(state.errorContext).toBeNull()
    expect(state.canRetry).toBe(false)
  })

  test('honors the requested channel', () => {
    expect(createInitialDesktopUpdateState(CURRENT_VERSION, 'nightly').channel).toBe('nightly')
  })
})

describe('reduceDesktopUpdateStateOnCheckStart', () => {
  test('moves to checking and clears prior error/progress metadata', () => {
    // Start from an error state so we can prove the reducer clears it; a stale
    // error message would otherwise linger on the sidebar pill during a retry.
    const errored: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'error',
      message: 'old failure',
      downloadPercent: 42,
      errorContext: 'check',
      canRetry: true,
    }

    const next = reduceDesktopUpdateStateOnCheckStart(errored, CHECKED_AT)

    expect(next.status).toBe('checking')
    expect(next.checkedAt).toBe(CHECKED_AT)
    expect(next.message).toBeNull()
    expect(next.downloadPercent).toBeNull()
    expect(next.errorContext).toBeNull()
    expect(next.canRetry).toBe(false)
    // Non-transitioned fields are preserved (AC6: channel/currentVersion stable).
    expect(next.channel).toBe(errored.channel)
    expect(next.currentVersion).toBe(errored.currentVersion)
  })
})

describe('reduceDesktopUpdateStateOnCheckFailure', () => {
  test('marks an error with check context and allows retry', () => {
    const next = reduceDesktopUpdateStateOnCheckFailure(initialState(), 'network down', CHECKED_AT)

    expect(next.status).toBe('error')
    expect(next.message).toBe('network down')
    expect(next.checkedAt).toBe(CHECKED_AT)
    expect(next.errorContext).toBe('check')
    expect(next.canRetry).toBe(true)
    expect(next.downloadPercent).toBeNull()
  })
})

describe('reduceDesktopUpdateStateOnUpdateAvailable', () => {
  test('exposes the available version and clears prior download metadata', () => {
    // Coming from a downloaded state (e.g. switched channel): the old
    // downloadedVersion must be cleared so the pill no longer offers "restart".
    const downloaded: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'downloaded',
      downloadedVersion: '0.10.3',
      downloadPercent: 100,
    }

    const next = reduceDesktopUpdateStateOnUpdateAvailable(downloaded, '0.10.4', CHECKED_AT)

    expect(next.status).toBe('available')
    expect(next.availableVersion).toBe('0.10.4')
    expect(next.downloadedVersion).toBeNull()
    expect(next.downloadPercent).toBeNull()
    expect(next.checkedAt).toBe(CHECKED_AT)
    expect(next.message).toBeNull()
    expect(next.errorContext).toBeNull()
    expect(next.canRetry).toBe(false)
  })
})

describe('reduceDesktopUpdateStateOnNoUpdate', () => {
  test('moves to up-to-date and clears any prior available version', () => {
    const available: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'available',
      availableVersion: '0.10.4',
    }

    const next = reduceDesktopUpdateStateOnNoUpdate(available, CHECKED_AT)

    expect(next.status).toBe('up-to-date')
    expect(next.availableVersion).toBeNull()
    expect(next.downloadedVersion).toBeNull()
    expect(next.downloadPercent).toBeNull()
    expect(next.checkedAt).toBe(CHECKED_AT)
    expect(next.canRetry).toBe(false)
  })
})

describe('reduceDesktopUpdateStateOnDownloadStart', () => {
  test('begins downloading at 0% and clears errors', () => {
    const available: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'available',
      availableVersion: '0.10.4',
      message: 'prior download error',
      errorContext: 'download',
    }

    const next = reduceDesktopUpdateStateOnDownloadStart(available)

    expect(next.status).toBe('downloading')
    expect(next.downloadPercent).toBe(0)
    expect(next.message).toBeNull()
    expect(next.errorContext).toBeNull()
    expect(next.canRetry).toBe(false)
    // availableVersion is preserved so the pill can show what is downloading.
    expect(next.availableVersion).toBe('0.10.4')
  })
})

describe('reduceDesktopUpdateStateOnDownloadProgress', () => {
  test('updates percent and forces downloading status', () => {
    const next = reduceDesktopUpdateStateOnDownloadProgress(
      { ...initialState(), enabled: true, status: 'downloading', downloadPercent: 10 },
      55,
    )

    expect(next.status).toBe('downloading')
    expect(next.downloadPercent).toBe(55)
    expect(next.message).toBeNull()
    expect(next.errorContext).toBeNull()
  })
})

describe('reduceDesktopUpdateStateOnDownloadFailure', () => {
  test('returns to available when a version is known, keeping retry', () => {
    // A failed download must not lose the available version: the sidebar pill
    // needs it to offer "Update available" again (AC3 retry path).
    const downloading: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'downloading',
      availableVersion: '0.10.4',
      downloadPercent: 30,
    }

    const next = reduceDesktopUpdateStateOnDownloadFailure(downloading, 'checksum mismatch')

    expect(next.status).toBe('available')
    expect(next.availableVersion).toBe('0.10.4')
    expect(next.message).toBe('checksum mismatch')
    expect(next.downloadPercent).toBeNull()
    expect(next.errorContext).toBe('download')
    expect(next.canRetry).toBe(true)
  })

  test('falls back to error when no available version is known', () => {
    const next = reduceDesktopUpdateStateOnDownloadFailure(
      { ...initialState(), enabled: true, status: 'downloading' },
      'unknown error',
    )

    expect(next.status).toBe('error')
    expect(next.canRetry).toBe(false)
  })
})

describe('reduceDesktopUpdateStateOnDownloadComplete', () => {
  test('moves to downloaded at 100% with retry allowed (for reinstall)', () => {
    const next = reduceDesktopUpdateStateOnDownloadComplete(
      { ...initialState(), enabled: true, status: 'downloading', availableVersion: '0.10.4' },
      '0.10.4',
    )

    expect(next.status).toBe('downloaded')
    expect(next.availableVersion).toBe('0.10.4')
    expect(next.downloadedVersion).toBe('0.10.4')
    expect(next.downloadPercent).toBe(100)
    expect(next.canRetry).toBe(true)
  })
})

describe('reduceDesktopUpdateStateOnInstallFailure', () => {
  test('stays downloaded with install error context so restart can be retried', () => {
    // An install failure must keep downloadedVersion: the pill should still
    // offer "Restart to update" so the user can retry (AC4 retry path).
    const downloaded: DesktopUpdateState = {
      ...initialState(),
      enabled: true,
      status: 'downloaded',
      downloadedVersion: '0.10.4',
    }

    const next = reduceDesktopUpdateStateOnInstallFailure(downloaded, 'permission denied')

    expect(next.status).toBe('downloaded')
    expect(next.downloadedVersion).toBe('0.10.4')
    expect(next.message).toBe('permission denied')
    expect(next.errorContext).toBe('install')
    expect(next.canRetry).toBe(true)
  })
})

describe('reduceDesktopUpdateStateOnChannelReset', () => {
  test('clears all update metadata when switching tracks (AC6 reset)', () => {
    // Switching Stable -> Nightly must not leave a stale "downloaded" state
    // from the previous channel: the user would see "Restart to update" for
    // an update that belongs to the wrong feed.
    const downloaded: DesktopUpdateState = {
      ...initialState('latest'),
      enabled: true,
      status: 'downloaded',
      availableVersion: '0.10.4',
      downloadedVersion: '0.10.4',
      downloadPercent: 100,
      message: 'old',
      errorContext: 'install',
      canRetry: true,
    }

    const next = reduceDesktopUpdateStateOnChannelReset(downloaded, 'nightly')

    expect(next.channel).toBe('nightly')
    expect(next.status).toBe('idle')
    expect(next.availableVersion).toBeNull()
    expect(next.downloadedVersion).toBeNull()
    expect(next.downloadPercent).toBeNull()
    expect(next.message).toBeNull()
    expect(next.errorContext).toBeNull()
    expect(next.canRetry).toBe(false)
    // currentVersion and enabled are preserved (not an enable/disable event).
    expect(next.currentVersion).toBe(CURRENT_VERSION)
    expect(next.enabled).toBe(true)
  })
})
