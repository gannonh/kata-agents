import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import type {
  BotPublicDto,
  ChannelPublicDto,
  JournalEntry,
  RouteRecord,
} from '@kata-sh/core'
import type { ApprovalCardView, HandoffRailView, KatacodeTaskRailView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelHeader } from '../app-shell/PanelHeader'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { HandoffCard } from '../handoffs/HandoffCard'
import { TaskCard } from '../katacode/TaskCard'
import { mergeHandoffTimeline } from '../handoffs/timeline'
import { useNavigation } from '@/contexts/NavigationContext'

export interface ChannelChatPanelProps {
  workspaceId: string
  channelId: string
}

function mentionNameFromError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = /^Unknown Channel mention: @(.+)$/.exec(message)
  if (!match?.[1]) return null
  return match[1].split(', @')[0] ?? null
}

export function ChannelChatPanel({ workspaceId, channelId }: ChannelChatPanelProps) {
  const { t } = useTranslation()
  const [channel, setChannel] = React.useState<ChannelPublicDto | null>(null)
  const [members, setMembers] = React.useState<BotPublicDto[]>([])
  const [entries, setEntries] = React.useState<JournalEntry[]>([])
  const [handoffs, setHandoffs] = React.useState<HandoffRailView[]>([])
  const [tasks, setTasks] = React.useState<KatacodeTaskRailView[]>([])
  const [approvals, setApprovals] = React.useState<ApprovalCardView[]>([])
  const [routes, setRoutes] = React.useState<RouteRecord[]>([])
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [isAddingMember, setIsAddingMember] = React.useState(false)
  const [memberName, setMemberName] = React.useState('')
  const [memberBusy, setMemberBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const refreshGeneration = React.useRef(0)
  const pendingSend = React.useRef<{ message: string; idempotencyKey: string } | null>(null)
  const { updateRightSidebar } = useNavigation()

  const mapError = React.useCallback((err: unknown): string => {
    const mentionName = mentionNameFromError(err)
    if (mentionName !== null) return t('channels.mentionUnknown', { name: mentionName })
    return err instanceof Error ? err.message : String(err)
  }, [t])

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGeneration.current
    const [journal, loadedRoutes] = await Promise.all([
      window.electronAPI.getChannelJournal(workspaceId, channelId),
      window.electronAPI.listChannelRoutes(workspaceId, channelId),
    ])
    const loadedHandoffs = await window.electronAPI.listConversationHandoffs(channelId)
    const loadedTasks = await window.electronAPI.listConversationKatacodeTasks(channelId)
    if (generation !== refreshGeneration.current) return
    setChannel(journal.channel)
    setMembers(journal.members)
    setEntries(journal.entries)
    setHandoffs(loadedHandoffs)
    setTasks(loadedTasks)
    setRoutes([...loadedRoutes].sort((a, b) => a.routeSeq - b.routeSeq))
    try {
      const loadedApprovals = await window.electronAPI.listConversationApprovals(channelId)
      if (generation !== refreshGeneration.current) return
      setApprovals(loadedApprovals)
    } catch (err) {
      console.error('[Channels] Failed to load approvals:', err)
    }
  }, [workspaceId, channelId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Channels] Failed to load journal:', err))
    const unsubscribe = window.electronAPI.onChannelEvent(() => {
      refresh().catch(err => console.error('[Channels] Failed to refresh journal:', err))
    })
    const unsubscribeHandoffs = window.electronAPI.onHandoffEvent(event => {
      if (event.conversationId !== channelId) return
      refresh().catch(err => console.error('[Channels] Failed to refresh handoffs:', err))
    })
    const unsubscribeKatacode = window.electronAPI.onKatacodeEvent(event => {
      if (event.conversationId !== channelId) return
      refresh().catch(err => console.error('[Channels] Failed to refresh Katacode tasks:', err))
    })
    const unsubscribeApprovals = window.electronAPI.onApprovalEvent(event => {
      if (event.conversationId !== channelId) return
      refresh().catch(err => console.error('[Channels] Failed to refresh approvals:', err))
    })
    return () => {
      refreshGeneration.current += 1
      unsubscribe()
      unsubscribeHandoffs()
      unsubscribeKatacode()
      unsubscribeApprovals()
    }
  }, [refresh])

  const openHandoff = React.useCallback((rail: HandoffRailView) => {
    updateRightSidebar({ type: 'handoff', conversationId: rail.conversationId, handoffId: rail.handoffId })
  }, [updateRightSidebar])

  const openTask = React.useCallback((rail: KatacodeTaskRailView) => {
    updateRightSidebar({ type: 'katacode', conversationId: rail.conversationId, taskId: rail.taskId })
  }, [updateRightSidebar])

  const timeline = React.useMemo(() => {
    return mergeHandoffTimeline(entries, handoffs, approvals, tasks)
  }, [entries, handoffs, approvals, tasks])

  const resolveApproval = React.useCallback(async (card: ApprovalCardView, choice: 'deny' | 'allow-once', createStandingAllow?: boolean) => {
    await window.electronAPI.resolveApproval({
      approvalId: card.approvalId,
      expectedVersion: card.version,
      choice,
      ...(createStandingAllow ? { createStandingAllow: true } : {}),
    })
    await refresh()
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
    setError(null)
    const pending = pendingSend.current?.message === trimmed
      ? pendingSend.current
      : { message: trimmed, idempotencyKey: crypto.randomUUID() }
    pendingSend.current = pending
    try {
      await window.electronAPI.sendChannelMessage(workspaceId, channelId, trimmed, {
        idempotencyKey: pending.idempotencyKey,
        waitForReplies: false,
      })
      pendingSend.current = null
      setMessage('')
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to send message:', err)
      setError(mapError(err))
    } finally {
      setSending(false)
    }
  }, [message, sending, workspaceId, channelId, refresh, mapError])

  const handleAddMember = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = memberName.trim()
    if (!trimmed || memberBusy) return

    setMemberBusy(true)
    setError(null)
    try {
      const bots = await window.electronAPI.listBots(workspaceId, { lifecycle: 'active' })
      const match = bots.find(bot => bot.name.trim().toLowerCase() === trimmed.toLowerCase())
      if (!match) {
        setError(t('channels.mentionUnknown', { name: trimmed }))
        return
      }
      await window.electronAPI.addChannelMember(workspaceId, channelId, match.botId)
      setMemberName('')
      setIsAddingMember(false)
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to add member:', err)
      setError(mapError(err))
    } finally {
      setMemberBusy(false)
    }
  }, [memberName, memberBusy, workspaceId, channelId, refresh, mapError, t])

  const handleRemoveMember = React.useCallback(async (botId: string) => {
    setError(null)
    try {
      await window.electronAPI.removeChannelMember(workspaceId, channelId, botId)
      await refresh()
    } catch (err) {
      console.error('[Channels] Failed to remove member:', err)
      setError(mapError(err))
    }
  }, [workspaceId, channelId, refresh, mapError])

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
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('channels.journalEmpty')}</p>
        ) : (
          timeline.map(item => item.kind === 'handoff' ? (
            <HandoffCard key={item.rail.handoffId} rail={item.rail} onOpen={openHandoff} />
          ) : item.kind === 'katacode' ? (
            <TaskCard key={item.rail.taskId} rail={item.rail} onOpen={openTask} />
          ) : item.kind === 'approval' ? (
            <ApprovalCard key={item.card.approvalId} card={item.card} onResolve={resolveApproval} />
          ) : (
            <div
              key={item.entry.entryId}
              data-testid={`channel-journal-entry-${item.entry.entryId}`}
              data-entry-kind={item.entry.kind}
              data-author-bot-id={item.entry.authorBotId}
              className="text-sm"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {item.entry.authorBotId
                  ? `${item.entry.kind} · ${memberNameById.get(item.entry.authorBotId) ?? item.entry.authorBotId}`
                  : item.entry.kind}
              </div>
              <div className="whitespace-pre-wrap break-words">{item.entry.body}</div>
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

      {error && (
        <div
          data-testid="channel-chat-error"
          role="alert"
          className="px-4 py-2 text-sm text-destructive border-t border-foreground/10"
        >
          {error}
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
