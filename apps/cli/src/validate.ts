import type { CliRpcClient } from './client.ts'
import { c, createSpinner, out, spinnerFrames, useColor } from './output.ts'
import { getProviderDisplayName, resolveApiKey, shouldSetupLlmConnection } from './llm-setup.ts'

export interface ValidateStep {
  name: string
  fn: (client: CliRpcClient, ctx: ValidateContext) => Promise<string>
}

export interface ValidateContext {
  /** Pre-existing workspace directory (from --workspace-dir) */
  workspaceDir?: string
  /** Custom endpoint URL (from --base-url) */
  baseUrl?: string
  /** API key override (from --api-key) */
  apiKey?: string
  /** Provider hint (from --provider, default 'anthropic') */
  provider?: string
  workspaceId?: string
  workspaceRootPath?: string
  createdWorkspace?: boolean
  createdSessionId?: string
  createdSourceSlug?: string
  createdSkillSlug?: string
  createdAutomation?: boolean
  automationTestSessionId?: string
  /** Session created by automation that should be blocked by failing condition (if bug occurs) */
  automationBlockedSessionId?: string
  automationName?: string
  automationBlockedName?: string
  createdLabelId?: string
  /** Backup of existing automations.json before overwrite (undefined = didn't exist) */
  automationsJsonBackup?: string | null
  /** Backup of existing automations-history.jsonl before overwrite (undefined = didn't exist) */
  automationsHistoryBackup?: string | null
  branchedSessionId?: string
  /** Label ID for e2e-test label created for session tool validation */
  e2eTestLabelId?: string
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void
}

/** Minimal shapes for RPC responses used in validation steps. */
interface ValidateStatus {
  id?: string
  label?: string
}

interface ValidateSession {
  id: string
  name?: string
  labels?: string[]
}

interface ValidateLabel {
  id?: string
  name?: string
}

interface ValidateMessageBlock {
  type: string
  text?: string
}

interface ValidateMessage {
  role: string
  content: string | ValidateMessageBlock[]
}

interface ValidateMessagesResponse {
  messages?: ValidateMessage[]
  conversation?: ValidateMessage[]
}

/**
 * Send a message and wait for streaming events.
 * Returns a summary of received event types.
 * If expectTool is true, validates that tool_start + tool_result events arrived.
 */
async function waitForSendEvents(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  timeoutMs: number,
  expectTool: boolean,
  sendOptions?: Record<string, unknown>,
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void,
  expectToolName?: string,
): Promise<string> {
  const seen = new Set<string>()
  let textChunks = 0
  let toolName = ''
  let finished = false

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    seen.add(ev.type)
    if (ev.type === 'text_delta') textChunks++
    if (ev.type === 'tool_start') toolName = String(ev.toolName ?? '')
    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'interrupted') {
      finished = true
    }
    onEvent?.(ev)
  })

  try {
    await client.invoke('sessions:sendMessage', sessionId, message,
      undefined, undefined, sendOptions)

    const deadline = Date.now() + timeoutMs
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!finished) throw new Error('Timed out waiting for completion')

    // Only treat as failure if error was the terminal event (no complete followed)
    if (seen.has('error') && !seen.has('complete')) throw new Error('Session returned an error event')

    if (expectTool) {
      if (!seen.has('tool_start')) throw new Error('No tool_start event received')
      if (!seen.has('tool_result')) throw new Error('No tool_result event received')
      if (expectToolName && !toolName.includes(expectToolName)) {
        throw new Error(`Expected tool containing "${expectToolName}", got "${toolName}"`)
      }
      return `tool=${toolName}, ${textChunks} text deltas, events: ${[...seen].join(', ')}`
    }

    if (!seen.has('text_delta')) throw new Error('No text_delta events received')
    return `${textChunks} text deltas, events: ${[...seen].join(', ')}`
  } finally {
    unsub()
  }
}

/**
 * Clean up automation test artifacts (config files, session, label).
 * Shared between the automation:cleanup test step and runValidation error recovery.
 */
