import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, utimesSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDurableLock, withDurableLock, writeDurableFile } from './durable-fs.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable locks', () => {
  it('fences an old owner from removing a replacement lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-fs-'))
    roots.push(root)
    const lock = join(root, 'resource.lock')

    withDurableLock(lock, (oldToken) => {
      rmSync(lock, { recursive: true, force: true })
      mkdirSync(lock)
      writeDurableFile(join(lock, 'owner.json'), JSON.stringify({ token: 'replacement', pid: process.pid, acquiredAt: Date.now() }))
      expect(() => assertDurableLock(lock, oldToken)).toThrow('Durable lock lost')
    })

    expect(() => assertDurableLock(lock, 'replacement')).not.toThrow()
  })

  it('reclaims a stale lock and rejects a live lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-fs-'))
    roots.push(root)
    const lock = join(root, 'resource.lock')
    const oldToken = 'old-lock-token'
    mkdirSync(lock, { recursive: true })
    writeDurableFile(join(lock, 'owner.json'), JSON.stringify({ token: oldToken, pid: 99_999_999, acquiredAt: Date.now() - 60_000 }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    expect(withDurableLock(lock, () => 'reclaimed')).toBe('reclaimed')
    mkdirSync(lock)
    expect(() => withDurableLock(lock, () => undefined)).toThrow('Durable lock is busy')
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock, { recursive: true })
    writeDurableFile(join(lock, 'owner.json'), JSON.stringify({ token: 'live-lock-token', pid: process.pid, acquiredAt: Date.now() }))
    expect(() => withDurableLock(lock, () => undefined)).toThrow('Durable lock is busy')
  })

  it('reclaims stale malformed lock metadata but keeps fresh malformed locks busy', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-fs-'))
    roots.push(root)
    const lock = join(root, 'resource.lock')
    mkdirSync(lock, { recursive: true })
    writeDurableFile(join(lock, 'owner.json'), JSON.stringify({ token: '', pid: 'bad', acquiredAt: 'bad' }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    expect(withDurableLock(lock, () => 'reclaimed')).toBe('reclaimed')
    mkdirSync(lock)
    writeDurableFile(join(lock, 'owner.json'), '{}')
    expect(() => withDurableLock(lock, () => undefined)).toThrow('Durable lock is busy')
  })
})
