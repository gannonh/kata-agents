export class ComputerAlreadyRunning extends Error {
  readonly holderPid: number
  readonly lockPath: string

  constructor(holderPid: number, lockPath: string) {
    super(`Computer already running (PID ${holderPid}). If this lock is stale, delete ${lockPath} and retry.`)
    this.name = 'ComputerAlreadyRunning'
    this.holderPid = holderPid
    this.lockPath = lockPath
  }
}

export class ComputerLayoutError extends Error {
  readonly tag: 'corrupt' | 'incompatible'
  readonly path?: string
  readonly found?: number

  constructor(input: { tag: 'corrupt'; reason: string; path: string } | { tag: 'incompatible'; found: number }) {
    if (input.tag === 'corrupt') {
      super(`Computer data root is corrupt: ${input.reason} (${input.path})`)
      this.path = input.path
    } else {
      super(`Computer data root layout version ${input.found} is incompatible`)
      this.found = input.found
    }
    this.name = 'ComputerLayoutError'
    this.tag = input.tag
  }
}

export class ProfileBusyError extends Error {
  readonly profileId: string
  readonly holderSessionId: string

  constructor(profileId: string, holderSessionId: string) {
    super(`Browser profile ${profileId} already has a writer (session ${holderSessionId})`)
    this.name = 'ProfileBusyError'
    this.profileId = profileId
    this.holderSessionId = holderSessionId
  }
}
