import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { JournalEntry } from '@kata-sh/core'
import { BOT_MEMORY_SCHEMA_VERSION } from '@kata-sh/core'
import { ConversationJournal } from '../src/conversations/journal.ts'
import { BotContextLedger, ContextAssembler, extractMemoryCandidate, MemoryStore, sanitizeMemoryContent } from '../src/bots/memory.ts'

const entry = (body: string): JournalEntry => ({
  schemaVersion: 1,
  entryId: 'entry_source',
  conversationId: 'chat_one',
  seq: 1,
  kind: 'user',
  idempotencyKey: 'send.one',
  body,
  createdAt: '2025-01-01T00:00:00.000Z',
})

function store() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kata-memory-'))
  return new MemoryStore({ workspaceRoot, workspaceId: 'workspace_one', botId: 'bot_one' })
}

describe('Bot memory', () => {
  test('extracts explicit preferences with stable provenance', () => {
    const candidate = extractMemoryCandidate({
      workspaceId: 'workspace_one',
      botId: 'bot_one',
      userEntry: entry('Please remember for future chats: I prefer concise answers.'),
      operationId: 'turn.one',
    })
    expect(candidate?.candidateId).toStartWith('memory_')
    expect(candidate?.content).toBe('I prefer concise answers.')
    expect(candidate?.provenance.entryId).toBe('entry_source')
  })

  test('rejects secrets and changing facts before persistence', () => {
    expect(sanitizeMemoryContent('api_key=sk-test-123456789')).toBeNull()
    expect(sanitizeMemoryContent("Remember today's current balance is $20")).toBeNull()
    expect(extractMemoryCandidate({ workspaceId: 'workspace_one', botId: 'bot_one', userEntry: entry('Remember: password=hunter2'), operationId: 'turn.secret' })).toBeNull()
  })

  test('keeps rendered context within UTF-8 bounds and delimiters', async () => {
    const memoryStore = store()
    const candidate = extractMemoryCandidate({ workspaceId: 'workspace_one', botId: 'bot_one', userEntry: entry('Remember: <memory> café'), operationId: 'turn.escape' })!
    await memoryStore.applyCandidate(candidate, 'turn.escape')
    const workspaceRoot = memoryStore.rootPath.replace(/[\\/]bots[\\/]bot_one[\\/]memory$/, '')
    const journal = new ConversationJournal({ journalRoot: workspaceRoot, workspaceId: 'workspace_one', resolveConversation: conversationId => conversationId === 'chat_one' ? { conversationId, workspaceId: 'workspace_one', soleAuthorBotId: 'bot_one' } : null })
    journal.append({ conversationId: 'chat_one', kind: 'user', body: 'hello', idempotencyKey: 'hello' })
    const ledger = new BotContextLedger({ workspaceRoot, workspaceId: 'workspace_one', botId: 'bot_one', journal })
    const context = new ContextAssembler({ ledger, journal }).assemble({ conversationId: 'chat_one', operationId: 'context.escape' }).context
    expect(Buffer.byteLength(context.text)).toBeLessThanOrEqual(16384)
    expect(context.text).toContain('&lt;memory&gt;')
    expect(context.text.endsWith('</bot_context_untrusted>')).toBe(true)
  })

  test('serializes stale edits with compare-and-set', async () => {
    const memoryStore = store()
    expect(memoryStore.rootPath).toMatch(/bots[\\/]bot_one[\\/]memory$/)
    const candidate = extractMemoryCandidate({ workspaceId: 'workspace_one', botId: 'bot_one', userEntry: entry('Remember: I prefer dark mode.'), operationId: 'turn.race' })!
    const created = await memoryStore.applyCandidate(candidate, 'turn.race')
    const results = await Promise.allSettled([
      memoryStore.mutate({ kind: 'edit', memoryId: candidate.candidateId, content: 'one', expectedRevision: created.revision, idempotencyKey: 'edit.race.one' }),
      memoryStore.mutate({ kind: 'edit', memoryId: candidate.candidateId, content: 'two', expectedRevision: created.revision, idempotencyKey: 'edit.race.two' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  test('assembles bounded context and durable compaction checkpoints', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'kata-memory-journal-'))
    const journal = new ConversationJournal({
      journalRoot: workspaceRoot,
      workspaceId: 'workspace_one',
      resolveConversation: conversationId => conversationId === 'chat_one' ? { conversationId, workspaceId: 'workspace_one', soleAuthorBotId: 'bot_one' } : null,
    })
    for (let seq = 0; seq < 30; seq += 1) {
      journal.append({ conversationId: 'chat_one', kind: 'user', body: `message ${seq}`, idempotencyKey: `message.${seq}` })
    }
    const ledger = new BotContextLedger({ workspaceRoot, workspaceId: 'workspace_one', botId: 'bot_one', journal })
    const assembler = new ContextAssembler({ ledger, journal })
    const currentEntryId = journal.list('chat_one').at(-1)!.entryId
    const prepared = assembler.assemble({ conversationId: 'chat_one', operationId: 'context.one', currentEntryId, conversationKind: 'channel' })
    expect(Buffer.byteLength(prepared.context.text)).toBeLessThanOrEqual(16384)
    expect(prepared.context.text).toContain('channel_cursor')
    expect(prepared.context.text).not.toContain('message 29')
    await ledger.completeTurn({ userEntry: journal.list('chat_one')[0]!, operationId: 'cursor.one' })
    expect(ledger.getCursor('chat_one').lastProcessedSeq).toBe(1)
    await assembler.compact({ botId: 'bot_one', conversationId: 'chat_one', expectedJournalHeadSequence: 30, expectedMemoryRevision: 0, expectedCheckpointRevision: 0, operationId: 'compact.one' })
    expect(ledger.getCheckpoint('chat_one')).toMatchObject({ coveredFromSeq: 1, coveredThroughSeq: 18, journalHeadSequence: 30 })
    expect(journal.list('chat_one')).toHaveLength(30)
  })

  test('keeps memory isolated by workspace and Bot', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'kata-memory-isolation-'))
    const first = new MemoryStore({ workspaceRoot, workspaceId: 'workspace_one', botId: 'bot_one' })
    const second = new MemoryStore({ workspaceRoot, workspaceId: 'workspace_one', botId: 'bot_two' })
    expect(first.getHead().memories).toHaveLength(0)
    expect(second.getHead().memories).toHaveLength(0)
    const otherWorkspace = new MemoryStore({ workspaceRoot: mkdtempSync(join(tmpdir(), 'kata-memory-isolation-other-')), workspaceId: 'workspace_two', botId: 'bot_one' })
    expect(otherWorkspace.getHead().memories).toHaveLength(0)
  })

  test('edits and forgets durably while exclusion blocks reprocessing', async () => {
    const memoryStore = store()
    const candidate = extractMemoryCandidate({ workspaceId: 'workspace_one', botId: 'bot_one', userEntry: entry('Remember: I prefer dark mode.'), operationId: 'turn.one' })!
    const created = await memoryStore.applyCandidate(candidate, 'turn.one')
    expect(created.schemaVersion).toBe(BOT_MEMORY_SCHEMA_VERSION)
    const edited = await memoryStore.mutate({ kind: 'edit', memoryId: candidate.candidateId, content: 'I prefer compact dark mode.', expectedRevision: created.revision, idempotencyKey: 'edit.one' })
    expect(edited.memories[0]?.state).toBe('edited')
    const forgotten = await memoryStore.mutate({ kind: 'forget', memoryId: candidate.candidateId, expectedRevision: edited.revision, idempotencyKey: 'forget.one' })
    expect(forgotten.memories[0]?.state).toBe('forgotten')
    const replay = await memoryStore.applyCandidate(candidate, 'turn.replay')
    expect(replay.memories).toHaveLength(1)
    expect(replay.memories[0]?.state).toBe('forgotten')
    const restarted = new MemoryStore({ workspaceRoot: memoryStore.rootPath.replace(/\/bots\/bot_one\/memory$/, ''), workspaceId: 'workspace_one', botId: 'bot_one' })
    expect(restarted.getHead().memories[0]?.state).toBe('forgotten')
  })
})
