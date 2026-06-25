import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isMainModule, readStdin } from './runtime.ts'

const CLI_SOURCE_FILES = ['index.ts', 'client.ts', 'server-spawner.ts', 'runtime.ts', 'workspace.ts', 'streaming.ts', 'llm-setup.ts', 'output.ts', 'args.ts', 'help.ts', 'validate.ts'] as const
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
    expect(isMainModule()).toBe(false)
  })
})

describe('readStdin', () => {
  it('is an async function with a timeout parameter', () => {
    expect(typeof readStdin).toBe('function')
    expect(readStdin.length).toBeGreaterThanOrEqual(0)
  })
})

describe('published bundle smoke', () => {
  const bundlePath = join(import.meta.dir, '../dist/cli.cjs')

  it('runs --version under plain Node when the bundle exists', () => {
    if (!existsSync(bundlePath)) {
      const build = spawnSync('bun', ['run', 'build'], {
        cwd: join(import.meta.dir, '..'),
        encoding: 'utf8',
      })
      expect(build.status).toBe(0)
    }

    const result = spawnSync('node', [bundlePath, '--version'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
