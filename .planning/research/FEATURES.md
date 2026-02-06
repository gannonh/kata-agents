# Feature Landscape: Sub-Agent Orchestration UX

**Domain:** Multi-agent visualization and orchestration in a desktop AI assistant
**Researched:** 2026-02-06
**Confidence:** HIGH (based on official documentation from Claude Code, VS Code, Cursor, Windsurf)

---

## Context: Existing Codebase Support

Kata Agents already has partial sub-agent infrastructure:

- **`parentToolUseId` tracking** on Messages (both runtime and stored)
- **`ActivityGroup` type** that groups Task tools with child activities
- **`groupActivitiesByParent()`** function that nests child tool calls under parent Task tools
- **Depth calculation** for tree-view rendering during streaming
- **`task_backgrounded` / `shell_backgrounded` event handling** with status tracking
- **`TaskOutput` data extraction** (duration, token usage) linked back to parent Task
- **Orphan child auto-completion** when parent Task finishes

The SDK exposes `AgentDefinition` with: description, tools, disallowedTools, prompt, model (sonnet/opus/haiku/inherit), mcpServers, skills, maxTurns. The `AgentInput` tool schema adds: run_in_background, name, team_name, mode (acceptEdits/bypassPermissions/default/delegate/dontAsk/plan), resume, allowed_tools.

SDK event types relevant to sub-agents: `SDKTaskNotificationMessage` (task_id, status, output_file, summary), `SDKToolProgressMessage` (elapsed_time_seconds), `SubagentStart`/`SubagentStop` hooks.

---

## Claude Code CLI: Sub-Agent UX Reference

### How sub-agents display

**Foreground sub-agents** block the main conversation. The CLI shows tool execution inline with the parent conversation. Permission prompts and AskUserQuestion calls pass through to the user. Child tool calls appear nested under the parent Task tool.

**Background sub-agents** run concurrently. The CLI returns immediately with an agentId. The main agent continues working. Permissions are pre-approved at launch time; anything not pre-approved auto-denies. Background sub-agents cannot use MCP tools or ask clarifying questions.

### Progress and monitoring

- **Ctrl+B**: Background a running task (bash command or agent). Unified key for both.
- **Ctrl+T**: Toggle the task list view in the terminal status area. Shows up to 10 tasks with pending/in-progress/complete indicators.
- **/tasks**: List and manage background tasks.
- **TaskOutput tool**: The main agent polls background task results. Returns JSON with result text, usage stats, total_cost_usd, duration_ms.

### Completion display

When a background sub-agent finishes, the SDK emits `SDKTaskNotificationMessage` with status (completed/failed/stopped), output_file path, and a summary. The main agent receives this and incorporates the result into its conversation.

Foreground sub-agents return their result directly as the Task tool's output. The result appears in the conversation as a completed tool call.

### Agent teams (experimental)

- **Shift+Up/Down**: Navigate between teammates in in-process mode.
- **Enter on teammate**: View their full session.
- **Escape**: Interrupt a teammate's current turn.
- Split-pane mode (tmux/iTerm2): Each teammate gets its own terminal pane.
- Shared task list: All agents can see task status and self-claim available work.
- Delegate mode: Restricts the lead to coordination-only tools (no code editing).
- Inter-agent messaging: Teammates message each other directly, not just back to the lead.

### Limitations in CLI

- No real-time visibility into nested tool calls during background execution until the sub-agent completes.
- Sub-agents cannot spawn other sub-agents (single-level nesting only).
- No interactive thinking mode or transparent intermediate output from sub-agents.
- No progress tracking or ability to interrupt background sub-agents mid-execution.
- Agent teams don't survive session resumption (in-process teammates lost on /resume).

---

## Competitive Landscape

### VS Code Copilot (v1.109, Jan 2026)

**Agent Sessions sidebar**: A dedicated view that lists all agent sessions (local, background, cloud) with status indicators. One place to manage everything. Click to jump between sessions.

**Agent HQ**: Multi-agent orchestration interface where background agents appear as manageable sessions. Side-by-side layout shows the "All Sessions" list alongside the active chat.

**Subagent visibility**: Users can see which tasks are running, which agent is being used, and expand any subagent to see the full prompt and result.

