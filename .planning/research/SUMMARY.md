# Sub-Agent Orchestration Research Summary

**Project:** Kata Agents v0.7.0 Milestone
**Synthesized:** 2026-02-06
**Research Coverage:** Technology stack, feature landscape, architecture integration, pitfalls

---

## Executive Summary

Sub-agent orchestration extends Kata's agent capabilities with user-defined task delegation and parallel execution. The SDK provides complete technical primitives (AgentDefinition, Task tool, lifecycle hooks), and the existing codebase already handles core sub-agent event processing (parentToolUseId tracking, ActivityGroup nesting, background task UI). The implementation path involves three layers: storage/configuration (new agent definition CRUD), runtime integration (plumbing agent definitions through CraftAgent.chat()), and UI enhancement (agent identity in existing message tree).

Three critical risks require upfront design: shared token budget exhaustion (parallel sub-agents consume parent context multiplicatively), event stream interleaving (concurrent sub-agent events require proper ordering and attribution), and permission inheritance complexity (sub-agents need their own permission evaluation scope). These are solvable with token attribution logic, per-sub-agent state tracking, and permission intersection models.

The GUI opportunity is in persistent visibility. CLI tools (Claude Code, command-line agents) provide background task lists and status checks via keyboard shortcuts and commands. A desktop GUI can offer a persistent agent activity dashboard, live sub-agent stream preview, per-agent token cost display, and context window gauges. These features are impossible in a CLI and differentiate Kata in the agent orchestration space.

---

## Key Findings by Research Area

### Technology Stack (STACK.md)

**What the SDK provides:**
- `AgentDefinition` type with description, tools, disallowedTools, prompt, model, mcpServers, skills, maxTurns
- `Options.agents` parameter accepts `Record<string, AgentDefinition>`
- Task tool with `subagent_type` input that references an agent definition
- SubagentStart/SubagentStop hook events for lifecycle management
- `SDKTaskNotificationMessage` for background task completion (status, output_file, summary)
- All messages carry `parent_tool_use_id` to identify sub-agent context

**What the codebase already has:**
- `parentToolUseId` tracking on all messages (runtime and stored)
- `ActivityGroup` type and `groupActivitiesByParent()` for nested tool display
- `task_backgrounded` / `task_progress` event handling
- Background task UI in ActiveTasksBar with TaskActionMenu
- Safety net that auto-completes orphaned child tools when parent Task finishes
- Plugin loading via `plugins: [{ type: 'local', path }]` (line 1483 in craft-agent.ts) that auto-discovers `.claude/agents/*.md` files

**Gap identified:**
- `SDKTaskNotificationMessage` not yet mapped to AgentEvent union type or forwarded to renderer
- No token attribution logic to track per-sub-agent consumption
- No agent slug extraction from Task tool input for UI display

**No new dependencies required.** The existing React + Jotai + shadcn/ui stack provides sufficient primitives for sub-agent tree visualization. Evaluated tree libraries (react-d3-tree, react-arborist, React Flow, react-complex-tree) were rejected due to heavy dependencies, styling conflicts, or wrong abstractions for shallow agent hierarchies.

### Feature Landscape (FEATURES.md)

**Table stakes** (users expect these, missing any feels broken):
1. Sub-agent as collapsible group in message tree (already partially built)
2. Progress indication for running sub-agents (SDK provides elapsed_time_seconds)
3. Background vs foreground distinction (run_in_background flag)
4. Completion summary when sub-agents finish (SDKTaskNotificationMessage.summary)
5. Error display with clear failure reason (status: 'failed')
6. Nested tool call display with depth indentation (already built)
7. Agent type label showing which agent is running (from subagent_type)

