/**
 * Five doors step 2 over the real CompanyStore + Dispatcher (hive.db): per-company task prefixes, and the one rule for
 * paused (A4). Pausing Harbor pauses its seats and holds its autopilot and starts; work in flight is saved and starts
 * again on resume; Ledgerly keeps running the whole time.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { Dispatcher, HookedCompanyStore } from './dispatcher'
import { setCompanyPaused } from './pauseCompany'
import { boardActions } from '../handlers/board'
import { pickPrefix, prefixCandidates } from './prefix'
import { createCompanyBridge } from '../companyBridge'
import type { StartRunOptions } from '../../shared/engine'
import type { CompanyTaskInput } from '../../shared/company'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Run, RunTarget } from '../../shared/types'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d_ = nativeOk && !process.versions.electron ? describe : describe.skip

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0
function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_p${++seq}`
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), new Date().toISOString(), dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'task', status: 'running', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
function end(runId: string, status: Run['status']) {
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, runId)
  const run = started.find((s) => s.run.id === runId)!.run
  d.onRunUpdated({ ...run, status })
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }

function company(name: string) {
  const co = c.create({ name })
  const dep = c.departments.save({ companyId: co.id, name: 'Marketing' })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const agent = c.departments.saveAgent({ companyId: co.id, departmentId: dep.id, kind: 'profile', refId: profile.id, name: 'Researcher', data: { autonomy: 'auto', persona: { key: 'pliny', name: 'Pliny', personality: 'Takes notes on everything.', bio: 'Researches markets.', look: { material: 'marble', hair: 'wavy', beard: 'full', laurel: false, drape: 'purple' } } } as never })
  c.setAutopilot(co.id, true)
  const task = (over: Partial<CompanyTaskInput> = {}) => c.createTask({ title: 'Competitor research', description: 'Look at the ads', companyId: co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: dep.id, agentId: agent.id, ...over })
  return { co, dep, agent, task }
}
const deps = () => ({
  company: c as never,
  cancelRun: async (id: string) => end(id, 'canceled'),
  startTask: (id: string) => void d.runNow(id),
  schedules: () => 0
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-copause-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  started = []
  d = new Dispatcher({ company: c, startRun, cancelRun: async (id) => end(id, 'canceled'), enabled: () => true, sessions: null })
  c.hooks = d.hooks()
})
afterEach(() => { d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('task prefixes (pure)', () => {
  it('initials first, unique, PRN only for Personal', () => {
    expect(prefixCandidates('Northwind Coffee')[0]).toBe('NC')
    expect(prefixCandidates('Ledgerly App')[0]).toBe('LA')
    expect(prefixCandidates('Harbor Dental Group')[0]).toBe('HD')
    expect(prefixCandidates('Acme')[0]).toBe('AC')
    expect(pickPrefix('co_x', 'Harbor Dental Group', new Set(['HD']))).toBe('HDG')
    expect(pickPrefix(PERSONAL_COMPANY_ID, 'Personal', new Set())).toBe('PRN')
    expect(pickPrefix('co_y', 'Prn', new Set())).not.toBe('PRN')
  })
})

d_('per-company task numbers', () => {
  it('each company numbers its own tasks; lookups stay inside the company', () => {
    const nw = company('Northwind Coffee')
    const la = company('Ledgerly App')
    const a1 = nw.task(); const b1 = la.task(); const a2 = nw.task()
    expect([a1.identifier, a2.identifier, b1.identifier]).toEqual(['NC-1', 'NC-2', 'LA-1'])
    expect(c.findTask(nw.co.id, 'nc-2')?.id).toBe(a2.id)
    expect(c.findTask(la.co.id, 'NC-2')).toBeNull()
    expect(c.passport(nw.co.id).taskPrefix).toBe('NC')
  })

  it('renaming a prefix keeps the numbers; a taken or reserved prefix is refused', () => {
    const nw = company('Northwind Coffee')
    const la = company('Ledgerly App')
    const t = nw.task()
    c.update(nw.co.id, { taskPrefix: 'nw' })
    expect(c.task(t.id).identifier).toBe('NW-1')
    expect(nw.task().identifier).toBe('NW-2')
    expect(() => c.update(la.co.id, { taskPrefix: 'NW' })).toThrow(/Northwind Coffee already uses NW/)
    expect(() => c.update(la.co.id, { taskPrefix: 'PRN' })).toThrow(/Personal/)
    expect(() => c.update(la.co.id, { taskPrefix: '1X' })).toThrow(/2 to 5 letters/)
  })

  it('an install from before prefixes is numbered again per company, oldest first; old PRN-n still resolves', () => {
    const nw = company('Northwind Coffee')
    const la = company('Ledgerly App')
    nw.task(); la.task(); nw.task()
    // what an older build wrote: global PRN-<seq>, no prefix on the rows
    for (const r of db.prepare('SELECT seq,id,data FROM company_tasks').all() as { seq: number; id: string; data: string }[])
      db.prepare('UPDATE company_tasks SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(r.data), identifier: `PRN-${r.seq}` }), r.id)
    for (const r of db.prepare('SELECT id,data FROM company_passports').all() as { id: string; data: string }[]) {
      const { taskPrefix: _p, taskSeq: _s, ...rest } = JSON.parse(r.data)
      db.prepare('UPDATE company_passports SET data=? WHERE id=?').run(JSON.stringify(rest), r.id)
    }
    const again = new HookedCompanyStore(store)
    const ids = (co: string) => again.listTasks(co).map((t) => t.identifier).sort()
    expect(ids(nw.co.id)).toEqual(['NC-1', 'NC-2'])
    expect(ids(la.co.id)).toEqual(['LA-1'])
    // PRN-2 was Ledgerly's second-created row: it still resolves inside Ledgerly, never inside Northwind
    expect(again.findTask(la.co.id, 'PRN-2')?.identifier).toBe('LA-1')
    expect(again.findTask(nw.co.id, 'PRN-2')).toBeNull()
    expect(nw.task().identifier).toBe('NC-3')
  })
})

d_('pause one company (A4)', () => {
  it('pausing Harbor saves its work, holds its starts and leaves Ledgerly running; resume brings it back', async () => {
    const hd = company('Harbor Dental Group')
    const la = company('Ledgerly App')
    const hdTask = hd.task()
    const laTask = la.task()
    await d.pump(); await settle()
    expect(c.task(hdTask.id).status).toBe('in_progress')
    expect(c.task(laTask.id).status).toBe('in_progress')
    const hdRun = c.task(hdTask.id).runId!

    const res = await setCompanyPaused(deps(), hd.co.id, true)
    await settle()
    expect(res.paused).toBe(true)
    expect(res.agents).toBe(1)
    expect(res.checkpoints).toEqual([expect.objectContaining({ taskId: hdTask.id, agentName: 'Pliny', title: 'Competitor research' })])
    // saved, not lost: back in To do with a wake that says where it stopped
    const saved = c.task(hdTask.id)
    expect(saved.status).toBe('todo')
    expect(saved.pendingWake?.reasons.at(-1)).toMatch(/Paused by the founder mid-turn/)
    expect(c.detail(hdTask.id).activity.some((a) => a.kind === 'paused')).toBe(true)
    expect(c.passport(hd.co.id).pausedAt).toBeTruthy()
    expect(c.departments.getAgent(hd.agent.id)!.pausedAt).toBeTruthy()
    // the other company never noticed
    expect(c.task(laTask.id).status).toBe('in_progress')
    expect(c.passport(la.co.id).pausedAt).toBeNull()
    expect(c.departments.getAgent(la.agent.id)!.pausedAt).toBeNull()
    expect(started.filter((s) => s.run.id === hdRun)).toHaveLength(1)

    // a paused company starts nothing: autopilot, a human click, the engine's bridge
    const before = started.length
    await d.pump(hd.co.id); await settle()
    expect(started.length).toBe(before)
    expect(() => d.runNow(hdTask.id)).toThrow(/Harbor Dental Group is paused/)
    const bridge = createCompanyBridge(c, { companyGuardsEnforced: () => true })
    expect(bridge.pausedName!(hd.co.id)).toBe('Harbor Dental Group')
    expect(bridge.pausedName!(la.co.id)).toBeNull()

    const back = await setCompanyPaused(deps(), hd.co.id, false)
    await settle()
    expect(back.paused).toBe(false)
    expect(back.agents).toBe(1)
    expect(back.checkpoints.map((x) => x.taskId)).toEqual([hdTask.id])
    expect(c.task(hdTask.id).status).toBe('in_progress')
    expect(c.passport(hd.co.id).pausedAt).toBeNull()
    expect(c.departments.getAgent(hd.agent.id)!.pausedAt).toBeNull()
  })

  it('resume brings back only the seats the pause paused', async () => {
    const hd = company('Harbor Dental Group')
    const own = c.departments.saveAgent({ companyId: hd.co.id, departmentId: hd.dep.id, kind: 'profile', refId: hd.agent.refId, name: 'Already paused', data: { autonomy: 'auto' } })
    c.departments.pauseAgent(own.id)
    await setCompanyPaused(deps(), hd.co.id, true)
    await setCompanyPaused(deps(), hd.co.id, false)
    expect(c.departments.getAgent(own.id)!.pausedAt).toBeTruthy()
    expect(c.departments.getAgent(hd.agent.id)!.pausedAt).toBeNull()
  })

  it('A4: Autopilot cannot be turned on in a paused company (every entry point, not only the menu); off still works', async () => {
    const hd = company('Harbor Dental Group')
    const la = company('Ledgerly App')
    c.setAutopilot(hd.co.id, false)
    await setCompanyPaused(deps(), hd.co.id, true)
    expect(() => c.setAutopilot(hd.co.id, true)).toThrow(/Autopilot is off while Harbor Dental Group is paused/)
    expect(c.boardSettings(hd.co.id).autopilot).toBe(false)
    expect(() => c.setAutopilot(hd.co.id, false)).not.toThrow()
    // the other company's switch is untouched
    expect(c.setAutopilot(la.co.id, true).autopilot).toBe(true)
    await setCompanyPaused(deps(), hd.co.id, false)
    expect(c.setAutopilot(hd.co.id, true).autopilot).toBe(true)
  })

  it('a profile save keeps the pause and the prefix', async () => {
    const hd = company('Harbor Dental Group')
    await setCompanyPaused(deps(), hd.co.id, true)
    const p = c.passport(hd.co.id)
    c.savePassport({ name: p.name, mission: 'New mission', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds: [] }, hd.co.id)
    expect(c.passport(hd.co.id).pausedAt).toBe(p.pausedAt)
    expect(c.passport(hd.co.id).taskPrefix).toBe('HD')
  })
})

d_('Pause this task (C9)', () => {
  const host = () => boardActions({ company: c as never, settings: () => ({ experimental: { companies: true, departments: true } }), engine: { runs: { cancel: async (id: string) => end(id, 'canceled') } }, dispatcher: d })
  it('the task goes back to To do with its work saved, never parked as a failure, and autopilot leaves it there', async () => {
    const la = company('Ledgerly App')
    const t = la.task()
    await d.pump(); await settle()
    expect(c.task(t.id).status).toBe('in_progress')
    const out = await host().pause({ id: t.id })
    await settle()
    expect(out.status).toBe('todo')
    expect(out.blockReason).toBeNull()
    expect(c.task(t.id).pendingWake?.reasons.at(-1)).toMatch(/Paused by the founder mid-turn/)
    const last = c.detail(t.id).activity.at(-1)!
    expect(last.kind).toBe('paused')
    expect(last.by).toBe('human')
    expect(last.message).toMatch(/^Paused by you/)
    expect(last.message).not.toMatch(/Unpark|no report/i)
    // the agent acts on its own and autopilot is on: still, a task you paused waits for your Start
    const before = started.length
    await d.pump(la.co.id); await settle()
    expect(c.task(t.id).status).toBe('todo')
    expect(started.length).toBe(before)
    // Start picks it up again
    d.runNow(t.id)
    expect(c.task(t.id).status).toBe('in_progress')
  })
  it('a task that is not running cannot be paused', async () => {
    const la = company('Ledgerly App')
    const t = la.task({ status: 'backlog' })
    await expect(host().pause({ id: t.id })).rejects.toThrow(/not running/)
  })
})

d_('five doors step 4: a company’s own accounts and monthly cap', () => {
  it('connects and disconnects one company’s Instagram and GitHub; another company never gets them', () => {
    const nw = company('Northwind Coffee').co
    const la = company('Ledgerly App').co
    const a = c.update(nw.id, { account: { kind: 'instagram', handle: '@northwindcoffee' } })
    expect(a.accounts?.instagram?.handle).toBe('@northwindcoffee')
    c.update(nw.id, { account: { kind: 'github', handle: 'diego-ledgerly' } })
    expect(c.passport(nw.id).accounts).toMatchObject({ instagram: { handle: '@northwindcoffee' }, github: { handle: 'diego-ledgerly' } })
    expect(c.passport(la.id).accounts).toBeUndefined()
    // a profile save (Company settings) keeps them, and the cap
    c.update(nw.id, { monthlyCap: 60 })
    c.savePassport({ name: 'Northwind Coffee', mission: 'Coffee', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds: [] }, nw.id)
    expect(c.passport(nw.id)).toMatchObject({ monthlyCap: 60, accounts: { instagram: { handle: '@northwindcoffee' } } })
    c.update(nw.id, { account: { kind: 'instagram', handle: null }, monthlyCap: null })
    expect(c.passport(nw.id).accounts).toEqual({ github: expect.objectContaining({ handle: 'diego-ledgerly' }) })
    expect(c.passport(nw.id).monthlyCap).toBeUndefined()
  })
  it('refuses a handle that is not one, a cap under $1, and accounts on Personal', () => {
    const nw = company('Northwind Coffee').co
    expect(() => c.update(nw.id, { account: { kind: 'instagram', handle: 'north wind' } })).toThrow()
    expect(() => c.update(nw.id, { monthlyCap: 0 })).toThrow()
    if (c.listPassports().some((p) => p.id === PERSONAL_COMPANY_ID)) expect(() => c.update(PERSONAL_COMPANY_ID, { account: { kind: 'github', handle: 'me' } })).toThrow(/Personal/)
  })
})

d_('five doors step 5: the task counter, the rail label and the client tag', () => {
  it('hands the Board the last task number, so the next branch can be named before Start', () => {
    const nw = company('Northwind Coffee')
    expect(c.passport(nw.co.id).taskSeq ?? 0).toBe(0)
    const t1 = nw.task()
    const t2 = nw.task({ title: 'Second' })
    expect(c.passport(nw.co.id).taskSeq).toBe(Number(t2.identifier.split('-')[1]))
    expect(Number(t1.identifier.split('-')[1]) + 1).toBe(c.passport(nw.co.id).taskSeq)
  })
  it('sets and clears a rail label and the client tag on any company, and a profile save keeps them', () => {
    const nw = company('Northwind Coffee').co
    const la = company('Ledgerly App').co
    expect(c.update(nw.id, { railLabel: 'nw2', client: true })).toMatchObject({ railLabel: 'NW2', client: true })
    c.savePassport({ name: 'Northwind Coffee', mission: 'Coffee', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds: [] }, nw.id)
    expect(c.passport(nw.id)).toMatchObject({ railLabel: 'NW2', client: true })
    expect(c.passport(la.id).railLabel).toBeUndefined()
    expect(c.passport(la.id).client).toBeUndefined()
    const cleared = c.update(nw.id, { railLabel: null, client: false })
    expect(cleared.railLabel).toBeUndefined()
    expect(cleared.client).toBeUndefined()
    expect(() => c.update(nw.id, { railLabel: 'ABCD' })).toThrow()
    expect(() => c.update(nw.id, { railLabel: 'a b' })).toThrow()
  })
})
