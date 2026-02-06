# Phase 9 Research: Sub-Agent Execution Foundation

**Phase goal:** A sub-agent spawned via the SDK Task tool appears in the message tree as a collapsible group with its agent type visible and nested tool calls indented.

**Requirements:** EXEC-01, EXEC-04, DISPLAY-01, DISPLAY-05

---

## Standard Stack

No new dependencies. Use existing:

| Component | Already in codebase | Used for |
|-----------|-------------------|----------|
| `@anthropic-ai/claude-agent-sdk` | Yes | Task tool, AgentDefinition, SubagentStart/SubagentStop hooks |
| `ActivityGroup` type | Yes (`turn-utils.ts`) | Grouping Task tool children into collapsible sections |
| `groupActivitiesByParent()` | Yes (`turn-utils.ts`) | Converting flat activities to grouped tree |
| `ActivityGroupRow` component | Yes (`TurnCard.tsx`) | Rendering collapsible group with chevron, badge, children |
| `parentToolUseId` tracking | Yes (all layers) | SDK-authoritative parent-child assignment on every message |
| `ToolIndex` | Yes (`tool-matching.ts`) | Stateless ID-based tool lookup |
| framer-motion `AnimatePresence` | Yes (`TurnCard.tsx`) | Animated expand/collapse of children |

**Confidence: HIGH** -- Verified by reading source files.

---

## Architecture Patterns

### 1. SDK Task Tool Event Flow (Verified)

The SDK emits these events when a sub-agent runs:

```
User message
  -> assistant message with tool_use block { name: "Task", id: "toolu_task1", input: { prompt, subagent_type, description } }
     -> SDKAssistantMessage (parent_tool_use_id: null) -- top-level Task call

SubagentStart hook fires: { agent_id, agent_type }

  Sub-agent runs internally:
    -> SDKAssistantMessage (parent_tool_use_id: "toolu_task1") -- sub-agent's assistant messages
       -> tool_use blocks with child tools (Read, Bash, etc.)
    -> SDKUserMessage (parent_tool_use_id: "toolu_task1") -- tool results
       -> tool_result blocks for child tools
    -> SDKToolProgressMessage { tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds }

SubagentStop hook fires: { agent_id, agent_transcript_path }

  -> SDKUserMessage with tool_result for "toolu_task1" -- Task tool result (the sub-agent's final output)
```

Key property: **every** SDK message inside a sub-agent carries `parent_tool_use_id` set to the Task tool's `tool_use_id`. The codebase already reads this field and propagates it through `CraftAgent.chat()` -> `sessions.ts` -> renderer events.

**Confidence: HIGH** -- Verified against SDK types (sdk.d.ts lines 1063-1070, 1267-1273, 1453-1461) and codebase (tool-matching.ts extractToolStarts/extractToolResults).

### 2. Current Event Processing Pipeline

Events flow through this chain:

```
SDK subprocess (Bun)
  -> stdout JSON lines
    -> CraftAgent.chat() processes SDKMessage
      -> emits AgentEvent (type-safe union)
        -> sessions.ts processEvent()
          -> stores Message in managed.messages
          -> sends SessionEvent to renderer via IPC
            -> renderer event-processor processEvent()
              -> updates SessionState (pure function)
                -> Jotai atom triggers re-render
                  -> groupMessagesByTurn() groups into Turn[]
                    -> groupActivitiesByParent() groups Task children
                      -> TurnCard renders ActivityGroupRow
```

**Where agentSlug extraction MUST happen:** In `sessions.ts processEvent()` at the `tool_start` case, when `event.toolName === 'Task'`. Extract from `event.input.subagent_type`.

**Confidence: HIGH** -- Traced through actual files.

### 3. agentSlug Extraction Point

The Task tool input contains `subagent_type` (string). This identifies the agent type.

**Extraction location:** `sessions.ts` line ~3208, inside `case 'tool_start'`:

```typescript
// After existing toolDisplayMeta resolution
if (event.toolName === 'Task') {
  const agentSlug = (formattedToolInput?.subagent_type as string) || undefined
  // Store on the Message so it reaches the renderer
}
```

The `subagent_type` value comes from the SDK tool input. Per `sdk-tools.d.ts` (AgentInput interface, line 44): `subagent_type: string`. Typical values: agent definition names from `Options.agents` keys, or built-in types.