**Parallel execution**: Multiple subagents run in parallel. Fire off multiple tasks at once. Results arrive independently.

**MCP Apps**: Tool calls can return interactive UI components (dashboards, forms, visualizations) that render directly in chat.

**Key insight**: VS Code treats agent sessions as first-class objects with their own lifecycle, visible in a persistent sidebar. The GUI adds value over a CLI by making all concurrent work visible simultaneously.

### Cursor 2.0 (Oct 2025)

**Agent-centric layout**: Dedicated sidebar where agents, plans, and runs are first-class objects. Conversations and diffs appear front and center.

**Parallel agents**: Up to 8 agents in parallel via git worktrees or remote sandboxes. Each agent operates on an isolated copy of the codebase.

**Progress visualization**: Each agent appears as a distinct item in the sidebar with status, progress indicators, and output logs. Sidebar shows running/completed/waiting states.

**Best-solution evaluation**: After all parallel agents finish, Cursor evaluates all runs and recommends the best solution. The selected agent gets a comment explaining why it was picked.

**Improved code review**: View all changes from Agent across multiple files without jumping between individual files.

**Key insight**: Cursor's competitive advantage is the evaluation/comparison step. Multiple agents solve the same problem, and the tool recommends the best one. This is a pattern that makes parallel work more useful than sequential.

### Windsurf (Wave 13, 2026)

**Side-by-side Cascade panes**: Multiple Cascade sessions in separate panes and tabs within the same window. Monitor progress and compare outputs side-by-side. Can turn the window into an agent dashboard.

**Context window indicator**: Visual indicator showing how much context window is in use. Helps users decide when to start a new session.

**Git worktrees**: First-class support for parallel multi-agent sessions with isolated worktrees.

**Terminal profile**: Dedicated terminal profile for more reliable agent execution.

**Key insight**: Windsurf's context window visualization is a unique addition. Showing context consumption helps users understand agent capacity and make informed decisions about when to start fresh.

---

## Table Stakes

Features users expect from sub-agent support in a desktop AI assistant. Missing any of these feels broken.

| Feature | Why Expected | Evidence | Complexity |
|---------|-------------|----------|------------|
| **Sub-agent as collapsible group** | Users need to see that a Task tool has child operations. Claude Code, VS Code, Cursor all group sub-agent work. Kata already has `ActivityGroup` / `groupActivitiesByParent()`. | All tools show nested/grouped sub-agent work | Low (already partially built) |
| **Progress indication for running sub-agents** | Users need to know something is happening. A spinner or elapsed timer on the Task tool while it runs. | Claude Code shows elapsed_time_seconds via SDKToolProgressMessage. All IDEs show running state. | Low (already have `task_progress` events) |
| **Background vs foreground distinction** | Users must know if a sub-agent is blocking their conversation or running concurrently. | Claude Code: Ctrl+B toggle. VS Code: Agent Sessions shows local/background/cloud. Cursor: parallel agent sidebar. | Medium |
| **Sub-agent completion summary** | When a sub-agent finishes, users need to see the result without digging through logs. | Claude Code: TaskNotification with summary. VS Code: expand to see result. Cursor: code review panel. | Low (SDK provides summary in SDKTaskNotificationMessage) |
| **Sub-agent error display** | Failed sub-agents must surface clearly with the error reason. | Universal pattern. SDK provides status: 'failed'. | Low |
| **Nested tool call display** | Child tools (Read, Edit, Bash) inside a sub-agent should be visible but secondary to the parent. | All tools show this. Kata already calculates depth and renders tree indentation. | Low (already built) |
| **Sub-agent agent type label** | Users should see what kind of agent is running ("Explore", "code-reviewer", custom name). | Claude Code shows agent type with custom colors. VS Code shows which agent is being used. | Low |

---

## Differentiators

Features that would make Kata's sub-agent UX stand out. The opportunity is GUI vs CLI.

