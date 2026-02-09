/**
 * Daemon State Atom
 *
 * Holds the current daemon process state, updated via IPC from main process.
 * Used by DaemonStatusIndicator and any component that needs daemon awareness.
 */

import { atom } from 'jotai'
import type { DaemonManagerState } from '../../shared/types'

/**
 * Current daemon process state.
 * Updated via window.electronAPI.onDaemonStateChanged() subscription in AppShell.
 */
export const daemonStateAtom = atom<DaemonManagerState>('stopped')
