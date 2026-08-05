/**
 * WorktreeSnapshotService — streaming binary capture, exact restore, and
 * permanent deletion of managed-worktree state.
 *
 * A snapshot captures the supported state of a managed checkout so removal can
 * never silently lose work:
 *
 * - staged projection (`git diff --cached --binary`) and unstaged projection
 *   (`git diff --binary`) as binary-safe patches — deletions, renames, binary
 *   changes, and modes are all preserved by Git's own patch format;
 * - untracked regular files and symlink NODES (link text, never dereferenced),
 *   plus regular files selected by `.worktreeinclude`;
 * - a hidden `refs/kata/worktree-snapshots/<snapshot-id>` ref CAS-created only
 *   when absent, pinning the captured HEAD.
 *
 * Capture excludes `.git`, ignored files outside `.worktreeinclude`, submodule
 * working trees, and unsupported sparse/unmerged/operation state. Unsupported
 * or unreadable state blocks deletion rather than producing a partial
 * snapshot. Payloads are preflight-bounded (10,000 files, 100 MiB total),
 * hashed component by component, and atomically published only after every
 * hash verifies.
 *
 * Restore revalidates repository identity, payload hashes, hidden-ref
 * ownership, branch/worktree occupancy, and snapshot version; recreates only
 * an absent branch at the captured OID (never force-resets a differently
 * advanced branch); restores state byte-for-byte and mode-for-mode; and only
 * then may the lifecycle service remove the payload and CAS-delete the ref.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, isAbsolute } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type {
  ManagedWorktreeRecordV2,
  ManagedWorktreeSnapshotMeta,
} from '@kata-sh/shared/protocol'
import { runGit, runGitBuffer, splitNul } from './command-runner'
import { listWorktreeIncludeFiles } from './worktree-include'

export const WORKTREE_SNAPSHOT_SCHEMA_VERSION = 1
export const WORKTREE_SNAPSHOT_REF_PREFIX = 'refs/kata/worktree-snapshots/'
export const WORKTREE_SNAPSHOT_MAX_FILES = 10_000
export const WORKTREE_SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024 // 100 MiB

export type WorktreeSnapshotErrorCode =
  | 'SNAPSHOT_LIMIT'
  | 'SNAPSHOT_UNSUPPORTED_STATE'
  | 'SNAPSHOT_CAPTURE_FAILED'
  | 'SNAPSHOT_VERIFY_FAILED'
  | 'SNAPSHOT_REF_CONFLICT'
  | 'SNAPSHOT_RESTORE_FAILED'
  | 'SNAPSHOT_PAYLOAD_MISSING'
  | 'SNAPSHOT_PATH_UNSAFE'
  | 'SNAPSHOT_REPOSITORY_MISMATCH'

export class WorktreeSnapshotError extends Error {
  readonly code: WorktreeSnapshotErrorCode
  constructor(code: WorktreeSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'WorktreeSnapshotError'
    this.code = code
  }
}

/** One captured untracked/included file or symlink node. */
export interface SnapshotFileEntry {
  /** Repository-relative POSIX path. */
  path: string
  /** Git mode, e.g. 100644, 100755, or 120000 (symlink). */
  mode: string
  size: number
  /** SHA-256 of the content (regular files only). */
  sha256: string
  /** Payload-relative stored file, null for symlink nodes. */
  stored: string | null
  /** Symlink target text; never dereferenced. */
  linkText?: string
}

/** Versioned snapshot manifest. */
export interface WorktreeSnapshotManifest {
  schemaVersion: 1
  snapshotId: string
  branch: string
  headOid: string
  baseRef: string | null
  capturedAt: number
  stagedPatch: { file: 'staged.patch'; sha256: string; bytes: number }
  unstagedPatch: { file: 'unstaged.patch'; sha256: string; bytes: number }
  files: SnapshotFileEntry[]
  fileCount: number
  totalBytes: number
}

export interface SnapshotCaptureInput {
  record: ManagedWorktreeRecordV2
  /** Final post-quiescence fingerprint recorded immediately before release. */
  finalFingerprint: string
  /** Server-issued preview fingerprint the removal was confirmed against. */
  previewFingerprint: string
  policyVersion: number
}

export interface SnapshotCaptureResult {
  meta: ManagedWorktreeSnapshotMeta
  manifest: WorktreeSnapshotManifest
}

export interface SnapshotRestoreInput {
  record: ManagedWorktreeRecordV2
  meta: ManagedWorktreeSnapshotMeta
  /** Destination checkout path (must be absent and safe). */
  checkoutPath: string
}

export interface SnapshotRestoreResult {
  checkoutPath: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashFile(path: string): string {
  return sha256(readFileSync(path))
}

function isHexOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)
}

/** True when `child` is contained within `parent` (both resolved). */
function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Git mode → permission bits. */
function modePermissions(mode: string): number {
  const match = /^(\d{6})$/.exec(mode)
  if (!match) return 0o644
  return parseInt(mode.slice(-3), 8)
}

