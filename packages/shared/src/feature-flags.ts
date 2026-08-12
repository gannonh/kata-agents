/**
 * Feature flags for controlling experimental or in-development features.
 */

declare global {
  // Optional renderer/build-time bridge for non-Vite contexts or code that cannot
  // safely read Node's process.env. Vite/Electron can inject this object via
  // `define`, and tests can set it directly on globalThis.
  // eslint-disable-next-line no-var
  var __KATA_FEATURE_FLAGS__: Record<string, string | undefined> | undefined;
}

/** Safe accessor for process.env — returns undefined in browser/renderer contexts. */
function getProcessEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) return process.env[key];
  return undefined;
}

/** Safe accessor for Vite renderer env (`import.meta.env`). */
function getImportMetaEnv(key: string): string | undefined {
  try {
    const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
    return meta.env?.[key];
  } catch {
    return undefined;
  }
}

/** Safe accessor for explicitly injected globals. */
function getInjectedGlobalEnv(key: string): string | undefined {
  return globalThis.__KATA_FEATURE_FLAGS__?.[key];
}

/**
 * Read a feature flag/environment value across all supported runtimes.
 *
 * Precedence:
 * 1. Node process.env — main process, server, tests, subprocesses
 * 2. Vite import.meta.env — renderer/browser bundles when explicitly exposed
 * 3. Injected global — renderer/browser bundles via build-time `define`
 */
export function getFeatureFlagEnv(key: string): string | undefined {
  return getProcessEnv(key) ?? getImportMetaEnv(key) ?? getInjectedGlobalEnv(key);
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Shared runtime detector for development/debug environments.
 *
 * Use this instead of app-specific debug flags (e.g., Electron main isDebugMode)
 * so behavior stays consistent across shared code and subprocess backends.
 */
export function isDevRuntime(): boolean {
  const nodeEnv = (getFeatureFlagEnv('NODE_ENV') || '').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'dev' || getFeatureFlagEnv('KATA_DEBUG') === '1';
}

type FeatureFlagDefault = boolean | (() => boolean);

/**
 * The single source of truth for feature defaults and their environment overrides.
 * Environment values take precedence over these defaults at runtime.
 */
export const FEATURE_FLAG_CONFIG = {
  fastMode: {
    env: 'KATA_FEATURE_FAST_MODE',
    default: false,
  },
  developerFeedback: {
    env: 'KATA_FEATURE_DEVELOPER_FEEDBACK',
    default: () => isDevRuntime(),
  },
  embeddedServer: {
    env: 'KATA_FEATURE_EMBEDDED_SERVER',
    default: true,
  },
  gitWorkspaceV1: {
    env: 'KATA_FEATURE_GIT_WORKSPACE_V1',
    default: true,
  },
  worktreeV2: {
    env: 'KATA_FEATURE_WORKTREE_V2',
    default: true,
  },
  shareOnline: {
    env: 'KATA_FEATURE_SHARE_ONLINE',
    default: false,
  },
} satisfies Record<string, { env: string; default: FeatureFlagDefault }>;

function resolveFeatureFlag(name: keyof typeof FEATURE_FLAG_CONFIG): boolean {
  const definition = FEATURE_FLAG_CONFIG[name];
  const override = parseBooleanEnv(getFeatureFlagEnv(definition.env));
  if (override !== undefined) return override;
  return typeof definition.default === 'function'
    ? definition.default()
    : definition.default;
}

/** Runtime-evaluated check for the developer feedback feature. */
export function isDeveloperFeedbackEnabled(): boolean {
  return resolveFeatureFlag('developerFeedback');
}

/** Runtime-evaluated check for the embedded server settings page. */
export function isEmbeddedServerEnabled(): boolean {
  return resolveFeatureFlag('embeddedServer');
}

/** Runtime-evaluated check for the Git/GitHub V1 managed-worktree feature. */
export function isGitWorkspaceV1Enabled(): boolean {
  return resolveFeatureFlag('gitWorkspaceV1');
}

/**
 * Runtime-evaluated check for the Git worktree V2 feature.
 *
 * V2 is deliberately dependent on V1 so disabling the existing managed-worktree
 * feature also disables every V2 control and route, regardless of the V2
 * override. This keeps the V1 gate as the single ownership boundary.
 */
export function isWorktreeV2Enabled(): boolean {
  return isGitWorkspaceV1Enabled() && resolveFeatureFlag('worktreeV2')
}

/** Runtime-evaluated check for online session sharing. */
export function isShareOnlineEnabled(): boolean {
  return resolveFeatureFlag('shareOnline');
}

export const FEATURE_FLAGS = {
  /** Enable Opus 4.7 fast mode (speed:"fast" + beta header). 6x pricing. */
  get fastMode(): boolean {
    return resolveFeatureFlag('fastMode');
  },
  get developerFeedback(): boolean {
    return isDeveloperFeedbackEnabled();
  },
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
  get gitWorkspaceV1(): boolean {
    return isGitWorkspaceV1Enabled();
  },
  get worktreeV2(): boolean {
    return isWorktreeV2Enabled();
  },
  get shareOnline(): boolean {
    return isShareOnlineEnabled();
  },
} as const;