| Feature | Value Proposition | Evidence / Inspiration | Complexity |
|---------|-------------------|----------------------|------------|
| **Agent activity dashboard** | A dedicated panel showing all active and recent sub-agents with status, elapsed time, and token cost. The GUI equivalent of Claude Code's Ctrl+T task list, but persistent and visual. | VS Code Agent Sessions sidebar. Cursor agent sidebar. CLI users lose track of background tasks. | Medium |
| **Live sub-agent stream preview** | While a foreground sub-agent runs, show a live preview of its intermediate text and tool calls in a collapsible region. CLI cannot do this for background agents. | VS Code allows expanding subagent to see full prompt/result. No tool shows live streaming preview of a background agent's work. | High |
| **Context window gauge per sub-agent** | Show how much context each sub-agent has consumed. Helps users understand why a sub-agent might compact or fail. | Windsurf context window indicator. No tool shows per-agent context usage. | Medium |
| **Token cost per sub-agent** | Display running cost alongside each sub-agent. SDK provides costUSD in ModelUsage. Makes the cost of parallel work transparent. | TaskOutput returns total_cost_usd. No tool surfaces this as a live indicator. | Low-Medium |
| **Agent configuration panel** | GUI for defining custom sub-agents: name, description, prompt, tools, model. Currently CLI-only in Claude Code (/agents). | Claude Code /agents command. Kata could make this a visual form instead of markdown files. | Medium |
| **Parallel agent comparison view** | When running multiple agents on the same problem, show results side-by-side for comparison. | Cursor 2.0 "best solution" evaluation. Windsurf side-by-side panes. | High |
| **One-click background toggle** | Button to send a running foreground agent to background (equivalent of Ctrl+B). No keyboard shortcut memorization needed. | Claude Code Ctrl+B. GUI button is more discoverable. | Low |
| **Sub-agent permission inheritance display** | Show which permissions a sub-agent has vs the parent. Visual diff of tool access. | Claude Code shows tool restrictions per sub-agent. No tool visualizes the delta. | Medium |
| **Resume/re-run sub-agent** | Button to resume a completed sub-agent's session (the SDK supports `resume` on AgentInput). Useful for iterating on partial results. | Claude Code agent resume via agent ID. GUI makes this a one-click action. | Medium |
| **Agent team coordination view** | If implementing agent teams: visual representation of the shared task list, agent assignments, message flow between agents. | Claude Code agent teams use shared task list and inter-agent messaging. All coordination happens via text in CLI. GUI could make this a Kanban-like board. | High |

### Strongest GUI differentiators (CLI cannot replicate)

1. **Agent activity dashboard**: Persistent visual of all agents, their states, and costs. CLI requires Ctrl+T toggle and /tasks command.
2. **Live sub-agent stream preview**: Expandable real-time view of what a background agent is doing. CLI has no visibility into background agent internals until completion.
3. **Context window gauge**: Visual meter showing context consumption per agent. CLI has no equivalent.
4. **Parallel comparison view**: Side-by-side results from multiple agents. CLI shows results sequentially.

---

## Anti-Features

Things to deliberately NOT build for v0.7.0.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Agent teams (multi-session coordination)** | Experimental even in Claude Code. Adds massive complexity: inter-agent messaging, shared task lists, session management, tmux-like pane splitting. The SDK marks this as experimental with many known limitations. | Build single-session sub-agent support first. Evaluate agent teams for v0.8.0+ after the feature stabilizes upstream. |
| **Custom agent definition editor** | Building a full visual editor for agent markdown files is scope creep for v0.7.0. The /agents interactive UI in Claude Code took multiple releases to stabilize. | Support loading existing agent definitions from .claude/agents/ and ~/.claude/agents/. Let users edit markdown files directly. Consider a visual editor for v0.8.0. |
| **Parallel agent comparison/evaluation** | Cursor's "run 8 agents and pick the best" requires git worktree isolation, result evaluation, and conflict resolution. Significant infrastructure. | Support one sub-agent at a time in foreground, or multiple sequential. Consider parallel for v0.8.0. |
| **Sub-agent spawning sub-agents** | The SDK explicitly prevents this. Single-level nesting only. Don't try to work around it. | Display the flat parent-child hierarchy that the SDK provides. |
| **Split-pane agent views** | Requires window management complexity (tmux-like splitting). Electron can do this but it's a major UI effort for v0.7.0. | Show sub-agents within the existing chat panel with collapsible groups. Consider dedicated agent panels for v0.8.0. |
| **Agent memory/persistence** | Claude Code's persistent memory feature (cross-session learning per agent) is new and adds storage/retrieval complexity. | Defer. Sub-agents run within a session. Memory is a v0.8.0+ concern. |
| **MCP tool visualization inside sub-agents** | Background sub-agents in Claude Code cannot use MCP tools. Visualizing MCP-specific tool calls inside sub-agents adds edge cases. | Show MCP tools the same as any other tool in the nested display. No special treatment needed. |
| **Real-time inter-agent messaging UI** | Only relevant for agent teams, which are out of scope for v0.7.0. | Not applicable until agent teams are implemented. |
| **Agent marketplace/sharing** | Distributing custom agents beyond the local machine. | Use the existing Agent Skills specification format. Plugin distribution is a separate feature. |

