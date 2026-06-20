/**
 * Update-channel resolution for the desktop auto-updater.
 *
 * The installed build's version string determines which release feed it
 * follows: a `X.Y.Z-nightly.YYYYMMDD.N` build tracks the `nightly` channel
 * (nightly*.yml prereleases); everything else tracks `latest` (latest*.yml
 * stable releases). Kept free of electron imports so it is unit-testable.
 */

/** electron-updater channel names: stable manifests are latest*.yml. */
export type UpdateChannel = 'latest' | 'nightly'

/** Version format that selects the nightly feed: `X.Y.Z-nightly.YYYYMMDD.N`. */
export const NIGHTLY_VERSION = /-nightly\./

export function resolveUpdateChannel(version: string): UpdateChannel {
  return NIGHTLY_VERSION.test(version) ? 'nightly' : 'latest'
}
