#!/usr/bin/env bun
/**
 * Verify that a source tree or assembled release directory contains the legal
 * files required by the project and preserves the upstream Craft attribution.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REQUIRED_LEGAL_FILES = [
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES.md',
] as const

const ROOT = resolve(import.meta.dir, '..')

type LegalFile = (typeof REQUIRED_LEGAL_FILES)[number]

export function verifyLegalDirectory(directory: string): void {
  const errors: string[] = []
  const contents = new Map<LegalFile, string>()

  for (const file of REQUIRED_LEGAL_FILES) {
    const path = join(directory, file)
    if (!existsSync(path)) {
      errors.push(`${file} is missing from ${directory}`)
      continue
    }
    const content = readFileSync(path, 'utf8')
    if (!content.trim()) errors.push(`${file} is empty in ${directory}`)
    contents.set(file, content)
  }

  const license = contents.get('LICENSE') ?? ''
  if (!license.includes('Apache License')) errors.push('LICENSE is not the Apache License text')
  if (!license.includes('Copyright 2026 Craft Docs Ltd.')) {
    errors.push('LICENSE does not retain Craft Docs Ltd. attribution')
  }

  const notice = contents.get('NOTICE') ?? ''
  for (const marker of [
    'Craft Agents',
    'Copyright 2026 Craft Docs Ltd.',
    'Commercial Terms of Service: https://www.anthropic.com/legal/commercial-terms',
    'Kata Agents modifications',
  ]) {
    if (!notice.includes(marker)) errors.push(`NOTICE is missing: ${marker}`)
  }

  const thirdParty = contents.get('THIRD-PARTY-NOTICES.md') ?? ''
  for (const marker of [
    'This file is generated from',
    'JavaScript and TypeScript runtime dependencies',
    'Python/PyPI dependencies used by bundled tools',
    'Claude Agent SDK',
    'ShellGuard security corpus',
  ]) {
    if (!thirdParty.includes(marker)) errors.push(`THIRD-PARTY-NOTICES.md is missing: ${marker}`)
  }

  if (errors.length) {
    throw new Error(`Legal asset verification failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`)
  }
}

const requestedDirectory = (): string => {
  const args = process.argv.slice(2)
  const dirIndex = args.indexOf('--dir')
  if (dirIndex >= 0) return resolve(args[dirIndex + 1] ?? ROOT)
  return resolve(args.find((arg) => !arg.startsWith('-')) ?? ROOT)
}

if (import.meta.main) {
  const directory = requestedDirectory()
  try {
    verifyLegalDirectory(directory)
    console.log(`Legal assets verified in ${directory}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
