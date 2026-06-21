import { describe, expect, test } from 'bun:test'
import {
  resolveUpdateButtonAction,
  shouldShowUpdateButton,
  isUpdateButtonDisabled,
} from '../useUpdateChecker'
import type { DesktopUpdateState } from '../../../shared/types'

// Renderer-side update action logic (AC12): the sidebar pill and Settings
// button derive their label/action from DesktopUpdateState. These tests pin the
// decisions the controller relies on (download vs install vs none, and when to
// hide the button entirely), and the no-auto-download contract — the action is
// resolved from state, never auto-triggered.

function state(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: 'idle',
    channel: 'latest',
    currentVersion: '0.10.3',
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  }
}

describe('resolveUpdateButtonAction', () => {
  test('download when an update is available (AC1/AC3: no auto-download — user clicks)', () => {
    expect(resolveUpdateButtonAction(state({ status: 'available', availableVersion: '0.10.4' }))).toBe('download')
  })

  test('install once a version is downloaded (AC4)', () => {
    expect(
      resolveUpdateButtonAction(state({ status: 'downloaded', downloadedVersion: '0.10.4' })),
    ).toBe('install')
  })

  test('retry download after a download failure that still knows the version', () => {
    expect(
      resolveUpdateButtonAction(
        state({ status: 'error', errorContext: 'download', availableVersion: '0.10.4', message: 'fail' }),
      ),
    ).toBe('download')
  })

  test('none when idle, checking, up-to-date, disabled, or downloading', () => {
    expect(resolveUpdateButtonAction(state())).toBe('none')
    expect(resolveUpdateButtonAction(state({ status: 'checking' }))).toBe('none')
    expect(resolveUpdateButtonAction(state({ status: 'up-to-date' }))).toBe('none')
    expect(resolveUpdateButtonAction(state({ enabled: false, status: 'disabled' }))).toBe('none')
    expect(
      resolveUpdateButtonAction(state({ status: 'downloading', downloadPercent: 50 })),
    ).toBe('none')
  })

  test('none when state null', () => {
    expect(resolveUpdateButtonAction(null)).toBe('none')
  })
})

describe('shouldShowUpdateButton', () => {
  test('hidden when disabled or null', () => {
    expect(shouldShowUpdateButton(null)).toBe(false)
    expect(shouldShowUpdateButton(state({ enabled: false, status: 'disabled' }))).toBe(false)
  })

  test('shown while downloading', () => {
    expect(shouldShowUpdateButton(state({ status: 'downloading', downloadPercent: 30 }))).toBe(true)
  })

  test('shown when an action is available', () => {
    expect(shouldShowUpdateButton(state({ status: 'available', availableVersion: '0.10.4' }))).toBe(true)
    expect(shouldShowUpdateButton(state({ status: 'downloaded', downloadedVersion: '0.10.4' }))).toBe(true)
  })

  test('hidden when idle / up-to-date', () => {
    expect(shouldShowUpdateButton(state())).toBe(false)
    expect(shouldShowUpdateButton(state({ status: 'up-to-date' }))).toBe(false)
  })
})

describe('isUpdateButtonDisabled', () => {
  test('disabled only while downloading', () => {
    expect(isUpdateButtonDisabled(state({ status: 'downloading' }))).toBe(true)
    expect(isUpdateButtonDisabled(state({ status: 'available' }))).toBe(false)
    expect(isUpdateButtonDisabled(null)).toBe(false)
  })
})

