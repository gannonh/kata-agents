/**
 * BotChatPanel
 *
 * A Bot's single durable DirectChat: the ordered ConversationJournal plus the
 * composer. Sending waits for the Bot reply, then re-reads the journal so the
 * committed entries — not optimistic local state — are what the user sees.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { BotPublicDto, JournalEntry } from '@kata-sh/core'
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
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const journal = await window.electronAPI.getBotJournal(workspaceId, botId)
    setBot(journal.bot)
    setEntries(journal.entries)
  }, [workspaceId, botId])

  React.useEffect(() => {
    refresh().catch(err => console.error('[Bots] Failed to load journal:', err))
  }, [refresh])

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
    } finally {
      setSending(false)
    }
  }, [message, sending, workspaceId, botId, refresh])

  return (
    <div data-testid="bot-chat" className="flex flex-col h-full min-h-0">
      <PanelHeader title={bot?.name ?? t('bots.title')} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
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
