#!/usr/bin/env node
/**
 * kata-agents-cli — Terminal client for Kata Agent server.
 */

import { resolve } from 'path'
import {
  buildAgentsCliInvokeArgs,
  isWorkspaceScopedInvokeChannel,
} from '@kata-sh/shared/config/agents-cli-invoke'
import { CliRpcClient } from './client.ts'
import { parseArgs, type CliArgs } from './args.ts'
import { out, err } from './output.ts'
import { isMainModule } from './runtime.ts'
import { printHelp } from './help.ts'
import { resolveWorkspace, requireWorkspace } from './workspace.ts'
import { readPrompt, sendAndStream } from './streaming.ts'
import { setupLlmConnection, shouldSetupLlmConnection } from './llm-setup.ts'
import { runValidation } from './validate.ts'

async function cmdPing(client: CliRpcClient, args: CliArgs): Promise<void> {
  const start = performance.now()
  const clientId = await client.connect()
  const latency = Math.round(performance.now() - start)
  out(
    args.json
      ? { clientId, latencyMs: latency }
      : `Connected: clientId=${clientId} latency=${latency}ms`,
    args.json,
  )
}

async function cmdHealth(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('credentials:healthCheck')
  out(result, args.json)
}

async function cmdVersions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('system:versions')
  out(result, args.json)
}

async function cmdWorkspaces(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = (await client.invoke('workspaces:get')) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No workspaces found', false)
      return
    }
    for (const ws of result) {
      out(`${ws.id}  ${ws.name ?? '(unnamed)'}  ${ws.path ?? ''}`, false)
    }
  }
}

async function cmdSessions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await requireWorkspace(client, args.workspace)
  const result = (await client.invoke('sessions:get', workspaceId)) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No sessions found', false)
      return
    }
    for (const s of result) {
      const name = s.name ?? '(unnamed)'
      const preview = s.preview ? `  ${s.preview.slice(0, 60)}` : ''
      const status = s.isProcessing ? ' [processing]' : ''
      out(`${s.id}  ${name}${preview}${status}`, false)
    }
  }
}

async function cmdConnections(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('LLM_Connection:list')
  out(result, args.json)
}

async function cmdSources(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await requireWorkspace(client, args.workspace)
  const result = await client.invoke('sources:get', workspaceId)
  out(result, args.json)
}

async function cmdSessionCreate(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await requireWorkspace(client, args.workspace)

  // Parse sub-args: --name <n>
  let name: string | undefined
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') name = args.rest[++i]
  }

  const opts: Record<string, unknown> = {}
  if (name) opts.name = name
  if (args.mode) opts.permissionMode = args.mode

  const result = await client.invoke('sessions:create', workspaceId, opts)
  out(result, args.json)
}

async function cmdSessionMessages(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session messages <session-id>')
    process.exit(1)
  }
  await client.connect()
  const result = await client.invoke('sessions:getMessages', sessionId)
  out(result, args.json)
}

async function cmdSessionDelete(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session delete <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:delete', sessionId)
  out(args.json ? { deleted: sessionId } : `Deleted session: ${sessionId}`, args.json)
}

/**
 * Read prompt text from positional args + stdin.
 * If there are positional words, they become the base message.
 * Reads stdin when: --stdin flag is present, or no message and stdin is piped (not a TTY).
 */
async function cmdSend(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: send <session-id> <message>')
    process.exit(1)
  }

  const message = await readPrompt(args.rest.slice(1), args.rest)
  if (!message.trim()) {
    err('No message provided')
    process.exit(1)
  }

  await client.connect()
  const exitCode = await sendAndStream(client, sessionId, message, args)
  client.destroy()
  process.exit(exitCode)
}

interface LocalServer {
  client: CliRpcClient
  stop: () => Promise<void>
}

