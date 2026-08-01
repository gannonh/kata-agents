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

/**
 * Runtime-evaluated check for developer feedback feature.
 * Explicit env override has precedence over dev-runtime defaults.
 */
export function isDeveloperFeedbackEnabled(): boolean {
  const override = parseBooleanEnv(getFeatureFlagEnv('KATA_FEATURE_DEVELOPER_FEEDBACK'));
  if (override !== undefined) return override;
  return isDevRuntime();
}

/**
 * Runtime-evaluated check for embedded server settings page.
 *
 * Defaults to disabled. Override with KATA_FEATURE_EMBEDDED_SERVER=1|0.
 */
export function isEmbeddedServerEnabled(): boolean {
  const override = parseBooleanEnv(getFeatureFlagEnv('KATA_FEATURE_EMBEDDED_SERVER'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for the Git/GitHub V1 managed-worktree workspace feature.
 *
 * Gates the complete user-facing Git workspace feature (composer Workspace/ref
 * controls, managed worktrees, checkout preparation, and Git mutation handlers).
 * Defaults to disabled in stable and nightly. Override with
 * KATA_FEATURE_GIT_WORKSPACE_V1=1|0. Server mutation handlers reject
 * feature-only operations while this flag is disabled so renderer/server state
 * cannot drift.
 */
export function isGitWorkspaceV1Enabled(): boolean {
  const override = parseBooleanEnv(getFeatureFlagEnv('KATA_FEATURE_GIT_WORKSPACE_V1'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for online session sharing.
 *
 * Defaults to disabled. Override with KATA_FEATURE_SHARE_ONLINE=1|0.
 */
export function isShareOnlineEnabled(): boolean {
  const override = parseBooleanEnv(getFeatureFlagEnv('KATA_FEATURE_SHARE_ONLINE'));
  if (override !== undefined) return override;
  return false;
}

export const FEATURE_FLAGS = {
  /** Enable Opus 4.7 fast mode (speed:"fast" + beta header). 6x pricing. */
  fastMode: false,
  /**
   * Enable agent developer feedback tool.
   *
   * Defaults to enabled in explicit development runtimes; disabled otherwise.
   * Override with KATA_FEATURE_DEVELOPER_FEEDBACK=1|0.
   */
  get developerFeedback(): boolean {
    return isDeveloperFeedbackEnabled();
  },
  /**
   * Enable embedded server settings page.
   *
   * Defaults to disabled. Override with KATA_FEATURE_EMBEDDED_SERVER=1|0.
   */
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
  /**
   * Enable the Git/GitHub V1 managed-worktree workspace feature.
   *
   * Defaults to disabled. Override with KATA_FEATURE_GIT_WORKSPACE_V1=1|0.
   */
  get gitWorkspaceV1(): boolean {
    return isGitWorkspaceV1Enabled();
  },
  /**
   * Enable online session sharing.
   *
   * Defaults to disabled. Override with KATA_FEATURE_SHARE_ONLINE=1|0.
   */
  get shareOnline(): boolean {
    return isShareOnlineEnabled();
  },
} as const;
