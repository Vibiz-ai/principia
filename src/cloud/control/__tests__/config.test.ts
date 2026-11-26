import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV_TEMPLATE, initSecrets, loadConfig } from '../config'
import { consoleSession, startHarness } from './harness'

describe('zero-config boot (CLOUD.md §12.1)', () => {
  it('init writes missing secrets once, 0600, and env vars win over the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psec-'))
    expect(initSecrets(dir).sort()).toEqual(['master.key', 'passport-admin'])
    const key = readFileSync(join(dir, 'master.key'), 'utf8').trim()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600)
    expect(initSecrets(dir)).toEqual([])
    expect(readFileSync(join(dir, 'master.key'), 'utf8').trim()).toBe(key)

    const fromFiles = loadConfig({ PRINCIPIA_SECRETS_DIR: dir, OPEN_PASSPORT_INTERNAL_URL: 'http://passport:8787' }, { consoleDir: '/c' })
    expect(fromFiles.masterKey.toString('hex')).toBe(key)
    expect(fromFiles.config.passport?.adminToken).toBe(readFileSync(join(dir, 'passport-admin'), 'utf8').trim())
    expect(fromFiles.config.adminToken).toBeNull()
    const env = loadConfig({ PRINCIPIA_SECRETS_DIR: dir, PRINCIPIA_MASTER_KEY: 'b'.repeat(64), OPEN_PASSPORT_INTERNAL_URL: 'http://passport:8787', OPEN_PASSPORT_ADMIN_TOKEN: 'env-admin-token-123456' }, { consoleDir: '/c' })
    expect(env.masterKey.toString('hex')).toBe('b'.repeat(64))
    expect(env.config.passport?.adminToken).toBe('env-admin-token-123456')
  })

  it('init copies only passport-admin to the passport secrets folder, never master.key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psec-'))
    const pdir = join(mkdtempSync(join(tmpdir(), 'ppsec-')), 'passport')
    initSecrets(dir, { passportDir: pdir })
    expect(readdirSync(pdir)).toEqual(['passport-admin'])
    expect(readFileSync(join(pdir, 'passport-admin'), 'utf8')).toBe(readFileSync(join(dir, 'passport-admin'), 'utf8'))
    expect(statSync(join(pdir, 'passport-admin')).mode & 0o777).toBe(0o600)
    // an upgrade (secrets already there, passport folder empty) still gets the copy
    const pdir2 = join(mkdtempSync(join(tmpdir(), 'ppsec-')), 'passport')
    expect(initSecrets(dir, { passportDir: pdir2 })).toEqual([])
    expect(readdirSync(pdir2)).toEqual(['passport-admin'])
    const compose = readFileSync(resolve(__dirname, '../../../../cloud/compose.yml'), 'utf8')
    const passportService = compose.slice(compose.indexOf('\n  passport:'), compose.indexOf('\nvolumes:'))
    expect(passportService).toContain('passport-secrets:/secrets:ro')
    expect(passportService).not.toContain('principia-secrets')
  })

  it('refuses a short admin token, and needs a master key from somewhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psec-'))
    expect(() => loadConfig({ PRINCIPIA_SECRETS_DIR: dir }, { consoleDir: '/c' })).toThrow(/PRINCIPIA_MASTER_KEY/)
    writeFileSync(join(dir, 'master.key'), 'c'.repeat(64))
    expect(() => loadConfig({ PRINCIPIA_SECRETS_DIR: dir, PRINCIPIA_ADMIN_TOKEN: 'short' }, { consoleDir: '/c' })).toThrow(/32/)
    const w = loadConfig({ PRINCIPIA_SECRETS_DIR: dir, PRINCIPIA_PUBLIC_URL: 'http://cloud.example.com' }, { consoleDir: '/c' })
    expect(w.warnings.join(' ')).toMatch(/not https/)
  })

  it('the .env.example in cloud/ is the template the CLI prints', () => {
    expect(readFileSync(resolve(__dirname, '../../../../cloud/.env.example'), 'utf8')).toBe(ENV_TEMPLATE)
  })
})

