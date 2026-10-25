/**
 * PLANS.md §2: the Plans store. A plan row (company_plans) holds the goal, the autonomy level, the head agent and the
 * draft's milestones and tasks as JSON. A draft never touches the Board; approve writes real BoardTasks: one
 * milestone task per milestone (the parent) and its tasks under it (source 'agent', dependencyIds = blockers, a filled
 * brief, the plan link), all in Backlog so the board's dispatcher never picks them: the pilot (planPilot.ts) starts
 * them at the pace the founder picked.
 *
 * The draft JSON the head agent writes is validated here (zod, ids and references checked, cycles refused).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { agentActive, type BoardTask, type CompanyAgent } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { EMPTY_BRIEF, PLAN_AUTONOMY, PLAN_LIMITS, type Milestone, type Plan, type PlanAutonomy, type PlanCreateInput, type PlanDraftEdit, type PlanTask, type TaskBrief } from '../../shared/plans'
import type { CompanyStore } from './index'

const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const notFound = (): never => { throw new HiveError('not_found', 'Plan not found') }
const uid = (p: string) => `${p}_${randomBytes(8).toString('hex')}`
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

export const DDL_PLANS = /* sql */ `
CREATE TABLE IF NOT EXISTS company_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS company_plans_company ON company_plans(company_id, status);
`

// ---------- the draft the head agent writes ----------

const str = (n: number) => z.string().trim().max(n)
/** What the model answers (keys, not ids). */
export const draftJsonSchema = z.object({
  summary: str(2000).default(''),
  milestones: z.array(z.object({
    key: str(8).optional(),
    title: str(PLAN_LIMITS.title).min(1),
    dependsOn: z.array(str(8)).max(PLAN_LIMITS.milestones).default([]),
    passCriteria: z.array(str(400).min(1)).max(PLAN_LIMITS.passCriteria).default([]),
    agent: str(80).nullable().optional(),
    tasks: z.array(z.object({
      key: str(12).optional(),
      title: str(PLAN_LIMITS.title).min(1),
      goal: str(1000).default(''),
      context: str(4000).default(''),
      criteria: z.array(str(400).min(1)).max(PLAN_LIMITS.criteria).default([]),
      blockers: z.array(str(12)).max(PLAN_LIMITS.tasksPerMilestone * 2).default([]),
      touches: z.array(str(PLAN_LIMITS.touch).min(1)).max(PLAN_LIMITS.touches).default([])
    })).min(1).max(PLAN_LIMITS.tasksPerMilestone)
  })).min(1).max(PLAN_LIMITS.milestones)
})
export type DraftJson = z.infer<typeof draftJsonSchema>

/** The first JSON object in a model answer (fenced or not). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  if (start < 0 || end <= start) fail('The head agent did not answer with a JSON plan')
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return fail('The head agent answered with JSON that does not parse') }
}

/**
 * The model's draft as milestones and tasks with ids. Milestone keys become M1…; task keys may be global (T3) or
 * the task's title; blockers name earlier keys of the same plan. Unknown references are dropped, cycles refused.
 */
