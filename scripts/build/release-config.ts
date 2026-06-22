#!/usr/bin/env bun
/**
 * release-config.ts — generate the per-build electron-builder publish config.
 *
 * The static `apps/electron/electron-builder.yml` carries the stable GitHub
 * publish config. A release build resolves the channel from the version and
 * injects the matching publish block (releaseType + channel) plus the
 * "Kata Agents (Nightly)" product name for nightlies.
 *
 * This governs the bundled `app-update.yml` and the update-manifest filenames
 * (`latest*.yml` / `nightly*.yml`) only. It does NOT upload the release — the
 * workflow creates the GitHub Release with an explicit upload action
 * (`softprops/action-gh-release`). See docs/operations/release.md.
 *
 * CLI:
 *   bun run scripts/build/release-config.ts \
 *     --version <v> [--channel stable|nightly] \
 *     [--repository owner/repo] [--base <path>] [--out <path>]
 *
 * Writes the merged config (YAML) to --out (default:
 * apps/electron/electron-builder.generated.yml) and prints the path on stdout.
 */

import { parse, stringify } from 'yaml'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Channel = 'stable' | 'nightly'

/** Version format that selects the nightly feed: `X.Y.Z-nightly.YYYYMMDD.N`. */
export const NIGHTLY_VERSION = /-nightly\./

export function resolveChannelFromVersion(version: string): Channel {
  return NIGHTLY_VERSION.test(version) ? 'nightly' : 'stable'
}

export interface GitHubPublishConfig {
  provider: 'github'
  owner: string
  repo: string
  releaseType: 'release' | 'prerelease'
  channel?: 'nightly'
}

/**
 * Resolve the GitHub publish block from the channel and an `owner/repo` string
 * (GITHUB_REPOSITORY in Actions). Stable omits `channel` so electron-updater
 * uses `latest*.yml`; nightly sets `channel: nightly` → `nightly*.yml`.
 */
export function buildPublishConfig(channel: Channel, repository: string): GitHubPublishConfig {
  const parts = repository.split('/')
  const [owner, repo] = parts
  if (parts.length !== 2 || !owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY "${repository}" (expected "owner/repo")`)
  }
  return {
    provider: 'github',
    owner,
    repo,
    releaseType: channel === 'nightly' ? 'prerelease' : 'release',
    ...(channel === 'nightly' ? { channel: 'nightly' as const } : {}),
  }
}

const APP_BASE_NAME = 'Kata Agents'

export function resolveProductName(channel: Channel, base = APP_BASE_NAME): string {
  return channel === 'nightly' ? `${base} (Nightly)` : base
}

export type Arch = 'arm64' | 'x64' | 'universal'

/**
 * Restrict the macOS target arch arrays to a single arch.
 *
 * The base config lists both `arm64` and `x64` under each `mac.target` entry.
 * electron-builder treats an explicit per-target `arch` array as authoritative
 * and ignores the CLI `--arm64`/`--x64` flag, so a per-arch matrix leg would
 * otherwise build BOTH arches. Two legs each emitting `Kata-Agents-arm64.zip`
 * and `Kata-Agents-x64.zip` then collide when the release job merges artifacts,
 * corrupting the uploaded zips. Pinning the arch per leg keeps each leg's
 * output (and its update manifest) single-arch and collision-free.
 */
export function restrictMacArch(base: Record<string, unknown>, arch: Arch): Record<string, unknown> {
  const mac = base.mac
  if (!mac || typeof mac !== 'object') return base
  const macObj = mac as Record<string, unknown>
  const targets = macObj.target
  if (!Array.isArray(targets)) return base

  const restrictedTargets = targets.map((entry) => {
    if (entry && typeof entry === 'object' && Array.isArray((entry as { arch?: unknown }).arch)) {
      const e = entry as { arch: string[] }
      // Only narrow targets that actually offer this arch; leave others intact.
      return e.arch.includes(arch) ? { ...e, arch: [arch] } : entry
    }
    return entry
  })

  return { ...base, mac: { ...macObj, target: restrictedTargets } }
}

export interface GenerateOptions {
  /** Parsed base electron-builder config. */
  base: Record<string, unknown>
  version: string
  repository: string
  /** Overrides the version-inferred channel when set. */
  channel?: Channel
  /** Pin macOS targets to a single arch (per-arch matrix legs). */
  arch?: Arch
}

/**
 * Produce a new config object with the GitHub publish block and product name
 * applied. All other fields are preserved unchanged (AC12).
 */
export function generateConfig(opts: GenerateOptions): Record<string, unknown> {
  const channel = opts.channel ?? resolveChannelFromVersion(opts.version)
  const base = opts.arch ? restrictMacArch(opts.base, opts.arch) : opts.base
  return {
    ...base,
    productName: resolveProductName(channel),
    publish: [buildPublishConfig(channel, opts.repository)],
  }
}

interface CliArgs {
  version?: string
  channel?: Channel
  repository?: string
  base?: string
  out?: string
  arch?: Arch
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--version':
        args.version = value
        i += 1
        break
      case '--channel':
        if (value !== 'stable' && value !== 'nightly') {
          throw new Error(`--channel must be "stable" or "nightly", got "${value}"`)
        }
        args.channel = value
        i += 1
        break
      case '--repository':
        args.repository = value
        i += 1
        break
      case '--base':
        args.base = value
        i += 1
        break
      case '--out':
        args.out = value
        i += 1
        break
      case '--arch':
        if (value !== 'arm64' && value !== 'x64' && value !== 'universal') {
          throw new Error(`--arch must be "arm64", "x64", or "universal", got "${value}"`)
        }
        args.arch = value
        i += 1
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const basePath = args.base ?? resolve(repoRoot, 'apps/electron/electron-builder.yml')
  const outPath = args.out ?? resolve(repoRoot, 'apps/electron/electron-builder.generated.yml')

  const version = args.version ?? process.env.RELEASE_VERSION
  if (!version) {
    throw new Error('Missing --version (or RELEASE_VERSION env)')
  }

  const repository = args.repository ?? process.env.GITHUB_REPOSITORY
  if (!repository) {
    throw new Error('Missing --repository (or GITHUB_REPOSITORY env)')
  }

  const base = parse(readFileSync(basePath, 'utf-8')) as Record<string, unknown>
  const generated = generateConfig({ base, version, repository, channel: args.channel, arch: args.arch })

  writeFileSync(outPath, stringify(generated), 'utf-8')
  // The release workflow captures stdout to pass `--config <path>` downstream.
  console.log(outPath)
}

if (import.meta.main) {
  main()
}
