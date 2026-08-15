/**
 * Tests for browser handler broadcast + LIST.
 *
 * Workspace isolation contract: enforced renderer-side via
 * filterInstancesForWorkspace (which handles both the local and remote-mirror
 * workspace ids). The server-side handler broadcasts every event to all
 * locally-connected renderers and returns the full instance list from LIST.
 *
 * The reason: a renderer's transport-level workspaceId is always the *local*
 * Kata Agents window's id (set by updateClientWorkspace), but remote-bridged
 * tabs are stamped with the *remote* server's workspaceId. A workspace-scoped
 * broadcast or LIST filter would silently drop those events because the two
 * ids never match. The renderer knows both ids and filters correctly.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { BrowserInstanceInfo } from '@kata-sh/shared/protocol'

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  app: { isReady: () => false, getPath: () => '/tmp/mock-userData' },
  session: { fromPartition: () => ({}) },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
}

function makeServer(): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, handlers, pushes }
}

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
  captureAnnotationCb?: (cb: (state: import('@kata-sh/shared/protocol').BrowserAnnotationState) => void) => void
  setAnnotateMode?: (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; reason: 'not-ready' }>
  cancelAnnotate?: (id: string) => void
  cancelPendingAnnotation?: (id: string) => void
  deleteAnnotation?: (id: string, annotationId: string) => boolean
  clearAnnotations?: (id: string) => void
  getAnnotationState?: (id: string) => import('@kata-sh/shared/protocol').BrowserAnnotationState
}): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: false,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
      onAnnotationStateChange: (
        cb: (state: import('@kata-sh/shared/protocol').BrowserAnnotationState) => void,
      ) => opts.captureAnnotationCb?.(cb),
      setAnnotateMode: opts.setAnnotateMode ?? (async () => ({ ok: true })),
      cancelAnnotate: opts.cancelAnnotate ?? (() => {}),
      cancelPendingAnnotation: opts.cancelPendingAnnotation ?? (() => {}),
      deleteAnnotation: opts.deleteAnnotation ?? (() => false),
      clearAnnotations: opts.clearAnnotations ?? (() => {}),
      getAnnotationState: opts.getAnnotationState ?? ((id: string) => ({
        instanceId: id,
        mode: 'idle' as const,
        annotations: [],
        pendingLabel: null,
      })),
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('always broadcasts to all renderers (workspace-aware-filtering happens in the renderer)', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      expect(captured).not.toBeNull()
      // Workspace-stamped instance broadcasts to all (renderer will filter).
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })

      // Unbound instance also broadcasts to all.
      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })
  })

  describe('REMOVED / INTERACTED stay broadcast-to-all', () => {
    it('REMOVED uses { to: "all" } even when the entry was workspace-scoped', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureRemovedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-removed')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      // Payload is id-only — workspaces that never saw the entry simply no-op.
      expect(recorder.pushes[0].args).toEqual(['b-removed'])
    })

    it('INTERACTED uses { to: "all" }', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureInteractedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-interacted')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
    })
  })

  describe('LIST handler', () => {
    function callListHandler(workspaceId: string | null): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler({ clientId: 'c1', workspaceId, webContentsId: null }) as BrowserInstanceInfo[]
    }

    it('returns ALL instances regardless of ctx.workspaceId (renderer filters)', async () => {
      // The server-side filter is intentionally absent: ctx.workspaceId is the
      // local Kata Agents window's workspace id, but remote-bridged tabs are
      // stamped with the remote server's workspace id. Filtering here would
      // hide those tabs. The renderer applies filterInstancesForWorkspace,
      // which accepts both ids.
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
      expect(callListHandler(null).map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
    })
  })

  describe('annotation RPCs', () => {
    it('broadcasts annotation state to all renderers', async () => {
      let captured: ((state: import('@kata-sh/shared/protocol').BrowserAnnotationState) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureAnnotationCb: (cb) => { captured = cb },
        }),
      )

      captured!({
        instanceId: 'b-1',
        mode: 'selecting',
        annotations: [],
        pendingLabel: null,
      })

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].channel).toBe('browser-pane:annotation-state-changed')
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      expect(recorder.pushes[0].args[0]).toEqual({
        instanceId: 'b-1',
        mode: 'selecting',
        annotations: [],
        pendingLabel: null,
      })
    })

    it('hydrates list-annotations with the full instance state', async () => {
      const state = {
        instanceId: 'b-1',
        mode: 'composing' as const,
        annotations: [],
        pendingLabel: 'Submit',
      }
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          getAnnotationState: (id) => ({ ...state, instanceId: id }),
        }),
      )
      const handler = recorder.handlers.get('browser-pane:list-annotations')
      expect(handler).toBeDefined()
      expect(handler!({ clientId: 'c1', workspaceId: 'ws-1', webContentsId: null }, 'b-1')).toEqual(state)
    })
  })
})
