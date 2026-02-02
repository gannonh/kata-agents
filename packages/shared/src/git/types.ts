/**
 * Git state for a workspace directory.
 * All fields are nullable to handle non-git directories gracefully.
 */
export interface GitState {
  /** Current branch name, or null if detached HEAD or not a git repo */
  branch: string | null
  /** True if directory is inside a git repository */
  isRepo: boolean
  /** True if in detached HEAD state (e.g., during rebase or checkout of commit) */
  isDetached: boolean
  /** Short commit hash when in detached HEAD state */
  detachedHead: string | null
}
