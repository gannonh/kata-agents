import { describe, expect, it } from 'bun:test'
import type { SpawnTaskIntegrityView, SpawnTaskResultChunkView } from '@kata-sh/core'
import { readCompleteHandoffResult } from './result-reader'

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Buffer.from(digest).toString('hex')
}

describe('readCompleteHandoffResult', () => {
  it('joins bounded byte chunks into the complete UTF-8 result', async () => {
    const text = `${'reviewed '.repeat(700)}✓`
    const bytes = Buffer.from(text, 'utf8')
    const sha256 = await sha256Hex(bytes)
    const read = async (offset: number, limit: number): Promise<SpawnTaskResultChunkView> => {
      const end = Math.min(offset + Math.min(limit, 997), bytes.byteLength)
      const chunk = bytes.subarray(offset, end)
      return {
        taskId: 'task_1',
        offset,
        nextOffset: end,
        byteLength: chunk.byteLength,
        totalByteLength: bytes.byteLength,
        sha256,
        dataBase64: chunk.toString('base64'),
        truncated: end < bytes.byteLength,
      }
    }

    await expect(readCompleteHandoffResult(read, { byteLength: bytes.byteLength, sha256 })).resolves.toBe(text)
  })

  it('rejects an integrity response instead of rendering partial data', async () => {
    const read = async (): Promise<SpawnTaskIntegrityView> => ({
      taskId: 'task_1',
      runtimeState: 'completed',
      result: {
        artifactPath: 'result.md',
        byteLength: 10,
        sha256: 'digest',
        preview: 'partial',
        committedAt: '2026-08-28T00:00:00.000Z',
      },
      integrityError: {
        code: 'result_persist_failed',
        message: 'Result integrity check failed.',
        detectedAt: '2026-08-28T00:00:00.000Z',
      },
    })

    await expect(readCompleteHandoffResult(read, { byteLength: 10, sha256: 'digest' }))
      .rejects.toMatchObject({ code: 'integrity_failed' })
  })

  it('rejects corrupt assembled bytes even when chunk metadata matches', async () => {
    const expected = Buffer.from('expected', 'utf8')
    const corrupt = Buffer.from('corrupt!', 'utf8')
    const sha256 = await sha256Hex(expected)
    const read = async (): Promise<SpawnTaskResultChunkView> => ({
      taskId: 'task_1',
      offset: 0,
      nextOffset: corrupt.byteLength,
      byteLength: corrupt.byteLength,
      totalByteLength: expected.byteLength,
      sha256,
      dataBase64: corrupt.toString('base64'),
      truncated: false,
    })

    await expect(readCompleteHandoffResult(read, { byteLength: expected.byteLength, sha256 }))
      .rejects.toMatchObject({ code: 'integrity_failed' })
  })

  it('stops before requesting another chunk after cancellation', async () => {
    const controller = new AbortController()
    let calls = 0
    const read = async (): Promise<SpawnTaskResultChunkView> => {
      calls += 1
      controller.abort()
      return {
        taskId: 'task_1',
        offset: 0,
        nextOffset: 2,
        byteLength: 2,
        totalByteLength: 4,
        sha256: 'digest',
        dataBase64: 'b2s=',
        truncated: true,
      }
    }

    await expect(readCompleteHandoffResult(read, { byteLength: 4, sha256: 'digest' }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toBe(1)
  })
})
