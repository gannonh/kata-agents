import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CURRENT_LAYOUT_VERSION,
  aggregateHealth,
  brandDisplayId,
  brandProfileId,
  brandSessionId,
  brandShutdownEpoch,
  layoutForRoot,
  openDataRootLayout,
  type BrowserProfile,
  type ComputerConfig,
  type ComputerIdentity,
  type ComputerIdentityPublic,
  type ComputerReadiness,
  type DataRootLayout,
  type IdleBrowserProfile,
  type LeasedBrowserProfile,
  type ProfileHandoffRequest,
  type ProfileId,
  type RecoveryDisposition,
  type SessionId,
  type ShutdownEpoch,
  type ShutdownWorkItem,
  type VirtualDisplay,
} from '@kata-sh/shared/computer'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface.ts'
import { NullBrowserPaneManager } from '../runtime/null-browser-pane-manager.ts'
import { ComputerLayoutError, ProfileBusyError } from './errors.ts'
import { acquireRuntimeLock, type RuntimeLockHandle } from './lock.ts'
import { identityFromRecord, loadComputerRecord, writeComputerRecord, type ComputerRecord } from './record.ts'
import { HeadlessBrowserPaneManager } from './headless-browser-pane-manager.ts'

const DEFAULT_DISPLAY_SIZE = { width: 1280, height: 720 }

export class Computer {
  readonly identity: ComputerIdentity
  readonly layout: DataRootLayout
  readonly config: ComputerConfig

  private lock: RuntimeLockHandle
  private record: ComputerRecord
  private readiness: ComputerReadiness
  private localBpm: IBrowserPaneManager | null = null
  private headlessBpm: HeadlessBrowserPaneManager | null = null
  private unavailableBpm: IBrowserPaneManager
  private closed = false
  private priorUnclean = false
  private displays = new Map<string, VirtualDisplay>()
  private leases = new Map<string, LeasedBrowserProfile>()

  private constructor(input: {
    config: ComputerConfig
    layout: DataRootLayout
    identity: ComputerIdentity
    lock: RuntimeLockHandle
    record: ComputerRecord
    readiness: ComputerReadiness
    unavailableBpm: IBrowserPaneManager
    priorUnclean: boolean
  }) {
    this.config = input.config
    this.layout = input.layout
    this.identity = input.identity
    this.lock = input.lock
    this.record = input.record
    this.readiness = input.readiness
    this.unavailableBpm = input.unavailableBpm
    this.priorUnclean = input.priorUnclean
  }

  static peekHealth(dataRoot: string): {
    status: 'ok' | 'degraded' | 'unhealthy'
    readiness: ComputerReadiness | null
  } {
    const layout = layoutForRoot(dataRoot)
    try {
      const record = loadComputerRecord(layout)
      if (!record?.lastReadiness) return { status: 'unhealthy', readiness: null }
      return { status: aggregateHealth(record.lastReadiness), readiness: record.lastReadiness }
    } catch {
      return { status: 'unhealthy', readiness: null }
    }
  }

  static async open(config: ComputerConfig, options?: { skipBrowser?: boolean }): Promise<Computer> {
    const opened = openDataRootLayout(config.dataRoot)
    if (opened.tag === 'corrupt') throw new ComputerLayoutError(opened)
    if (opened.tag === 'incompatible') throw new ComputerLayoutError({ tag: 'incompatible', found: opened.found })

    const lock = acquireRuntimeLock(opened.layout.runtimeLockPath)
    try {
      const osAccount = userInfo().username
      const now = new Date().toISOString()
      let record = loadComputerRecord(opened.layout)
      let priorUnclean = false
      if (!record) {
        record = {
          computerId: opened.computerId,
          kind: config.kind,
          osAccount,
          createdAt: now,
          appVersion: config.appVersion,
          shutdownEpoch: 0,
          unclean: true,
          lastReadiness: null,
        }
      } else {
        priorUnclean = record.unclean
        record = {
          ...record,
          kind: config.kind,
          appVersion: config.appVersion,
          unclean: true,
        }
      }

      const identity = identityFromRecord(record, config.kind, opened.layout.root)
      const skipBrowser = options?.skipBrowser === true
      const browserStatus = skipBrowser
        ? { tag: 'degraded' as const, reason: 'browser not started (skipBrowser)' }
        : { tag: 'degraded' as const, reason: 'browser starting' }

      const readiness: ComputerReadiness = {
        process: { tag: 'ready' },
        storage: { tag: 'ready' },
        browser: browserStatus,
        checkedAt: now,
      }
      record.lastReadiness = readiness
      writeComputerRecord(opened.layout, record)

      const computer = new Computer({
        config,
        layout: opened.layout,
        identity,
        lock,
        record,
        readiness,
        unavailableBpm: new NullBrowserPaneManager(
          skipBrowser
            ? 'Browser runtime was not started (skipBrowser)'
            : 'Server-resident browser is not ready',
        ),
        priorUnclean,
      })
      computer.loadPersistedDisplays()
      computer.dropStaleLeases()

      if (!skipBrowser) {
        await computer.startBrowser()
      }

      computer.persistRecord()
      return computer
    } catch (error) {
      lock.release()
      throw error
    }
  }