async function spawnLocalServer(args: CliArgs, opts?: { quiet?: boolean }): Promise<LocalServer> {
  const { spawnServer } = await import('./server-spawner.ts')
  process.stderr.write('Starting server...\n')
  const server = await spawnServer({
    serverEntry: args.serverEntry,
    startupTimeout: args.timeout > 30_000 ? args.timeout : 30_000,
    quiet: opts?.quiet,
  })
  process.stderr.write(`Server ready: ${server.url}\n`)
  const client = new CliRpcClient(server.url, {
    token: server.token,
    requestTimeout: args.timeout,
  })
  return { client, stop: server.stop }
}


async function cmdRun(args: CliArgs): Promise<void> {
  // Prompt = all positional args (no session ID needed, unlike send)
  const message = await readPrompt(args.rest, args.rest)
  if (!message.trim()) {
    err('No prompt provided. Usage: run <message>')
    process.exit(1)
  }

  const server = await spawnLocalServer(args)

  let client: CliRpcClient | undefined = server.client
  let sessionId: string | undefined

  const cleanup = async () => {
    if (sessionId && client?.isConnected && !args.noCleanup) {
      await client.invoke('sessions:delete', sessionId).catch(() => {})
    }
    client?.destroy()
    await server.stop()
  }

  // Signal handling — cancel + clean up on SIGINT/SIGTERM
  const onSignal = async () => {
    if (sessionId && client?.isConnected) {
      await client.invoke('sessions:cancel', sessionId).catch(() => {})
    }
    await cleanup()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await client.connect()

    // Bootstrap workspace from directory if specified
    let bootstrappedWorkspaceId: string | undefined
    if (args.workspaceDir) {
      const absPath = resolve(args.workspaceDir)
      const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
      bootstrappedWorkspaceId = ws.id
      process.stderr.write(`Workspace registered: ${absPath}\n`)
    }

    // Auto-setup LLM connection from flags / env vars.
    // When --base-url is provided, always create the custom endpoint connection
    // (even if other connections exist) so the session routes through it.
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    let connectionSlug: string | undefined
    if (shouldSetupLlmConnection(connections?.length ?? 0, args)) {
      const result = await setupLlmConnection(client, args)
      connectionSlug = result.connectionSlug
    }

    const workspaceId = bootstrappedWorkspaceId
      ?? await resolveWorkspace(client, args.workspace)
    if (bootstrappedWorkspaceId) {
      await client.invoke('window:switchWorkspace', bootstrappedWorkspaceId).catch(() => {})
    }
    if (!workspaceId) {
      err('No workspace found on server')
      process.exit(1)
    }

    const session = (await client.invoke('sessions:create', workspaceId, {
      permissionMode: args.mode || 'allow-all',
      enabledSourceSlugs: args.sources.length > 0 ? args.sources : undefined,
    })) as { id: string }
    sessionId = session.id

    if (args.model) {
      await client.invoke('session:setModel', sessionId, workspaceId, args.model, connectionSlug)
    }

    const exitCode = await sendAndStream(client, sessionId, message, args)
    await cleanup()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    await cleanup()
    process.exit(1)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function cmdValidate(args: CliArgs): Promise<void> {
  let server: LocalServer | undefined
  let client: CliRpcClient

  // Use a generous timeout for validation steps — source creation and MCP
  // server startup can be slow on Windows.
  const validateArgs = { ...args, timeout: Math.max(args.timeout, 30_000) }

  if (args.url) {
    client = new CliRpcClient(args.url, {
      token: args.token || undefined,
      requestTimeout: validateArgs.timeout,
      connectTimeout: validateArgs.timeout,
    })
  } else {
    server = await spawnLocalServer(validateArgs, { quiet: !args.verbose })
    client = server.client
  }

  try {
    const exitCode = await runValidation(client, args.json, args.noSpinner, args.workspaceDir, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      provider: args.provider,
    })
    client.destroy()
    if (server) await server.stop()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    client.destroy()
    if (server) await server.stop()
    process.exit(1)
  }
}

async function cmdCancel(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: cancel <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:cancel', sessionId)
  out(args.json ? { cancelled: sessionId } : `Cancelled: ${sessionId}`, args.json)
}

async function cmdInvoke(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: invoke <channel> [json-args...]')
    process.exit(1)
  }
  await client.connect()

  // Parse remaining args as JSON
  const userArgs: unknown[] = []
  for (let i = 1; i < args.rest.length; i++) {
    try {
      userArgs.push(JSON.parse(args.rest[i]))
    } catch {
      userArgs.push(args.rest[i])
    }
  }

  // Workspace-scoped config channels need the active workspace as the first arg.
  const workspaceId = isWorkspaceScopedInvokeChannel(channel)
    ? await requireWorkspace(client, args.workspace)
    : undefined

  const invokeArgs = buildAgentsCliInvokeArgs(channel, userArgs, workspaceId)
  const result = await client.invoke(channel, ...invokeArgs)
  out(result, args.json)
}

