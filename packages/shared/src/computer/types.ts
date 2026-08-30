export type ComputerId = string & { readonly __brand: 'ComputerId' }
export type DisplayId = string & { readonly __brand: 'DisplayId' }
export type ProfileId = string & { readonly __brand: 'ProfileId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type LayoutVersion = number & { readonly __brand: 'LayoutVersion' }

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
  | { tag: 'incompatible'; found: number; supported: LayoutVersion[] }

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

export function brandLayoutVersion(value: number): LayoutVersion {
  if (!Number.isInteger(value) || value < 1) throw new Error('layout version must be a positive integer')
  return value as LayoutVersion
}