The SDK's `SubagentStartHookInput` (sdk.d.ts line 1610-1614) also provides `agent_type: string` and `agent_id: string`. The codebase already logs these in `craft-agent.ts` line 1457-1458 but does not surface them as events. These hooks fire AFTER the tool_start, so extraction from tool input is simpler and more reliable.

**Confidence: HIGH** -- Verified against SDK type definitions and test fixtures (tool-matching-sdk-fixtures.test.ts line 87).

### 4. Existing ActivityGroup Rendering

`ActivityGroupRow` in TurnCard.tsx (line ~909) already:
- Shows a chevron for expand/collapse (starts collapsed by default when `expandedGroups` Set doesn't contain the group ID)
- Displays a badge with `subagentType || 'Task'` (line 964) read from `group.parent.toolInput?.subagent_type`
- Shows the description from `group.parent.toolInput?.description`
- Renders children with left border indentation (`border-l-2 border-muted ml-[5px]`)
- Auto-completes orphaned children when parent Task completes (safety net in tool.ts handler)
- Tracks `expandedActivityGroups` state via Set<string> (controlled or local)

This means DISPLAY-01 (collapsible group, collapsed by default) and DISPLAY-05 (depth indentation) are **already implemented** at the rendering layer. The requirement is met once sub-agent events flow through with `parentToolUseId` set, which already happens.

**Confidence: VERY HIGH** -- Read the component source directly.

### 5. What's Actually Missing (Gap Analysis)

After tracing the full pipeline, the actual gaps for Phase 9 are smaller than expected:

| Gap | Layer | Effort |
|-----|-------|--------|
| **G1: `agentSlug` field on Message type** | `packages/core/src/types/message.ts` | Add `agentSlug?: string` to Message and StoredMessage |
| **G2: Extract agentSlug in sessions.ts** | `apps/electron/src/main/sessions.ts` | 5 lines in `tool_start` case when toolName === 'Task' |
| **G3: Forward agentSlug in ToolStartEvent** | `event-processor/types.ts` | Add `agentSlug?: string` to ToolStartEvent |
| **G4: Store agentSlug in tool handler** | `event-processor/handlers/tool.ts` | Pass through to Message in handleToolStart |
| **G5: Display agentSlug in ActivityGroupRow** | `TurnCard.tsx` | Already reads `toolInput?.subagent_type` -- may want to prefer explicit `agentSlug` field |
| **G6: Test with real sub-agent** | E2E or manual | Send message that triggers Task tool, verify rendering |

Gaps G1-G5 total roughly 20-30 lines of code changes across 5 files.

**The collapsible group (DISPLAY-01), depth indentation (DISPLAY-05), and parent-child nesting (EXEC-01) are already working.** The only missing piece is explicit `agentSlug` propagation (EXEC-04 agent type badge) and verification that a real sub-agent execution flows through correctly end-to-end.

**Confidence: HIGH** -- Verified by reading all files in the chain.

---

## Don't Hand-Roll

| Problem | Use Instead | Why |
|---------|-------------|-----|
| Parent-child tool relationship tracking | SDK's `parent_tool_use_id` field (already used) | SDK is authoritative; hand-tracking with stacks/maps is fragile and was already removed |
| Agent slug extraction | Read from `toolInput.subagent_type` | The SDK puts it there; no need for separate hook-based extraction |
| Collapsible group UI | Existing `ActivityGroupRow` + `groupActivitiesByParent()` | Already handles expand/collapse, animation, depth, child rendering |
| Tool ID matching | Existing `ToolIndex` class | Append-only, order-independent, dedup-safe |
| Tree nesting algorithm | Existing `calculateActivityDepths()` | Walks parent chain, max 10 levels, handles out-of-order arrival |

---

## Common Pitfalls

### P1: Event Interleaving During Streaming (HIGH)

Sub-agent events arrive interleaved with parent events on the same stdout stream. `tool_result` for a child tool can arrive before `tool_start` for that same child (documented in codebase comments at sessions.ts line 3320-3323 and tool.ts line 118-121).

**Already mitigated:** The codebase handles this by creating a message from result if no matching start exists, then updating it when the start arrives later. The safety net in `handleToolResult` (tool.ts lines 90-113) auto-completes orphaned children when the parent Task completes.

**Verify:** Run a real sub-agent and confirm no orphaned tool messages appear.

### P2: Duplicate Events from SDK Dual-Event Pattern (MEDIUM)

SDK sends two events per tool: first from `stream_event` (empty input), second from `assistant` message (complete input). Both `extractToolStarts` and `sessions.ts` handle dedup via `emittedToolStartIds` Set and `existingStartMsg` check.

**Already mitigated.** No new code needed.

### P3: ActivityGroupRow Badge Shows "Task" Instead of Agent Type (LOW)

The badge reads `group.parent.toolInput?.subagent_type` directly. If the first `tool_start` event arrives with empty input (stream event pattern), the badge momentarily shows "Task" until the second event with full input arrives.

**Mitigation:** The second `tool_start` event triggers a re-render with updated toolInput. In practice, the delay is milliseconds and unnoticeable. If it matters, add the explicit `agentSlug` field as a stable property.

### P4: Sub-Agent with No Children Renders as Empty Group (LOW)

If a sub-agent runs but all its internal tools are invisible (e.g., the SDK doesn't surface them), the `ActivityGroup` has `children: []`. The `ActivityGroupRow` still renders the parent row with expand chevron, but expanding shows nothing.

**Mitigation:** Conditionally hide the chevron when `children.length === 0`. Approximately 2 lines in ActivityGroupRow.

### P5: Deeply Nested Sub-Agents (Sub-Agent Spawns Sub-Agent) (LOW)

The existing `calculateActivityDepths()` supports 10 levels of nesting. `groupActivitiesByParent()` only groups by direct parent Task. Nested sub-agents (Task -> Task -> Read) already work because each child's `parentToolUseId` points to its immediate parent Task.

**Already handled.** The test file `turn-utils-grouping.test.ts` line 404-410 includes a nested Task test case.

---

## Code Examples

### Example 1: Add agentSlug to Message type

File: `packages/core/src/types/message.ts`

```typescript
// Add after parentToolUseId field (line ~148)
// Agent type for Task sub-agents (extracted from tool input subagent_type)
agentSlug?: string;
```

Same field on `StoredMessage` (line ~226).

### Example 2: Extract agentSlug in sessions.ts processEvent

File: `apps/electron/src/main/sessions.ts`, inside `case 'tool_start'` block

```typescript
// After line 3230 (parentToolUseId assignment)
// Extract agent slug from Task tool input for display
const agentSlug = event.toolName === 'Task'
  ? (formattedToolInput?.subagent_type as string) || undefined
  : undefined

// Add to toolStartMessage (line ~3257):
agentSlug,

// Add to sendEvent call (line ~3277):
agentSlug,
```

### Example 3: Add agentSlug to ToolStartEvent

File: `apps/electron/src/renderer/event-processor/types.ts`

```typescript
export interface ToolStartEvent {
  // ...existing fields...
  /** Agent type slug for Task sub-agents */
  agentSlug?: string
}
```

### Example 4: Store agentSlug in handleToolStart

File: `apps/electron/src/renderer/event-processor/handlers/tool.ts`

```typescript
// In the new tool message creation (line ~46):
const toolMessage: Message = {
  // ...existing fields...
  agentSlug: event.agentSlug,
}
```

### Example 5: Use agentSlug in ActivityGroupRow badge (optional enhancement)

File: `packages/ui/src/components/chat/TurnCard.tsx`, line ~929

```typescript
// Prefer explicit agentSlug over toolInput lookup
const subagentType = group.parent.agentSlug
  || (group.parent.toolInput?.subagent_type as string | undefined)
```

### Example 6: ActivityItem type needs agentSlug

File: `packages/ui/src/components/chat/TurnCard.tsx`, ActivityItem interface

```typescript
export interface ActivityItem {
  // ...existing fields...
  /** Agent type slug for Task sub-agents */
  agentSlug?: string
}
```

And in `turn-utils.ts` `messageToActivity()`:
```typescript
const activity: ActivityItem = {
  // ...existing fields...
  agentSlug: message.agentSlug,
}
```

---

## Files to Modify (Ordered by Dependency)

1. **`packages/core/src/types/message.ts`** -- Add `agentSlug?: string` to Message and StoredMessage interfaces
2. **`apps/electron/src/main/sessions.ts`** -- Extract agentSlug from Task tool input in `processEvent`, propagate through sendEvent
3. **`apps/electron/src/renderer/event-processor/types.ts`** -- Add `agentSlug?: string` to ToolStartEvent
4. **`apps/electron/src/renderer/event-processor/handlers/tool.ts`** -- Pass `agentSlug` through handleToolStart
5. **`packages/ui/src/components/chat/TurnCard.tsx`** -- Add `agentSlug` to ActivityItem interface; prefer it in ActivityGroupRow badge
6. **`packages/ui/src/components/chat/turn-utils.ts`** -- Pass `agentSlug` in `messageToActivity()` and `storedToMessage()`

## Files Already Working (No Changes Needed)

- `packages/shared/src/agent/tool-matching.ts` -- Already extracts parentToolUseId from SDK messages
- `packages/shared/src/agent/craft-agent.ts` -- Already logs SubagentStart hook; already passes agents to SDK options
- `apps/electron/src/renderer/event-processor/processor.ts` -- Already routes tool_start/tool_result events
- `packages/ui/src/components/chat/turn-utils.ts` -- `groupActivitiesByParent()` already groups Task children, `calculateActivityDepths()` already nests
- `packages/ui/src/components/chat/TurnCard.tsx` -- `ActivityGroupRow` already renders collapsible group with badge, chevron, indented children

---

## Verification Checklist (Maps to Success Criteria)

1. **EXEC-01: Sub-agent executes and events appear in session**
   - Send a message that triggers Task tool (requires an agent definition or built-in agent)
   - Verify tool_start event for Task appears with subagent_type in input
   - Verify child tool events (Read, Bash, etc.) appear with parentToolUseId pointing to Task's toolUseId
   - Verify tool_result for Task arrives with sub-agent output

2. **DISPLAY-01: Collapsible group, collapsed by default**
   - Verify `ActivityGroupRow` renders for the Task
   - Verify default state is collapsed (chevron pointing right, children hidden)
   - Click chevron to expand; verify children become visible
   - Click again to collapse

3. **EXEC-04: Agent type badge displays**
   - Verify badge shows the `subagent_type` value (not just "Task")
   - Test with different agent types (e.g., "Explore", "Plan", custom agent name)

4. **DISPLAY-05: Depth indentation for nested tool calls**
   - Expand the sub-agent group
   - Verify child tools render with left border indentation (`border-l-2`)
   - Verify depth is correctly calculated (child = depth 1, grandchild = depth 2)

---

## Open Questions

### Q1: How to trigger a sub-agent for testing?

The SDK spawns a sub-agent when the model calls the Task tool. This happens naturally when the model's system prompt includes agent definitions (via `Options.agents`) and the model decides to delegate. For testing, send a prompt like "Research how React hooks work" to a session where an "Explore" agent is defined. The model should delegate via Task.

For deterministic testing, use the existing e2e infrastructure with a live session. The mock infrastructure cannot simulate sub-agent flows since sub-agents run inside the SDK subprocess.

**Recommendation:** Manual verification for Phase 9. Add e2e test in a follow-up phase.

### Q2: Do we need to handle SDKTaskNotificationMessage?

`SDKTaskNotificationMessage` (sdk.d.ts line 1442-1451) is emitted when a background Task completes. It has `task_id`, `status` ('completed' | 'failed' | 'stopped'), `output_file`, and `summary`.

For Phase 9 scope (foreground sub-agents only), this message is NOT needed. The normal `tool_result` for the Task tool carries the sub-agent's output. `SDKTaskNotificationMessage` is only relevant for background sub-agents (Phase 3 in the milestone roadmap).

**Recommendation:** Defer SDKTaskNotificationMessage handling to a later phase focused on background agents.

### Q3: Do we need agent definitions loaded for sub-agents to work?

No. The SDK has built-in agent types. When the model calls Task with `subagent_type: "general-purpose"` (or another built-in), it works without custom agent definitions. Custom definitions (passed via `Options.agents`) enable user-defined agents but are not required for the Phase 9 success criteria.

**Recommendation:** Phase 9 works with SDK-native agents. Agent definition CRUD is a separate concern.

---

## Confidence Assessment

| Finding | Confidence | Rationale |
|---------|-----------|-----------|
| SDK event model for sub-agents | **HIGH** | Read sdk.d.ts and sdk-tools.d.ts type definitions directly |
| Existing pipeline handles parentToolUseId | **VERY HIGH** | Traced through 6 files in the chain, all use it |
| ActivityGroupRow already renders collapsible groups | **VERY HIGH** | Read TurnCard.tsx source, component already exists |
| agentSlug extraction from toolInput.subagent_type | **HIGH** | Verified in SDK tool schema and test fixtures |
| No new dependencies needed | **HIGH** | Reviewed all component requirements against existing stack |
| ~30 lines of code for core changes | **MEDIUM-HIGH** | Estimated from gap analysis; actual may be 40-50 with tests |
| Sub-agent events appear without custom agent definitions | **MEDIUM** | SDK docs suggest built-in agents exist; not tested in Kata context |
