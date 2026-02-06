# Technology Stack - Sub-Agent Orchestration

**Project:** Kata Agents - Sub-Agent Orchestration Milestone
**Researched:** 2026-02-06
**SDK Version:** @anthropic-ai/claude-agent-sdk 0.2.19 (claudeCodeVersion: 2.1.19)

## 1. SDK Types and Interfaces for Sub-Agent Definition

### AgentDefinition (from sdk.d.ts)

The SDK exports a fully typed `AgentDefinition` interface for programmatic sub-agent configuration:

```typescript
type AgentDefinition = {
  /** Natural language description of when to use this agent */
  description: string;
  /** Array of allowed tool names. If omitted, inherits all tools from parent */
  tools?: string[];
  /** Array of tool names to explicitly disallow for this agent */
  disallowedTools?: string[];
  /** The agent's system prompt */
  prompt: string;
  /** Model to use. If omitted or 'inherit', uses the main model */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  /** MCP servers available to this agent */
  mcpServers?: AgentMcpServerSpec[];
  /** Experimental: Critical reminder added to system prompt */
  criticalSystemReminder_EXPERIMENTAL?: string;
  /** Array of skill names to preload into the agent context */
  skills?: string[];
  /** Maximum number of agentic turns (API round-trips) before stopping */
  maxTurns?: number;
};
```

### Options.agents Parameter

The `Options` type for `query()` accepts agents as `Record<string, AgentDefinition>`:

```typescript
agents?: Record<string, AgentDefinition>;
```

The `Options.agent` field (singular) selects which defined agent runs the main thread:

```typescript
agent?: string; // Name of agent from agents map to use as main thread
```

### AgentInput (Task Tool Input Schema, from sdk-tools.d.ts)

The Task tool's input schema includes:

```typescript
interface AgentInput {
  description: string;        // Short (3-5 word) task description
  prompt: string;             // Full task for the agent
  subagent_type: string;      // References a key from Options.agents
  model?: 'sonnet' | 'opus' | 'haiku'; // Model override
  resume?: string;            // Agent ID to resume from previous execution
  run_in_background?: boolean; // Run as background task
  max_turns?: number;         // Max API round-trips
  allowed_tools?: string[];   // Tools to grant (user prompted if not pre-allowed)
  name?: string;              // Name for the spawned agent
  team_name?: string;         // Team name for multi-agent coordination
  mode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan';
}
```

### Key Integration Point

The `Task` tool must be included in `allowedTools` for sub-agent invocation. The current codebase does NOT add `Task` to `disallowedTools`, so it is available by default through the `claude_code` preset.

## 2. Sub-Agent Lifecycle Events

### Hook Events

The SDK provides two hook events for sub-agent lifecycle:

```typescript
// SubagentStart - fired when a sub-agent begins execution
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;      // Unique ID for this sub-agent instance
  agent_type: string;    // Name from agents map (matches subagent_type)
};

type SubagentStartHookSpecificOutput = {
  hookEventName: 'SubagentStart';
  additionalContext?: string; // Inject context into the sub-agent
};

// SubagentStop - fired when a sub-agent completes
type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string; // Path to sub-agent's full transcript
};
```

### SDK Message Events During Sub-Agent Execution

All SDK messages carry `parent_tool_use_id` to identify sub-agent context:

| Message Type | parent_tool_use_id | Meaning |
|---|---|---|
| `SDKAssistantMessage` | `null` | Main agent message |
| `SDKAssistantMessage` | `string` | Sub-agent message (ID = Task tool_use_id) |
| `SDKPartialAssistantMessage` | `string` | Streaming text from sub-agent |
| `SDKToolProgressMessage` | `string` | Tool progress inside sub-agent |
| `SDKUserMessage` | `string` | Tool results fed back to sub-agent |

### Background Task Notification

