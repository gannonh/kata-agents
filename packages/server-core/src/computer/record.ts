import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  ComputerIdentity,
  ComputerKind,
  ComputerReadiness,
  DataRootLayout,
} from '@kata-sh/shared/computer'
import { brandComputerId } from '@kata-sh/shared/computer'

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
  const parsed = JSON.parse(readFileSync(layout.recordPath, 'utf8')) as Record<string, unknown>
  if (typeof parsed.computerId !== 'string' || parsed.computerId.length === 0) {
    throw new Error(`computer record is corrupt: ${layout.recordPath}`)
  }
  return {
    computerId: parsed.computerId,
    kind: parsed.kind === 'self-hosted-headless' ? 'self-hosted-headless' : 'local-client',
    osAccount: typeof parsed.osAccount === 'string' ? parsed.osAccount : '',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    shutdownEpoch: typeof parsed.shutdownEpoch === 'number' ? parsed.shutdownEpoch : 0,
    unclean: parsed.unclean === true,
    lastReadiness: (parsed.lastReadiness as ComputerReadiness | null) ?? null,
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
