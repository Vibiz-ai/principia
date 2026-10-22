/**
 * COMPANY.md §4, §6 (C4): execution isolation over the real modules: keys (vault.ts), interactive sessions
 * (sessions.ts over CompanyStore through companyBridge.ts) and MCP gateway connections. Engine runs are covered with a
 * fake company module in engine/__tests__/passport.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the authoring wiring imports IPC, dialogs and notifications: no Electron in unit tests
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: { isSupported: () => false }
}))
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from '../company'
import { CompanySecrets } from '../db/companySecrets'
import { createCompanyBridge } from '../companyBridge'
import { Vault, type Cipher } from '../vault'
import { SessionManager, type PtyLike, type SessionDeps } from '../sessions'
import { GatewayService } from '../gateway/service'
import { wireAuthoring } from '../author/wire'
import type { Hive } from '../hive'
import type { InteractiveSpawnOptions, MemoryGrantRequest } from '../../shared/engine'
import { PERSONAL_COMPANY_ID } from '../../shared/company'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

const fakeCipher = (): Cipher => ({
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

class FakePty implements PtyLike {
  static last: FakePty
  pid = 4343
  constructor(
    public file: string,
    public args: string[],
    public opts: { cwd: string; env: Record<string, string> }
  ) {
    FakePty.last = this
  }
  exitCb: (e: { exitCode: number }) => void = () => {}
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  write() {}
  resize() {}
  kill() {}
}

let tmp: string
let db: DB
let store: Store
let company: CompanyStore
let vault: Vault
let secrets: CompanySecrets
let w: ReturnType<typeof seed>

function seed() {
  const mk = (name: string) => {
    const p = path.join(tmp, name)
    fs.mkdirSync(p, { recursive: true })
    return store.addRepo(p)[0]
  }
  const repoA = mk('acme-web')
  const repoB = mk('beta-api')
  const repoP = mk('side-project')
  const acme = company.create({ name: 'Acme', repoIds: [repoA.id] })
  const beta = company.create({ name: 'Beta', repoIds: [repoB.id] })
  vault.set('SHARED_KEY', 'shared-value-0001')
  vault.set('OPENAI_API_KEY', 'sk-shared-0001')
  secrets.set(acme.id, 'ACME_TOKEN', 'tok-acme-secret')
  secrets.set(acme.id, 'OPENAI_API_KEY', 'sk-acme-0002')
  secrets.set(beta.id, 'BETA_TOKEN', 'tok-beta-secret')
  vault.refreshRedactions() // company keys changed (KeyNamespaces' change listener does the same)
  return { repoA, repoB, repoP, acme, beta }
}
const enforce = (on: boolean) => store.updateSettings({ experimental: { companies: on } })

beforeEach(() => {
  if (!nativeOk) return
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-c4-')))
  db = openDatabase(':memory:')
  store = new Store(db)
  company = new CompanyStore(store, { companiesRoot: path.join(tmp, 'companies') })
  vault = new Vault(db, fakeCipher())
  secrets = new CompanySecrets(db, fakeCipher())
  w = seed()
})
afterEach(() => {
  if (!nativeOk) return
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

d('keys (COMPANY.md §4)', () => {
  it("'*' is every shared key plus this company's, never another company's; a company value overrides a shared one", () => {
    expect(vault.resolve(['*'], w.acme.id)).toEqual({ SHARED_KEY: 'shared-value-0001', OPENAI_API_KEY: 'sk-acme-0002', ACME_TOKEN: 'tok-acme-secret' })
    expect(vault.resolve(['*'], w.beta.id)).toEqual({ SHARED_KEY: 'shared-value-0001', OPENAI_API_KEY: 'sk-shared-0001', BETA_TOKEN: 'tok-beta-secret' })
    // no company (older callers, Personal without keys): shared only
    expect(vault.resolve(['*'])).toEqual({ SHARED_KEY: 'shared-value-0001', OPENAI_API_KEY: 'sk-shared-0001' })
    expect(vault.resolve(['*'], PERSONAL_COMPANY_ID)).toEqual({ SHARED_KEY: 'shared-value-0001', OPENAI_API_KEY: 'sk-shared-0001' })
    // naming another company's key does not reach it
    expect(vault.resolve(['ACME_TOKEN', 'SHARED_KEY'], w.beta.id)).toEqual({ SHARED_KEY: 'shared-value-0001' })
    expect(vault.names(['*'], w.acme.id)).toEqual(['ACME_TOKEN', 'OPENAI_API_KEY', 'SHARED_KEY'])
    expect(vault.names(['*'], w.beta.id)).not.toContain('ACME_TOKEN')
    expect(vault.names(['*'])).toEqual(['OPENAI_API_KEY', 'SHARED_KEY'])
  })

  it('redaction stays global: every company key is masked in any output, without KeyNamespaces', () => {
    const out = vault.redact('a tok-acme-secret b tok-beta-secret c sk-acme-0002 d shared-value-0001')
    expect(out).toBe('a ••••ACME_TOKEN b ••••BETA_TOKEN c ••••OPENAI_API_KEY d ••••SHARED_KEY')
    expect(vault.secretValues().map((v) => v.value)).toEqual(expect.arrayContaining(['tok-acme-secret', 'tok-beta-secret']))
  })
})

d('interactive sessions (COMPANY.md §6)', () => {
  let grants: MemoryGrantRequest[]
  let spawns: InteractiveSpawnOptions[]
  let trusted: string[]
  let authorCompanies: (string | null | undefined)[]
  let mgr: SessionManager
  beforeEach(() => {
    if (!nativeOk) return
    grants = []
    spawns = []
    trusted = []
    authorCompanies = []
    const paths = { userData: tmp, artifactsRoot: path.join(tmp, 'artifacts'), sessionLogsDir: path.join(tmp, 'logs'), scratchDir: path.join(tmp, 'scratch') }
    for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true })
    const deps: SessionDeps = {
      store,
      paths,
      spawnPty: (file, args, opts) => new FakePty(file, args, opts),
      interactiveSpawn: (_profile, opts) => {
        spawns.push(opts)
        return { file: '/bin/claude', args: [], agentSessionId: 'uuid-1' }
      },
      baseEnv: () => ({ PATH: '/usr/bin', HOME: '/Users/x' }),
      secrets: { resolve: (n, c) => vault.resolve(n, c), redact: (t) => vault.redact(t), names: (n, c) => vault.names(n, c) },
      company: createCompanyBridge(company, store),
      emitData: () => {},
      emitExit: () => {},
      emitUpdated: () => {},
      trustFolder: (cwd) => void trusted.push(cwd),
      memory: {
        grant: (req) => {
          grants.push(req)
          return null
        },
        release: () => {},
        transportFor: () => 'mcp',
        lastMode: () => null
      },
      live: { open: () => ({ dir: path.join(tmp, 'live'), hookCommand: '', mcpEnv: {}, onLine() {}, writeAnswer() {}, close() {} }), start() {}, data() {}, input() {}, exit() {} },
      author: {
        server: (_sid, _dir, companyId) => {
          authorCompanies.push(companyId)
          return null
        },
        tools: [],
        spawnDir: tmp
      }
    }
    mgr = new SessionManager(deps)
  })

  it("a repo-less chat runs in its company's workspace with that company's keys, Passport, memory and authoring scope", () => {
    const s = mgr.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24, memory: 'read' })
    const workspace = path.join(tmp, 'companies', w.acme.slug, 'workspace')
    expect(s).toMatchObject({ cwd: workspace, companyId: w.acme.id, title: 'Chat · Claude', repoId: null })
    expect(store.getSession(s.id)?.companyId).toBe(w.acme.id)
    expect(fs.statSync(workspace).isDirectory()).toBe(true)
    expect(trusted).toEqual([workspace])
    const env = FakePty.last.opts.env
    expect(env.ACME_TOKEN).toBe('tok-acme-secret')
    expect(env.OPENAI_API_KEY).toBe('sk-acme-0002')
    expect(env.BETA_TOKEN).toBeUndefined()
    expect(spawns[0]).toMatchObject({ companyId: w.acme.id, cwd: workspace })
    expect(spawns[0].keyNames).not.toContain('BETA_TOKEN')
    expect(grants[0].companyId).toBe(w.acme.id)
    expect(authorCompanies).toEqual([w.acme.id])
    // Restart keeps the company and the workspace (still trusted, still a chat)
    FakePty.last.exitCb({ exitCode: 0 })
    const again = mgr.restart(s.id)
    expect(again).toMatchObject({ cwd: workspace, companyId: w.acme.id, title: 'Chat · Claude' })
  })

  it("authoring tools list, read and run only the session's company workflows while enforced; a foreign company_id line is refused", async () => {
    const started: { companyId?: string | null }[] = []
    const hive = {
      db, store, vault, paths: { userData: tmp, scratchDir: path.join(tmp, 'scratch') }, runHooks: [], live: null, slack: null,
      settings: () => store.getSettings(),
      safe: <T,>(fn: () => T, fb: T): T => { try { return fn() } catch { return fb } },
      statusChanged() {}, onLiveEvent() {}, windows: { command() {} },
      engine: {
        providers: { cached: () => [] },
        workflows: { validate: () => [] },
        scheduler: { preview: () => ({ ok: true, sentence: '', next: [] }), upsert() {} },
        runs: { start: (_t: unknown, o: { companyId?: string | null }) => (started.push(o), { id: 'run_x' }) }
      }
    } as unknown as Hive
    wireAuthoring(hive, { mainDir: tmp, reaper: null })
    const node = { id: 'a', type: 'agent' as const, label: 'A', after: [], cwd: null, timeoutMin: 1, profileId: 'p', prompt: 'x' }
    const wfA = store.createWorkflow({ name: 'Acme flow', description: '', inputs: [], nodes: [node] }, null, null, w.acme.id)
    const wfB = store.createWorkflow({ name: 'Beta flow', description: '', inputs: [], nodes: [node] }, null, null, w.beta.id)
    const s = mgr.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    let n = 0
    const call = (tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
        const callId = `hac_${String(n++).padStart(10, '0')}`
        hive.author!.handleCall({ kind: 'session', sessionId: s.id } as never, { call_id: callId, tool, args, ...extra }, (_id, payload) => resolve(payload as never))
      })
    const names = async () => ((await call('hive_workflow_list')).result!.workflows as { name: string }[]).map((x) => x.name).sort()
    // off: guards warn, never hide
    expect(await names()).toEqual(['Acme flow', 'Beta flow'])
    enforce(true)
    expect(await names()).toEqual(['Acme flow'])
    expect(await call('hive_workflow_get', { id: wfB.id })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await call('hive_workflow_get', { id: wfA.id })).toMatchObject({ ok: true })
    expect(((await call('hive_repos_list')).result!.repos as { id: string }[]).map((r) => r.id)).toEqual([w.repoA.id])
    expect(await call('hive_workflow_list', {}, { company_id: w.beta.id })).toMatchObject({ ok: false, error: expect.stringMatching(/another company/) })
  })

  it('no explicit company: the repo decides; an unowned repo and a plain chat are Personal', () => {
    expect(mgr.create({ adapter: 'claude', repoId: w.repoB.id, cols: 80, rows: 24 }).companyId).toBe(w.beta.id)
    expect(mgr.create({ adapter: 'claude', repoId: w.repoP.id, cols: 80, rows: 24 }).companyId).toBe(PERSONAL_COMPANY_ID)
    const chat = mgr.create({ adapter: 'claude', cols: 80, rows: 24 })
    expect(chat).toMatchObject({ companyId: PERSONAL_COMPANY_ID, cwd: path.join(tmp, 'companies', 'personal', 'workspace') })
    expect(FakePty.last.opts.env.ACME_TOKEN).toBeUndefined()
  })

  it("enforced: a launch from Acme into Beta's repo or folder is refused; off: it warns and still stamps", () => {
    enforce(true)
    expect(() => mgr.create({ adapter: 'claude', companyId: w.acme.id, repoId: w.repoB.id, cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    fs.mkdirSync(path.join(w.repoB.path, 'src'))
    expect(() => mgr.create({ adapter: 'claude', companyId: w.acme.id, cwd: path.join(w.repoB.path, 'src'), cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    const betaWorkspace = company.workspaceDir(w.beta.id)
    expect(() => mgr.create({ adapter: 'claude', companyId: w.acme.id, cwd: betaWorkspace, cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    expect(spawns).toHaveLength(0)
    enforce(false)
    const s = mgr.create({ adapter: 'claude', companyId: w.acme.id, repoId: w.repoB.id, cols: 80, rows: 24 })
    expect(s.companyId).toBe(w.acme.id)
  })
})

d('MCP gateway connections (COMPANY.md §6)', () => {
  it("a connection limited to Acme never reaches Beta's spawns (by company id or by folder); absent companyIds = every company", () => {
    const gw = new GatewayService({
      userData: tmp,
      mainDir: tmp,
      cipher: fakeCipher(),
      vault: { addRedactions() {} },
      baseEnv: () => ({}),
      companies: { forCwd: (cwd) => company.companyForCwd(cwd).id, enforced: () => store.companyGuardsEnforced() }
    })
    try {
      enforce(true)
      gw.save({ id: 'acme-crm', name: 'Acme CRM', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global', companyIds: [w.acme.id] })
      expect(gw.list()[0].companyIds).toEqual([w.acme.id])
      expect(gw.attachment(w.repoA.path)).not.toBeNull()
      expect(gw.attachment(w.repoB.path)).toBeNull()
      expect(gw.attachment(w.repoP.path)).toBeNull()
      // the spawn's company wins over its folder: an Acme chat in its workspace yes, a Beta spawn anywhere no
      expect(gw.attachment(company.workspaceDir(w.acme.id), w.acme.id)).not.toBeNull()
      expect(gw.attachment(w.repoA.path, w.beta.id)).toBeNull()
      enforce(false)
      expect(gw.attachment(w.repoB.path)).not.toBeNull()
      enforce(true)
      gw.save({ id: 'acme-crm', name: 'Acme CRM', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global' })
      expect(gw.attachment(w.repoB.path)).not.toBeNull()
    } finally {
      gw.close()
    }
  })
})
