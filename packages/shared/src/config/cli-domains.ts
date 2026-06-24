export type CliDomainNamespace = 'label' | 'source' | 'skill' | 'automation' | 'permission' | 'theme'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  workspacePathScopes: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  label: {
    namespace: 'label',
    workspacePathScopes: ['labels/**'],
    bashGuardPaths: ['labels/**'],
  },
  source: {
    namespace: 'source',
    workspacePathScopes: ['sources/**'],
  },
  skill: {
    namespace: 'skill',
    workspacePathScopes: ['skills/**'],
  },
  automation: {
    namespace: 'automation',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by config domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const KATA_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const KATA_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for config-domain owned paths.
 */
export const KATA_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const KATA_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

const READ_ONLY_INVOKE_CHANNELS = [
  'labels:list',
  'sources:get',
  'sources:getPermissions',
  'skills:get',
  'automations:get',
  'automations:getHistory',
  'automations:getLastExecuted',
  'workspace:getPermissions',
  'permissions:getDefaults',
  'workspaceSettings:get',
  'system:homeDir',
] as const

/**
 * Derive the canonical Explore-mode read-only kata-agents-cli invoke patterns.
 * Keeps permissions regexes aligned with allowed RPC channels.
 */
export function getAgentsCliReadOnlyInvokeBashPatterns(): BashPatternRule[] {
  const channelAlternation = READ_ONLY_INVOKE_CHANNELS.join('|')

  return [
    {
      pattern: `^kata-agents-cli\\s+invoke\\s+(${channelAlternation})\\b`,
      comment: 'kata-agents-cli invoke read-only RPC channels',
    },
    {
      pattern: '^kata-agents-cli\\s+--help\\b',
      comment: 'kata-agents-cli help',
    },
  ]
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
