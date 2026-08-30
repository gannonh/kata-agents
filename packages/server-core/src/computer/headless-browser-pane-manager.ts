import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { BrowserContext, Locator, Page } from 'playwright-core'
import {
  DEFAULT_BROWSER_PROFILE_ID,
  brandSessionId,
  type ProfileId,
} from '@kata-sh/shared/computer'
import type { BrowserInstanceInfo } from '@kata-sh/shared/protocol'
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
} from '../handlers/browser-pane-manager-interface.ts'
import { ProfileBusyError } from './errors.ts'
import type { BrowserHost } from './browser-host.ts'

interface SnapshotRef {
  role: string
  name: string
  nth: number
}

interface Pane {
  id: string
  sessionId: string
  profileId: ProfileId
  page: Page
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
  refs: Map<string, SnapshotRef>
  info: BrowserInstanceInfo
}

function resolveChromium(explicit: string | null): string | null {
  const candidates = [
    explicit,
    process.env.KATA_CHROMIUM_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

export class HeadlessBrowserPaneManager implements IBrowserPaneManager {
  private panes = new Map<string, Pane>()
  private contexts = new Map<string, BrowserContext>()
  private sessionProfile = new Map<string, ProfileId>()
  private claimedPages = new WeakSet<Page>()

  private constructor(
    private readonly host: BrowserHost,
    private readonly executablePath: string,
  ) {}

  static async launch(opts: { computer: BrowserHost; chromiumPath: string | null }): Promise<HeadlessBrowserPaneManager> {
    const executablePath = resolveChromium(opts.chromiumPath)
    if (!executablePath) {
      throw new Error('No Chromium executable found. Set KATA_CHROMIUM_PATH or install google-chrome/chromium.')
    }
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    await browser.close()
    return new HeadlessBrowserPaneManager(opts.computer, executablePath)
  }

  async close(): Promise<void> {
    for (const pane of this.panes.values()) {
      await pane.page.close().catch(() => {})
    }
    this.panes.clear()
    for (const context of this.contexts.values()) {
      await context.close().catch(() => {})
    }
    this.contexts.clear()
  }

  async flushProfile(profileId: ProfileId): Promise<void> {
    const context = this.contexts.get(profileId)
    if (!context) return
    for (const [id, pane] of [...this.panes]) {
      if (pane.profileId === profileId) {
        await pane.page.close().catch(() => {})
        this.panes.delete(id)
      }
    }
    await context.close()
    this.contexts.delete(profileId)
  }

  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {}

  destroyForSession(sessionId: string): void {
    for (const [id, pane] of [...this.panes]) {
      if (pane.sessionId === sessionId) {
        this.panes.delete(id)
        void pane.page.close().catch((error) => {
          this.ignoreBackgroundRejection(error)
        })
      }
    }
    this.releaseSessionLeaseIfIdle(sessionId)
  }

  async clearVisualsForSession(_sessionId: string): Promise<void> {}
  unbindAllForSession(_sessionId: string): void {}

  getOrCreateForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string {
    throw new Error('HeadlessBrowserPaneManager.getOrCreateForSession is unavailable; use getOrCreateForSessionAsync')
  }

  async getOrCreateForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> {
    return this.createForSessionAsync(sessionId, { show: false, workspaceId: options?.workspaceId })
  }

  setAgentControl(
    _sessionId: string,
    _meta: { displayName?: string; intent?: string },
    _options?: { workspaceId?: string | null },
  ): void {}

  createForSession(_sessionId: string, _options?: { show?: boolean; workspaceId?: string | null }): string {
    throw new Error('HeadlessBrowserPaneManager.createForSession is unavailable; use createForSessionAsync')
  }

  async createForSessionAsync(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string> {
    const existing = [...this.panes.values()].find((pane) => pane.sessionId === sessionId)
    if (existing) return existing.id

    const profileId = this.sessionProfile.get(sessionId) ?? DEFAULT_BROWSER_PROFILE_ID
    await this.host.acquireProfileLease({
      profileId,
      sessionId: brandSessionId(sessionId),
    })
    this.sessionProfile.set(sessionId, profileId)
    const page = await this.pageForProfile(profileId)
    const id = randomUUID()
    const info: BrowserInstanceInfo = {
      id,
      url: page.url(),
      title: await page.title().catch(() => ''),
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: sessionId,
      ownerType: 'session',
      ownerSessionId: sessionId,
      isVisible: options?.show ?? false,
      agentControlActive: false,
      themeColor: null,
      workspaceId: options?.workspaceId ?? null,
      surface: 'panel',
    }
    const pane: Pane = {
      id,
      sessionId,
      profileId,
      page,
      console: [],
      network: [],
      downloads: [],
      refs: new Map(),
      info,
    }
    page.on('console', (msg) => {
      const type = msg.type()
      const level = type === 'error' || type === 'warning' || type === 'info' || type === 'log' ? type : 'log'
      pane.console.push({
        timestamp: Date.now(),
        level: level === 'warning' ? 'warn' : level,
        message: msg.text(),
      })
    })
    page.on('requestfinished', async (request) => {
      const response = await request.response()
      const status = response?.status() ?? 0
      pane.network.push({
        timestamp: Date.now(),
        method: request.method(),
        url: request.url(),
        status,
        resourceType: request.resourceType(),
        ok: status >= 200 && status < 400,
      })
    })
    page.on('download', (download) => {
      pane.downloads.push({
        id: randomUUID(),
        timestamp: Date.now(),
        url: download.url(),
        filename: download.suggestedFilename(),
        state: 'in_progress',
        bytesReceived: 0,
        totalBytes: 0,
        mimeType: '',
      })
    })
    this.panes.set(id, pane)
    return id
  }

  getInstance(id: string): BrowserInstanceSnapshot | undefined {
    const pane = this.panes.get(id)
    if (!pane) return undefined
    return {
      ownerType: pane.info.ownerType,
      ownerSessionId: pane.info.ownerSessionId,
      isVisible: pane.info.isVisible,
      title: pane.info.title,
      currentUrl: pane.info.url,
    }
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    const pane = this.panes.get(id)
    if (!pane) return undefined
    pane.info.title = await pane.page.title().catch(() => pane.info.title)
    pane.info.url = pane.page.url()
    return this.getInstance(id)
  }

  listInstances(): BrowserInstanceInfo[] {
    return [...this.panes.values()].map((pane) => pane.info)
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    for (const pane of this.panes.values()) {
      pane.info.title = await pane.page.title().catch(() => pane.info.title)
      pane.info.url = pane.page.url()
    }
    return this.listInstances()
  }

  focusBoundForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string {
    throw new Error('HeadlessBrowserPaneManager.focusBoundForSession is unavailable; use focusBoundForSessionAsync')
  }

  async focusBoundForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> {
    return this.getOrCreateForSessionAsync(sessionId, options)
  }

  bindSession(id: string, sessionId: string, _options?: { workspaceId?: string | null }): void {
    const pane = this.requirePane(id)
    pane.sessionId = sessionId
    pane.info.boundSessionId = sessionId
    pane.info.ownerSessionId = sessionId
  }

  focus(_id: string): void {}
  destroyInstance(id: string): void {
    const pane = this.panes.get(id)
    if (!pane) return
    this.panes.delete(id)
    void pane.page.close().catch((error) => {
      this.ignoreBackgroundRejection(error)
    })
    this.releaseSessionLeaseIfIdle(pane.sessionId)
  }
  hide(_id: string): void {}
  clearAgentControl(_sessionId: string): void {}
  clearAgentControlForInstance(_instanceId: string, _sessionId?: string): { released: boolean; reason?: string } {
    return { released: true }
  }

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    const pane = this.requirePane(id)
    await pane.page.goto(url, { waitUntil: 'domcontentloaded' })
    pane.info.url = pane.page.url()
    pane.info.title = await pane.page.title()
    return { url: pane.info.url, title: pane.info.title }
  }

  async goBack(id: string): Promise<void> {
    await this.requirePane(id).page.goBack()
  }

  async goForward(id: string): Promise<void> {
    await this.requirePane(id).page.goForward()
  }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    const pane = this.requirePane(id)
    const snapshot = await pane.page.accessibility.snapshot()
    pane.refs.clear()
    const nodes: AccessibilitySnapshot['nodes'] = []
    const occurrence = new Map<string, number>()
    const walk = (node: Awaited<ReturnType<Page['accessibility']['snapshot']>> | null, index: { n: number }) => {
      if (!node) return
      const ref = `ref-${index.n++}`
      const name = node.name ?? ''
      const key = `${node.role}\0${name}`
      const nth = occurrence.get(key) ?? 0
      occurrence.set(key, nth + 1)
      pane.refs.set(ref, { role: node.role, name, nth })
      nodes.push({
        ref,
        role: node.role,
        name,
        value: typeof node.value === 'string' ? node.value : undefined,
        focused: node.focused,
        checked: typeof node.checked === 'boolean' ? node.checked : undefined,
        disabled: node.disabled,
      })
      for (const child of node.children ?? []) walk(child, index)
    }
    walk(snapshot, { n: 1 })
    return { url: pane.page.url(), title: await pane.page.title(), nodes }
  }

  async clickElement(id: string, ref: string, _options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void> {
    await this.locatorForRef(this.requirePane(id), ref).click()
  }

  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    await this.requirePane(id).page.mouse.click(x, y)
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const page = this.requirePane(id).page
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move(x2, y2)
    await page.mouse.up()
  }

  async fillElement(id: string, ref: string, value: string): Promise<void> {
    await this.locatorForRef(this.requirePane(id), ref).fill(value)
  }

  async typeText(id: string, text: string): Promise<void> {
    await this.requirePane(id).page.keyboard.type(text)
  }

  async selectOption(id: string, ref: string, value: string): Promise<void> {
    await this.locatorForRef(this.requirePane(id), ref).selectOption(value)
  }

  private clipboardText = ''

  async setClipboard(_id: string, text: string): Promise<void> {
    this.clipboardText = text
  }

  async getClipboard(_id: string): Promise<string> {
    return this.clipboardText
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 400): Promise<void> {
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
    await this.requirePane(id).page.mouse.wheel(dx, dy)
  }

  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const page = this.requirePane(id).page
    for (const modifier of args.modifiers ?? []) await page.keyboard.down(modifier)
    await page.keyboard.press(args.key)
    for (const modifier of [...(args.modifiers ?? [])].reverse()) await page.keyboard.up(modifier)
  }

  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown> {
    await this.locatorForRef(this.requirePane(id), ref).setInputFiles(filePaths)
    return { uploaded: filePaths.length }
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    return this.requirePane(id).page.evaluate(expression)
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const format = options?.format === 'jpeg' ? 'jpeg' : 'png'
    const buffer = await this.requirePane(id).page.screenshot({
      type: format,
      quality: format === 'jpeg' ? options?.jpegQuality : undefined,
    })
    return { imageBuffer: Buffer.from(buffer), imageFormat: format }
  }

  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const clip = {
      x: target.x ?? 0,
      y: target.y ?? 0,
      width: target.width ?? 100,
      height: target.height ?? 100,
    }
    const format = target.format === 'jpeg' ? 'jpeg' : 'png'
    const buffer = await this.requirePane(id).page.screenshot({
      type: format,
      clip,
      quality: format === 'jpeg' ? target.jpegQuality : undefined,
    })
    return { imageBuffer: Buffer.from(buffer), imageFormat: format }
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    const logs = this.requirePane(id).console
    const filtered = options?.level && options.level !== 'all'
      ? logs.filter((entry) => entry.level === options.level)
      : logs
    return filtered.slice(-(options?.limit ?? filtered.length))
  }

  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    void this.requirePane(id).page.setViewportSize({ width, height }).catch((error) => {
      this.ignoreBackgroundRejection(error)
    })
    return { width, height }
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    let logs = this.requirePane(id).network
    if (options?.method) logs = logs.filter((entry) => entry.method === options.method)
    if (options?.status === 'failed') logs = logs.filter((entry) => !entry.ok)
    if (options?.status === '2xx') logs = logs.filter((entry) => entry.status >= 200 && entry.status < 300)
    if (options?.status === '3xx') logs = logs.filter((entry) => entry.status >= 300 && entry.status < 400)
    if (options?.status === '4xx') logs = logs.filter((entry) => entry.status >= 400 && entry.status < 500)
    if (options?.status === '5xx') logs = logs.filter((entry) => entry.status >= 500)
    return logs.slice(-(options?.limit ?? logs.length))
  }

  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const started = Date.now()
    const page = this.requirePane(id).page
    const timeout = args.timeoutMs ?? 10_000
    if (args.kind === 'selector' && args.value) await page.waitForSelector(args.value, { timeout })
    if (args.kind === 'text' && args.value) await page.getByText(args.value).first().waitFor({ timeout })
    if (args.kind === 'url' && args.value) await page.waitForURL(args.value, { timeout })
    if (args.kind === 'network-idle') await page.waitForLoadState('networkidle', { timeout })
    return { ok: true, kind: args.kind, elapsedMs: Date.now() - started, detail: args.value ?? args.kind }
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const downloads = this.requirePane(id).downloads
    return downloads.slice(-(options?.limit ?? downloads.length))
  }

  async detectSecurityChallenge(_id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return { detected: false, provider: 'none', signals: [] }
  }

  bindSessionToProfile(sessionId: string, profileId: ProfileId): void {
    this.sessionProfile.set(sessionId, profileId)
  }

  reassignProfileWriter(fromSessionId: string, toSessionId: string, profileId: ProfileId): void {
    for (const pane of this.panes.values()) {
      if (pane.sessionId === fromSessionId && pane.profileId === profileId) {
        pane.sessionId = toSessionId
        pane.info.boundSessionId = toSessionId
        pane.info.ownerSessionId = toSessionId
      }
    }
    this.sessionProfile.delete(fromSessionId)
    this.sessionProfile.set(toSessionId, profileId)
  }

  private releaseSessionLeaseIfIdle(sessionId: string): void {
    if ([...this.panes.values()].some((pane) => pane.sessionId === sessionId)) return
    const profileId = this.sessionProfile.get(sessionId)
    if (!profileId) return
    this.sessionProfile.delete(sessionId)
    void this.host.releaseProfileLease({
      profileId,
      sessionId: brandSessionId(sessionId),
    }).catch((error) => {
      this.ignoreBackgroundRejection(error)
    })
  }

  private ignoreBackgroundRejection(error: unknown): void {
    if (error instanceof ProfileBusyError) return
  }

  private locatorForRef(pane: Pane, ref: string): Locator {
    const target = pane.refs.get(ref)
    if (!target) return pane.page.locator(ref).first()
    const role = target.role as Parameters<Page['getByRole']>[0]
    if (target.name.length > 0) {
      return pane.page.getByRole(role, { name: target.name, exact: true }).nth(target.nth)
    }
    return pane.page.getByRole(role).nth(target.nth)
  }

  private requirePane(id: string): Pane {
    const pane = this.panes.get(id)
    if (!pane) throw new Error(`Unknown browser instance ${id}`)
    return pane
  }

  private async pageForProfile(profileId: ProfileId): Promise<Page> {
    let context = this.contexts.get(profileId)
    if (!context) {
      const { chromium } = await import('playwright-core')
      const userDataDir = `${this.host.layout.browserProfilesDir}/${profileId}`
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: this.executablePath,
        headless: true,
        viewport: { width: 1280, height: 720 },
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      })
      this.contexts.set(profileId, context)
    }
    for (const page of context.pages()) {
      if (!this.claimedPages.has(page)) {
        this.claimedPages.add(page)
        return page
      }
    }
    const page = await context.newPage()
    this.claimedPages.add(page)
    return page
  }
}
