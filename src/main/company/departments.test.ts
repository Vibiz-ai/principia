import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from './index'
import { assertDepartmentsEnabled, DepartmentStore } from './departments'
import { companyAgentDataSchema, departmentSaveSchema, taskInputSchema, taskPatchSchema } from './schemas'
import { REQUEST_SCHEMAS } from '../ipcSchemas'
import { buildTaskPrompt } from './taskPrompt'
import { route } from './router'
import { pickPersona, type AgentPersona } from '../../shared/personas'
import { INVOKE_CHANNELS } from '../../shared/ipc'
import {
  DEPARTMENT_PRESETS, DEPARTMENT_PRESET_KEYS, TASK_BOARD_DEFAULTS, departmentsEnabled, laneOf, needsYouReason, withTaskDefaults,
  type CompanyPassport, type CompanyTaskInput, type TaskStatus
} from '../../shared/company'

let db: DB; let store: Store; let c: CompanyStore; let d: DepartmentStore; let dir: string
let acme: CompanyPassport; let beta: CompanyPassport
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-departments-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new CompanyStore(store); d = new DepartmentStore(store, c)
  acme = c.create({ name: 'Acme' }); beta = c.create({ name: 'Beta' })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const profile = (adapter: 'claude' | 'shell' = 'claude') => store.createProfile({ name: adapter, adapter, permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
const workflow = (companyId: string) => store.createWorkflow({ name: 'Weekly report', description: '', inputs: [], nodes: [] } as never, null, null, companyId)
const task = (o: Partial<CompanyTaskInput> = {}) => c.createTask({ title: 'Write launch post', description: '', companyId: acme.id, repoId: null, status: 'todo', priority: 2, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...o })
/** Sets the task JSON status directly (the state machine lives in CompanyStore; here only the refusal matters). */
const setStatus = (id: string, status: TaskStatus) => db.prepare("UPDATE company_tasks SET data=json_set(data,'$.status',?) WHERE id=?").run(status, id)

describe('departments', () => {
  it('creates, updates, merges data, keeps the key and lists in order', () => {
    const m = d.save({ companyId: acme.id, name: 'Marketing', data: { charter: { does: 'Copy' } } })
    expect(m).toMatchObject({ key: 'marketing', companyId: acme.id, sortOrder: 0, archivedAt: null })
    expect(m.id).toMatch(/^dep_/)
    expect(m.data).toEqual({ charter: { does: 'Copy', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' })
    const u = d.save({ id: m.id, companyId: acme.id, name: 'Growth', data: { charter: { doesNot: 'Code' }, sourceDefaults: ['posthog'] } })
    expect(u).toMatchObject({ key: 'marketing', name: 'Growth', data: { charter: { does: 'Copy', doesNot: 'Code' }, sourceDefaults: ['posthog'] } })
    expect(() => d.save({ id: m.id, companyId: acme.id, key: 'growth', name: 'Growth' })).toThrow('key cannot change')
    expect(() => d.save({ id: m.id, companyId: beta.id, name: 'Growth' })).toThrow('another company')
    const s = d.save({ companyId: acme.id, name: 'Sales' })
    expect(d.list(acme.id).map(x => x.name)).toEqual(['Growth', 'Sales'])
    expect(d.reorder(acme.id, [s.id]).map(x => x.name)).toEqual(['Sales', 'Growth'])
    expect(() => d.reorder(beta.id, [s.id])).toThrow('not found')
    expect(d.list(beta.id)).toEqual([])
  })
  it('refuses a charter over 600 characters, a duplicate key and a Slack channel routed twice', () => {
    expect(() => d.save({ companyId: acme.id, name: 'Ops', data: { charter: { does: 'x'.repeat(400), doesNot: 'y'.repeat(201) } } })).toThrow('600')
    d.save({ companyId: acme.id, key: 'ops', name: 'Ops', data: { slackChannels: ['C123'] } })
    expect(() => d.save({ companyId: acme.id, key: 'ops', name: 'Ops 2' })).toThrow('already has')
    expect(d.save({ companyId: acme.id, name: 'Ops' }).key).toBe('ops-2')
    expect(() => d.save({ companyId: acme.id, name: 'Support', data: { slackChannels: ['C123'] } })).toThrow('already routes to Ops')
    // another company may route its own copy of the channel id
    expect(d.save({ companyId: beta.id, name: 'Support', data: { slackChannels: ['C123'] } }).data.slackChannels).toEqual(['C123'])
  })
  it('presets create six departments in one call and are idempotent by key', () => {
    const list = d.createPresets(acme.id)
    expect(list.map(x => x.key)).toEqual([...DEPARTMENT_PRESET_KEYS])
    expect(list.find(x => x.key === 'development')?.data.sourceDefaults).toEqual(['github', 'sentry'])
    for (const p of DEPARTMENT_PRESETS) expect(p.data.charter.does.length + p.data.charter.doesNot.length).toBeLessThanOrEqual(600)
    const ids = list.map(x => x.id)
    // renamed and archived ones still count: the key decides
    d.save({ id: ids[1], companyId: acme.id, name: 'Growth' }); d.archive(ids[5])
    expect(d.createPresets(acme.id).map(x => x.id)).toEqual(ids.slice(0, 5))
    expect(d.list(acme.id, { includeArchived: true })).toHaveLength(6)
    expect(d.createPresets(beta.id, ['support']).map(x => x.key)).toEqual(['support'])
    expect(d.createPresets(beta.id).map(x => x.key)).toEqual(['support', 'development', 'marketing', 'sales', 'ops', 'finance'])
  })
  it('refuses to archive a department with open tasks and lists them; done tasks do not block', () => {
    const m = d.save({ companyId: acme.id, name: 'Marketing' })
    const a = task({ departmentId: m.id }), b = task({ departmentId: m.id, title: 'Newsletter', status: 'triage' })
    task({ departmentId: m.id, title: 'Old', status: 'done' })
    let err: unknown
    try { d.archive(m.id) } catch (e) { err = e }
    expect(err).toMatchObject({ code: 'conflict' })
    expect(String((err as Error).message)).toContain(a.identifier)
    expect(String((err as Error).message)).toContain(b.identifier)
    expect(String((err as Error).message)).not.toContain('Old')
    c.updateTask(a.id, { status: 'canceled' }); c.updateTask(b.id, { status: 'canceled' })
    expect(d.archive(m.id).archivedAt).toBeTruthy()
    expect(d.list(acme.id)).toEqual([])
    expect(d.archive(m.id, false).archivedAt).toBeNull()
  })
})

describe('company agents', () => {
  it('a new agent in another company gets a name no other company uses (no shared Marcus across clients)', () => {
    const p = profile()
    const da = d.save({ companyId: acme.id, name: 'Marketing' })
    const db2 = d.save({ companyId: beta.id, name: 'Marketing' })
    const a = d.saveAgent({ companyId: acme.id, departmentId: da.id, kind: 'profile', refId: p.id, name: 'Copywriter' })
    const b = d.saveAgent({ companyId: beta.id, departmentId: db2.id, kind: 'profile', refId: p.id, name: 'Copywriter' })
    expect(a.data.persona?.name).toBe('Marcus')
    expect(b.data.persona?.name).toBe('Ovid')
  })
  it('creates a profile agent with data defaults and merges limits on update', () => {
    const dep = d.save({ companyId: acme.id, name: 'Marketing' })
    const p = profile()
    const a = d.saveAgent({ companyId: acme.id, departmentId: dep.id, kind: 'profile', refId: p.id, name: 'Copywriter' })
    expect(a.id).toMatch(/^agt_/)
    const { persona, ...rest } = a.data
    expect(rest).toEqual({ instructions: '', capabilities: '', autonomy: 'manual', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } })
    expect(persona).toMatchObject({ key: 'marcus', name: 'Marcus' })
    const u = d.saveAgent({ id: a.id, companyId: acme.id, departmentId: dep.id, kind: 'profile', refId: p.id, name: 'Copywriter', data: { autonomy: 'auto', limits: { runMinutes: 10 } } })
    expect(u.data).toMatchObject({ autonomy: 'auto', limits: { runMinutes: 10, autoWakesPerHour: 4 } })
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'X', data: { instructions: 'x'.repeat(4001) } })).toThrow()
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'X', data: { limits: { autoWakesPerHour: 5 } } })).toThrow()
    expect(d.listAgents({ companyId: acme.id, departmentId: dep.id }).map(x => x.name)).toEqual(['Copywriter'])
    expect(d.listAgents({ companyId: acme.id, departmentId: null })).toEqual([])
    expect(d.listAgents({ companyId: beta.id })).toEqual([])
  })
  it('rejects a missing or shell profile', () => {
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: 'prof_missing', name: 'Ghost' })).toThrow('profile not found')
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: profile('shell').id, name: 'Shell' })).toThrow('Shell profiles cannot be agents')
  })
  it('rejects a workflow from another company and accepts one from the same company', () => {
    const wb = workflow(beta.id)
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'workflow', refId: wb.id, name: 'Reporter' })).toThrow('belongs to Beta')
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'workflow', refId: 'wf_missing', name: 'Reporter' })).toThrow('Workflow not found')
    const wa = workflow(acme.id)
    expect(d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'workflow', refId: wa.id, name: 'Reporter' }).kind).toBe('workflow')
  })
  it("rejects an agent whose company differs from its department's", () => {
    const betaDep = d.save({ companyId: beta.id, name: 'Sales' })
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: betaDep.id, kind: 'profile', refId: profile().id, name: 'Closer' })).toThrow('same company as its department')
    const a = d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: profile().id, name: 'Closer' })
    expect(() => d.saveAgent({ id: a.id, companyId: beta.id, departmentId: betaDep.id, kind: 'profile', refId: a.refId, name: 'Closer' })).toThrow('another company')
  })
  it('rejects a default repository owned by another company', () => {
    const repoDir = path.join(dir, 'beta-app'); fs.mkdirSync(repoDir)
    const [repo] = store.addRepo(fs.realpathSync(repoDir)); c.assignRepo(repo.id, beta.id)
    expect(() => d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: profile().id, name: 'Dev', data: { defaultRepoId: repo.id } })).toThrow('belongs to Beta')
  })
  it('refuses to archive or move an agent with a task in flight and lists it; pause and resume', () => {
    const dep = d.save({ companyId: acme.id, name: 'Marketing' })
    const a = d.saveAgent({ companyId: acme.id, departmentId: dep.id, kind: 'profile', refId: profile().id, name: 'Copywriter' })
    const t = task({ departmentId: dep.id, agentId: a.id }); setStatus(t.id, 'in_progress')
    expect(() => d.archiveAgent(a.id)).toThrow(`Copywriter is working on ${t.identifier}`)
    expect(() => d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: a.refId, name: 'Copywriter' })).toThrow(t.identifier)
    // renaming and instructions are fine while busy
    expect(d.saveAgent({ id: a.id, companyId: acme.id, departmentId: dep.id, kind: 'profile', refId: a.refId, name: 'Writer', data: { instructions: 'Short' } }).name).toBe('Writer')
    expect(d.pauseAgent(a.id).pausedAt).toBeTruthy()
    expect(d.resumeAgent(a.id).pausedAt).toBeNull()
    setStatus(t.id, 'in_review')
    expect(d.archiveAgent(a.id).archivedAt).toBeTruthy()
    expect(d.listAgents({ companyId: acme.id })).toEqual([])
    expect(d.listAgents({ companyId: acme.id, includeArchived: true })).toHaveLength(1)
  })
  it("refuses to archive a department whose agents are in flight on a task filed elsewhere", () => {
    const dep = d.save({ companyId: acme.id, name: 'Marketing' })
    const a = d.saveAgent({ companyId: acme.id, departmentId: dep.id, kind: 'profile', refId: profile().id, name: 'Copywriter' })
    const t = task({ agentId: a.id }); setStatus(t.id, 'in_progress')
    expect(() => d.archive(dep.id)).toThrow(t.identifier)
    setStatus(t.id, 'in_review')
    expect(d.archive(dep.id).archivedAt).toBeTruthy()
  })
  it('lets a seat whose profile was deleted be renamed, but checks a new backing', () => {
    const p = profile()
    const a = d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Dev' })
    db.prepare('UPDATE company_agents SET ref_id=? WHERE id=?').run('prof_gone', a.id)
    expect(d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: 'prof_gone', name: 'Dev 2' }).name).toBe('Dev 2')
    expect(() => d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: profile('shell').id, name: 'Dev 2' })).toThrow('Shell')
  })
  it('task writes: department and agent stay in the task company, archived ones are not newly set, done needs approval', () => {
    const mk = d.save({ companyId: acme.id, name: 'Marketing' }), sales = d.save({ companyId: acme.id, name: 'Sales' })
    const betaDep = d.save({ companyId: beta.id, name: 'Marketing' })
    const writer = d.saveAgent({ companyId: acme.id, departmentId: mk.id, kind: 'profile', refId: profile().id, name: 'Copywriter' })
    const anyone = d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: profile().id, name: 'Generalist' })
    const betaAgent = d.saveAgent({ companyId: beta.id, departmentId: null, kind: 'profile', refId: profile().id, name: 'Closer' })
    const input = (o: Partial<CompanyTaskInput>): CompanyTaskInput => ({ title: 'T', description: '', companyId: acme.id, repoId: null, status: 'todo', priority: 2, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...o })
    expect(() => d.assertTaskCreate(input({ departmentId: betaDep.id }))).toThrow('another company')
    expect(() => d.assertTaskCreate(input({ agentId: betaAgent.id }))).toThrow('another company')
    expect(() => d.assertTaskCreate(input({ departmentId: sales.id, agentId: writer.id }))).toThrow('another department')
    expect(() => d.assertTaskCreate(input({ departmentId: mk.id, status: 'done' }))).toThrow('approve')
    expect(() => d.assertTaskCreate(input({ departmentId: 'dep_missing' }))).toThrow('not found')
    d.assertTaskCreate(input({ departmentId: sales.id, agentId: anyone.id }))
    d.assertTaskCreate(input({ status: 'done' }))
    const t = task({ departmentId: mk.id, agentId: writer.id })
    expect(() => d.assertTaskPatch(t, { agentId: betaAgent.id })).toThrow('another company')
    expect(() => d.assertTaskPatch(t, { departmentId: sales.id })).toThrow('another department')
    d.assertTaskPatch(t, { departmentId: sales.id, agentId: anyone.id })
    expect(() => d.assertTaskPatch(t, { status: 'done' })).toThrow('done note')
    expect(() => d.assertTaskPatch({ ...task(), status: 'in_review' }, { status: 'done' })).toThrow('done note')
    // a plain company task without department or agent keeps today's status edits
    d.assertTaskPatch(task(), { status: 'done' })
    // an archived agent stays on its task but cannot be newly assigned
    d.archiveAgent(anyone.id)
    d.assertTaskPatch({ ...t, agentId: anyone.id, departmentId: null }, { title: 'x' })
    expect(() => d.assertTaskPatch(t, { agentId: anyone.id, departmentId: null })).toThrow('archived')
  })
  it('reads corrupt or partial data JSON with defaults', () => {
    const dep = d.save({ companyId: acme.id, name: 'Ops' })
    db.prepare("UPDATE company_departments SET data='not json' WHERE id=?").run(dep.id)
    expect(d.department(dep.id).data.charter).toEqual({ does: '', doesNot: '' })
    db.prepare(`INSERT INTO company_agents(id,company_id,department_id,kind,ref_id,name,data) VALUES('agt_old',?,NULL,'profile','prof_x','Old','{"autonomy":"auto","future":1}')`).run(acme.id)
    expect(d.agent('agt_old').data).toMatchObject({ autonomy: 'auto', mode: 'headless', limits: { runMinutes: 30, autoWakesPerHour: 4 } })
  })
})

