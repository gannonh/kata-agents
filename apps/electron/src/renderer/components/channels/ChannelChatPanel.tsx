import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import type {
  BotPublicDto,
  ChannelPublicDto,
  JournalEntry,
  RouteRecord,
} from '@kata-sh/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelHeader } from '../app-shell/PanelHeader'

export interface ChannelChatPanelProps {
  workspaceId: string
  channelId: string
}

export function ChannelChatPanel({ workspaceId, channelId }: ChannelChatPanelProps) {
  const { t } = useTranslation()
  const [channel, setChannel] = React.useState<ChannelPublicDto | null>(null)
  const [members, setMembers] = React.useState<BotPublicDto[]>([])
  const [entries, setEntries] = React.useState<JournalEntry[]>([])
  const [routes, setRoutes] = React.useState<RouteRecord[]>([])
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [isAddingMember, setIsAddingMember] = React.useState(false)
  const [memberName, setMemberName] = React.useState('')
  const [memberBusy, setMemberBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const [journal, loadedRoutes] = await Promise.all([
      window.electronAPI.getChannelJournal(workspaceId, channelId),
      window.electronAPI.listChannelRoutes(workspaceId, channelId),
    ])
    setChannel(journal.channel)
    setMembers(journal.members)
    setEntries(journal.entries)
    setRoutes([...loadedRoutes].sort((a, b) => a.routeSeq - b.routeSeq))
  }, [workspaceId, channelId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Channels] Failed to load journal:', err))
    return window.electronAPI.onChannelEvent(() => {
      refresh().catch(err => console.error('[Channels] Failed to refresh journal:', err))
    })
  }, [refresh])

  const memberNameById = React.useMemo(
    () => new Map(members.map(member => [member.botId, member.name])),
    [members],
  )

  const handleSend = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || sending) return

    setSending(true)
    try {
      await window.electronAPI.sendChannelMessage(workspaceId, channelId, trimmed, {
        idempotencyKey: crypto.randomUUID(),
        waitForReplies: true,
      })
      setMessage('')
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }, [message, sending, workspaceId, channelId, refresh])

  const handleAddMember = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = memberName.trim()
    if (!trimmed || memberBusy) return

    setMemberBusy(true)
    try {
      const bots = await window.electronAPI.listBots(workspaceId, { lifecycle: 'active' })
      const match = bots.find(bot => bot.name.trim().toLowerCase() === trimmed.toLowerCase())
      await window.electronAPI.addChannelMember(workspaceId, channelId, match?.botId ?? trimmed)
      setMemberName('')
      setIsAddingMember(false)
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to add member:', err)
    } finally {
      setMemberBusy(false)
    }
  }, [memberName, memberBusy, workspaceId, channelId, refresh])

  const handleRemoveMember = React.useCallback(async (botId: string) => {
    try {
      await window.electronAPI.removeChannelMember(workspaceId, channelId, botId)
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to remove member:', err)
    }
  }, [workspaceId, channelId, refresh])

  const describeRoute = React.useCallback((route: RouteRecord) => {
    if (route.blockedReason === 'no-eligible-members') return t('channels.blockedNoMembers')
    if (route.blockedReason === 'no-claim') return t('channels.blockedNoClaim')

    return route.stages
      .map(stage => {
        const name = memberNameById.get(stage.ownerBotId) ?? stage.ownerBotId
        if (route.mode === 'explicit') return t('channels.mentionedOwner', { name })
        const claim = route.claims.find(c => c.botId === stage.ownerBotId)
        return t('channels.claimedBy', { name, confidence: claim?.confidence ?? 0 })
      })
      .join(' · ')
  }, [t, memberNameById])

  return (
    <div data-testid="channel-chat" className="flex flex-col h-full min-h-0">
      <PanelHeader title={channel?.name ?? t('channels.title')} />

      <div
        data-testid="channel-members"
        className="flex flex-wrap items-center gap-2 border-b border-foreground/10 px-4 py-2"
      >
        {members.map(member => (
          <span
            key={member.botId}
            data-testid={`channel-member-${member.botId}`}
            className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] pl-2.5 pr-1 py-0.5 text-xs"
          >
            {member.name}
            <button
              type="button"
              aria-label={t('channels.removeMember')}
              title={t('channels.removeMember')}
              onClick={() => handleRemoveMember(member.botId)}
              className="rounded-full p-0.5 hover:bg-foreground/10"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {isAddingMember ? (
          <form onSubmit={handleAddMember} className="flex items-center gap-2">
            <Input
              data-testid="channel-member-input"
              autoFocus
              value={memberName}
              onChange={e => setMemberName(e.target.value)}
              placeholder={t('channels.memberPlaceholder')}
              className="h-7 w-48 text-xs"
            />
            <Button type="submit" size="sm" disabled={memberBusy} data-testid="channel-member-submit">
              {t('channels.addMember')}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setIsAddingMember(true)}
            data-testid="channel-member-add"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('channels.addMember')}
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('channels.journalEmpty')}</p>
        ) : (
          entries.map(entry => (
            <div
              key={entry.entryId}
              data-testid={`channel-journal-entry-${entry.entryId}`}
              data-entry-kind={entry.kind}
              data-author-bot-id={entry.authorBotId}
              className="text-sm"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {entry.authorBotId
                  ? `${entry.kind} · ${memberNameById.get(entry.authorBotId) ?? entry.authorBotId}`
                  : entry.kind}
              </div>
              <div className="whitespace-pre-wrap break-words">{entry.body}</div>
            </div>
          ))
        )}
      </div>

      {routes.length > 0 && (
        <div className="border-t border-foreground/10 px-4 py-2 flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t('channels.routing')}
          </div>
          {routes.map(route => (
            <div
              key={route.routeId}
              data-testid={`channel-route-${route.routeId}`}
              data-route-mode={route.mode}
              data-owner-bot-id={
                route.stages.length > 0
                  ? route.stages.map(stage => stage.ownerBotId).join(' ')
                  : undefined
              }
              className="text-xs text-muted-foreground"
            >
              {describeRoute(route)}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-foreground/10 px-4 py-3">
        <Input
          data-testid="channel-chat-input"
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder={t('channels.messagePlaceholder')}
          disabled={sending}
        />
        <Button type="submit" disabled={sending} data-testid="channel-chat-send">
          {t('channels.send')}
        </Button>
      </form>
    </div>
  )
}
