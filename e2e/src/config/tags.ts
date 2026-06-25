/** Playwright grep tags for local E2E filtering. */
export const E2E_TAGS = {
  smoke: "@smoke",
  settings: "@settings",
  agent: "@agent",
} as const;

export type E2ETag = (typeof E2E_TAGS)[keyof typeof E2E_TAGS];
