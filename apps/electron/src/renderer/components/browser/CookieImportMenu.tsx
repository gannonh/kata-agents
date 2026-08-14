import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import {
  DropdownMenuSub,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import { cookieImportErrorI18nKey, cookieImportStatusI18n } from './cookie-import-i18n'
import type { useChromeCookieImport } from './useChromeCookieImport'

type CookieImportMenuProps = ReturnType<typeof useChromeCookieImport>

export function CookieImportMenu({
  chromeSource,
  profileOptions,
  selectedDirectory,
  setSelectedDirectory,
  lastImport,
  busy,
  errorCode,
  importSelected,
}: CookieImportMenuProps) {
  const { t } = useTranslation()

  const lastImportStatus = cookieImportStatusI18n(lastImport)
  const lastImportLabel = t(lastImportStatus.key, lastImportStatus.values)

  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger data-testid="chrome-cookie-import-menu">
        <Icons.Cookie className="h-3.5 w-3.5" />
        {t('settings.browser.cookieImport.title')}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent minWidth="min-w-56">
        {chromeSource ? (
          profileOptions.map((option) => (
            <StyledDropdownMenuItem
              key={option.value}
              disabled={busy}
              onSelect={() => setSelectedDirectory(option.value)}
            >
              {selectedDirectory === option.value ? (
                <Icons.Check className="h-3.5 w-3.5" />
              ) : (
                <span className="h-3.5 w-3.5" />
              )}
              <span className="truncate">{option.label}</span>
            </StyledDropdownMenuItem>
          ))
        ) : (
          <StyledDropdownMenuItem disabled>
            {t('browser.cookieImport.chromeNotFound')}
          </StyledDropdownMenuItem>
        )}
        <StyledDropdownMenuSeparator />
        <StyledDropdownMenuItem disabled>
          {errorCode ? t(cookieImportErrorI18nKey(errorCode)) : lastImportLabel}
        </StyledDropdownMenuItem>
        <StyledDropdownMenuItem
          disabled={!chromeSource || !selectedDirectory || busy}
          onSelect={() => void importSelected()}
        >
          <Icons.Download className="h-3.5 w-3.5" />
          {busy ? t('browser.cookieImport.importing') : t('browser.cookieImport.importAction')}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
