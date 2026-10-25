/**
 * Five doors A1 release gate: the three-company leak test (the real-app version of the prototype's tools-r2/leak.js).
 * Northwind Coffee, Ledgerly App and Harbor Dental Group each own a full set of rows with a marker word only that
 * company uses: tasks, departments and agents (Team, Board), schedules and workflows (Automations), artifacts
 * (Files), keys (Keys), gateway connections (Connections), live agents with cost (Spend), a Forum (Forum and the
 * composer's @-suggestions), the chat brief (composer hints), chat sessions and runs (Chats, the terminal) and a
 * Knowledge vault. Every surface is read the way the renderer reads it, through the real IPC handlers behind ipc.ts's
 * zod validation (Knowledge through the same passport ops the memory:* handlers run), scoped to one company; the
 * test fails when a company's answer carries another company's marker.
 *
 * The renderer half (sidebar, status bar, palette, Home and Chats counts) is src/renderer/src/companyLeak.render.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcReply = { ok: boolean; data?: unknown; error?: { code: string; message: string } }
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcReply>>() }))
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn(), whenReady: () => Promise.resolve() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  shell: { openExternal: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString()
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<IpcReply>) => void ipc.handlers.set(channel, fn),
    removeHandler: (channel: string) => void ipc.handlers.delete(channel),
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  Notification: { isSupported: () => false }
}))
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { LiveStore } from '../db/liveStore'
import { Vault, type Cipher } from '../vault'
import { CompanySecrets } from '../db/companySecrets'
import { Dispatcher, HookedCompanyStore } from '../company/dispatcher'
import { ForumService } from '../forum/service'
import { registerCompanyHandlers } from '../handlers/company'
import { registerScheduleHandlers } from '../handlers/schedules'
import { registerWorkflowHandlers } from '../handlers/workflows'
import { registerArtifactHandlers } from '../handlers/artifacts'
import { registerSecretHandlers } from '../handlers/secrets'
import { registerRunHandlers } from '../handlers/runs'
import { registerSessionHandlers } from '../handlers/sessions'
import { registerUsageHandlers } from '../handlers/usage'
import { registerForumHandlers } from '../handlers/forum'
import { registerGatewayHandlers } from '../handlers/gateway'
import { Hive } from '../hive'
import { linksOp, graphOp, noteOp } from '../memory/passportIpc'
import { vaultSearch } from '../memory/search'
import { GX, makeHarness, NW, PERSONAL, type Harness } from '../memory/__tests__/fixtures/vault/harness'
import { nativeOk as vaultNativeOk } from '../memory/vault/__tests__/vaultTestKit'
import type { InvokeChannel, InvokeReq, InvokeRes } from '../../shared/ipc'
import type { CompanyPassport } from '../../shared/company'
import type { GatewayConnection } from '../../shared/gateway'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d_ = nativeOk && !process.versions.electron ? describe : describe.skip

/** The three companies of the fixture and the word only each one uses (lower case; matched case-insensitively). */
const COMPANIES = [
  { name: 'Northwind Coffee', marker: 'espresso' },
  { name: 'Ledgerly App', marker: 'ledgerline' },
  { name: 'Harbor Dental Group', marker: 'molarcare' }
] as const

interface Co {
  id: string
  name: string
  marker: string
  /** every id this company owns (a leaked id is a leak even without its words) */
  ids: string[]
}
interface World {
  dir: string
  db: DB
  store: Store
  c: HookedCompanyStore
  d: Dispatcher
  forum: ForumService
  cos: Co[]
}
let w: World

const redact = (s: string) => s
const fakeCipher = (): Cipher => ({
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})
const now = () => new Date().toISOString()

async function invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  const r = await fn({ sender: {} }, req)
  if (!r.ok) throw Object.assign(new Error(`${channel}: ${r.error!.message}`), { code: r.error!.code })
  return r.data as InvokeRes<C>
}

/** Another company's marker words, names and ids found in `value` (its JSON). Empty = no leak. */
function leaks(value: unknown, mine: Co): string[] {
  const text = JSON.stringify(value) ?? ''
  const low = text.toLowerCase()
  const out: string[] = []
  for (const o of w.cos) {
    if (o.id === mine.id) continue
    if (low.includes(o.marker)) out.push(`${o.name}: "${o.marker}"`)
    if (text.includes(o.name)) out.push(`${o.name}: its name`)
    for (const id of o.ids) if (text.includes(id)) out.push(`${o.name}: ${id}`)
  }
  return out
}

