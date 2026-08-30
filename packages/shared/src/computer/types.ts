export type ComputerId = string & { readonly __brand: 'ComputerId' }
export type DisplayId = string & { readonly __brand: 'DisplayId' }
export type ProfileId = string & { readonly __brand: 'ProfileId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type LayoutVersion = number & { readonly __brand: 'LayoutVersion' }
export type ShutdownEpoch = number & { readonly __brand: 'ShutdownEpoch' }

export const CURRENT_LAYOUT_VERSION = 1 as LayoutVersion

export const CLIENT_BROWSER_INVOKE_CAPABILITY = 'client:browser:invoke'

export type ComputerKind = 'local-client' | 'self-hosted-headless'

export type ComputerIdentity = Readonly<{
  computerId: ComputerId
  kind: ComputerKind
  dataRoot: string
  osAccount: string
  createdAt: string
}>

export type ComputerIdentityPublic = Readonly<{
  kind: ComputerKind
  computerId: ComputerId
  dataRootVersion: LayoutVersion
}>

export type DataRootLayout = Readonly<{
  version: LayoutVersion
  root: string
  manifestPath: string
  recordPath: string
  shutdownDir: string
  migrationLockPath: string
  runtimeLockPath: string
  configPath: string
  credentialsPath: string
  worktreesDir: string
  workspacesDir: string
  browserProfilesDir: string
  browserDisplaysDir: string
  browserLocksDir: string
}>

export type LayoutOpenResult =
  | { tag: 'opened'; layout: DataRootLayout; created: boolean; computerId: ComputerId }
  | { tag: 'corrupt'; reason: string; path: string }
  | { tag: 'incompatible'; found: LayoutVersion; supported: LayoutVersion[] }

export type VirtualDisplay = Readonly<{
  displayId: DisplayId
  computerId: ComputerId
  width: number
  height: number
  boundProfileId: ProfileId | null
  boundSessionId: SessionId | null
  persistedAt: string
}>

export type IdleBrowserProfile = Readonly<{
  profileId: ProfileId
  computerId: ComputerId
  userDataDir: string
  writer: { tag: 'none' }
}>

export type LeasedBrowserProfile = Readonly<{
  profileId: ProfileId
  computerId: ComputerId
  userDataDir: string
  writer: {
    tag: 'leased'
    sessionId: SessionId
    leaseToken: string
    displayId: DisplayId
    acquiredAt: string
  }
}>

export type BrowserProfile = IdleBrowserProfile | LeasedBrowserProfile

export type ProfileHandoffMode = 'lease-transfer' | 'snapshot-clone'

export type ProfileHandoffRequest = Readonly<{
  profileId: ProfileId
  fromSessionId: SessionId
  toSessionId: SessionId
  mode: ProfileHandoffMode
}>

export type DimensionStatus =
  | { tag: 'ready' }
  | { tag: 'degraded'; reason: string }
  | { tag: 'failed'; reason: string }

export type ComputerReadiness = Readonly<{
  process: DimensionStatus
  storage: DimensionStatus
  browser: DimensionStatus
  checkedAt: string
}>

export type ShutdownWorkKind = 'checkpointed' | 'interrupted' | 'uncertain'

export type ShutdownWorkItem = Readonly<{
  kind: ShutdownWorkKind
  domain: 'session' | 'browser-profile' | 'journal' | 'worktree'
  ref: string
  detail?: string
}>

export type RecoveryDisposition =
  | { sessionId: string; action: 'resume'; from: 'checkpointed' }
  | { sessionId: string; action: 'surface'; from: 'interrupted' | 'uncertain' }

export type ComputerRpcConfig = Readonly<{
  host: string
  port: number
  token: string
  tls: Readonly<{ certPath: string; keyPath: string; caPath?: string }> | null
  allowInsecurePublicBind: boolean
}>

export type ComputerConfig = Readonly<{
  kind: ComputerKind
  dataRoot: string
  packaged: boolean
  rpc: ComputerRpcConfig
  healthPort: number
  appVersion: string
  chromiumPath: string | null
}>

export type ComputerConfigErrorCode =
  | 'missing-data-root'
  | 'missing-token'
  | 'tls-incomplete'
  | 'insecure-public-bind'
  | 'packaged-insecure-bind'
  | 'weak-token'
  | 'invalid-port'

export class ComputerConfigError extends Error {
  readonly code: ComputerConfigErrorCode

  constructor(code: ComputerConfigErrorCode, message: string) {
    super(message)
    this.name = 'ComputerConfigError'
    this.code = code
  }
}

export function brandComputerId(value: string): ComputerId {
  if (value.length === 0) throw new Error('computer id must be non-empty')
  return value as ComputerId
}

export function brandDisplayId(value: string): DisplayId {
  if (value.length === 0) throw new Error('display id must be non-empty')
  return value as DisplayId
}

export function brandProfileId(value: string): ProfileId {
  if (value.length === 0) throw new Error('profile id must be non-empty')
  return value as ProfileId
}

export const DEFAULT_BROWSER_PROFILE_ID = brandProfileId('default')

export function brandSessionId(value: string): SessionId {
  if (value.length === 0) throw new Error('session id must be non-empty')
  return value as SessionId
}

export function brandLayoutVersion(value: number): LayoutVersion {
  if (!Number.isInteger(value)) throw new Error('layout version must be an integer')
  return value as LayoutVersion
}

export function brandShutdownEpoch(value: number): ShutdownEpoch {
  if (!Number.isInteger(value) || value < 0) throw new Error('shutdown epoch must be a non-negative integer')
  return value as ShutdownEpoch
}
