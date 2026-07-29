/**
 * Pure diff-line comment model for the Changes review flow.
 *
 * These helpers are transport- and React-agnostic so they can be unit-tested in
 * isolation. The renderer owns the live pending-comment store; this module owns
 * the deterministic rules the acceptance criteria depend on:
 *
 * - anchoring a comment to an old/new diff line + fingerprint,
 * - marking comments stale when a path's diff fingerprint changes,
 * - serializing reviewed comments into one deterministic follow-up message.
 */

import type { GitCommentSide, GitPendingComment } from '../protocol/git'

export interface CreatePendingCommentInput {
  id: string
  sessionId: string
  path: string
  previousPath?: string
  side: GitCommentSide
  line: number
  text: string
  diffFingerprint: string
  context: string
  createdAt: number
}

/** Build a normalized pending comment (trims text/context, clears stale). */
export function createPendingComment(input: CreatePendingCommentInput): GitPendingComment {
  return {
    id: input.id,
    sessionId: input.sessionId,
    path: input.path,
    previousPath: input.previousPath,
    side: input.side,
    line: input.line,
    text: input.text.trim(),
    diffFingerprint: input.diffFingerprint,
    context: input.context,
    createdAt: input.createdAt,
    stale: false,
  }
}

/**
 * Re-evaluate staleness for the comments on a single path against the latest
 * diff fingerprint. A comment is stale when its captured fingerprint no longer
 * matches the current diff for that path (spec: changed diff marks affected
 * comments stale and requires review before sending).
 */
export function reconcileStaleForPath(
  comments: GitPendingComment[],
  path: string,
  currentFingerprint: string,
): GitPendingComment[] {
  let changed = false
  const next = comments.map((c) => {
    if (c.path !== path) return c
    const stale = c.diffFingerprint !== currentFingerprint
    if (stale === Boolean(c.stale)) return c
    changed = true
    return { ...c, stale }
  })
  return changed ? next : comments
}

/** True when any comment in the list is marked stale. */
export function hasStaleComments(comments: GitPendingComment[]): boolean {
  return comments.some((c) => c.stale)
}

/**
 * Derived UI state for the Send-feedback affordance. The spec requires that a
 * changed diff marks affected comments stale and blocks sending until they are
 * reviewed, and that sending is only possible when there is at least one
 * pending comment.
 */
export interface PendingCommentSummary {
  pendingCount: number
  staleCount: number
  /** True when there is at least one non-stale comment to send and none are stale. */
  canSend: boolean
  /** True when stale comments require review before sending. */
  requiresReview: boolean
}

/** Summarize a session's pending comments for the Send-feedback control. */
export function summarizePendingComments(comments: GitPendingComment[]): PendingCommentSummary {
  const pendingCount = comments.length
  const staleCount = comments.reduce((n, c) => (c.stale ? n + 1 : n), 0)
  const requiresReview = staleCount > 0
  return {
    pendingCount,
    staleCount,
    canSend: pendingCount > 0 && !requiresReview,
    requiresReview,
  }
}

/** Comments for a single session, filtering out any foreign session IDs. */
export function commentsForSession(
  comments: GitPendingComment[],
  sessionId: string,
): GitPendingComment[] {
  return comments.filter((c) => c.sessionId === sessionId)
}

/** Map a comment side to the human-facing side label used in the follow-up. */
export function sideLabel(side: GitCommentSide): 'old' | 'new' {
  return side === 'old' ? 'old' : 'new'
}

/**
 * Deterministic ordering for serialization: by path, then side (old before
 * new), then line, then creation time. Guarantees a stable follow-up message
 * regardless of comment insertion order.
 */
export function sortCommentsForSerialization(
  comments: GitPendingComment[],
): GitPendingComment[] {
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.side !== b.side) return a.side === 'old' ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.createdAt - b.createdAt
  })
}

export interface SerializeFeedbackOptions {
  /** Optional heading line; defaults to a generic review instruction. */
  heading?: string
}

const DEFAULT_HEADING =
  'Please address the following review comments on the current uncommitted changes:'

/**
 * Serialize reviewed comments into a single deterministic follow-up message.
 * The message is structured (path → per-line comments with side, line, context)
 * and stable across runs so the same review always produces the same text.
 */
export function serializeFeedback(
  comments: GitPendingComment[],
  options: SerializeFeedbackOptions = {},
): string {
  const heading = options.heading ?? DEFAULT_HEADING
  const sorted = sortCommentsForSerialization(comments)
  const lines: string[] = [heading, '']

  let currentPath: string | null = null
  for (const c of sorted) {
    if (c.path !== currentPath) {
      currentPath = c.path
      const rename = c.previousPath && c.previousPath !== c.path ? ` (renamed from ${c.previousPath})` : ''
      lines.push(`### ${c.path}${rename}`)
    }
    lines.push(`- [${sideLabel(c.side)} line ${c.line}] ${c.text}`)
    if (c.context.trim().length > 0) {
      lines.push(`  > ${c.context.trim()}`)
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}
