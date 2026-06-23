#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getKataAgentReadOnlyBashPatterns } from './cli-domains.ts'

interface AllowedBashEntry {
  pattern: string
  comment?: string
}

interface PermissionsConfig {
  version?: string
  allowedBashPatterns?: AllowedBashEntry[]
  [key: string]: unknown
}

function isKataAgentPattern(entry: AllowedBashEntry): boolean {
  return typeof entry.pattern === 'string' && entry.pattern.startsWith('^kata-agent\\s')
}

function syncKataAgentPatterns(config: PermissionsConfig): PermissionsConfig {
  const patterns = config.allowedBashPatterns ?? []
  const firstKataIndex = patterns.findIndex(isKataAgentPattern)

  const withoutKata = patterns.filter(entry => !isKataAgentPattern(entry))
  const generated = getKataAgentReadOnlyBashPatterns()

  const insertAt = firstKataIndex >= 0 ? firstKataIndex : withoutKata.length
  const nextAllowedBashPatterns = [
    ...withoutKata.slice(0, insertAt),
    ...generated,
    ...withoutKata.slice(insertAt),
  ]

  return {
    ...config,
    allowedBashPatterns: nextAllowedBashPatterns,
  }
}

function main() {
  const targetPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'apps/electron/resources/permissions/default.json')

  const config = JSON.parse(readFileSync(targetPath, 'utf-8')) as PermissionsConfig
  const nextConfig = syncKataAgentPatterns(config)

  writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8')
  process.stdout.write(`Synced kata-agent bash patterns in ${targetPath}\n`)
}

if (import.meta.main) {
  main()
}