**GUI differentiators** (CLI cannot replicate):
1. **Agent activity dashboard**: Persistent panel showing all active/recent sub-agents with status, elapsed time, token cost. CLI equivalent (Ctrl+T in Claude Code) requires a keyboard shortcut and only shows on demand.
2. **Live sub-agent stream preview**: Expandable real-time view of what a background agent is doing. CLI has no visibility into background agent internals until completion.
3. **Context window gauge per sub-agent**: Visual meter showing context consumption. No CLI equivalent.
4. **Parallel comparison view**: Side-by-side results from multiple agents solving the same problem. CLI shows results sequentially.

**MVP recommendation:**
- Phase 1: Core sub-agent display (agent type badge, elapsed time, collapsible children, completion summary, error state)
- Phase 2: Background agent support (background indicator, toggle button, task notification handling, TaskOutput integration)
- Phase 3: Agent dashboard (active agents panel, per-agent cost display, resume button)

**Defer to v0.8.0+:**
- Agent teams (multi-session coordination with shared task lists and inter-agent messaging)
- Parallel agent comparison/evaluation (requires git worktree isolation, result evaluation)
- Custom agent definition visual editor (markdown files suffice for v0.7.0)
- Agent memory/persistence (cross-session learning)

### Architecture Integration (ARCHITECTURE.md)

**Recommended storage pattern:** Workspace-level agent definitions at `~/.kata-agents/workspaces/{id}/agents/{agent-slug}/` with:
- `config.json` (AgentDefinition fields + UI metadata: slug, name, description, model, tools, disallowedTools, mcpServers, skills, maxTurns, enabled, icon)
- `prompt.md` (system prompt as separate file for editing)

**New package module:**
```
packages/shared/src/agents/
  types.ts           # StoredAgentDefinition, LoadedAgent interfaces
  storage.ts         # CRUD for agent definition files
  index.ts           # Re-exports
```

**New IPC channels:**
- `agents:get` - List agent definitions for workspace
- `agents:create` - Create new agent definition
- `agents:update` - Update agent definition
- `agents:delete` - Delete agent definition
- `agents:templates` - Get built-in agent templates
- `agents:changed` - Broadcast when definitions change (main -> renderer)

**Runtime changes needed:**
1. Extract `agentSlug` from Task tool input (subagent_type field) in `sessions.ts` event processing
2. Add `agentSlug?: string` to Message type and ToolStartEvent type
3. Store `activeSubAgents: Map<taskId, agentSlug>` on ManagedSession for tracking
4. Pass loaded agent definitions to `options.agents` in CraftAgent.chat()
5. Add agent-aware permission checks in PreToolUse hook (enforce disallowedTools per agent)

**Files to create:**
- `packages/shared/src/agents/` module (3 files)
- `apps/electron/src/renderer/atoms/agents.ts` (agentDefinitionsAtom, agentDefinitionMapAtom)
- `apps/electron/src/renderer/components/agents/` directory (AgentList, AgentEditor, AgentCard components)

**Files to modify:**
- `packages/core/src/types/message.ts` (add agentSlug)
- `packages/shared/src/agent/craft-agent.ts` (load agents, pass to options, agent-aware permissions)
- `apps/electron/src/shared/types.ts` (IPC channels)
- `apps/electron/src/main/ipc.ts` (agent CRUD handlers)
- `apps/electron/src/main/sessions.ts` (agentSlug extraction, activeSubAgents tracking)
- `apps/electron/src/preload/index.ts` (expose agent methods)
- `apps/electron/src/renderer/event-processor/types.ts` (agentSlug on ToolStartEvent)
- Settings UI component (add Agents tab)
- ActiveTasksBar.tsx (show agent name when BackgroundTask has agentSlug)
- TurnCard rendering (agent identity badge on Task activities)

**Build order:**
1. Storage layer (packages/shared/src/agents/)
2. IPC and main process (channels, handlers, activeSubAgents tracking)
3. Renderer state (atoms, extend Message type)
4. UI components (settings panel, agent badges, dashboard)

### Domain Pitfalls (PITFALLS.md)

**Critical pitfalls (cause rewrites):**