  snapshotReadiness(): ComputerReadiness {
    return this.readiness
  }

  healthStatus(): 'ok' | 'degraded' | 'unhealthy' {
    return aggregateHealth(this.readiness)
  }

  publicIdentity(): ComputerIdentityPublic {
    return {
      kind: this.identity.kind,
      computerId: this.identity.computerId,
      dataRootVersion: CURRENT_LAYOUT_VERSION,
    }
  }

  async waitReady(options: {
    require: readonly ('process' | 'storage' | 'browser')[]
    timeoutMs?: number
  }): Promise<ComputerReadiness> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (true) {
      const snap = this.snapshotReadiness()
      if (options.require.every((dimension) => snap[dimension].tag === 'ready')) return snap
      if (Date.now() >= deadline) return snap
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  setLocalBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.localBpm = bpm
  }

  browserPaneManagerForSession(_sessionId: string): IBrowserPaneManager {
    if (this.identity.kind === 'local-client' && this.localBpm) return this.localBpm
    if (this.headlessBpm) return this.headlessBpm
    if (this.localBpm) return this.localBpm
    return this.unavailableBpm
  }

  listDisplays(): readonly VirtualDisplay[] {
    return [...this.displays.values()]
  }

  async acquireProfileLease(input: {
    profileId: ProfileId
    sessionId: SessionId
    displayId?: VirtualDisplay['displayId']
  }): Promise<LeasedBrowserProfile> {
    this.assertOpen()
    const existing = this.leases.get(input.profileId)
    if (existing && existing.writer.sessionId !== input.sessionId) {
      throw new ProfileBusyError(input.profileId, existing.writer.sessionId)
    }
    if (existing && existing.writer.sessionId === input.sessionId) return existing

    const display = this.ensureDisplay(input.displayId, input.profileId, input.sessionId)
    const userDataDir = join(this.layout.browserProfilesDir, input.profileId)
    mkdirSync(userDataDir, { recursive: true })
    const leased: LeasedBrowserProfile = {
      profileId: input.profileId,
      computerId: this.identity.computerId,
      userDataDir,
      writer: {
        tag: 'leased',
        sessionId: input.sessionId,
        leaseToken: randomBytes(12).toString('hex'),
        displayId: display.displayId,
        acquiredAt: new Date().toISOString(),
      },
    }
    this.leases.set(input.profileId, leased)
    this.persistLease(leased)
    return leased
  }

  async releaseProfileLease(input: { profileId: ProfileId; sessionId: SessionId }): Promise<IdleBrowserProfile> {
    this.assertOpen()
    const existing = this.leases.get(input.profileId)
    if (existing && existing.writer.sessionId !== input.sessionId) {
      throw new ProfileBusyError(input.profileId, existing.writer.sessionId)
    }
    this.leases.delete(input.profileId)
    const lockPath = join(this.layout.browserLocksDir, `${input.profileId}.lock`)
    if (existsSync(lockPath)) rmSync(lockPath)
    return {
      profileId: input.profileId,
      computerId: this.identity.computerId,
      userDataDir: join(this.layout.browserProfilesDir, input.profileId),
      writer: { tag: 'none' },
    }
  }

