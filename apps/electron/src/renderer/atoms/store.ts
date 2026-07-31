/**
 * The renderer's single Jotai store.
 *
 * Most atoms are mutated through React hooks, while Git status and pending
 * review comments also receive imperative updates from IPC/event callbacks.
 * Exporting the store keeps those two paths on the same provider-backed state.
 */
import { createStore } from 'jotai'

export const appStore = createStore()
