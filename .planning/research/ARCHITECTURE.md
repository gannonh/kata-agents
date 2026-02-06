# Architecture: Sub-Agent Orchestration Integration

**Domain:** Sub-agent orchestration in existing Electron + React + Claude Agent SDK app
**Researched:** 2026-02-06
**Confidence:** HIGH (based on codebase analysis and SDK type inspection)

## Executive Summary

The existing architecture already handles sub-agent events (parent_tool_use_id, task_backgrounded, task_progress) through the SDK's built-in Task tool. The integration goal is to add user-defined sub-agent orchestration: defining, configuring, persisting, and managing custom agent definitions that the SDK's `agents` parameter accepts. The SDK already provides the `Options.agents` field (`Record<string, AgentDefinition>`) and the `Options.plugins` field (which auto-discovers agents from workspace directories). The primary work is in the configuration layer, IPC plumbing, and UI for managing these definitions.

## Current Sub-Agent Support (Already Working)

Before listing what needs to change, here is what the SDK and codebase already handle:

| Capability | How It Works Today | Location |
|---|---|---|
| `Task` tool execution | SDK spawns sub-agents internally; CraftAgent streams events | `craft-agent.ts` chat() |
| `parent_tool_use_id` tracking | SDK provides it on every message; ToolIndex + extractToolStarts use it | `tool-matching.ts` |
| `task_backgrounded` events | Detected from Task tool_result containing `agentId:` pattern | `tool-matching.ts:326-338` |
| `task_progress` events | Forwarded to renderer via sendEvent | `sessions.ts:3598-3604` |
| Background task UI | ActiveTasksBar, useBackgroundTasks hook, BackgroundTask atoms | `ActiveTasksBar.tsx`, `useBackgroundTasks.ts` |
| Nested tool rendering | parentId on ActivityItem, depth calculation in turn-utils | `turn-utils.ts:241-248` |
| Safety net cleanup | Parent Task completion auto-completes orphaned children | `sessions.ts:3361-3385`, `tool.ts:91-113` |
| Plugin-based agents | `plugins: [{ type: 'local', path: workspaceRootPath }]` loads `.claude/agents/` | `craft-agent.ts:1482-1483` |
| SDK `agents` parameter | `Options.agents?: Record<string, AgentDefinition>` accepted by query() | SDK `sdk.d.ts:460` |

The SDK's `AgentDefinition` type (from `sdk.d.ts`):

```typescript
type AgentDefinition = {
  description: string;           // When to use this agent
  tools?: string[];              // Allowed tools (inherits parent if omitted)
  disallowedTools?: string[];    // Tools to block
  prompt: string;                // System prompt
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  mcpServers?: AgentMcpServerSpec[];
  criticalSystemReminder_EXPERIMENTAL?: string;
  skills?: string[];
  maxTurns?: number;
}
```

## Question 1: Sub-Agent Definition Storage and Loading

### Recommended Approach: Workspace-Level Agent Definitions

Follow the established skill/source pattern. Agent definitions live under the workspace config directory.

**Storage location:**
```
~/.kata-agents/workspaces/{id}/agents/{agent-slug}/
  config.json        # AgentDefinition fields + UI metadata
  prompt.md          # System prompt (separate file for editing)
```

**config.json schema:**
```typescript
interface StoredAgentDefinition {
  slug: string;                          // URL-safe identifier
  name: string;                          // Display name
  description: string;                   // SDK description field
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];                      // Allowed tools
  disallowedTools?: string[];            // Blocked tools
  mcpServers?: string[];                 // Source slugs to include
  skills?: string[];                     // Skill slugs to preload
  maxTurns?: number;                     // Turn limit
  enabled: boolean;                      // Toggle without deleting
  icon?: string;                         // Emoji or icon reference
}
```

