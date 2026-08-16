export { SessionManager, setSessionPlatform, setSessionRuntimeHooks, sanitizeForTitle, AGENT_FLAGS } from './SessionManager'
export type { SessionManagerOptions } from './SessionManager'
export {
  SpawnTaskCoordinator,
  SpawnTaskCreationError,
} from './spawn-task-coordinator'
export type {
  SpawnTaskCoordinatorOptions,
  SpawnTaskCreateChildInput,
  SpawnTaskAppendPromptInput,
  SpawnTaskDispatchInput,
  SpawnTaskSpawnInput,
} from './spawn-task-coordinator'
