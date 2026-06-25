#!/usr/bin/env bun
/**
 * update-release-package-versions.ts — align package versions to a release.
 *
 * Writes the resolved release version into the version-bearing manifests so the
 * electron build produces an artifact (and update manifest) whose version
 * matches the release tag. This is what lets a nightly build advertise
 * `X.Y.Z-nightly.*` and so resolve the nightly channel at runtime.
 *
 * The version field is replaced with a targeted string edit to preserve each
 * file's existing formatting (no full reserialization).
 *
 * CLI:
 *   bun run scripts/release/update-release-package-versions.ts <version> \
 *     [--root <dir>] [--file <path> ...] [--github-output]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Manifests that carry the desktop app version (the electron build reads these). */
export const DEFAULT_RELEASE_PACKAGE_FILES = [
  'package.json',
  'apps/electron/package.json',
  'apps/cli/package.json',
] as const

export function setPackageVersion(
  text: string,
  version: string,
): { text: string; changed: boolean } {
  const re = /("version"\s*:\s*")([^"]*)(")/
  const match = re.exec(text)
  if (!match) {
    throw new Error('No "version" field found in package.json')
  }
  if (match[2] === version) {
    return { text, changed: false }
  }
  return { text: text.replace(re, `$1${version}$3`), changed: true }
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

interface CliArgs {
  version?: string
  root?: string
  files: string[]
  githubOutput: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { files: [], githubOutput: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--root':
        args.root = value
        i += 1
        break
      case '--file':
        if (value) args.files.push(value)
        i += 1
        break
      case '--github-output':
        args.githubOutput = true
        break
      default:
        if (flag && !flag.startsWith('--') && args.version === undefined) {
          args.version = flag
        } else {
          throw new Error(`Unknown argument: ${flag}`)
        }
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.version) {
    throw new Error('Missing positional <version> argument')
  }

  const rootDir = args.root ? resolve(args.root) : repoRoot()
  const files = args.files.length > 0 ? args.files : [...DEFAULT_RELEASE_PACKAGE_FILES]

  let changed = false
  for (const rel of files) {
    const filePath = resolve(rootDir, rel)
    if (!existsSync(filePath)) {
      throw new Error(`Release package manifest not found: ${filePath}`)
    }
    const original = readFileSync(filePath, 'utf-8')
    const result = setPackageVersion(original, args.version)
    if (result.changed) {
      writeFileSync(filePath, result.text)
      changed = true
      console.log(`Updated ${rel} → ${args.version}`)
    }
  }

  if (!changed) {
    console.log('All package versions already match the release version.')
  }

  if (args.githubOutput) {
    const githubOutput = process.env.GITHUB_OUTPUT
    if (!githubOutput) {
      throw new Error('GITHUB_OUTPUT is not set')
    }
    appendFileSync(githubOutput, `changed=${changed}\n`)
  }
}

if (import.meta.main) {
  main()
}