**Loading pattern** (new `packages/shared/src/agents/` module):
```
packages/shared/src/agents/
  types.ts           # StoredAgentDefinition, LoadedAgent types
  storage.ts         # loadWorkspaceAgents(), saveAgentDefinition(), deleteAgentDefinition()
  index.ts           # Re-exports
```

This mirrors the skill loading pattern in `packages/shared/src/skills/`.

**Integration into CraftAgent.chat():**

In `craft-agent.ts`, the `agents` option is built from loaded workspace definitions:

```typescript
// In the options block (~line 1470-1484)
const agentDefs: Record<string, AgentDefinition> = {};
for (const agent of loadedAgents) {
  if (agent.enabled) {
    agentDefs[agent.slug] = {
      description: agent.description,
      prompt: agent.prompt,
      model: agent.model,
      tools: agent.tools,
      disallowedTools: agent.disallowedTools,
      mcpServers: agent.mcpServers,
      skills: agent.skills,
      maxTurns: agent.maxTurns,
    };
  }
}
// Add to options object
agents: agentDefs,
```

### Files to Create

| File | Purpose |
|---|---|
| `packages/shared/src/agents/types.ts` | StoredAgentDefinition, LoadedAgent interfaces |
| `packages/shared/src/agents/storage.ts` | CRUD for agent definition files |
| `packages/shared/src/agents/index.ts` | Re-exports |

### Files to Modify

| File | Change |
|---|---|
| `packages/shared/src/agent/craft-agent.ts` | Load agents, pass to options.agents |
| `packages/shared/package.json` | Add `agents` subpath export |

## Question 2: New IPC Channels for Sub-Agent Management

### New IPC Channels

Add to `IPC_CHANNELS` in `apps/electron/src/shared/types.ts`:

```typescript
// Agent definition management
GET_AGENTS: 'agents:get',                     // List agent definitions for workspace
CREATE_AGENT: 'agents:create',                // Create new agent definition
UPDATE_AGENT: 'agents:update',                // Update agent definition
DELETE_AGENT: 'agents:delete',                // Delete agent definition
GET_AGENT_TEMPLATES: 'agents:templates',      // Get built-in agent templates

// Agent definition change notification (main -> renderer)
AGENTS_CHANGED: 'agents:changed',             // Broadcast when definitions change
```

### No IPC Changes for Runtime Sub-Agent Events

The existing event stream (SESSION_EVENT channel) already carries all runtime sub-agent data. The `tool_start`, `tool_result`, `task_backgrounded`, `task_progress`, and `text_complete` events all include `parentToolUseId` when inside a sub-agent. No new runtime channels are needed.

### IPC Handler Registration

Add handlers in `ipc.ts` `registerIpcHandlers()`. Follow the existing CRUD pattern for sources/skills:

```typescript
ipcMain.handle(IPC_CHANNELS.GET_AGENTS, async (_event, workspaceId: string) => {
  const workspace = getWorkspaceOrThrow(workspaceId)
  return loadWorkspaceAgents(workspace.rootPath)
})

ipcMain.handle(IPC_CHANNELS.CREATE_AGENT, async (_event, workspaceId: string, definition: CreateAgentInput) => {
  const workspace = getWorkspaceOrThrow(workspaceId)
  return createAgentDefinition(workspace.rootPath, definition)
})
// ... UPDATE_AGENT, DELETE_AGENT follow same pattern
```

### Files to Modify

| File | Change |
|---|---|
| `apps/electron/src/shared/types.ts` | Add IPC channel constants, type exports |
| `apps/electron/src/main/ipc.ts` | Add agent CRUD handlers |
| `apps/electron/src/preload/index.ts` | Expose agent methods to renderer |

## Question 3: Event Processor Handling of Nested Sub-Agent Events

### Current State (Already Working)

The event processor already handles nested events correctly. Key mechanisms:

1. **parentToolUseId propagation**: Every `tool_start`, `tool_result`, and intermediate `text_complete` carries `parentToolUseId` from the SDK's `parent_tool_use_id` field. This is set in `tool-matching.ts:extractToolStarts()` at line 149 and `extractToolResults()` at line 226.

