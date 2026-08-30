import type {
  IBrowserPaneManager,
  AccessibilitySnapshot,
  BrowserConsoleEntry,
  BrowserConsoleOptions,
  BrowserDownloadEntry,
  BrowserDownloadOptions,
  BrowserInstanceSnapshot,
  BrowserKeyArgs,
  BrowserNetworkEntry,
  BrowserNetworkOptions,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
  BrowserWaitArgs,
  BrowserWaitResult,
} from '../handlers/browser-pane-manager-interface'
import type { BrowserInstanceInfo } from '@kata-sh/shared/protocol'

const DEFAULT_UNAVAILABLE = 'Browser automation runs on the server computer. Client-hosted Chromium is not used.'

export class NullBrowserPaneManager implements IBrowserPaneManager {
  constructor(private readonly reason: string = DEFAULT_UNAVAILABLE) {}

  private fail(method: string): never {
    throw new Error(`${method}: ${this.reason}`)
  }

  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {}
  destroyForSession(_sessionId: string): void {}
  async clearVisualsForSession(_sessionId: string): Promise<void> {}
  unbindAllForSession(_sessionId: string): void {}
  getOrCreateForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string {
    return this.fail('getOrCreateForSession')
  }
  async getOrCreateForSessionAsync(_sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return this.fail('getOrCreateForSession')
  }
  setAgentControl(
    _sessionId: string,
    _meta: { displayName?: string; intent?: string },
    _options?: { workspaceId?: string | null },
  ): void {}

  createForSession(_sessionId: string, _options?: { show?: boolean; workspaceId?: string | null }): string {
    return this.fail('createForSession')
  }
  async createForSessionAsync(_sessionId: string, _options?: { show?: boolean; workspaceId?: string | null }): Promise<string> {
    return this.fail('createForSession')
  }
  getInstance(_id: string): BrowserInstanceSnapshot | undefined { return undefined }
  async getInstanceAsync(_id: string): Promise<BrowserInstanceSnapshot | undefined> { return undefined }
  listInstances(): BrowserInstanceInfo[] { return [] }
  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> { return [] }
  focusBoundForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string {
    return this.fail('focusBoundForSession')
  }
  async focusBoundForSessionAsync(_sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return this.fail('focusBoundForSession')
  }
  bindSession(_id: string, _sessionId: string, _options?: { workspaceId?: string | null }): void {
    this.fail('bindSession')
  }
  focus(_id: string): void { this.fail('focus') }
  destroyInstance(_id: string): void {}
  hide(_id: string): void {}
  clearAgentControl(_sessionId: string): void {}
  clearAgentControlForInstance(_instanceId: string, _sessionId?: string): { released: boolean; reason?: string } {
    return { released: false, reason: this.reason }
  }

  async navigate(_id: string, _url: string): Promise<{ url: string; title: string }> { this.fail('navigate') }
  async goBack(_id: string): Promise<void> { this.fail('goBack') }
  async goForward(_id: string): Promise<void> { this.fail('goForward') }

  async getAccessibilitySnapshot(_id: string): Promise<AccessibilitySnapshot> { this.fail('getAccessibilitySnapshot') }
  async clickElement(_id: string, _ref: string, _options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void> {
    this.fail('clickElement')
  }
  async clickAtCoordinates(_id: string, _x: number, _y: number): Promise<void> { this.fail('clickAtCoordinates') }
  async drag(_id: string, _x1: number, _y1: number, _x2: number, _y2: number): Promise<void> { this.fail('drag') }
  async fillElement(_id: string, _ref: string, _value: string): Promise<void> { this.fail('fillElement') }
  async typeText(_id: string, _text: string): Promise<void> { this.fail('typeText') }
  async selectOption(_id: string, _ref: string, _value: string): Promise<void> { this.fail('selectOption') }
  async setClipboard(_id: string, _text: string): Promise<void> { this.fail('setClipboard') }
  async getClipboard(_id: string): Promise<string> { return this.fail('getClipboard') }
  async scroll(_id: string, _direction: 'up' | 'down' | 'left' | 'right', _amount?: number): Promise<void> {
    this.fail('scroll')
  }
  async sendKey(_id: string, _args: BrowserKeyArgs): Promise<void> { this.fail('sendKey') }
  async uploadFile(_id: string, _ref: string, _filePaths: string[]): Promise<unknown> { return this.fail('uploadFile') }
  async evaluate(_id: string, _expression: string): Promise<unknown> { return this.fail('evaluate') }

  async screenshot(_id: string, _options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    return this.fail('screenshot')
  }
  async screenshotRegion(_id: string, _target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    return this.fail('screenshotRegion')
  }

  getConsoleLogs(_id: string, _options?: BrowserConsoleOptions): BrowserConsoleEntry[] { return [] }
  windowResize(_id: string, _width: number, _height: number): { width: number; height: number } {
    return this.fail('windowResize')
  }
  getNetworkLogs(_id: string, _options?: BrowserNetworkOptions): BrowserNetworkEntry[] { return [] }
  async waitFor(_id: string, _args: BrowserWaitArgs): Promise<BrowserWaitResult> { return this.fail('waitFor') }
  async getDownloads(_id: string, _options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> { return [] }
  async detectSecurityChallenge(_id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return { detected: false, provider: 'none', signals: [] }
  }
}
