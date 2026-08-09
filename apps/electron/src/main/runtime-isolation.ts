import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DEV_CONFIG_DIR = join(homedir(), '.kata-agents-dev')

/**
 * Development launches use separate persistent state so their embedded server
 * cannot contend with an installed Kata Agents instance. Explicit config-dir
 * overrides remain authoritative for E2E and numbered worktree launches.
 */
export const isDevelopmentRuntime = !app.isPackaged || process.env.KATA_DEV_RUNTIME === '1'

const configDir = process.env.KATA_CONFIG_DIR || (isDevelopmentRuntime ? DEFAULT_DEV_CONFIG_DIR : undefined)
if (configDir) {
  process.env.KATA_CONFIG_DIR = configDir
}

if (isDevelopmentRuntime) {
  // Electron's instance lock is scoped by userData. Source development skips
  // that lock; packaged development retains it in this isolated scope so its
  // second-instance deep-link forwarding still works beside a release build.
  app.setPath('userData', join(configDir ?? DEFAULT_DEV_CONFIG_DIR, 'electron'))
}
