/**
 * BotChatPanel
 *
 * A Bot's single durable DirectChat: the ordered ConversationJournal plus the
 * composer. Sending waits for the Bot reply, then re-reads the journal so the
 * committed entries — not optimistic local state — are what the user sees.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { BotContextSnapshot, BotMemoryHead, BotPublicDto, JournalEntry, StandingRule } from '@kata-sh/core'
import type { ApprovalCardView, HandoffRailView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelHeader } from '../app-shell/PanelHeader'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { HandoffCard } from '../handoffs/HandoffCard'
import { mergeHandoffTimeline } from '../handoffs/timeline'
import { useNavigation } from '@/contexts/NavigationContext'

export interface BotChatPanelProps {
  workspaceId: string
  botId: string
}

export function BotChatPanel({ workspaceId, botId }: BotChatPanelProps) {
  const { t } = useTranslation()
  const [bot, setBot] = React.useState<BotPublicDto | null>(null)
  const [entries, setEntries] = React.useState<JournalEntry[]>([])
  const [handoffs, setHandoffs] = React.useState<HandoffRailView[]>([])
  const [approvals, setApprovals] = React.useState<ApprovalCardView[]>([])
  const [standingRules, setStandingRules] = React.useState<StandingRule[]>([])
  const [memory, setMemory] = React.useState<BotMemoryHead | null>(null)
  const [context, setContext] = React.useState<BotContextSnapshot | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [savingMemory, setSavingMemory] = React.useState<string | null>(null)
  const refreshGeneration = React.useRef(0)
  const pendingSend = React.useRef<{ message: string; idempotencyKey: string } | null>(null)
  const { updateRightSidebar } = useNavigation()

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGeneration.current
    const [journal, loadedMemory, loadedContext] = await Promise.all([
      window.electronAPI.getBotJournal(workspaceId, botId),
      window.electronAPI.getBotMemory(workspaceId, botId),
      window.electronAPI.getBotContext(workspaceId, botId),
    ])
    const loadedHandoffs = await window.electronAPI.listConversationHandoffs(journal.bot.directChatId)
    const loadedApprovals = await window.electronAPI.listConversationApprovals(journal.bot.directChatId)
    const loadedRules = await window.electronAPI.listStandingRules(botId)
    if (generation !== refreshGeneration.current) return
    setBot(journal.bot)
    setEntries(journal.entries)
    setHandoffs(loadedHandoffs)
    setApprovals(loadedApprovals)
    setStandingRules(loadedRules)
    setMemory(loadedMemory)
    setContext(loadedContext)
  }, [workspaceId, botId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Bots] Failed to load journal:', err))
    const unsubscribe = window.electronAPI.onBotEvent(event => {
      if (event.botId && event.botId !== botId) return
      refresh().catch(err => console.error('[Bots] Failed to refresh journal:', err))
    })
    const unsubscribeHandoffs = window.electronAPI.onHandoffEvent(event => {
      if (bot?.directChatId && event.conversationId !== bot.directChatId) return
      refresh().catch(err => console.error('[Bots] Failed to refresh handoffs:', err))
    })
    const unsubscribeApprovals = window.electronAPI.onApprovalEvent(event => {
      if (bot?.directChatId && event.conversationId !== bot.directChatId) return
      refresh().catch(err => console.error('[Bots] Failed to refresh approvals:', err))
    })
    return () => {
      refreshGeneration.current += 1
      unsubscribe()
      unsubscribeHandoffs()
      unsubscribeApprovals()
    }
  }, [refresh, botId, bot?.directChatId])

  const openHandoff = React.useCallback((rail: HandoffRailView) => {
    updateRightSidebar({ type: 'handoff', conversationId: rail.conversationId, handoffId: rail.handoffId })
  }, [updateRightSidebar])

  const timeline = React.useMemo(() => {
    return mergeHandoffTimeline(entries, handoffs, approvals)
  }, [entries, handoffs, approvals])

  const resolveApproval = React.useCallback(async (card: ApprovalCardView, choice: 'deny' | 'allow-once', createStandingAllow?: boolean) => {
    await window.electronAPI.resolveApproval({
      approvalId: card.approvalId,
      expectedVersion: card.version,
      choice,
      ...(createStandingAllow ? { createStandingAllow: true } : {}),
    })
    await refresh()
  }, [refresh])

  const setPermissionMode = React.useCallback(async (permissionMode: BotPublicDto['permissionMode']) => {
    await window.electronAPI.updateBot(workspaceId, botId, { permissionMode })
    await refresh()
  }, [workspaceId, botId, refresh])

  const updateMemory = React.useCallback(async (memoryId: string, kind: 'edit' | 'forget' | 'restore', content?: string) => {
    if (!memory) return
    setSavingMemory(memoryId)
    try {
      await window.electronAPI.mutateBotMemory(workspaceId, botId, kind === 'edit'
        ? { kind, memoryId, content: content ?? '', expectedRevision: memory.revision, idempotencyKey: `ui.${kind}.${memoryId}.${memory.revision}` }
        : { kind, memoryId, expectedRevision: memory.revision, idempotencyKey: `ui.${kind}.${memoryId}.${memory.revision}` })
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to update memory:', err)
    } finally {
      setSavingMemory(null)
    }
  }, [memory, workspaceId, botId, refresh])

  const handleSend = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || sending) return

    setSending(true)
    const pending = pendingSend.current?.message === trimmed
      ? pendingSend.current
      : { message: trimmed, idempotencyKey: crypto.randomUUID() }
    pendingSend.current = pending
    try {
      await window.electronAPI.sendBotMessage(workspaceId, botId, trimmed, {
        waitForReply: true,
        idempotencyKey: pending.idempotencyKey,
      })
      pendingSend.current = null
      setMessage('')
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to send message:', err)
      await refresh().catch(() => undefined)
    } finally {
      setSending(false)
    }
  }, [message, sending, workspaceId, botId, refresh])

  return (
    <div data-testid="bot-chat" className="flex flex-col h-full min-h-0">
      <PanelHeader title={bot?.name ?? t('bots.title')} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        <section data-testid="bot-policy-panel" className="rounded border border-foreground/10 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <strong>{t('approvals.policyHeading')}</strong>
            <select
              data-testid="bot-permission-mode"
              className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
              value={bot?.permissionMode ?? 'ask'}
              onChange={event => setPermissionMode(event.target.value as BotPublicDto['permissionMode'])}
            >
              <option value="safe">{t('mode.safe')}</option>
              <option value="ask">{t('mode.ask')}</option>
              <option value="allow-all">{t('mode.allow-all')}</option>
            </select>
          </div>
          <strong className="text-sm">{t('approvals.standingHeading')}</strong>
          {standingRules.length === 0 ? (
            <p data-testid="bot-standing-empty" className="text-xs text-muted-foreground">{t('approvals.standingEmpty')}</p>
          ) : standingRules.map(rule => (
            <div key={rule.ruleId} data-testid={`standing-rule-${rule.ruleId}`} data-rule-state={rule.state} className="flex items-center justify-between gap-2 border-t border-foreground/10 pt-2 text-xs">
              <span>{rule.toolName} {rule.target} ({rule.effect})</span>
              <div className="flex gap-1">
                {rule.state === 'active' && (
                  <Button type="button" size="sm" variant="outline" data-testid={`standing-rule-disable-${rule.ruleId}`} onClick={() => window.electronAPI.disableStandingRule({ ruleId: rule.ruleId, expectedVersion: rule.version }).then(() => refresh())}>
                    {t('approvals.disableRule')}
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" data-testid={`standing-rule-delete-${rule.ruleId}`} onClick={() => window.electronAPI.deleteStandingRule({ ruleId: rule.ruleId }).then(() => refresh())}>
                  {t('approvals.deleteRule')}
                </Button>
              </div>
            </div>
          ))}
        </section>
        <section data-testid="bot-memory-panel" className="rounded border border-foreground/10 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <strong>{t('bots.memoryHeading')}</strong>
            <span data-testid="bot-memory-revision" className="text-xs text-muted-foreground">v{memory?.revision ?? 0}</span>
          </div>
          {context && (
            <div data-testid="bot-memory-context" data-memory-ids={context.context.memoryIds.join(',')} data-journal-cursor={context.context.journalCursor} data-conversation-cursor={context.context.conversationCursor} data-checkpoint-revision={context.context.checkpointRevision} className="text-xs text-muted-foreground">
              {t('bots.contextProvenance')}: {context.context.memoryIds.length} · {context.context.checkpointRevision > 0 ? t('bots.contextCheckpoint', { revision: context.context.checkpointRevision }) : t('bots.contextNoCheckpoint')}
            </div>
          )}
          {!memory || memory.memories.length === 0 ? (
            <p data-testid="bot-memory-empty" className="text-xs text-muted-foreground">{t('bots.memoryEmpty')}</p>
          ) : memory.memories.map(item => (
            <div key={item.memoryId} data-testid={`bot-memory-${item.memoryId}`} data-memory-state={item.state} data-memory-provenance={item.provenance.map(source => `${source.conversationId}:${source.entryId}:${source.seq}`).join('|')} className="flex flex-col gap-1 border-t border-foreground/10 pt-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t(`bots.memoryState${item.state[0].toUpperCase()}${item.state.slice(1)}`)}</span>
                <span>{item.provenance[0]?.entryId ?? ''}</span>
              </div>
              <Input
                data-testid={`bot-memory-input-${item.memoryId}`}
                value={drafts[item.memoryId] ?? item.content}
                onChange={event => setDrafts(current => ({ ...current, [item.memoryId]: event.target.value }))}
                disabled={item.state === 'forgotten' || savingMemory === item.memoryId}
              />
              <div className="flex gap-2">
                {item.state !== 'forgotten' && <Button type="button" size="sm" disabled={savingMemory === item.memoryId} data-testid={`bot-memory-save-${item.memoryId}`} onClick={() => updateMemory(item.memoryId, 'edit', drafts[item.memoryId] ?? item.content)}>{t('bots.memorySave')}</Button>}
                {item.state !== 'forgotten' && <Button type="button" size="sm" variant="outline" disabled={savingMemory === item.memoryId} data-testid={`bot-memory-forget-${item.memoryId}`} onClick={() => updateMemory(item.memoryId, 'forget')}>{t('bots.memoryForget')}</Button>}
                {item.state === 'forgotten' && <Button type="button" size="sm" variant="outline" disabled={savingMemory === item.memoryId} data-testid={`bot-memory-restore-${item.memoryId}`} onClick={() => updateMemory(item.memoryId, 'restore')}>{t('bots.memoryRestore')}</Button>}
              </div>
              <div className="text-xs text-muted-foreground">{item.provenance.map(source => `${source.conversationId}:${source.seq}`).join(', ')}</div>
            </div>
          ))}
        </section>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('bots.journalEmpty')}</p>
        ) : (
          timeline.map(item => item.kind === 'handoff' ? (
            <HandoffCard key={item.rail.handoffId} rail={item.rail} onOpen={openHandoff} />
          ) : item.kind === 'approval' ? (
            <ApprovalCard key={item.card.approvalId} card={item.card} onResolve={resolveApproval} />
          ) : (
            <div
              key={item.entry.entryId}
              data-testid={`bot-journal-entry-${item.entry.entryId}`}
              data-entry-kind={item.entry.kind}
              className="text-sm"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {item.entry.kind}
              </div>
              <div className="whitespace-pre-wrap break-words">{item.entry.body}</div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-foreground/10 px-4 py-3">
        <Input
          data-testid="bot-chat-input"
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder={t('bots.messagePlaceholder')}
          disabled={sending}
        />
        <Button type="submit" disabled={sending} data-testid="bot-chat-send">
          {t('bots.send')}
        </Button>
      </form>
    </div>
  )
}