2. **Event processor types**: `ToolStartEvent` and `ToolResultEvent` in `event-processor/types.ts` already have `parentToolUseId?: string` fields.

3. **Tool handler**: `handleToolStart` in `event-processor/handlers/tool.ts` creates tool messages with `parentToolUseId` at line 56. `handleToolResult` preserves it.

4. **Turn grouping**: `turn-utils.ts` uses `parentId` (mapped from `parentToolUseId`) to calculate depth for tree rendering at lines 241-248.

5. **Safety net**: Both `sessions.ts:3361-3385` (main process) and `tool.ts:91-113` (event processor) auto-complete orphaned child tools when a parent Task completes.

### What Needs Refinement (Not Rewrite)

The current system treats all sub-agent events as undifferentiated children of a Task tool. With user-defined agents, the UI needs to know which agent definition is executing. Add `agentSlug` to relevant events:

**Extend tool_start event** (when toolName is 'Task'):

The SDK's `AgentInput` type has `subagent_type: string` which identifies the agent. Extract this from tool input:

```typescript
// In sessions.ts processEvent, case 'tool_start':
if (event.toolName === 'Task' && event.input?.subagent_type) {
  // Store agent slug on the tool message for UI rendering
  toolStartMessage.agentSlug = event.input.subagent_type as string
}
```

**Extend the Message type** in `packages/core/src/types/message.ts`:

```typescript
// Add to Message interface:
agentSlug?: string;    // Which agent definition is executing (for Task tools)
```

### Files to Modify

| File | Change |
|---|---|
| `packages/core/src/types/message.ts` | Add agentSlug to Message |
| `apps/electron/src/main/sessions.ts` | Extract subagent_type from Task tool input |
| `apps/electron/src/renderer/event-processor/types.ts` | Add agentSlug to ToolStartEvent |

## Question 4: New Jotai Atoms for Sub-Agent State

### Agent Definition Atoms (Configuration)

```typescript
// apps/electron/src/renderer/atoms/agents.ts (NEW)
import { atom } from 'jotai'
import type { LoadedAgent } from '../../shared/types'

/** Agent definitions for the current workspace */
export const agentDefinitionsAtom = atom<LoadedAgent[]>([])

/** Derived: agent definitions keyed by slug for fast lookup */
export const agentDefinitionMapAtom = atom((get) => {
  const agents = get(agentDefinitionsAtom)
  return new Map(agents.map(a => [a.slug, a]))
})
```

### Existing Atoms (No Changes Needed)

The following atoms already handle sub-agent runtime state:

- `backgroundTasksAtomFamily` in `atoms/sessions.ts` tracks active background tasks per session. The `BackgroundTask` interface already has `type: 'agent' | 'shell'`, `toolUseId`, `intent`, and `elapsedSeconds`.

- `sessionAtomFamily` stores the full session including messages with `parentToolUseId`. The turn-utils grouping logic already renders nested activity trees.

### Optional Enhancement: Active Sub-Agent Tracking

If the UI needs to show which user-defined agents are actively running (beyond the existing BackgroundTask tracking):

```typescript
/** Active sub-agent executions in a session (slug -> status) */
export const activeSubAgentsAtomFamily = atomFamily(
  (_sessionId: string) => atom<Map<string, SubAgentStatus>>(new Map()),
  (a, b) => a === b
)

interface SubAgentStatus {
  slug: string
  toolUseId: string       // The Task tool's ID
  parentToolUseId?: string // For nested sub-agents
  startTime: number
  elapsedSeconds: number
}
```

This is optional for the initial integration. The existing `backgroundTasksAtomFamily` covers the basic case.

### Files to Create

| File | Purpose |
|---|---|
| `apps/electron/src/renderer/atoms/agents.ts` | Agent definition atoms |

### Files to Modify

| File | Change |
|---|---|
| `apps/electron/src/renderer/atoms/sessions.ts` | Optionally extend BackgroundTask with agentSlug |