---

## Feature Dependencies

```
Sub-agent as collapsible group (already partially built)
    |
    +-- Progress indication (SDKToolProgressMessage / elapsed timer)
    |
    +-- Agent type label (from AgentInput.subagent_type)
    |
    +-- Nested tool call display (already built: depth calculation, ActivityGroup)
    |
    +-- Sub-agent completion summary (SDKTaskNotificationMessage)
    |
    +-- Sub-agent error display (status: 'failed')
    |
    +-- Background vs foreground distinction (AgentInput.run_in_background)
            |
            +-- One-click background toggle (Ctrl+B equivalent)
            |
            +-- Agent activity dashboard (requires tracking all active agents)
                    |
                    +-- Token cost per sub-agent (TaskOutput.total_cost_usd)
                    |
                    +-- Context window gauge (SDK ModelUsage.contextWindow)
```

---

## MVP Recommendation for v0.7.0

### Phase 1: Core Sub-Agent Display

Enhance the existing `ActivityGroup` rendering to show sub-agents as first-class UI elements:

1. **Agent type badge** on the Task tool activity (show "Explore", "code-reviewer", etc.)
2. **Elapsed time indicator** using existing `task_progress` events
3. **Collapsible child tools** using existing depth/group infrastructure
4. **Completion summary** from SDKTaskNotificationMessage
5. **Error state** with clear failure reason

This phase uses infrastructure that already exists in the codebase.

### Phase 2: Background Agent Support

6. **Background indicator** on Task tools that were backgrounded (toolStatus: 'backgrounded')
7. **Background-to-foreground toggle** button on backgrounded tasks
8. **Task notification handling** when background agents complete
9. **TaskOutput result integration** into the completion display

### Phase 3: Agent Dashboard (Differentiator)

10. **Active agents panel** in sidebar or header showing all running/recent sub-agents
11. **Per-agent cost display** from TaskOutput data
12. **Resume button** to continue a completed sub-agent's session

### Defer to v0.8.0+

- Agent teams and inter-agent coordination
- Parallel agent comparison view
- Custom agent definition visual editor
- Agent memory/persistence
- Split-pane agent views

---

## Sources

**Official Documentation (HIGH confidence):**
- [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Interactive Mode](https://code.claude.com/docs/en/interactive-mode)
- [VS Code Multi-Agent Development](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [VS Code Agent Overview](https://code.visualstudio.com/docs/copilot/agents/overview)
- [VS Code Unified Agent Experience](https://code.visualstudio.com/blogs/2025/11/03/unified-agent-experience)
- [Cursor 2.0 Changelog](https://cursor.com/changelog/2-0)
- [Cursor Parallel Agents Docs](https://cursor.com/docs/configuration/worktrees)
- [Windsurf Cascade Changelog](https://windsurf.com/changelog)

**SDK Source (HIGH confidence):**
- `@anthropic-ai/claude-agent-sdk` types: AgentDefinition, AgentInput, SDKTaskNotificationMessage, SDKToolProgressMessage
- Existing codebase: turn-utils.ts (groupActivitiesByParent), tool.ts event handlers, message.ts types

**Industry Analysis (MEDIUM confidence):**
- [VS Code 1.107 Agent HQ](https://visualstudiomagazine.com/articles/2025/12/12/vs-code-1-107-november-2025-update-expands-multi-agent-orchestration-model-management.aspx)
- [Cursor 2.0 InfoWorld](https://www.infoworld.com/article/4081431/cursor-2-0-adds-coding-model-ui-for-parallel-agents.html)
- [Building Agents with Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
