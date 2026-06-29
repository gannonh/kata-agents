#!/usr/bin/env bun
/**
 * @kata-sh/server — standalone headless Kata Agent server.
 *
 * Usage:
 *   KATA_SERVER_TOKEN=<secret> bun run packages/server/src/index.ts
 *
 * Environment:
 *   KATA_SERVER_TOKEN         — required bearer token for client auth
 *   KATA_RPC_HOST             — bind address (default: 127.0.0.1)
 *   KATA_RPC_PORT             — bind port (default: 9100)
 *   KATA_RPC_TLS_CERT         — path to PEM certificate file (enables TLS/wss)
 *   KATA_RPC_TLS_KEY          — path to PEM private key file (required with cert)
 *   KATA_RPC_TLS_CA           — path to PEM CA chain file (optional)
 *   KATA_APP_ROOT             — app root path (default: cwd)
 *   KATA_RESOURCES_PATH       — resources path (default: cwd/resources)
 *   KATA_IS_PACKAGED          — 'true' for production (default: false)
 *   KATA_VERSION              — app version (default: 0.0.0-dev)
 *   KATA_DEBUG                — 'true' for debug logging
 *   KATA_WEBUI_DIR            — path to built web UI assets (enables web UI on RPC port)
 *   KATA_WEBUI_PASSWORD       — optional shorter password for web login (falls back to KATA_SERVER_TOKEN)
 *   KATA_WEBUI_SECURE_COOKIE  — optional true/false override for the session cookie Secure flag
 *   KATA_WEBUI_WS_URL         — optional browser-facing ws:// or wss:// URL returned by /api/config
 *   KATA_WEBUI_AUTH_URL       — printed at startup: /api/auth/token?token=... one-click login URL
 *   KATA_MESSAGING_WA_WORKER  — absolute path to worker.cjs (default: packages/messaging-whatsapp-worker/dist/worker.cjs)
 *   KATA_MESSAGING_NODE_BIN   — Node binary used to spawn the WhatsApp worker (default: node)
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { version as packageVersion } from '../package.json'
import { enableDebug } from '@kata-sh/shared/utils/debug'
import { bootstrapServer, startHealthHttpServer, generateServerToken } from '@kata-sh/server-core/bootstrap'
import { validateSession, createWebuiHandler, nodeHttpAdapter } from '@kata-sh/server-core/webui'
import type { WebuiHandler } from '@kata-sh/server-core/webui'
import { getCredentialManager } from '@kata-sh/shared/credentials'
import { getWorkspaces } from '@kata-sh/shared/config'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@kata-sh/messaging-gateway'

// --generate-token: print a crypto-random token and exit
if (process.argv.includes('--generate-token')) {
  console.log(generateServerToken())
  process.exit(0)
}
import type { WsRpcTlsOptions } from '@kata-sh/server-core/transport'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@kata-sh/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@kata-sh/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@kata-sh/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@kata-sh/server-core/services'
import type { HandlerDeps } from '@kata-sh/server-core/handlers'

process.env.KATA_IS_PACKAGED ??= 'false'

// Prevent unhandled rejections from crashing the server.
// SDK subprocess abort can reject promises that propagate up unhandled;
// Bun (unlike Node) terminates the process on unhandled rejections by default.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[server] Unhandled rejection (caught, not crashing): ${msg}`)
})

if (process.env.KATA_DEBUG === 'true' || process.env.KATA_DEBUG === '1') {
  enableDebug()
}

function parseOptionalBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false

  console.error(`Invalid ${name}: expected one of true/false/1/0/yes/no/on/off.`)
  process.exit(1)
}

function parseOptionalWebSocketUrl(name: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('must use ws:// or wss://')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Invalid ${name}: ${message}`)
    process.exit(1)
  }
}

// In dev (monorepo), bundled assets root is the repo root (4 levels up from this file).
// In packaged mode, use KATA_BUNDLED_ASSETS_ROOT env or cwd.
const bundledAssetsRoot = process.env.KATA_BUNDLED_ASSETS_ROOT
  ?? join(import.meta.dir, '..', '..', '..', '..')

// TLS configuration — when cert + key paths are provided, server listens on wss://
let tls: WsRpcTlsOptions | undefined
const tlsCertPath = process.env.KATA_RPC_TLS_CERT
const tlsKeyPath = process.env.KATA_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    console.error('TLS requires both KATA_RPC_TLS_CERT and KATA_RPC_TLS_KEY.')
    process.exit(1)
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.KATA_RPC_TLS_CA ? { ca: readFileSync(process.env.KATA_RPC_TLS_CA) } : {}),
  }
}

// Web UI configuration
const webuiDir = process.env.KATA_WEBUI_DIR || undefined
const webuiEnabled = webuiDir && existsSync(webuiDir)
const webuiSecureCookies = parseOptionalBooleanEnv('KATA_WEBUI_SECURE_COOKIE', process.env.KATA_WEBUI_SECURE_COOKIE)
const webuiWsUrl = parseOptionalWebSocketUrl('KATA_WEBUI_WS_URL', process.env.KATA_WEBUI_WS_URL)
const serverToken = process.env.KATA_SERVER_TOKEN

// ---------------------------------------------------------------------------
// Create WebUI handler early so it can be embedded in the WsRpcServer.
// The handler is a pure function — it doesn't need the session manager yet
// because health checks are injected lazily via getHealthCheck().
// ---------------------------------------------------------------------------

let webuiHandler: WebuiHandler | null = null
let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined

// Health check is injected lazily — the session manager isn't ready until
// after bootstrap completes, but the handler captures the closure.
let healthCheckFn: (() => { status: string }) | null = null

if (webuiEnabled && serverToken) {
  const rpcPort = parseInt(process.env.KATA_RPC_PORT ?? '9100', 10)
  const rpcProtocol = tls ? 'wss' as const : 'ws' as const

  webuiHandler = createWebuiHandler({
    webuiDir: webuiDir!,
    secret: serverToken,
    password: process.env.KATA_WEBUI_PASSWORD || undefined,
    secureCookies: webuiSecureCookies,
    publicWsUrl: webuiWsUrl,
    wsProtocol: rpcProtocol,
    // WebUI is served on the same port as WS — wsPort matches the RPC port
    wsPort: rpcPort,
    getHealthCheck: () => healthCheckFn?.() ?? { status: 'starting' },
    logger: { info: console.log, warn: console.warn, error: console.error } as any,
  })

  webuiNodeHandler = nodeHttpAdapter(webuiHandler.fetch)
}

// Resolve WhatsApp worker paths up-front so the helper + Docker env stay in sync.
// The worker is a Node subprocess — Bun cannot run it directly — so we must
// pass an explicit `nodeBin` (Electron defaults nodeBin to process.execPath
// which is correct there but wrong under Bun).
const waWorkerEntry = process.env.KATA_MESSAGING_WA_WORKER
  ?? join(bundledAssetsRoot, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs')
const waNodeBin = process.env.KATA_MESSAGING_NODE_BIN ?? 'node'

// Built inside createHandlerDeps (needs sessionManager), populated with the WS
// publisher after bootstrapServer resolves.
let messagingHandle: MessagingBootstrapHandle | null = null

const instance = await (async () => {
  try {
    return await bootstrapServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      serverVersion: process.env.KATA_VERSION ?? packageVersion,
      tls,
      // When web UI is enabled, accept JWT session cookies on WebSocket upgrade
      validateSessionCookie: webuiEnabled && serverToken
        ? async (cookieHeader) => {
            const session = await validateSession(cookieHeader, serverToken)
            return session !== null
          }
        : undefined,
      // Embed the WebUI HTTP handler on the WS server's port
      httpHandler: webuiNodeHandler,
      applyPlatformToSubsystems: (platform) => {
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {},
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
      },
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const manager = getCredentialManager()
        const [apiKey, oauth] = await Promise.all([
          manager.getLlmApiKey(slug).catch(() => null),
          manager.getLlmOAuth(slug).catch(() => null),
        ])
        return {
          apiKey: apiKey ?? undefined,
          oauthAccessToken: oauth?.accessToken,
          oauthRefreshToken: oauth?.refreshToken,
          oauthIdToken: oauth?.idToken,
        }
      }),
      createSessionManager: () => new SessionManager(),
      bindRpcServer: (sm, server) => sm.setRpcServer(server),
      createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => {
        messagingHandle = createMessagingBootstrap({
          sessionManager,
          credentialManager: getCredentialManager(),
          getMessagingDir: (wsId: string) =>
            join(homedir(), '.kata-agents', 'workspaces', wsId, 'messaging'),
          // Headless has no legacy messaging dir — workspaces start clean.
          whatsapp: {
            workerEntry: waWorkerEntry,
            nodeBin: waNodeBin,
            pairingMode: 'qr',
          },
        })
        return {
          sessionManager,
          platform,
          oauthFlowStore,
          messagingRegistry: messagingHandle.registry,
        }
      },
      registerAllRpcHandlers: registerCoreRpcHandlers,
      setSessionEventSink: (sessionManager, sink) => {
        if (!messagingHandle) {
          // createHandlerDeps always runs before setSessionEventSink, but be
          // defensive in case bootstrapServer's ordering ever changes.
          sessionManager.setEventSink(sink)
          return
        }
        sessionManager.setEventSink(messagingHandle.wrapSink(sink))
      },
      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          sessionManager.cleanup()
        }
      },
      cleanupClientResources: cleanupSessionFileWatchForClient,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

// ---------------------------------------------------------------------------
// Messaging post-bootstrap: bind the WS publisher and initialize local
// workspaces. Remote-owned workspaces are skipped because their messaging
// runs on the remote server.
// ---------------------------------------------------------------------------
if (messagingHandle !== null) {
  const handle: MessagingBootstrapHandle = messagingHandle
  handle.setPublisher(instance.wsServer.push.bind(instance.wsServer))
  try {
    const localWorkspaceIds = getWorkspaces()
      .filter((ws) => !ws.remoteServer)
      .map((ws) => ws.id)
    await handle.initializeWorkspaces(localWorkspaceIds)
  } catch (error) {
    console.error('[messaging] Workspace initialization failed:', error)
  }
}

// Wire up the lazy health check now that the session manager is ready
if (webuiHandler) {
  const { getHealthCheck } = await import('@kata-sh/server-core/handlers/rpc/server')
  const depsLike = { sessionManager: instance.sessionManager } as any
  healthCheckFn = () => getHealthCheck(depsLike)

  // Wire up OAuth callback deps so /api/oauth/callback works
  const { getSourceCredentialManager, loadWorkspaceSources } = await import('@kata-sh/shared/sources')
  const { getWorkspaceByNameOrId } = await import('@kata-sh/shared/config')
  const { pushTyped } = await import('@kata-sh/server-core/transport')
  const { RPC_CHANNELS } = await import('@kata-sh/shared/protocol')

  webuiHandler.setOAuthCallbackDeps({
    flowStore: instance.oauthFlowStore,
    credManager: getSourceCredentialManager(),
    sessionManager: instance.sessionManager,
    pushSourcesChanged: (workspaceId: string) => {
      const ws = getWorkspaceByNameOrId(workspaceId)
      const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
      pushTyped(instance.wsServer, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
    },
  })
}

// Start HTTP health endpoint if KATA_HEALTH_PORT is set
const healthPort = parseInt(process.env.KATA_HEALTH_PORT ?? '0', 10)
const healthServer = await startHealthHttpServer({
  port: healthPort,
  deps: { sessionManager: instance.sessionManager },
  wsServer: instance.wsServer,
  platform: instance.platform,
})

const serverProto = instance.protocol === 'wss' ? 'https' : 'http'
console.log(`KATA_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
console.log(`KATA_SERVER_TOKEN=${instance.token}`)
if (webuiHandler) {
  const webuiHost = instance.host === '0.0.0.0' ? '127.0.0.1' : instance.host
  const webuiUrl = `${serverProto}://${webuiHost}:${instance.port}`
  console.log(`KATA_WEBUI_URL=${webuiUrl}`)
  // When a login password/token is configured, print a one-click authenticated URL.
  // The token is validated by /api/auth/token against the same hash as the login form.
  const authToken = process.env.KATA_WEBUI_PASSWORD || instance.token
  if (authToken) {
    console.log(`KATA_WEBUI_AUTH_URL=${webuiUrl}/api/auth/token?token=${encodeURIComponent(authToken)}`)
  }
}

// Block binding to a non-localhost address without TLS — tokens would be sent in cleartext.
// Override with --allow-insecure-bind for explicitly trusted networks.
const isLocalBind = instance.host === '127.0.0.1' || instance.host === 'localhost' || instance.host === '::1'
if (!isLocalBind && instance.protocol === 'ws') {
  if (process.argv.includes('--allow-insecure-bind')) {
    console.warn(
      '\n⚠️  WARNING: Server is listening on a network address without TLS.\n' +
      '   Authentication tokens will be sent in cleartext.\n' +
      '   Set KATA_RPC_TLS_CERT and KATA_RPC_TLS_KEY to enable wss://.\n'
    )
  } else {
    console.error(
      '\n❌  Refusing to bind to a network address without TLS.\n' +
      '   Authentication tokens would be sent in cleartext.\n\n' +
      '   Options:\n' +
      '     1. Set KATA_RPC_TLS_CERT and KATA_RPC_TLS_KEY to enable wss://\n' +
      '     2. Pass --allow-insecure-bind to override (NOT recommended for production)\n'
    )
    await instance.stop()
    process.exit(1)
  }
}

const shutdown = async () => {
  webuiHandler?.dispose()
  healthServer?.stop()
  if (messagingHandle) {
    try {
      await messagingHandle.dispose()
    } catch (error) {
      console.error('[messaging] dispose failed:', error)
    }
  }
  await instance.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
