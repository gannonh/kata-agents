import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseComputerConfig } from '@kata-sh/shared/computer'
import { Computer } from './computer.ts'

const config = parseComputerConfig(process.env, { packaged: false, argv: ['--allow-insecure-bind'] })
const computer = await Computer.open({ ...config, kind: 'self-hosted-headless' }, { skipBrowser: true })
writeFileSync(
  join(computer.layout.shutdownDir, 'interrupted.json'),
  `${JSON.stringify({ kind: 'interrupted', domain: 'session', ref: 'sess-crash' })}\n`,
)
process.exit(9)