1. **Shared token budget exhaustion (HIGH risk):** Parent and N sub-agents share the same 200K token context window. Three to five concurrent sub-agents can exhaust the parent's budget, causing truncated results. Real-world report: 3 of 5 agents failed with output truncation. Prevention: track per-sub-agent token consumption via parentToolUseId, implement token budget allocator, set output token limits per sub-agent, monitor context utilization in real-time.

2. **Event stream interleaving (HIGH risk):** Multiple sub-agents produce interleaved events on the same stream. `tool_result` can arrive before `tool_start`, and events from different sub-agents are mixed. Current `processEvent()` uses O(n) linear scans on `managed.messages` array which becomes O(N*M) with N sub-agents and M tools each. Prevention: replace linear scans with Map-based O(1) lookups, implement per-sub-agent event queuing, extend ToolIndex pattern to main process.

3. **Permission escalation (HIGH risk):** Sub-agents inherit parent's permission mode but need more nuanced control. Background sub-agents auto-deny permissions they can't prompt for, foreground sub-agents may inherit too-broad permissions, custom permissions don't propagate. Prevention: each sub-agent needs its own permission evaluation scope intersecting parent permissions with sub-agent tool restrictions, foreground sub-agents proxy prompts to parent UI, background sub-agents need policy defined at spawn time.

4. **Resource exhaustion (HIGH risk):** N parallel sub-agents create N concurrent API calls. Memory usage scales linearly (~50-200MB per sub-agent). Token cost multiplies (5 sub-agents at 50K tokens each = 250K tokens per turn). Prevention: set hard limit on concurrent sub-agents (3-5), implement sub-agent queue, monitor memory pressure, summarize completed sub-agent histories to reduce in-memory message count.

**Moderate pitfalls:**

5. **Error propagation (MODERATE risk):** Sub-agent failures arrive as tool errors, not thrown exceptions. No real-time health monitoring. Parent can't preemptively cancel related sub-agents. Research shows 17.2x error amplification in poorly coordinated multi-agent systems. Prevention: implement sub-agent supervisor, classify errors (transient/fatal/partial), add circuit-breaker logic, surface root cause not every downstream failure.

6. **UI state complexity (MODERATE risk):** Nested sub-agent trees with real-time streaming cause React re-render storms. Current `sessionAtomFamily` has single StreamingState but multiple concurrent streaming sub-agents need multiple streaming contexts. Prevention: per-sub-agent streaming state (Map<parentToolUseId, StreamingState>), React.memo with stable keys, separate atom family for sub-agent messages, batch IPC events before dispatching.

7. **Background lifecycle management (MODERATE risk):** Background sub-agents run asynchronously with no heartbeat, no progress reporting beyond elapsed time, no cancellation granularity. Can't access MCP tools. After app restart, background task shell access is lost. Prevention: background task registry in main process, heartbeat monitoring, per-sub-agent cancel/resume controls, persist background task state to disk.

8. **Session persistence (MODERATE risk):** Sub-agent messages create complex nested structure in JSONL. Large session files (5 sub-agents with 10 tool calls each = 50+ messages per turn). SDK maintains separate sub-agent transcripts at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, creating two sources of truth. StoredMessage doesn't include agentId or background task metadata. Prevention: add agentId to StoredMessage, store background task metadata, consider incremental persistence, reconcile app's JSONL with SDK's sub-agent transcripts, lazy loading for sub-agent messages.

**Minor pitfalls:**

9. **Sub-agent compaction timing:** Parent compacts context while sub-agents run, losing orchestration context. Prevention: delay compaction until sub-agents complete, include summary of active sub-agents in compaction prompt.

10. **Cost visibility:** No per-sub-agent token breakdown. Users can't identify expensive sub-agents. Prevention: attribute token usage via parentToolUseId, per-sub-agent counter in UI.

11. **Testing complexity:** Testing requires simulating concurrent, asynchronous, interleaved event streams. Existing test infrastructure not set up for this. Prevention: event stream simulator, property-based tests, mock SDK query() generator, add sub-agent e2e scenarios.

