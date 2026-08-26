/**
 * ChannelsListPanel
 *
 * Navigator panel for Channels. Lists the workspace's active Channels and hosts
 * the inline create control. Selecting a Channel opens its journal.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessagesSquare, Plus } from 'lucide-react'
import type { ChannelPublicDto } from '@kata-sh/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'

export interface ChannelsListPanelProps {
  workspaceId: string
  selectedChannelId?: string | null
  onChannelClick: (channel: ChannelPublicDto) => void
}

export function ChannelsListPanel({
  workspaceId,
  selectedChannelId,
  onChannelClick,
}: ChannelsListPanelProps) {
  const { t } = useTranslation()

  const [channels, setChannels] = React.useState<ChannelPublicDto[]>([])
  const [isCreating, setIsCreating] = React.useState(false)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const loaded = await window.electronAPI.listChannels(workspaceId, { lifecycle: 'active' })
    setChannels(loaded)
  }, [workspaceId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Channels] Failed to list channels:', err))
    return window.electronAPI.onChannelEvent(() => {
      refresh().catch(err => console.error('[Channels] Failed to refresh channels:', err))
    })
  }, [refresh])

  const handleCreate = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return

    setBusy(true)
    try {
      const channel = await window.electronAPI.createChannel(workspaceId, {
        name: trimmed,
        idempotencyKey: crypto.randomUUID(),
      })
      setName('')
      setIsCreating(false)
      await refresh()
      onChannelClick(channel)
    } catch (err) {
      console.error('[Channels] Failed to create channel:', err)
    } finally {
      setBusy(false)
    }
  }, [name, busy, workspaceId, refresh, onChannelClick])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2">
        {isCreating ? (
          <form onSubmit={handleCreate} className="flex items-center gap-2">
            <Input
              data-testid="channels-name-input"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('channels.namePlaceholder')}
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" disabled={busy} data-testid="channels-create-submit">
              {t('channels.createSubmit')}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setIsCreating(true)}
            data-testid="channels-create-button"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('channels.newChannel')}
          </Button>
        )}
      </div>

      <div data-testid="channels-list" className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {channels.length === 0 ? (
          <EntityListEmptyScreen
            icon={<MessagesSquare />}
            title={t('channels.noChannels')}
            description={t('channels.emptyDescription')}
          />
        ) : (
          channels.map((channel, index) => (
            <EntityRow
              key={channel.channelId}
              icon={<MessagesSquare />}
              title={channel.name}
              isSelected={selectedChannelId === channel.channelId}
              showSeparator={index > 0}
              onClick={() => onChannelClick(channel)}
              dataAttributes={{ 'data-testid': `channel-row-${channel.channelId}` }}
            />
          ))
        )}
      </div>
    </div>
  )
}
