/**
 * DEPARTMENTS.md §1.1, §9, §10: departments inside a company and the company-scoped agent seats in them. Rows live in
 * company_departments / company_agents (created by healV2Columns); their JSON `data` is parsed with defaults so rows
 * from older or newer builds still read. Nothing here starts work: the dispatcher and the board read these rows.
 *
 * Rules enforced on every write:
 * - a department and an agent never change company; an agent's company equals its department's;
 * - a profile agent's profile exists and is not `shell`; a workflow agent's workflow belongs to the same company;
 * - archiving an agent with an in-flight task, or a department with open tasks, is refused and names them.
 */
import { randomBytes } from 'node:crypto'
import {
  AGENT_DATA_DEFAULTS, DEPARTMENT_DATA_DEFAULTS, DEPARTMENT_PRESETS, departmentsEnabled,
  type CompanyAgent, type CompanyAgentData, type CompanyTask, type CompanyTaskInput, type CompanyAgentSaveInput, type Department, type DepartmentData, type DepartmentPresetKey, type DepartmentSaveInput
} from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { DEPT_POOLS, personaNamesElsewhere, pickPersona, usedPersonaNames, type AgentPersona } from '../../shared/personas'
import type { ExperimentalFlags } from '../../shared/types'
import { companySlug, defaultCompanyColor } from '../db/companyMigration'
import type { Store } from '../db/store'
import type { CompanyStore } from './index'
import { companyAgentDataSchema, companyAgentSaveSchema, departmentDataSchema, departmentPresetsSchema, departmentReorderSchema, departmentSaveSchema, personaSchema } from './schemas'