---

## Implications for Roadmap

### Phase 1: Core Infrastructure (v0.7.0 foundation)

**Goal:** Enable user-defined sub-agent storage, runtime loading, and basic UI display without touching parallel execution or background tasks.

**Rationale:** Build the storage layer and agent definition loading pipeline first. This establishes the data model and IPC patterns that later phases depend on. No UI complexity yet, no concurrency risks yet.

**Deliverables:**
- Agent definition storage at `~/.kata-agents/workspaces/{id}/agents/{slug}/`
- CRUD operations in `packages/shared/src/agents/`
- IPC channels for agent management
- Load agent definitions and pass to `options.agents` in CraftAgent.chat()
- Extract agentSlug from Task tool input and add to Message type
- Agent settings panel in workspace settings (list, create, edit, delete)

**Dependencies:** None (greenfield)

**Risk flags:** None at this phase (no runtime execution changes)

### Phase 2: Sub-Agent Identity and Single-Agent UX (v0.7.0 MVP)

**Goal:** Make sub-agents visible in the existing message tree with agent type badges, elapsed time, and completion summaries. One sub-agent at a time, foreground only.

**Rationale:** Extend the existing ActivityGroup rendering with agent identity. Users see which agent ran, how long it took, and the result. No background tasks, no parallel execution (avoids token exhaustion and event interleaving risks).

**Deliverables:**
- Agent type badge on Task activities (show agent name + icon from definition)
- Elapsed time indicator using existing `task_progress` events
- Completion summary display from `SDKTaskNotificationMessage`
- Error state display with clear failure reason
- Agent-aware permission prompts (include agent name in permission request)
- activeSubAgents tracking in ManagedSession (one entry max for now)

**Dependencies:** Phase 1 (needs agent definitions loaded)

**Risk flags:**
- Research needed: How to handle permission intersection for sub-agents with restricted tools
- Implementation detail: Renderer's `updateStreamingContentAtom` assumes single streaming context; may need adjustment even for single sub-agent

### Phase 3: Background Sub-Agents and Lifecycle Management (v0.7.1)

**Goal:** Enable background sub-agent execution with proper lifecycle tracking, status monitoring, and output retrieval.

**Rationale:** Background execution is a table stakes feature (users expect it from Claude Code). But it introduces moderate risks (no heartbeat, MCP tool unavailability, subprocess restart issues). Separate from Phase 2 to avoid compounding complexity.

**Deliverables:**
- Background indicator on Task activities (toolStatus: 'backgrounded')
- Handle `SDKTaskNotificationMessage` when background tasks complete
- TaskOutput result integration into completion display
- Background task registry in main process (Map<taskId, metadata>)
- Per-sub-agent cancel control in ActiveTasksBar
- Persist background task state to JSONL (taskId, agentSlug, isBackground)
- Heartbeat monitoring (mark hung tasks after N seconds of no progress)

**Dependencies:** Phase 2 (needs single foreground sub-agent working)

