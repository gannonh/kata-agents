function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Shared local E2E timeout budget. Override individual knobs via KATA_E2E_* env vars. */
export const E2E_TIMEOUTS = {
  devStackMs: readPositiveIntEnv("KATA_E2E_DEV_STACK_TIMEOUT_MS", 30_000),
  electronWindowMs: readPositiveIntEnv("KATA_E2E_ELECTRON_WINDOW_TIMEOUT_MS", 30_000),
  testMs: readPositiveIntEnv("KATA_E2E_TEST_TIMEOUT_MS", 90_000),
  agentTestMs: readPositiveIntEnv("KATA_E2E_AGENT_TEST_TIMEOUT_MS", 150_000),
  assertionMs: readPositiveIntEnv("KATA_E2E_ASSERTION_TIMEOUT_MS", 10_000),
  authMs: readPositiveIntEnv("KATA_E2E_AUTH_TIMEOUT_MS", 15_000),
  agentReplyMs: readPositiveIntEnv("KATA_E2E_AGENT_REPLY_TIMEOUT_MS", 60_000),
} as const;
