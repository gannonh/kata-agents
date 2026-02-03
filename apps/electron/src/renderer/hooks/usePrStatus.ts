/**
 * usePrStatus - Hook for PR status with focus-aware polling
 *
 * Provides PR information for the current working directory with:
 * - Initial fetch on mount
 * - Refresh on branch change
 * - Refresh on window focus
 * - Periodic polling (5 minutes) when window is focused
 *
 * Polling pauses when window is unfocused to save battery/resources.
 *
 * Usage:
 *   const { prInfo, isLoading, refresh } = usePrStatus(workingDirectory, currentBranch)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PrInfo } from '../../shared/types'

// Poll every 5 minutes when window is focused
const PR_POLL_INTERVAL_MS = 5 * 60 * 1000

interface UsePrStatusResult {
  /** PR info for current branch, null if no PR or error */
  prInfo: PrInfo | null
  /** True if PR status is being fetched */
  isLoading: boolean
  /** Manually refresh PR status */
  refresh: () => Promise<void>
}

/**
 * Hook to access PR status for a working directory.
 * Automatically polls when window is focused.
 *
 * @param workingDirectory - Absolute path to working directory (git repo)
 * @param currentBranch - Current branch name (triggers refresh on change)
 * @returns PR info, loading state, and refresh function
 */
export function usePrStatus(
  workingDirectory: string | undefined,
  currentBranch: string | null
): UsePrStatusResult {
  const [prInfo, setPrInfo] = useState<PrInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isFocused, setIsFocused] = useState(true)
  const lastBranchRef = useRef<string | null>(null)

  // Track window focus state
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowFocusChange?.((focused) => {
      setIsFocused(focused)
    })
    return unsubscribe
  }, [])

  // Fetch PR status
  const fetchPrStatus = useCallback(async () => {
    if (!workingDirectory) {
      setPrInfo(null)
      return
    }

    setIsLoading(true)
    try {
      const info = await window.electronAPI?.getPrStatus?.(workingDirectory)
      setPrInfo(info ?? null)
    } catch (error) {
      console.error('[usePrStatus] Fetch failed:', error)
      setPrInfo(null)
    } finally {
      setIsLoading(false)
    }
  }, [workingDirectory])

  // Initial fetch on mount or working directory change
  useEffect(() => {
    fetchPrStatus()
  }, [fetchPrStatus])

  // Refresh on branch change
  useEffect(() => {
    // Skip initial mount (lastBranchRef is null)
    if (lastBranchRef.current !== null && currentBranch !== lastBranchRef.current) {
      fetchPrStatus()
    }
    lastBranchRef.current = currentBranch
  }, [currentBranch, fetchPrStatus])

  // Refresh on window focus (LIVE-03 related - keep PR fresh)
  useEffect(() => {
    if (isFocused && workingDirectory) {
      fetchPrStatus()
    }
  }, [isFocused, workingDirectory, fetchPrStatus])

  // Periodic polling when window is focused (LIVE-02)
  useEffect(() => {
    if (!isFocused || !workingDirectory) {
      return // Don't poll when unfocused or no working directory
    }

    const interval = setInterval(() => {
      fetchPrStatus()
    }, PR_POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [isFocused, workingDirectory, fetchPrStatus])

  return {
    prInfo,
    isLoading,
    refresh: fetchPrStatus,
  }
}
