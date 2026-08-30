import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseComputerConfig, CURRENT_LAYOUT_VERSION, brandProfileId, brandSessionId } from '@kata-sh/shared/computer'
import { Computer } from './computer.ts'
import { ComputerAlreadyRunning, ComputerLayoutError, ProfileBusyError } from './errors.ts'

const roots: string[] = []
const computers: Computer[] = []

afterEach(async () => {
  for (const computer of computers.splice(0)) {
    try {
      await computer.shutdown({ reason: 'operator', timeoutMs: 1_000 })
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kata-computer-open-'))
  roots.push(root)
  return root
}

function configFor(root: string) {
  return parseComputerConfig({
    KATA_DATA_ROOT: root,
    KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
    KATA_COMPUTER_KIND: 'self-hosted-headless',
    KATA_RPC_HOST: '127.0.0.1',
  }, { packaged: false })
}

async function open(root: string): Promise<Computer> {
  const computer = await Computer.open(configFor(root), { skipBrowser: true })
  computers.push(computer)
  return computer
}

describe('Computer.open', () => {
  it('opens a data root without Chromium and reports storage ready', async () => {
    const root = tempRoot()
    const computer = await open(root)
    expect(computer.identity.kind).toBe('self-hosted-headless')
    expect(computer.identity.computerId.length).toBeGreaterThan(0)
    expect(computer.identity.dataRoot).toBe(root)
    const readiness = computer.snapshotReadiness()
    expect(readiness.process.tag).toBe('ready')
    expect(readiness.storage.tag).toBe('ready')
    expect(readiness.browser.tag).toBe('degraded')
    expect(computer.publicIdentity()).toEqual({
      kind: 'self-hosted-headless',
      computerId: computer.identity.computerId,
      dataRootVersion: CURRENT_LAYOUT_VERSION,
    })
  })

  it('rejects a second open of the same root while the first is alive', async () => {
    const root = tempRoot()
    await open(root)
    try {
      await Computer.open(configFor(root), { skipBrowser: true })
      throw new Error('expected ComputerAlreadyRunning')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerAlreadyRunning)
    }
  })

  it('reopens the same computer id after shutdown', async () => {
    const root = tempRoot()
    const first = await open(root)
    const id = first.identity.computerId
    await first.shutdown({ reason: 'drain', timeoutMs: 1_000 })
    computers.splice(computers.indexOf(first), 1)
    const second = await open(root)
    expect(second.identity.computerId).toBe(id)
  })

  it('fails closed on a corrupt manifest', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'computer'), { recursive: true })
    writeFileSync(join(root, 'computer', 'manifest.json'), '{not-json')
    try {
      await Computer.open(configFor(root), { skipBrowser: true })
      throw new Error('expected ComputerLayoutError')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerLayoutError)
      expect((error as ComputerLayoutError).tag).toBe('corrupt')
    }
  })

  it('denies a second writer on the same browser profile', async () => {
    const computer = await open(tempRoot())
    const profileId = brandProfileId('shared')
    await computer.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-a'),
    })
    try {
      await computer.acquireProfileLease({
        profileId,
        sessionId: brandSessionId('bot-b'),
      })
      throw new Error('expected ProfileBusyError')
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileBusyError)
    }
  })

  it('transfers a profile lease so the next bot can write', async () => {
    const computer = await open(tempRoot())
    const profileId = brandProfileId('shared')
    await computer.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-a'),
    })
    const transferred = await computer.handoffProfile({
      profileId,
      fromSessionId: brandSessionId('bot-a'),
      toSessionId: brandSessionId('bot-b'),
      mode: 'lease-transfer',
    })
    expect(transferred.writer.tag).toBe('leased')
    if (transferred.writer.tag !== 'leased') return
    expect(String(transferred.writer.sessionId)).toBe('bot-b')
    const again = await computer.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-b'),
    })
    expect(String(again.writer.sessionId)).toBe('bot-b')
  })

  it('clones a profile snapshot into an independent lease', async () => {
    const computer = await open(tempRoot())
    const profileId = brandProfileId('shared')
    await computer.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-a'),
    })
    const cloned = await computer.handoffProfile({
      profileId,
      fromSessionId: brandSessionId('bot-a'),
      toSessionId: brandSessionId('bot-b'),
      mode: 'snapshot-clone',
    })
    expect(cloned.profileId).not.toBe(profileId)
    expect(cloned.writer.tag).toBe('leased')
    if (cloned.writer.tag !== 'leased') return
    expect(String(cloned.writer.sessionId)).toBe('bot-b')
    const original = await computer.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-a'),
    })
    expect(String(original.writer.sessionId)).toBe('bot-a')
  })

  it('surfaces interrupted work after an unclean child exit and does not resume it', async () => {
    const root = tempRoot()
    const child = Bun.spawn(['bun', join(import.meta.dir, 'crash-child.ts')], {
      env: {
        ...process.env,
        KATA_DATA_ROOT: root,
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
        KATA_COMPUTER_KIND: 'self-hosted-headless',
        KATA_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await child.exited
    expect(code).toBe(9)
    const computer = await open(root)
    const recovery = await computer.reconcileRecovery()
    const crashed = recovery.find((item) => item.sessionId === 'sess-crash')
    expect(crashed).toEqual({ sessionId: 'sess-crash', action: 'surface', from: 'interrupted' })
    expect(recovery.some((item) => item.sessionId === 'sess-crash' && item.action === 'resume')).toBe(false)
  })

  it('keeps Bot A files under the data root after restart', async () => {
    const root = tempRoot()
    const first = await open(root)
    const marker = join(first.layout.workspacesDir, 'bot-a.txt')
    writeFileSync(marker, 'shared-by-bots')
    const computerId = first.identity.computerId
    await first.shutdown({ reason: 'drain', timeoutMs: 1_000 })
    computers.splice(computers.indexOf(first), 1)

    const second = await open(root)
    expect(second.identity.computerId).toBe(computerId)
    expect(readFileSync(join(second.layout.workspacesDir, 'bot-a.txt'), 'utf8')).toBe('shared-by-bots')
    expect(second.layout.worktreesDir.startsWith(root)).toBe(true)
  })

  it('drops profile leases on restart so another Bot can write', async () => {
    const root = tempRoot()
    const first = await open(root)
    const profileId = brandProfileId('shared')
    await first.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-a'),
    })
    await first.shutdown({ reason: 'drain', timeoutMs: 1_000 })
    computers.splice(computers.indexOf(first), 1)

    const second = await open(root)
    const leased = await second.acquireProfileLease({
      profileId,
      sessionId: brandSessionId('bot-b'),
    })
    expect(leased.writer.tag).toBe('leased')
    if (leased.writer.tag !== 'leased') return
    expect(String(leased.writer.sessionId)).toBe('bot-b')
  })

  it('resumes checkpointed shutdown work and never silent-replays it as new work', async () => {
    const root = tempRoot()
    const first = await open(root)
    writeFileSync(
      join(first.layout.shutdownDir, 'checkpointed.json'),
      `${JSON.stringify({ kind: 'checkpointed', domain: 'session', ref: 'sess-ok' })}\n`,
    )
    await first.shutdown({ reason: 'drain', timeoutMs: 1_000 })
    computers.splice(computers.indexOf(first), 1)

    const second = await open(root)
    const recovery = await second.reconcileRecovery()
    expect(recovery).toContainEqual({ sessionId: 'sess-ok', action: 'resume', from: 'checkpointed' })
    expect(recovery.some((item) => item.sessionId === 'sess-ok' && item.action === 'surface')).toBe(false)
  })
})
