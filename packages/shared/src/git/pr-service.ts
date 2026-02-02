import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { PrInfo } from './types'

const execFileAsync = promisify(execFile)

/**
 * Get PR status for the current branch in a directory.
 * Uses gh CLI to fetch PR information.
 * Returns null if:
 * - Not a git repository
 * - No PR exists for the current branch
 * - gh CLI is not installed
 * - gh CLI is not authenticated
 * - Any other error (graceful degradation)
 *
 * IMPORTANT: This function is async-only to prevent main process blocking.
 */
export async function getPrStatus(dirPath: string): Promise<PrInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'number,title,state,isDraft,url'],
      {
        cwd: dirPath,
        timeout: 5000, // 5 second timeout
      }
    )

    // Parse the JSON response
    const data = JSON.parse(stdout.trim())

    return {
      number: data.number,
      title: data.title,
      state: data.state,
      isDraft: data.isDraft,
      url: data.url,
    }
  } catch (error) {
    // Log for debugging if enabled
    if (process.env.DEBUG_GIT) {
      console.debug('[PrService] getPrStatus failed:', error)
    }
    // Graceful degradation - return null for any error
    return null
  }
}
