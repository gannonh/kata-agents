/**
 * Mutation lock keyed by Git common directory.
 *
 * Linked worktrees share one Git common directory, so concurrent Kata-issued
 * mutations can race on shared Git metadata. This serializes mutations per
 * common directory while allowing read-only status/diff operations to run
 * concurrently (they simply don't acquire the lock).
 */

import { resolve as resolvePath } from 'node:path'

export class MutationLock {
  private chains = new Map<string, Promise<unknown>>()

  /**
   * Run `fn` while holding the lock for `gitCommonDir`. Calls for the same
   * common directory run strictly one-at-a-time in call order; calls for
   * different common directories run concurrently.
   */
  async withLock<T>(gitCommonDir: string, fn: () => Promise<T>): Promise<T> {
    const key = resolvePath(gitCommonDir)
    const prev = this.chains.get(key) ?? Promise.resolve()
    // Chain onto the previous op; swallow its result/rejection so one failure
    // doesn't poison subsequent queued operations.
    const run = prev.then(() => fn(), () => fn())
    // Keep the chain alive but non-rejecting for the next queuer.
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    try {
      return await run
    } finally {
      // Clean up when this was the tail of the chain.
      if (this.chains.get(key) === undefined) this.chains.delete(key)
    }
  }
}
