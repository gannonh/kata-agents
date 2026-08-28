/**
 * BotChatPanel
 *
 * A Bot's single durable DirectChat: the ordered ConversationJournal plus the
 * composer. Sending waits for the Bot reply, then re-reads the journal so the
 * committed entries — not optimistic local state — are what the user sees.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { BotContextSnapshot, BotMemoryHead, BotPublicDto, JournalEntry } from '@kata-sh/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelHeader } from '../app-shell/PanelHeader'

export interface BotChatPanelProps {
  workspaceId: string
  botId: string
}

export function BotChatPanel({ workspaceId, botId }: BotChatPanelProps) {
  const { t } = useTranslation()
  const [bot, setBot] = React.useState<BotPublicDto | null>(null)
  const [entries, setEntries] = React.useState<JournalEntry[]>([])
  const [memory, setMemory] = React.useState<BotMemoryHead | null>(null)
  const [context, setContext] = React.useState<BotContextSnapshot | null>(null)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [savingMemory, setSavingMemory] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    const [journal, loadedMemory, loadedContext] = await Promise.all([
      window.electronAPI.getBotJournal(workspaceId, botId),
      window.electronAPI.getBotMemory(workspaceId, botId),
      window.electronAPI.getBotContext(workspaceId, botId),
    ])
    setBot(journal.bot)
    setEntries(journal.entries)
    setMemory(loadedMemory)
    setContext(loadedContext)
  }, [workspaceId, botId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Bots] Failed to load journal:', err))
  }, [refresh])

  const updateMemory = React.useCallback(async (memoryId: string, kind: 'edit' | 'forget', content?: string) => {
    if (!memory) return
    setSavingMemory(memoryId)
    try {
      await window.electronAPI.mutateBotMemory(workspaceId, botId, {
        kind,
        memoryId,
        ...(content !== undefined ? { content } : {}),
        expectedRevision: memory.revision,
        idempotencyKey: `ui.${kind}.${memoryId}.${memory.revision}`,
      })
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
    try {
      await window.electronAPI.sendBotMessage(workspaceId, botId, trimmed, { waitForReply: true })
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
        <section data-testid="bot-memory-panel" className="rounded border border-foreground/10 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <strong>{t('bots.memoryHeading')}</strong>
            <span data-testid="bot-memory-revision" className="text-xs text-muted-foreground">v{memory?.revision ?? 0}</span>
          </div>
          {context && (
            <div data-testid="bot-memory-context" data-memory-ids={context.context.memoryIds.join(',')} className="text-xs text-muted-foreground">
              {t('bots.contextProvenance')}: {context.context.memoryIds.length} · {context.context.checkpointRevision > 0 ? `checkpoint ${context.context.checkpointRevision}` : t('bots.contextNoCheckpoint')}
            </div>
          )}
          {!memory || memory.memories.length === 0 ? (
            <p data-testid="bot-memory-empty" className="text-xs text-muted-foreground">{t('bots.memoryEmpty')}</p>
          ) : memory.memories.map(item => (
            <div key={item.memoryId} data-testid={`bot-memory-${item.memoryId}`} data-memory-state={item.state} data-memory-provenance={item.provenance.map(source => `${source.conversationId}:${source.entryId}:${source.seq}`).join('|')} className="flex flex-col gap-1 border-t border-foreground/10 pt-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{item.state}</span>
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
              </div>
              <div className="text-xs text-muted-foreground">{item.provenance.map(source => `${source.conversationId}:${source.seq}`).join(', ')}</div>
            </div>
          ))}
        </section>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('bots.journalEmpty')}</p>
        ) : (
          entries.map(entry => (
            <div
              key={entry.entryId}
              data-testid={`bot-journal-entry-${entry.entryId}`}
              data-entry-kind={entry.kind}
              className="text-sm"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {entry.kind}
              </div>
              <div className="whitespace-pre-wrap break-words">{entry.body}</div>
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