When `run_in_background: true` is set on Task:

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;   // Path to output file for reading
  summary: string;       // Brief summary of what the task produced
  uuid: UUID;
  session_id: string;
};
```

### TaskOutput Tool (Check Background Tasks)

```typescript
interface TaskOutputInput {
  task_id: string;  // The task ID to get output from
  block: boolean;   // Whether to wait for completion
  timeout: number;  // Max wait time in ms
}
```

### TaskStop Tool (Kill Background Tasks)

```typescript
interface TaskStopInput {
  task_id?: string;   // Background task to stop
  shell_id?: string;  // Deprecated: use task_id
}
```

## 3. Event Flow Through SDK Generator

When a sub-agent is active, the SDK generator (`query()` AsyncGenerator) yields messages in this sequence:

1. **Main agent** emits `SDKAssistantMessage` with `tool_use` block where `name = 'Task'`
2. **SubagentStart hook** fires with `agent_id` and `agent_type`
3. **Sub-agent messages** flow with `parent_tool_use_id` set to the Task's `tool_use_id`:
   - `SDKPartialAssistantMessage` (streaming text, if `includePartialMessages: true`)
   - `SDKAssistantMessage` (complete messages with tool_use blocks)
   - `SDKUserMessage` (tool results fed back to sub-agent)
   - `SDKToolProgressMessage` (elapsed time updates)
4. **SubagentStop hook** fires with `agent_id` and transcript path
5. **Main agent** receives `SDKUserMessage` with `tool_result` for the Task tool

For **background tasks** (`run_in_background: true`):
- Step 2 completes, then Task returns immediately with `agentId` in result
- Steps 3-4 happen asynchronously
- `SDKTaskNotificationMessage` fires when background task completes
- Main agent uses `TaskOutput` tool to read results

### Codebase Event Mapping (already implemented)

| SDK Event | Codebase AgentEvent | Handler |
|---|---|---|
| Task tool_use block | `tool_start` (toolName='Task') | `tool-matching.ts:extractToolStarts()` |
| Task tool_result with agentId | `task_backgrounded` | `tool-matching.ts:detectBackgroundEvents()` |
| `SDKToolProgressMessage` | `task_progress` | `craft-agent.ts` line ~2634 |
| `SDKTaskNotificationMessage` | (not yet mapped) | Not yet implemented |
| Sub-agent messages | `text_delta`/`text_complete`/`tool_start`/`tool_result` with `parentToolUseId` | `tool-matching.ts` + `craft-agent.ts` |

### Gap: SDKTaskNotificationMessage

The SDK emits `SDKTaskNotificationMessage` when background tasks complete, but the codebase does not yet handle this message type. This needs to be added to:
- `craft-agent.ts` message processing loop
- `AgentEvent` union type in `packages/core/src/types/message.ts`
- Event processor in `apps/electron/src/renderer/event-processor/`

## 4. Agent Definition File Format

The SDK loads agents from `.claude/agents/*.md` files when a workspace is loaded as a plugin. The current codebase already does this:

```typescript
// craft-agent.ts line 1482-1483
plugins: [{ type: 'local' as const, path: this.workspaceRootPath }],
```

This means any `.claude/agents/*.md` files in the workspace root are automatically loaded.

### Agent Definition File Format

Files in `.claude/agents/` use YAML frontmatter + Markdown body:

```markdown
---
name: code-reviewer
model: sonnet
allowed-tools: Read Grep Glob
---

You are a code review specialist...
```

The frontmatter fields map to `AgentDefinition`:
- `name` -> agent key name
- `model` -> `model` field ('sonnet' | 'opus' | 'haiku')
- `allowed-tools` -> `tools` field (space-delimited tool names)
- Markdown body -> `prompt` field

### Programmatic vs File-Based Agents

Both approaches are available and can coexist:

| Approach | How | When to Use |
|---|---|---|
| `Options.agents` parameter | Pass `Record<string, AgentDefinition>` to `query()` | App-defined agents, dynamic configuration |
| `.claude/agents/*.md` files | Place files in workspace `.claude/agents/` directory | User-defined agents, workspace-portable |
| SDK plugin loading | `plugins: [{ type: 'local', path }]` | Already active in Kata (line 1483) |

### SDKSystemMessage.agents Field

On initialization, the SDK emits an `SDKSystemMessage` with `agents?: string[]` listing all loaded agent names. This can be used to populate the UI's agent picker.

## 5. New Dependencies for Sub-Agent UI Visualization

### No new dependencies required for basic functionality

The existing stack (React + Jotai + shadcn/ui + Tailwind) provides sufficient primitives for sub-agent visualization. The `parentToolUseId` field already enables tree construction from flat message arrays.

### Recommended: No new visualization libraries

The codebase already uses:
- `parentToolUseId` on `Message` for parent-child relationships
- `BackgroundTask` type with `type: 'agent' | 'shell'` in Jotai atoms
- `TaskActionMenu` component for background task interaction
- `useBackgroundTasks` hook for task lifecycle management

For the sub-agent tree view, a custom component built on shadcn/ui primitives and Tailwind is the right approach. Adding a tree library introduces styling conflicts with the existing design system.

### Libraries Evaluated (NOT recommending)

| Library | Why Not |
|---|---|
| react-d3-tree | Heavy D3 dependency, overkill for shallow agent trees (typically 1-2 levels deep) |
| react-arborist | File-explorer-oriented API, drag-and-drop focus, wrong abstraction for agent execution trees |
| @xyflow/react (React Flow) | Node-graph paradigm designed for workflow editors, too heavy for status display |
| react-complex-tree | Keyboard-focused file tree, good for deep hierarchies but agent trees are shallow |
| MUI Tree View | Would pull in MUI, conflicts with shadcn/ui design system |

### Recommended Custom Components

Build with existing shadcn/ui + Tailwind + Jotai:

1. **AgentTreeView** - Renders message tree grouped by `parentToolUseId`, collapsible sections per sub-agent
2. **SubAgentBadge** - Inline badge showing agent type, model, status (similar to existing `TaskActionMenu`)
3. **AgentProgressIndicator** - Uses `elapsedSeconds` from `task_progress` events for live updates
4. **BackgroundTaskPanel** - Extends existing `ActiveTasksBar` with agent-specific actions (view output, stop, resume)

### State Management

Extend existing Jotai atoms:

```typescript
// Extend BackgroundTask with agent-specific fields
interface BackgroundTask {
  id: string;
  type: 'agent' | 'shell';
  toolUseId: string;
  intent?: string;
  startTime: number;
  elapsedSeconds: number;
  // New fields for sub-agent orchestration:
  agentType?: string;        // From subagent_type
  model?: string;            // Model override if specified
  status?: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;          // From SDKTaskNotificationMessage
  outputFile?: string;       // Path to output for reading
}
```

## 6. Implementation Checklist

### SDK Integration (packages/shared/src/agent/)

- [ ] Add `agents` parameter passthrough in `craft-agent.ts` Options construction
- [ ] Handle `SDKTaskNotificationMessage` in message processing loop
- [ ] Add `task_notification` to AgentEvent union type
- [ ] Forward `SubagentStart`/`SubagentStop` hook events to UI

### UI Layer (apps/electron/src/renderer/)

- [ ] Add `task_notification` event handler to event processor
- [ ] Extend `BackgroundTask` type with agent metadata
- [ ] Build sub-agent tree grouping from `parentToolUseId` in message list
- [ ] Add agent type/model badge to tool messages from sub-agents
- [ ] Extend `ActiveTasksBar` for agent task management (view output, stop)

### Agent Definition Management

- [ ] Build UI for browsing/creating `.claude/agents/*.md` files in workspace
- [ ] Parse `SDKSystemMessage.agents` to populate available agents list
- [ ] Allow selecting agent definitions when configuring sessions

## Sources

- SDK type definitions: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.2.19)
- SDK tool schemas: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
- Claude Agent SDK documentation: https://platform.claude.com/docs/en/agent-sdk/subagents
- Existing codebase: `packages/shared/src/agent/tool-matching.ts` (parent_tool_use_id handling)
- Existing codebase: `apps/electron/src/renderer/event-processor/handlers/tool.ts` (background task handlers)
- Existing codebase: `apps/electron/src/renderer/hooks/useBackgroundTasks.ts` (task lifecycle)
- React tree libraries evaluated: react-d3-tree, react-arborist, @xyflow/react, react-complex-tree, shadcn-tree-view
