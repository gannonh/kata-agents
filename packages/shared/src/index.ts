/**
 * @kata-sh/shared
 *
 * Shared business logic for Kata Agent.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { ClaudeAgent } from '@kata-sh/shared/agent';
 *   import { loadStoredConfig } from '@kata-sh/shared/config';
 *   import { getCredentialManager } from '@kata-sh/shared/credentials';
 *   import { CraftMcpClient } from '@kata-sh/shared/mcp';
 *   import { debug } from '@kata-sh/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@kata-sh/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@kata-sh/shared/workspaces';
 *
 * Available modules:
 *   - agent: ClaudeAgent SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Craft API client
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
