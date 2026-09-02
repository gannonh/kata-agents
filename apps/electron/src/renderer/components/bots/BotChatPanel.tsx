/**
 * BotChatPanel
 *
 * A Bot's single durable DirectChat: the ordered ConversationJournal plus the
 * composer. Sending waits for the Bot reply, then re-reads the journal so the
 * committed entries — not optimistic local state — are what the user sees.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { BotContextSnapshot, BotMemoryHead, BotPublicDto, ChannelPublicDto, JournalEntry, RoutinePublicDto, RoutineRevision, RoutineRunPublicDto, StandingRule } from '@kata-sh/core'
import type { ApprovalCardView, HandoffRailView, KatacodeTaskRailView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelHeader } from '../app-shell/PanelHeader'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { HandoffCard } from '../handoffs/HandoffCard'
import { TaskCard } from '../katacode/TaskCard'
import { mergeHandoffTimeline } from '../handoffs/timeline'
import { useNavigation } from '@/contexts/NavigationContext'

export interface BotChatPanelProps {
  workspaceId: string
  botId: string
}

const ROUTINE_STATE_KEYS: Record<RoutineRunPublicDto['state']['kind'], string> = {
  queued: 'routines.stateQueued',
  claimed: 'routines.stateClaimed',
  running: 'routines.stateRunning',
  'awaiting-approval': 'routines.stateAwaitingApproval',
  succeeded: 'routines.stateSucceeded',
  failed: 'routines.stateFailed',
  cancelled: 'routines.stateCancelled',
  uncertain: 'routines.stateUncertain',
  reconciled: 'routines.stateReconciled',
}

const ROUTINE_LIFECYCLE_KEYS: Record<RoutinePublicDto['lifecycle'], string> = {
  enabled: 'routines.lifecycleEnabled',
  paused: 'routines.lifecyclePaused',
  deleted: 'routines.lifecycleDeleted',
}

export function BotChatPanel({ workspaceId, botId }: BotChatPanelProps) {
  const { t } = useTranslation()
  const [bot, setBot] = React.useState<BotPublicDto | null>(null)
  const [entries, setEntries] = React.useState<JournalEntry[]>([])
  const [handoffs, setHandoffs] = React.useState<HandoffRailView[]>([])
  const [tasks, setTasks] = React.useState<KatacodeTaskRailView[]>([])
  const [approvals, setApprovals] = React.useState<ApprovalCardView[]>([])
  const [standingRules, setStandingRules] = React.useState<StandingRule[]>([])
  const [memory, setMemory] = React.useState<BotMemoryHead | null>(null)
  const [context, setContext] = React.useState<BotContextSnapshot | null>(null)
  const [routines, setRoutines] = React.useState<RoutinePublicDto[]>([])
  const [routineRuns, setRoutineRuns] = React.useState<Record<string, RoutineRunPublicDto[]>>({})
  const [channels, setChannels] = React.useState<ChannelPublicDto[]>([])
  const [routineName, setRoutineName] = React.useState('')
  const [routineInput, setRoutineInput] = React.useState('')
  const [routineExpectedResult, setRoutineExpectedResult] = React.useState('Done.')
  const [routineTriggerKind, setRoutineTriggerKind] = React.useState<RoutineRevision['trigger']['kind']>('schedule')
  const [routineEventSource, setRoutineEventSource] = React.useState('SessionStatusChange')
  const [routineEventField, setRoutineEventField] = React.useState('newState')
  const [routineEventValue, setRoutineEventValue] = React.useState('done')
  const [routineCron, setRoutineCron] = React.useState('0 9 * * *')
  const [routineTimezone, setRoutineTimezone] = React.useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [routineApprovalBoundary, setRoutineApprovalBoundary] = React.useState<BotPublicDto['permissionMode']>('ask')
  const [routineFailurePolicy, setRoutineFailurePolicy] = React.useState<'stop' | 'retry' | 'uncertain'>('uncertain')
  const [routineDestinationKind, setRoutineDestinationKind] = React.useState<'direct' | 'channel'>('direct')
  const [routineChannelId, setRoutineChannelId] = React.useState('')
  const [routineBusy, setRoutineBusy] = React.useState<string | null>(null)
  const [routineError, setRoutineError] = React.useState<string | null>(null)
  const [editingRoutineId, setEditingRoutineId] = React.useState<string | null>(null)
  const [editRoutineName, setEditRoutineName] = React.useState('')
  const [editRoutineInput, setEditRoutineInput] = React.useState('')
  const [editRoutineExpectedResult, setEditRoutineExpectedResult] = React.useState('')
  const [editRoutineCron, setEditRoutineCron] = React.useState('')
  const [editRoutineTimezone, setEditRoutineTimezone] = React.useState('')
  const [editRoutineApprovalBoundary, setEditRoutineApprovalBoundary] = React.useState<RoutineRevision['approvalBoundary']>('ask')
  const [editRoutineFailurePolicy, setEditRoutineFailurePolicy] = React.useState<RoutineRevision['failurePolicy']>('uncertain')
  const [editRoutineDestinationKind, setEditRoutineDestinationKind] = React.useState<RoutineRevision['destination']['kind']>('direct')
  const [editRoutineChannelId, setEditRoutineChannelId] = React.useState('')
  const [editRoutineEventSource, setEditRoutineEventSource] = React.useState('')
  const [editRoutineEventField, setEditRoutineEventField] = React.useState('')
  const [editRoutineEventValue, setEditRoutineEventValue] = React.useState('')
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
    const loadedTasks = await window.electronAPI.listConversationKatacodeTasks(journal.bot.directChatId)
    const loadedApprovals = await window.electronAPI.listConversationApprovals(journal.bot.directChatId)
    const loadedRules = await window.electronAPI.listStandingRules(botId)
    const loadedRoutines = await window.electronAPI.listRoutines(workspaceId, botId)
    const loadedChannels = await window.electronAPI.listChannels(workspaceId, { lifecycle: 'active' })
    const loadedRuns = await Promise.all(loadedRoutines.map(async routine => [routine.routineId, await window.electronAPI.listRoutineRuns(workspaceId, routine.routineId, 5)] as const))
    if (generation !== refreshGeneration.current) return
    setBot(journal.bot)
    setEntries(journal.entries)
    setHandoffs(loadedHandoffs)
    setTasks(loadedTasks)
    setApprovals(loadedApprovals)
    setStandingRules(loadedRules)
    setMemory(loadedMemory)
    setContext(loadedContext)
    setRoutines(loadedRoutines)
    setRoutineRuns(Object.fromEntries(loadedRuns))
    setChannels(loadedChannels)
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
    const unsubscribeKatacode = window.electronAPI.onKatacodeEvent(event => {
      if (bot?.directChatId && event.conversationId !== bot.directChatId) return
      refresh().catch(err => console.error('[Bots] Failed to refresh Katacode tasks:', err))
    })
    const unsubscribeApprovals = window.electronAPI.onApprovalEvent(event => {
      if (bot?.directChatId && event.conversationId !== bot.directChatId) return
      refresh().catch(err => console.error('[Bots] Failed to refresh approvals:', err))
    })
    const unsubscribeRoutines = window.electronAPI.onRoutineEvent(() => {
      refresh().catch(err => console.error('[Bots] Failed to refresh routines:', err))
    })
    return () => {
      refreshGeneration.current += 1
      unsubscribe()
      unsubscribeHandoffs()
      unsubscribeKatacode()
      unsubscribeApprovals()
      unsubscribeRoutines()
    }
  }, [refresh, botId, bot?.directChatId])

  React.useEffect(() => {
    if (bot) setRoutineApprovalBoundary(bot.permissionMode)
  }, [bot?.permissionMode])

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

  const createRoutine = React.useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!bot || !routineName.trim() || !routineInput.trim() || !routineExpectedResult.trim() || routineBusy) return
    if (routineDestinationKind === 'channel' && !routineChannelId) return
    setRoutineBusy('create')
    try {
      const trigger: RoutineRevision['trigger'] = routineTriggerKind === 'schedule'
        ? { kind: 'schedule', cron: routineCron.trim(), timezone: routineTimezone.trim(), dst: { gap: 'skip', fold: 'once' } }
        : routineTriggerKind === 'event'
          ? { kind: 'event', source: routineEventSource.trim(), matcher: { field: routineEventField.trim(), equals: routineEventValue } }
          : { kind: 'on-demand' }
      await window.electronAPI.createRoutine(workspaceId, {
        ownerBotId: botId,
        name: routineName.trim(),
        trigger,
        input: routineInput.trim(),
        expectedResult: routineExpectedResult.trim(),
        approvalBoundary: routineApprovalBoundary,
        failurePolicy: routineFailurePolicy,
        destination: routineDestinationKind === 'channel'
          ? { kind: 'channel', channelId: routineChannelId }
          : { kind: 'direct', chatId: bot.directChatId },
      })
      setRoutineName('')
      setRoutineInput('')
      setRoutineExpectedResult('Done.')
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to create routine:', err)
    } finally {
      setRoutineBusy(null)
    }
  }, [bot, botId, routineBusy, routineName, routineInput, routineExpectedResult, routineTriggerKind, routineEventSource, routineEventField, routineEventValue, routineCron, routineTimezone, routineApprovalBoundary, routineFailurePolicy, routineDestinationKind, routineChannelId, workspaceId, refresh])

  const beginEditRoutine = React.useCallback((routine: RoutinePublicDto) => {
    setEditingRoutineId(routine.routineId)
    setEditRoutineName(routine.name)
    setEditRoutineInput(routine.revision.input)
    setEditRoutineExpectedResult(routine.revision.expectedResult)
    setEditRoutineApprovalBoundary(routine.revision.approvalBoundary)
    setEditRoutineFailurePolicy(routine.revision.failurePolicy)
    setEditRoutineDestinationKind(routine.revision.destination.kind)
    setEditRoutineChannelId(routine.revision.destination.kind === 'channel' ? routine.revision.destination.channelId : '')
    if (routine.revision.trigger.kind === 'schedule') {
      setEditRoutineCron(routine.revision.trigger.cron)
      setEditRoutineTimezone(routine.revision.trigger.timezone)
    }
    if (routine.revision.trigger.kind === 'event') {
      setEditRoutineEventSource(routine.revision.trigger.source)
      setEditRoutineEventField(routine.revision.trigger.matcher.field)
      setEditRoutineEventValue(routine.revision.trigger.matcher.equals ?? routine.revision.trigger.matcher.matches ?? '')
    }
  }, [])

  const saveRoutine = React.useCallback(async (routine: RoutinePublicDto) => {
    const directChatId = routine.revision.destination.kind === 'direct' ? routine.revision.destination.chatId : bot?.directChatId
    if (editRoutineDestinationKind === 'channel' && !editRoutineChannelId) return
    if (editRoutineDestinationKind === 'direct' && !directChatId) return
    setRoutineBusy(routine.routineId)
    try {
      const trigger: RoutineRevision['trigger'] = routine.revision.trigger.kind === 'schedule'
        ? { kind: 'schedule', cron: editRoutineCron.trim(), timezone: editRoutineTimezone.trim(), dst: { gap: 'skip', fold: 'once' } }
        : routine.revision.trigger.kind === 'event'
          ? routine.revision.trigger.matcher.matches !== undefined
            ? { kind: 'event', source: editRoutineEventSource.trim(), matcher: { field: editRoutineEventField.trim(), matches: editRoutineEventValue } }
            : { kind: 'event', source: editRoutineEventSource.trim(), matcher: { field: editRoutineEventField.trim(), equals: editRoutineEventValue } }
          : routine.revision.trigger
      await window.electronAPI.updateRoutine(workspaceId, routine.routineId, {
        name: editRoutineName.trim(),
        input: editRoutineInput.trim(),
        expectedResult: editRoutineExpectedResult.trim(),
        approvalBoundary: editRoutineApprovalBoundary,
        failurePolicy: editRoutineFailurePolicy,
        destination: editRoutineDestinationKind === 'channel'
          ? { kind: 'channel', channelId: editRoutineChannelId }
          : { kind: 'direct', chatId: directChatId! },
        trigger,
      })
      setEditingRoutineId(null)
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to edit routine:', err)
    } finally {
      setRoutineBusy(null)
    }
  }, [bot?.directChatId, editRoutineName, editRoutineInput, editRoutineExpectedResult, editRoutineCron, editRoutineTimezone, editRoutineApprovalBoundary, editRoutineFailurePolicy, editRoutineDestinationKind, editRoutineChannelId, editRoutineEventSource, editRoutineEventField, editRoutineEventValue, workspaceId, refresh])

  const runRoutine = React.useCallback(async (routine: RoutinePublicDto) => {
    if (routine.lifecycle !== 'enabled') {
      setRoutineError(t('routines.notEnabled'))
      return
    }
    setRoutineError(null)
    setRoutineBusy(routine.routineId)
    try {
      await window.electronAPI.testRoutine(workspaceId, routine.routineId)
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to run routine:', err)
      setRoutineError(t('routines.runFailed'))
    } finally {
      setRoutineBusy(null)
    }
  }, [workspaceId, refresh, t])

  const replayRoutine = React.useCallback(async (run: RoutineRunPublicDto) => {
    setRoutineBusy(run.routineId)
    try {
      await window.electronAPI.replayRoutineRun(workspaceId, run.runId)
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to replay routine:', err)
    } finally {
      setRoutineBusy(null)
    }
  }, [workspaceId, refresh])

  const toggleRoutine = React.useCallback(async (routine: RoutinePublicDto) => {
    setRoutineBusy(routine.routineId)
    try {
      if (routine.lifecycle === 'enabled') await window.electronAPI.pauseRoutine(workspaceId, routine.routineId)
      else await window.electronAPI.enableRoutine(workspaceId, routine.routineId)
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to change routine state:', err)
    } finally {
      setRoutineBusy(null)
    }
  }, [workspaceId, refresh])

  const deleteRoutine = React.useCallback(async (routine: RoutinePublicDto) => {
    setRoutineBusy(routine.routineId)
    try {
      await window.electronAPI.deleteRoutine(workspaceId, routine.routineId)
      await refresh()
    } catch (err) {
      console.error('[Bots] Failed to delete routine:', err)
    } finally {
      setRoutineBusy(null)
    }
  }, [workspaceId, refresh])

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
        <section data-testid="bot-routines-panel" className="rounded border border-foreground/10 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <strong>{t('routines.title')}</strong>
            <span className="text-xs text-muted-foreground">{routines.length}</span>
          </div>
          {routineError && <p data-testid="routine-action-error" className="text-xs text-destructive">{routineError}</p>}
          <form onSubmit={createRoutine} className="grid gap-2 border-t border-foreground/10 pt-2">
            <Input
              data-testid="routine-name-input"
              value={routineName}
              onChange={event => setRoutineName(event.target.value)}
              placeholder={t('routines.name')}
              required
            />
            <Input
              data-testid="routine-input"
              value={routineInput}
              onChange={event => setRoutineInput(event.target.value)}
              placeholder={t('routines.input')}
              required
            />
            <Input
              data-testid="routine-expected-result-input"
              value={routineExpectedResult}
              onChange={event => setRoutineExpectedResult(event.target.value)}
              placeholder={t('routines.expectedResult')}
              aria-label={t('routines.expectedResult')}
              required
            />
            <select
              data-testid="routine-trigger-select"
              className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
              value={routineTriggerKind}
              onChange={event => setRoutineTriggerKind(event.target.value as RoutineRevision['trigger']['kind'])}
              aria-label={t('routines.trigger')}
            >
              <option value="schedule">{t('routines.scheduleTrigger')}</option>
              <option value="event">{t('routines.eventTrigger')}</option>
              <option value="on-demand">{t('routines.onDemandTrigger')}</option>
            </select>
            {routineTriggerKind === 'schedule' && (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  data-testid="routine-cron-input"
                  value={routineCron}
                  onChange={event => setRoutineCron(event.target.value)}
                  placeholder={t('routines.cron')}
                  aria-label={t('routines.cron')}
                  required
                />
                <Input
                  data-testid="routine-timezone-input"
                  value={routineTimezone}
                  onChange={event => setRoutineTimezone(event.target.value)}
                  placeholder={t('routines.timezone')}
                  aria-label={t('routines.timezone')}
                  required
                />
              </div>
            )}
            {routineTriggerKind === 'event' && (
              <div className="grid grid-cols-3 gap-2">
                <Input data-testid="routine-event-source" value={routineEventSource} onChange={event => setRoutineEventSource(event.target.value)} placeholder={t('routines.eventSource')} aria-label={t('routines.eventSource')} required />
                <Input data-testid="routine-event-field" value={routineEventField} onChange={event => setRoutineEventField(event.target.value)} placeholder={t('routines.eventField')} aria-label={t('routines.eventField')} required />
                <Input data-testid="routine-event-value" value={routineEventValue} onChange={event => setRoutineEventValue(event.target.value)} placeholder={t('routines.eventValue')} aria-label={t('routines.eventValue')} required />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <select
                data-testid="routine-approval-select"
                className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
                value={routineApprovalBoundary}
                onChange={event => setRoutineApprovalBoundary(event.target.value as BotPublicDto['permissionMode'])}
                aria-label={t('routines.approvalBoundary')}
              >
                <option value="safe">{t('mode.safe')}</option>
                <option value="ask">{t('mode.ask')}</option>
                <option value="allow-all">{t('mode.allow-all')}</option>
              </select>
              <select
                data-testid="routine-failure-select"
                className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
                value={routineFailurePolicy}
                onChange={event => setRoutineFailurePolicy(event.target.value as 'stop' | 'retry' | 'uncertain')}
                aria-label={t('routines.failurePolicy')}
              >
                <option value="stop">{t('routines.failureStop')}</option>
                <option value="retry">{t('routines.failureRetry')}</option>
                <option value="uncertain">{t('routines.failureUncertain')}</option>
              </select>
            </div>
            <select
              data-testid="routine-destination-select"
              className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
              value={routineDestinationKind === 'channel' ? `channel:${routineChannelId}` : 'direct'}
              onChange={event => {
                const value = event.target.value
                if (value === 'direct') setRoutineDestinationKind('direct')
                else { setRoutineDestinationKind('channel'); setRoutineChannelId(value.slice('channel:'.length)) }
              }}
              aria-label={t('routines.destination')}
            >
              <option value="direct">{t('routines.directDestination')}</option>
              {channels.filter(channel => channel.members.some(member => member.botId === botId)).map(channel => (
                <option key={channel.channelId} value={`channel:${channel.channelId}`}>{channel.name}</option>
              ))}
            </select>
            <Button type="submit" size="sm" disabled={routineBusy !== null} data-testid="routine-create">
              {t('routines.create')}
            </Button>
          </form>
          {routines.length === 0 ? (
            <p data-testid="routine-empty" className="text-xs text-muted-foreground">{t('routines.noRoutines')}</p>
          ) : routines.map(routine => {
            const trigger = routine.revision.trigger
            const latest = routineRuns[routine.routineId]?.[0]
            const latestStatus = t('routines.status', { status: t(latest ? ROUTINE_STATE_KEYS[latest.state.kind] : ROUTINE_LIFECYCLE_KEYS[routine.lifecycle]) })
            const latestLabel = latest
              ? latest.state.kind === 'succeeded'
                ? latest.state.result
                : latest.state.kind === 'failed'
                  ? latest.state.error
                  : t(ROUTINE_STATE_KEYS[latest.state.kind])
              : ''
            return (
              <div key={routine.routineId} data-testid={`routine-${routine.routineId}`} data-routine-state={routine.lifecycle} className="flex flex-col gap-1 border-t border-foreground/10 pt-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <strong>{routine.name}</strong>
                  <span className="text-xs text-muted-foreground">{latestStatus}</span>
                </div>
                  <div className="text-xs text-muted-foreground">
                  {trigger.kind === 'schedule'
                    ? `${trigger.cron} · ${trigger.timezone}${routine.nextRunAt ? ` · ${new Date(routine.nextRunAt).toLocaleString()}` : ''}`
                    : trigger.kind === 'event' ? `${t('routines.eventTrigger')} · ${trigger.source}` : t('routines.onDemandTrigger')}
                </div>
                {editingRoutineId === routine.routineId && (
                  <div data-testid={`routine-edit-${routine.routineId}`} className="grid gap-2">
                    <Input value={editRoutineName} onChange={event => setEditRoutineName(event.target.value)} aria-label={t('routines.name')} required />
                    <Input value={editRoutineInput} onChange={event => setEditRoutineInput(event.target.value)} aria-label={t('routines.input')} required />
                    <Input value={editRoutineExpectedResult} onChange={event => setEditRoutineExpectedResult(event.target.value)} aria-label={t('routines.expectedResult')} required />
                    {trigger.kind === 'schedule' && (
                      <div className="grid grid-cols-2 gap-2">
                        <Input value={editRoutineCron} onChange={event => setEditRoutineCron(event.target.value)} aria-label={t('routines.cron')} required />
                        <Input value={editRoutineTimezone} onChange={event => setEditRoutineTimezone(event.target.value)} aria-label={t('routines.timezone')} required />
                      </div>
                    )}
                    {trigger.kind === 'event' && (
                      <div className="grid grid-cols-3 gap-2">
                        <Input value={editRoutineEventSource} onChange={event => setEditRoutineEventSource(event.target.value)} aria-label={t('routines.eventSource')} required />
                        <Input value={editRoutineEventField} onChange={event => setEditRoutineEventField(event.target.value)} aria-label={t('routines.eventField')} required />
                        <Input value={editRoutineEventValue} onChange={event => setEditRoutineEventValue(event.target.value)} aria-label={t('routines.eventValue')} required />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        data-testid="routine-edit-approval-select"
                        className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
                        value={editRoutineApprovalBoundary}
                        onChange={event => setEditRoutineApprovalBoundary(event.target.value as RoutineRevision['approvalBoundary'])}
                        aria-label={t('routines.approvalBoundary')}
                      >
                        <option value="safe">{t('mode.safe')}</option>
                        <option value="ask">{t('mode.ask')}</option>
                        <option value="allow-all">{t('mode.allow-all')}</option>
                      </select>
                      <select
                        data-testid="routine-edit-failure-select"
                        className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
                        value={editRoutineFailurePolicy}
                        onChange={event => setEditRoutineFailurePolicy(event.target.value as RoutineRevision['failurePolicy'])}
                        aria-label={t('routines.failurePolicy')}
                      >
                        <option value="stop">{t('routines.failureStop')}</option>
                        <option value="retry">{t('routines.failureRetry')}</option>
                        <option value="uncertain">{t('routines.failureUncertain')}</option>
                      </select>
                    </div>
                    <select
                      data-testid="routine-edit-destination-select"
                      className="h-8 rounded border border-foreground/15 bg-transparent px-2 text-sm"
                      value={editRoutineDestinationKind === 'channel' ? `channel:${editRoutineChannelId}` : 'direct'}
                      onChange={event => {
                        const value = event.target.value
                        if (value === 'direct') setEditRoutineDestinationKind('direct')
                        else { setEditRoutineDestinationKind('channel'); setEditRoutineChannelId(value.slice('channel:'.length)) }
                      }}
                      aria-label={t('routines.destination')}
                    >
                      <option value="direct">{t('routines.directDestination')}</option>
                      {channels.filter(channel => channel.members.some(member => member.botId === botId)).map(channel => (
                        <option key={channel.channelId} value={`channel:${channel.channelId}`}>{channel.name}</option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" disabled={routineBusy !== null} onClick={() => saveRoutine(routine)}>{t('bots.memorySave')}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={routineBusy !== null} onClick={() => setEditingRoutineId(null)}>{t('common.cancel')}</Button>
                    </div>
                  </div>
                )}
                {latest && <div data-testid={`routine-latest-${routine.routineId}`} className="text-xs whitespace-pre-wrap break-words">{latestLabel}</div>}
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={routineBusy !== null || routine.lifecycle !== 'enabled'} data-testid={`routine-run-${routine.routineId}`} onClick={() => runRoutine(routine)}>{t('routines.runNow')}</Button>
                  {latest && ['succeeded', 'failed', 'cancelled', 'uncertain', 'reconciled'].includes(latest.state.kind) && <Button type="button" size="sm" variant="outline" disabled={routineBusy !== null} data-testid={`routine-replay-${routine.routineId}`} onClick={() => replayRoutine(latest)}>{t('routines.replay')}</Button>}
                  <Button type="button" size="sm" variant="outline" disabled={routineBusy !== null} data-testid={`routine-toggle-${routine.routineId}`} onClick={() => toggleRoutine(routine)}>{routine.lifecycle === 'enabled' ? t('routines.pause') : t('routines.resume')}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={routineBusy !== null} data-testid={`routine-edit-button-${routine.routineId}`} onClick={() => beginEditRoutine(routine)}>{t('routines.edit')}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={routineBusy !== null} data-testid={`routine-delete-${routine.routineId}`} onClick={() => deleteRoutine(routine)}>{t('routines.delete')}</Button>
                </div>
              </div>
            )
          })}
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
          ) : item.kind === 'katacode' ? (
            <TaskCard key={item.rail.taskId} rail={item.rail} onOpen={openTask} />
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