async function cleanupAutomationArtifacts(
  client: CliRpcClient,
  ctx: ValidateContext,
): Promise<string[]> {
  const cleaned: string[] = []

  // Restore or remove automation config files
  if (ctx.workspaceRootPath && ctx.createdAutomation) {
    try {
      const { writeFile, unlink } = await import('fs/promises')
      const configPath = `${ctx.workspaceRootPath}/automations.json`
      const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
      if (ctx.automationsJsonBackup != null) {
        await writeFile(configPath, ctx.automationsJsonBackup).catch(() => {})
        cleaned.push('automations.json (restored)')
      } else {
        await unlink(configPath).catch(() => {})
        cleaned.push('automations.json (removed)')
      }
      if (ctx.automationsHistoryBackup != null) {
        await writeFile(historyPath, ctx.automationsHistoryBackup).catch(() => {})
      } else {
        await unlink(historyPath).catch(() => {})
      }
      ctx.createdAutomation = false
    } catch { /* best effort */ }
  }

  // Delete automation-triggered sessions
  for (const key of ['automationTestSessionId', 'automationBlockedSessionId'] as const) {
    const id = ctx[key]
    if (!id || !client.isConnected) continue
    try {
      await client.invoke('sessions:delete', id)
      cleaned.push(`session ${id}`)
      ctx[key] = undefined
    } catch { /* best effort */ }
  }

  // Delete test label
  if (ctx.workspaceId && ctx.createdLabelId && client.isConnected) {
    try {
      await client.invoke('labels:delete', ctx.workspaceId, ctx.createdLabelId)
      cleaned.push(`label ${ctx.createdLabelId}`)
      ctx.createdLabelId = undefined
    } catch { /* best effort */ }
  }

  return cleaned
}

