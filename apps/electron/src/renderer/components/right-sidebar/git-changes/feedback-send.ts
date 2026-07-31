/**
 * Orchestrates the Changes "send feedback" flow so the React component stays a
 * thin view. Extracted for direct unit testing of the acceptance-critical rules
 * (AC11):
 *
 * - Before sending, refresh the diff for every path that has a comment so a
 *   changed diff marks affected comments stale and vanished lines auto-drop.
 * - When any stale comment remains after that refresh, sending is blocked and
 *   the caller must let the user review (Clear stale) first.
 * - The pending comments are cleared ONLY after the message is successfully
 *   submitted; a failed submission retains them for retry.
 */

import type { GitFileDiff } from '@kata-sh/shared/protocol'
import { summarizePendingComments, serializeFeedback } from '@kata-sh/shared/git'
import {
  getSessionComments,
  reconcileSessionPathForDiff,
  clearSessionComments,
} from '@/atoms/git-comments'

export interface FeedbackSendDeps {
  /** Fetch the latest bounded diff for a repository-relative path. */
  getDiff: (sessionId: string, path: string) => Promise<GitFileDiff>
  /** Submit the serialized feedback; resolves true only on successful submission. */
  send: (sessionId: string, message: string) => Promise<boolean>
}

export type FeedbackSendResult =
  | 'sent' // submitted successfully; comments cleared
  | 'requires-review' // stale comments remain; nothing sent
  | 'empty' // no comments to send
  | 'failed' // submission failed; comments retained

/** Run the review-refresh → gate → send → clear pipeline for a session. */
export async function submitPendingFeedback(
  sessionId: string,
  deps: FeedbackSendDeps,
): Promise<FeedbackSendResult> {
  // Refresh every affected diff so staleness/auto-drop reflect the latest state.
  const paths = Array.from(new Set(getSessionComments(sessionId).map((c) => c.path)))
  await Promise.all(
    paths.map(async (path) => {
      try {
        const fresh = await deps.getDiff(sessionId, path)
        reconcileSessionPathForDiff(sessionId, path, fresh)
      } catch {
        /* keep the comment as-is when its diff can't be refreshed */
      }
    }),
  )

  const latest = getSessionComments(sessionId)
  const summary = summarizePendingComments(latest)
  if (summary.pendingCount === 0) return 'empty'
  // A changed diff marks comments stale and requires review before sending.
  if (!summary.canSend) return 'requires-review'

  const message = serializeFeedback(latest)
  const ok = await deps.send(sessionId, message)
  if (!ok) return 'failed'
  clearSessionComments(sessionId)
  return 'sent'
}