async function cmdListen(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: listen <channel>')
    process.exit(1)
  }
  await client.connect()

  client.on(channel, (...eventArgs: unknown[]) => {
    out({ channel, args: eventArgs, timestamp: new Date().toISOString() }, true)
  })

  process.stdout.write(`Listening on ${channel} (Ctrl+C to stop)\n`)

  // Keep alive
  await new Promise(() => {
    // Never resolves — Ctrl+C exits
  })
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  // Set custom CA before any WS connections
  if (args.tlsCa) {
    process.env.NODE_EXTRA_CA_CERTS = args.tlsCa
  }

  if (args.command === 'help' || args.command === '') {
    printHelp()
    return
  }

  if (args.command === 'version') {
    const pkg = await import('../package.json')
    out(pkg.version ?? pkg.default?.version ?? 'unknown', false)
    return
  }

  // run is self-contained — spawns its own server
  if (args.command === 'run') {
    await cmdRun(args)
    return
  }

  // validate can spawn its own server or use --url
  if (args.command === 'validate') {
    await cmdValidate(args)
    return
  }

  // All other commands need a server URL
  if (!args.url) {
    err('No server URL. Use --url <ws://...> or set $KATA_SERVER_URL')
    process.exit(1)
  }

  const client = new CliRpcClient(args.url, {
    token: args.token || undefined,
    workspaceId: args.workspace,
    requestTimeout: args.timeout,
    connectTimeout: args.timeout,
  })

  try {
    switch (args.command) {
      case 'ping':
        await cmdPing(client, args)
        break
      case 'health':
        await cmdHealth(client, args)
        break
      case 'versions':
        await cmdVersions(client, args)
        break
      case 'workspaces':
        await cmdWorkspaces(client, args)
        break
      case 'sessions':
        await cmdSessions(client, args)
        break
      case 'connections':
        await cmdConnections(client, args)
        break
      case 'sources':
        await cmdSources(client, args)
        break
      case 'session': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'create':
            await cmdSessionCreate(client, args)
            break
          case 'messages':
            await cmdSessionMessages(client, args)
            break
          case 'delete':
            await cmdSessionDelete(client, args)
            break
          default:
            err(`Unknown session subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'send':
        await cmdSend(client, args)
        break // cmdSend calls process.exit
      case 'cancel':
        await cmdCancel(client, args)
        break
      case 'invoke':
        await cmdInvoke(client, args)
        break
      case 'listen':
        await cmdListen(client, args)
        break // never returns
      default:
        err(`Unknown command: ${args.command}`)
        printHelp()
        process.exit(1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    process.exit(1)
  } finally {
    client.destroy()
  }
}

// Run if executed directly (not when imported by tests)
if (isMainModule()) {
  main()
}

// Re-exports for tests and downstream consumers
export { parseArgs, type CliArgs } from './args.ts'
export { isMainModule, readStdin } from './runtime.ts'
export { resolveApiKey, shouldSetupLlmConnection } from './llm-setup.ts'
export { getValidateSteps } from './validate.ts'
export { buildAgentsCliInvokeArgs as buildInvokeArgs } from '@kata-sh/shared/config/agents-cli-invoke'
