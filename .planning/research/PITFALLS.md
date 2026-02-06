# Domain Pitfalls: Sub-Agent Orchestration in Electron Desktop App

**Domain:** Adding sub-agent orchestration to existing Electron + React app wrapping the Claude Agent SDK
**Researched:** 2026-02-06
**Confidence:** HIGH (verified against codebase, SDK docs, and real-world GitHub issues)

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or fundamental architecture problems.

---

### Pitfall 1: Shared Token Budget Exhaustion

**What goes wrong:** Parent agent and N sub-agents share the same 200K token context window. When parallel sub-agents run, each consumes 10-15K tokens before returning. Three to five concurrent sub-agents can exhaust the parent's budget, causing truncated results and cascading failures.

**Why it happens:** The Claude Agent SDK runs sub-agents inside the parent's `query()` generator. Each sub-agent's tool calls, results, and summary text all count against the parent's context window. Developers test with one sub-agent and don't see the multiplicative effect.

**Consequences:**
- Sub-agents hit the 8192 output token limit and produce truncated results (3 of 5 agents failed in [real-world report](https://github.com/anthropics/claude-code/issues/10212))
- Each failure wastes 10-15K tokens of parent budget before truncation
- Forces sequential execution instead of parallel (5-10x slower)
- Parent's context fills with sub-agent overhead, leaving no room for the actual conversation

**Codebase-specific risk:** The existing `ManagedSession.tokenUsage` tracks a single context window. No infrastructure exists for tracking per-sub-agent token consumption. The `usage_update` event type reports `inputTokens` and `contextWindow` but does not break these down by sub-agent.

**Prevention:**
1. Track per-sub-agent token consumption separately (the SDK exposes `parent_tool_use_id` on all messages, use it to attribute tokens)
2. Implement a token budget allocator: reserve a portion of the parent's window for orchestration and divide the rest among sub-agents
3. Set output token limits per sub-agent via SDK options
4. Monitor context utilization in real-time and cancel sub-agents approaching budget limits
5. Design sub-agents to return summaries by default, with full output written to files

**References:**
- [Claude Code #10212: Independent Context Windows for Sub-Agents](https://github.com/anthropics/claude-code/issues/10212)
- [claude-agent-sdk-typescript #66: Context window usage formula](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66)
- [claude-agent-sdk-typescript #124: Tool Search to reduce token usage](https://github.com/anthropics/claude-agent-sdk-typescript/issues/124)

---

### Pitfall 2: Event Stream Interleaving and Out-of-Order Delivery

**What goes wrong:** When multiple sub-agents run in parallel, their events arrive interleaved on the same stream from the SDK's `query()` generator. `tool_result` events can arrive before their corresponding `tool_start`, and events from different sub-agents are mixed together.

**Why it happens:** The SDK streams events from all sub-agents through a single `for-await` loop. The parent processes events sequentially but sub-agents execute concurrently. Network latency and API response ordering mean events do not arrive in a predictable sequence.

**Consequences:**
- Tool results arrive without matching tool starts (the codebase already handles this: "This is normal for background subagent child tools where tool_result arrives without a prior tool_start")
- UI renders orphaned tool results that later need backfilling when the start event arrives
- Race conditions in message array manipulation when multiple sub-agent events arrive in rapid succession

**Codebase-specific risk:** The current `processEvent()` method in `sessions.ts` (line 3163) processes events sequentially on the managed session's `messages` array. It uses `managed.messages.find(m => m.toolUseId === event.toolUseId)` for O(n) linear scans. With N sub-agents producing M tools each, this becomes O(N*M) per event. The safety net auto-completion logic (lines 3361-3385) that marks orphaned children as completed when a parent Task finishes is correct for the current single-agent case but becomes more complex with nested parallel sub-agents.

The renderer's `EventProcessor` handles out-of-order events correctly via its pure function design and `findToolMessage()` helper, but the main process's `processEvent()` mutates the `managed.messages` array directly, creating potential for state inconsistency during rapid interleaved updates.

**Prevention:**
1. Use `parentToolUseId` (already available from SDK's `parent_tool_use_id`) to maintain per-sub-agent event queues
2. Replace linear `messages.find()` scans with a Map<toolUseId, messageIndex> for O(1) lookups
3. Implement event buffering per sub-agent: collect events, then flush to the message array in correct order
4. The `ToolIndex` class in `tool-matching.ts` already provides an append-only, order-independent lookup. Extend this pattern to the main process's event handling
5. Test with simulated concurrent sub-agent event streams

---

### Pitfall 3: Permission Escalation Through Sub-Agent Inheritance

**What goes wrong:** Sub-agents inherit the parent's permission mode, but the inheritance model creates security gaps. Background sub-agents auto-deny permissions they can't prompt for, foreground sub-agents inherit permissions that may be too broad, and custom permission configurations fail to propagate.

**Why it happens:** The three-level permission system (`safe`/`ask`/`allow-all`) is designed for single-agent sessions. Sub-agents need a more nuanced model: they may need read access but not write access, or they may need specific tool access that doesn't map to the parent's mode.

**Consequences:**
- Sub-agents in `dontAsk` mode auto-deny tool usage even with `--dangerously-skip-permissions` ([Claude Code #11934](https://github.com/anthropics/claude-code/issues/11934))
- User-level permissions from `settings.json` are not inherited by sub-agents ([Claude Code #18950](https://github.com/anthropics/claude-code/issues/18950))
- Sub-agents fail to inherit file system permissions in MCP server mode ([Claude Code #5465](https://github.com/anthropics/claude-code/issues/5465))
- Custom plugin sub-agents cannot access MCP tools that built-in agents can ([Claude Code #13605](https://github.com/anthropics/claude-code/issues/13605))

**Codebase-specific risk:** The current permission system in `mode-manager.ts` uses per-session state (`initializeModeState`, `cleanupModeState`). Sub-agents spawned within a session don't get their own permission state. The `PERMISSION_MODE_CONFIG` maps modes to allowed tool sets, but sub-agent tool restrictions (from the `tools` field in agent definitions) are a separate, orthogonal constraint. The `shouldAllowToolInMode()` function checks the session's mode but has no concept of sub-agent scope.

The `permissions-config.ts` system supports workspace-level and source-level rules, but there's no sub-agent-level permission configuration. The `PendingPermission` system in `craft-agent.ts` resolves permissions via callbacks to the UI, but background sub-agents can't reach the UI.

**Prevention:**
1. Each sub-agent needs its own permission evaluation scope that intersects parent permissions with sub-agent tool restrictions
2. Foreground sub-agents should proxy permission prompts to the parent's UI (already partially works)
3. Background sub-agents need a permission policy defined at spawn time, not at prompt time
4. Log all permission denials for sub-agents with clear attribution to the sub-agent that was denied
5. Add sub-agent-level permission configuration to the existing `permissions-config.ts` hierarchy

---

### Pitfall 4: Resource Exhaustion from Parallel Sub-Agents

**What goes wrong:** N parallel sub-agents create N concurrent API calls, each with its own context window. Memory usage scales linearly with sub-agent count. On desktop machines with limited resources, this causes swap pressure, UI freezes, and potential OOM kills.

**Why it happens:** Each sub-agent maintains its own conversation history, tool outputs, and streaming buffers. The SDK manages this internally, but the host application's state management (Jotai atoms, message arrays, IPC events) adds overhead on top.

**Consequences:**
- Memory usage grows proportionally: each sub-agent adds ~50-200MB of context management overhead
- CPU contention from parallel API calls and response parsing
- Token cost multiplies: 5 sub-agents at 50K tokens each = 250K tokens per parent turn
- Electron main process becomes bottleneck for IPC forwarding of events from all sub-agents

**Codebase-specific risk:** The existing architecture spawns each session as a Bun subprocess. Sub-agents within a session run inside that single subprocess. While this avoids additional process creation, it concentrates all sub-agent memory in one process. The `ManagedSession.messages` array grows unbounded during a sub-agent-heavy conversation. The `sessionPersistenceQueue` debounces writes at 500ms, but during parallel sub-agent execution, the session data can grow by megabytes between flushes.

The lazy-loading optimization for sessions (`ensureSessionMessagesLoadedAtom`) helps for initial load, but during an active multi-sub-agent conversation, all messages are in memory. The existing note in `sessions.ts` about "reducing initial memory usage from ~500MB to ~50MB for 300+ sessions" suggests memory is already a concern.

**Prevention:**
1. Set a hard limit on concurrent sub-agents (3-5 is a reasonable default)
2. Implement a sub-agent queue: spawn at most N in parallel, queue the rest
3. Monitor memory pressure and throttle sub-agent creation accordingly
4. Summarize completed sub-agent histories to reduce in-memory message count
5. Consider streaming sub-agent results to disk (extend the JSONL pattern) rather than accumulating in memory
6. Add cost tracking per sub-agent so users can see the resource impact

---

## Moderate Pitfalls

Mistakes that cause technical debt, poor UX, or significant rework.

---

### Pitfall 5: Error Propagation and Cascading Failures

**What goes wrong:** A sub-agent fails mid-execution. The parent doesn't learn about the failure until the Task tool returns an error result. Meanwhile, other parallel sub-agents may depend on the failed sub-agent's output or share resources that are now in an inconsistent state.

**Why it happens:** The SDK surfaces sub-agent failures as tool errors on the Task tool. There's no real-time health monitoring of running sub-agents. The parent can't preemptively cancel related sub-agents when one fails.

**Consequences:**
- Other sub-agents waste tokens on work that will be discarded
- Parent's context fills with error messages from multiple failures
- Research shows up to 17.2x error amplification in poorly coordinated multi-agent systems ([source](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/))
- User sees a cascade of error messages with no clear root cause

**Codebase-specific risk:** The current error handling in `sendMessage()` (line 2722) catches errors from the `for-await` loop and routes them through `onProcessingStopped()`. But sub-agent errors arrive as `tool_result` events with `isError: true`, not as thrown exceptions. The `processEvent()` handler updates the tool message's status but has no mechanism to cancel sibling sub-agents. The `forceAbort()` method aborts the entire session, not individual sub-agents.

The `typed_error` handler (line 3463) has auth error retry logic that assumes a single active operation. Multiple concurrent sub-agent failures would trigger multiple retry attempts.

**Prevention:**
1. Implement a sub-agent supervisor that monitors all active sub-agents and can cancel siblings on failure
2. Classify sub-agent errors: transient (retry), fatal (cancel siblings), and partial (continue with degraded results)
3. Add circuit-breaker logic: after N sub-agent failures, stop spawning new ones
4. Surface the root cause error to the user, not every downstream failure
5. Extend the existing `task_progress` event to include health status, not just elapsed time

---

### Pitfall 6: UI State Complexity with Nested Agent Trees

**What goes wrong:** Rendering a tree of parent + sub-agents with real-time streaming updates causes React re-render storms, stale closures, and visual inconsistencies.

**Why it happens:** The current UI renders a flat message list. Sub-agents introduce a tree structure where messages have parent-child relationships via `parentToolUseId`. Streaming updates from multiple sub-agents arrive asynchronously, and React's batching may not group them optimally.

**Consequences:**
- Re-render cascade: updating one sub-agent's streaming text triggers re-renders for the entire message tree
- Stale closure bugs: event handlers capture old sub-agent state
- Visual jank: sub-agent progress indicators update at different rates
- Session list jitter: `lastMessageAt` updates from sub-agent intermediate messages cause re-sorting

**Codebase-specific risk:** The `sessionAtomFamily` pattern isolates sessions from each other (solving the original "Session A streaming causes Session B re-render" bug). But within a session, all messages share a single atom. The `updateSessionAtom` action replaces the entire session object, causing all message-rendering components to re-evaluate.

The `syncSessionsToAtomsAtom` has a critical guard: "If the atom's session is processing, it has streaming updates that React state doesn't know about yet. Don't overwrite." This guard works for single-agent streaming but becomes more complex when multiple sub-agents are streaming simultaneously. The `streamingState` in `SessionState` tracks a single streaming context (content + turnId + parentToolUseId). Multiple concurrent streaming sub-agents need multiple streaming contexts.

The `updateStreamingContentAtom` (line 236) appends to the last message if it matches the turnId. With parallel sub-agents, the "last message" assumption breaks.

**Prevention:**
1. Introduce per-sub-agent streaming state: a Map<parentToolUseId, StreamingState> instead of a single StreamingState
2. Use React.memo with stable keys for sub-agent message groups to prevent cascade re-renders
3. Consider a separate atom family for sub-agent messages (keyed by parentToolUseId) to isolate updates
4. Implement virtual scrolling for long sub-agent output
5. Batch IPC events before dispatching to atoms: collect events for 16ms (one frame), then apply all at once
6. The `lastMessageAt` for session sorting should only update on user messages and final assistant responses, not sub-agent intermediate updates (this is already partially implemented: "Note: Does NOT update lastMessageAt - caller must handle timestamp updates")

---

### Pitfall 7: Background Sub-Agent Lifecycle Management

**What goes wrong:** Background sub-agents continue running after the user navigates away, closes the session, or the app restarts. There's no mechanism to monitor, pause, resume, or cancel individual background sub-agents.

**Why it happens:** The SDK's background task support (via `run_in_background: true`) returns immediately with an `agentId`. The parent can later check results via `TaskOutput`. But there's a lifecycle gap: the agent runs asynchronously with no heartbeat, no progress reporting (beyond elapsed time), and no cancellation granularity.

**Consequences:**
- Background sub-agents can't access MCP tools ([Claude Code #13254](https://github.com/anthropics/claude-code/issues/13254)), degrading their capabilities
- After app restart, background task shell access is lost ([Claude Code #16085](https://github.com/anthropics/claude-code/issues/16085))
- No way to distinguish "still running" from "hung" sub-agents
- Sub-agents that need permission prompts silently fail in background mode

**Codebase-specific risk:** The `BackgroundTask` type in `sessions.ts` atoms tracks `id`, `type`, `toolUseId`, `startTime`, and `elapsedSeconds`. The `backgroundTasksAtomFamily` stores active tasks per session. But cleanup happens only when the parent Task tool result arrives or the session is removed. If the session's Bun subprocess crashes, background tasks become orphaned.

The `handleTaskBackgrounded` and `handleShellBackgrounded` handlers (in `tool.ts` event processor) update status to 'backgrounded' and store IDs. But the `handleTaskProgress` only updates `elapsedSeconds`. There's no "task failed" or "task completed" event for background tasks. Instead, completion is detected when `TaskOutput` is called.

The `backgroundShellCommands` Map on `ManagedSession` tracks shell commands for killing, but there's no equivalent for sub-agent tasks. The `cancelProcessing` method (line 2778) calls `forceAbort(AbortReason.UserStop)` which aborts the entire query, not individual background sub-agents.

**Prevention:**
1. Implement a background task registry in the main process that survives subprocess restarts
2. Add heartbeat monitoring: if a background sub-agent doesn't report progress for N seconds, mark it as potentially hung
3. Provide per-sub-agent cancel/resume controls in the UI
4. Persist background task state to disk so it survives app restart
5. Design a graceful degradation path: when background sub-agents lose MCP access, inform the user and offer to resume in foreground

---

### Pitfall 8: Session Persistence with Sub-Agent History

**What goes wrong:** Sub-agent messages interleaved with parent messages create a complex nested structure in JSONL format. Loading, replaying, and resuming sessions with sub-agent history requires reconstructing the parent-child tree. File sizes grow large because sub-agent tool calls are verbose.

**Why it happens:** The current JSONL format is a flat sequence of messages with `parentToolUseId` as the only tree-structure hint. Sub-agents can produce dozens of tool calls each, and parallel sub-agents multiply this. The `SessionHeader` pre-computes `messageCount`, `lastMessageRole`, and `preview`, but these don't account for sub-agent message distribution.

**Consequences:**
- Large session files: a conversation with 5 sub-agents, each making 10 tool calls, adds 50+ messages per turn
- Slow session loading: parsing thousands of JSONL lines blocks the main process
- Resume complexity: the SDK needs the session ID and agent IDs to resume sub-agents, but these aren't stored in the JSONL header
- Compaction interactions: when the parent compacts, sub-agent transcripts are stored separately (per SDK docs), but the app's persistence layer doesn't know about these separate files

**Codebase-specific risk:** The `SessionPersistenceQueue` writes the entire session as a single JSONL file (header + all messages). The atomic write pattern (write to .tmp, then rename) prevents corruption but requires serializing all messages every time. With sub-agent-heavy sessions, this serialization cost grows.

The `StoredMessage` type includes `parentToolUseId` but not `agentId`. When resuming a session with sub-agents, the app can't tell which messages came from which sub-agent. The SDK maintains sub-agent transcripts at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, separate from the app's own JSONL storage. This creates two sources of truth for session history.

The `messageToStored()` function (line 372) converts runtime messages to stored format. It preserves `parentToolUseId` but doesn't store background task metadata (`isBackground`, `taskId`, `shellId`). On reload, background task status is lost.

**Prevention:**
1. Add `agentId` to `StoredMessage` type to preserve sub-agent attribution
2. Store background task metadata in the JSONL (taskId, shellId, isBackground)
3. Consider incremental persistence: append new messages to JSONL instead of rewriting the entire file
4. Add a session-level summary of sub-agent usage to the `SessionHeader` (count, agent types, total tokens per sub-agent)
5. Reconcile the app's JSONL storage with the SDK's sub-agent transcript files during session load
6. Implement lazy loading for sub-agent messages: load parent messages first, load sub-agent details on expand

---

### Pitfall 9: Subprocess Lifecycle Complexity

**What goes wrong:** The main process manages Bun subprocesses for agent sessions. Sub-agents run inside these subprocesses. When a subprocess crashes, restarts, or hangs, all sub-agents within it are affected. The main process has no visibility into sub-agent state within the subprocess.

**Why it happens:** The current architecture has a clean two-level hierarchy: Electron main process -> Bun subprocess (one per session). Sub-agents add a third level: Electron main -> Bun subprocess -> SDK sub-agent. The main process can manage the subprocess but can't directly manage sub-agents within it.

**Consequences:**
- Subprocess crash kills all active sub-agents without cleanup
- Memory leak: sub-agent context accumulates within the subprocess but the main process can't trigger garbage collection
- The `agent: CraftAgent | null` field on `ManagedSession` represents a single agent. Sub-agents are invisible to the session manager.
- The `processingGeneration` counter (used for stale-request detection) doesn't account for sub-agent generations

**Codebase-specific risk:** The `getOrCreateAgent()` method creates a single `CraftAgent` per session. This agent handles sub-agent creation internally via the SDK. The `forceAbort()` call on the agent aborts the entire query including all sub-agents. There's no selective abort.

The auth retry logic (line 3487) destroys the agent (`managed.agent = null`) and recreates it. This kills all active sub-agents. If a sub-agent was mid-execution, its work is lost.

The `onProcessingStopped()` handler (line 2828) flushes the session and processes the next queued message. It doesn't distinguish between "parent completed normally" and "parent completed because a sub-agent forced it to."

**Prevention:**
1. Add sub-agent tracking to `ManagedSession`: a Map of active sub-agent IDs and their states
2. Implement graceful shutdown: before destroying an agent, signal sub-agents to finalize their work
3. Add sub-agent-aware abort: ability to cancel specific sub-agents without aborting the parent
4. Monitor subprocess memory and CPU from the main process; throttle sub-agent creation when resources are constrained
5. The `processingGeneration` pattern should extend to sub-agents so stale sub-agent events are discarded

---

## Minor Pitfalls

Mistakes that cause annoyance but are fixable without major rework.

---

### Pitfall 10: Sub-Agent Compaction Timing

**What goes wrong:** The parent agent compacts its context while sub-agents are running. Sub-agent transcripts survive compaction (stored separately), but the parent loses the context needed to understand sub-agent results when they return.

**Why it happens:** Auto-compaction triggers at ~95% context utilization. With multiple sub-agents consuming tokens, this threshold is reached faster. The compaction happens asynchronously and the parent's understanding of sub-agent tasks is compressed away.

**Consequences:**
- Parent receives sub-agent results but has lost the context of why it spawned them
- Compacted parent asks redundant questions or re-spawns sub-agents unnecessarily
- The compaction_complete event triggers pending plan execution (line 3416), but this doesn't account for outstanding sub-agent work

**Prevention:**
1. Track active sub-agents and delay compaction until they complete
2. Include a summary of active sub-agent tasks in the compaction prompt so the parent retains orchestration context
3. Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lower for orchestrating sessions to leave more headroom
4. Store sub-agent task descriptions in session metadata so they survive compaction

---

### Pitfall 11: Cost Visibility and Attribution

**What goes wrong:** Users have no visibility into how much each sub-agent costs. The aggregate `tokenUsage` on the session shows a total, but there's no per-sub-agent breakdown.

**Why it happens:** The SDK reports usage at the conversation level, not per sub-agent. The `usage_update` event provides `inputTokens` and `contextWindow` without attribution.

**Consequences:**
- Users can't identify expensive sub-agents to optimize
- No way to set per-sub-agent cost budgets
- Surprise bills from sub-agents that consume more tokens than expected

**Codebase-specific risk:** The `SessionTokenUsage` type has flat counters. There's no per-sub-agent breakdown structure. The UI's context usage display (powered by `usage_update` events) shows a single percentage bar.

**Prevention:**
1. Attribute token usage to sub-agents using `parentToolUseId` from SDK events
2. Add a per-sub-agent token counter to the UI (possibly in the ActiveTasksBar)
3. Implement sub-agent cost budgets with configurable thresholds
4. Log per-sub-agent token usage for post-hoc analysis

---

### Pitfall 12: Testing Complexity

**What goes wrong:** Testing sub-agent orchestration requires simulating concurrent, asynchronous, interleaved event streams. Existing test infrastructure (Bun test runner, Playwright e2e) isn't set up for this.

**Why it happens:** The current test suite tests event processing with sequential events. Sub-agents produce concurrent, non-deterministic event orderings that are hard to reproduce in tests.

**Consequences:**
- Race conditions pass tests but fail in production
- Tests are flaky due to timing sensitivity
- E2e tests require live API calls for sub-agent flows (expensive, slow)

**Codebase-specific risk:** The existing `tool-matching-sdk-fixtures.test.ts` has a "full subagent lifecycle" test case that validates sequential parent-child event processing. But it doesn't test parallel sub-agents or out-of-order delivery. The event processor's pure-function design makes unit testing straightforward, but integration testing the full pipeline (subprocess -> main process -> IPC -> renderer) with concurrent sub-agents is not covered.

**Prevention:**
1. Build an event stream simulator that generates realistic interleaved sub-agent events
2. Add property-based tests: any permutation of valid events should produce consistent state
3. Test the renderer's `processEvent` with concurrent updates to verify atom consistency
4. Mock the SDK's `query()` generator to produce controlled multi-sub-agent event streams
5. Add sub-agent e2e test scenarios to the live test suite

---

## Kata-Agents Integration Risk Matrix

| Dimension | Current State | Sub-Agent Impact | Risk Level |
|-----------|--------------|-----------------|------------|
| Token budget | Single session tracking | N sub-agents multiply consumption | HIGH |
| Event processing | Sequential, flat messages | Interleaved, tree-structured | HIGH |
| Permission model | Per-session, three modes | Per-sub-agent, intersected with parent | HIGH |
| Memory management | Lazy loading, atom isolation | In-memory accumulation during execution | HIGH |
| Error handling | Single-agent abort/retry | Cascading failures across sub-agents | MODERATE |
| UI rendering | Flat message list | Nested tree with concurrent streams | MODERATE |
| Background tasks | Basic tracking (id + elapsed) | Full lifecycle management needed | MODERATE |
| Session persistence | Flat JSONL, single file | Nested structure, dual storage | MODERATE |
| Subprocess model | One CraftAgent per session | Sub-agents invisible to main process | MODERATE |
| Testing | Sequential event fixtures | Concurrent, non-deterministic | LOW |
| Cost tracking | Aggregate per session | Per-sub-agent attribution needed | LOW |
| Compaction | Single-agent timing | Must account for active sub-agents | LOW |

---

## Sources

### Official SDK Documentation
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents) -- Programmatic sub-agent definition, tool restrictions, detection, resumption
- [Create Custom Subagents](https://code.claude.com/docs/en/sub-agents) -- File-based definitions, permission modes, hooks, lifecycle
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)

### Real-World GitHub Issues (Claude Code)
- [#10212: Independent Context Windows for Sub-Agents](https://github.com/anthropics/claude-code/issues/10212) -- Token exhaustion with parallel sub-agents, 8192 output limit
- [#13254: Background subagents cannot access MCP tools](https://github.com/anthropics/claude-code/issues/13254) -- MCP tool unavailability in background mode, reopened after fix
- [#11934: Sub-agents permission denial in dontAsk mode](https://github.com/anthropics/claude-code/issues/11934) -- Permission bypass flags not propagating to sub-agents
- [#18950: Skills/subagents do not inherit user-level permissions](https://github.com/anthropics/claude-code/issues/18950)
- [#16085: Background task shell access lost on session restore](https://github.com/anthropics/claude-code/issues/16085) -- Subprocess state not surviving restarts
- [#5465: Task subagents fail to inherit permissions in MCP server mode](https://github.com/anthropics/claude-code/issues/5465)
- [#13605: Custom plugin subagents cannot access MCP tools](https://github.com/anthropics/claude-code/issues/13605)
- [#4462: Sub-agents claim successful file creation but files don't persist](https://github.com/anthropics/claude-code/issues/4462)
- [#15677: Expose sub-agent context sizes in statusline API](https://github.com/anthropics/claude-code/issues/15677)
- [#9620: Subagent spawning fails with marketplace permission error](https://github.com/anthropics/claude-code/issues/9620)
- [#4182: Sub-Agent Task Tool Not Exposed When Launching Nested Agents](https://github.com/anthropics/claude-code/issues/4182)

### SDK Issues
- [claude-agent-sdk-typescript #66: Context window usage formula](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66)
- [claude-agent-sdk-typescript #124: Tool Search (defer_loading) to reduce token usage](https://github.com/anthropics/claude-agent-sdk-typescript/issues/124)

### Multi-Agent Systems Research
- [Why Your Multi-Agent System is Failing: 17x Error Trap](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/) -- Error amplification in multi-agent systems, centralized coordination as mitigation
- [Why Multi-Agent AI Systems Fail and How to Fix Them](https://galileo.ai/blog/multi-agent-ai-failures-prevention) -- Specification failures (42%), coordination breakdowns (37%), verification gaps (21%)
- [Context Management with Subagents in Claude Code](https://www.richsnapp.com/article/2025/10-05-context-management-with-subagents-in-claude-code)

### Electron and Subprocess Management
- [Everything About Electron Child Processes](https://www.matthewslipper.com/2019/09/22/everything-you-wanted-electron-child-process.html) -- Fork behavior, ELECTRON_RUN_AS_NODE, API restrictions
- [Electron #7084: child_process.fork() not terminated on close](https://github.com/electron/electron/issues/7084) -- Process cleanup on app exit
- [Electron #4817: Zombie processes and memory leaks](https://github.com/electron/electron/issues/4817)
- [Electron utilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process) -- Recommended alternative to child_process.fork
