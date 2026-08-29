import {
  SPAWN_TASK_LIMITS,
  type SpawnTaskIntegrityView,
  type SpawnTaskResultChunkView,
} from '@kata-sh/core'

type ReadChunk = (
  offset: number,
  limit: number,
) => Promise<SpawnTaskResultChunkView | SpawnTaskIntegrityView>

export type HandoffResultReadErrorCode =
  | 'changed'
  | 'chunk_inconsistent'
  | 'integrity_failed'
  | 'no_progress'
  | 'too_large'

export class HandoffResultReadError extends Error {
  constructor(readonly code: HandoffResultReadErrorCode) {
    super(code)
    this.name = 'HandoffResultReadError'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The handoff result read was aborted', 'AbortError')
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function readCompleteHandoffResult(
  readChunk: ReadChunk,
  expected: { byteLength: number; sha256: string },
  signal?: AbortSignal,
): Promise<string> {
  if (expected.byteLength > SPAWN_TASK_LIMITS.resultBytes) throw new HandoffResultReadError('too_large')
  const output = new Uint8Array(expected.byteLength)
  let offset = 0

  while (true) {
    throwIfAborted(signal)
    const response = await readChunk(offset, SPAWN_TASK_LIMITS.resultReadBytes)
    throwIfAborted(signal)
    if ('integrityError' in response) throw new HandoffResultReadError('integrity_failed')
    if (
      response.offset !== offset
      || response.totalByteLength !== expected.byteLength
      || response.sha256 !== expected.sha256
    ) throw new HandoffResultReadError('changed')

    const bytes = decodeBase64(response.dataBase64)
    if (bytes.byteLength !== response.byteLength || response.nextOffset !== offset + bytes.byteLength) {
      throw new HandoffResultReadError('chunk_inconsistent')
    }
    output.set(bytes, offset)
    offset = response.nextOffset
    if (offset === expected.byteLength) {
      if (await sha256Hex(output) !== expected.sha256) throw new HandoffResultReadError('integrity_failed')
      return new TextDecoder().decode(output)
    }
    if (offset > expected.byteLength || bytes.byteLength === 0) throw new HandoffResultReadError('no_progress')
  }
}