function seedCompany(c: HookedCompanyStore, store: Store, db: DB, live: LiveStore, secrets: CompanySecrets, name: string, marker: string, profileId: string): Co {
  const co: CompanyPassport = c.create({ name, mission: `We sell ${marker} things` })
  const ids: string[] = [co.id]
  const dep = c.departments.save({ companyId: co.id, name: `${marker} desk`, key: `${marker}-desk` })
  const seat = c.departments.saveAgent({ companyId: co.id, departmentId: dep.id, kind: 'profile', refId: profileId, name: `${marker} writer`, data: { autonomy: 'manual' } })
  ids.push(dep.id, seat.id)
  const task = c.createTask({ title: `${marker} launch plan`, description: `the ${marker} brief`, companyId: co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: dep.id, agentId: seat.id })
  ids.push(task.id)
  // Automations: a workflow and a schedule of this company
  const wf = store.createWorkflow({ name: `${marker} weekly review`, description: `${marker} review`, inputs: [], nodes: [{ id: 'n1', label: `${marker} step`, adapter: 'shell', prompt: 'echo hi', cwd: null, profileId: null, dependsOn: [] }] } as never, null, null, co.id)
  ids.push(wf.id)
  const schId = `sch_${marker}`
  db.prepare("INSERT INTO schedules(id,name,target_json,when_json,enabled,created_at,updated_at,company_id) VALUES(?,?,?,?,1,?,?,?)").run(schId, `${marker} monday check`, JSON.stringify({ kind: 'workflow', workflowId: wf.id, inputs: {} }), JSON.stringify({ kind: 'cron', cron: '0 9 * * 1', tz: 'UTC' }), now(), now(), co.id)
  ids.push(schId)
  // Chats and the terminal: a session; a run (with an artifact: Files)
  const sessId = `session_${marker}`
  db.prepare("INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,NULL,?,'running',80,24,?,?,?,?)").run(sessId, `${marker} chat`, profileId, 'claude', w.dir, now(), w.dir, path.join(w.dir, `${marker}.log`), co.id)
  const runId = `run_${marker}`
  db.prepare("INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt',?,?,'manual','running',?,?,?)").run(runId, `${marker} research`, JSON.stringify({ kind: 'prompt', profileId, repoId: null, prompt: `${marker} research` }), now(), w.dir, co.id)
  const artId = `art_${marker.slice(0, 8)}`
  db.prepare("INSERT INTO artifacts(id,run_id,session_id,path,rel_path,name,kind,mime,bytes,mtime,created_at,company_id) VALUES(?,?,NULL,?,?,?,'markdown','text/markdown',10,?,?,?)").run(artId, runId, path.join(w.dir, `${marker}-report.md`), `${marker}-report.md`, `${marker}-report.md`, now(), now(), co.id)
  ids.push(sessId, runId, artId)
  // Spend: a live root agent with a cost, filed under this company
  const agentId = `agent_${marker}`
  live.insertAgent({ id: agentId, kind: 'step', parentId: null, rootId: agentId, sessionId: null, runId, stepId: null, provider: 'claude', repoId: null, cwd: w.dir, title: `${marker} research step`, agentType: null, externalId: null, toolUseId: null, model: 'claude-sonnet', depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: `reading ${marker} notes`, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: 1000, tokensOut: 100, costUsd: 0.42, modelUsage: null, report: null, startedAt: now(), updatedAt: now(), endedAt: null, companyId: co.id })
  ids.push(agentId)
  // Keys: a company secret
  secrets.set(co.id, `${marker.toUpperCase()}_TOKEN`, `${marker}-secret-value`)
  return { id: co.id, name, marker, ids }
}

