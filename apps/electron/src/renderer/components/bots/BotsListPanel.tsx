/**
 * BotsListPanel
 *
 * Navigator panel for Bots. Lists the workspace's active Bots and hosts the
 * inline create control. Selecting a Bot navigates to its one DirectChat.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Plus } from 'lucide-react'
import type { BotPublicDto } from '@kata-sh/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useAppShellContext } from '@/context/AppShellContext'

/** Used when the workspace has no usable LLM connection yet. */
const FALLBACK_PROVIDER_ID = 'openai-codex'
const FALLBACK_MODEL_ID = 'gpt-5-codex'

export interface BotsListPanelProps {
  workspaceId: string
  selectedBotId?: string | null
  onBotClick: (bot: BotPublicDto) => void
}

export function BotsListPanel({ workspaceId, selectedBotId, onBotClick }: BotsListPanelProps) {
  const { t } = useTranslation()
  const { llmConnections, workspaceDefaultLlmConnection } = useAppShellContext()

  const [bots, setBots] = React.useState<BotPublicDto[]>([])
  const [isCreating, setIsCreating] = React.useState(false)
  const [name, setName] = React.useState('')
  const [profile, setProfile] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const loaded = await window.electronAPI.listBots(workspaceId, { lifecycle: 'active' })
    setBots(loaded)
  }, [workspaceId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Bots] Failed to list bots:', err))
    return window.electronAPI.onBotEvent(() => {
      refresh().catch(err => console.error('[Bots] Failed to refresh bots:', err))
    })
  }, [refresh])

  const handleCreate = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return

    const connection =
      llmConnections.find(c => c.slug === workspaceDefaultLlmConnection) ?? llmConnections[0]

    const trimmedProfile = profile.trim()

    setBusy(true)
    try {
      const bot = await window.electronAPI.createBot(workspaceId, {
        name: trimmed,
        permissionMode: 'ask',
        providerConfig: {
          providerId: connection?.slug ?? FALLBACK_PROVIDER_ID,
          modelId: connection?.defaultModel ?? FALLBACK_MODEL_ID,
        },
        ...(trimmedProfile ? { profile: trimmedProfile } : {}),
        idempotencyKey: crypto.randomUUID(),
      })
      setName('')
      setProfile('')
      setIsCreating(false)
      await refresh()
      onBotClick(bot)
    } catch (err) {
      console.error('[Bots] Failed to create bot:', err)
    } finally {
      setBusy(false)
    }
  }, [name, profile, busy, llmConnections, workspaceDefaultLlmConnection, workspaceId, refresh, onBotClick])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2">
        {isCreating ? (
          <form onSubmit={handleCreate} className="flex flex-col gap-2">
            <Input
              data-testid="bots-name-input"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('bots.namePlaceholder')}
              className="h-8 text-sm"
            />
            <div className="flex items-center gap-2">
              <Input
                data-testid="bots-profile-input"
                value={profile}
                onChange={e => setProfile(e.target.value)}
                placeholder={t('bots.profilePlaceholder')}
                className="h-8 text-sm"
              />
              <Button type="submit" size="sm" disabled={busy} data-testid="bots-create-submit">
                {t('bots.createSubmit')}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setIsCreating(true)}
            data-testid="bots-create-button"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('bots.newBot')}
          </Button>
        )}
      </div>

      <div data-testid="bots-list" className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {bots.length === 0 ? (
          <EntityListEmptyScreen
            icon={<Bot />}
            title={t('bots.noBots')}
            description={t('bots.emptyDescription')}
          />
        ) : (
          bots.map((bot, index) => (
            <EntityRow
              key={bot.botId}
              icon={<Bot />}
              title={bot.name}
              isSelected={selectedBotId === bot.botId}
              showSeparator={index > 0}
              onClick={() => onBotClick(bot)}
              dataAttributes={{ 'data-testid': `bot-row-${bot.botId}` }}
            />
          ))
        )}
      </div>
    </div>
  )
}
