/**
 * AUTOPILOT.md §6-§7 in main: playbooks (turn on, levels refused in code, pause, guard after a run, company
 * isolation) and the "N tasks will start" guard on the Autopilot switch.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from './index'
import { Playbooks, type PlaybookScheduleOps } from './playbooks'
import { autopilotPreview, boardActions } from '../handlers/board'
import { newCompanyAutopilotOn } from './newCompany'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import crypto from 'node:crypto'
import { GatewayService } from '../gateway/service'
import type { Vault } from '../vault'
import type { Schedule, ScheduleInput } from '../../shared/types'

let db: DB
let store: Store
let c: CompanyStore
let dir: string
let p: Playbooks
let schedules: Map<string, Schedule>
let seq = 0

function ops(): PlaybookScheduleOps {
  const write = (id: string, input: ScheduleInput, companyId: string | null, prev?: Schedule): Schedule => {
    const s: Schedule = { id, name: input.name, target: input.target, departmentId: input.departmentId ?? null, when: input.when, preset: input.preset ?? null, enabled: input.enabled ?? true, sentence: '', lastFireAt: prev?.lastFireAt ?? null, lastRunId: null, lastRunStatus: null, nextFireAt: '2026-10-21T09:00:00.000Z', createdAt: '', updatedAt: '', companyId: companyId ?? undefined }
    schedules.set(id, s)
    return s
  }
  return {
    create: ({ companyId, ...input }) => write(`sch_${++seq}`, input, companyId),
    update: (id, input) => write(id, input, schedules.get(id)!.companyId ?? null, schedules.get(id)),
    setEnabled: (id, enabled) => {
      const s = { ...schedules.get(id)!, enabled }
      schedules.set(id, s)
      return s
    },
    remove: (id) => void schedules.delete(id),
    get: (id) => schedules.get(id) ?? null
  }
}

function company(name: string, depts = true) {
  const co = c.create({ name })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  if (!depts) return { co, profile, marketing: null, agent: null }
  const marketing = c.departments.save({ companyId: co.id, name: 'Marketing', key: 'marketing' })
  const agent = c.departments.saveAgent({ companyId: co.id, departmentId: marketing.id, kind: 'profile', refId: profile.id, name: 'Growth', data: { autonomy: 'auto' } })
  return { co, profile, marketing, agent }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-playbooks-'))
  db = openDatabase(path.join(dir, 'test.db'))
  store = new Store(db)
  c = new CompanyStore(store)
  schedules = new Map()
  p = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => true, tz: () => 'Europe/Madrid', now: () => new Date('2026-10-20T10:00:00.000Z') })
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('turning a playbook on', () => {
  it('creates one enabled task-mode schedule for the department agent, with the level in its prompt', () => {
    const { co, agent } = company('Sunday Bakery')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    expect(v).toMatchObject({ on: true, level: 1, raised: false, running: true, agentId: agent!.id, agentName: expect.any(String), limits: { maxChanges: 3, budgetCapUsd: 50 } })
    const s = schedules.get(v.scheduleId!)!
    expect(s).toMatchObject({ name: 'Ads watch & creative refresh', enabled: true, companyId: co.id, departmentId: agent!.departmentId })
    expect(s.target).toMatchObject({ kind: 'prompt', mode: 'task', agentId: agent!.id })
    expect(s.target.kind === 'prompt' && s.target.prompt).toContain('Level 1, watch and report')
    expect(p.isOn(co.id, 'ads-watch')).toBe(true)
    // on again changes the level, never makes a second schedule
    p.turnOn(co.id, 'ads-watch', { level: 2 })
    expect(schedules.size).toBe(1)
    expect(p.view(co.id, 'ads-watch').level).toBe(2)
  })
  it('refuses a money playbook above Level 2 without the founder’s explicit raise, and keeps the raise only at Level 3', () => {
    const { co } = company('Sunday Bakery')
    expect(() => p.turnOn(co.id, 'ads-watch', { level: 3 })).toThrow(/moves money/)
    expect(schedules.size).toBe(0)
    p.turnOn(co.id, 'ads-watch', { level: 1 })
    expect(() => p.configure(co.id, 'ads-watch', { level: 3 })).toThrow(/moves money/)
    const raised = p.configure(co.id, 'ads-watch', { level: 3, raise: true, limits: { budgetCapUsd: 80 } })
    expect(raised).toMatchObject({ level: 3, raised: true, limits: { budgetCapUsd: 80 } })
    const s = schedules.get(raised.scheduleId!)!
    expect(s.target.kind === 'prompt' && s.target.prompt).toContain('$80')
    // lowering drops the raise: going back to 3 needs a new explicit raise
    p.configure(co.id, 'ads-watch', { level: 2 })
    expect(p.view(co.id, 'ads-watch').raised).toBe(false)
    expect(() => p.configure(co.id, 'ads-watch', { level: 3 })).toThrow(/moves money/)
    // a playbook that moves no money may go to Level 3
    expect(p.turnOn(co.id, 'site-watch', { level: 3 }).level).toBe(3)
  })
  it('needs an agent, departments and a real company', () => {
    const bare = company('No team', false)
    expect(() => p.turnOn(bare.co.id, 'ads-watch', { level: 1 })).toThrow(/Hire an agent first/)
    const off = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => false })
    const { co } = company('Acme')
    expect(() => off.turnOn(co.id, 'ads-watch', { level: 1 })).toThrow(/Turn on departments/)
    expect(() => p.turnOn(co.id, 'make-money' as never, { level: 1 })).toThrow(/Unknown autopilot/)
  })
  it('pause, resume and turn off act on exactly its schedule', () => {
    const { co } = company('Sunday Bakery')
    const v = p.turnOn(co.id, 'social-rhythm', { level: 2 })
    expect(p.setPaused(co.id, 'social-rhythm', true)).toMatchObject({ running: false, nextRunAt: null })
    expect(schedules.get(v.scheduleId!)!.enabled).toBe(false)
    // paused still counts as on: it is never offered again
    expect(p.isOn(co.id, 'social-rhythm')).toBe(true)
    expect(p.setPaused(co.id, 'social-rhythm', false).running).toBe(true)
    p.turnOff(co.id, 'social-rhythm')
    expect(schedules.size).toBe(0)
    expect(p.isOn(co.id, 'social-rhythm')).toBe(false)
  })
  it('a schedule deleted on the Schedules page turns the playbook off; Turn on makes a fresh one', () => {
    const { co } = company('Sunday Bakery')
    const v = p.turnOn(co.id, 'site-watch', { level: 1 })
    schedules.delete(v.scheduleId!)
    expect(p.isOn(co.id, 'site-watch')).toBe(false)
    expect(p.turnOn(co.id, 'site-watch', { level: 1 }).on).toBe(true)
  })
})

describe('company isolation', () => {
  it('one company’s playbook is never another’s, and an agent of another company is refused', () => {
    const a = company('Sunday Bakery')
    const b = company('Harbor Dental')
    p.turnOn(a.co.id, 'ads-watch', { level: 1 })
    expect(p.isOn(b.co.id, 'ads-watch')).toBe(false)
    expect(p.list(b.co.id).every((v) => !v.on)).toBe(true)
    expect(() => p.turnOn(b.co.id, 'site-watch', { level: 1, agentId: a.agent!.id })).toThrow(/active agent of this company/)
    expect(() => p.setPaused(b.co.id, 'ads-watch', true)).toThrow(/is not on/)
    p.turnOff(b.co.id, 'ads-watch')
    expect(p.isOn(a.co.id, 'ads-watch')).toBe(true)
  })
})

describe('the guard after a playbook run', () => {
  const run = (id: string, companyId: string, scheduleId: string | null, taskId: string | null = null) =>
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,schedule_id,task_id) VALUES(?,'prompt','Ads',?,'schedule','passed',?,?,?,?,?)`).run(id, '{}', '2026-10-20T10:00:00.000Z', dir, companyId, scheduleId, taskId)
  const tools = (runId: string, names: string[]) => {
    db.prepare(`INSERT INTO agents(id,kind,root_id,run_id,provider,cwd,title,status,started_at,updated_at) VALUES(?,'step',?,?,'claude','/','Ads','done','x','x')`).run(`ag_${runId}`, `ag_${runId}`, runId)
    for (const n of names) db.prepare(`INSERT INTO agent_events(agent_id,ts,kind,name,summary) VALUES(?,'x','tool',?,'')`).run(`ag_${runId}`, n)
  }
  it('a run at Level 1 that changed an ad pauses the playbook and says why; reading is fine', () => {
    const { co } = company('Sunday Bakery')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    run('run_ok', co.id, v.scheduleId)
    tools('run_ok', ['mcp__meta_ads__get_insights', 'Read'])
    expect(p.guardRun('run_ok')).toBeNull()
    run('run_bad', co.id, v.scheduleId)
    tools('run_bad', ['mcp__meta_ads__get_insights', 'mcp__meta_ads__update_adset_budget'])
    const g = p.guardRun('run_bad')!
    expect(g).toMatchObject({ companyId: co.id, id: 'ads-watch', refused: [{ tool: 'mcp__meta_ads__update_adset_budget' }] })
    expect(p.view(co.id, 'ads-watch')).toMatchObject({ running: false, pausedWhy: 'Paused by Principia: Ads watch tried to change a budget with Meta Ads (update adset budget), in an amount Principia could not read; refused.' })
  })
  it('finds the playbook through its standing card too, and ignores runs of other companies or no playbook', () => {
    const { co, agent, marketing } = company('Sunday Bakery')
    const v = p.turnOn(co.id, 'ads-watch', { level: 2 })
    const card = c.createTask({ title: 'Recurring: Ads watch', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'schedule', sourceUrl: null, externalId: v.scheduleId, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id })
    run('run_card', co.id, null, card.id)
    expect(p.forRun('run_card')).toEqual({ companyId: co.id, id: 'ads-watch' })
    const other = company('Harbor Dental')
    run('run_other', other.co.id, v.scheduleId)
    expect(p.forRun('run_other')).toBeNull()
    run('run_none', co.id, null)
    expect(p.guardRun('run_none')).toBeNull()
  })
})

describe('the guard before each call through the connections gateway', () => {
  const run = (id: string, companyId: string, scheduleId: string | null) =>
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,schedule_id) VALUES(?,'prompt','Ads',?,'schedule','running',?,?,?,?)`).run(id, '{}', '2026-10-20T10:00:00.000Z', dir, companyId, scheduleId)
  it('checks every call of a playbook run whatever the connection is called, before it happens', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1, limits: { budgetCapUsd: 30 } })
    run('run_gw', co.id, v.scheduleId)
    const call = (connection: string, tool: string, args: unknown = {}) => p.gatewayCall({ runId: 'run_gw', companyId: co.id, connection, tool, args, connector: 'meta' })
    // reading is fine on any server
    expect(call('meta', 'get_insights')).toBeNull()
    expect(call('pipeboard', 'search_ads_archive')).toBeNull()
    // a server named "meta" (no "ads" in it) is checked as much as "meta_ads"
    expect(call('meta', 'pause_ad')).toMatch(/Level 1 only watches/)
    expect(call('meta', 'update_campaign')).toMatch(/Level 1/)
    expect(call('meta', 'set_daily_budget', { daily_budget: 80 })).toMatch(/No new spend/)
    // a tool Principia cannot place counts as a change, never as a read
    expect(call('meta', 'frobnicate_things')).toMatch(/Level 1/)
    expect(call('meta', 'duplicate_ad_set')).toMatch(/never creates new campaigns/)
    // nothing ran, so nothing is paused; the calls are recorded and the offers see them
    expect(p.view(co.id, 'ads-watch').running).toBe(true)
    expect(p.gatewayToolsOf('run_gw')).toEqual(['mcp__meta__get_insights', 'mcp__pipeboard__search_ads_archive'])
  })
  it('a raised Level 3 changes a budget within the cap (the amount from the call), and refuses one above it', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 3, raise: true, limits: { budgetCapUsd: 30, maxChanges: 2, targets: ['a', 'b', '1'] } })
    run('run_l3', co.id, v.scheduleId)
    const call = (tool: string, args: unknown) => p.gatewayCall({ runId: 'run_l3', companyId: co.id, connection: 'meta', tool, args, connector: 'meta' })
    // a change carrying a budget is money, whatever the tool is called (Meta counts in cents)
    expect(call('update_adset', { adset_id: 'a', daily_budget: 8000 })).toMatch(/\$30/)
    expect(call('update_adset', { adset_id: 'a', daily_budget: 2500 })).toBeNull()
    expect(call('set_daily_budget', { adset_id: 'b', daily_budget: 8000 })).toMatch(/\$30/)
    // the same ad set again replaces its amount: $5 + $25 = $30, at the cap
    expect(call('set_daily_budget', { adset_id: 'b', daily_budget_cents: 500 })).toBeNull()
    // two changes a run: the third is refused
    expect(call('pause_ad', { ad_id: '1' })).toMatch(/more than 2 changes/)
    expect(call('set_daily_budget', { adset_id: 'a' })).toMatch(/amount Principia can read|more than 2/)
  })
  it('counts posts across the week: Level 3 social posting stops at 3', () => {
    const { co } = company('Harlow')
    const v = p.turnOn(co.id, 'social-rhythm', { level: 3, limits: { maxChanges: 5 } })
    run('run_s1', co.id, v.scheduleId)
    run('run_s2', co.id, v.scheduleId)
    for (let i = 0; i < 2; i++) expect(p.gatewayCall({ runId: 'run_s1', companyId: co.id, connection: 'instagram', tool: 'publish_post' })).toBeNull()
    expect(p.gatewayCall({ runId: 'run_s2', companyId: co.id, connection: 'linkedin', tool: 'share' })).toBeNull()
    expect(p.gatewayCall({ runId: 'run_s2', companyId: co.id, connection: 'linkedin', tool: 'share' })).toMatch(/At most 3 posts a week/)
  })
  it('a run that is not a playbook’s is only recorded, never refused', () => {
    const { co } = company('Ledgerline')
    run('run_free', co.id, null)
    expect(p.gatewayCall({ runId: 'run_free', companyId: co.id, connection: 'meta', tool: 'create_campaign' })).toBeNull()
    expect(p.gatewayCall({ runId: null, companyId: co.id, connection: 'meta', tool: 'create_campaign' })).toBeNull()
    expect(p.gatewayToolsOf('run_free')).toEqual(['mcp__meta__create_campaign'])
  })
})

describe('a playbook that needs a connection', () => {
  it('turned on without it, waits paused, says so, and starts once the connection is there', () => {
    let conns: string[] = []
    p = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => true, connections: () => conns, now: () => new Date('2026-10-20T10:00:00.000Z') })
    const { co } = company('Ledgerline')
    expect(p.view(co.id, 'ads-watch').needs).toMatchObject({ connectId: 'meta-ads' })
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    expect(v).toMatchObject({ on: true, running: false, waiting: { connectId: 'meta-ads' }, pausedWhy: expect.stringMatching(/^Waiting for/) })
    expect(schedules.get(v.scheduleId!)!.enabled).toBe(false)
    expect(p.wakeWaiting(co.id)).toEqual([])
    conns = ['meta', 'Meta']
    expect(p.wakeWaiting(co.id)).toEqual(['ads-watch'])
    expect(p.view(co.id, 'ads-watch')).toMatchObject({ running: true, waiting: null })
    // a pause by the founder is never lifted by a connection
    p.setPaused(co.id, 'ads-watch', true)
    expect(p.wakeWaiting(co.id)).toEqual([])
    // the summary every surface reads
    expect(p.summary()[co.id]).toEqual([{ id: 'ads-watch', level: 1, running: false, waiting: false }])
  })
})

describe('"N tasks will start" before Autopilot goes on', () => {
  const flags = { experimental: { companies: true, departments: true } }
  it('counts the To do work of agents that act on their own, and refuses to turn on silently', () => {
    const { co, agent, marketing } = company('Sunday Bakery')
    const a = boardActions({ company: c, settings: () => flags, engine: { runs: { cancel: async () => undefined } } })
    const task = (title: string, extra: Record<string, unknown> = {}) => c.createTask({ title, description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id, ...extra })
    expect(autopilotPreview(c, co.id).count).toBe(0)
    // nothing waits: it turns on without a confirm
    expect(a.autopilot({ companyId: co.id, on: true }).autopilot).toBe(true)
    a.autopilot({ companyId: co.id, on: false })
    task('Old leftover one')
    task('Old leftover two')
    task('Later', { status: 'backlog' })
    const pre = a.autopilotPreview({ companyId: co.id })
    expect(pre).toMatchObject({ count: 2, maxInFlight: 0 })
    expect(pre.tasks.map((t) => t.title)).toEqual(['Old leftover one', 'Old leftover two'])
    expect(() => a.autopilot({ companyId: co.id, on: true })).toThrow(/2 tasks will start/)
    expect(c.boardSettings(co.id).autopilot).toBe(false)
    expect(a.autopilot({ companyId: co.id, on: true, confirmed: true }).autopilot).toBe(true)
    // already on (a tasks-at-once change) needs no confirm; another company's work is not counted
    expect(a.autopilot({ companyId: co.id, on: true, maxInFlight: 5 }).maxInFlight).toBe(5)
    const other = company('Harbor Dental')
    expect(autopilotPreview(c, other.co.id).count).toBe(0)
  })
  it('a manual agent’s work is not counted (Autopilot does not start it)', () => {
    const { co, profile, marketing } = company('Sunday Bakery')
    const manual = c.departments.saveAgent({ companyId: co.id, departmentId: marketing!.id, kind: 'profile', refId: profile.id, name: 'Careful', data: { autonomy: 'manual' } })
    c.createTask({ title: 'Waits for Start', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing!.id, agentId: manual.id })
    expect(autopilotPreview(c, co.id).count).toBe(0)
  })
})

describe('Autopilot on by default for new companies', () => {
  it('a company just created gets Autopilot on with no limit on tasks at once; existing ones, Personal and one with work keep theirs', () => {
    const fresh = newCompanyAutopilotOn(c, c.create({ name: 'New Bakery' }))
    expect(fresh.autopilot).toBe(true)
    expect(c.boardSettings(fresh.id)).toEqual({ companyId: fresh.id, autopilot: true, maxInFlight: 0 })
    // an existing company is never touched (only the create paths call this)
    const old = c.create({ name: 'Old Shop' })
    expect(c.boardSettings(old.id).autopilot).toBe(false)
    // a company that already holds work is left off: its old tasks never start silently
    const busy = c.create({ name: 'Busy' })
    c.createTask({ title: 'Leftover', description: '', companyId: busy.id, repoId: null, status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [] })
    expect(newCompanyAutopilotOn(c, busy).autopilot).toBeFalsy()
    const personal = c.listPassports().find((x) => x.id === PERSONAL_COMPANY_ID)
    if (personal) expect(newCompanyAutopilotOn(c, personal).autopilot).toBeFalsy()
  })
})

describe('PM review: refused before the ads server, counted in total, and shown to the founder', () => {
  const run = (id: string, companyId: string, scheduleId: string | null, taskId: string | null = null) =>
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,schedule_id,task_id) VALUES(?,'prompt','Ads',?,'schedule','running',?,?,?,?,?)`).run(id, '{}', '2026-10-20T10:00:00.000Z', dir, companyId, scheduleId, taskId)

  it('through the real gateway, the bypass calls never reach the ads server; reads do, and each refusal leaves a line', async () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1, limits: { budgetCapUsd: 10 } })
    run('run_live', co.id, v.scheduleId)
    const key = crypto.randomBytes(32)
    const cipher = { available: () => true, encrypt: (t: string) => { const n = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, n); return Buffer.concat([n, c.update(t), c.final(), c.getAuthTag()]) }, decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString() } }
    const log = path.join(dir, 'ads-calls.jsonl')
    const service = new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({ PATH: process.env.PATH ?? '' }), guard: (c) => p.gatewayCall(c) })
    const ask = async (grantDir: string, req: Record<string, unknown>): Promise<{ ok: boolean; error?: string; result?: unknown }> => {
      const id = crypto.randomBytes(16).toString('hex')
      fs.writeFileSync(path.join(grantDir, id + '.request'), JSON.stringify(req))
      for (let i = 0; i < 200; i++) {
        try {
          return JSON.parse(fs.readFileSync(path.join(grantDir, id + '.answer'), 'utf8'))
        } catch {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      throw new Error('no answer')
    }
    try {
      // the fake server says it is a Meta ads server the way a real one's command does (never by the connection's name)
      service.save({ id: 'meta', name: 'Meta', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, '../gateway/__tests__/fakeAdsMcp.cjs'), 'meta-ads-mcp'], credentials: { FAKE_ADS_LOG: log }, enabled: true, roots: [], scope: 'global' })
      const spec = service.attachment(dir, co.id, 'run_live')!
      const grant = spec.env.PRINCIPIA_GATEWAY_DIR!
      // the agent lists first (the server's read-only marks come with the list)
      expect((await ask(grant, { method: 'list' })).ok).toBe(true)
      const bypass = [
        ['get_or_create_campaign', { daily_budget: 500 }],
        ['check_and_fix_delivery', { status: 'ACTIVE' }],
        ['insights_update', { daily_budget: 900 }],
        ['update_campaign', { daily_budget: 800, adsets: [{ daily_budget: 90000 }] }],
        ['get_delivery_report', {}],
        ['set_budget_quietly', { campaign_id: '1' }]
      ] as const
      for (const [tool, args] of bypass) {
        const a = await ask(grant, { method: 'call', connection: 'meta', tool, arguments: args })
        expect(a, tool).toMatchObject({ ok: false, error: expect.stringMatching(/^Refused by Principia: /) })
      }
      // reads the server marks read-only, and known reads, go through
      expect(await ask(grant, { method: 'call', connection: 'meta', tool: 'get_campaigns', arguments: {} })).toMatchObject({ ok: true })
      expect(await ask(grant, { method: 'call', connection: 'meta', tool: 'get_insights', arguments: { date_preset: 'yesterday' } })).toMatchObject({ ok: true })
      // another spawn's folder (a chat session's, bound to no run) is no way around the check while the playbook runs
      const chat = service.attachment(dir, co.id)!.env.PRINCIPIA_GATEWAY_DIR!
      expect(await ask(chat, { method: 'call', connection: 'meta', tool: 'update_campaign', arguments: { campaign_id: '1', daily_budget: 90000 } })).toMatchObject({ ok: false, error: expect.stringMatching(/^Refused by Principia: /) })
      const reached = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { tool: string }).tool)
      expect(reached).toEqual(['get_campaigns', 'get_insights'])
      // the founder sees each refusal on the On autopilot row right away
      const lines = p.view(co.id, 'ads-watch').nearMisses!.map((m) => m.line)
      expect(lines).toContain('Ads watch tried to create something new with Meta (get or create campaign); refused.')
      expect(lines).toContain('Ads watch tried to turn a campaign, ad set or ad back on with Meta (check and fix delivery); refused.')
      expect(lines).toContain('Ads watch tried to change a budget to $9; refused.')
      // and once the run ends, the playbook pauses and Needs you gets every line
      const g = p.guardRun('run_live')!
      expect(g.refused.map((r) => r.line)).toContain('Ads watch tried to change a budget to $9; refused.')
      expect(g.refused).toHaveLength(7)
      expect(p.view(co.id, 'ads-watch')).toMatchObject({ running: false, pausedWhy: expect.stringMatching(/^Paused by Principia: Ads watch tried/) })
    } finally {
      service.close()
    }
  })

  it('the total budget cap counts every run for the company, on every day, and is kept in the database', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 3, raise: true, limits: { budgetCapUsd: 10, maxChanges: 5, targets: ['a', 'b', 'c', 'd'] } })
    for (const r of ['run_a', 'run_b', 'run_c', 'run_d']) run(r, co.id, v.scheduleId)
    const call = (pb: Playbooks, runId: string, adset: string, cents: number) => pb.gatewayCall({ runId, companyId: co.id, connection: 'meta', connector: 'meta', tool: 'update_adset', args: { account_id: 'act_1', adset_id: adset, daily_budget: cents } })
    expect(call(p, 'run_a', 'a', 400)).toBeNull()
    expect(call(p, 'run_b', 'b', 400)).toBeNull()
    // $4 + $4 + $4 = $12 over $10, even from a third run (one account, three ad sets: never merged)
    expect(call(p, 'run_c', 'c', 400)).toMatch(/total daily budget it has set to \$12, over the total budget cap of \$10/)
    expect(call(p, 'run_d', 'd', 90800)).toMatch(/\$916/)
    // a fresh Playbooks over the same database still knows the total
    const again = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => true, tz: () => 'Europe/Madrid', now: () => new Date('2026-10-20T18:00:00.000Z') })
    expect(again.budgetSet(co.id).reduce((n, s) => n + s.usd, 0)).toBe(8)
    // budgets keep spending: tomorrow, and a week later, ad sets a and b still count against the cap
    for (const day of ['2026-10-21T09:00:00.000Z', '2026-10-28T09:00:00.000Z']) {
      const later = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => true, tz: () => 'Europe/Madrid', now: () => new Date(day) })
      run(`run_${day.slice(8, 10)}`, co.id, v.scheduleId)
      expect(call(later, `run_${day.slice(8, 10)}`, 'c', 400)).toMatch(/\$12, over the total budget cap of \$10/)
    }
    // lowering one makes room
    expect(call(p, 'run_a', 'a', 100)).toBeNull()
    expect(call(p, 'run_b', 'c', 400)).toBeNull()
  })

  it('a follow-up task filed from a playbook run keeps the playbook’s level and guard, and money runs load only Principia’s MCP servers', () => {
    const { co, agent, marketing } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    const card = c.createTask({ title: 'Recurring: Ads watch', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'schedule', sourceUrl: null, externalId: v.scheduleId, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id })
    const follow = c.createTask({ title: 'Refresh the creative', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'agent', sourceUrl: null, externalId: 'followup-1', assigneeProfileId: null, parentId: card.id, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id })
    run('run_follow', co.id, null, follow.id)
    expect(p.forRun('run_follow')).toEqual({ companyId: co.id, id: 'ads-watch' })
    expect(p.gatewayCall({ runId: 'run_follow', companyId: co.id, connection: 'meta', tool: 'update_campaign', args: { status: 'ACTIVE' } })).toMatch(/Level 1/)
    expect(p.strictMcpFor('run_follow')).toBe(true)
    // a playbook that moves no money, and a run of no playbook, keep their own servers
    const site = p.turnOn(co.id, 'site-watch', { level: 1 })
    run('run_site', co.id, site.scheduleId)
    expect(p.strictMcpFor('run_site')).toBe(false)
    run('run_plain', co.id, null)
    expect(p.strictMcpFor('run_plain')).toBe(false)
  })
})

describe('attack review: other doors, turned-off playbooks, and money runs kept to the gateway', () => {
  const run = (id: string, companyId: string, scheduleId: string | null, status = 'running', taskId: string | null = null) =>
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,schedule_id,task_id) VALUES(?,'prompt','Ads',?,'schedule',?,?,?,?,?,?)`).run(id, '{}', status, '2026-10-20T09:58:00.000Z', dir, companyId, scheduleId, taskId)

  it('while a money playbook runs, a call from a grant of no playbook run is checked as that run’s, and pauses it', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    // nothing runs: a chat session's call goes through
    expect(p.gatewayCall({ runId: null, companyId: co.id, connection: 'meta', connector: 'meta', tool: 'update_campaign', args: { campaign_id: '1', daily_budget: 90000 } })).toBeNull()
    run('run_live', co.id, v.scheduleId)
    run('run_free', co.id, null)
    // a chat session's grant, and a grant of a run of no playbook, of the same company: checked
    expect(p.gatewayCall({ runId: null, companyId: co.id, connection: 'meta', connector: 'meta', tool: 'update_campaign', args: { campaign_id: '1', daily_budget: 90000 } })).toMatch(/^No new spend/)
    expect(p.gatewayCall({ runId: 'run_free', companyId: co.id, connection: 'notes', tool: 'write_page', args: {} })).toMatch(/Level 1/)
    // another company's grant: an ads-looking call is checked, anything else is that company's own business
    const other = company('Harbor Dental')
    expect(p.gatewayCall({ runId: null, companyId: other.co.id, connection: 'pipeboard', tool: 'update_campaign', args: { campaign_id: '1', status: 'ACTIVE' } })).toMatch(/restarts its spend/)
    expect(p.gatewayCall({ runId: null, companyId: other.co.id, connection: 'notion', tool: 'update_page', args: { title: 'x' } })).toBeNull()
    expect(p.view(co.id, 'ads-watch').nearMisses!.map((m) => m.line)).toContain('Ads watch tried to change a budget to $900 from outside its own run; refused.')
    const g = p.guardRun('run_live')!
    expect(g.refused.length).toBeGreaterThanOrEqual(3)
    expect(p.view(co.id, 'ads-watch').running).toBe(false)
  })

  it('a run that ended (or an old one stuck as running) no longer makes other grants checked', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    run('run_done', co.id, v.scheduleId, 'passed')
    db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id,schedule_id) VALUES('run_stale','prompt','Ads','{}','schedule','running','2026-10-19T01:00:00.000Z',?,?,?)`).run(dir, co.id, v.scheduleId)
    expect(p.gatewayCall({ runId: null, companyId: co.id, connection: 'meta', connector: 'meta', tool: 'update_campaign', args: { campaign_id: '1' } })).toBeNull()
  })

  it('turning a playbook off keeps its runs and follow-ups guarded (and restricted)', () => {
    const { co, agent, marketing } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 1 })
    const card = c.createTask({ title: 'Recurring: Ads watch', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'schedule', sourceUrl: null, externalId: v.scheduleId, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id })
    const follow = c.createTask({ title: 'Raise the budget', description: '', companyId: co.id, repoId: null, status: 'todo', priority: 0, source: 'agent', sourceUrl: null, externalId: 'f1', assigneeProfileId: null, parentId: card.id, dependencyIds: [], departmentId: marketing!.id, agentId: agent!.id })
    run('run_inflight', co.id, v.scheduleId)
    p.turnOff(co.id, 'ads-watch')
    run('run_follow', co.id, null, 'queued', follow.id)
    expect(p.forRun('run_follow')).toEqual({ companyId: co.id, id: 'ads-watch' })
    expect(p.gatewayCall({ runId: 'run_follow', companyId: co.id, connection: 'meta', connector: 'meta', tool: 'update_campaign', args: { campaign_id: '1', daily_budget: 90000 } })).toMatch(/off/)
    expect(p.gatewayCall({ runId: 'run_inflight', companyId: co.id, connection: 'meta', connector: 'meta', tool: 'pause_ad', args: { ad_id: '1' } })).toMatch(/off/)
    expect(p.strictMcpFor('run_follow')).toBe(true)
    // a fresh Playbooks (after a restart) still knows
    const again = new Playbooks({ db, company: () => c, schedules: ops(), departmentsOn: () => true })
    expect(again.forRun('run_inflight')).toEqual({ companyId: co.id, id: 'ads-watch' })
  })

  it('Level 3 changes only the campaigns listed, never turns one back on, and the list rewrites the prompt', () => {
    const { co } = company('Ledgerline')
    const v = p.turnOn(co.id, 'ads-watch', { level: 3, raise: true, limits: { budgetCapUsd: 50 } })
    run('run_scope', co.id, v.scheduleId)
    const call = (tool: string, args: unknown) => p.gatewayCall({ runId: 'run_scope', companyId: co.id, connection: 'meta', connector: 'meta', tool, args })
    expect(call('pause_ad', { ad_id: '11' })).toMatch(/no campaigns or ad sets listed/)
    const after = p.configure(co.id, 'ads-watch', { limits: { targets: ['11', '12'] } })
    expect(after.limits.targets).toEqual(['11', '12'])
    expect(schedules.get(after.scheduleId!)!.target.kind === 'prompt' && (schedules.get(after.scheduleId!)!.target as { prompt: string }).prompt).toContain('11, 12')
    expect(call('pause_ad', { ad_id: '11' })).toBeNull()
    expect(call('pause_ad', { ad_id: '99' })).toMatch(/99 is not one of them/)
    expect(call('update_campaign', { campaign_id: '11', status: 'ACTIVE' })).toMatch(/restarts its spend/)
  })
})
