/**
 * LINEAR.md §8: Linear sync over the real modules (hive.db, CompanyStore, the sync engine and service, the Linear
 * client over real fetch) against the in-repo fake Linear on 127.0.0.1. Nothing here reaches api.linear.app.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../../db'
import { Store } from '../../db/store'
import { CompanyStore } from '../index'
import type { BoardTask, CompanyTaskInput, TaskStatus } from '../../../shared/company'
import { FakeLinear, startFakeLinear } from './fakeLinear'
import { LINEAR_API, LinearProvider, PRIORITY_TO_LINEAR, linearEndpoint, priorityFromLinear, stateForStatus, statusFromState } from './linear'
import { LinearSyncService, POLL_MS } from './service'
import { needsYouReason } from '../../../shared/company'
import { fingerprint } from './fields'
import type { RemoteState } from './provider'

const KEY = 'lin_api_test_good_key_000000000000'
let dir: string; let db: DB; let c: CompanyStore; let fake: FakeLinear; let server: { url: string; close: () => Promise<void> }; let svc: LinearSyncService
let saved: Map<string, string>
let companyId: string

function service(): LinearSyncService {
  return new LinearSyncService({
    db,
    board: {
      tasks: (id) => c.listTasks(id), createFromRemote: (i) => c.createFromRemote(i), applyRemote: (id, p, m) => c.applyRemote(id, p, m),
      note: (id, m) => { c.activity(id, 'updated', m, 'system') }, inFlight: (t) => t.status === 'in_progress' && !!t.runId,
      depsDone: (t) => t.dependencyIds.every((d) => c.task(d).status === 'done'), onTaskWrite: (fn) => c.onTaskWrite(fn), setExternalLinks: (fn) => c.setExternalLinks(fn),
      companyExists: (id) => { try { return !!c.passport(id) } catch { return false } },
      companyName: (id) => { try { return c.passport(id).name } catch { return null } }
    },
    keys: {
      masked: (id) => (saved.has(id) ? `lin_…${saved.get(id)!.slice(-4)}` : null), reveal: (id) => saved.get(id) ?? null,
      save: (id, v) => { saved.set(id, v) }, remove: (id) => { saved.delete(id) }
    },
    provider: (key) => new LinearProvider(key, { endpoint: server.url })
  })
}
const task = (o: Partial<CompanyTaskInput> = {}): BoardTask => c.createTask({ title: 'Local task', description: 'From the Board', companyId, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...o })
const byKey = (key: string): BoardTask => { const id = Object.entries(svc.status(companyId).links).find(([, l]) => l.key === key)?.[0]; if (!id) throw new Error(`no task for ${key}`); return c.task(id) }
const engTeam = () => fake.teams.find((t) => t.key === 'ENG')!.id
async function connect(o: { sendOpen?: boolean; autosync?: boolean } = {}) {
  await svc.connect({ companyId, key: KEY, teamId: engTeam(), autosync: o.autosync ?? false, sendOpen: o.sendOpen ?? false })
  return svc.syncNow(companyId)
}
const later = () => new Promise((r) => setTimeout(r, 5))

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-linear-'))
  db = openDatabase(path.join(dir, 'test.db'))
  c = new CompanyStore(new Store(db))
  companyId = c.create({ name: 'Acme' }).id
  fake = new FakeLinear({ key: KEY })
  server = await startFakeLinear(fake)
  saved = new Map()
  svc = service()
  svc.start()
})
afterEach(async () => { svc.stop(); await server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('Linear mapping (pinned)', () => {
  const states: RemoteState[] = [
    { id: 'tr', name: 'Triage', type: 'triage', position: 0 }, { id: 'bl', name: 'Backlog', type: 'backlog', position: 1 }, { id: 'td', name: 'Todo', type: 'unstarted', position: 2 },
    { id: 'rv', name: 'Code Review', type: 'started', position: 4 }, { id: 'ip', name: 'In Progress', type: 'started', position: 3 }, { id: 'ip2', name: 'Doing', type: 'started', position: 5 },
    { id: 'dn', name: 'Done', type: 'completed', position: 6 }, { id: 'cx', name: 'Canceled', type: 'canceled', position: 7 }
  ]
  it('maps state types to Board statuses, review by name', () => {
    expect(states.map((s) => statusFromState(s))).toEqual(['triage', 'backlog', 'todo', 'in_review', 'in_progress', 'in_progress', 'done', 'canceled'])
  })
  it('picks the first state of a type by position; blocked goes out as started; a matching current state is kept', () => {
    const pick = (s: TaskStatus, cur?: string) => stateForStatus(states, s, cur)?.id
    expect(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'].map((s) => pick(s as TaskStatus))).toEqual(['tr', 'bl', 'td', 'ip', 'rv', 'ip', 'dn', 'cx'])
    expect(pick('in_progress', 'ip2')).toBe('ip2')
    expect(pick('blocked', 'ip2')).toBe('ip2')
    expect(pick('todo', 'ip2')).toBe('td')
  })
  it('keeps Linear’s 0–4 priority numbers', () => {
    expect(PRIORITY_TO_LINEAR).toEqual({ 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 })
    expect([0, 1, 2, 3, 4, 7, null, 'x'].map(priorityFromLinear)).toEqual([0, 1, 2, 3, 4, 0, 0, 0])
  })
  it('points at a fake only on loopback', () => {
    expect(linearEndpoint({})).toBe(LINEAR_API)
    expect(linearEndpoint({ PRINCIPIA_LINEAR_API: 'http://127.0.0.1:8765/graphql' })).toBe('http://127.0.0.1:8765/graphql')
    expect(linearEndpoint({ PRINCIPIA_LINEAR_API: 'https://evil.example/graphql' })).toBe(LINEAR_API)
  })
})

describe('Linear sync against the fake', () => {
  it('Check Key: a bad key is turned down, a good one lists the teams', async () => {
    expect(await svc.checkKey(companyId, 'lin_api_wrong_key_00000000000000')).toMatchObject({ ok: false, message: 'Linear turned down the key.' })
    const ok = await svc.checkKey(companyId, KEY)
    expect(ok.ok).toBe(true)
    expect(ok.teams.map((t) => t.name)).toEqual(['Engineering', 'Design'])
    expect(saved.size).toBe(0)
  })

  it('first pull: open issues and the recently closed ones, with status, priority, labels, estimate, due and parent', async () => {
    const view = await connect()
    expect(view.connected).toBe(true)
    expect(view.linkedCount).toBe(6)
    const s = (k: string) => byKey(k)
    expect([s('ENG-1').status, s('ENG-2').status, s('ENG-3').status, s('ENG-4').status, s('ENG-5').status, s('ENG-6').status]).toEqual(['todo', 'in_progress', 'in_progress', 'triage', 'backlog', 'done'])
    expect(s('ENG-6').doneNote).toBe('Done in Linear')
    expect(s('ENG-1')).toMatchObject({ priority: 2, labels: ['Bug'], estimate: 3, dueDate: '2026-11-07', source: 'linear', externalId: 'ENG-1' })
    expect(s('ENG-1').sourceUrl).toBe(`${fake.base}/issue/ENG-1`)
    expect(s('ENG-5').parentId).toBe(s('ENG-1').id)
    expect(() => byKey('ENG-7')).toThrow()
    // a second pass changes nothing and sends nothing
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(fake.writes()).toEqual([])
  })

  it('sends existing open tasks when asked, parents before children', async () => {
    const parent = task({ title: 'Parent plan', labels: ['Launch'] })
    task({ title: 'Child step', parentId: parent.id, priority: 1 })
    task({ title: 'Already shipped', status: 'done' })
    await connect({ sendOpen: true })
    const creates = fake.writes('Create')
    expect(creates.map((e) => (e.variables as { input: { title: string } }).input.title)).toEqual(['Parent plan', 'Child step'])
    const p = fake.issues.find((i) => i.title === 'Parent plan')!
    const ch = fake.issues.find((i) => i.title === 'Child step')!
    expect(ch.parentId).toBe(p.id)
    expect(ch.priority).toBe(1)
    expect(fake.labels.find((l) => p.labelIds.includes(l.id))?.name).toBe('Launch')
    expect(fake.issues.some((i) => i.title === 'Already shipped')).toBe(false)
  })

  it('without "send open tasks", only tasks made after connecting go out', async () => {
    task({ title: 'Before' })
    await connect()
    await later()
    task({ title: 'After' })
    await svc.syncNow(companyId)
    expect(fake.issues.map((i) => i.title)).toContain('After')
    expect(fake.issues.map((i) => i.title)).not.toContain('Before')
  })

  it('a local edit goes out, a Linear edit comes in, and neither echoes', async () => {
    await connect()
    const t = byKey('ENG-1')
    c.updateTask(t.id, { title: 'Fix the login redirect for good' })
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(fake.byKey('ENG-1')!.title).toBe('Fix the login redirect for good')
    expect(fake.writes('Update')).toHaveLength(1)
    expect((fake.writes('Update')[0].variables as { input: Record<string, unknown> }).input).toEqual({ title: 'Fix the login redirect for good' })
    fake.edit('ENG-1', { priority: 1 })
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(c.task(t.id).priority).toBe(1)
    expect(c.task(t.id).title).toBe('Fix the login redirect for good')
    await svc.syncNow(companyId)
    expect(fake.writes()).toEqual([])
    expect(c.detail(t.id).activity.map((a) => a.message)).toContain('Linear changed the priority')
  })

  it('both sides changed the title: the newer wins on both sides and the activity says which', async () => {
    await connect()
    const t = byKey('ENG-2')
    fake.edit('ENG-2', { title: 'Linear title' })
    await later()
    c.updateTask(t.id, { title: 'Local title' })
    await svc.syncNow(companyId)
    expect(c.task(t.id).title).toBe('Local title')
    expect(fake.byKey('ENG-2')!.title).toBe('Local title')
    expect(c.detail(t.id).activity.map((a) => a.message)).toContain('Your title replaced Linear’s')

    c.updateTask(byKey('ENG-3').id, { title: 'Local again' })
    await later()
    fake.edit('ENG-3', { title: 'Linear again' })
    await svc.syncNow(companyId)
    expect(byKey('ENG-3').title).toBe('Linear again')
    expect(fake.byKey('ENG-3')!.title).toBe('Linear again')
    expect(c.detail(byKey('ENG-3').id).activity.map((a) => a.message)).toContain('Linear’s title replaced yours')
  })

  it('blocked goes out as started and an incoming started never undoes it', async () => {
    await connect()
    const t = byKey('ENG-1')
    c.updateTask(t.id, { status: 'blocked' })
    await svc.syncNow(companyId)
    const st = () => fake.team(engTeam())!.states.find((s) => s.id === fake.byKey('ENG-1')!.stateId)!
    expect(st().type).toBe('started')
    fake.edit('ENG-1', { priority: 4 })
    await svc.syncNow(companyId)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', priority: 4 })
    fake.edit('ENG-1', { stateName: 'Done' })
    await svc.syncNow(companyId)
    expect(c.task(t.id).status).toBe('done')
  })

  it('a task started in Linear stays editable and leaves in progress by a status move here', async () => {
    await connect()
    const t = byKey('ENG-2')
    expect(c.startedElsewhere(t)).toBe(true)
    c.updateTask(t.id, { title: 'Edited while started in Linear' })
    c.updateTask(t.id, { status: 'todo' })
    await svc.syncNow(companyId)
    expect(fake.team(engTeam())!.states.find((s) => s.id === fake.byKey('ENG-2')!.stateId)!.name).toBe('Todo')
    c.reconcile()
    expect(byKey('ENG-2').status).toBe('todo')
  })

  it('a rejected key turns autosync off and says so', async () => {
    await connect({ autosync: true })
    fake.admin({ op: 'revoke' })
    const v = await svc.syncNow(companyId)
    expect(v).toMatchObject({ autosync: false, state: 'auth', message: 'Linear turned down the key. Autosync is off.' })
    expect(() => svc.setAutosync(companyId, true)).toThrow('Reconnect')
  })

  it('disconnect forgets the key and the links; tasks keep their content and Linear is untouched', async () => {
    await connect()
    const t = byKey('ENG-1')
    const before = JSON.stringify(fake.issues)
    fake.admin({ op: 'clearLog' })
    const v = svc.disconnect(companyId)
    expect(v).toMatchObject({ connected: false, linkedCount: 0, keyMasked: null })
    expect(saved.has(companyId)).toBe(false)
    expect(c.task(t.id).title).toBe('Fix the login redirect loop')
    expect(c.externalOf(t.id)).toBeNull()
    // in progress only in Linear: back to Todo here, so it never looks like running work
    expect(c.listTasks(companyId).find((x) => x.externalId === 'ENG-2')!.status).toBe('todo')
    expect(JSON.stringify(fake.issues)).toBe(before)
    expect(fake.log).toEqual([])
  })

  it('a company that never connected makes no request and its tasks are unchanged', async () => {
    const t = task()
    c.updateTask(t.id, { title: 'Still local' })
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.log).toEqual([])
    expect(svc.status(companyId)).toMatchObject({ connected: false, linkedCount: 0 })
    expect(c.task(t.id)).toMatchObject({ labels: [], estimate: null, dueDate: null })
  })

  it('no status or check result carries the key', async () => {
    const check = await svc.checkKey(companyId, KEY)
    const view = await connect()
    for (const r of [check, view, svc.status(companyId)]) expect(JSON.stringify(r)).not.toContain(KEY)
    const t = byKey('ENG-1')
    expect(c.task(t.id)).toBeTruthy()
  })

  it('a reconnect to the same team keeps the links; another team unlinks the old ones', async () => {
    await connect()
    const n = svc.status(companyId).linkedCount
    await svc.connect({ companyId, key: KEY, teamId: engTeam(), autosync: false, sendOpen: false })
    expect(svc.status(companyId).linkedCount).toBe(n)
    await svc.connect({ companyId, key: KEY, teamId: fake.teams.find((t) => t.key === 'DES')!.id, autosync: false, sendOpen: false })
    await svc.syncNow(companyId)
    expect(svc.status(companyId)).toMatchObject({ team: { key: 'DES' }, linkedCount: 0 })
  })

  it('disconnect then connect again finds the same tasks: nothing is brought over twice', async () => {
    const mine = task({ title: 'Sent from here' })
    await connect({ sendOpen: true })
    const before = c.listTasks(companyId).length
    svc.disconnect(companyId)
    c.updateTask(mine.id, { title: 'Renamed while disconnected' })
    await later()
    await connect()
    expect(c.listTasks(companyId).length).toBe(before)
    expect(svc.status(companyId).linkedCount).toBe(before)
    expect(c.task(mine.id).title).toBe('Renamed while disconnected')
    expect(fake.issues.find((i) => i.id === Object.values(svc.store.links(companyId)).find((l) => l.taskId === mine.id)!.remoteId)!.title).toBe('Renamed while disconnected')
  })

  it('agents see a linked task’s Linear key and URL in its prompt, as data', async () => {
    await connect()
    const t = byKey('ENG-1')
    const { buildTaskPrompt } = await import('../taskPrompt')
    const prompt = buildTaskPrompt({ task: t, companyId, external: c.externalOf(t.id), department: null, agent: null, deps: [], activity: [], wake: ['Go'] })
    expect(prompt).toContain(`Linear: ENG-1 ${fake.base}/issue/ENG-1`)
    expect(buildTaskPrompt({ task: t, companyId, department: null, agent: null, deps: [], activity: [], wake: ['Go'] })).not.toContain('Linear:')
  })

  // ---------- QA regressions (LINEAR.md §3–§5) ----------

  it('an issue deleted in Linear unlinks only its task; the rest of the pass and later passes go on', async () => {
    await connect()
    const t1 = byKey('ENG-1')
    fake.issues = fake.issues.filter((i) => i.identifier !== 'ENG-1')
    c.updateTask(t1.id, { title: 'Edited after delete in Linear' })
    fake.edit('ENG-2', { priority: 4 })
    await later()
    task({ title: 'Brand new local task' })
    const cursor = svc.store.connection(companyId)!.cursor
    const v = await svc.syncNow(companyId)
    expect(v).toMatchObject({ state: 'ok', message: null })
    expect(byKey('ENG-2').priority).toBe(4)
    expect(fake.issues.some((i) => i.title === 'Brand new local task')).toBe(true)
    expect(svc.store.connection(companyId)!.cursor! > cursor!).toBe(true)
    expect(c.externalOf(t1.id)).toBeNull()
    expect(c.task(t1.id).title).toBe('Edited after delete in Linear')
    expect(c.detail(t1.id).activity.map((a) => a.message).some((m) => m.startsWith('ENG-1 is gone from Linear'))).toBe(true)
    fake.admin({ op: 'clearLog' })
    expect((await svc.syncNow(companyId)).state).toBe('ok')
    expect(fake.writes()).toEqual([])
  })

  it('a Linear review is not agent work waiting for approval: it reads as in progress there, never Needs you', async () => {
    await connect()
    const t = byKey('ENG-3')
    expect(t.status).toBe('in_progress')
    expect(c.startedElsewhere(t)).toBe(true)
    expect(needsYouReason(t)).toBeNull()
    expect(svc.status(companyId).links[t.id].status).toBe('in_review')
    // a teammate moves another issue to review: same, and nothing echoes back
    fake.edit('ENG-1', { stateName: 'In Review' })
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(byKey('ENG-1').status).toBe('in_progress')
    expect(fake.writes()).toEqual([])
    // Linear moves it on between started states: still agreed, no write
    fake.edit('ENG-3', { stateName: 'In Progress' })
    await svc.syncNow(companyId)
    expect(byKey('ENG-3').status).toBe('in_progress')
    expect(fake.writes()).toEqual([])
  })

  it('disconnect and reconnect never write back what the disconnect did (released status, unchanged parents)', async () => {
    await connect()
    const started = byKey('ENG-2')
    svc.disconnect(companyId)
    expect(c.task(started.id).status).toBe('todo')
    fake.admin({ op: 'clearLog' })
    await connect()
    expect(fake.writes()).toEqual([])
    expect(fake.team(engTeam())!.states.find((s) => s.id === fake.byKey('ENG-2')!.stateId)!.name).toBe('In Progress')
    expect(c.task(started.id).status).toBe('in_progress')
    expect(c.startedElsewhere(c.task(started.id))).toBe(true)
    await svc.syncNow(companyId)
    expect(fake.writes()).toEqual([])
  })

  it('an issue the Board cannot hold as is gets clamped values; the pass finishes and nothing bounces', async () => {
    fake.createIssue('team-eng', { title: 'Long label', stateName: 'Todo', labels: ['x'.repeat(90)] })
    const blank = fake.createIssue('team-eng', { title: '   ', stateName: 'Todo' })
    const huge = fake.createIssue('team-eng', { title: 'Huge estimate', stateName: 'Todo' }); huge.estimate = 1500
    const v = await connect()
    expect(v).toMatchObject({ state: 'ok', linkedCount: 9 })
    expect(c.listTasks(companyId).find((t) => t.title === 'Long label')!.labels).toEqual(['x'.repeat(80)])
    expect(byKey(blank.identifier).title).toBe(blank.identifier)
    expect(byKey(huge.identifier).estimate).toBe(1000)
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(fake.writes()).toEqual([])
  })

  it('last writer wins per field: an edit of another field here does not make an older title newer', async () => {
    await connect()
    const t = byKey('ENG-1')
    c.updateTask(t.id, { title: 'Local title at T0' })
    await later()
    fake.edit('ENG-1', { title: 'Linear title at T1' })
    await later()
    c.updateTask(t.id, { priority: 1 })
    await svc.syncNow(companyId)
    expect(c.task(t.id)).toMatchObject({ title: 'Linear title at T1', priority: 1 })
    expect(fake.byKey('ENG-1')).toMatchObject({ title: 'Linear title at T1', priority: 1 })
    expect(c.detail(t.id).activity.map((a) => a.message)).toContain('Linear’s title replaced yours')
  })

  it('sync’s own writes do not schedule another pass', async () => {
    await connect({ autosync: true })
    await new Promise((r) => setTimeout(r, 80)) // the pass Connect queued behind Sync Now
    fake.edit('ENG-1', { priority: 1 })
    await svc.syncNow(companyId)
    expect(byKey('ENG-1').priority).toBe(1)
    const timer = (svc as unknown as { timers: Map<string, { at: number }> }).timers.get(companyId)!
    expect(timer.at - Date.now()).toBeGreaterThan(POLL_MS / 2)
    c.updateTask(byKey('ENG-1').id, { title: 'A real local edit' })
    expect((svc as unknown as { timers: Map<string, { at: number }> }).timers.get(companyId)!.at - Date.now()).toBeLessThan(POLL_MS / 2)
  })

  it('Check Key names the other companies already synced with a team', async () => {
    await connect()
    const b = c.create({ name: 'Beta' }).id
    const r = await svc.checkKey(b, KEY)
    expect(r.teams.find((t) => t.key === 'ENG')!.syncedWith).toEqual(['Acme'])
    expect(r.teams.find((t) => t.key === 'DES')!.syncedWith).toBeUndefined()
  })

  it('a pass that fails for a reason other than the network is not shown as offline', async () => {
    await connect()
    const kept = (svc as unknown as { providers: Map<string, { p: { changedSince: () => Promise<never> } }> }).providers.get(companyId)!
    kept.p.changedSince = async () => { throw new Error('unexpected') }
    const v = await svc.syncNow(companyId)
    expect(v.state).toBe('error')
    expect(v.message).toBe('Something went wrong syncing with Linear. Principia tries again later.')
  })

  it('a disconnect during a pass leaves no links behind', async () => {
    await svc.connect({ companyId, key: KEY, teamId: engTeam(), autosync: false, sendOpen: false })
    const p = svc.syncNow(companyId)
    svc.disconnect(companyId)
    await p
    await later()
    expect(svc.store.count(companyId)).toBe(0)
    expect(svc.store.connection(companyId)).toBeNull()
  })

  it('a review brought over by an earlier build as in review heals to in progress there, writing nothing to Linear', async () => {
    await connect()
    const t = byKey('ENG-3')
    c.applyRemote(t.id, { status: 'in_review' }, 'as an earlier build did')
    const link = svc.store.link(t.id)!
    link.local.status = fingerprint('in_review')
    svc.store.saveLink(link)
    fake.admin({ op: 'clearLog' })
    await svc.syncNow(companyId)
    expect(c.task(t.id).status).toBe('in_progress')
    expect(needsYouReason(c.task(t.id))).toBeNull()
    expect(fake.writes()).toEqual([])
  })

  it('a link never blocks a pass because another task still names the same issue', async () => {
    await connect()
    const a = byKey('ENG-1'); const b = byKey('ENG-2')
    const link = svc.store.link(b.id)!
    svc.store.saveLink({ ...svc.store.link(a.id)!, remoteId: link.remoteId })
    expect(svc.store.link(b.id)).toBeNull()
    expect(svc.store.link(a.id)!.remoteId).toBe(link.remoteId)
  })
})
