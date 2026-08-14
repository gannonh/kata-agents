/**
 * BrowserSettingsPage
 *
 * Chrome cookie import into the shared Kata browser profile/session.
 */

import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import {
  SettingsSection,
  SettingsCard,
  SettingsCardContent,
  SettingsSelect,
} from '@/components/settings'
import { useChromeCookieImport } from '@/components/browser/useChromeCookieImport'
import { cookieImportErrorI18nKey, cookieImportStatusI18n } from '@/components/browser/cookie-import-i18n'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'browser',
}

export default function BrowserSettingsPage() {
  const { t } = useTranslation()
  const {
    chromeSource,
    profileOptions,
    selectedDirectory,
    setSelectedDirectory,
    lastImport,
    busy,
    errorCode,
    importSelected,
  } = useChromeCookieImport()

  const lastImportStatus = cookieImportStatusI18n(lastImport)
  const lastImportLabel = t(lastImportStatus.key, lastImportStatus.values)

  return (
    <div className="h-full flex flex-col" data-testid="browser-settings-page">
      <PanelHeader title={t('settings.browser.title')} actions={<HeaderMenu route={routes.view.settings('browser')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t('settings.browser.cookieImport.title')}
                description={t('settings.browser.cookieImport.description')}
              >
                <SettingsCard>
                  {chromeSource ? (
                    <SettingsSelect
                      label={t('browser.cookieImport.profileLabel')}
                      description={t('browser.cookieImport.sourceLabel', { source: chromeSource.label })}
                      value={selectedDirectory}
                      onValueChange={setSelectedDirectory}
                      options={profileOptions}
                      placeholder={t('browser.cookieImport.selectProfile')}
                      disabled={busy}
                      inCard
                      testId="chrome-cookie-import-profile"
                    />
                  ) : (
                    <SettingsCardContent>
                      <p className="text-sm text-muted-foreground" data-testid="chrome-cookie-import-missing">
                        {t('browser.cookieImport.chromeNotFound')}
                      </p>
                    </SettingsCardContent>
                  )}
                  <SettingsCardContent>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-muted-foreground" data-testid="chrome-cookie-import-last">
                        {errorCode ? t(cookieImportErrorI18nKey(errorCode)) : lastImportLabel}
                      </p>
                      <Button
                        size="sm"
                        onClick={() => void importSelected()}
                        disabled={!chromeSource || !selectedDirectory || busy}
                        data-testid="chrome-cookie-import-button"
                      >
                        {busy ? t('browser.cookieImport.importing') : t('browser.cookieImport.importAction')}
                      </Button>
                    </div>
                  </SettingsCardContent>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