export function draftFromJson(raw: unknown, agents: CompanyAgent[], headAgentId: string | null): { body: string; milestones: Milestone[]; tasks: PlanTask[] } {
  const r = draftJsonSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    fail(`The draft is not a valid plan: ${i.path.join('.') || '(root)'}: ${i.message}`)
  }
  const d = r.data!
  const milestones: Milestone[] = []
  const tasks: PlanTask[] = []
  const mByKey = new Map<string, string>()
  const tByKey = new Map<string, string>()
  const local = new Map<string, string>()
  d.milestones.forEach((m, i) => {
    const key = `M${i + 1}`
    const id = uid('pm')
    mByKey.set(key, id)
    if (m.key) mByKey.set(m.key.toUpperCase(), id)
    const want = m.agent?.toLowerCase().trim()
    const agent = want ? agents.find(a => agentActive(a) && (a.name.toLowerCase() === want || a.data.persona?.name?.toLowerCase() === want || a.id === m.agent)) : undefined
    milestones.push({ id, key, title: clip(m.title, PLAN_LIMITS.title), dependsOn: [], passCriteria: m.passCriteria, agentId: agent?.id ?? headAgentId, taskId: null, gate: { result: null, notes: '', at: null, evidence: [], fails: 0 }, passedAt: null, worktree: null, sessionId: null })
    m.tasks.forEach((t, j) => {
      const tid = uid('pt')
      // keys may restart per milestone (T1 in M1 and in M2): blockers resolve inside their milestone first
      for (const k of [(t.key ?? `${key}.${j + 1}`).toUpperCase(), t.title.toUpperCase()]) {
        local.set(`${id}|${k}`, tid)
        if (!tByKey.has(k)) tByKey.set(k, tid)
      }
      tasks.push({ id: tid, milestoneId: id, title: clip(t.title, PLAN_LIMITS.title), briefSeed: { goal: t.goal, context: t.context, criteria: t.criteria }, blockers: [], touches: t.touches, taskId: null })
    })
  })
  d.milestones.forEach((m, i) => {
    milestones[i].dependsOn = [...new Set(m.dependsOn.map(k => mByKey.get(k.toUpperCase())).filter((x): x is string => !!x && x !== milestones[i].id))]
  })
  let n = 0
  d.milestones.forEach(m => m.tasks.forEach(t => {
    const pt = tasks[n++]
    pt.blockers = [...new Set(t.blockers.map(k => local.get(`${pt.milestoneId}|${k.toUpperCase()}`) ?? tByKey.get(k.toUpperCase())).filter((x): x is string => !!x && x !== pt.id))]
  }))
  if (tasks.length > PLAN_LIMITS.tasks) fail(`A plan has at most ${PLAN_LIMITS.tasks} tasks`)
  assertAcyclic(milestones, tasks)
  return { body: d.summary, milestones, tasks }
}
/** Milestone dependsOn and task blockers must both be acyclic, and blockers must point inside the plan. */
export function assertAcyclic(milestones: Milestone[], tasks: PlanTask[]): void {
  const cyclic = (nodes: string[], edges: (id: string) => string[]): boolean => {
    const state = new Map<string, 1 | 2>()
    const visit = (id: string): boolean => {
      if (state.get(id) === 2) return false
      if (state.get(id) === 1) return true
      state.set(id, 1)
      for (const e of edges(id)) if (visit(e)) return true
      state.set(id, 2)
      return false
    }
    return nodes.some(visit)
  }
  const mIds = new Set(milestones.map(m => m.id)), tIds = new Set(tasks.map(t => t.id))
  for (const m of milestones) for (const d of m.dependsOn) if (!mIds.has(d)) fail(`${m.key} depends on a milestone that is not in this plan`)
  for (const t of tasks) {
    if (!mIds.has(t.milestoneId)) fail(`"${clip(t.title, 60)}" belongs to no milestone`)
    for (const b of t.blockers) if (!tIds.has(b)) fail(`"${clip(t.title, 60)}" waits for a task that is not in this plan`)
  }
  if (cyclic(milestones.map(m => m.id), id => milestones.find(m => m.id === id)?.dependsOn ?? [])) fail('Milestones cannot depend on each other in a circle')
  if (cyclic(tasks.map(t => t.id), id => tasks.find(t => t.id === id)?.blockers ?? [])) fail('Tasks cannot block each other in a circle')
}

// ---------- the founder's draft edit ----------

const milestoneEditSchema = z.object({
  id: z.string().min(1).max(64), key: z.string().min(1).max(8), title: str(PLAN_LIMITS.title).min(1),
  dependsOn: z.array(z.string().max(64)).max(PLAN_LIMITS.milestones), passCriteria: z.array(str(400).min(1)).max(PLAN_LIMITS.passCriteria),
  agentId: z.string().max(64).nullable()
}).passthrough()
const taskEditSchema = z.object({
  id: z.string().min(1).max(64), milestoneId: z.string().min(1).max(64), title: str(PLAN_LIMITS.title).min(1),
  briefSeed: z.object({ goal: str(1000), context: str(4000), criteria: z.array(str(400).min(1)).max(PLAN_LIMITS.criteria) }).strict(),
  blockers: z.array(z.string().max(64)).max(PLAN_LIMITS.tasksPerMilestone * 2), touches: z.array(str(PLAN_LIMITS.touch).min(1)).max(PLAN_LIMITS.touches)
}).passthrough()

// ---------- the store ----------