**Risk flags:**
- **Research needed:** Background sub-agents can't access MCP tools (SDK limitation). Need to document this restriction and provide UI feedback.
- **Research needed:** How to handle app restart with active background tasks. SDK loses shell access on restart (issue #16085).
- Implementation risk: Reconciling app's JSONL storage with SDK's separate sub-agent transcript files.

### Phase 4: Token Attribution and Budget Management (v0.7.2)

**Goal:** Track per-sub-agent token consumption and implement budget controls to prevent shared token exhaustion.

**Rationale:** This is the highest-risk pitfall for parallel sub-agents. Addressing it before Phase 5 (parallel execution) prevents costly production failures.

**Deliverables:**
- Per-sub-agent token counter using parentToolUseId attribution
- Token budget allocator (reserve parent budget, divide remainder among sub-agents)
- Real-time context utilization monitoring with UI gauge
- Per-sub-agent cost display in agent dashboard
- Cancel sub-agents approaching budget limits
- Output token limit per sub-agent (configurable in agent definition)

**Dependencies:** Phase 3 (needs background lifecycle tracking)

**Risk flags:**
- **Research needed:** The SDK's `usage_update` event provides aggregate inputTokens and contextWindow. Need to verify if per-sub-agent attribution via parentToolUseId is sufficient or if we need SDK changes.
- **Research needed:** What happens when a sub-agent hits the output token limit mid-execution? Does it gracefully truncate or error out?

### Phase 5: Parallel Sub-Agent Execution and Event Ordering (v0.8.0)

**Goal:** Allow multiple sub-agents to run concurrently with proper event interleaving, state consistency, and resource limits.

**Rationale:** Parallel execution is the major UX differentiator (vs sequential sub-agents) but introduces the highest complexity. Requires all previous phases to be stable. This is a v0.8.0 milestone, not v0.7.0.

**Deliverables:**
- Per-sub-agent event queuing in main process
- Replace linear message array scans with Map-based O(1) lookups
- Per-sub-agent StreamingState map in renderer atoms
- Concurrent sub-agent limit (3-5) with queueing for additional requests
- Memory pressure monitoring (cancel/throttle sub-agents if memory exceeds threshold)
- Batch IPC event dispatch (collect events for 16ms, then apply all at once)
- React.memo with stable keys for sub-agent message groups (prevent cascade re-renders)
- Sub-agent supervisor for error handling (cancel siblings on fatal error, circuit-breaker logic)

**Dependencies:** Phase 4 (needs token attribution and budget controls)

**Risk flags:**
- **Deep research needed:** Event interleaving with out-of-order delivery. Need comprehensive test suite with simulated concurrent event streams.
- **Deep research needed:** Renderer atom consistency under concurrent updates. Existing `syncSessionsToAtomsAtom` guard ("don't overwrite if processing") may need extension.
- **Deep research needed:** Subprocess memory leak prevention. How to trigger garbage collection for completed sub-agents?

### Phase 6: Agent Activity Dashboard (v0.8.1)

**Goal:** Build the persistent agent activity dashboard that shows all running, recent, and completed sub-agents with detailed metrics.

**Rationale:** This is the GUI's killer feature vs CLI tools. It requires stable parallel execution (Phase 5) and accurate token attribution (Phase 4).

**Deliverables:**
- Agent activity panel in sidebar or header
- Real-time status for all active sub-agents (running/completed/failed/stopped)
- Elapsed time, token consumption, and cost per sub-agent
- Click to expand sub-agent for full transcript
- Resume button to continue completed sub-agent's session
- Filter/search within dashboard (by agent type, status, cost)
- Export sub-agent results as markdown or JSON

**Dependencies:** Phase 5 (needs parallel execution working)

**Risk flags:**
- Implementation challenge: Where to place the dashboard in the existing UI layout? Sidebar competes with session list. Header competes with workspace switcher. Consider a floating panel or bottom drawer.

### Defer to Future Milestones (v0.9.0+)

**Agent teams (multi-session coordination):** Experimental even in Claude Code. Requires inter-agent messaging, shared task lists, session management across multiple windows/processes. Massive architectural lift. Wait for upstream SDK stabilization.

**Parallel agent comparison/evaluation:** Cursor's "run 8 agents and pick the best" feature requires git worktree isolation, result evaluation, conflict resolution. Significant infrastructure investment. Consider after agent teams.

**Custom agent definition visual editor:** Building a full visual editor for agent markdown files is scope creep. Let users edit markdown directly for v0.7.0-v0.8.0. Revisit for v0.9.0 if user demand is high.

**Agent memory/persistence:** Cross-session learning per agent. Adds storage/retrieval complexity. Defer until sub-agent orchestration patterns stabilize.

---

## Phase Dependency Graph

```
Phase 1: Core Infrastructure
    |
    +-- Phase 2: Single-Agent UX
            |
            +-- Phase 3: Background Lifecycle
                    |
                    +-- Phase 4: Token Attribution
                            |
                            +-- Phase 5: Parallel Execution (v0.8.0)
                                    |
                                    +-- Phase 6: Agent Dashboard
                                            |
                                            +-- Future: Agent Teams (v0.9.0+)
                                            +-- Future: Comparison View (v0.9.0+)
```

Critical path: 1 → 2 → 3 → 4 → 5

Phase 6 can start as soon as Phase 5 ships alpha (no need to wait for stable).

---

## Research Flags

### Must research before Phase 3:
- **Background sub-agent MCP tool access:** SDK issue #13254 reports background sub-agents can't access MCP tools. Verify if this is still true in SDK 0.2.19. If true, document prominently and provide UI feedback when user tries to background an agent that needs MCP tools.
- **App restart with active background tasks:** Issue #16085 reports shell access is lost on session restore. Test if sub-agent background tasks survive app restart or need special handling.

### Must research before Phase 4:
- **Per-sub-agent token attribution:** Verify that attributing SDK events via parentToolUseId provides accurate per-sub-agent token counts. If not, may need SDK changes or fallback to estimation.
- **Output token limit behavior:** What happens when a sub-agent hits 8192 output token limit? Truncation? Error? Need to handle gracefully in UI.

### Must research before Phase 5:
- **Event ordering guarantees:** Confirm that tool_result can arrive before tool_start for background sub-agent child tools (already observed in codebase). Design event buffer to handle this.
- **Renderer atom consistency:** Stress test `syncSessionsToAtomsAtom` with rapid concurrent updates from multiple sub-agents. Verify no race conditions.
- **Subprocess memory management:** Investigate if there's a way to trigger garbage collection in the Bun subprocess after sub-agents complete or if we need to restart the subprocess periodically.

---

## Confidence Assessment

| Research Area | Confidence | Rationale |
|---------------|-----------|-----------|
| SDK API surface (types, events, lifecycle) | **VERY HIGH** | Verified against SDK 0.2.19 type definitions and official docs |
| Existing codebase sub-agent support | **VERY HIGH** | Read source files, traced event flow, confirmed parentToolUseId handling |
| Feature landscape (table stakes, differentiators) | **HIGH** | Based on official Claude Code, VS Code, Cursor, Windsurf docs and changelogs |
| Architecture integration plan | **HIGH** | Follows established patterns (source/skill CRUD, JSONL persistence, IPC channels) |
| Critical pitfalls (token exhaustion, event interleaving) | **HIGH** | Verified against real-world GitHub issues and SDK limitations |
| Moderate pitfalls (permissions, lifecycle) | **MEDIUM-HIGH** | Based on issue reports but some are closed/disputed; need to verify in SDK 0.2.19 |
| Minor pitfalls (compaction, testing) | **MEDIUM** | Logical extrapolations from system behavior, not confirmed in production |
| Parallel execution complexity | **MEDIUM** | Theoretical analysis; real complexity emerges during implementation |
| Background task persistence | **MEDIUM** | SDK's separate transcript files not yet tested in Kata context |

---

## Gaps to Address

### Before Phase 1 implementation:
1. **Agent definition schema validation:** Define JSON schema for config.json and validate on load. Prevent invalid agent definitions from breaking runtime.
2. **Agent slug constraints:** Define valid characters (kebab-case only? length limits?). Must match filesystem restrictions.
3. **Built-in agent templates:** Decide if v0.7.0 ships with any pre-defined agents (e.g., "code-reviewer", "test-writer"). If yes, where do they live (app bundle vs workspace)?

### Before Phase 3 implementation:
4. **Background task completion notification:** Design UI for notifying user when background sub-agent finishes. Toast? Badge on session? Status bar update?
5. **Background task output handling:** TaskOutput returns text result. If result is large (10KB+), how to display? Inline expansion? Separate modal? Save to file?

### Before Phase 5 implementation:
6. **Sub-agent concurrency limit configuration:** Should the 3-5 concurrent limit be user-configurable? Per-workspace? Per-agent definition?
7. **Error classification taxonomy:** Define which errors are transient (retry), fatal (cancel siblings), partial (continue). Map SDK error codes to classifications.

### Testing gaps:
8. **Concurrent event stream simulator:** Build test harness that generates realistic interleaved sub-agent events. Use for integration testing.
9. **E2e sub-agent scenarios:** Add live test cases for foreground sub-agent, background sub-agent, parallel sub-agents (Phase 5+).
10. **Memory pressure testing:** Simulate 5-10 concurrent sub-agents to measure memory usage and identify leaks.

---

## Sources

### Technology Stack
- SDK type definitions: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.2.19)
- SDK tool schemas: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
- Claude Agent SDK documentation: https://platform.claude.com/docs/en/agent-sdk/subagents
- Existing codebase: `packages/shared/src/agent/tool-matching.ts`, `apps/electron/src/main/sessions.ts`, `apps/electron/src/renderer/event-processor/`

