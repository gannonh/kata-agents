#!/usr/bin/env node
/**
 * Controlled fake `gh` executable for GitHubCliService adapter tests.
 *
 * Behavior is driven by environment variables so a single script exercises
 * argument construction, capability/auth mapping, PR lookup, PR creation, and
 * failure paths deterministically (spec: fake `gh` adapter tests). It appends
 * every invocation's argv (and any `pr create` body from stdin) to GH_FAKE_LOG
 * as JSON lines so tests can assert exact argument construction.
 */

const fs = require('node:fs')

const argv = process.argv.slice(2)
const log = process.env.GH_FAKE_LOG

function record(entry) {
  if (!log) return
  try {
    fs.appendFileSync(log, JSON.stringify(entry) + '\n')
  } catch {
    /* ignore */
  }
}

function main() {
  if (argv[0] === '--version') {
    record({ argv })
    process.stdout.write('gh version 2.40.0 (fake)\n')
    process.exit(0)
  }

  if (argv[0] === 'auth' && argv[1] === 'status') {
    record({ argv })
    if (process.env.GH_FAKE_AUTHED === '1') {
      process.stderr.write('Logged in to github.com\n')
      process.exit(0)
    }
    process.stderr.write('You are not logged into any GitHub hosts.\n')
    process.exit(1)
  }

  if (argv[0] === 'pr' && argv[1] === 'view') {
    record({ argv })
    if (process.env.GH_FAKE_HAS_PR === '1') {
      process.stdout.write(process.env.GH_FAKE_PR_JSON || '{}')
      process.exit(0)
    }
    process.stderr.write('no pull requests found for branch\n')
    process.exit(1)
  }

  if (argv[0] === 'pr' && argv[1] === 'create') {
    let body = ''
    try {
      body = fs.readFileSync(0, 'utf8')
    } catch {
      /* no stdin */
    }
    record({ argv, body })
    if (process.env.GH_FAKE_CREATE_FAIL === '1') {
      process.stderr.write('a pull request for branch already exists\n')
      process.exit(1)
    }
    process.stdout.write((process.env.GH_FAKE_PR_URL || 'https://github.com/o/r/pull/42') + '\n')
    process.exit(0)
  }

  record({ argv, unknown: true })
  process.stderr.write('unknown command\n')
  process.exit(1)
}

main()