d_('A1: three companies, nothing of one reaches another', () => {
  beforeAll(() => {
    ipc.handlers.clear()
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'principia-leak-')))
    const db = openDatabase(path.join(dir, 'hive.db'))
    const store = new Store(db)
    store.updateSettings({ experimental: { companies: true, departments: true } })
    const c = new HookedCompanyStore(store, { companiesRoot: path.join(dir, 'companies') })
    const d = new Dispatcher({ company: c, startRun: () => { throw new Error('no runs in the leak test') }, cancelRun: async () => undefined, enabled: () => true, sessions: null })
    c.hooks = d.hooks()
    w = { dir, db, store, c, d, forum: null as unknown as ForumService, cos: [] }
    const live = new LiveStore(db, redact)
    const secrets = new CompanySecrets(db, fakeCipher())
    const profileId = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false }).id
    w.cos = COMPANIES.map((x) => seedCompany(c, store, db, live, secrets, x.name, x.marker, profileId))
    // the Forum, over the same db, with the company module as its directory (wire.ts's shape)
    w.forum = new ForumService({
      db,
      enabled: () => true,
      emit: () => undefined,
      redact,
      directory: {
        departments: (id) => c.departments.list(id, { includeArchived: true }).map((x) => ({ id: x.id, key: x.key, name: x.name, archivedAt: x.archivedAt })),
        agents: (id) => c.departments.listAgents({ companyId: id, includeArchived: true }).map((a) => ({ id: a.id, departmentId: a.departmentId, name: a.name, archivedAt: a.archivedAt, personaName: null })),
        ownerName: () => 'Founder',
        hasCompany: (id) => c.listPassports({ includeArchived: true }).some((p) => p.id === id)
      }
    })
    for (const co of w.cos) {
      w.forum.state(co.id)
      const me = w.forum.me(co.id)
      const general = w.forum.store.channelByName(co.id, 'general')!
      const m = w.forum.store.post(me.id, { channelId: general.id, text: `Kickoff: the ${co.marker} rollout starts Monday` })
      co.ids.push(general.id, m.id)
    }
    // Connections: one shared, one per company (only that company's agents get it)
    const connections: GatewayConnection[] = [
      { id: 'shared-notion', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com', enabled: true, roots: [], hasCredentials: false },
      ...w.cos.map<GatewayConnection>((co) => ({ id: `conn-${co.marker}`, name: `${co.marker} CRM`, transport: 'http', url: `https://${co.marker}.example.com/mcp`, enabled: true, roots: [], companyIds: [co.id], hasCredentials: true }))
    ]
    w.cos.forEach((co) => co.ids.push(`conn-${co.marker}`))
    const vault = new Vault(db, fakeCipher())
    const host = {
      store, db, company: c, dispatcher: d, runHooks: [], paths: { userData: dir, artifacts: path.join(dir, 'artifacts') },
      settings: () => store.getSettings(), vault, statusChanged: () => undefined, safe: <T,>(f: () => T, fb: T) => { try { return f() } catch { return fb } },
      engine: { runs: { start: () => { throw new Error('no runs') }, cancel: async () => undefined } },
      forum: w.forum,
      gateway: { list: () => connections },
      sessions: { create: () => { throw new Error('no spawns') } },
      history: null, taskWork: null, worktrees: null, memory: null
    }
    for (const register of [registerCompanyHandlers, registerScheduleHandlers, registerWorkflowHandlers, registerArtifactHandlers, registerSecretHandlers, registerRunHandlers, registerSessionHandlers, registerUsageHandlers, registerForumHandlers, registerGatewayHandlers])
      register(host as unknown as Hive)
    ;(w as unknown as { host: unknown }).host = host
  })
  afterAll(() => {
    w.d.dispose()
    w.db.close()
    fs.rmSync(w.dir, { recursive: true, force: true })
  })

  /** One surface: what its view loads for company `co`. */
  const SURFACES: [string, (co: Co) => Promise<unknown>][] = [
    ['Board (tasks:list)', (co) => invoke('tasks:list', { companyId: co.id })],
    ['Team (departments:list)', (co) => invoke('departments:list', { companyId: co.id })],
    ['Team (companyAgents:list)', (co) => invoke('companyAgents:list', { companyId: co.id })],
    ['Automations (schedules:list)', (co) => invoke('schedules:list', { companyId: co.id })],
    ['Automations (workflows:list)', (co) => invoke('workflows:list', { companyId: co.id })],
    ['Files (artifacts:list)', (co) => invoke('artifacts:list', { companyId: co.id, limit: 2000 })],
    ['Keys (secrets:list)', (co) => invoke('secrets:list', { companyId: co.id })],
    ['Connections (gateway:list)', (co) => invoke('gateway:list', { companyId: co.id })],
    ['Spend (usage:summary)', (co) => invoke('usage:summary', { range: '30d', companyId: co.id })],
    ['Forum (forum:state, composer @-suggestions)', (co) => invoke('forum:state', { companyId: co.id })],
    ['Forum (forum:messages)', async (co) => invoke('forum:messages', { companyId: co.id, channelId: w.forum.store.channelByName(co.id, 'general')!.id })],
    // searching another company's word inside this company finds nothing
    ['Forum (forum:search)', async (co) => Promise.all(w.cos.filter((o) => o.id !== co.id).map((o) => invoke('forum:search', { companyId: co.id, query: o.marker })))],
    ['Chats and the terminal (sessions:list)', (co) => invoke('sessions:list', { status: 'all', companyId: co.id })],
    ['Chats and the terminal (runs:list)', (co) => invoke('runs:list', { companyId: co.id, limit: 300 })],
    ['Composer hints (the chat brief a new chat starts with)', async (co) => Hive.prototype.chatContext.call((w as unknown as { host: Hive }).host, { companyId: co.id, departmentId: null, adapter: 'claude' })]
  ]

  for (const [surface, load] of SURFACES) {
    it(`${surface}: each company sees only its own rows`, async () => {
      for (const co of w.cos) {
        const got = await load(co)
        // the surface is not empty for its own company: a leak test that reads nothing proves nothing
        if (!/forum:search/.test(surface)) expect(JSON.stringify(got).toLowerCase(), `${surface} for ${co.name} shows its own rows`).toMatch(new RegExp(`${co.marker}|${co.id}`))
        expect(leaks(got, co), `${surface} for ${co.name}`).toEqual([])
      }
    })
  }

  it('the seeded install really holds all three companies (the matrix above is not vacuous)', async () => {
    const everything = JSON.stringify([await invoke('tasks:list', {}), await invoke('schedules:list', {}), await invoke('artifacts:list', {})]).toLowerCase()
    for (const co of w.cos) expect(everything).toContain(co.marker)
  })
})

