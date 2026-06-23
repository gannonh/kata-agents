/**
 * Centralized path configuration for Kata Agent.
 *
 * Supports multi-instance development via KATA_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., craft-tui-agent-1), the detect-instance.sh
 * script sets KATA_CONFIG_DIR to ~/.kata-agents-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.kata-agents/
 * Instance 1 (-1 suffix): ~/.kata-agents-1/
 * Instance 2 (-2 suffix): ~/.kata-agents-2/
 */

import { homedir } from 'os';
import { join } from 'path';

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.kata-agents/ for production and non-numbered dev folders
export const CONFIG_DIR = process.env.KATA_CONFIG_DIR || join(homedir(), '.kata-agents');
