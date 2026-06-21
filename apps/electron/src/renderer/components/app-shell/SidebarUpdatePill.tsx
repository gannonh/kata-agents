/**
 * SidebarUpdatePill — compact update affordance in the sidebar footer (AC2-AC4).
 *
 * Mirrors kata-code's `SidebarUpdatePill`:
 * - `Update available` with a dismiss (×) for the current launch — clicking
 *   starts the download (manual-download parity, AC1/AC3).
 * - `Downloading (N%)` while in progress.
 * - `Restart to update` after download; clicking shows a confirm then installs
 *   (AC4). Keeps offering restart on install failure so the user can retry.
 *
 * Dismissal is renderer/session state only — it does not persist across app
 * restarts. Hidden when updates are disabled, idle, or up to date.
 */

import { useState, useCallback } from 'react'
import { Download, RotateCw } from 'lucide-react'
import { useDesktopUpdate } from '@/hooks/useUpdateChecker'
import { useTranslation } from 'react-i18next'

export function SidebarUpdatePill() {
  const { t } = useTranslation()
  const { state, showButton, action, buttonDisabled, downloadUpdate, installUpdate } = useDesktopUpdate()
  const [dismissed, setDismissed] = useState(false)

  // Only the "available" action is dismissible for the launch; an already
  // downloaded update always surfaces "Restart to update".
  const visible = showButton && (!dismissed || action === 'install')

  const handleClick = useCallback(() => {
    if (buttonDisabled || action === 'none') return
    if (action === 'download') {
      void downloadUpdate()
    } else if (action === 'install') {
      void installUpdate()
    }
  }, [action, buttonDisabled, downloadUpdate, installUpdate])

  if (!visible) return null

  const downloading = state?.status === 'downloading'
  const percent = typeof state?.downloadPercent === 'number' ? Math.floor(state.downloadPercent) : null

  return (
    <div className="flex items-center px-2 pb-1">
      <div
        className={`group relative flex h-7 w-full items-center rounded-[6px] bg-primary/15 text-xs font-medium text-primary ${
          buttonDisabled ? 'cursor-not-allowed opacity-60' : ''
        }`}
      >
        <button
          type="button"
          aria-label={
            action === 'install'
              ? t('update.restartToUpdate')
              : downloading
                ? t('update.downloadingTitle')
                : t('update.updateAvailable')
          }
          aria-disabled={buttonDisabled || undefined}
          disabled={buttonDisabled}
          className="relative flex h-full flex-1 items-center gap-2 px-2 enabled:cursor-pointer"
          onClick={handleClick}
        >
          {action === 'install' ? (
            <>
              <RotateCw className="size-3.5" />
              <span>{t('update.restartToUpdate')}</span>
            </>
          ) : downloading ? (
            <>
              <Download className="size-3.5" />
              <span>{percent !== null ? t('update.downloadingPercent', { percent }) : t('update.downloadingTitle')}</span>
            </>
          ) : (
            <>
              <Download className="size-3.5" />
              <span>{t('update.updateAvailable')}</span>
            </>
          )}
        </button>
        {action === 'download' && (
          <button
            type="button"
            aria-label={t('update.dismiss')}
            className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-primary/60 transition-colors hover:text-primary"
            onClick={() => setDismissed(true)}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
