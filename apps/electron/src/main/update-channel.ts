/**
 * Update-channel resolution for the desktop auto-updater.
 *
 * The installed build's version string determines which release feed it
 * follows by default: a `X.Y.Z-nightly.YYYYMMDD.N` build tracks the `nightly`
 * channel (nightly*.yml prereleases); everything else tracks `latest`
 * (latest*.yml stable releases). A persisted user preference can override that
 * default from Settings (AC6). Kept free of electron imports so it is
 * unit-testable.
 */

/** electron-updater channel names: stable manifests are latest*.yml. */
export type UpdateChannel = 'latest' | 'nightly'

/** Version format that selects the nightly feed: `X.Y.Z-nightly.YYYYMMDD.N`. */
export const NIGHTLY_VERSION = /-nightly\./

export function resolveUpdateChannel(version: string): UpdateChannel {
  return NIGHTLY_VERSION.test(version) ? 'nightly' : 'latest'
}

/**
 * Persisted update-track preference. `configuredByUser` distinguishes an
 * explicit user choice from a legacy/stale `channel` value written before this
 * flag existed; only an explicit choice overrides the version-derived default.
 */
export interface PersistedUpdateChannelPreference {
  channel: UpdateChannel
  configuredByUser: boolean | undefined
}

export interface ResolvedUpdateChannel {
  channel: UpdateChannel
  configuredByUser: boolean
}

/**
 * Resolve the effective update channel from the installed version and an
 * optional persisted preference (AC6).
 *
 * - No preference, or a legacy preference without `configuredByUser: true`:
 *   the installed version decides (stable → latest, nightly → nightly).
 * - An explicit user preference (`configuredByUser: true`): the preference
 *   wins, even if it matches the version default (still counts as configured).
 *
 * Mirrors kata-code's `DesktopAppSettings.normalizeDesktopSettingsDocument`
 * legacy-fallback semantics: a missing `configuredByUser` flag must NOT be
 * treated as an implicit user choice, otherwise an old config could force a
 * stable build onto the nightly feed.
 */
export function resolveSelectedChannel(
  installedVersion: string,
  preference?: PersistedUpdateChannelPreference,
): ResolvedUpdateChannel {
  const defaultChannel = resolveUpdateChannel(installedVersion)

  if (preference && preference.configuredByUser === true) {
    return {
      channel: preference.channel,
      configuredByUser: true,
    }
  }

  return {
    channel: defaultChannel,
    configuredByUser: false,
  }
}
