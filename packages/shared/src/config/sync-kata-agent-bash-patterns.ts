#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAgentsCliReadOnlyInvokeBashPatterns } from './cli-domains.ts'

interface AllowedBashEntry {
  pattern: string
  comment?: string
}

interface PermissionsConfig {
  version?: string
  allowedBashPatterns?: AllowedBashEntry[]
  [key: string]: unknown
}

function isManagedAgentsCliPattern(entry: AllowedBashEntry): boolean {
  if (typeof entry.pattern !== 'string') return false
  return (
    entry.pattern.startsWith('^kata-agent\\s')
    || entry.pattern.startsWith('^kata-agents-cli\\s+invoke\\s+')
    || entry.pattern.startsWith('^kata-agents-cli\\s+--help\\b')
  )
}

function syncAgentsCliPatterns(config: PermissionsConfig): PermissionsConfig {
  const patterns = config.allowedBashPatterns ?? []
  const firstManagedIndex = patterns.findIndex(isManagedAgentsCliPattern)

  const withoutManaged = patterns.filter(entry => !isManagedAgentsCliPattern(entry))
  const generated = getAgentsCliReadOnlyInvokeBashPatterns()

  const insertAt = firstManagedIndex >= 0 ? firstManagedIndex : withoutManaged.length
  const nextAllowedBashPatterns = [
    ...withoutManaged.slice(0, insertAt),
    ...generated,
    ...withoutManaged.slice(insertAt),
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
  const nextConfig = syncAgentsCliPatterns(config)

  writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8')
  process.stdout.write(`Synced kata-agents-cli invoke bash patterns in ${targetPath}\n`)
}

if (import.meta.main) {
  main()
}