  async handoffProfile(request: ProfileHandoffRequest): Promise<BrowserProfile> {
    this.assertOpen()
    const existing = this.leases.get(request.profileId)
    if (!existing || existing.writer.sessionId !== request.fromSessionId) {
      const holder = existing?.writer.sessionId ?? 'none'
      throw new ProfileBusyError(request.profileId, holder)
    }

    if (request.mode === 'snapshot-clone' && this.headlessBpm) {
      await this.headlessBpm.flushProfile(request.profileId)
    }

    if (request.mode === 'lease-transfer') {
      const transferred: LeasedBrowserProfile = {
        ...existing,
        writer: {
          ...existing.writer,
          sessionId: request.toSessionId,
          leaseToken: randomBytes(12).toString('hex'),
          acquiredAt: new Date().toISOString(),
        },
      }
      this.leases.set(request.profileId, transferred)
      this.persistLease(transferred)
      const display = this.displays.get(transferred.writer.displayId)
      if (display) {
        this.displays.set(display.displayId, {
          ...display,
          boundSessionId: request.toSessionId,
          persistedAt: new Date().toISOString(),
        })
        this.persistDisplay(this.displays.get(display.displayId)!)
      }
      this.headlessBpm?.reassignProfileWriter(
        String(request.fromSessionId),
        String(request.toSessionId),
        request.profileId,
      )
      return transferred
    }

    const cloneId = brandProfileId(`${request.profileId}-clone-${randomBytes(4).toString('hex')}`)
    const cloneDir = join(this.layout.browserProfilesDir, cloneId)
    if (existsSync(existing.userDataDir)) {
      cpSync(existing.userDataDir, cloneDir, { recursive: true })
    } else {
      mkdirSync(cloneDir, { recursive: true })
    }
    const cloned = await this.acquireProfileLease({
      profileId: cloneId,
      sessionId: request.toSessionId,
    })
    this.headlessBpm?.bindSessionToProfile(String(request.toSessionId), cloneId)
    return cloned
  }

  async reconcileRecovery(): Promise<readonly RecoveryDisposition[]> {
    const items = this.readShutdownWork()
    const dispositions = items.length === 0 && this.priorUnclean
      ? [{ sessionId: 'computer', action: 'surface' as const, from: 'uncertain' as const }]
      : items
        .filter((item) => item.domain === 'session' || item.domain === 'browser-profile')
        .map((item) => {
          if (item.kind === 'checkpointed') {
            return { sessionId: item.ref, action: 'resume' as const, from: 'checkpointed' as const }
          }
          return {
            sessionId: item.ref,
            action: 'surface' as const,
            from: item.kind === 'interrupted' ? 'interrupted' as const : 'uncertain' as const,
          }
        })
    this.archiveReconciledShutdownWork()
    return dispositions
  }

