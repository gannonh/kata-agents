/**
 * Wire protocol types for the WS-based RPC layer.
 *
 * Shared between server (main process / headless) and client (renderer / Node).
 */

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack'

export interface MessageEnvelope {
  /** Correlation ID. UUIDv4 for requests; echoed in responses. */
  id: string
  type: MessageType
  /** Required for request / response / event / error. */
  channel?: string
  /** Request args or event payload. */
  args?: unknown[]
  /** Response payload. */
  result?: unknown
  /** Structured error. */
  error?: WireError
  /** Sent on handshake / handshake_ack. */
  protocolVersion?: string
  /** Sent on handshake by the client. */
  workspaceId?: string
  /** Sent on handshake for remote auth. */
  token?: string
  /** Assigned by server in handshake_ack. */
  clientId?: string
  /** Server identity stamp on outgoing events. For MultiClient source disambiguation. */
  serverId?: string
  /** Electron webContents.id, sent on handshake by local clients. */
  webContentsId?: number
  /** Client capabilities advertised on handshake. */
  clientCapabilities?: string[]
  /** Server-registered channels, sent in handshake_ack. Clients use this to avoid calling unavailable channels. */
  registeredChannels?: string[]

  // -- Reliable delivery fields --

  /** Per-client monotonic delivery sequence number, assigned when an event is targeted to that client. */
  seq?: number
  /** Client's last processed per-client seq — sent in sequence_ack and reconnect handshake. */
  lastSeq?: number
  /** Previous clientId — sent by client on reconnect handshake. */
  reconnectClientId?: string
  /** True when handshake_ack is for a reconnection (vs fresh connect). */
  reconnected?: boolean
  /** True when server buffer was evicted — client must do a full state refresh. */
  stale?: boolean
  /** Server app version, sent in handshake_ack. Clients can use this for compatibility checks. */
  serverVersion?: string
}

