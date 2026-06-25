import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAgentsCliReadOnlyInvokeBashPatterns } from '../src/config/agents-cli-invoke.ts'

type AllowedBashEntry = { pattern: string; comment?: string }

describe('permissions kata-agents-cli invoke allowlist sync', () => {
  it('keeps default.json kata-agents-cli read-only invoke rules aligned with shared policy', () => {
    const permissionsPath = resolve(import.meta.dir, '../../../apps/electron/resources/permissions/default.json')
    const permissions = JSON.parse(readFileSync(permissionsPath, 'utf-8')) as {
      allowedBashPatterns?: AllowedBashEntry[]
    }

    const actual = (permissions.allowedBashPatterns ?? [])
      .filter(entry => typeof entry.pattern === 'string' && (
        entry.pattern.startsWith('^kata-agents-cli\\s+invoke\\s+')
        || entry.pattern.startsWith('^kata-agents-cli\\s+--help')
      ))
      .map(entry => ({ pattern: entry.pattern, comment: entry.comment ?? '' }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern))

    const expected = getAgentsCliReadOnlyInvokeBashPatterns()
      .map(entry => ({ pattern: entry.pattern, comment: entry.comment }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern))

    expect(actual).toEqual(expected)
  })

  it('does not contain deprecated kata-agent (singular) bash patterns', () => {
    const permissionsPath = resolve(import.meta.dir, '../../../apps/electron/resources/permissions/default.json')
    const permissions = JSON.parse(readFileSync(permissionsPath, 'utf-8')) as {
      allowedBashPatterns?: AllowedBashEntry[]
    }

    const deprecated = (permissions.allowedBashPatterns ?? []).filter(
      (entry) => /kata-agent(\\s|\\b|\s)/.test(entry.pattern) || /\bcraft-agent/.test(entry.pattern),
    )
    expect(deprecated).toEqual([])
  })
})
