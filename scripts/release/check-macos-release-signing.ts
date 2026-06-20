#!/usr/bin/env bun
/**
 * check-macos-release-signing.ts — signing gate for the release workflow.
 *
 * Fails fast (exit 1) before a build starts if any required macOS code-signing
 * / notarization secret is missing, so a release run does not waste a full
 * build only to fail at the signing step. Ported from kata-code.
 */

export const MACOS_RELEASE_SIGNING_SECRET_NAMES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
] as const

export type MacOsReleaseSigningSecret = (typeof MACOS_RELEASE_SIGNING_SECRET_NAMES)[number]

export interface MacOsReleaseSigningStatus {
  ready: boolean
  missing: MacOsReleaseSigningSecret[]
}

export function resolveMacOsReleaseSigning(
  env: Record<string, string | undefined>,
): MacOsReleaseSigningStatus {
  const missing = MACOS_RELEASE_SIGNING_SECRET_NAMES.filter((name) => {
    const value = env[name]
    return value === undefined || value === ''
  })
  return { ready: missing.length === 0, missing }
}

function main(): void {
  const status = resolveMacOsReleaseSigning(process.env)
  if (status.ready) {
    process.stdout.write(
      `macOS release signing inputs ready (${MACOS_RELEASE_SIGNING_SECRET_NAMES.join(', ')}).\n`,
    )
    process.exit(0)
  }
  process.stderr.write(
    `Missing required macOS release signing secrets: ${status.missing.join(', ')}\n`,
  )
  process.exit(1)
}

if (import.meta.main) {
  main()
}