export interface WireError {
  code: ErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Wire error returned when a V2 Git worktree RPC targets an incapable server. */
export const WORKTREE_V2_CAPABILITY_ERROR_CODE = 'GIT_WORKTREE_V2_UNAVAILABLE' as const
/** Wire error returned when a worktree settings update fails validation or persistence. */
export const WORKTREE_SETTINGS_ERROR_CODE = 'GIT_WORKTREE_SETTINGS_INVALID' as const
/** Wire error returned when a named worktree request fails before any mutation. */
export const WORKTREE_NAME_INVALID_CODE = 'WORKTREE_NAME_INVALID' as const
/** Wire error returned when the requested named branch already exists. */
export const WORKTREE_BRANCH_COLLISION_CODE = 'WORKTREE_BRANCH_COLLISION' as const
/** Wire error returned when a destination component is unsafe. */
export const WORKTREE_DESTINATION_UNSAFE_CODE = 'WORKTREE_DESTINATION_UNSAFE' as const
/** Wire error returned when compensation cannot prove branch ownership. */
export const WORKTREE_BRANCH_OWNERSHIP_UNKNOWN_CODE = 'WORKTREE_BRANCH_OWNERSHIP_UNKNOWN' as const
/** Wire error returned when a lifecycle transaction fails safety validation. */
export const WORKTREE_LIFECYCLE_ERROR_CODE = 'WORKTREE_LIFECYCLE_FAILED' as const
/** Wire error returned when a preview fingerprint is stale before capture. */
export const WORKTREE_PREVIEW_STALE_CODE = 'WORKTREE_PREVIEW_STALE' as const
/** Wire error returned when a record is not in a manageable state. */
export const WORKTREE_STATE_UNMANAGEABLE_CODE = 'WORKTREE_STATE_UNMANAGEABLE' as const
/** Wire error returned when a lifecycle action requires zero owners. */
export const WORKTREE_OWNERS_PRESENT_CODE = 'WORKTREE_OWNERS_PRESENT' as const
/** Wire error returned when a handoff RPC fails during execution. */
export const WORKTREE_HANDOFF_ERROR_CODE = 'WORKTREE_HANDOFF_FAILED' as const
/** Wire error returned when a handoff RPC is rejected by a typed blocker. */
export const WORKTREE_HANDOFF_BLOCKED_CODE = 'WORKTREE_HANDOFF_BLOCKED' as const
/** Wire error returned when a handoff preview fingerprint is stale. */
export const WORKTREE_HANDOFF_PREVIEW_STALE_CODE = 'WORKTREE_HANDOFF_PREVIEW_STALE' as const
/** Wire error returned when a pending/recovery handoff fences an action. */
export const WORKTREE_HANDOFF_PENDING_CODE = 'WORKTREE_HANDOFF_PENDING' as const
/** Wire error returned when a fork RPC fails during execution. */
export const WORKTREE_FORK_ERROR_CODE = 'WORKTREE_FORK_FAILED' as const
/** Wire error returned when a fork RPC is rejected by a typed blocker. */
export const WORKTREE_FORK_BLOCKED_CODE = 'WORKTREE_FORK_BLOCKED' as const
/** Wire error returned when a fork preview fingerprint is stale. */
export const WORKTREE_FORK_PREVIEW_STALE_CODE = 'WORKTREE_FORK_PREVIEW_STALE' as const
/** Wire error returned when a pending/recovery fork fences an action. */
export const WORKTREE_FORK_PENDING_CODE = 'WORKTREE_FORK_PENDING' as const

export type ErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | typeof WORKTREE_V2_CAPABILITY_ERROR_CODE
  | typeof WORKTREE_SETTINGS_ERROR_CODE
  | typeof WORKTREE_NAME_INVALID_CODE
  | typeof WORKTREE_BRANCH_COLLISION_CODE
  | typeof WORKTREE_DESTINATION_UNSAFE_CODE
  | typeof WORKTREE_BRANCH_OWNERSHIP_UNKNOWN_CODE
  | typeof WORKTREE_LIFECYCLE_ERROR_CODE
  | typeof WORKTREE_PREVIEW_STALE_CODE
  | typeof WORKTREE_STATE_UNMANAGEABLE_CODE
  | typeof WORKTREE_OWNERS_PRESENT_CODE
  | typeof WORKTREE_HANDOFF_ERROR_CODE
  | typeof WORKTREE_HANDOFF_BLOCKED_CODE
  | typeof WORKTREE_HANDOFF_PREVIEW_STALE_CODE
  | typeof WORKTREE_HANDOFF_PENDING_CODE
  | typeof WORKTREE_FORK_ERROR_CODE
  | typeof WORKTREE_FORK_BLOCKED_CODE
  | typeof WORKTREE_FORK_PREVIEW_STALE_CODE
  | typeof WORKTREE_FORK_PENDING_CODE
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  WORKTREE_V2_CAPABILITY_ERROR_CODE,
  WORKTREE_SETTINGS_ERROR_CODE,
  WORKTREE_NAME_INVALID_CODE,
  WORKTREE_BRANCH_COLLISION_CODE,
  WORKTREE_DESTINATION_UNSAFE_CODE,
  WORKTREE_BRANCH_OWNERSHIP_UNKNOWN_CODE,
  WORKTREE_LIFECYCLE_ERROR_CODE,
  WORKTREE_PREVIEW_STALE_CODE,
  WORKTREE_STATE_UNMANAGEABLE_CODE,
  WORKTREE_OWNERS_PRESENT_CODE,
  WORKTREE_HANDOFF_ERROR_CODE,
  WORKTREE_HANDOFF_BLOCKED_CODE,
  WORKTREE_HANDOFF_PREVIEW_STALE_CODE,
  WORKTREE_HANDOFF_PENDING_CODE,
  WORKTREE_FORK_ERROR_CODE,
  WORKTREE_FORK_BLOCKED_CODE,
  WORKTREE_FORK_PREVIEW_STALE_CODE,
  WORKTREE_FORK_PENDING_CODE,
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
])

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

/**
 * Sender-side helper for throwing transport errors with a typed `code`.
 *
 * Class identity is lost across the wire — the transport reconstructs a plain
 * `Error` with `.code` on the receiving side. Receivers MUST branch on
 * `err.code === 'X'`, never `err instanceof CodedError`.
 */
export class CodedError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CodedError'
  }
}

// ---------------------------------------------------------------------------
// Push target (server → clients)
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }
  | { to: 'workspace'; workspaceId: string; exclude?: string }
  | { to: 'client'; clientId: string }

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '1.0'

/** Heartbeat interval in ms. Server pings every 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Client that misses this many pongs gets terminated. */
export const HEARTBEAT_MAX_MISSED = 2

/** Default request timeout in ms. */
export const REQUEST_TIMEOUT_MS = 30_000

// -- Reliable delivery constants --

/** Max events to retain per client in the ring buffer. */
export const EVENT_BUFFER_MAX_SIZE = 500

/** Events older than this are evicted from the buffer. */
export const EVENT_BUFFER_TTL_MS = 30_000

/** How long to retain a disconnected client's buffer for potential reconnect. */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** Client sends a sequence_ack every N ms. */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000