### Feature Landscape
- [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [VS Code Multi-Agent Development](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [VS Code Agent Overview](https://code.visualstudio.com/docs/copilot/agents/overview)
- [Cursor 2.0 Changelog](https://cursor.com/changelog/2-0)
- [Windsurf Cascade Changelog](https://windsurf.com/changelog)

### Architecture Integration
- Existing codebase: `craft-agent.ts`, `sessions.ts`, `ipc.ts`, `tool-matching.ts`, `event-processor/`
- Agent Skills specification: https://agentskills.io/llms.txt (for agent definition file format reference)

### Domain Pitfalls
- [Claude Code #10212: Independent Context Windows for Sub-Agents](https://github.com/anthropics/claude-code/issues/10212)
- [Claude Code #13254: Background subagents cannot access MCP tools](https://github.com/anthropics/claude-code/issues/13254)
- [Claude Code #11934: Sub-agents permission denial in dontAsk mode](https://github.com/anthropics/claude-code/issues/11934)
- [Claude Code #18950: Skills/subagents do not inherit user-level permissions](https://github.com/anthropics/claude-code/issues/18950)
- [Claude Code #16085: Background task shell access lost on session restore](https://github.com/anthropics/claude-code/issues/16085)
- [Why Your Multi-Agent System is Failing: 17x Error Trap](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/)
- [claude-agent-sdk-typescript #66: Context window usage formula](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66)

---

## Recommended v0.7.0 Scope

**In scope:**
- Phase 1: Core infrastructure (agent definition storage, CRUD, IPC, settings panel)
- Phase 2: Single-agent UX (agent type badges, elapsed time, completion summaries, errors)
- Phase 3: Background lifecycle (background indicator, task notifications, cancel controls)

**Out of scope (defer to v0.7.1+):**
- Phase 4: Token attribution and budget management
- Phase 5: Parallel sub-agent execution
- Phase 6: Agent activity dashboard
- Agent teams, comparison view, visual editor, memory/persistence

**Why this scope:** Delivers table stakes sub-agent features (user-defined agents, basic visibility, background execution) without tackling the highest-risk areas (token exhaustion, event interleaving, parallel execution). Establishes the foundation for more advanced features in v0.7.1-v0.8.0.

**Estimated effort:**
- Phase 1: 2-3 weeks (storage layer, IPC, settings UI)
- Phase 2: 2 weeks (agent identity rendering, event handling)
- Phase 3: 1-2 weeks (background lifecycle)
- **Total: 5-7 weeks for v0.7.0**

**Risk mitigation:** Phase 2 and 3 build on existing infrastructure (ActivityGroup, BackgroundTask, event processor). No rewrites needed. Token attribution and parallel execution (high-risk areas) deferred to v0.7.1+.