const uid = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`
const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const notFound = (message: string): never => { throw new HiveError('not_found', message) }
/** Refusals that name the blocking tasks (archive with work open). */
const blocked = (message: string): never => { throw new HiveError('conflict', message) }
/** At most this many identifiers in a refusal, then "and N more". */
const LIST_MAX = 5

/** §0.8: every departments/companyAgents/board channel refuses unless both flags are on. */
export function assertDepartmentsEnabled(flags: ExperimentalFlags | null | undefined): void {
  if (!departmentsEnabled(flags)) throw new HiveError('forbidden', 'Departments are experimental. Turn on Companies and Departments under Settings → Experimental first.')
}

type DeptRow = { id: string; company_id: string; key: string; name: string; color: string | null; icon: string | null; sort_order: number | null; archived_at: string | null; created_at: string | null; updated_at: string | null; data: string }
type AgentRow = { id: string; company_id: string; department_id: string | null; kind: string; ref_id: string; name: string; archived_at: string | null; paused_at: string | null; created_at: string | null; updated_at: string | null; data: string }
type TaskRef = { id: string; identifier: string; title: string }

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return {} }
}
/** Stored department JSON with defaults; a corrupt or out-of-range row reads as the defaults it can keep. */
function readDeptData(text: string): DepartmentData {
  const r = departmentDataSchema.safeParse(parseJson(text))
  return r.success ? r.data : structuredClone(DEPARTMENT_DATA_DEFAULTS)
}
/**
 * Stored agent JSON with defaults. The persona heals on its own (VOICE.md §4.2): a bad one is dropped and the rest
 * kept; a good one survives a corrupt rest.
 */
function readAgentData(text: string): CompanyAgentData {
  const raw = parseJson(text)
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  const p = 'persona' in obj ? personaSchema.safeParse(obj.persona) : null
  if (p && !p.success) delete obj.persona
  const r = companyAgentDataSchema.safeParse(obj)
  if (r.success) return r.data
  const data: CompanyAgentData = structuredClone(AGENT_DATA_DEFAULTS)
  if (p?.success) data.persona = p.data
  return data
}
/** The preset a department stands for (its key, else its name), for the persona pools; null for a custom one. */
function presetKeyOf(d: Department): DepartmentPresetKey | null {
  const has = (k: string): k is DepartmentPresetKey => Object.prototype.hasOwnProperty.call(DEPT_POOLS, k)
  if (has(d.key)) return d.key
  const byName = DEPARTMENT_PRESETS.find(p => p.name.toLowerCase() === d.name.trim().toLowerCase())
  return byName ? byName.key : null
}
const toDept = (r: DeptRow): Department => ({
  id: r.id, companyId: r.company_id, key: r.key, name: r.name, color: r.color, icon: r.icon, sortOrder: r.sort_order ?? 0,
  archivedAt: r.archived_at, createdAt: r.created_at ?? '', updatedAt: r.updated_at ?? r.created_at ?? '', data: readDeptData(r.data)
})
const toAgent = (r: AgentRow): CompanyAgent => ({
  id: r.id, companyId: r.company_id, departmentId: r.department_id, kind: r.kind === 'workflow' ? 'workflow' : 'profile', refId: r.ref_id, name: r.name,
  archivedAt: r.archived_at, pausedAt: r.paused_at, createdAt: r.created_at ?? '', updatedAt: r.updated_at ?? r.created_at ?? '', data: readAgentData(r.data)
})
const listRefs = (tasks: TaskRef[]): string =>
  tasks.slice(0, LIST_MAX).map(t => `${t.identifier} ${t.title}`).join(', ') + (tasks.length > LIST_MAX ? ` and ${tasks.length - LIST_MAX} more` : '')

/** The task JSON is the source of truth (the company_tasks mirrors may lag behind an older build's write). */
const TASK_JSON = (field: string) => `CASE WHEN json_valid(data) THEN json_extract(data,'$.${field}') END`

export interface AgentListQuery { companyId?: string; departmentId?: string | null; includeArchived?: boolean }

export class DepartmentStore {
  constructor(readonly store: Store, readonly company: CompanyStore) {}
  private get db() { return this.store.db }

  // ---------- departments ----------
  /** Sidebar order (sort_order, then creation). Archived only with includeArchived. */
  list(companyId?: string, opts: { includeArchived?: boolean } = {}): Department[] {
    const where = [companyId ? 'company_id = @companyId' : '1', opts.includeArchived ? '1' : 'archived_at IS NULL'].join(' AND ')
    return (this.db.prepare(`SELECT * FROM company_departments WHERE ${where} ORDER BY company_id, COALESCE(sort_order, 1e9), created_at, rowid`).all({ companyId }) as DeptRow[]).map(toDept)
  }
  get(id: string): Department | null {
    const r = this.db.prepare('SELECT * FROM company_departments WHERE id = ?').get(id) as DeptRow | undefined
    return r ? toDept(r) : null
  }
  department(id: string): Department { return this.get(id) ?? notFound('Department not found') }
  byKey(companyId: string, key: string): Department | null {
    const r = this.db.prepare('SELECT * FROM company_departments WHERE company_id = ? AND key = ?').get(companyId, key) as DeptRow | undefined
    return r ? toDept(r) : null
  }

  /** Create (no id) or update. The key is fixed at creation; data merges into the stored JSON. */
  save(input: DepartmentSaveInput): Department {
    const i = departmentSaveSchema.parse(input)
    const id = this.db.transaction(() => {
      const company = this.company.passport(i.companyId)
      const existing = i.id ? this.department(i.id) : null
      if (existing && existing.companyId !== i.companyId) fail('A department cannot move to another company')
      if (!existing && company.archivedAt) fail(`Unarchive ${company.name} before adding departments to it.`)
      if (existing && i.key !== undefined && i.key !== existing.key) fail('A department key cannot change after creation')
      const base = existing?.data ?? DEPARTMENT_DATA_DEFAULTS
      const merged = departmentDataSchema.safeParse({ ...base, ...i.data, charter: { ...base.charter, ...i.data?.charter } })
      if (!merged.success) fail(merged.error.issues[0]?.message ?? 'Invalid department')
      const data = merged.data!
      this.checkSlackChannels(i.companyId, data.slackChannels, existing?.id ?? null)
      const now = new Date().toISOString()
      if (existing) {
        this.db.prepare('UPDATE company_departments SET name=?, color=?, icon=?, data=?, updated_at=? WHERE id=?')
          .run(i.name, i.color === undefined ? existing.color : i.color ?? defaultCompanyColor(existing.id), i.icon === undefined ? existing.icon : i.icon, JSON.stringify(data), now, existing.id)
        return existing.id
      }
      const taken = new Set(this.list(i.companyId, { includeArchived: true }).map(d => d.key))
      if (i.key && taken.has(i.key)) blocked(`${company.name} already has a department with the key "${i.key}"`)
      const key = i.key ?? companySlug(i.name, taken)
      const did = uid('dep')
      this.db.prepare('INSERT INTO company_departments(id,company_id,key,name,color,icon,sort_order,archived_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)')
        .run(did, i.companyId, key, i.name, i.color ?? defaultCompanyColor(did), i.icon ?? null, this.nextSort(i.companyId), now, now, JSON.stringify(data))
      return did
    })()
    return this.department(id)
  }
  /** A Slack channel routes to at most one active department of a company (§2 step 3 stays deterministic). */
  private checkSlackChannels(companyId: string, channels: string[], self: string | null): void {
    if (!channels.length) return
    for (const d of this.list(companyId)) {
      if (d.id === self) continue
      const clash = channels.find(c => d.data.slackChannels.includes(c))
      if (clash) blocked(`Slack channel ${clash} already routes to ${d.name}`)
    }
  }
  private nextSort(companyId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM company_departments WHERE company_id=?').get(companyId) as { n: number }).n
  }

  /** Open (not done/canceled) tasks of a department, newest first. */
  openTasksInDepartment(departmentId: string): TaskRef[] {
    return this.db.prepare(`SELECT id, ${TASK_JSON('identifier')} AS identifier, ${TASK_JSON('title')} AS title FROM company_tasks
      WHERE ${TASK_JSON('departmentId')} = ? AND COALESCE(${TASK_JSON('status')}, '') NOT IN ('done','canceled') ORDER BY seq DESC`).all(departmentId) as TaskRef[]
  }
  /** Archive replaces delete; refused while the department has open tasks. `archived=false` restores it. */
  archive(id: string, archived = true): Department {
    this.db.transaction(() => {
      const d = this.department(id)
      if (!archived) {
        if (this.company.passport(d.companyId).archivedAt) fail('Unarchive the company first')
        this.db.prepare('UPDATE company_departments SET archived_at=NULL, updated_at=? WHERE id=?').run(new Date().toISOString(), id)
        return
      }
      if (d.archivedAt) return
      const open = this.openTasksInDepartment(id)
      if (open.length) blocked(`${d.name} has ${open.length} open task${open.length === 1 ? '' : 's'}: ${listRefs(open)}. Finish, cancel or move them before archiving.`)
      // its agents may be in flight on a task filed elsewhere (company-level, or handed off): an archived department never has work running
      const busy = this.listAgents({ companyId: d.companyId, departmentId: id }).flatMap(a => this.inFlightTasks(a.id))
      if (busy.length) blocked(`${d.name}'s agents are working on ${listRefs(busy)}. Stop or finish them before archiving.`)
      const now = new Date().toISOString()
      this.db.prepare('UPDATE company_departments SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id)
    })()
    return this.department(id)
  }
  /** New order within one company. Unlisted departments keep their relative order after the listed ones. */
  reorder(companyId: string, ids: string[]): Department[] {
    const q = departmentReorderSchema.parse({ companyId, ids })
    this.db.transaction(() => {
      this.company.passport(q.companyId)
      const all = this.list(q.companyId, { includeArchived: true })
      const known = new Set(all.map(d => d.id))
      for (const id of q.ids) if (!known.has(id)) notFound('Department not found in this company')
      const listed = [...new Set(q.ids)]
      const order = [...listed, ...all.map(d => d.id).filter(id => !listed.includes(id))]
      const up = this.db.prepare('UPDATE company_departments SET sort_order=? WHERE id=?')
      order.forEach((id, n) => up.run(n, id))
    })()
    return this.list(q.companyId)
  }
  /**
   * §9 "+" chips: the six presets (or `keys`) in one call and one transaction. Idempotent by key: a department that
   * already has the key (archived included) is left as it is. Returns the company's active departments.
   */
  createPresets(companyId: string, keys?: DepartmentPresetKey[]): Department[] {
    const q = departmentPresetsSchema.parse({ companyId, ...(keys ? { keys } : {}) })
    this.db.transaction(() => {
      const company = this.company.passport(q.companyId)
      if (company.archivedAt) fail(`Unarchive ${company.name} before adding departments to it.`)
      const wanted = new Set(q.keys ?? DEPARTMENT_PRESETS.map(p => p.key))
      const ins = this.db.prepare('INSERT OR IGNORE INTO company_departments(id,company_id,key,name,color,icon,sort_order,archived_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)')
      const now = new Date().toISOString()
      let sort = this.nextSort(q.companyId)
      for (const p of DEPARTMENT_PRESETS) {
        if (!wanted.has(p.key) || this.byKey(q.companyId, p.key)) continue
        ins.run(uid('dep'), q.companyId, p.key, p.name, p.color, p.icon, sort++, now, now, JSON.stringify(p.data))
      }
    })()
    return this.list(q.companyId)
  }

  // ---------- agents ----------
  listAgents(q: AgentListQuery = {}): CompanyAgent[] {
    const where = [q.companyId ? 'company_id = @companyId' : '1', q.departmentId === undefined ? '1' : q.departmentId === null ? 'department_id IS NULL' : 'department_id = @departmentId',
      q.includeArchived ? '1' : 'archived_at IS NULL'].join(' AND ')
    return (this.db.prepare(`SELECT * FROM company_agents WHERE ${where} ORDER BY company_id, created_at, rowid`).all({ companyId: q.companyId, departmentId: q.departmentId }) as AgentRow[]).map(toAgent)
  }
  getAgent(id: string): CompanyAgent | null {
    const r = this.db.prepare('SELECT * FROM company_agents WHERE id = ?').get(id) as AgentRow | undefined
    return r ? toAgent(r) : null
  }
  agent(id: string): CompanyAgent { return this.getAgent(id) ?? notFound('Agent not found') }
  /** The agent's tasks in flight (in_progress; a session lease is in_progress too). At most one by the claim rule. */
  inFlightTasks(agentId: string): TaskRef[] {
    return this.db.prepare(`SELECT id, ${TASK_JSON('identifier')} AS identifier, ${TASK_JSON('title')} AS title FROM company_tasks
      WHERE ${TASK_JSON('agentId')} = ? AND ${TASK_JSON('status')} = 'in_progress' ORDER BY seq DESC`).all(agentId) as TaskRef[]
  }

  /** Create (no id) or update an agent seat. See the module comment for the rules. */
  saveAgent(input: CompanyAgentSaveInput): CompanyAgent {
    const i = companyAgentSaveSchema.parse(input)
    const id = this.db.transaction(() => {
      const company = this.company.passport(i.companyId)
      const existing = i.id ? this.agent(i.id) : null
      if (existing && existing.companyId !== i.companyId) fail('An agent cannot move to another company')
      if (!existing && company.archivedAt) fail(`Unarchive ${company.name} before adding agents to it.`)
      if (i.departmentId) {
        const d = this.department(i.departmentId)
        if (d.companyId !== i.companyId) fail(`An agent must belong to the same company as its department (${d.name} is in another company)`)
        if (d.archivedAt && d.id !== existing?.departmentId) fail(`${d.name} is archived`)
      }
      // a seat whose profile was deleted can still be renamed or re-pointed; what backs it is checked when it is set
      if (!existing || existing.kind !== i.kind || existing.refId !== i.refId) this.checkRef(i.companyId, i.kind, i.refId)
      else if (i.kind === 'workflow' && this.store.getWorkflow(i.refId)) this.company.assertSameCompany(i.companyId, { workflowId: i.refId })
      const base = existing?.data ?? AGENT_DATA_DEFAULTS
      const aid = existing ? existing.id : uid('agt')
      // VOICE.md §4: every new seat gets a persona, unique among the company's active agents (legacy ones included,
      // with the name they are shown with). On update the persona is taken as given, so a rename persists.
      const persona = existing ? undefined : this.newPersona(i.companyId, aid, i.departmentId, i.data?.persona)
      if (existing && !existing.archivedAt && i.data?.persona) this.assertPersonaFree(existing.id, i.companyId, i.data.persona.name)
      const merged = companyAgentDataSchema.safeParse({ ...base, ...i.data, ...(persona ? { persona } : {}), limits: { ...base.limits, ...i.data?.limits } })
      if (!merged.success) fail(merged.error.issues[0]?.message ?? 'Invalid agent')
      const data = merged.data!
      if (data.defaultRepoId && data.defaultRepoId !== existing?.data.defaultRepoId) {
        if (!this.store.getRepo(data.defaultRepoId)) notFound('Repository no longer exists')
        this.company.assertSameCompany(i.companyId, { repoId: data.defaultRepoId })
      }
      const now = new Date().toISOString()
      if (existing) {
        if (existing.kind !== i.kind || existing.refId !== i.refId || existing.departmentId !== i.departmentId) {
          const busy = this.inFlightTasks(existing.id)
          if (busy.length) blocked(`${existing.name} is working on ${listRefs(busy)}. Stop or finish it before changing its department or what backs it.`)
        }
        this.db.prepare('UPDATE company_agents SET department_id=?, kind=?, ref_id=?, name=?, data=?, updated_at=? WHERE id=?')
          .run(i.departmentId, i.kind, i.refId, i.name, JSON.stringify(data), now, existing.id)
        return existing.id
      }
      this.db.prepare('INSERT INTO company_agents(id,company_id,department_id,kind,ref_id,name,archived_at,paused_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?)')
        .run(aid, i.companyId, i.departmentId, i.kind, i.refId, i.name, now, now, JSON.stringify(data))
      return aid
    })()
    return this.agent(id)
  }
  /**
   * The persona for a seat being created: the given one when its name is free, else pickPersona with the department's
   * preset pool and seed `companyId:agentId`. Names are compared case-insensitively against the company's non-archived
   * agents, stored or resolved for display.
   */
  private newPersona(companyId: string, agentId: string, departmentId: string | null, given: AgentPersona | undefined): AgentPersona {
    const departments = this.list(companyId, { includeArchived: true })
    const used = usedPersonaNames(companyId, this.listAgents({ companyId }), departments)
    if (given && !used.has(given.name.trim().toLowerCase())) return given
    const dept = departmentId ? departments.find(d => d.id === departmentId) : undefined
    const avoid = personaNamesElsewhere(companyId, this.listAgents(), this.list(undefined, { includeArchived: true }))
    return pickPersona({ departmentKey: dept ? presetKeyOf(dept) : null, used, avoid, seed: `${companyId}:${agentId}` })
  }
  /**
   * A rename (update with a persona) must not take a name another active agent of the company is shown with, stored
   * or resolved for display. Its own current name is free to keep, so re-saving an unchanged persona always passes.
   */
  private assertPersonaFree(agentId: string, companyId: string, name: string): void {
    const departments = this.list(companyId, { includeArchived: true })
    const used = usedPersonaNames(companyId, this.listAgents({ companyId }), departments, agentId)
    const clean = name.trim()
    if (used.has(clean.toLowerCase())) fail(`Another agent is already called ${clean}. Choose a different name.`)
  }
  /**
   * Deleting a profile or workflow that backs an active seat would leave the seat dangling: refused, naming the seats.
   * Archived seats never run, so they do not block. A db without company_agents (older test dbs) has no seats.
   */
  assertNotBacking(kind: CompanyAgent['kind'], refId: string): void {
    let seats: { name: string }[] = []
    try { seats = this.db.prepare('SELECT name FROM company_agents WHERE kind=? AND ref_id=? AND archived_at IS NULL ORDER BY created_at, rowid').all(kind, refId) as { name: string }[] } catch { return }
    if (!seats.length) return
    const names = seats.slice(0, 5).map(a => a.name).join(', ') + (seats.length > 5 ? ` and ${seats.length - 5} more` : '')
    blocked(`This ${kind} backs ${seats.length === 1 ? 'the agent' : 'the agents'} ${names}. Archive ${seats.length === 1 ? 'it' : 'them'} or point ${seats.length === 1 ? 'it' : 'them'} at another ${kind} first.`)
  }
  /** Profiles stay global (any company may seat one); workflows are company-scoped. */
  private checkRef(companyId: string, kind: CompanyAgent['kind'], refId: string): void {
    if (kind === 'profile') {
      const p = this.store.getProfile(refId) ?? notFound('Agent profile not found')
      if (p.adapter === 'shell') fail('Shell profiles cannot be agents. Choose Claude, Codex, Cursor or Gemini.')
      return
    }
    if (!this.store.getWorkflow(refId)) notFound('Workflow not found')
    // always enforced: departments only run with experimental.companies on
    this.company.assertSameCompany(companyId, { workflowId: refId })
  }
  /**
   * A task's department and agent, as set by a human (tasks:create/update, tasks:assign): both must exist and belong to
   * the task's company, an archived one cannot be newly set, and an agent of one department cannot take a task filed in
   * another (company-level agents can take any). `prev` is the task's current pair; keeping an archived one is allowed.
   */
  assertTaskRefs(companyId: string, refs: { departmentId?: string | null; agentId?: string | null }, prev: { departmentId?: string | null; agentId?: string | null } = {}): void {
    const dep = refs.departmentId ? this.department(refs.departmentId) : null
    if (dep && dep.companyId !== companyId) fail(`${dep.name} belongs to another company; a task stays in its own company`)
    if (dep?.archivedAt && dep.id !== prev.departmentId) fail(`${dep.name} is archived`)
    const agent = refs.agentId ? this.agent(refs.agentId) : null
    if (!agent) return
    if (agent.companyId !== companyId) fail(`${agent.name} belongs to another company; a task stays in its own company`)
    if (agent.archivedAt && agent.id !== prev.agentId) fail(`${agent.name} is archived`)
    if (dep && agent.departmentId && agent.departmentId !== dep.id) fail(`${agent.name} works in another department. Choose an agent of ${dep.name} or a company-level agent.`)
  }
  /**
   * tasks:create with departments on: valid department and agent (assertTaskRefs), and a task with either never starts
   * as done (§1.4: done only through tasks:approve with a done note).
   */
  assertTaskCreate(t: CompanyTaskInput): void {
    this.assertTaskRefs(t.companyId, t)
    if ((t.departmentId || t.agentId) && t.status === 'done') fail('Create the task in To do; you approve it as done once it is reviewed.')
  }
  /** tasks:update with departments on: the resulting pair is valid, and a board or in-review task reaches done only through tasks:approve. */
  assertTaskPatch(old: CompanyTask, patch: Partial<CompanyTaskInput>): void {
    const next = { departmentId: patch.departmentId !== undefined ? patch.departmentId : old.departmentId ?? null, agentId: patch.agentId !== undefined ? patch.agentId : old.agentId ?? null }
    this.assertTaskRefs(old.companyId, next, old)
    if (patch.status === 'done' && old.status !== 'done' && (old.departmentId || old.agentId || next.departmentId || next.agentId || old.status === 'in_review')) fail('Approve the task as done with a done note.')
  }
  /** Archive replaces delete; refused while the agent has a task in flight. `archived=false` restores it. */
  archiveAgent(id: string, archived = true): CompanyAgent {
    this.db.transaction(() => {
      const a = this.agent(id)
      const now = new Date().toISOString()
      if (!archived) {
        if (a.departmentId && this.department(a.departmentId).archivedAt) fail('Unarchive its department first')
        if (this.company.passport(a.companyId).archivedAt) fail('Unarchive the company first')
        this.db.prepare('UPDATE company_agents SET archived_at=NULL, updated_at=? WHERE id=?').run(now, id)
        return
      }
      if (a.archivedAt) return
      const busy = this.inFlightTasks(id)
      if (busy.length) blocked(`${a.name} is working on ${listRefs(busy)}. Stop or finish it before archiving.`)
      this.db.prepare('UPDATE company_agents SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id)
    })()
    return this.agent(id)
  }
  /** Paused agents take no new tasks (§3.2). A run already in flight finishes; Stop is a task action. */
  pauseAgent(id: string): CompanyAgent { return this.setPaused(id, true) }
  resumeAgent(id: string): CompanyAgent { return this.setPaused(id, false) }
  private setPaused(id: string, paused: boolean): CompanyAgent {
    const a = this.agent(id)
    if (paused && a.archivedAt) fail('This agent is archived')
    const now = new Date().toISOString()
    this.db.prepare('UPDATE company_agents SET paused_at=?, updated_at=? WHERE id=?').run(paused ? a.pausedAt ?? now : null, now, id)
    return this.agent(id)
  }
}
