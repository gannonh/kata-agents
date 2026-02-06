# Phase 9 Plan 01: Thread agentSlug Through Event Pipeline Summary

**One-liner:** Thread agentSlug from Task tool input through sessions.ts, event processor, and UI so the sub-agent badge displays the actual agent type instead of raw toolInput lookup.

---

## What Was Done

### Task 1: Add agentSlug to core types and event pipeline
- Added `agentSlug?: string` to `Message` interface after `parentToolUseId`
- Added `agentSlug?: string` to `StoredMessage` interface after `parentToolUseId`
- Added `agentSlug?: string` to `ToolStartEvent` interface after `toolDisplayMeta`

### Task 2: Extract and propagate agentSlug through sessions.ts and tool handler
- Extract `agentSlug` from `formattedToolInput.subagent_type` when `toolName === 'Task'` in the `tool_start` case
- Store `agentSlug` on both new and existing tool messages in sessions.ts
- Send `agentSlug` in the renderer event from sessions.ts `sendEvent` call
- Pass `agentSlug` through both update and create paths in `handleToolStart`

### Task 3: Thread agentSlug through UI layer and prefer it in badge
- Added `agentSlug` field to `ActivityItem` interface in TurnCard.tsx
- Changed `ActivityGroupRow` to prefer `agentSlug` over `toolInput?.subagent_type` for badge label
- Added `agentSlug` passthrough in `storedToMessage()` (stored -> runtime Message)
- Added `agentSlug` passthrough in `messageToActivity()` (Message -> ActivityItem)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Extract from `toolInput.subagent_type`, not SDK hooks | Tool input is available synchronously at `tool_start` time; hooks fire later |
| Prefer `agentSlug` field over `toolInput` lookup in badge | Explicit field is stable against the SDK dual-event pattern where first `tool_start` arrives with empty input |
| Optional field on all types | Not all tool messages are Task sub-agents; keeps backward compatibility |

## Deviations from Plan

None. Plan executed exactly as written.

## Verification Results

- `bun run typecheck:all`: passes
- `bun test`: 1322 pass, 0 fail (zero regressions)
- `bun run lint:electron`: 0 errors (47 pre-existing warnings)
- `agentSlug` present in all 6 target files

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/types/message.ts` | Added `agentSlug` to Message and StoredMessage |
| `apps/electron/src/renderer/event-processor/types.ts` | Added `agentSlug` to ToolStartEvent |
| `apps/electron/src/main/sessions.ts` | Extract agentSlug from Task input, store on messages, send in event |
| `apps/electron/src/renderer/event-processor/handlers/tool.ts` | Pass agentSlug through update and create paths |
| `packages/ui/src/components/chat/TurnCard.tsx` | Added agentSlug to ActivityItem, prefer in badge |
| `packages/ui/src/components/chat/turn-utils.ts` | Pass agentSlug in storedToMessage and messageToActivity |

## Commits

| Hash | Message |
|------|---------|
| `f5243d4` | feat(09-01): add agentSlug field to core types and event pipeline |
| `6602c18` | feat(09-01): extract and propagate agentSlug through sessions and tool handler |
| `69868bb` | feat(09-01): thread agentSlug through UI layer and prefer it in badge |

## Next Phase Readiness

All four Phase 9 success criteria are addressed:
1. Sub-agent events already appear in session (verified by research, existing pipeline)
2. Collapsible group already renders (ActivityGroupRow, existing component)
3. Agent type badge now displays agentSlug instead of falling back to raw toolInput lookup
4. Depth indentation already works (calculateActivityDepths, existing function)

No blockers for Phase 10 (Sub-Agent Lifecycle Display).

---

**Duration:** ~2 minutes
**Completed:** 2026-02-06
