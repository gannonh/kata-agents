import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

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
if (!bundle.includes('registerBunOAuthFlows')) {
  throw new Error('Generated Pi agent server bundle does not register bundled Pi OAuth flows.')
}

const syntaxCheck = Bun.spawnSync(['node', '--check', bundlePath])
if (syntaxCheck.exitCode !== 0) {
  throw new Error('Generated Pi agent server bundle failed node --check.')
}

const smokeRoot = mkdtempSync(join(tmpdir(), 'kata-pi-oauth-smoke-'))
const smokeOutput: string[] = []
const smokeProcess = spawn(process.execPath, [bundlePath], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

try {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let sawExpectedAuthFailure = false
    let shutdownRequested = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      fail(new Error(`Bundled Pi OAuth smoke test timed out. Output:\n${smokeOutput.join('')}`))
    }, 15_000)

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolve()
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      smokeProcess.kill()
      reject(error)
    }

    const requestShutdown = () => {
      if (shutdownRequested) return
      shutdownRequested = true
      try {
        smokeProcess.stdin.write('{"type":"shutdown"}\n')
        smokeProcess.stdin.end()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      forceKillTimer = setTimeout(() => {
        fail(new Error(`Bundled Pi OAuth smoke test did not exit after shutdown. Output:\n${smokeOutput.join('')}`))
      }, 3_000)
    }

    const record = (chunk: Buffer) => {
      const text = chunk.toString()
      smokeOutput.push(text)
      const output = smokeOutput.join('')
      if (output.includes('Cannot find module') || output.includes('No API key found')) {
        fail(new Error(`Bundled Pi OAuth loader failed:\n${output}`))
      } else if (output.includes('Failed to extract accountId from token')) {
        // The fake token reached Pi's Codex auth derivation. This confirms the
        // bundled OAuth loader resolved before the expected fake-token failure.
        sawExpectedAuthFailure = true
        requestShutdown()
      }
    }

    smokeProcess.stdout.on('data', record)
    smokeProcess.stderr.on('data', record)
    smokeProcess.on('error', (error) => fail(error))
    smokeProcess.on('close', (code, signal) => {
      if (settled) return
      if (!sawExpectedAuthFailure) {
        fail(new Error(`Bundled Pi OAuth smoke test exited before auth derivation (code=${code}, signal=${signal}). Output:\n${smokeOutput.join('')}`))
      } else if (code !== 0) {
        fail(new Error(`Bundled Pi OAuth smoke test exited unsuccessfully (code=${code}, signal=${signal}). Output:\n${smokeOutput.join('')}`))
      } else {
        finish()
      }
    })

    const init = {
      type: 'init',
      apiKey: '',
      model: 'gpt-5.6-luna',
      cwd: smokeRoot,
      thinkingLevel: 'off',
      workspaceRootPath: smokeRoot,
      sessionId: 'oauth-smoke',
      sessionPath: smokeRoot,
      workingDirectory: smokeRoot,
      plansFolderPath: smokeRoot,
      providerType: 'pi',
      authType: 'oauth',
      piAuth: {
        provider: 'openai-codex',
        credential: {
          type: 'oauth',
          access: 'not-a-jwt',
          refresh: 'fake-refresh-token',
          expires: Date.now() + 3_600_000,
        },
      },
    }
    smokeProcess.stdin.write(`${JSON.stringify(init)}\n`)
    smokeProcess.stdin.write(`${JSON.stringify({
      type: 'prompt',
      id: 'oauth-smoke',
      message: 'Say ok',
      systemPrompt: 'Reply briefly.',
    })}\n`)
  })
} finally {
  rmSync(smokeRoot, { recursive: true, force: true })
}

console.log(`Pi agent server bundle smoke check passed: ${bundlePath}`)
