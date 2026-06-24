import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMainModule, readStdin } from './index.ts'

// ---------------------------------------------------------------------------
// The published CLI bundle (dist/cli.cjs) must run under plain Node.js — no
// Bun-only runtime APIs in CLI source. These guard against reintroducing them.
// ---------------------------------------------------------------------------

const CLI_SOURCE_FILES = ['index.ts', 'server-spawner.ts'] as const
const FORBIDDEN_BUN_API = [
  'Bun.stdin',
  'Bun.file',
  'Bun.serve',
  'Bun.password',
  'Bun.spawn',
  'import.meta.main',
] as const

describe('CLI Node-compatibility (no Bun-only APIs in source)', () => {
  for (const file of CLI_SOURCE_FILES) {
    describe(file, () => {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')

      for (const symbol of FORBIDDEN_BUN_API) {
        it(`does not use ${symbol}`, () => {
          // Strip full-line comments so doc mentions don't trip the guard.
          const codeOnly = source
            .split('\n')
            .filter((line) => {
              const t = line.trim()
              return !t.startsWith('//') && !t.startsWith('*')
            })
            .join('\n')
          expect(codeOnly).not.toContain(symbol)
        })
      }
    })
  }
})

describe('isMainModule', () => {
  it('is false when imported by a test (never runs main() during import)', () => {
    // This test module imports index.ts; if isMainModule() were true it would
    // have launched main() and likely exited the process before tests run.
    expect(isMainModule()).toBe(false)
  })
})

describe('readStdin', () => {
  it('is an async function reading process.stdin (Bun.stdin reintroduction is source-scanned above)', () => {
    // readStdin reads process.stdin, portable across Bun and Node. The actual
    // piping behavior is validated end-to-end by the bundle smoke + live-server
    // send --stdin check; here we assert the contract exists, and the source
    // scan above guarantees no Bun.stdin sneaks back in.
    expect(typeof readStdin).toBe('function')
  })
})
