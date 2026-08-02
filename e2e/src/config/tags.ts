/** Playwright grep tags for local E2E filtering. */
export const E2E_TAGS = {
  smoke: "@smoke",
  settings: "@settings",
  agent: "@agent",
  oauth: "@oauth",
  /** Serial Git/GitHub V1 flows, including the authenticated UAT repository path. */
  git: "@git",
} as const;

export type E2ETag = (typeof E2E_TAGS)[keyof typeof E2E_TAGS];
