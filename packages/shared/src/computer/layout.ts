import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  CURRENT_LAYOUT_VERSION,
  brandComputerId,
  brandLayoutVersion,
  type ComputerId,
  type DataRootLayout,
  type LayoutOpenResult,
} from './types.ts'

export function layoutForRoot(root: string): DataRootLayout {
  const absolute = resolve(root)
  return {
    version: CURRENT_LAYOUT_VERSION,
    root: absolute,
    manifestPath: join(absolute, 'computer', 'manifest.json'),
    recordPath: join(absolute, 'computer', 'record.json'),
    shutdownDir: join(absolute, 'computer', 'shutdown'),
    configPath: join(absolute, 'config.json'),
    credentialsPath: join(absolute, 'credentials.enc'),
    worktreesDir: join(absolute, 'worktrees'),
    workspacesDir: join(absolute, 'workspaces'),
    browserProfilesDir: join(absolute, 'browser', 'profiles'),
    browserDisplaysDir: join(absolute, 'browser', 'displays'),
    browserLocksDir: join(absolute, 'browser', 'locks'),
  }
}

function ensureLayoutDirs(layout: DataRootLayout): void {
  for (const dir of [
    join(layout.root, 'computer'),
    layout.shutdownDir,
    layout.worktreesDir,
    layout.workspacesDir,
    layout.browserProfilesDir,
    layout.browserDisplaysDir,
    layout.browserLocksDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
}

function parseManifest(path: string): LayoutOpenResult | { tag: 'ok'; computerId: ComputerId } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { tag: 'corrupt', reason: 'manifest unreadable', path }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { tag: 'corrupt', reason: 'manifest is not JSON', path }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tag: 'corrupt', reason: 'manifest is not an object', path }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.layoutVersion !== 'number' || !Number.isInteger(record.layoutVersion)) {
    return { tag: 'corrupt', reason: 'manifest layoutVersion missing', path }
  }
  if (record.layoutVersion !== CURRENT_LAYOUT_VERSION) {
    return {
      tag: 'incompatible',
      found: brandLayoutVersion(record.layoutVersion),
      supported: [CURRENT_LAYOUT_VERSION],
    }
  }
  if (typeof record.computerId !== 'string' || record.computerId.length === 0) {
    return { tag: 'corrupt', reason: 'manifest computerId missing', path }
  }
  return { tag: 'ok', computerId: brandComputerId(record.computerId) }
}

export function openDataRootLayout(root: string): LayoutOpenResult {
  const layout = layoutForRoot(root)

  if (existsSync(layout.root) && !statSync(layout.root).isDirectory()) {
    return { tag: 'corrupt', reason: 'data root is not a directory', path: layout.root }
  }

  if (existsSync(layout.manifestPath)) {
    const parsed = parseManifest(layout.manifestPath)
    if (parsed.tag !== 'ok') return parsed
    ensureLayoutDirs(layout)
    return { tag: 'opened', layout, created: false, computerId: parsed.computerId }
  }

  mkdirSync(layout.root, { recursive: true })
  ensureLayoutDirs(layout)
  const computerId = brandComputerId(randomUUID())
  writeFileSync(
    layout.manifestPath,
    `${JSON.stringify({
      layoutVersion: CURRENT_LAYOUT_VERSION,
      computerId,
    }, null, 2)}\n`,
    'utf8',
  )
  return { tag: 'opened', layout, created: true, computerId }
}
