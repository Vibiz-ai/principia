/**
 * The first five minutes for someone outside the team (CLOUD.md §0, §12.1): one downloadable compose file that pulls
 * published images, a one-button Render Blueprint with no tunnel, public HTTPS in one flag, and a connect link that
 * says when it only works on the cloud's own machine.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { isPublicHttpsUrl } from '../../../shared/cloud'
import { loadConfig, passportPublicUrlFrom, publicUrlFrom } from '../config'
import { agentUserFor, connectHint } from '../main'
import { parseMasterKey } from '../vault'
import { isPassportPath } from '../passportProxy'

const root = resolve(__dirname, '../../../..')
const yaml = (p: string) => load(readFileSync(join(root, p), 'utf8')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('compose: one file, pulled images, nothing else on disk', () => {
  const c = yaml('cloud/compose.yml')
  it('pulls every service from ghcr.io and builds nothing (no clone, no sibling checkout, no GitHub credentials)', () => {
    for (const name of ['init', 'principia', 'passport']) {
      expect(c.services[name].build, name).toBeUndefined()
      expect(c.services[name].image, name).toMatch(/^ghcr\.io\/vibiz-ai\/(principia-cloud|open-passport-host):\$\{(PRINCIPIA|OPEN_PASSPORT)_VERSION:-latest\}$/)
    }
    // no path relative to a checkout: named volumes only (the Caddyfile is inline)
    const mounts = Object.values(c.services as Record<string, { volumes?: string[] }>).flatMap(s => s.volumes ?? [])
    for (const m of mounts) expect(m.split(':')[0], m).toMatch(/^[a-z-]+$/)
    expect(Object.keys(c.volumes)).toEqual(expect.arrayContaining(['principia-data', 'principia-workspace', 'principia-secrets', 'passport-secrets', 'passport-data']))
  })

  it('agents cannot read the secrets: the control plane runs as root with six capabilities, the passport never sees master.key', () => {
    const p = c.services.principia
    expect(p.user).toBe('0:0')
    expect(p.cap_drop).toEqual(['ALL'])
    expect(p.cap_add.sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID'])
    expect(p.security_opt).toEqual(['no-new-privileges:true'])
    expect(p.read_only).toBe(true)
    expect(p.environment.PRINCIPIA_AGENT_UID).toBe('${PRINCIPIA_AGENT_UID:-1001}')
    expect(p.volumes).toContain('principia-secrets:/secrets:ro')
    expect(c.services.passport.volumes).toContain('passport-secrets:/secrets:ro')
    expect(JSON.stringify(c.services.passport)).not.toContain('principia-secrets')
    expect(c.services.init.cap_add.sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
    expect(c.services.init.environment.PRINCIPIA_PASSPORT_SECRETS_UID).toBe('1000')
  })

  it('the caddy profile makes both origins public HTTPS from two domains, and is off by default', () => {
    const caddy = c.services.caddy
    expect(caddy.profiles).toEqual(['caddy'])
    expect(caddy.ports).toEqual(['80:80', '443:443'])
    expect(c.configs.caddyfile.content).toContain('{$$PRINCIPIA_DOMAIN} {\n  reverse_proxy principia:8787')
    expect(c.configs.caddyfile.content).toContain('{$$PASSPORT_DOMAIN} {\n  reverse_proxy passport:8787')
    // the same domains set the public URLs (control plane and passport host) with no other setting
    expect(c.services.principia.environment.PRINCIPIA_DOMAIN).toBe('${PRINCIPIA_DOMAIN:-}')
    expect(c.services.principia.environment.PASSPORT_DOMAIN).toBe('${PASSPORT_DOMAIN:-}')
    expect(c.services.passport.command.join(' ')).toContain('$${PASSPORT_DOMAIN:+https://$$PASSPORT_DOMAIN}')
  })

  it('compose.build.yml is an override that builds both images from source, with Open Passport as a named context', () => {
    const b = yaml('cloud/compose.build.yml')
    expect(b.services.principia.build.dockerfile).toBe('cloud/Dockerfile')
    expect(b.services.principia.build.additional_contexts['open-passport']).toBe('${OPEN_PASSPORT_SRC:-https://github.com/Vibiz-ai/open-passport.git#main}')
    expect(b.services.passport.build).toEqual({ context: '${OPEN_PASSPORT_SRC:-https://github.com/Vibiz-ai/open-passport.git#main}', dockerfile: 'packages/server/Dockerfile' })
    const docker = readFileSync(join(root, 'cloud/Dockerfile'), 'utf8')
    expect(docker).toContain('COPY --from=open-passport packages/server /opt/open-passport/packages/server')
    expect(docker).toMatch(/useradd --system --uid 1001 .* agent/)
    expect(docker).not.toMatch(/^USER /m)
  })
})

describe('Render Blueprint: one button, https, no tunnel (CLOUD.md §12.1)', () => {
  const r = yaml('render.yaml')
  const svc = r.services[0]
  const env = Object.fromEntries((svc.envVars as { key: string; value?: string; generateValue?: boolean }[]).map(e => [e.key, e.value ?? (e.generateValue ? '<generated>' : '')]))
  it('parses, runs the published image with a disk, and embeds the passport on the same origin', () => {
    expect(r.services).toHaveLength(1)
    expect(svc).toMatchObject({ type: 'web', runtime: 'image', image: { url: 'ghcr.io/vibiz-ai/principia-cloud:latest' }, healthCheckPath: '/v1/health', numInstances: 1, disk: { mountPath: '/data' } })
    expect(env).toMatchObject({ PRINCIPIA_PASSPORT: 'embedded', PRINCIPIA_DATA_DIR: '/data', PRINCIPIA_SECRETS_DIR: '/data/secrets', PRINCIPIA_WORKSPACE: '/data/workspace', PRINCIPIA_MASTER_KEY: '<generated>' })
    // nothing to type: no sync:false variable asks the founder for a value
    expect((svc.envVars as { sync?: boolean }[]).some(e => e.sync === false)).toBe(false)
  })

  it('with Render\'s own variables the connect link and the Passport URL are the https origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prender-'))
    writeFileSync(join(dir, 'passport-admin'), 'p'.repeat(32))
    const l = loadConfig({ ...env, PRINCIPIA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), PRINCIPIA_SECRETS_DIR: dir, PRINCIPIA_DATA_DIR: dir, RENDER_EXTERNAL_URL: 'https://principia-cloud-x1.onrender.com' }, { consoleDir: '/c' })
    expect(l.config.publicUrl).toBe('https://principia-cloud-x1.onrender.com')
    expect(l.publicSource).toBe('render')
    expect(l.config.passport).toMatchObject({ internalUrl: 'http://127.0.0.1:8788', publicUrl: 'https://principia-cloud-x1.onrender.com' })
    expect(l.config.passportProxy).toBe('http://127.0.0.1:8788')
    expect(l.embeddedPassport).toMatchObject({ port: 8788, dataDir: join(dir, 'passport') })
    expect(isPublicHttpsUrl(`${l.config.passport!.publicUrl}/v1/passports/co_a/mcp`)).toBe(true)
    expect(connectHint(l, false)).toBeNull()
  })
})

describe('public URLs, keys and the connect hint', () => {
  it('derives the public origin from the hosts that set one, explicit settings first', () => {
    expect(publicUrlFrom({}, 8787)).toEqual({ url: 'http://127.0.0.1:8787', source: 'local' })
    expect(publicUrlFrom({ PRINCIPIA_DOMAIN: 'cloud.example.com' }, 8787)).toEqual({ url: 'https://cloud.example.com', source: 'domain' })
    expect(publicUrlFrom({ FLY_APP_NAME: 'acme-cloud' }, 8787)).toEqual({ url: 'https://acme-cloud.fly.dev', source: 'fly' })
    expect(publicUrlFrom({ RAILWAY_PUBLIC_DOMAIN: 'acme.up.railway.app' }, 8787)).toEqual({ url: 'https://acme.up.railway.app', source: 'railway' })
    expect(publicUrlFrom({ PRINCIPIA_PUBLIC_URL: 'https://x.example/', RENDER_EXTERNAL_URL: 'https://y.onrender.com' }, 1).url).toBe('https://x.example')
    expect(publicUrlFrom({ PRINCIPIA_PUBLIC_URL: '' }, 8787).source).toBe('local')
    expect(passportPublicUrlFrom({}, 'https://c.example', false)).toBe('http://127.0.0.1:8788')
    expect(passportPublicUrlFrom({ PASSPORT_DOMAIN: 'passport.example.com' }, 'https://c.example', false)).toBe('https://passport.example.com')
    expect(passportPublicUrlFrom({}, 'https://c.example', true)).toBe('https://c.example')
    expect(passportPublicUrlFrom({ OPEN_PASSPORT_PUBLIC_URL: 'https://p.example/' }, 'https://c.example', true)).toBe('https://p.example')
  })

  it('a master key is 64 hex characters or 32 bytes of base64 (Render generateValue)', () => {
    expect(parseMasterKey('a'.repeat(64))).toHaveLength(32)
    expect(parseMasterKey(Buffer.alloc(32, 1).toString('base64'))).toEqual(Buffer.alloc(32, 1))
    expect(parseMasterKey(Buffer.alloc(32, 2).toString('base64url'))).toEqual(Buffer.alloc(32, 2))
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
    expect(() => parseMasterKey('short')).toThrow(/64 hex/)
  })

  it('a local-only connect link comes with one plain instruction, except on the Mac itself', () => {
    const hint = connectHint({ publicSource: 'local', port: 8787 }, false)!
    expect(hint).toBe('This link works only on this machine. From your Mac: ssh -N -L 8787:127.0.0.1:8787 you@this-server, then paste it. Or set PRINCIPIA_PUBLIC_URL to an address your Mac reaches.')
    expect(connectHint({ publicSource: 'local', port: 8787 }, true)).toBeNull()
    expect(connectHint({ publicSource: 'domain', port: 8787 }, false)).toBeNull()
  })

  it('agents get their own uid only when the control plane can change users (root)', () => {
    expect(agentUserFor({}, 0)).toEqual({ uid: 1001, gid: 1001 })
    expect(agentUserFor({ PRINCIPIA_AGENT_UID: '2000', PRINCIPIA_AGENT_GID: '2001' }, 0)).toEqual({ uid: 2000, gid: 2001 })
    expect(agentUserFor({}, 1000)).toBeNull()
    expect(agentUserFor({ PRINCIPIA_AGENT_UID: 'off' }, 0)).toBeNull()
    expect(() => agentUserFor({ PRINCIPIA_AGENT_UID: '0' }, 0)).toThrow(/not root/)
  })

  it('the embedded passport serves only the host\'s own paths on the cloud origin', () => {
    for (const p of ['/v1/passports', '/v1/passports/co_a/mcp', '/v1/grants/g1', '/oauth/authorize', '/oauth/token', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/v1/passports/co_a/mcp', '/.well-known/openid-configuration', '/p/co_a/n/notes/a.md']) expect(isPassportPath(p), p).toBe(true)
    for (const p of ['/oauth/connectors/callback', '/v1/companies', '/v1/health', '/console/', '/pair', '/v1/passportsX', '/.well-known/security.txt']) expect(isPassportPath(p), p).toBe(false)
  })
})