export function getValidateSteps(): ValidateStep[] {
  return [
    {
      name: 'Connect + handshake',
      fn: async (client) => {
        const start = performance.now()
        const clientId = await client.connect()
        const ms = Math.round(performance.now() - start)
        return `clientId: ${clientId}, ${ms}ms`
      },
    },
    {
      name: 'credentials:healthCheck',
      fn: async (client) => {
        const r = (await client.invoke('credentials:healthCheck')) as any
        return JSON.stringify(r)
      },
    },
    {
      name: 'system:versions',
      fn: async (client) => {
        const r = (await client.invoke('system:versions')) as any
        return r?.node ? `node=${r.node}` : JSON.stringify(r)
      },
    },
    {
      name: 'system:homeDir',
      fn: async (client) => {
        const r = await client.invoke('system:homeDir')
        return String(r)
      },
    },
    {
      name: 'workspaces:get',
      fn: async (client, ctx) => {
        // Register workspace from --workspace-dir if provided
        if (ctx.workspaceDir) {
          const { resolve } = await import('path')
          const absPath = resolve(ctx.workspaceDir)
          const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
          ctx.workspaceId = ws.id
          ctx.workspaceRootPath = absPath
          await client.invoke('window:switchWorkspace', ws.id)
          return `registered: ${absPath}`
        }
        const r = (await client.invoke('workspaces:get')) as any[]
        if (r?.length > 0) {
          ctx.workspaceId = r[0].id
          ctx.workspaceRootPath = r[0].rootPath ?? r[0].path
          // Bind this client to the workspace so push events (e.g. session:event)
          // routed { to: 'workspace' } reach us.
          await client.invoke('window:switchWorkspace', r[0].id)
          return `${r.length} workspaces`
        }
        // Auto-bootstrap a temp workspace for CI environments
        const { mkdtemp } = await import('fs/promises')
        const { tmpdir } = await import('os')
        const tmpDir = await mkdtemp(`${tmpdir()}/kata-validate-`)
        const ws = (await client.invoke('workspaces:create', tmpDir, 'validate-workspace')) as { id: string }
        ctx.workspaceId = ws.id
        ctx.workspaceRootPath = tmpDir
        ctx.createdWorkspace = true
        await client.invoke('window:switchWorkspace', ws.id)
        return `0 found → created temp workspace`
      },
    },
    {
      name: 'sessions:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sessions`
      },
    },
    {
      name: 'LLM_Connection:list',
      fn: async (client, ctx) => {
        const r = (await client.invoke('LLM_Connection:list')) as any[]

        // Custom endpoint: always create/update when --base-url is provided
        if (ctx.baseUrl) {
          const provider = ctx.provider || 'anthropic'
          let key = ''
          try {
            key = resolveApiKey(provider, ctx.apiKey || '')
          } catch (error) {
            return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
          }
          const slug = `${provider}-cli`
          const isAnthropicApi = provider === 'anthropic'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: `${getProviderDisplayName(provider)} (Custom Endpoint)`,
            providerType: 'pi_compat',
            authType: 'api_key_with_endpoint',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            credential: key,
            baseUrl: ctx.baseUrl,
            customEndpoint: { api: isAnthropicApi ? 'anthropic-messages' : 'openai-completions' },
            defaultModel: isAnthropicApi ? 'claude-sonnet-4-6' : 'gpt-4o',
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + custom endpoint via ${ctx.baseUrl}`
        }

        // Amazon Bedrock: IAM credential setup
        if (ctx.provider === 'amazon-bedrock') {
          const accessKeyId = process.env.AWS_ACCESS_KEY_ID
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
          const region = process.env.AWS_REGION || 'us-east-1'
          const sessionToken = process.env.AWS_SESSION_TOKEN
          if (!accessKeyId || !secretAccessKey) {
            return '0 connections (missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
          }
          const slug = 'amazon-bedrock-cli'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: 'Amazon Bedrock',
            providerType: 'pi',
            authType: 'iam_credentials',
            piAuthProvider: 'amazon-bedrock',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            piAuthProvider: 'amazon-bedrock',
            bedrockAuthMethod: 'iam_credentials',
            iamCredentials: { accessKeyId, secretAccessKey, sessionToken },
            awsRegion: region,
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + Bedrock IAM (${region})`
        }

        const provider = ctx.provider || 'anthropic'
        if (!shouldSetupLlmConnection(r?.length ?? 0, { provider, baseUrl: ctx.baseUrl ?? '' })) {
          return `${r.length} connections`
        }
        // Auto-setup from env / flags for the requested provider.
        let key = ''
        try {
          key = resolveApiKey(provider, ctx.apiKey || '')
        } catch (error) {
          return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
        }
        const slug = `${provider}-cli`
        const providerType = provider === 'anthropic' ? 'anthropic' : 'pi'
        const authType = 'api_key'
        await client.invoke('LLM_Connection:save', {
          slug,
          name: getProviderDisplayName(provider),
          providerType,
          authType,
          createdAt: Date.now(),
        })
        const setupPayload = provider === 'anthropic'
          ? { slug, credential: key }
          : { slug, credential: key, piAuthProvider: provider }
        const result = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
        if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
        await client.invoke('LLM_Connection:setDefault', slug)
        return `0 found → created ${provider} connection`
      },
    },
    {
      name: 'sources:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sources`
      },
    },
    {
      name: 'sessions:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const name = `__cli-validate-${Date.now()}`
        const r = (await client.invoke('sessions:create', ctx.workspaceId, {
          name,
          permissionMode: 'allow-all',
        })) as any
        ctx.createdSessionId = r?.id
        return ctx.createdSessionId ?? 'created'
      },
    },
    {
      name: 'sessions:getMessages',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:getMessages', ctx.createdSessionId)
        return 'session readable'
      },
    },
    {
      name: 'send message + stream',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Reply with exactly: VALIDATION_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'send message + tool use',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the Bash tool to run: echo TOOL_VALIDATION_OK', 90_000, true, undefined, ctx.onEvent)
      },
    },
    // ----- Session tool validation (guards against #511 regression) -----
    {
      name: 'labels:create (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('labels:create', ctx.workspaceId, {
          name: 'e2e-test',
          color: 'gray',
        })) as any
        ctx.e2eTestLabelId = r?.id
        return `label created: ${r?.id}`
      },
    },
    {
      name: 'session-tools:set_session_labels',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        if (!ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        const result = await waitForSendEvents(client, ctx.createdSessionId,
          'Use the set_session_labels tool to set labels: ["e2e-test"] on the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'set_session_labels')
        // Verify labels were actually applied
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        const session = sessions?.find((s: any) => s.id === ctx.createdSessionId)
        const labels: string[] = session?.labels ?? session?.labelIds ?? []
        const hasExpectedLabel = labels.some((label: string) =>
          label === ctx.e2eTestLabelId || label === 'e2e-test' || label.includes('e2e-test')
        )
        if (!hasExpectedLabel) throw new Error(`Expected e2e-test label, got: ${JSON.stringify(labels)}`)
        return `${result} — labels verified: ${JSON.stringify(labels)}`
      },
    },
    {
      name: 'session-tools:get_session_info',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the get_session_info tool to get info about the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'get_session_info')
      },
    },
    {
      name: 'session-tools:list_sessions',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the list_sessions tool to list all sessions. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'list_sessions')
      },
    },
    // ----- Session branching -----
    {
      name: 'sessions:branch',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session)'
        const r = (await client.invoke('sessions:getMessages', ctx.createdSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const firstAssistant = messages.find((m) => m.role === 'assistant') as any
        if (!firstAssistant?.id) throw new Error('No assistant message found to branch from')
        const branch = (await client.invoke('sessions:create', ctx.workspaceId, {
          name: `__cli-validate-branch-${Date.now()}`,
          permissionMode: 'allow-all',
          branchFromSessionId: ctx.createdSessionId,
          branchFromMessageId: firstAssistant.id,
        })) as any
        ctx.branchedSessionId = branch?.id
        return `branched at message ${firstAssistant.id} → session ${branch?.id}`
      },
    },
    {
      name: 'sessions:branch verify',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        const r = (await client.invoke('sessions:getMessages', ctx.branchedSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const hasAssistant = messages.some((m) => m.role === 'assistant')
        if (!hasAssistant) throw new Error('Branch missing assistant message')
        const origR = (await client.invoke('sessions:getMessages', ctx.createdSessionId!)) as ValidateMessagesResponse
        const origMessages = origR?.messages ?? origR?.conversation ?? []
        if (messages.length >= origMessages.length) {
          throw new Error(`Branch has ${messages.length} messages, expected fewer than original (${origMessages.length})`)
        }
        return `branch has ${messages.length} messages (original has ${origMessages.length})`
      },
    },
    {
      name: 'sessions:branch send',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        return await waitForSendEvents(client, ctx.branchedSessionId,
          'Reply with exactly: BRANCH_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Source lifecycle -----
    {
      name: 'sources:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:create', ctx.workspaceId, {
          name: 'Cat Facts',
          provider: 'catfact',
          type: 'api',
          api: { baseUrl: 'https://catfact.ninja', authType: 'none' },
          icon: '🐱',
        })) as any
        ctx.createdSourceSlug = r?.slug
        return ctx.createdSourceSlug ? `slug=${ctx.createdSourceSlug}` : JSON.stringify(r)
      },
    },
    {
      name: 'send + source mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSourceSlug) return 'skipped (no session or source)'
        // Enable the source on the session
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: [ctx.createdSourceSlug],
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:${ctx.createdSourceSlug}] Get me a cat fact`, 90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- MCP source validation (pre-committed in .github/agents/sources/) -----
    {
      name: 'mcp:kata-docs (auth:none)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        // Enable the pre-committed kata-docs MCP source on the session
        const enableSlugs = [ctx.createdSourceSlug, 'kata-docs'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:kata-docs] List the documents under the "KataAgents E2E Test" folder inside the "KataAgents" folder. Just list their names.`,
          180_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'mcp:stitch-mcp (header-auth)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        const apiKey = process.env.STITCH_API_KEY
        if (!apiKey) return 'skipped (no STITCH_API_KEY)'
        // Inject credential into store (multi-header JSON format, same as API headerNames)
        await client.invoke('sources:saveCredentials', ctx.workspaceId, 'stitch-mcp', JSON.stringify({ 'X-Goog-Api-Key': apiKey }))
        // Enable stitch-mcp + existing sources on session
        const enableSlugs = [ctx.createdSourceSlug, 'kata-docs', 'stitch-mcp'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the source_test tool to test the stitch-mcp source. Report the result.`,
          90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Skill lifecycle -----
    {
      name: 'send + skill create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        ctx.createdSkillSlug = '__cli-validate-skill'
        const sourceSlug = ctx.createdSourceSlug ?? 'cat-facts'
        const skillDir = `${ctx.workspaceRootPath}/skills/${ctx.createdSkillSlug}`
        // Use bash to create the skill file deterministically
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the Bash tool to run this exact command:
mkdir -p "${skillDir}" && cat > "${skillDir}/SKILL.md" << 'SKILLEOF'
---
name: "CLI Validate Skill"
description: "Validation skill created by kata-agents-cli"
requiredSources:
  - "${sourceSlug}"
---

This skill does two things:
1. Check the current water temperature of Lake Balaton (search the web or estimate based on the season)
2. Use the Cat Facts source to get a random cat fact

Always perform both steps when this skill is invoked.
SKILLEOF`, 90_000, true, undefined, ctx.onEvent)
      },
    },
    {
      name: 'skills:get (verify)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        const r = (await client.invoke('skills:get', ctx.workspaceId)) as any[]
        const found = r?.find((s: any) => s.slug === ctx.createdSkillSlug)
        if (!found) throw new Error(`Skill '${ctx.createdSkillSlug}' not found in skills list`)
        return `found: ${found.name ?? found.slug}`
      },
    },
    {
      name: 'send + skill mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSkillSlug) return 'skipped (no session or skill)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[skill:${ctx.createdSkillSlug}] Run the skill`, 120_000, false,
          { skillSlugs: [ctx.createdSkillSlug] }, ctx.onEvent)
      },
    },
    {
      name: 'skills:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        await client.invoke('skills:delete', ctx.workspaceId, ctx.createdSkillSlug)
        return `deleted skill: ${ctx.createdSkillSlug}`
      },
    },
    // ----- Automation lifecycle -----
    {
      name: 'automation:create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        const configPath = `${ctx.workspaceRootPath}/automations.json`
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
        const { readFile, writeFile } = await import('fs/promises')

        // Always backup + overwrite with deterministic validation config,
        // then restore during cleanup.
        const existingConfig = await readFile(configPath, 'utf-8').catch(() => null)
        ctx.automationsJsonBackup = existingConfig
        ctx.automationsHistoryBackup = await readFile(historyPath, 'utf-8').catch(() => null)

        const templatePath = `${process.cwd()}/.github/agents/automations.json`
        const templateConfig = await readFile(templatePath, 'utf-8').catch(() => null)
        if (!templateConfig) {
          throw new Error(`Missing automation template at ${templatePath}`)
        }

        const parsed = JSON.parse(templateConfig) as {
          automations?: { SessionStatusChange?: Array<{ name?: string }> }
        }
        const entries = parsed?.automations?.SessionStatusChange
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error('Automation template missing automations.SessionStatusChange entries')
        }

        const blocked = entries.find((e) => e.name === 'CLI Validate Condition Blocked')
        const pass = entries.find((e) => e.name === 'CLI Validate Condition Pass')
        if (!blocked?.name || !pass?.name) {
          throw new Error('Automation template must define both "CLI Validate Condition Blocked" and "CLI Validate Condition Pass"')
        }

        ctx.automationBlockedName = blocked.name
        ctx.automationName = pass.name

        await writeFile(configPath, templateConfig)
        ctx.createdAutomation = true
        // ConfigWatcher auto-detects automations.json changes (debounced)
        await new Promise((r) => setTimeout(r, 2000))
        return `wrote config from template (blocked=${ctx.automationBlockedName}, pass=${ctx.automationName})`
      },
    },
    {
      name: 'automation:trigger (status change)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session or workspace)'
        // Get available statuses to find one containing "in-progress"
        const statuses = (await client.invoke('statuses:list', ctx.workspaceId)) as ValidateStatus[]
        const inProgress = statuses?.find((s) =>
          (s.id ?? '').toLowerCase().includes('in-progress') ||
          (s.label ?? '').toLowerCase().includes('in progress')
        )
        const statusValue = inProgress?.id ?? 'in-progress'

        // Change session status to trigger the automations
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSessionStatus',
          state: statusValue,
        })

        // Poll for expected automation behavior:
        // - pass automation MUST create a session
        // - blocked automation MUST NOT create a session
        let delay = 1000
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
          const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]

          const blockedSession = sessions?.find((s) =>
            s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
          )
          if (blockedSession) {
            ctx.automationBlockedSessionId = blockedSession.id
            throw new Error(`Blocked automation unexpectedly triggered (session=${blockedSession.id})`)
          }

          const passSession = sessions?.find((s) =>
            s.name === ctx.automationName && s.id !== ctx.createdSessionId
          )
          if (passSession) {
            ctx.automationTestSessionId = passSession.id

            // Guard against delayed blocked-automation session creation.
            await new Promise((r) => setTimeout(r, 2000))
            const sessionsAfter = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
            const blockedAfter = sessionsAfter?.find((s) =>
              s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
            )
            if (blockedAfter) {
              ctx.automationBlockedSessionId = blockedAfter.id
              throw new Error(`Blocked automation unexpectedly triggered after delay (session=${blockedAfter.id})`)
            }

            return `pass triggered → session ${passSession.id}; blocked automation did not trigger (status=${statusValue})`
          }
        }
        throw new Error('Passing automation-created session not found within 60s')
      },
    },
    {
      name: 'automation:verify session',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId) return 'skipped (no automation session)'
        // Wait for the automation session to complete
        let delay = 1000
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const session = (await client.invoke('sessions:getMessages', ctx.automationTestSessionId)) as ValidateMessagesResponse
          const messages = session?.messages ?? session?.conversation ?? []
          const hasAssistant = messages.some((m) => m.role === 'assistant')
          if (hasAssistant) {
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
            const text = typeof lastAssistant?.content === 'string'
              ? lastAssistant.content
              : Array.isArray(lastAssistant?.content)
                ? lastAssistant.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
                : ''
            return `session has assistant response (${text.slice(0, 80).trim()})`
          }
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
        }
        throw new Error('Automation session did not complete within 90s')
      },
    },
    {
      name: 'automation:verify labels',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId || !ctx.workspaceId) return 'skipped (no automation session)'
        // Verify label was auto-created
        const labels = (await client.invoke('labels:list', ctx.workspaceId)) as ValidateLabel[]
        const found = labels?.find((l) => l.id === 'cli-validate-label' || l.name === 'cli-validate-label')
        if (!found) throw new Error('Label cli-validate-label was not auto-created')
        ctx.createdLabelId = found.id ?? 'cli-validate-label'

        // Verify the automation session has the label
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        const automationSession = sessions?.find((s) => s.id === ctx.automationTestSessionId)
        const sessionLabels: string[] = automationSession?.labels ?? []
        const hasLabel = sessionLabels.some((l: string) => l.includes('cli-validate-label'))
        if (!hasLabel) throw new Error(`Automation session missing label (has: ${sessionLabels.join(', ')})`)
        return `label created and assigned: ${ctx.createdLabelId}`
      },
    },
    {
      name: 'automations:getLastExecuted',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const history = (await client.invoke('automations:getLastExecuted', ctx.workspaceId)) as Record<string, number>
        const entries = Object.entries(history)
        if (entries.length === 0) throw new Error('No automation execution history found')
        // Verify at least one automation ran recently (within last 2 minutes)
        const recentThreshold = Date.now() - 120_000
        const recent = entries.find(([, ts]) => ts > recentThreshold)
        if (!recent) throw new Error(`No recent automation execution (latest: ${Math.max(...entries.map(([, ts]) => ts))})`)
        return `${entries.length} automation(s), latest ran ${Math.round((Date.now() - recent[1]) / 1000)}s ago`
      },
    },
    // ----- Webhook validation -----
    {
      name: 'webhook:test (RPC)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('automations:test', {
          workspaceId: ctx.workspaceId,
          actions: [{
            type: 'webhook',
            url: 'http://127.0.0.1:19999/validate-test',
            method: 'GET',
          }],
        })) as any
        const result = r?.actions?.[0]
        if (result?.success) throw new Error('Expected webhook to fail (nothing listening)')
        if (!result?.error && result?.statusCode !== 0) throw new Error('Expected error or statusCode 0 in result')
        return `correctly failed: ${(result.error ?? `statusCode=${result.statusCode}`).slice(0, 80)}`
      },
    },
    {
      name: 'webhook:verify failure',
      fn: async (client, ctx) => {
        if (!ctx.workspaceRootPath) return 'skipped (no workspace root)'
        const { readFile } = await import('fs/promises')
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`

        const start = Date.now()
        const deadline = start + 15_000
        let delay = 200

        let lastLineCount = 0
        let lastWebhookCount = 0
        let lastSummary = 'no entries'

        while (Date.now() < deadline) {
          const content = await readFile(historyPath, 'utf-8').catch(() => '')
          const lines = content.trim().split('\n').filter(Boolean)
          lastLineCount = lines.length

          const entries = lines
            .map((l) => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(Boolean) as Array<Record<string, unknown>>

          const webhookEntries = entries.filter((e) => !!e.webhook)
          lastWebhookCount = webhookEntries.length

          if (webhookEntries.length > 0) {
            const recentThreshold = Date.now() - 120_000
            const recentFailed = webhookEntries.find((e: any) =>
              !e.ok && e.ts > recentThreshold && e.webhook?.method === 'POST'
            ) as any
            if (recentFailed) {
              return `webhook failure recorded: method=${recentFailed.webhook.method}, url=${recentFailed.webhook.url?.slice(0, 50)}`
            }

            const latest = webhookEntries[webhookEntries.length - 1] as any
            lastSummary = `latest: ok=${String(latest?.ok)} method=${String(latest?.webhook?.method ?? 'n/a')} ts=${String(latest?.ts ?? 'n/a')}`
          }

          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }

        const waitedMs = Date.now() - start
        throw new Error(
          `No recent failed POST webhook history entry after ${waitedMs}ms (lines=${lastLineCount}, webhookEntries=${lastWebhookCount}, ${lastSummary})`,
        )
      },
    },
    {
      name: 'automation:cleanup',
      fn: async (client, ctx) => {
        const cleaned = await cleanupAutomationArtifacts(client, ctx)
        return cleaned.length > 0 ? `cleaned: ${cleaned.join(', ')}` : 'nothing to clean'
      },
    },
    {
      name: 'sessions:branch delete',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        await client.invoke('sessions:delete', ctx.branchedSessionId)
        const id = ctx.branchedSessionId
        ctx.branchedSessionId = undefined
        return `deleted branch session: ${id}`
      },
    },
    {
      name: 'sources:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSourceSlug) return 'skipped (no source)'
        await client.invoke('sources:delete', ctx.workspaceId, ctx.createdSourceSlug)
        return `deleted source: ${ctx.createdSourceSlug}`
      },
    },
    {
      name: 'labels:delete (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        await client.invoke('labels:delete', ctx.workspaceId, ctx.e2eTestLabelId)
        return `deleted label: ${ctx.e2eTestLabelId}`
      },
    },
    {
      name: 'sessions:delete',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:delete', ctx.createdSessionId)
        return `deleted session: ${ctx.createdSessionId}`
      },
    },
    {
      name: 'Disconnect',
      fn: async (client) => {
        client.destroy()
        return 'OK'
      },
    },
  ]
}