export interface PlanStoreDeps { company: () => CompanyStore; redact?: (s: string) => string; now?: () => Date }
interface Row { id: string; company_id: string; status: string; data: string }

export class PlanStore {
  constructor(private readonly d: PlanStoreDeps) {
    this.db.exec(DDL_PLANS)
  }
  private get c(): CompanyStore { return this.d.company() }
  private get db() { return this.d.company().store.db }
  private now(): string { return (this.d.now ? this.d.now() : new Date()).toISOString() }
  private redact(s: string): string { return this.d.redact ? this.d.redact(s) : s }

  list(companyId?: string): Plan[] {
    const rows = (companyId ? this.db.prepare('SELECT * FROM company_plans WHERE company_id=? ORDER BY created_at DESC').all(companyId) : this.db.prepare('SELECT * FROM company_plans ORDER BY created_at DESC').all()) as Row[]
    return rows.map(read)
  }
  get(id: string): Plan {
    const r = this.db.prepare('SELECT * FROM company_plans WHERE id=?').get(id) as Row | undefined
    return r ? read(r) : notFound()
  }
  /** Writes the whole row (the JSON is the source of truth; status is a query mirror). */
  save(p: Plan): Plan {
    const next = { ...p, updatedAt: this.now() }
    this.db.prepare('INSERT INTO company_plans(id,company_id,status,created_at,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data')
      .run(next.id, next.companyId, next.status, next.createdAt, next.updatedAt, JSON.stringify(next))
    return next
  }
  /** One read-modify-write in a transaction. */
  update(id: string, fn: (p: Plan) => Plan): Plan {
    return this.db.transaction(() => this.save(fn(this.get(id))))()
  }
  remove(id: string): void {
    const p = this.get(id)
    if (p.status !== 'draft') fail('Only a draft can be discarded; an approved plan keeps its tasks on the Board')
    this.db.prepare('DELETE FROM company_plans WHERE id=?').run(id)
  }

  /** The head agent: the named one, else the department head (Development first), else the company's first agent. */
  defaultHead(companyId: string): CompanyAgent | null {
    const agents = this.c.departments.listAgents({ companyId }).filter(a => agentActive(a) && a.kind === 'profile')
    if (!agents.length) return null
    const deps = this.c.departments.list(companyId)
    const order = [...deps.filter(d => d.key === 'development'), ...deps.filter(d => d.key !== 'development')]
    for (const d of order) { const a = agents.find(x => x.departmentId === d.id); if (a) return a }
    return agents[0]
  }
  /** A new draft row (drafting), nothing on the Board. */
  create(input: PlanCreateInput): Plan {
    const company = this.c.passport(input.companyId)
    if (company.archivedAt) fail(`Unarchive ${company.name} before planning work for it`)
    const goal = this.redact(input.goal.trim())
    if (!goal) fail('Write the goal first')
    if (!PLAN_AUTONOMY.includes(input.autonomy)) fail('Pick Step by Step, Check-ins or Autopilot')
    if (input.repoId && !company.repoIds.includes(input.repoId)) fail(`That repository does not belong to ${company.name}`)
    let head: CompanyAgent | null = null
    if (input.headAgentId) {
      head = this.c.departments.getAgent(input.headAgentId)
      if (!head || head.companyId !== company.id || !agentActive(head)) fail('Pick an active agent of this company as the head agent')
    } else head = this.defaultHead(company.id)
    if (!head) fail(`${company.name} has no agents yet. Hire one in a department, then plan.`)
    const now = this.now()
    const p: Plan = {
      id: uid('plan'), companyId: company.id, repoId: input.repoId ?? (company.repoIds.length === 1 ? company.repoIds[0] : null), goal: clip(goal, PLAN_LIMITS.goal), autonomy: input.autonomy, status: 'draft',
      headAgentId: head!.id, body: '', milestones: [], tasks: [], drafting: true, draftError: null, halted: null, changes: [], createdAt: now, updatedAt: now, approvedAt: null
    }
    return this.save(p)
  }
  /** The founder's edit of a draft (or its settings). Lists are replaced whole and re-checked. */
  saveDraft(e: PlanDraftEdit): Plan {
    return this.update(e.id, p => {
      if (p.status !== 'draft') fail('Only a draft can be edited. After approval only fix tasks are added.')
      if (p.drafting && (e.milestones || e.tasks)) fail('The head agent is still drafting')
      const next: Plan = { ...p }
      if (e.goal !== undefined) { const g = this.redact(e.goal.trim()); if (!g) fail('Write the goal first'); next.goal = clip(g, PLAN_LIMITS.goal) }
      if (e.body !== undefined) next.body = clip(this.redact(e.body), 2000)
      if (e.autonomy) next.autonomy = e.autonomy
      if (e.repoId !== undefined) {
        if (e.repoId && !this.c.passport(p.companyId).repoIds.includes(e.repoId)) fail('That repository does not belong to this company')
        next.repoId = e.repoId
      }
      if (e.headAgentId !== undefined) {
        const a = e.headAgentId ? this.c.departments.getAgent(e.headAgentId) : null
        if (!a || a.companyId !== p.companyId) fail('Pick an agent of this company as the head agent')
        next.headAgentId = a!.id
      }
      if (e.milestones) {
        next.milestones = e.milestones.map(m => {
          const v = milestoneEditSchema.parse(m)
          const old = p.milestones.find(x => x.id === v.id)
          if (v.agentId) { const a = this.c.departments.getAgent(v.agentId); if (!a || a.companyId !== p.companyId) fail(`${v.key}: pick an agent of this company`) }
          return { ...(old ?? { taskId: null, gate: { result: null, notes: '', at: null, evidence: [], fails: 0 }, passedAt: null, worktree: null, sessionId: null }), id: v.id, key: v.key, title: this.redact(v.title), dependsOn: v.dependsOn, passCriteria: v.passCriteria.map(s => this.redact(s)), agentId: v.agentId } as Milestone
        })
      }
      if (e.tasks) {
        next.tasks = e.tasks.map(t => {
          const v = taskEditSchema.parse(t)
          return { id: v.id, milestoneId: v.milestoneId, title: this.redact(v.title), briefSeed: { goal: this.redact(v.briefSeed.goal), context: this.redact(v.briefSeed.context), criteria: v.briefSeed.criteria.map(s => this.redact(s)) }, blockers: v.blockers, touches: v.touches, taskId: null }
        })
      }
      if (next.tasks.length > PLAN_LIMITS.tasks) fail(`A plan has at most ${PLAN_LIMITS.tasks} tasks`)
      assertAcyclic(next.milestones, next.tasks)
      return next
    })
  }

