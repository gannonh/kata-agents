/**
 * useGitStatus - Hook for accessing workspace git status
 *
 * Provides git status for the current workspace with automatic fetching.
 * Handles workspace switching by re-fetching when workspaceId changes.
 *
 * Usage:
 *   const { gitState, isLoading, refresh } = useGitStatus(workspaceId, workspaceRootPath)
 */

import { useEffect, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  gitStateForWorkspaceAtom,
  gitLoadingForWorkspaceAtom,
  setGitStateAtom,
  setGitLoadingAtom,
} from '@/atoms/git'
import type { GitState } from '../../shared/types'

interface UseGitStatusResult {
  /** Current git state for the workspace, null if not yet fetched or not a git repo */
  gitState: GitState | null
  /** True if git status is being fetched */
  isLoading: boolean
  /** Manually refresh git status */
  refresh: () => Promise<void>
}

/**
 * Hook to access git status for a workspace.
 *
 * @param workspaceId - Current workspace ID
 * @param workspaceRootPath - Absolute path to workspace root directory
 * @returns Git state, loading state, and refresh function
 */
export function useGitStatus(
  workspaceId: string | null,
  workspaceRootPath: string | null
): UseGitStatusResult {
  const getGitState = useAtomValue(gitStateForWorkspaceAtom)
  const getLoading = useAtomValue(gitLoadingForWorkspaceAtom)
  const setGitState = useSetAtom(setGitStateAtom)
  const setLoading = useSetAtom(setGitLoadingAtom)

  const gitState = workspaceId ? getGitState(workspaceId) : null
  const isLoading = workspaceId ? getLoading(workspaceId) : false

  const refresh = useCallback(async () => {
    if (!workspaceId || !workspaceRootPath) return

    // Set loading state
    setLoading({ workspaceId, loading: true })

    try {
      // Fetch git status via IPC
      const state = await window.electronAPI.getGitStatus(workspaceRootPath)
      setGitState({ workspaceId, state })
    } catch (error) {
      console.error('[useGitStatus] Failed to fetch git status:', error)
      // Set default non-repo state on error
      setGitState({
        workspaceId,
        state: {
          branch: null,
          isRepo: false,
          isDetached: false,
          detachedHead: null,
        },
      })
    } finally {
      setLoading({ workspaceId, loading: false })
    }
  }, [workspaceId, workspaceRootPath, setGitState, setLoading])

  // Fetch git status when workspace changes
  useEffect(() => {
    if (workspaceId && workspaceRootPath) {
      // Only fetch if we don't have state yet for this workspace
      const existingState = getGitState(workspaceId)
      if (!existingState) {
        refresh()
      }
    }
  }, [workspaceId, workspaceRootPath, refresh, getGitState])

  return {
    gitState,
    isLoading,
    refresh,
  }
}