## Question 5: UI Component Tree Extension

### New Components

```
apps/electron/src/renderer/components/
  agents/                            # NEW directory
    AgentList.tsx                     # List of agent definitions in workspace settings
    AgentEditor.tsx                   # Create/edit agent definition form
    AgentCard.tsx                     # Card display for an agent definition
    AgentSelector.tsx                 # Dropdown/picker for available agents
```

### Modified Components

| Component | File | Change |
|---|---|---|
| WorkspaceSettings | `components/settings/` | Add "Agents" tab alongside Sources, Skills |
| ActiveTasksBar | `ActiveTasksBar.tsx` | Show agent name/icon when BackgroundTask has agentSlug |
| TaskActionMenu | `TaskActionMenu.tsx` | Show agent-specific actions |
| TurnCard | `packages/ui/src/components/chat/TurnCard.tsx` | Render agent identity badge on Task activities |
| ActivityItem rendering | `turn-utils.ts` | Include agentSlug in activity creation for Task tools |

### UI Rendering Flow

The existing turn-based rendering already groups sub-agent tools under their parent Task. The enhancement is:

1. **Activity tree**: When a Task activity has `agentSlug`, show the agent's display name and icon instead of generic "Agent" label.
2. **Background tasks bar**: Replace generic "Agent Task" with the user-defined agent name.
3. **Settings panel**: CRUD interface for agent definitions, similar to source/skill management.

## Question 6: Background Sub-Agent Management in Main Process

### Current Infrastructure

