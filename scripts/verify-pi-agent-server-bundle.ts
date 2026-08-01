import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const bundlePath = join(import.meta.dir, '..', 'apps', 'electron', 'resources', 'pi-agent-server', 'index.js')

if (!existsSync(bundlePath)) {
  throw new Error(
    `Missing generated Pi agent server bundle at ${bundlePath}. `
    + 'Run `bun run server:build:subprocess && bun apps/electron/scripts/stage-subprocesses.ts` first.',
  )
}

const bundle = readFileSync(bundlePath, 'utf8')
if (!/minimal:\s*["']minimal["']/.test(bundle)) {
  throw new Error('Generated Pi agent server bundle does not contain the minimal thinking mapping.')
}
if (!bundle.includes('set_thinking_level')) {
  throw new Error('Generated Pi agent server bundle does not contain set_thinking_level handling.')
}

const syntaxCheck = Bun.spawnSync(['node', '--check', bundlePath])
if (syntaxCheck.exitCode !== 0) {
  throw new Error('Generated Pi agent server bundle failed node --check.')
}

console.log(`Pi agent server bundle smoke check passed: ${bundlePath}`)
