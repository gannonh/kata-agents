import type { PlatformServices } from '../runtime/platform'
import type { GitServices, GitStatusSubscription } from '../git'
import type { Computer } from '../computer/computer.ts'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry
  /**
   * Server-owned Git domain (repository/ref discovery, managed worktrees,
   * mutation lock). Optional: handlers fall back to the lazily-constructed
   * default services rooted under the Kata config directory when unset, so
   * both the git RPC handlers and SessionManager share one registry instance.
   */
  gitServices?: GitServices
  /**
   * Coalesced Git status subscription, populated by `registerGitHandlers`.
   * Exposed so app-issued Git mutations (Phase 3) and agent turn completion can
   * request an immediate status refresh instead of waiting for the poll tick.
   */
  gitStatusSubscription?: GitStatusSubscription
  computer?: Computer
}