export async function runValidation(
  client: CliRpcClient,
  jsonMode: boolean,
  noSpinner?: boolean,
  workspaceDir?: string,
  validateOptions?: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<number> {
  const steps = getValidateSteps()
  const total = steps.length
  const ctx: ValidateContext = {
    workspaceDir,
    baseUrl: validateOptions?.baseUrl,
    apiKey: validateOptions?.apiKey,
    provider: validateOptions?.provider,
  }
  let passed = 0
  let failed = 0
  const results: Array<{ step: string; status: string; detail: string; elapsed: number }> = []
  const totalStart = performance.now()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const num = `[${i + 1}/${total}]`
    const plainLen = num.length + 1 + step.name.length

    // Spinner + live event printer
    // Spinner keeps running until the agent produces real output (text_delta/tool_start).
    // Early events (user_message, connection_changed, usage_update) are buffered or ignored
    // so the spinner stays visible while the agent is thinking.
    let spinner: { stop(): void } | undefined
    if (!jsonMode) {
      let headerPrinted = false
      let accText = ''
      let textFlushed = false
      let bufferedPrompt = ''

      if (useColor && !noSpinner) {
        spinner = createSpinner(`${c.cyan(num)} ${step.name}`)
      }

      const flushText = () => {
        if (textFlushed || !accText) return
        const clean = accText.replace(/\n/g, ' ').trim()
        if (!clean) return
        const display = clean.length > 120 ? clean.slice(0, 120) + '…' : clean
        process.stdout.write(`    ${c.dim('↳')} ${c.yellow(display)}\n`)
        textFlushed = true
      }

      const ensureHeader = () => {
        if (headerPrinted) return
        spinner?.stop()
        process.stdout.write(`${c.cyan(num)} ${step.name}\n`)
        if (bufferedPrompt) {
          process.stdout.write(`    ${c.dim('→')} ${c.blue(`"${bufferedPrompt}"`)}\n`)
        }
        headerPrinted = true
      }

      ctx.onEvent = (ev) => {
        switch (ev.type) {
          // Buffer prompt — shown when agent starts responding
          case 'user_message': {
            const msg = ev.message as any
            let text = ''
            if (typeof msg?.content === 'string') {
              text = msg.content
            } else if (Array.isArray(msg?.content)) {
              text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            }
            const clean = text.replace(/\n/g, ' ').trim()
            bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
            break
          }
          // Agent text — stop spinner, show header + prompt + text
          case 'text_delta':
            ensureHeader()
            accText += String(ev.delta ?? '')
            if (!textFlushed && accText.length > 40) flushText()
            break
          case 'text_complete':
            ensureHeader()
            flushText()
            break
          // Tool use — stop spinner, show header + prompt + tool
          case 'tool_start': {
            ensureHeader()
            flushText()
            const name = String(ev.toolName ?? '?')
            const intent = ev.toolIntent ? ` — "${ev.toolIntent}"` : ''
            process.stdout.write(`    ${c.dim('↳')} ${c.dim(`tool: ${name}${intent}`)}\n`)
            accText = ''
            textFlushed = false
            break
          }
          // Ignore internal events (connection_changed, usage_update, etc.)
        }
      }
    } else {
      ctx.onEvent = undefined
    }

    const stepStart = performance.now()
    try {
      const detail = await step.fn(client, ctx)
      const elapsed = (performance.now() - stepStart) / 1000
      passed++
      results.push({ step: step.name, status: 'OK', detail, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stdout.write(`${c.cyan(num)} ${step.name} ${dots} ${c.green('✓')}  ${detail}  ${time}\n`)
      }
    } catch (e) {
      const elapsed = (performance.now() - stepStart) / 1000
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ step: step.name, status: 'FAIL', detail: msg, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stderr.write(`${c.cyan(num)} ${step.name} ${dots} ${c.red('✗')}  ${msg}  ${time}\n`)
      }
    }
  }

  // Cleanup: branched session
  if (ctx.branchedSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.branchedSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: if a session was created but delete step hasn't run or failed
  if (ctx.createdSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.createdSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: automation artifacts
  await cleanupAutomationArtifacts(client, ctx)

  // Cleanup: if we auto-created a temp workspace, remove it
  if (ctx.createdWorkspace && ctx.workspaceId && client.isConnected) {
    try {
      await client.invoke('workspaces:delete', ctx.workspaceId)
    } catch {
      // best effort
    }
    if (ctx.workspaceRootPath) {
      try {
        const { rm } = await import('fs/promises')
        await rm(ctx.workspaceRootPath, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1)

  if (jsonMode) {
    out({ total, passed, failed, results, elapsedSeconds: parseFloat(totalSec) }, true)
  } else {
    if (failed === 0) {
      process.stdout.write(`\n${c.green(`✓ ${passed}/${total} passed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    } else {
      process.stdout.write(`\n${c.red(`✗ ${passed}/${total} passed, ${failed} failed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    }
  }

  return failed > 0 ? 1 : 0
}
