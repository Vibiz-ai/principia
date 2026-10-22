import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessSandbox, isSafeKeyName } from '../sandbox'
import { Redactor } from '../redact'
import { tmp } from './fakes'

const hostEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TZ: 'Europe/Madrid',
  SHELL: '/bin/sh',
  HOME: '/Users/owner',
  PRINCIPIA_SECRET: 'control-plane-secret-value',
  PRINCIPIA_MASTER_KEY: 'a'.repeat(64),
  OPEN_PASSPORT_ADMIN_TOKEN: 'admin-token-value',
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  OPENAI_API_KEY: 'sk-host-key-should-not-leak-0000',
  NODE_OPTIONS: '--require /evil.js'
}

describe('process sandbox: environment allowlist', () => {
  it('keeps only allowlisted host variables; nothing of the control plane leaks', () => {
    const root = tmp()
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv })
    const box = sb.prepare('crun_env1')
    const env = sb.buildEnv(box, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }, { ACME_KEY: 'acme-key-value', PATH: '/evil', PRINCIPIA_X: 'no' })
    expect(env.PRINCIPIA_SECRET).toBeUndefined()
    expect(Object.keys(env).filter((k) => /^(PRINCIPIA_|OPEN_PASSPORT_|TELEGRAM_|AWS_)/.test(k))).toEqual([])
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('control-plane-secret-value')
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.TZ).toBe('Europe/Madrid')
    expect(env.HOME).toBe(box.home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(box.home, '.claude'))
    expect(env.CODEX_HOME).toBe(join(box.home, '.codex'))
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test')
    expect(env.ACME_KEY).toBe('acme-key-value')
    expect(env.PRINCIPIA_X).toBeUndefined()
    // the base env (gateway upstreams, version checks) has a private neutral HOME, never the host's
    expect(sb.baseEnv().HOME).toBe(sb.neutralHome)
    expect(sb.baseEnv().HOME).not.toBe('/Users/owner')
  })

  it('run home is 0700 and is deleted by cleanup', () => {
    const root = tmp()
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv })
    const box = sb.prepare('crun_home')
    expect(statSync(box.home).mode & 0o777).toBe(0o700)
    expect(box.root).toBe(join(root, 'runtime', 'runs', 'crun_home'))
    writeFileSync(join(box.codexHome, 'auth.json'), '{}')
    sb.cleanup(box)
    expect(existsSync(box.home)).toBe(false)
    expect(existsSync(box.root)).toBe(true)
  })

  it('refuses unsafe ids and key names', () => {
    const root = tmp()
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv })
    expect(() => sb.prepare('../escape')).toThrow(/Invalid run id/)
    expect(() => sb.companyDir('a/b')).toThrow(/Invalid company id/)
    expect(isSafeKeyName('STRIPE_KEY')).toBe(true)
    for (const bad of ['PATH', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'GIT_ASKPASS', 'PRINCIPIA_TOKEN', 'lower', 'BASH_ENV']) expect(isSafeKeyName(bad)).toBe(false)
  })
})

describe('process sandbox: cwd confinement', () => {
  it('confines cwds to the company folder, following symlinks', () => {
    const root = tmp()
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv })
    const co = sb.companyDir('co_acme')
    mkdirSync(join(co, 'site'))
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(co, 'link'))
    const other = sb.companyDir('co_other')
    expect(sb.confine('co_acme', null)).toBe(co)
    expect(sb.confine('co_acme', 'site')).toBe(join(co, 'site'))
    expect(sb.confine('co_acme', join(co, 'site'))).toBe(join(co, 'site'))
    expect(() => sb.confine('co_acme', '../co_other')).toThrow(/outside the company/)
    expect(() => sb.confine('co_acme', other)).toThrow(/outside the company/)
    expect(() => sb.confine('co_acme', '/etc')).toThrow(/outside the company/)
    expect(() => sb.confine('co_acme', 'link')).toThrow(/leads outside/)
    expect(() => sb.confine('co_acme', '{{inputs.repo}}')).toThrow(/templates/)
    expect(() => sb.confine('co_acme', 'missing')).toThrow(/not found/)
  })

  it('removes a company folder only inside the workspace', () => {
    const root = tmp()
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv })
    const co = sb.companyDir('co_gone')
    writeFileSync(join(co, 'x'), 'x')
    sb.removeCompanyDir('co_gone')
    expect(existsSync(co)).toBe(false)
  })
})

