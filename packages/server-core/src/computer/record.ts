import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  ComputerIdentity,
  ComputerKind,
  ComputerReadiness,
  DataRootLayout,
} from '@kata-sh/shared/computer'
import { brandComputerId } from '@kata-sh/shared/computer'
import { ComputerLayoutError } from './errors.ts'

export interface ComputerRecord {
  computerId: string
  kind: ComputerKind
  osAccount: string
  createdAt: string
  appVersion: string
  shutdownEpoch: number
  unclean: boolean
  lastReadiness: ComputerReadiness | null
}

export function loadComputerRecord(layout: DataRootLayout): ComputerRecord | null {
  if (!existsSync(layout.recordPath)) return null
  const raw = readFileSync(layout.recordPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ComputerLayoutError({
      tag: 'corrupt',
      reason: 'computer record is not JSON',
      path: layout.recordPath,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ComputerLayoutError({
      tag: 'corrupt',
      reason: 'computer record is not an object',
      path: layout.recordPath,
    })
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.computerId !== 'string' || record.computerId.trim().length === 0) {
    throw new ComputerLayoutError({
      tag: 'corrupt',
      reason: 'computer record computerId missing',
      path: layout.recordPath,
    })
  }
  return {
    computerId: record.computerId,
    kind: record.kind === 'self-hosted-headless' ? 'self-hosted-headless' : 'local-client',
    osAccount: typeof record.osAccount === 'string' ? record.osAccount : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : '',
    shutdownEpoch: typeof record.shutdownEpoch === 'number' ? record.shutdownEpoch : 0,
    unclean: record.unclean === true,
    lastReadiness: (record.lastReadiness as ComputerReadiness | null) ?? null,
  }
}

export function writeComputerRecord(layout: DataRootLayout, record: ComputerRecord): void {
  writeFileSync(layout.recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

export function identityFromRecord(
  record: ComputerRecord,
  kind: ComputerKind,
  dataRoot: string,
): ComputerIdentity {
  return {
    computerId: brandComputerId(record.computerId),
    kind,
    dataRoot,
    osAccount: record.osAccount,
    createdAt: record.createdAt,
  }
}