/** Knowledge: the per-company vaults, through the passport ops behind memory:note / memory:links / memory:graph. */
const dv = vaultNativeOk ? describe : describe.skip
dv('A1: Knowledge (three vaults)', () => {
  let h: Harness
  const MARK: Record<string, string> = { [NW]: 'espresso', [GX]: 'ledgerline', [PERSONAL]: 'molarcare' }
  beforeAll(async () => {
    h = makeHarness()
    for (const co of [NW, GX, PERSONAL]) {
      h.rt.ensure(co)
      const m = MARK[co]!
      const res = await h.rt.applyOps(co, [
        { op: 'createNote', title: `${m} brand voice`, type: 'concept', summary: `How ${m} sounds` },
        { op: 'observe', note: `${m} brand voice`, category: 'convention', text: `Always say ${m} in the first line` },
        { op: 'relate', from: `${m} brand voice`, rel: 'depends_on', to: `${m} audience` }
      ], { kind: 'user' })
      expect(res.results.every((r) => r.status === 'ok')).toBe(true)
    }
  })
  afterAll(() => h.close())

  const others = (co: string) => Object.entries(MARK).filter(([id]) => id !== co).map(([, m]) => m)
  it('tree, tags, ghosts, graph, a note and search show the company’s own vault only', async () => {
    for (const co of [NW, GX, PERSONAL]) {
      const tree = linksOp(h.rt, { op: 'tree', companyId: co } as never, redact) as unknown as { path: string; title: string }[]
      const own = tree.find((e) => e.title.toLowerCase().includes(MARK[co]!))!
      const views: unknown[] = [
        tree,
        linksOp(h.rt, { op: 'tags', companyId: co } as never, redact),
        linksOp(h.rt, { op: 'ghosts', companyId: co, limit: 500 } as never, redact),
        graphOp(h.rt, { op: 'global', companyId: co } as never),
        await noteOp(h.rt, { op: 'get', companyId: co, path: own.path } as never, redact),
        ...others(co).map((m) => vaultSearch(h.rt.db, { companyId: co }, m, { limit: 20 }))
      ]
      const text = JSON.stringify(views).toLowerCase()
      expect(text, `${co} shows its own notes`).toContain(MARK[co]!)
      for (const m of others(co)) expect(text.includes(m), `${co} must not show "${m}"`).toBe(false)
    }
  })
})
