import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type {
  BrowserCookieImportState,
  BrowserCookieSource,
  CookieImportErrorCode,
} from '../../../shared/types'
import { cookieImportErrorI18nKey, cookieImportStatusI18n } from './cookie-import-i18n'

export function useChromeCookieImport() {
  const { t } = useTranslation()
  const [sources, setSources] = useState<BrowserCookieSource[]>([])
  const [selectedDirectory, setSelectedDirectory] = useState('')
  const [lastImport, setLastImport] = useState<BrowserCookieImportState | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<CookieImportErrorCode | null>(null)

  const chromeSource = sources.find((source) => source.family === 'chrome') ?? null
  const profileOptions = useMemo(
    () => chromeSource?.profiles.map((profile) => ({
      value: profile.directory,
      label: profile.name,
    })) ?? [],
    [chromeSource],
  )

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api?.detectCookieSources) return
    try {
      const detected = await api.detectCookieSources()
      setSources(detected)
      const chrome = detected.find((source) => source.family === 'chrome')
      setSelectedDirectory((current) => {
        if (current && chrome?.profiles.some((profile) => profile.directory === current)) return current
        return chrome?.selectedProfile ?? ''
      })
      const state = await api.getCookieImportState?.()
      setLastImport(state ?? null)
    } catch {
      setSources([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importSelected = useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api?.importCookiesFromBrowser || !selectedDirectory) return
    setBusy(true)
    setErrorCode(null)
    try {
      const result = await api.importCookiesFromBrowser({
        browserFamily: 'chrome',
        browserProfile: selectedDirectory,
      })
      if (!result.ok) {
        setErrorCode(result.code)
        toast.error(t(cookieImportErrorI18nKey(result.code)))
        return
      }
      const lastImportState = {
        profileId: result.profileId,
        source: result.source,
        importedAt: Date.now(),
        summary: result.summary,
      }
      setLastImport(lastImportState)
      const status = cookieImportStatusI18n(lastImportState)
      if (result.summary.warning) {
        toast.warning(t(status.key, status.values))
      } else {
        toast.success(t('browser.cookieImport.success', {
          count: result.summary.importedCookies,
          profile: result.source.profileName,
        }))
      }
    } catch {
      setErrorCode('malformed-records')
      toast.error(t(cookieImportErrorI18nKey('malformed-records')))
    } finally {
      setBusy(false)
    }
  }, [selectedDirectory, t])

  return {
    chromeSource,
    profileOptions,
    selectedDirectory,
    setSelectedDirectory,
    lastImport,
    busy,
    errorCode,
    importSelected,
    refresh,
  }
}
