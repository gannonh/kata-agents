/**
 * Renderer-side pending diff-line comment store for the Changes review flow.
 *
 * Pending comments are scoped to a session and survive Changes-panel close for
 * the lifetime of the app run (spec: AC11). They are cleared only after the
 * batched feedback message is successfully submitted. The pure model
 * (create/reconcile/serialize) lives in `@kata-sh/shared/git`; this module owns
 * the live store and the mutation actions the UI dispatches.
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import {
  reconcileStaleForPath as reconcilePure,
  reconcileCommentsForDiff,
  clearStaleComments,
  type CommentDiffView,
} from '@kata-sh/shared/git'
import type { GitPendingComment } from '@kata-sh/shared/protocol'
import { appStore } from './store'

/** All pending comments across every session for the current app run. */
export const pendingCommentsAtom = atom<GitPendingComment[]>([])

/** Read-only, memoized per-session view of the pending comments. */
export const sessionPendingCommentsAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(pendingCommentsAtom).filter((c) => c.sessionId === sessionId)),
)

function update(mutator: (comments: GitPendingComment[]) => GitPendingComment[]): void {
  appStore.set(pendingCommentsAtom, mutator(appStore.get(pendingCommentsAtom)))
}

/** Append a new pending comment. */
export function addPendingComment(comment: GitPendingComment): void {
  update((comments) => [...comments, comment])
}

/** Update the text of an existing pending comment. */
export function updatePendingCommentText(id: string, text: string): void {
  update((comments) =>
    comments.map((c) => (c.id === id ? { ...c, text: text.trim() } : c)),
  )
}

/** Remove a single pending comment. */
export function removePendingComment(id: string): void {
  update((comments) => comments.filter((c) => c.id !== id))
}

/** Clear every pending comment for a session (after a successful send). */
export function clearSessionComments(sessionId: string): void {
  update((comments) => comments.filter((c) => c.sessionId !== sessionId))
}

/** Read a synchronous snapshot of a session's pending comments. */
export function getSessionComments(sessionId: string): GitPendingComment[] {
  return appStore
    .get(pendingCommentsAtom)
    .filter((c) => c.sessionId === sessionId)
}

/** Remove a session's stale comments (the "clear stale" review action, AC11). */
export function clearStaleSessionComments(sessionId: string): void {
  update((comments) => {
    const scoped = comments.filter((c) => c.sessionId === sessionId)
    const kept = clearStaleComments(scoped)
    if (kept.length === scoped.length) return comments
    const keptIds = new Set(kept.map((c) => c.id))
    return comments.filter((c) => c.sessionId !== sessionId || keptIds.has(c.id))
  })
}

/**
 * Reconcile a session's comments on a single path against a freshly-fetched
 * diff: auto-drop comments whose anchored line no longer exists (or whose path
 * is now clean), and mark still-present comments stale when the fingerprint
 * changed (AC11 — review before sending).
 */
export function reconcileSessionPathForDiff(
  sessionId: string,
  path: string,
  diff: CommentDiffView,
): void {
  update((comments) => {
    const scoped = comments.filter((c) => c.sessionId === sessionId)
    const reconciled = reconcileCommentsForDiff(scoped, path, diff)
    if (reconciled === scoped) return comments
    const byId = new Map(reconciled.map((c) => [c.id, c]))
    // Preserve ordering; drop scoped comments no longer present, apply updates.
    const result: GitPendingComment[] = []
    for (const c of comments) {
      if (c.sessionId !== sessionId) {
        result.push(c)
        continue
      }
      const updated = byId.get(c.id)
      if (updated) result.push(updated)
      // else: this comment was auto-dropped by reconciliation.
    }
    return result
  })
}

/**
 * Re-evaluate staleness for a session's comments on a single path against the
 * latest diff fingerprint. Comments whose captured fingerprint no longer
 * matches become stale and must be reviewed before sending (AC11).
 */
export function reconcileStaleForSessionPath(
  sessionId: string,
  path: string,
  fingerprint: string,
): void {
  update((comments) => {
    const scoped = comments.filter((c) => c.sessionId === sessionId)
    const reconciled = reconcilePure(scoped, path, fingerprint)
    if (reconciled === scoped) return comments
    const byId = new Map(reconciled.map((c) => [c.id, c]))
    return comments.map((c) => byId.get(c.id) ?? c)
  })
}
