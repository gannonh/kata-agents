import type {
  BrowserProfile,
  ComputerIdentity,
  DataRootLayout,
  LeasedBrowserProfile,
  ProfileHandoffRequest,
  ProfileId,
  SessionId,
  VirtualDisplay,
} from '@kata-sh/shared/computer'

export interface BrowserHost {
  readonly identity: ComputerIdentity
  readonly layout: DataRootLayout
  acquireProfileLease(input: {
    profileId: ProfileId
    sessionId: SessionId
    displayId?: VirtualDisplay['displayId']
  }): Promise<LeasedBrowserProfile>
  releaseProfileLease(input: { profileId: ProfileId; sessionId: SessionId }): Promise<unknown>
  handoffProfile(request: ProfileHandoffRequest): Promise<BrowserProfile>
}