Background sub-agents are already managed by the SDK internally. The main process only sees:
- `task_backgrounded` events with `taskId` (the SDK's internal agent ID)
- `task_progress` events with `elapsedSeconds`
- `tool_result` events when the Task completes
- `shell_killed` events for shells

The main process stores these in `managed.backgroundShellCommands` (for shells) and forwards all events to the renderer.

### What Needs Addition

**Agent lifecycle tracking in SessionManager:**

Add a map to `ManagedSession` for correlating SDK agent IDs with user-defined agent slugs:

```typescript
// In ManagedSession interface (sessions.ts ~line 267):
/** Map of SDK taskId -> agent slug for user-defined sub-agents */
activeSubAgents: Map<string, string>
```

Populate this map when processing `task_backgrounded` events:

```typescript
// In processEvent, case 'task_backgrounded':
if (event.taskId) {
  // Look up the Task tool's input to find subagent_type
  const taskToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
  if (taskToolMsg?.toolInput?.subagent_type) {
    managed.activeSubAgents.set(event.taskId, taskToolMsg.toolInput.subagent_type as string)
  }
}
```

Clean up when the Task tool completes:

```typescript
// In processEvent, case 'tool_result' for Task tools:
// Already handled by existing safety net cleanup
// Add: managed.activeSubAgents.delete(taskId) if known
```

**getTaskOutput enhancement:**

The existing `getTaskOutput()` method at `sessions.ts:3013` returns a placeholder. For user-defined agents, enrich the response with agent definition context:

```typescript
async getTaskOutput(taskId: string): Promise<string | null> {
  // Find which session owns this task
  for (const [sessionId, managed] of this.sessions) {
    const agentSlug = managed.activeSubAgents.get(taskId)
    if (agentSlug) {
      // Return agent context alongside output info
      return `Agent: ${agentSlug}\nTask ID: ${taskId}\n...`
    }
  }
  // ... existing fallback
}
```

### Files to Modify

| File | Change |
|---|---|
| `apps/electron/src/main/sessions.ts` | Add activeSubAgents to ManagedSession, populate on task_backgrounded, clean up on task completion |

## Question 7: Sub-Agent Permission Modes and Parent Session Interaction

### Current Permission System

The permission system is per-session, managed by `mode-manager.ts`:
- Three modes: `safe` (read-only), `ask` (prompt for write), `allow-all` (auto-approve)
- Permission state is keyed by session ID: `initializeModeState(sessionId, ...)`
- The SDK receives `permissionMode: 'bypassPermissions'` because CraftAgent handles all permissions via the PreToolUse hook

### Interaction Rules for Sub-Agents

Sub-agents inherit the parent session's SDK subprocess. They run in the same process with the same permission context. The SDK's internal permission checks are bypassed (`permissionMode: 'bypassPermissions'`), and CraftAgent's PreToolUse hook handles all tool permission decisions.

**Key constraint**: The SDK processes everything in one subprocess per session. Sub-agents are not separate processes. They share the parent's permission hooks.

**Recommended behavior**:

1. **Inherit parent by default**: Sub-agents use the parent session's permission mode. This matches the SDK's behavior where sub-agent tools go through the same PreToolUse hook.

2. **Per-definition restriction (optional)**: Agent definitions can specify `disallowedTools` to restrict what tools a sub-agent can use. This is already supported by the SDK's `AgentDefinition.disallowedTools` field.

3. **No per-sub-agent permission UI**: Permission prompts from sub-agent tools show in the parent session's UI. The existing permission request flow (`onPermissionRequest` callback -> `permission_request` event -> renderer dialog) works for sub-agent tools because the SDK includes `agentID` in the `canUseTool` options.

4. **Agent-aware permission display**: When a permission request comes from a sub-agent, include the agent name in the prompt so the user knows which sub-agent is requesting access. The `canUseTool` callback already receives `agentID` which can be mapped to a slug.

**Modification to PreToolUse hook** (in `craft-agent.ts`):

```typescript
// In the PreToolUse hook handler:
// The SDK's options.agentID identifies the sub-agent
// Use it to look up restrictions from the agent definition
if (options.agentID && this.agentDefinitions[options.agentID]) {
  const agentDef = this.agentDefinitions[options.agentID]
  if (agentDef.disallowedTools?.includes(toolName)) {
    return { continue: false, reason: `Tool ${toolName} is not allowed for agent ${options.agentID}` }
  }
}
```

### Files to Modify

| File | Change |
|---|---|
| `packages/shared/src/agent/craft-agent.ts` | Add agentID awareness to permission hooks, store loaded agent definitions |

## Component Summary: New vs Modified

### New Files

| File | Purpose | Effort |
|---|---|---|
| `packages/shared/src/agents/types.ts` | Agent definition types | Small |
| `packages/shared/src/agents/storage.ts` | Agent definition CRUD | Medium |
| `packages/shared/src/agents/index.ts` | Re-exports | Small |
| `apps/electron/src/renderer/atoms/agents.ts` | Agent definition atoms | Small |
| `apps/electron/src/renderer/components/agents/AgentList.tsx` | List view | Medium |
| `apps/electron/src/renderer/components/agents/AgentEditor.tsx` | Edit form | Medium |
| `apps/electron/src/renderer/components/agents/AgentCard.tsx` | Card display | Small |

### Modified Files

| File | Change | Effort |
|---|---|---|
| `packages/shared/src/agent/craft-agent.ts` | Load agents, pass to options.agents, agentID-aware permissions | Medium |
| `packages/shared/package.json` | Add agents subpath export | Small |
| `packages/core/src/types/message.ts` | Add agentSlug to Message | Small |
| `apps/electron/src/shared/types.ts` | IPC channels, type exports | Small |
| `apps/electron/src/main/ipc.ts` | Agent CRUD IPC handlers | Small |
| `apps/electron/src/main/sessions.ts` | activeSubAgents map, agentSlug extraction | Medium |
| `apps/electron/src/preload/index.ts` | Expose agent methods | Small |
| `apps/electron/src/renderer/event-processor/types.ts` | agentSlug on ToolStartEvent | Small |
| `packages/ui/src/components/chat/turn-utils.ts` | Agent name in Task activities | Small |
| Settings UI component | Add Agents tab | Medium |
| `ActiveTasksBar.tsx` | Show agent name | Small |

### Unchanged (Already Working)

| Component | Why No Changes |
|---|---|
| `tool-matching.ts` | parentToolUseId extraction already complete |
| Event processor `processor.ts` | Already routes all event types |
| `handlers/tool.ts` | Already handles parentToolUseId, safety net |
| `useBackgroundTasks.ts` | Already tracks agent/shell background tasks |
| `mode-manager.ts` | Permission mode is per-session, sub-agents inherit |

## Data Flow Diagram

```
                      CONFIGURATION TIME
                      ==================
User creates agent    AgentEditor.tsx
  definition          ──────────────────►  IPC: agents:create
                                           ──────────────────►  storage.ts
                                                                writes to
                                                                ~/.kata-agents/workspaces/{id}/agents/{slug}/

                      RUNTIME (Existing Flow, Enhanced)
                      ==================================

User sends message    FreeFormInput.tsx
                      ──────────────────►  IPC: sessions:send
                                           ──────────────────►  SessionManager.sendMessage()
                                                                ──────────────────►  CraftAgent.chat()
                                                                                     │
                                                                                     │ Passes agents to
                                                                                     │ SDK options.agents
                                                                                     ▼
                                                                                   SDK query()
                                                                                     │
                                                                  ┌──────────────────┘
                                                                  │ SDK decides to use Task tool
                                                                  │ with subagent_type from definition
                                                                  ▼
                                                                tool_start (toolName: 'Task')
                                                                  │ input.subagent_type = 'my-agent'
                                                                  │ parentToolUseId = null (top-level)
                                                                  ▼
                                                                Sub-agent runs...
                                                                  │ Emits child tool_start/tool_result
                                                                  │ with parentToolUseId = Task's ID
                                                                  ▼
                                                                task_backgrounded (if background)
                                                                OR tool_result (if foreground)
                                                                  │
                                             ┌────────────────────┘
                                             ▼
                                       sessions.ts processEvent()
                                             │ Extracts agentSlug from input
                                             │ Maps taskId -> slug
                                             │ Forwards via sendEvent()
                                             ▼
                                       Renderer event processor
                                             │ Creates/updates messages
                                             │ with parentToolUseId + agentSlug
                                             ▼
                                       turn-utils.ts groupMessages()
                                             │ Groups into ActivityItems
                                             │ with depth + agentSlug
                                             ▼
                                       TurnCard renders nested tree
                                       with agent identity badges
```

## Build Order Recommendation

### Phase 1: Storage Layer (no UI)
1. Create `packages/shared/src/agents/` module (types, storage, index)
2. Wire into `craft-agent.ts` to load and pass to `options.agents`
3. Add subpath export to `packages/shared/package.json`

### Phase 2: IPC and Main Process
4. Add IPC channels to `types.ts`
5. Add handlers in `ipc.ts`
6. Expose in `preload/index.ts`
7. Add `activeSubAgents` tracking to `ManagedSession`
8. Extract `agentSlug` from Task tool inputs in `processEvent()`

### Phase 3: Renderer State
9. Create `atoms/agents.ts`
10. Extend `BackgroundTask` with optional `agentSlug`
11. Add `agentSlug` to Message type and event types

### Phase 4: UI Components
12. Agent settings panel (list, create, edit, delete)
13. Agent identity in TurnCard activities
14. Agent name in ActiveTasksBar
15. Agent-aware permission prompts

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| SDK `agents` parameter behavior changes | Low | Pin SDK version, test with real agent definitions |
| Sub-agent permission conflicts | Medium | Start with inherit-only, add per-agent restrictions later |
| Event ordering during parallel sub-agents | Low | Already handled by ID-based matching (no FIFO queues) |
| Large agent prompts increasing context | Medium | maxTurns limit, prompt size validation in editor |
| Config file watcher doesn't detect agent changes | Low | Add agents/ directory to ConfigWatcher paths |
