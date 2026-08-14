import type {
  BrowserCookieImportResult,
  BrowserCookieImportState,
  BrowserCookieSource,
  ImportCookiesFromBrowserArgs,
} from '@kata-sh/shared/protocol'
import { DEFAULT_KATA_BROWSER_PROFILE_ID } from '@kata-sh/shared/protocol'
import { DEFAULT_BROWSER_PARTITION } from './apply-pending'
import {
  detectInstalledBrowsers,
  detectInstalledCookieSources,
  isSafeBrowserProfileDirectory,
  selectBrowserProfile,
  type DetectCookieSourcesOptions,
} from './detect'
import { importCookiesFromDetectedBrowser, type CookieImportRuntime } from './import-cookies'
import { createFileCookieImportStateStore, getLastImport } from './state'

export function listRendererCookieSources(options?: DetectCookieSourcesOptions): BrowserCookieSource[] {
  return detectInstalledCookieSources(options)
}

export function getCookieImportState(
  userDataPath: string,
  profileId = DEFAULT_KATA_BROWSER_PROFILE_ID,
): BrowserCookieImportState | null {
  return getLastImport(createFileCookieImportStateStore(userDataPath), profileId)
}

export async function importCookiesFromBrowserArgs(
  args: ImportCookiesFromBrowserArgs,
  runtime: CookieImportRuntime,
  detectOptions?: DetectCookieSourcesOptions,
): Promise<BrowserCookieImportResult> {
  const profileId = args.profileId || DEFAULT_KATA_BROWSER_PROFILE_ID
  if (args.browserFamily !== 'chrome') {
    return { ok: false, code: 'chrome-not-found' }
  }
  if (args.browserProfile && !isSafeBrowserProfileDirectory(args.browserProfile)) {
    return { ok: false, code: 'invalid-profile' }
  }

  const browsers = detectInstalledBrowsers(detectOptions)
  let browser = browsers.find((item) => item.family === 'chrome')
  if (!browser) return { ok: false, code: 'chrome-not-found' }

  if (args.browserProfile && args.browserProfile !== browser.selectedProfile) {
    const reselected = selectBrowserProfile(browser, args.browserProfile, detectOptions)
    if (!reselected) return { ok: false, code: 'invalid-profile' }
    browser = reselected
  }

  return importCookiesFromDetectedBrowser(browser, {
    ...runtime,
    partition: DEFAULT_BROWSER_PARTITION,
    profileId,
  })
}
