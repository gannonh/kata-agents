import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderCanonicalCompose,
  renderSystemdUnit,
  renderPackagedServerWrapper,
  renderPackagedInstallScript,
  renderPackagedSystemdUnit,
  CANONICAL_DATA_ROOT,
} from '../server-packaging.ts'

describe('server packaging', () => {
  it('compose uses a durable data root, token file, TLS, and healthcheck', () => {
    const compose = renderCanonicalCompose()
    expect(compose).toContain(`KATA_DATA_ROOT: ${CANONICAL_DATA_ROOT}`)
    expect(compose).toContain(`kata-data:${CANONICAL_DATA_ROOT}`)
    expect(compose).toContain('KATA_SERVER_TOKEN_FILE: /run/secrets/kata_server_token')
    expect(compose).toContain('KATA_RPC_TLS_CERT: /certs/cert.pem')
    expect(compose).toContain('KATA_RPC_TLS_KEY: /certs/key.pem')
    expect(compose).toContain('curl')
    expect(compose).toContain('http://127.0.0.1:9101/health')
    expect(compose).toContain('dockerfile: Dockerfile.server')
    expect(compose).toContain(
      'user: "${KATA_UID:?Set KATA_UID to the numeric uid that owns certs/key.pem}:${KATA_GID:?Set KATA_GID to the numeric gid of certs/key.pem}"',
    )
    expect(compose).not.toContain('user: "kataagents"')
    expect(compose).not.toContain('/root/.kata-agents')
  })

  it('packaged compose builds the emitted Dockerfile', () => {
    const compose = renderCanonicalCompose({ dockerfile: 'Dockerfile' })
    expect(compose).toMatch(/dockerfile:\s*Dockerfile\n/)
    expect(compose).not.toContain('Dockerfile.server')
    expect(compose).toContain(`KATA_DATA_ROOT: ${CANONICAL_DATA_ROOT}`)
  })

  it('repo-root docker-compose.server.yml matches the canonical renderer', () => {
    const committed = readFileSync(join(import.meta.dir, '..', '..', 'docker-compose.server.yml'), 'utf8')
    expect(committed).toBe(renderCanonicalCompose())
  })

  it('systemd unit still binds localhost', () => {
    const unit = renderSystemdUnit({
      serviceUser: 'kata',
      workingDirectory: '/opt/kata-server',
      execStart: '/opt/kata-server/bin/kata-server',
      envFile: '/opt/kata-server/.env',
    })
    expect(unit).toContain('KATA_RPC_HOST=127.0.0.1')
    expect(unit).toContain('User=kata')
    expect(unit).not.toContain('0.0.0.0')
  })

  it('packaged wrapper does not invent a data root', () => {
    const wrapper = renderPackagedServerWrapper()
    expect(wrapper).toContain('KATA_IS_PACKAGED=true')
    expect(wrapper).not.toContain('KATA_DATA_ROOT')
    expect(wrapper).not.toContain(CANONICAL_DATA_ROOT)
  })

  it('install.sh embeds the canonical localhost systemd unit', () => {
    const install = renderPackagedInstallScript()
    const unit = renderPackagedSystemdUnit()
    expect(install).toContain(unit)
    expect(install).toContain('KATA_DATA_ROOT=$DIR/data')
    expect(install).toContain('KATA_RPC_HOST=127.0.0.1')
    expect(install).not.toContain('0.0.0.0')
  })
})