describe('redactor', () => {
  it('masks seeded secrets, their JSON forms, file credentials and known token shapes', () => {
    const r = new Redactor()
    r.add('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz')
    r.add('acme-key-value', 'ACME_KEY')
    r.add('short')
    r.add(JSON.stringify({ tokens: { access_token: 'eyJhbGciOiJSUzI1NiJ9.access.token', refresh_token: 'rt_refresh_token_value_123456' }, last_refresh: '2026-10-21T10:00:00Z' }))
    r.add('line1 "quoted" secret value with quotes')
    const text = 'tok sk-ant-oat01-abcdefghijklmnopqrstuvwxyz key acme-key-value at short; rt_refresh_token_value_123456 eyJhbGciOiJSUzI1NiJ9.access.token ghp_0123456789abcdefghijklmn opk_abcdefghijklmnop0123 line1 \\"quoted\\" secret value with quotes 2026-10-21T10:00:00Z'
    const out = r.redact(text)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(out).toContain('••••ACME_KEY')
    expect(out).toContain('short')
    expect(out).not.toContain('rt_refresh_token_value_123456')
    expect(out).not.toContain('access.token')
    expect(out).not.toContain('ghp_0123')
    expect(out).not.toContain('opk_abcd')
    expect(out).not.toContain('secret value with quotes')
    expect(out).toContain('2026-10-21T10:00:00Z')
  })
})

describe('agent user (CLOUD.md §7.8): agents never run as the control plane', () => {
  it('hands the run home, the company folder and granted folders to the agent; the runtime folders are traverse-only', () => {
    const root = tmp()
    const owned: [string, number, number][] = []
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv, agentUser: { uid: 4242, gid: 4343 }, chown: (p, uid, gid) => void owned.push([p, uid, gid]) })
    expect(sb.spawnUser()).toEqual({ uid: 4242, gid: 4343 })
    expect(statSync(join(root, 'runtime')).mode & 0o777).toBe(0o711)
    expect(statSync(join(root, 'workspace')).mode & 0o777).toBe(0o711)
    expect(statSync(join(root, 'runtime', 'runs')).mode & 0o777).toBe(0o711)
    // the neutral home (version checks, gateway upstreams) stays the runtime's own
    expect(statSync(sb.neutralHome).mode & 0o777).toBe(0o700)

    const company = sb.companyDir('co_acme')
    expect(owned).toContainEqual([company, 4242, 4343])

    const box = sb.prepare('crun_user1')
    expect(statSync(box.root).mode & 0o777).toBe(0o711)
    writeFileSync(join(box.codexHome, 'auth.json'), '{}', { mode: 0o600 })
    owned.length = 0
    sb.handOver(box)
    const paths = owned.map(([p]) => p)
    expect(paths).toContain(box.home)
    expect(paths).toContain(join(box.codexHome, 'auth.json'))
    expect(owned.every(([, u, g]) => u === 4242 && g === 4343)).toBe(true)
    // symlinks are re-owned, never followed (a link to /secrets cannot hand /secrets over)
    symlinkSync('/etc', join(box.home, 'escape'))
    owned.length = 0
    sb.handOver(box)
    expect(owned.map(([p]) => p)).toContain(join(box.home, 'escape'))
    expect(owned.map(([p]) => p).some((p) => p.startsWith('/etc'))).toBe(false)
  })

  it('without an agent user nothing changes hands (the desktop, tests)', () => {
    const root = tmp()
    const owned: string[] = []
    const sb = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv, chown: (p) => void owned.push(p) })
    sb.handOver(sb.prepare('crun_user2'))
    sb.grant(sb.companyDir('co_acme'), true)
    expect(owned).toEqual([])
    expect(sb.spawnUser()).toBeNull()
  })

  it('step processes start as the given user (the engine spawn honors it)', async () => {
    const { startProcess } = await import('../../../main/engine/process')
    let out = ''
    const uid = process.getuid!()
    const gid = process.getgid!()
    const h = startProcess({ file: '/bin/sh', args: ['-c', 'id -u; id -g'], cwd: tmp(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000, onStdout: (c) => (out += c), onStderr: () => {}, user: { uid, gid } })
    expect((await h.done).exitCode).toBe(0)
    expect(out.trim().split('\n')).toEqual([String(uid), String(gid)])
  })
})