describe('agent personas (VOICE.md §4)', () => {
  const save = (o: { departmentId?: string | null; name?: string; persona?: AgentPersona; companyId?: string } = {}) => {
    const p = profile()
    return d.saveAgent({ companyId: o.companyId ?? acme.id, departmentId: o.departmentId ?? null, kind: 'profile', refId: p.id, name: o.name ?? 'Copywriter', ...(o.persona ? { data: { persona: o.persona } } : {}) })
  }
  it('assigns a valid persona on create from the department pool, unique among active agents', () => {
    const [dev, mkt] = d.createPresets(acme.id, ['development', 'marketing'])
    const a = save({ departmentId: mkt.id }), b = save({ departmentId: mkt.id }), c1 = save({ departmentId: dev.id }), e = save()
    expect(companyAgentDataSchema.shape.persona.safeParse(a.data.persona).success).toBe(true)
    expect([a, b, c1, e].map(x => x.data.persona?.name)).toEqual(['Marcus', 'Ovid', 'Livia', 'Junia'])
    expect(a.data.persona?.look).toEqual(pickPersona({ departmentKey: 'marketing', used: new Set(), seed: `${acme.id}:${a.id}` }).look)
    // agent.name stays the role label
    expect(a.name).toBe('Copywriter')
    // stored: a re-read gives the same face
    expect(d.agent(a.id).data.persona).toEqual(a.data.persona)
    // another company avoids the names this one uses (five doors: clients never seem to share an agent); an archived
    // agent frees its name
    expect(save({ companyId: beta.id }).data.persona?.name).toBe('Seneca')
    d.archiveAgent(b.id)
    expect(save({ departmentId: mkt.id }).data.persona?.name).toBe('Ovid')
  })
  it('infers the preset from a custom department name, else uses the no-department pool', () => {
    const growth = d.save({ companyId: acme.id, key: 'growth-team', name: 'Marketing' })
    const lab = d.save({ companyId: acme.id, name: 'Constructor Lab' })
    expect(save({ departmentId: growth.id }).data.persona?.name).toBe('Marcus')
    expect(save({ departmentId: lab.id }).data.persona?.name).toBe('Junia')
  })
  it('reserves the names legacy agents are shown with', () => {
    db.prepare(`INSERT INTO company_agents(id,company_id,department_id,kind,ref_id,name,created_at,data) VALUES('agt_old',?,NULL,'profile','prof_x','Old','2020-01-01T00:00:00.000Z','{}')`).run(acme.id)
    expect(d.agent('agt_old').data.persona).toBeUndefined()
    expect(save().data.persona?.name).toBe('Seneca')
  })
  it('updates a legacy agent without inventing a persona, and persists one when the user renames it', () => {
    const p = profile()
    db.prepare(`INSERT INTO company_agents(id,company_id,department_id,kind,ref_id,name,created_at,data) VALUES('agt_old',?,NULL,'profile',?,'Old','2020-01-01T00:00:00.000Z','{"autonomy":"auto"}')`).run(acme.id, p.id)
    const u = d.saveAgent({ id: 'agt_old', companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Old', data: { instructions: 'Hi.' } })
    expect(u.data.persona).toBeUndefined()
    expect(u.data).toMatchObject({ autonomy: 'auto', instructions: 'Hi.' })
    const shown = pickPersona({ departmentKey: null, used: new Set(), seed: `${acme.id}:agt_old` })
    const r = d.saveAgent({ id: 'agt_old', companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Old', data: { persona: { ...shown, name: 'Maximus' } } })
    expect(r.name).toBe('Old')
    expect(r.data.persona).toEqual({ ...shown, name: 'Maximus' })
    expect(r.data).toMatchObject({ autonomy: 'auto', instructions: 'Hi.' })
  })
  it('keeps a given persona on create when its name is free, re-picks when taken', () => {
    const mine: AgentPersona = { key: 'custom', name: 'Brutus', personality: 'Trusty.', bio: 'Mostly.', look: { material: 'bronze', hair: 'crop', beard: 'full', laurel: false, drape: 'gold' } }
    expect(save({ persona: mine }).data.persona).toEqual(mine)
    expect(save({ persona: { ...mine, name: 'brutus' } }).data.persona?.name).toBe('Junia')
  })
  it('keeps a rename on update and never changes agent.name', () => {
    const p = profile()
    const a = d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Copywriter' })
    const renamed = { ...a.data.persona!, name: 'Maximus' }
    const u = d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Copywriter', data: { persona: renamed } })
    expect(u.name).toBe('Copywriter')
    expect(u.data.persona).toEqual(renamed)
    // an update that does not name the persona keeps it
    const v = d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Writer', data: { autonomy: 'auto' } })
    expect(v.data.persona).toEqual(renamed)
    expect(v.name).toBe('Writer')
    // an invalid persona is refused at the IPC/schema boundary
    expect(() => d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Writer', data: { persona: { ...renamed, name: 'x'.repeat(25) } } })).toThrow()
    expect(() => d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Writer', data: { persona: { ...renamed, extra: 1 } as never } })).toThrow()
  })
  it('refuses a rename to a name another active agent is shown with, case-insensitively', () => {
    const p = profile()
    const a = d.saveAgent({ companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Copywriter' })
    const b = save()
    const upd = (name: string) => d.saveAgent({ id: a.id, companyId: acme.id, departmentId: null, kind: 'profile', refId: p.id, name: 'Copywriter', data: { persona: { ...a.data.persona!, name } } })
    expect(() => upd(` ${b.data.persona!.name.toUpperCase()} `)).toThrow(/already called/)
    // its own name is free to keep (an About-only edit re-sends it), and a free name passes
    expect(upd(a.data.persona!.name).data.persona?.name).toBe(a.data.persona!.name)
    expect(upd('Maximus').data.persona?.name).toBe('Maximus')
    // an archived agent frees its name
    d.archiveAgent(b.id)
    expect(upd(b.data.persona!.name).data.persona?.name).toBe(b.data.persona!.name)
  })
  it('heals a corrupt persona by dropping only that field, and keeps a good persona when the rest is corrupt', () => {
    const a = save()
    const good = a.data.persona!
    db.prepare('UPDATE company_agents SET data=? WHERE id=?').run(JSON.stringify({ autonomy: 'auto', instructions: 'Be brief.', persona: { ...good, look: { ...good.look, material: 'gold' } } }), a.id)
    const healed = d.agent(a.id)
    expect(healed.data.persona).toBeUndefined()
    expect(healed.data).toMatchObject({ autonomy: 'auto', instructions: 'Be brief.' })
    db.prepare('UPDATE company_agents SET data=? WHERE id=?').run(JSON.stringify({ autonomy: 'sometimes', persona: good }), a.id)
    expect(d.agent(a.id).data).toMatchObject({ autonomy: 'manual', persona: good })
    db.prepare('UPDATE company_agents SET data=? WHERE id=?').run('[1,2]', a.id)
    expect(d.agent(a.id).data.persona).toBeUndefined()
  })
  it('router and task prompt still use agent.name (the role label)', () => {
    const [mkt] = d.createPresets(acme.id, ['marketing'])
    const a = save({ departmentId: mkt.id })
    expect(a.data.persona?.name).toBe('Marcus')
    const prompt = buildTaskPrompt({ task: { identifier: 'ACM-1', title: 'Post', description: '', source: 'manual', sourceUrl: null }, companyId: acme.id, department: { name: mkt.name }, agent: { name: a.name, instructions: a.data.instructions }, deps: [], activity: [], wake: [] })
    expect(prompt).toContain('agent="Copywriter"')
    expect(prompt).not.toContain('Marcus')
    const r = route({ companyId: acme.id, title: 'Post', description: '', source: 'manual', sourceUrl: null, status: 'todo', agentId: a.id }, { departments: d.list(acme.id), agents: d.listAgents({ companyId: acme.id }) })
    expect(r.reason).toContain('Copywriter')
    expect(r.reason).not.toContain('Marcus')
  })
})

describe('laneOf (§1.5)', () => {
  const t = (status: TaskStatus, o: Partial<CompanyTaskInput> = {}) => ({ status, departmentId: null, agentId: null, assigneeProfileId: null, blockReason: null, ...o })
  it('maps every lane row', () => {
    expect(laneOf(t('triage'))).toBe('inbox')
    for (const s of ['backlog', 'todo'] as const) expect(laneOf(t(s))).toBe('queued')
    expect(laneOf(t('blocked', { blockReason: 'deps' }))).toBe('queued')
    expect(laneOf(t('in_progress'))).toBe('working')
    expect(laneOf(t('in_progress'), true)).toBe('needs_you')
    expect(laneOf(t('in_review'))).toBe('needs_you')
    for (const r of ['needs_input', 'run_failed', 'interrupted', 'no_report', 'limit', 'agent', 'handoff_cap', 'manual'] as const) expect(laneOf(t('blocked', { blockReason: r }))).toBe('needs_you')
    // an older build's blocked row has no reason: never treated as healable
    expect(laneOf(t('blocked'))).toBe('needs_you')
    expect(laneOf(t('done'))).toBe('done')
    expect(laneOf(t('canceled'))).toBe('done')
  })
  it('todo/triage with a department but no eligible agent need the human', () => {
    expect(laneOf(t('todo', { departmentId: 'dep_a' }))).toBe('needs_you')
    expect(laneOf(t('triage', { departmentId: 'dep_a' }))).toBe('needs_you')
    expect(needsYouReason(t('todo', { departmentId: 'dep_a' }))).toBe('unassigned')
    expect(laneOf(t('todo', { departmentId: 'dep_a', agentId: 'agt_a' }))).toBe('queued')
    expect(laneOf(t('triage', { departmentId: 'dep_a', agentId: 'agt_a' }))).toBe('inbox')
    // legacy alias still counts as assigned; backlog is parked on purpose
    expect(laneOf(t('todo', { departmentId: 'dep_a', assigneeProfileId: 'prof_a' }))).toBe('queued')
    expect(laneOf(t('backlog', { departmentId: 'dep_a' }))).toBe('queued')
    // the assigned agent is paused or archived: no eligible agent
    expect(laneOf(t('todo', { departmentId: 'dep_a', agentId: 'agt_a' }), false, false)).toBe('needs_you')
    expect(needsYouReason(t('triage', { departmentId: 'dep_a', agentId: 'agt_a' }), false, false)).toBe('unassigned')
    expect(laneOf(t('todo', { agentId: 'agt_a' }), false, false)).toBe('queued')
  })
  it('needsYouReason names the chip and is null outside Needs you', () => {
    expect(needsYouReason(t('in_review'))).toBe('review')
    expect(needsYouReason(t('in_progress'), true)).toBe('live_ask')
    expect(needsYouReason(t('blocked', { blockReason: 'limit' }))).toBe('limit')
    expect(needsYouReason(t('in_progress'))).toBeNull()
    expect(needsYouReason(t('blocked', { blockReason: 'deps' }))).toBeNull()
  })
})

describe('task schema and IPC contract', () => {
  const old = { title: 'Fix login', description: '', companyId: 'co_abc', repoId: null, status: 'blocked', priority: 2, source: 'github', sourceUrl: 'https://github.com/a/b/issues/1', externalId: null, assigneeProfileId: 'prof_x', parentId: null, dependencyIds: [] }
  it('old task JSON rows parse with the §1.3 defaults', () => {
    expect(taskInputSchema.parse(old)).toEqual({ ...old, ...TASK_BOARD_DEFAULTS })
    expect(withTaskDefaults(old as CompanyTaskInput)).toEqual({ ...old, ...TASK_BOARD_DEFAULTS })
    expect(taskInputSchema.parse({ ...old, source: 'agent', blockReason: 'needs_input', ask: { kind: 'choice', prompt: 'Which?', options: ['A', 'B'] }, handoffs: 2 })).toMatchObject({ blockReason: 'needs_input', handoffs: 2 })
    expect(() => taskInputSchema.parse({ ...old, blockReason: 'bogus' })).toThrow()
    expect(() => taskInputSchema.parse({ ...old, extra: 1 })).toThrow()
  })
  it('patches never reset fields they do not name', () => {
    expect(taskPatchSchema.parse({ title: 'x' })).toEqual({ title: 'x' })
    expect(REQUEST_SCHEMAS['tasks:update'].parse({ id: 'task_1', patch: { departmentId: 'dep_a' } })).toEqual({ id: 'task_1', patch: { departmentId: 'dep_a' } })
  })
  it('the renderer cannot write main-only task fields', () => {
    expect(REQUEST_SCHEMAS['tasks:update'].safeParse({ id: 'task_1', patch: { doneNote: 'ok' } }).success).toBe(false)
    expect(REQUEST_SCHEMAS['tasks:update'].safeParse({ id: 'task_1', patch: { report: null } }).success).toBe(false)
    expect(REQUEST_SCHEMAS['tasks:create'].safeParse({ task: { ...old, autoWakes: { windowStart: null, n: 0 } } }).success).toBe(false)
    expect(REQUEST_SCHEMAS['tasks:create'].safeParse({ task: { ...old, departmentId: 'dep_a', agentId: 'agt_a' } }).success).toBe(true)
  })
  it('declares and validates every §10 channel', () => {
    const channels = ['departments:list', 'departments:save', 'departments:archive', 'departments:reorder', 'departments:createPresets', 'companyAgents:list', 'companyAgents:save', 'companyAgents:archive', 'companyAgents:pause', 'companyAgents:resume',
      'tasks:assign', 'tasks:acceptRoute', 'tasks:answer', 'tasks:approve', 'tasks:sendBack', 'tasks:unpark', 'tasks:openSession', 'tasks:takeover', 'tasks:stop', 'tasks:pause', 'board:autopilot'] as const
    for (const ch of channels) { expect(INVOKE_CHANNELS).toContain(ch); expect(REQUEST_SCHEMAS[ch]).toBeDefined() }
    expect(REQUEST_SCHEMAS['tasks:approve'].safeParse({ id: 'task_1' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['tasks:approve'].safeParse({ id: 'task_1', doneNote: 'x'.repeat(10_001) }).success).toBe(false)
    expect(REQUEST_SCHEMAS['tasks:assign'].safeParse({ id: 'task_1' }).success).toBe(false)
    expect(REQUEST_SCHEMAS['tasks:assign'].safeParse({ id: 'task_1', agentId: null }).success).toBe(true)
    expect(REQUEST_SCHEMAS['board:autopilot'].safeParse({ companyId: 'co_a', on: true }).success).toBe(true)
    expect(REQUEST_SCHEMAS['companyAgents:list'].parse(undefined)).toBeUndefined()
    expect(departmentSaveSchema.safeParse({ companyId: 'co_a', name: 'X', data: { slackChannels: ['general'] } }).success).toBe(false)
    expect(companyAgentDataSchema.parse({}).limits).toEqual({ runMinutes: 30, autoWakesPerHour: 4 })
    expect(REQUEST_SCHEMAS['settings:update'].safeParse({ experimental: { departments: true } }).success).toBe(true)
  })
  it('schedules and Slack triggers accept task mode and a department', () => {
    const when = { kind: 'cron', cron: '0 9 * * 1', tz: 'UTC' }
    const r = REQUEST_SCHEMAS['schedules:create'].parse({ name: 'Weekly', target: { kind: 'workflow', workflowId: 'wf_1', inputs: {}, mode: 'task', agentId: 'agt_1' }, when, departmentId: 'dep_a' }) as { target: { mode?: string; agentId?: string }; departmentId?: string }
    expect(r.target).toMatchObject({ mode: 'task', agentId: 'agt_1' }); expect(r.departmentId).toBe('dep_a')
    expect(REQUEST_SCHEMAS['schedules:create'].safeParse({ name: 'Weekly', target: { kind: 'workflow', workflowId: 'wf_1', inputs: {}, mode: 'later' }, when }).success).toBe(false)
  })
})

describe('experimental gate', () => {
  it('needs both companies and departments', () => {
    expect(departmentsEnabled({ companies: true, departments: true })).toBe(true)
    expect(departmentsEnabled({ departments: true })).toBe(false)
    expect(departmentsEnabled({ companies: true })).toBe(false)
    expect(departmentsEnabled(undefined)).toBe(false)
    expect(() => assertDepartmentsEnabled({ departments: true })).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => assertDepartmentsEnabled({ companies: true, departments: true })).not.toThrow()
  })
})
