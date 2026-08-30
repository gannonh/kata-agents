/** Playwright grep tags for local E2E filtering. */
export const E2E_TAGS = {
  smoke: "@smoke",
  settings: "@settings",
  browser: "@browser",
  agent: "@agent",
  bots: "@bots",
  memory: "@memory",
  handoffs: "@handoffs",
  channels: "@channels",
  oauth: "@oauth",
  approvals: "@approvals",
  /** Serial Git/GitHub V1 flows, including the authenticated UAT repository path. */
  git: "@git",
  /** Offline Worktree V2 identity/root parity flows. */
  worktreeV2: "@worktree-v2",
  /** Self-hosted headless computer with a thin Electron client. */
  computerHeadless: "@computer-headless",
} as const;

export type E2ETag = (typeof E2E_TAGS)[keyof typeof E2E_TAGS];