export interface SnapshotLimits {
  maxFiles: number
  maxBytes: number
}

export class WorktreeSnapshotService {
  private readonly snapshotsRoot: string
  private readonly limits: SnapshotLimits

  constructor(
    snapshotsRoot: string,
    limits: Partial<SnapshotLimits> = {},
  ) {
    this.snapshotsRoot = resolvePath(snapshotsRoot)
    this.limits = {
      maxFiles: limits.maxFiles ?? WORKTREE_SNAPSHOT_MAX_FILES,
      maxBytes: limits.maxBytes ?? WORKTREE_SNAPSHOT_MAX_BYTES,
    }
  }

  getSnapshotsRoot(): string {
    return this.snapshotsRoot
  }

  snapshotIdFor(meta: Pick<ManagedWorktreeSnapshotMeta, 'snapshotId'>): string {
    return meta.snapshotId
  }

  hiddenRefFor(snapshotId: string): string {
    return `${WORKTREE_SNAPSHOT_REF_PREFIX}${snapshotId}`
  }

  /** SHA-256 of the manifest bytes (the verification anchor in record.snapshot). */
  manifestHash(manifest: WorktreeSnapshotManifest): string {
    return sha256(JSON.stringify(manifest))
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Verify the checkout is in a supported state for capture. Unsupported or
   * unreadable state BLOCKS capture (and therefore deletion) — never a partial
   * snapshot.
   */
  async assertSupportedState(checkoutPath: string): Promise<void> {
    const problems: string[] = []
    try {
      const gitDir = (
        await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: checkoutPath })
      ).stdout.trim()
      // An in-progress Git operation leaves an index lock in the per-worktree
      // git dir. Ref locks would also block the hidden-ref CAS later; both are
      // covered by this presence check.
      if (existsSync(join(resolvePath(gitDir), 'index.lock'))) {
        problems.push('a Git operation is in progress')
      }
      // Unresolved merge/rebase/cherry-pick/revert state is unsupported: the
      // working tree carries operation metadata that a snapshot would silently
      // lose on restore.
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
        if (existsSync(join(resolvePath(gitDir), marker))) {
          problems.push(`an unresolved ${marker.replace('_HEAD', '').toLowerCase()} operation is in progress`)
          break
        }
      }
      for (const marker of ['rebase-merge', 'rebase-apply']) {
        if (existsSync(join(resolvePath(gitDir), marker))) {
          problems.push('a rebase is in progress')
          break
        }
      }
    } catch {
      problems.push('the checkout is not a readable Git worktree')
    }

    const unmerged = await runGit(['ls-files', '-u'], { cwd: checkoutPath })
    if (unmerged.stdout.trim().length > 0) {
      problems.push('the index contains unmerged entries')
    }

    for (const key of ['core.sparseCheckout', 'core.sparseCheckoutCone']) {
      const sparse = await runGit(['config', '--get', key], {
        cwd: checkoutPath,
        okExitCodes: [1, 128],
      })
      if (sparse.exitCode === 0 && sparse.stdout.trim().length > 0) {
        problems.push('the checkout uses sparse checkout')
        break
      }
    }

    if (problems.length > 0) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_UNSUPPORTED_STATE',
        `Snapshot capture is blocked because ${problems.join('; ')}.`,
      )
    }
  }

  /** Paths of tracked submodules (mode 160000 gitlinks). */
  private async submodulePaths(repositoryRoot: string): Promise<Set<string>> {
    const stage = await runGit(['ls-files', '--stage', '-z'], { cwd: repositoryRoot })
    const paths = new Set<string>()
    for (const record of splitNul(stage.stdout)) {
      if (record.startsWith('160000 ')) {
        const path = record.split('\t').pop()
        if (path) paths.add(path)
      }
    }
    return paths
  }

  private isUnderAny(path: string, parents: Set<string>): boolean {
    for (const parent of parents) {
      if (path === parent || path.startsWith(`${parent}/`)) return true
    }
    return false
  }

  /**
   * Capture the full supported state of the checkout into a fresh snapshot.
   * Preflight bounds run before any payload bytes are written; the final
   * publish is atomic and verified.
   */
  async capture(input: SnapshotCaptureInput): Promise<SnapshotCaptureResult> {
    const { record, finalFingerprint, previewFingerprint, policyVersion } = input
    const checkoutPath = record.checkoutPath
    await this.assertSupportedState(checkoutPath)

    const headOid = (await runGit(['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim()
    if (!isHexOid(headOid)) {
      throw new WorktreeSnapshotError('SNAPSHOT_UNSUPPORTED_STATE', 'HEAD cannot be resolved to an object ID.')
    }
    const branch = (await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: checkoutPath, okExitCodes: [1] })).stdout
      .trim()
      .replace(/^refs\/heads\//, '')
    if (!branch || branch !== record.expectedBranch) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_UNSUPPORTED_STATE',
        `Checkout is on an unexpected branch (${branch || 'detached'} != ${record.expectedBranch}); refusing capture.`,
      )
    }

    const snapshotId = randomBytes(8).toString('hex')
    const hiddenRef = this.hiddenRefFor(snapshotId)
    const stagingDir = join(this.snapshotsRoot, `.tmp-${snapshotId}`)
    const filesDir = join(stagingDir, 'files')
    mkdirSync(filesDir, { recursive: true, mode: 0o700 })

    let stagedBytes: Buffer
    let unstagedBytes: Buffer
    try {
      const maxPatchBuffer = this.limits.maxBytes + 16 * 1024
      stagedBytes = (
        await runGitBuffer(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes: maxPatchBuffer,
        })
      ).stdout
      unstagedBytes = (
        await runGitBuffer(['diff', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes: maxPatchBuffer,
        })
      ).stdout
    } catch (error) {
      this.removeDir(stagingDir)
      throw error
    }

    // Untracked regular files + symlink nodes, plus `.worktreeinclude` files.
    const untracked = splitNul(
      (await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: checkoutPath })).stdout,
    )
    const included = (await listWorktreeIncludeFiles(checkoutPath))
      .filter((path) => !untracked.includes(path))
    const submodules = await this.submodulePaths(checkoutPath)

    const fileEntries: SnapshotFileEntry[] = []
    let totalBytes = stagedBytes.length + unstagedBytes.length
    const stagedHash = sha256(stagedBytes)
    const unstagedHash = sha256(unstagedBytes)

    try {
      for (const rel of [...untracked, ...included]) {
        // Path safety: git emits repository-relative paths, but a hostile or
        // corrupt checkout must never make capture write outside the payload.
        if (!rel || rel.includes('\0') || rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel)) {
          throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Untracked path escapes the checkout: ${rel}`)
        }
        // Submodule working trees are excluded from capture by policy.
        if (this.isUnderAny(rel, submodules)) continue
        const abs = join(checkoutPath, rel)
        let stat: ReturnType<typeof lstatSync>
        try {
          stat = lstatSync(abs)
        } catch {
          continue // disappeared between listing and capture — not captured
        }
        if (stat.isSymbolicLink()) {
          const linkText = readlinkSync(abs)
          fileEntries.push({
            path: rel,
            mode: '120000',
            size: linkText.length,
            sha256: sha256(linkText),
            stored: null,
            linkText,
          })
          totalBytes += linkText.length
          continue
        }
        if (!stat.isFile()) continue
        totalBytes += stat.size
        if (fileEntries.length + 1 > this.limits.maxFiles || totalBytes > this.limits.maxBytes) {
          throw new WorktreeSnapshotError(
            'SNAPSHOT_LIMIT',
            `Snapshot exceeds the capture limit (${this.limits.maxFiles} files / ${this.limits.maxBytes} bytes).`,
          )
        }
        // Preserve the exact permission bits (mode-for-mode restore): Git
        // modes are six octal digits, `10` prefix + perms for regular files.
        const entry: SnapshotFileEntry = {
          path: rel,
          mode: `10${(stat.mode & 0o777).toString(8).padStart(4, '0')}`,
          size: stat.size,
          sha256: '',
          stored: null,
        }
        const hash = createHash('sha256')
        const storedName = `${sha256(`${rel}\0${stat.size}\0${stat.mtimeMs}`)}`
        const storedPath = join(filesDir, storedName)
        await new Promise<void>((resolve, reject) => {
          const input = createReadStream(abs)
          const output = createWriteStream(storedPath, { mode: 0o600 })
          input.on('data', (chunk: string | Buffer) => hash.update(chunk))
          input.on('error', reject)
          output.on('error', reject)
          output.on('close', () => resolve())
          input.pipe(output)
        })
        entry.sha256 = hash.digest('hex')
        entry.stored = storedName
        fileEntries.push(entry)
      }

      if (fileEntries.length + 2 > this.limits.maxFiles) {
        throw new WorktreeSnapshotError(
          'SNAPSHOT_LIMIT',
          `Snapshot exceeds the capture limit (${this.limits.maxFiles} files).`,
        )
      }
      if (totalBytes > this.limits.maxBytes) {
        throw new WorktreeSnapshotError(
          'SNAPSHOT_LIMIT',
          `Snapshot exceeds the capture size limit (${this.limits.maxBytes} bytes).`,
        )
      }

      const manifest: WorktreeSnapshotManifest = {
        schemaVersion: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        snapshotId,
        branch,
        headOid,
        baseRef: record.baseRef,
        capturedAt: Date.now(),
        stagedPatch: { file: 'staged.patch', sha256: stagedHash, bytes: stagedBytes.length },
        unstagedPatch: { file: 'unstaged.patch', sha256: unstagedHash, bytes: unstagedBytes.length },
        files: fileEntries,
        fileCount: fileEntries.length + 2,
        totalBytes,
      }
      // Hashes must verify before anything is published.
      const manifestHash = this.manifestHash(manifest)
      if (manifestHash !== sha256(JSON.stringify(manifest))) {
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Manifest hash mismatch while preparing the snapshot.')
      }
      for (const entry of fileEntries) {
        if (entry.stored && hashFile(join(filesDir, entry.stored)) !== entry.sha256) {
          throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', `Stored file hash mismatch: ${entry.path}`)
        }
      }
      writePatch(stagingDir, 'staged.patch', stagedBytes)
      writePatch(stagingDir, 'unstaged.patch', unstagedBytes)
      if (sha256(readFileSync(join(stagingDir, 'staged.patch'))) !== stagedHash) {
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Staged patch hash mismatch before publish.')
      }
      if (sha256(readFileSync(join(stagingDir, 'unstaged.patch'))) !== unstagedHash) {
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Unstaged patch hash mismatch before publish.')
      }
      writePatch(stagingDir, 'manifest.json', Buffer.from(JSON.stringify(manifest)))
      if (hashFile(join(stagingDir, 'manifest.json')) !== manifestHash) {
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Manifest hash mismatch before publish.')
      }

      // CAS-create the hidden ref only when absent, pinning captured HEAD.
      const zeroOid = '0'.repeat(40)
      const refResult = await runGit(['update-ref', hiddenRef, headOid, zeroOid], {
        cwd: record.repositoryRoot,
        okExitCodes: [1, 128],
      })
      if (refResult.exitCode !== 0) {
        throw new WorktreeSnapshotError(
          'SNAPSHOT_REF_CONFLICT',
          `The hidden snapshot ref ${hiddenRef} already exists; refusing to overwrite it.`,
        )
      }

      // Atomic publish: rename the verified staging directory into place.
      const payloadPath = join(this.snapshotsRoot, snapshotId)
      try {
        renameSync(stagingDir, payloadPath)
      } catch (error) {
        this.removeDir(stagingDir)
        await runGit(['update-ref', '-d', hiddenRef, headOid], {
          cwd: record.repositoryRoot,
          okExitCodes: [1, 128],
        })
        throw new WorktreeSnapshotError(
          'SNAPSHOT_CAPTURE_FAILED',
          `Unable to publish the snapshot payload: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // Final read-back verification of the published payload.
      let published: WorktreeSnapshotManifest
      try {
        published = JSON.parse(readFileSync(join(payloadPath, 'manifest.json'), 'utf8')) as WorktreeSnapshotManifest
      } catch (error) {
        this.removeDir(payloadPath)
        await runGit(['update-ref', '-d', hiddenRef, headOid], {
          cwd: record.repositoryRoot,
          okExitCodes: [1, 128],
        })
        throw new WorktreeSnapshotError(
          'SNAPSHOT_VERIFY_FAILED',
          `Published payload is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (this.manifestHash(published) !== manifestHash) {
        // The publish is not trustworthy: remove the payload and CAS-delete
        // the ref so no orphaned snapshot survives a failed capture.
        this.removeDir(payloadPath)
        await runGit(['update-ref', '-d', hiddenRef, headOid], {
          cwd: record.repositoryRoot,
          okExitCodes: [1, 128],
        })
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Published manifest hash differs from the prepared manifest.')
      }

      const meta: ManagedWorktreeSnapshotMeta = {
        snapshotId,
        schemaVersion: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
        hiddenRef,
        headOid,
        branch,
        manifestHash,
        payloadPath,
        createdAt: Date.now(),
        fileCount: manifest.fileCount,
        totalBytes,
        fingerprint: finalFingerprint,
        policyVersion,
        previewFingerprint,
      }
      return { meta, manifest }
    } catch (error) {
      this.removeDir(stagingDir)
      throw error
    }
  }

  /**
   * Recompute the exact post-quiescence fingerprint. The lifecycle service
   * calls this after all owning runtimes quiesce and immediately before source
   * release; a changed fingerprint means an external writer raced and removal
   * must not proceed.
   */
  async recomputeFingerprint(record: ManagedWorktreeRecordV2, policyVersion?: number): Promise<string> {
    return computeWorktreeFingerprint({
      managedWorktreeId: record.managedWorktreeId,
      checkoutPath: record.checkoutPath,
      gitCommonDir: record.gitCommonDir,
      expectedBranch: record.expectedBranch,
      baseRef: record.baseRef,
      ownerSessionIds: record.ownerSessionIds,
      policyVersion: policyVersion ?? record.policyVersion ?? 0,
      archivedOwnerSessionIds: record.archivedOwnerSessionIds ?? [],
    })
  }

  // -------------------------------------------------------------------------
  // Verification and deletion
  // -------------------------------------------------------------------------

  /** Full payload verification against the record's snapshot metadata. */
  verifyPayload(meta: ManagedWorktreeSnapshotMeta): WorktreeSnapshotManifest {
    // The payload path must live under this service's snapshot root: a forged
    // or migrated record can never authorize reading outside server storage.
    if (!isContained(resolvePath(this.snapshotsRoot), resolvePath(meta.payloadPath))) {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', 'Snapshot payload path escapes the snapshot root.')
    }
    if (!existsSync(join(meta.payloadPath, 'manifest.json'))) {
      throw new WorktreeSnapshotError('SNAPSHOT_PAYLOAD_MISSING', 'Snapshot payload is missing its manifest.')
    }
    let manifest: WorktreeSnapshotManifest
    try {
      manifest = JSON.parse(readFileSync(join(meta.payloadPath, 'manifest.json'), 'utf8')) as WorktreeSnapshotManifest
    } catch {
      throw new WorktreeSnapshotError('SNAPSHOT_PAYLOAD_MISSING', 'Snapshot manifest is unreadable.')
    }
    if (manifest.schemaVersion !== WORKTREE_SNAPSHOT_SCHEMA_VERSION) {
      throw new WorktreeSnapshotError('SNAPSHOT_PAYLOAD_MISSING', 'Snapshot manifest schema version is unsupported.')
    }
    if (this.manifestHash(manifest) !== meta.manifestHash) {
      throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Snapshot manifest hash does not match the record.')
    }
    if (manifest.snapshotId !== meta.snapshotId || manifest.headOid !== meta.headOid || manifest.branch !== meta.branch) {
      throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Snapshot manifest identity does not match the record.')
    }
    const stagedPatch = readFileSync(join(meta.payloadPath, 'staged.patch'))
    if (sha256(stagedPatch) !== manifest.stagedPatch.sha256) {
      throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Staged patch hash mismatch.')
    }
    const unstagedPatch = readFileSync(join(meta.payloadPath, 'unstaged.patch'))
    if (sha256(unstagedPatch) !== manifest.unstagedPatch.sha256) {
      throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', 'Unstaged patch hash mismatch.')
    }
    for (const entry of manifest.files) {
      if (!entry.stored) continue
      // Stored names are opaque single-file leaf names; anything else is a
      // forged manifest trying to read or write outside the payload.
      if (entry.stored.includes('/') || entry.stored.includes('\\') || entry.stored === '..' || entry.stored.startsWith('.')) {
        throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Snapshot stored name is unsafe: ${entry.stored}`)
      }
      const stored = join(meta.payloadPath, 'files', entry.stored)
      if (!existsSync(stored) || hashFile(stored) !== entry.sha256) {
        throw new WorktreeSnapshotError('SNAPSHOT_VERIFY_FAILED', `Snapshot file hash mismatch: ${entry.path}`)
      }
    }
    return manifest
  }

  /** Verify the hidden ref still pins the captured OID. */
  async verifyHiddenRef(repositoryRoot: string, meta: ManagedWorktreeSnapshotMeta): Promise<void> {
    const ref = await runGit(['rev-parse', '--verify', '--quiet', meta.hiddenRef], {
      cwd: repositoryRoot,
      okExitCodes: [1, 128],
    })
    if (ref.exitCode !== 0 || ref.stdout.trim() !== meta.headOid) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_REF_CONFLICT',
        `Hidden snapshot ref ${meta.hiddenRef} is missing or no longer pins the captured OID.`,
      )
    }
  }

  /** CAS-delete the hidden ref, limited to the captured OID. */
  async casDeleteRef(repositoryRoot: string, meta: ManagedWorktreeSnapshotMeta): Promise<void> {
    const result = await runGit(['update-ref', '-d', meta.hiddenRef, meta.headOid], {
      cwd: repositoryRoot,
      okExitCodes: [1, 128],
    })
    if (result.exitCode !== 0) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_REF_CONFLICT',
        `Unable to delete hidden snapshot ref ${meta.hiddenRef}; it is not at the captured OID.`,
      )
    }
  }

  /**
   * Permanent deletion: verify the payload and ref ownership, CAS-delete only
   * the owned hidden ref, remove the payload, and return. The registry record
   * deletion is the lifecycle service's responsibility and runs last.
   */
  async permanentDelete(repositoryRoot: string, meta: ManagedWorktreeSnapshotMeta): Promise<void> {
    this.verifyPayload(meta)
    await this.verifyHiddenRef(repositoryRoot, meta)
    await this.casDeleteRef(repositoryRoot, meta)
    this.removeDir(meta.payloadPath)
  }

  /** Remove a verified snapshot payload (post-restore). */
  removePayload(meta: ManagedWorktreeSnapshotMeta): void {
    this.removeDir(meta.payloadPath)
  }

  /** Remove an unreferenced capture staging directory (startup GC). */
  removeStagingDir(name: string): void {
    if (!name.startsWith('.tmp-')) return
    this.removeDir(join(this.snapshotsRoot, name))
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  /**
   * Restore the snapshot into a fresh checkout at `checkoutPath`. Revalidates
   * repository identity, payload hashes, hidden-ref ownership/OID, branch and
   * worktree occupancy before creating anything. Attempt-created artifacts are
   * removed on failure; the payload and ref are retained for retry.
   */
  async restore(input: SnapshotRestoreInput): Promise<SnapshotRestoreResult> {
    const { record, meta, checkoutPath } = input
    this.verifyPayload(meta)

    // Repository identity: the original repository/common object store must be
    // available (reconstruction/cross-host restore is out of scope).
    const commonDir = (
      await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: record.repositoryRoot,
        okExitCodes: [128],
      })
    ).stdout.trim()
    if (!commonDir || resolvePath(commonDir) !== resolvePath(record.gitCommonDir)) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_REPOSITORY_MISMATCH',
        'The original repository is unavailable or its identity changed; restore is not possible.',
      )
    }
    await this.verifyHiddenRef(record.repositoryRoot, meta)

    // Branch occupancy: absent, or unchanged at the captured OID. A
    // differently advanced branch is never force-reset.
    const branchOid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${meta.branch}`], {
      cwd: record.repositoryRoot,
      okExitCodes: [1, 128],
    })
    const branchAbsent = branchOid.exitCode !== 0
    if (!branchAbsent && branchOid.stdout.trim() !== meta.headOid) {
      throw new WorktreeSnapshotError(
        'SNAPSHOT_RESTORE_FAILED',
        `Branch ${meta.branch} advanced to a different OID than the snapshot; restore refuses to force-reset it.`,
      )
    }

    // Destination must be absent, inside the recorded root, and free of
    // symlinked parents (no-follow safety).
    if (existsSync(checkoutPath) || lstatSafe(checkoutPath) === 'symlink') {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Restore destination already exists: ${checkoutPath}`)
    }
    if (!isContained(resolvePath(record.materializationRoot), resolvePath(checkoutPath))) {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', 'Restore destination escapes the materialization root.')
    }
    this.prepareRestoreParents(resolvePath(record.materializationRoot), checkoutPath)

    const manifest = this.verifyPayload(meta)
    let createdWorktree = false
    try {
      if (branchAbsent) {
        await runGit(['worktree', 'add', '--no-track', '-b', meta.branch, checkoutPath, meta.headOid], {
          cwd: record.repositoryRoot,
          timeoutMs: 120_000,
        })
      } else {
        await runGit(['worktree', 'add', '--detach', checkoutPath, meta.headOid], {
          cwd: record.repositoryRoot,
          timeoutMs: 120_000,
        })
        await runGit(['switch', meta.branch], { cwd: checkoutPath })
      }
      createdWorktree = true

      // Verify the fresh checkout identity before touching any content: same
      // common directory, branch, and HEAD, AND the real path must stay inside
      // the recorded materialization root (no-follow containment even when the
      // root or destination was swapped through symlinks).
      const ctx = await this.checkoutContext(checkoutPath)
      if (
        !ctx.ok ||
        ctx.gitCommonDir !== resolvePath(record.gitCommonDir) ||
        ctx.branch !== meta.branch ||
        ctx.headOid !== meta.headOid ||
        !isContained(safeRealpathFor(record.materializationRoot), safeRealpathFor(checkoutPath))
      ) {
        throw new WorktreeSnapshotError(
          'SNAPSHOT_RESTORE_FAILED',
          'Git created a restore checkout with an unexpected identity.',
        )
      }

      // Staged projection → index AND working tree (so rename/add patches also
      // materialize their files); unstaged projection → working tree only.
      await this.applyPatch(checkoutPath, join(meta.payloadPath, 'staged.patch'), ['--index'])
      await this.applyPatch(checkoutPath, join(meta.payloadPath, 'unstaged.patch'), [])

      // Untracked regular files + symlink nodes + `.worktreeinclude` files.
      for (const entry of manifest.files) {
        this.restoreFileEntry(checkoutPath, meta, entry)
      }

      // Exact verification: the restored staged and unstaged projections must
      // reproduce the captured patches byte-for-byte (Git's own diff output is
      // deterministic for identical tree states), and every untracked/included
      // file must match its captured hash and mode.
      const restoredStaged = (
        await runGitBuffer(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes: this.limits.maxBytes + 16 * 1024,
        })
      ).stdout
      if (sha256(restoredStaged) !== manifest.stagedPatch.sha256) {
        throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', 'Restored index differs from the captured staged state.')
      }
      const restoredUnstaged = (
        await runGitBuffer(['diff', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes: this.limits.maxBytes + 16 * 1024,
        })
      ).stdout
      if (sha256(restoredUnstaged) !== manifest.unstagedPatch.sha256) {
        throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', 'Restored worktree differs from the captured unstaged state.')
      }
      for (const entry of manifest.files) {
        const abs = join(checkoutPath, entry.path)
        const stat = lstatSafe(abs)
        if (stat === null) {
          throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `Restored file is missing: ${entry.path}`)
        }
        if (entry.mode === '120000') {
          if (stat !== 'symlink' || readlinkSync(abs) !== entry.linkText) {
            throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `Restored symlink differs: ${entry.path}`)
          }
          continue
        }
        if (stat === 'symlink' || stat === 'dir') {
          throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `Restored path is not a regular file: ${entry.path}`)
        }
        const actual = statSync(abs)
        if ((actual.mode & 0o777) !== modePermissions(entry.mode) || hashFile(abs) !== entry.sha256) {
          throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `Restored file content or mode differs: ${entry.path}`)
        }
      }

      return { checkoutPath: resolvePath(checkoutPath) }
    } catch (error) {
      // Remove only artifacts created by this attempt; the payload and hidden
      // ref are retained for a safe retry.
      if (createdWorktree) {
        try {
          await runGit(['worktree', 'remove', '--force', checkoutPath], {
            cwd: record.repositoryRoot,
            okExitCodes: [1, 128],
          })
        } catch {
          /* fall through to directory removal */
        }
      }
      this.removeDir(checkoutPath)
      throw error
    }
  }

  private async checkoutContext(checkoutPath: string): Promise<
    { ok: true; gitCommonDir: string; branch: string; headOid: string } | { ok: false }
  > {
    try {
      const commonDir = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: checkoutPath })
      const branch = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: checkoutPath, okExitCodes: [1] })
      const head = await runGit(['rev-parse', 'HEAD'], { cwd: checkoutPath })
      return {
        ok: true,
        gitCommonDir: resolvePath(commonDir.stdout.trim()),
        branch: branch.stdout.trim().replace(/^refs\/heads\//, ''),
        headOid: head.stdout.trim(),
      }
    } catch {
      return { ok: false }
    }
  }

  private async applyPatch(checkoutPath: string, patchPath: string, extra: string[]): Promise<void> {
    if (!existsSync(patchPath)) return
    if (statSync(patchPath).size === 0) return
    const result = await runGit(
      ['apply', '--binary', '--allow-empty', '--whitespace=nowarn', ...extra, '--', patchPath],
      { cwd: checkoutPath, okExitCodes: [1, 128] },
    )
    if (result.exitCode !== 0) {
      const message = extra.includes('--index') ? 'staged' : 'unstaged'
      throw new WorktreeSnapshotError(
        'SNAPSHOT_RESTORE_FAILED',
        `Unable to apply the captured ${message} patch.`,
      )
    }
  }

  /**
   * Restore one untracked/included entry. Parent components are walked with
   * lstat: an existing symlink parent (or an escaping path) fails the restore
   * instead of being followed. Symlink targets are stored as link text and
   * recreated with `symlink` — never dereferenced.
   */
  private restoreFileEntry(checkoutPath: string, meta: ManagedWorktreeSnapshotMeta, entry: SnapshotFileEntry): void {
    if (!entry.path || entry.path.includes('\0') || entry.path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(entry.path)) {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Snapshot path escapes the checkout: ${entry.path}`)
    }
    const dest = join(checkoutPath, entry.path)
    this.assertNoSymlinkParents(checkoutPath, dest)
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Restore destination exists: ${entry.path}`)
    }
    if (entry.mode === '120000') {
      if (typeof entry.linkText !== 'string') {
        throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `Symlink entry has no link text: ${entry.path}`)
      }
      try {
        symlinkSync(entry.linkText, dest)
      } catch (error) {
        throw new WorktreeSnapshotError(
          'SNAPSHOT_RESTORE_FAILED',
          `Unable to recreate symlink ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return
    }
    if (!entry.stored) {
      throw new WorktreeSnapshotError('SNAPSHOT_RESTORE_FAILED', `File entry has no stored payload: ${entry.path}`)
    }
    const storedPath = join(meta.payloadPath, 'files', entry.stored)
    if (!existsSync(storedPath)) {
      throw new WorktreeSnapshotError('SNAPSHOT_PAYLOAD_MISSING', `Stored payload missing for ${entry.path}`)
    }
    copyFileSync(storedPath, dest)
    chmodSync(dest, modePermissions(entry.mode))
  }

  private assertNoSymlinkParents(checkoutPath: string, dest: string): void {
    let current = dirname(dest)
    const root = resolvePath(checkoutPath)
    while (current !== root && isContained(root, current)) {
      const kind = lstatSafe(current)
      if (kind === 'symlink') {
        throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Restore destination has a symlinked parent: ${current}`)
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  /** Symlink-safe mkdir of the restore destination parents under the root. */
  private prepareRestoreParents(root: string, checkoutPath: string): void {
    const rel = relative(root, checkoutPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', 'Restore destination escapes the materialization root.')
    }
    // The recorded root itself must never be a symlink: a swapped root must
    // fail closed rather than redirect extraction outside server storage.
    if (lstatSafe(root) === 'symlink') {
      throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', 'Restore materialization root must not be a symlink.')
    }
    let current = root
    for (const component of rel.split(/[\\/]+/).filter(Boolean).slice(0, -1)) {
      current = join(current, component)
      if (lstatSafe(current) === 'symlink') {
        throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Restore destination has a symlinked parent: ${current}`)
      }
      if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
      const kind = lstatSafe(current)
      if (kind === 'symlink' || kind === null || kind !== 'dir') {
        throw new WorktreeSnapshotError('SNAPSHOT_PATH_UNSAFE', `Restore destination parent is not a safe directory: ${current}`)
      }
    }
  }

  private removeDir(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort; retained payloads are verified before any retry */
    }
  }
}

function safeRealpathFor(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolvePath(p)
  }
}

function lstatSafe(path: string): 'symlink' | 'dir' | 'file' | 'other' | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch {
    return null
  }
}

function writePatch(dir: string, name: string, bytes: Buffer): void {
  const path = join(dir, name)
  if (!existsSync(path)) {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
  }
}

/**
 * Fingerprint binding the complete owner/path/Git/content/policy state of a
 * managed checkout. A lifecycle preview issues this value; delete revalidates
 * it immediately before capture and before source release, so any changed
 * owner, branch, HEAD, index, working tree, untracked manifest, root,
 * lifecycle state, or policy refuses a stale confirmation.
 */
export async function computeWorktreeFingerprint(input: {
  managedWorktreeId: string
  checkoutPath: string
  gitCommonDir: string
  expectedBranch: string
  baseRef: string | null
  ownerSessionIds: string[]
  policyVersion: number
  archivedOwnerSessionIds: string[]
}): Promise<string> {
  const hash = createHash('sha256')
  hash.update('kata-worktree-lifecycle-v1\0')
  hash.update(
    `${input.managedWorktreeId}\0${input.checkoutPath}\0${input.gitCommonDir}\0${input.expectedBranch}\0${input.baseRef ?? ''}\0`,
  )
  hash.update(`owners=${[...input.ownerSessionIds].sort().join(',')}\0`)
  hash.update(`archived=${[...input.archivedOwnerSessionIds].sort().join(',')}\0`)
  hash.update(`policy=${input.policyVersion}\0`)

  const repositoryIdentity = await runGit(
    ['rev-parse', '--show-toplevel', '--git-common-dir'],
    { cwd: input.checkoutPath },
  )
  const headIdentity = await runGit(['rev-parse', 'HEAD'], { cwd: input.checkoutPath })
  const branchIdentity = await runGit(['symbolic-ref', '--quiet', 'HEAD'], {
    cwd: input.checkoutPath,
    okExitCodes: [1],
  })
  hash.update(repositoryIdentity.stdout)
  hash.update(headIdentity.stdout)
  hash.update(branchIdentity.stdout)
  hash.update('\0')

  const indexState = await runGit(['ls-files', '--stage', '-z'], {
    cwd: input.checkoutPath,
  })
  hash.update(indexState.stdout)
  hash.update('\0')

  // Dirty paths with their index + worktree state and content hashes.
  const status = await runGit(['status', '--porcelain=v2', '-z'], { cwd: input.checkoutPath })
  hash.update(status.stdout)
  hash.update('\0')
  for (const record of splitNul(status.stdout)) {
    const path = record.split('\t').pop()
    if (!path) continue
    const absolutePath = join(input.checkoutPath, path)
    try {
      const stat = lstatSync(absolutePath)
      hash.update(stat.mode.toString(8))
      hash.update('\0')
      if (stat.isFile()) {
        const object = await runGit(['hash-object', '--no-filters', '--', path], {
          cwd: input.checkoutPath,
        })
        hash.update(object.stdout.trim())
      } else if (stat.isSymbolicLink()) {
        hash.update(readlinkSync(absolutePath))
      }
    } catch {
      // Missing path hashes as absent.
    }
    hash.update('\0')
  }

  // Ignored files outside `.worktreeinclude` are excluded by documented
  // policy; ignored files selected by `.worktreeinclude` are bound below.
  for (const ignoredPath of await listWorktreeIncludeFiles(input.checkoutPath)) {
    hash.update(`included\0${ignoredPath}\0`)
    const absolutePath = join(input.checkoutPath, ignoredPath)
    try {
      const stat = lstatSync(absolutePath)
      hash.update(stat.mode.toString(8))
      hash.update('\0')
      if (stat.isFile()) {
        const object = await runGit(['hash-object', '--no-filters', '--', ignoredPath], {
          cwd: input.checkoutPath,
        })
        hash.update(object.stdout.trim())
      } else if (stat.isSymbolicLink()) {
        hash.update(readlinkSync(absolutePath))
      }
    } catch {
      /* absent */
    }
    hash.update('\0')
  }

  if (input.baseRef) {
    const uniqueCommits = await runGit(['rev-list', '--reverse', `${input.baseRef}..HEAD`], {
      cwd: input.checkoutPath,
    })
    hash.update(uniqueCommits.stdout)
  }

  return hash.digest('hex')
}