describe('connect link, pair page and console CSP', () => {
  it('logs one connect link on first boot when no device is paired, and none after pairing', async () => {
    const h = await startHarness()
    try {
      const line = h.logs.find(l => l.startsWith('Connect link: '))!
      expect(line).toMatch(/^Connect link: http:\/\/127\.0\.0\.1:1\/pair#[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4} \(10 min\)$/)
      const code = line.split('#')[1]!.split(' ')[0]!
      const done = await h.call('POST', '/v1/pair/complete', { body: { code, deviceName: 'Mac', platform: 'darwin-arm64' } })
      expect(done.status).toBe(201)
      const l = h.app.connectLink()
      expect(l.link.startsWith(`${h.url}/pair#`)).toBe(true)
    } finally { await h.close() }
  })

  it('GET /pair is a static page with no script and a strict CSP', async () => {
    const h = await startHarness()
    try {
      const r = await h.call('GET', '/pair')
      expect(r.status).toBe(200)
      expect(r.text).toContain('Open Principia on your Mac → Cloud and paste this link')
      expect(r.text).not.toMatch(/<script/i)
      expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'/)
      expect(r.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/)
    } finally { await h.close() }
  })

  it('serves the console with CSP, no inline script, frame-ancestors none, and blocks traversal', async () => {
    const h = await startHarness()
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(h.dir, 'console'), { recursive: true })
      writeFileSync(join(h.dir, 'console', 'index.html'), '<!doctype html><title>c</title><script src="app.js"></script>')
      writeFileSync(join(h.dir, 'console', 'app.js'), 'console.log(1)')
      writeFileSync(join(h.dir, 'secret.txt'), 'nope')
      for (const p of ['/console/', '/console/app.js', '/console/runs']) {
        const r = await h.call('GET', p)
        expect(r.status).toBe(200)
        const csp = r.headers.get('content-security-policy')!
        expect(csp).toContain("default-src 'self'")
        expect(csp).toContain("frame-ancestors 'none'")
        expect(csp).not.toContain('unsafe-inline')
      }
      expect((await h.call('GET', '/console/..%2Fsecret.txt')).status).toBe(404)
      expect((await h.call('GET', '/console/missing.js')).status).toBe(404)
      const redirect = await h.call('GET', '/console')
      expect(redirect.status).toBe(302)
    } finally { await h.close() }
  })

  it('a console login link sets an HttpOnly SameSite=Strict cookie and redirects to /console/', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const link = await h.call('POST', '/v1/login-links', { token: dev })
      expect(link.status).toBe(201)
      expect(link.json.url).toMatch(/\/console\/login\?t=pll_/)
      const t = new URL(link.json.url).searchParams.get('t')!
      const r = await h.call('GET', `/console/login?t=${t}`)
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe('/console/')
      const c = r.headers.get('set-cookie')!
      expect(c).toMatch(/^principia_session=pss_/)
      expect(c).toContain('HttpOnly')
      expect(c).toContain('SameSite=Strict')
      expect(c).not.toContain('Secure')
      expect((await h.call('GET', `/console/login?t=${t}`)).status).toBe(400)
      const s = await consoleSession(h, dev)
      expect(s.csrf.length).toBeGreaterThan(20)
    } finally { await h.close() }
  })

  it('marks the cookie Secure when the public URL is https', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      h.app.ctx.config.publicUrl = 'https://cloud.example.com'
      const link = await h.call('POST', '/v1/login-links', { token: dev })
      const r = await h.call('GET', `/console/login?t=${new URL(link.json.url).searchParams.get('t')}`)
      expect(r.headers.get('set-cookie')).toContain('Secure')
    } finally { await h.close() }
  })
})

describe('PRINCIPIA_ADMIN_TOKEN_SHA256 (docs/MACHINES.md)', () => {
  it('takes 64 hex characters, lowercased, and refuses anything else', () => {
    const base = { PRINCIPIA_MASTER_KEY: 'b'.repeat(64), PRINCIPIA_SECRETS_DIR: mkdtempSync(join(tmpdir(), 'psec-')) }
    expect(loadConfig({ ...base, PRINCIPIA_ADMIN_TOKEN_SHA256: 'AB'.repeat(32) }, { consoleDir: '/c' }).config.adminTokenSha256).toBe('ab'.repeat(32))
    expect(loadConfig(base, { consoleDir: '/c' }).config.adminTokenSha256).toBeNull()
    expect(() => loadConfig({ ...base, PRINCIPIA_ADMIN_TOKEN_SHA256: 'not-a-hash' }, { consoleDir: '/c' })).toThrow(/64 hex/)
  })
})

describe('principia-cloud phone-link (docs/MACHINES.md §7, install.sh)', () => {
  it('waits for a paired device (exit 3), then prints a one-time console link for it', async () => {
    const { main } = await import('../main')
    const { openControlDb } = await import('../db')
    const data = mkdtempSync(join(tmpdir(), 'pdata-'))
    const env = { PRINCIPIA_DATA_DIR: data, PRINCIPIA_WORKSPACE: join(data, 'ws'), PRINCIPIA_SECRETS_DIR: join(data, 'secrets'), PRINCIPIA_MASTER_KEY: 'c'.repeat(64), PRINCIPIA_PUBLIC_URL: 'https://203-0-113-7.sslip.io' }
    const out: string[] = []
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main(['phone-link'], env)).toBe(3)
      expect(await main(['pair'], env)).toBe(0)
      const db = openControlDb(join(data, 'control.db'))
      const ws = db.get<{ id: string }>('SELECT id FROM workspace LIMIT 1')!
      db.run('INSERT INTO devices (id, workspace_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'dev_1', ws.id, 'Mac', 'darwin', 'h', '2026-11-26T00:00:00Z', null)
      db.close()
      expect(await main(['phone-link'], env)).toBe(0)
    } finally { w.mockRestore(); e.mockRestore() }
    expect(out.join('')).toMatch(/Connect link: https:\/\/203-0-113-7\.sslip\.io\/pair#/)
    expect(out.join('')).toMatch(/Phone link: https:\/\/203-0-113-7\.sslip\.io\/console\/login\?t=pll_/)
  })
})
