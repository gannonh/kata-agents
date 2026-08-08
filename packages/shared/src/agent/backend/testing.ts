/**
 * Test-only deterministic provider adapters.
 *
 * These factories simulate provider capabilities so unit and state-machine
 * tests can run credential-free. They are NOT provider implementations and
 * MUST NEVER be wired into production code paths — no env-var seam, no
 * SessionManager wiring, no renderer path. Production provider backends
 * implement the real capabilities (ExecutionCwdRebindCapability /
 * StrictConversationForkCapability) and stay disabled until credentialed UAT
 * proves them. Import only from test files via `@kata-sh/shared/agent/testing`.
 */

export {
  createDeterministicHandoffAdapter,
  type DeterministicHandoffAdapterOptions,
} from './deterministic-handoff-adapter.ts';

export {
  createDeterministicStrictForkAdapter,
  type DeterministicStrictForkAdapterOptions,
} from './deterministic-fork-adapter.ts';
