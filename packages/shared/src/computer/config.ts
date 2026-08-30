import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ComputerConfigError,
  type ComputerConfig,
  type ComputerKind,
  type ComputerRpcConfig,
} from './types.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MIN_TOKEN_LENGTH = 16

function envFlag(value: string | undefined): boolean {
  if (value == null) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1'
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new ComputerConfigError('invalid-port', `${name} must be an integer 0-65535`)
  }
  return parsed
}

function readToken(env: NodeJS.ProcessEnv): string {
  const filePath = env.KATA_SERVER_TOKEN_FILE?.trim()
  if (filePath) {
    return readFileSync(filePath, 'utf8').trim()
  }
  return env.KATA_SERVER_TOKEN?.trim() ?? ''
}

function assertTokenStrength(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ComputerConfigError(
      'weak-token',
      `Token too short (${token.length} chars, minimum ${MIN_TOKEN_LENGTH})`,
    )
  }
  if (new Set(token).size === 1) {
    throw new ComputerConfigError('weak-token', 'Token has zero entropy (single repeated character)')
  }
}

function parseKind(env: NodeJS.ProcessEnv, packaged: boolean): ComputerKind {
  const raw = env.KATA_COMPUTER_KIND?.trim()
  if (raw === 'local-client' || raw === 'self-hosted-headless') return raw
  return packaged ? 'self-hosted-headless' : 'local-client'
}

function parseTls(env: NodeJS.ProcessEnv): ComputerRpcConfig['tls'] {
  const certPath = env.KATA_RPC_TLS_CERT?.trim() || undefined
  const keyPath = env.KATA_RPC_TLS_KEY?.trim() || undefined
  const caPath = env.KATA_RPC_TLS_CA?.trim() || undefined
  if (certPath && keyPath) {
    return { certPath, keyPath, ...(caPath ? { caPath } : {}) }
  }
  if (certPath || keyPath) {
    throw new ComputerConfigError('tls-incomplete', 'TLS requires both KATA_RPC_TLS_CERT and KATA_RPC_TLS_KEY')
  }
  return null
}

export function parseComputerConfig(
  env: NodeJS.ProcessEnv,
  opts?: { packaged?: boolean; argv?: string[] },
): ComputerConfig {
  const packaged = opts?.packaged ?? envFlag(env.KATA_IS_PACKAGED)
  const argv = opts?.argv ?? []
  const allowInsecurePublicBind = argv.includes('--allow-insecure-bind')

  const dataRootEnv = env.KATA_DATA_ROOT?.trim() ?? ''
  if (packaged && !dataRootEnv) {
    throw new ComputerConfigError('missing-data-root', 'KATA_DATA_ROOT is required in packaged mode')
  }
  const dataRoot = dataRootEnv || env.KATA_CONFIG_DIR?.trim() || join(homedir(), '.kata-agents')

  const token = readToken(env)
  if (!token && packaged) {
    throw new ComputerConfigError(
      'missing-token',
      'KATA_SERVER_TOKEN or KATA_SERVER_TOKEN_FILE is required in packaged mode',
    )
  }
  if (token) assertTokenStrength(token)

  const host = env.KATA_RPC_HOST?.trim() || '127.0.0.1'
  const port = parsePort('KATA_RPC_PORT', env.KATA_RPC_PORT, 9100)
  const healthPort = parsePort('KATA_HEALTH_PORT', env.KATA_HEALTH_PORT, 0)
  const tls = parseTls(env)

  if (!LOCAL_HOSTS.has(host) && tls === null && !allowInsecurePublicBind) {
    throw new ComputerConfigError(
      'insecure-public-bind',
      'Refusing to bind a non-localhost address without TLS. Set KATA_RPC_TLS_CERT/KEY or pass --allow-insecure-bind.',
    )
  }

  return {
    kind: parseKind(env, packaged),
    dataRoot,
    packaged,
    rpc: {
      host,
      port,
      token,
      tls,
      allowInsecurePublicBind,
    },
    healthPort,
    appVersion: env.KATA_VERSION?.trim() || '0.0.0-dev',
    chromiumPath: env.KATA_CHROMIUM_PATH?.trim() || null,
  }
}