  // ---------- approve: the draft goes on the Board ----------

  /**
   * Creates the milestone tasks and their tasks with briefs, parents and blockers (one transaction). Tasks start in
   * Backlog with their milestone agent, so nothing starts until the pilot (or the founder, Step by Step) starts it.
   */
  approve(id: string): Plan {
    return this.db.transaction(() => {
      const p = this.get(id)
      if (p.status !== 'draft') fail('This plan is already approved')
      if (p.drafting) fail('The head agent is still drafting')
      if (!p.milestones.length || !p.tasks.length) fail('The draft has no milestones or tasks yet')
      assertAcyclic(p.milestones, p.tasks)
      const company = this.c.passport(p.companyId)
      if (p.repoId && !company.repoIds.includes(p.repoId)) fail(`The plan's repository no longer belongs to ${company.name}`)
      const at = this.now()
      const milestones = p.milestones.map(m => ({ ...m }))
      const tasks = p.tasks.map(t => ({ ...t }))
      const seat = (agentId: string | null): CompanyAgent | null => {
        const a = agentId ? this.c.departments.getAgent(agentId) : null
        return a && a.companyId === p.companyId && !a.archivedAt ? a : null
      }
      for (const m of topoMilestones(milestones)) {
        const agent = seat(m.agentId ?? p.headAgentId)
        if (!agent) fail(`${m.key} has no agent: pick one in the draft`)
        const brief: TaskBrief = { ...EMPTY_BRIEF, goal: m.title, context: `${m.key} of the plan "${clip(p.goal, 300)}". Its gate checks every task of this milestone against the pass criteria.`, criteria: m.passCriteria.map((text, i) => ({ id: `c${i + 1}`, text, state: 'open' as const })), revisions: [{ at, by: 'system', section: 'goal' }] }
        const mt = this.c.createTask({
          companyId: p.companyId, title: clip(`${m.key} · ${m.title}`, 240), description: m.passCriteria.map(c => `- ${c}`).join('\n'), repoId: p.repoId, status: 'backlog', priority: 0,
          source: 'agent', sourceUrl: null, externalId: `plan:${p.id}:${m.id}`, assigneeProfileId: agent!.kind === 'profile' ? agent!.refId : null, parentId: null, dependencyIds: [],
          departmentId: agent!.departmentId, agentId: agent!.id, routing: { departmentId: agent!.departmentId, agentId: agent!.id, by: 'human', reason: `Plan milestone: ${clip(p.goal, 200)}` },
          brief, plan: { planId: p.id, milestoneId: m.id, planTaskId: null, role: 'milestone' }
        })
        m.taskId = mt.id
        m.agentId = agent!.id
        for (const t of topoTasks(tasks.filter(x => x.milestoneId === m.id), tasks)) this.createPlanTask(p, m, t, tasks, agent!, at)
      }
      const out = this.save({ ...p, milestones, tasks, status: 'approved', approvedAt: at, changes: [...p.changes, { at, by: 'human', text: `Approved: ${milestones.length} milestones, ${tasks.length} tasks on the Board` }] })
      for (const m of milestones) if (m.taskId) this.c.activity(m.taskId, 'created', `From the plan "${clip(p.goal, 200)}"`, 'human')
      return out
    })()
  }
  /** One plan task on the Board (approval, or a fix task added by a failing gate). */
  createPlanTask(p: Plan, m: Milestone, t: PlanTask, all: PlanTask[], agent: CompanyAgent, at: string): BoardTask {
    const deps = t.blockers.map(b => all.find(x => x.id === b)?.taskId).filter((x): x is string => !!x)
    const brief: TaskBrief = {
      ...EMPTY_BRIEF, goal: t.briefSeed.goal || t.title,
      context: [t.briefSeed.context, t.touches.length ? `Files this task changes: ${t.touches.join(', ')}` : ''].filter(Boolean).join('\n\n'),
      criteria: t.briefSeed.criteria.map((text, i) => ({ id: `c${i + 1}`, text, state: 'open' as const })),
      revisions: [{ at, by: 'system', section: 'goal' }]
    }
    const row = this.c.createTask({
      companyId: p.companyId, title: t.title, description: [t.briefSeed.goal, t.briefSeed.context].filter(Boolean).join('\n\n'), repoId: p.repoId, status: 'backlog', priority: 0,
      source: 'agent', sourceUrl: null, externalId: `plan:${p.id}:${t.id}`, assigneeProfileId: agent.kind === 'profile' ? agent.refId : null, parentId: m.taskId, dependencyIds: deps,
      departmentId: agent.departmentId, agentId: agent.id, routing: { departmentId: agent.departmentId, agentId: agent.id, by: 'human', reason: `Plan ${m.key}: ${clip(p.goal, 200)}` },
      brief, plan: { planId: p.id, milestoneId: m.id, planTaskId: t.id, role: 'task' }
    })
    t.taskId = row.id
    return row
  }
}

function read(r: Row): Plan {
  const p = JSON.parse(r.data) as Plan
  return { ...p, milestones: p.milestones ?? [], tasks: p.tasks ?? [], changes: p.changes ?? [], halted: p.halted ?? null, drafting: !!p.drafting, draftError: p.draftError ?? null }
}
export function topoMilestones(ms: Milestone[]): Milestone[] {
  const out: Milestone[] = []; const seen = new Set<string>()
  const visit = (m: Milestone) => { if (seen.has(m.id)) return; seen.add(m.id); for (const d of m.dependsOn) { const x = ms.find(y => y.id === d); if (x) visit(x) } out.push(m) }
  ms.forEach(visit)
  return out
}
function topoTasks(ts: PlanTask[], all: PlanTask[]): PlanTask[] {
  const out: PlanTask[] = []; const seen = new Set<string>()
  const visit = (t: PlanTask) => { if (seen.has(t.id)) return; seen.add(t.id); for (const b of t.blockers) { const x = ts.find(y => y.id === b); if (x) visit(x) } out.push(t) }
  ts.forEach(visit)
  void all
  return out
}
export const isAutonomy = (v: unknown): v is PlanAutonomy => (PLAN_AUTONOMY as readonly unknown[]).includes(v)
