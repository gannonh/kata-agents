import {
  SPAWN_TASK_LIMITS,
  type SpawnTaskIntegrityView,
  type SpawnTaskResultChunkView,
} from '@kata-sh/core'

type ReadChunk = (
  offset: number,
  limit: number,
) => Promise<SpawnTaskResultChunkView | SpawnTaskIntegrityView>

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The handoff result read was aborted', 'AbortError')
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export async function readCompleteHandoffResult(
  readChunk: ReadChunk,
  expected: { byteLength: number; sha256: string },
  signal?: AbortSignal,
): Promise<string> {
  if (expected.byteLength > SPAWN_TASK_LIMITS.resultBytes) throw new Error('Handoff result exceeds the durable byte limit')
  const output = new Uint8Array(expected.byteLength)
  let offset = 0

  while (true) {
    throwIfAborted(signal)
    const response = await readChunk(offset, SPAWN_TASK_LIMITS.resultReadBytes)
    throwIfAborted(signal)
    if ('integrityError' in response) throw new Error(response.integrityError.message)
    if (
      response.offset !== offset
      || response.totalByteLength !== expected.byteLength
      || response.sha256 !== expected.sha256
    ) throw new Error('Handoff result changed while it was being read')

    const bytes = decodeBase64(response.dataBase64)
    if (bytes.byteLength !== response.byteLength || response.nextOffset !== offset + bytes.byteLength) {
      throw new Error('Handoff result chunk is inconsistent')
    }
    output.set(bytes, offset)
    offset = response.nextOffset
    if (offset === expected.byteLength) return new TextDecoder().decode(output)
    if (offset > expected.byteLength || bytes.byteLength === 0) throw new Error('Handoff result chunk made no progress')
  }
}