  async shutdown(input: { reason: 'signal' | 'drain' | 'operator'; timeoutMs: number }): Promise<{
    epoch: ShutdownEpoch
    work: readonly ShutdownWorkItem[]
  }> {
    this.assertOpen()
    const epoch = brandShutdownEpoch(this.record.shutdownEpoch + 1)
    const work: ShutdownWorkItem[] = []

    if (this.headlessBpm) {
      try {
        await this.headlessBpm.close()
        work.push({ kind: 'checkpointed', domain: 'browser-profile', ref: 'headless' })
      } catch (error) {
        work.push({
          kind: 'interrupted',
          domain: 'browser-profile',
          ref: 'headless',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const leased of this.leases.values()) {
      work.push({
        kind: 'checkpointed',
        domain: 'browser-profile',
        ref: leased.profileId,
        detail: `writer=${leased.writer.sessionId}`,
      })
    }

    this.writeShutdownWork(epoch, work)
    this.record = {
      ...this.record,
      shutdownEpoch: epoch,
      unclean: false,
      lastReadiness: this.readiness,
    }
    this.persistRecord()
    this.lock.release()
    this.closed = true
    void input.timeoutMs
    void input.reason
    return { epoch, work }
  }

  private async startBrowser(): Promise<void> {
    try {
      this.headlessBpm = await HeadlessBrowserPaneManager.launch({
        computer: this,
        chromiumPath: this.config.chromiumPath,
      })
      this.readiness = {
        ...this.readiness,
        browser: { tag: 'ready' },
        checkedAt: new Date().toISOString(),
      }
      this.unavailableBpm = this.headlessBpm
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.readiness = {
        ...this.readiness,
        browser: { tag: 'failed', reason },
        checkedAt: new Date().toISOString(),
      }
      this.unavailableBpm = new NullBrowserPaneManager(`Server-resident browser failed: ${reason}`)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Computer is shut down')
  }

  private persistRecord(): void {
    writeComputerRecord(this.layout, { ...this.record, lastReadiness: this.readiness })
  }

  private ensureDisplay(
    displayId: VirtualDisplay['displayId'] | undefined,
    profileId: ProfileId,
    sessionId: SessionId,
  ): VirtualDisplay {
    if (displayId) {
      const existing = this.displays.get(displayId)
      if (existing) return existing
    }
    const id = displayId ?? brandDisplayId(`display-${randomBytes(4).toString('hex')}`)
    const display: VirtualDisplay = {
      displayId: id,
      computerId: this.identity.computerId,
      width: DEFAULT_DISPLAY_SIZE.width,
      height: DEFAULT_DISPLAY_SIZE.height,
      boundProfileId: profileId,
      boundSessionId: sessionId,
      persistedAt: new Date().toISOString(),
    }
    this.displays.set(id, display)
    this.persistDisplay(display)
    return display
  }

  private persistDisplay(display: VirtualDisplay): void {
    writeFileSync(
      join(this.layout.browserDisplaysDir, `${display.displayId}.json`),
      `${JSON.stringify(display, null, 2)}\n`,
      'utf8',
    )
  }

  private persistLease(leased: LeasedBrowserProfile): void {
    writeFileSync(
      join(this.layout.browserLocksDir, `${leased.profileId}.lock`),
      `${JSON.stringify(leased, null, 2)}\n`,
      'utf8',
    )
  }

  private loadPersistedDisplays(): void {
    if (!existsSync(this.layout.browserDisplaysDir)) return
    for (const name of readdirSync(this.layout.browserDisplaysDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const display = JSON.parse(
          readFileSync(join(this.layout.browserDisplaysDir, name), 'utf8'),
        ) as VirtualDisplay
        this.displays.set(display.displayId, display)
      } catch {}
    }
  }

  private dropStaleLeases(): void {
    this.leases.clear()
    if (!existsSync(this.layout.browserLocksDir)) return
    for (const name of readdirSync(this.layout.browserLocksDir)) {
      if (name.endsWith('.lock')) rmSync(join(this.layout.browserLocksDir, name), { force: true })
    }
  }

  private writeShutdownWork(epoch: ShutdownEpoch, work: readonly ShutdownWorkItem[]): void {
    mkdirSync(this.layout.shutdownDir, { recursive: true })
    writeFileSync(
      join(this.layout.shutdownDir, `${epoch}.json`),
      `${JSON.stringify({ epoch, work }, null, 2)}\n`,
      'utf8',
    )
  }

  private listShutdownJsonFiles(): string[] {
    if (!existsSync(this.layout.shutdownDir)) return []
    return readdirSync(this.layout.shutdownDir).filter((name) => name.endsWith('.json'))
  }

  private parseShutdownFile(name: string): ShutdownWorkItem[] {
    try {
      const parsed = JSON.parse(readFileSync(join(this.layout.shutdownDir, name), 'utf8')) as {
        work?: ShutdownWorkItem[]
      } | ShutdownWorkItem
      if ('kind' in parsed && 'domain' in parsed && 'ref' in parsed) {
        return [parsed]
      }
      if (parsed && 'work' in parsed && Array.isArray(parsed.work)) {
        return parsed.work
      }
      return []
    } catch {
      return [{ kind: 'uncertain', domain: 'session', ref: name, detail: 'unreadable shutdown record' }]
    }
  }

  private readShutdownWork(): ShutdownWorkItem[] {
    const names = this.listShutdownJsonFiles()
    const epochFiles: { epoch: number; name: string }[] = []
    const currentFiles: string[] = []
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name)
      if (match) epochFiles.push({ epoch: Number(match[1]), name })
      else currentFiles.push(name)
    }
    epochFiles.sort((a, b) => b.epoch - a.epoch)
    const selected = [...currentFiles, ...(epochFiles[0] ? [epochFiles[0].name] : [])]
    return selected.flatMap((name) => this.parseShutdownFile(name))
  }

  private archiveReconciledShutdownWork(): void {
    const names = this.listShutdownJsonFiles()
    if (names.length === 0) return
    const dest = join(
      this.layout.shutdownDir,
      'reconciled',
      String(this.record.shutdownEpoch),
      `${Date.now()}`,
    )
    mkdirSync(dest, { recursive: true })
    for (const name of names) {
      renameSync(join(this.layout.shutdownDir, name), join(dest, name))
    }
  }
}

export { brandProfileId, brandSessionId }
