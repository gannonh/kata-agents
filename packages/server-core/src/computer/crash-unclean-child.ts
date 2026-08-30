import { parseComputerConfig } from '@kata-sh/shared/computer'
import { Computer } from './computer.ts'

const config = parseComputerConfig(process.env, { packaged: false, argv: ['--allow-insecure-bind'] })
await Computer.open({ ...config, kind: 'self-hosted-headless' }, { skipBrowser: true })
process.exit(9)
