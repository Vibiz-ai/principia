import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_MAX_IN_FLIGHT, PERSONAL_COMPANY_ID, PROFILE_FIELDS, withTaskDefaults, type ActivityBy, type BoardSettings, type BoardTask, type CompanyAgent, type CompanyCreateInput, type CompanyOverview, type CompanyPassport, type CompanyPassportInput, type CompanyTask, type CompanyTaskInput, type CompanyUpdateInput, type PassportExport, type PendingWake, type TaskActivity, type TaskActivityKind, type TaskBoardFields, type TaskDetail, type TaskRouting } from '../../shared/company'
import type { Run, RunTarget } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { companySlug, defaultCompanyColor, ensureCompanyRows } from '../db/companyMigration'
import type { Store } from '../db/store'
import { log } from '../log'
import { DepartmentStore } from './departments'
import { assignRepoSchema, companyCreateSchema, companyReorderSchema, companyUpdateSchema, passportExportSchema, passportInputSchema, taskInputSchema, taskPatchSchema } from './schemas'
import { buildResumePrompt, buildTaskPrompt } from './taskPrompt'
import { assertEditable, assertReassignable, assertTransition, runEndState } from './taskState'
import { suggestionApplies } from './router'
import { CompanyScope, type CompanyRef, type PassportContextOptions, type PassportRenderer, type ResolveQuery, type Resolved, type SameCompanyRefs } from './scope'
export { buildPassportContext, CompanyScope } from './scope'
export type { CompanyRef, Located, PassportContextOptions, PassportRenderer, ResolveQuery, Resolved, SameCompanyRefs } from './scope'
export { assertTransition, transitionError, TRANSITIONS, type Actor, type TaskState, type TransitionCtx } from './taskState'
/** What startTask hands the engine besides the target (§4.3): the run's task and seat, its cwd and a Claude resume id. */
export interface TaskRunLink {
  taskId: string
  agentId: string | null
  /** the task's repo, else the agent's default repo, else the company workspace (null without company folders) */
  cwd: string | null
  /** set on a resumed Claude turn: the prompt then holds only the wake and the rules footer */
  resumeSessionId: string | null
}
/** patchInFlight: the fields main writes while a run holds the task. */
const inFlightPatchSchema = taskPatchSchema.pick({ report: true, ask: true, agentSessionId: true, pendingWake: true, autoWakes: true, handoffs: true })
const uid = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`
const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const OPEN_TASK = (t: CompanyTask) => !['done','canceled'].includes(t.status)
const LIVE_AGENT = "('starting','working','needs_you','idle')"
/** Memory counts for company:overview, plugged in by the memory service (the passport index). */
export type MemoryCounter = (companyId: string) => Pick<CompanyOverview, 'noteCount' | 'ghostCount' | 'pendingSuggestions'> | null
/** `<userData>/companies`, next to hive.db (null for an in-memory db). */
function defaultCompaniesRoot(store: Store): string | null {
  return store.db.memory || !store.db.name ? null : path.join(path.dirname(path.resolve(store.db.name)), 'companies')
}
export class CompanyStore {
  /** COMPANY.md §5: every company-resolution question goes through here. */
  readonly scope: CompanyScope
  private memoryCounter: MemoryCounter | null = null
  /** departments and agent seats of the board (stateless over the same db) */
  readonly departments: DepartmentStore
  private redact: (text: string) => string = s=>s
  /** experimental.departments (§0.8); off, plain tasks keep today's statuses (no dependency lock, no auto heal) */
  private boardOn: () => boolean = ()=>true
  /** why main canceled a task's run (time or wake cap); consumed at its run end */
  private readonly stopReasons = new Map<string, 'limit'|'interrupted'|'handoff_cap'>()
  /** runs.task_id / agent_id exist (healed by openDatabase) */
  private readonly runLinks: boolean
  constructor(readonly store: Store, opts: { companiesRoot?: string | null } = {}) {
    this.scope = new CompanyScope(store, opts.companiesRoot !== undefined ? opts.companiesRoot : defaultCompaniesRoot(store))
    store.db.exec(`CREATE TABLE IF NOT EXISTS company_passports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS company_repos (repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, company_id TEXT NOT NULL REFERENCES company_passports(id));
      CREATE TABLE IF NOT EXISTS company_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, company_id TEXT NOT NULL REFERENCES company_passports(id), source_key TEXT, run_id TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS company_tasks_source ON company_tasks(company_id,source_key) WHERE source_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS company_tasks_run ON company_tasks(run_id);
      CREATE TABLE IF NOT EXISTS company_task_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES company_tasks(id), kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);`)
    // DEPARTMENTS.md §1.2 mirrors and the activity actor; openDatabase heals them, kept for a store over a bare db
    const cols=(t:string)=>new Set((store.db.prepare(`PRAGMA table_info(${t})`).all() as {name:string}[]).map(c=>c.name))
    const taskCols=cols('company_tasks')
    for (const col of ['status','department_id','agent_id']) if (!taskCols.has(col)) store.db.exec(`ALTER TABLE company_tasks ADD COLUMN ${col} TEXT`)
    if (!cols('company_task_activity').has('actor')) store.db.exec('ALTER TABLE company_task_activity ADD COLUMN actor TEXT')
    const runCols=cols('runs')
    this.runLinks=runCols.has('task_id')&&runCols.has('agent_id')
    this.departments=new DepartmentStore(store,this)
    // openDatabase already did this; kept so a store over a db without the Personal row still lists it
    if (!this.store.db.prepare('SELECT 1 FROM company_passports WHERE id=?').get(PERSONAL_COMPANY_ID)) ensureCompanyRows(store.db)
  }
  /** Rail / sidebar order, Personal last. Archived companies only with includeArchived (Settings → Companies). */
  listPassports(opts: { includeArchived?: boolean } = {}): CompanyPassport[] { return this.scope.list(opts) }
  /** Any company, archived included. */
  passport(id: string): CompanyPassport { return this.scope.get(id) ?? fail('Company not found') }
  /**
   * Full profile save. Personal keeps its implicit repos (every unowned repo; no company_repos rows are written for
   * it, §2.2), so its input repoIds are ignored. Slug and system are fixed at creation.
   */
  savePassport(input: CompanyPassportInput, id?: string): CompanyPassport {
    input = passportInputSchema.parse(input)
    const created = this.store.db.transaction(()=> {
      const existing = id ? this.passport(id) : null
      const personal = existing?.system === 'personal'
      if (personal) input = {...input, repoIds: []}
      for (const repoId of input.repoIds) {
        if (!this.store.getRepo(repoId)) fail('Repository no longer exists')
        const owner = this.store.db.prepare('SELECT company_id FROM company_repos WHERE repo_id=?').get(repoId) as {company_id:string}|undefined
        if (owner && owner.company_id !== id) fail('This repository already belongs to another company. Remove it from that Passport first.')
      }
      // Personal's repos are implicit, so saving its profile never removes or adds one
      if (existing && !personal) {
        const removed = existing.repoIds.filter(r=>!input.repoIds.includes(r))
        if (this.listTasks(existing.id).some(t=>t.repoId && removed.includes(t.repoId) && OPEN_TASK(t))) fail('Move or finish open tasks before removing their repository from this company.')
      }
      if (!personal) {
        // an added repo (unowned, so Personal's) must not strand open tasks of its current company
        const added = input.repoIds.filter(r=>!existing?.repoIds.includes(r))
        if (this.listTasks().some(t=>t.repoId && added.includes(t.repoId) && t.companyId !== existing?.id && OPEN_TASK(t))) fail('Move or finish open tasks on this repository before assigning it to another company.')
      }
      if (input.vaultPath && input.vaultPath !== existing?.vaultPath) this.scope.checkVaultPath(existing?.id ?? '', input.vaultPath)
      const now = new Date().toISOString()
      const pid = existing?.id ?? uid('co')
      const {color, vaultPath, ...profile} = input
      // data keeps the shape older builds' listPassports parses; the §2.1 fields live in their own columns
      // the board switch (§1.1) lives in the same JSON and survives a profile save
      const board = existing ? (({autopilot, maxInFlight})=>({...(autopilot!==undefined?{autopilot}:{}),...(maxInFlight!==undefined?{maxInFlight}:{})}))(this.companyJson(pid)) : {}
      const data = {...board,...profile,repoIds:personal?[]:[...new Set(input.repoIds)],id:pid,createdAt:existing?.createdAt??now,updatedAt:now}
      if (existing) {
        this.store.db.prepare('UPDATE company_passports SET data=?, color=COALESCE(?,color), vault_path=? WHERE id=?')
          .run(JSON.stringify(data), color ?? null, vaultPath === undefined ? existing.vaultPath ?? null : vaultPath, pid)
      } else {
        const taken = new Set((this.store.db.prepare('SELECT slug FROM company_passports WHERE slug IS NOT NULL').all() as {slug:string}[]).map(r=>r.slug))
        const sort = (this.store.db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM company_passports WHERE system IS NOT 'personal'").get() as {n:number}).n
        this.store.db.prepare('INSERT INTO company_passports(id,data,slug,color,sort_order,system,archived_at,vault_path) VALUES(?,?,?,?,?,NULL,NULL,?)')
          .run(pid, JSON.stringify(data), companySlug(input.name, taken), color ?? defaultCompanyColor(pid), sort, vaultPath ?? null)
      }
      if (!personal) {
        this.store.db.prepare('DELETE FROM company_repos WHERE company_id=?').run(pid)
        for (const repoId of data.repoIds) this.store.db.prepare('INSERT INTO company_repos(repo_id,company_id) VALUES(?,?)').run(repoId,pid)
      }
      return {id: pid, isNew: !existing}
    })()
    if (created.isNew) this.tryWorkspace(created.id)
    return this.passport(created.id)
  }
  /** §3: repo-less chats of a new company get `<userData>/companies/<slug>/workspace`. Best effort; sessions re-ensure it. */
  private tryWorkspace(companyId: string): void {
    if (!this.scope.companiesRoot) return
    try { this.scope.ensureWorkspace(companyId) } catch (err) { log.warn('company workspace dir could not be created', { companyId, error: String(err) }) }
  }
  /** The owning company, null for an unowned repo (implicitly Personal; see companyForRepo). */
  passportForRepo(repoId: string): CompanyPassport | null {
    const c = this.scope.companyForRepo(repoId)
    return c.system === 'personal' ? null : c
  }
  /** Legacy cwd-based Passport context, on top of scope (§5); new callers use passportContextFor(companyId). */
  contextForDirectory(directory: string): string | null { return this.scope.passportContextFor(this.scope.companyForCwd(directory).id) }

  // ---------- §5 resolution (delegates to scope.ts) ----------
  companyForCwd(cwd: string): CompanyPassport { return this.scope.companyForCwd(cwd) }
  companyForRepo(repoId: string): CompanyPassport { return this.scope.companyForRepo(repoId) }
  companyOf(ref: CompanyRef): CompanyPassport { return this.scope.companyOf(ref) }
  resolveCompany(q: ResolveQuery): Resolved { return this.scope.resolveCompany(q) }
  crossCompany(companyId: string, refs: SameCompanyRefs): string | null { return this.scope.crossCompany(companyId, refs) }
  assertSameCompany(companyId: string, refs: SameCompanyRefs): void { this.scope.assertSameCompany(companyId, refs) }
  passportContextFor(companyId: string, opts?: PassportContextOptions): string | null { return this.scope.passportContextFor(companyId, opts) }
  setPassportRenderer(fn: PassportRenderer | null): void { this.scope.setPassportRenderer(fn) }
  workspaceDir(companyId: string): string { return this.scope.ensureWorkspace(companyId) }
  vaultPathFor(companyId: string): string { return this.scope.vaultPathFor(companyId) }

  // ---------- §7 company channels ----------
  create(input: CompanyCreateInput): CompanyPassport {
    const i = companyCreateSchema.parse(input)
    const profile = Object.fromEntries(PROFILE_FIELDS.map(k=>[k, i[k] ?? ''])) as Pick<CompanyPassportInput, typeof PROFILE_FIELDS[number]>
    return this.savePassport({...profile, name: i.name, repoIds: i.repoIds ?? [], ...(i.color ? {color: i.color} : {}), ...(i.vaultPath !== undefined ? {vaultPath: i.vaultPath} : {})})
  }
  /** Name, colour, sort order, vault path. The slug (folder name) never changes on rename. */
  update(id: string, patch: CompanyUpdateInput): CompanyPassport {
    const p = companyUpdateSchema.parse(patch)
    this.store.db.transaction(()=> {
      const c = this.passport(id)
      if (p.name !== undefined && p.name !== c.name) {
        const row = this.store.db.prepare('SELECT data FROM company_passports WHERE id=?').get(id) as {data:string}
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(row.data) ?? {} } catch { /* rewritten below */ }
        this.store.db.prepare('UPDATE company_passports SET data=? WHERE id=?').run(JSON.stringify({...data, name: p.name, updatedAt: new Date().toISOString()}), id)
      }
      if (p.color !== undefined) this.store.db.prepare('UPDATE company_passports SET color=? WHERE id=?').run(p.color, id)
      if (p.sortOrder !== undefined) this.store.db.prepare('UPDATE company_passports SET sort_order=? WHERE id=?').run(p.sortOrder, id)
      if (p.vaultPath && p.vaultPath !== c.vaultPath) this.scope.checkVaultPath(id, p.vaultPath)
      if (p.vaultPath !== undefined) this.store.db.prepare('UPDATE company_passports SET vault_path=? WHERE id=?').run(p.vaultPath, id)
    })()
    return this.passport(id)
  }
  /** Archive replaces delete: nothing is removed and `archived=false` restores it. Personal is never archived. */
  archive(id: string, archived = true): CompanyPassport {
    const c = this.passport(id)
    if (c.system === 'personal') fail('Personal / Unassigned cannot be archived')
    this.store.db.prepare('UPDATE company_passports SET archived_at=? WHERE id=?').run(archived ? c.archivedAt ?? new Date().toISOString() : null, id)
    return this.passport(id)
  }
  /** New rail order. Unlisted companies keep their relative order after the listed ones; Personal stays last. */
  reorder(ids: string[]): CompanyPassport[] {
    ids = companyReorderSchema.parse(ids)
    this.store.db.transaction(()=> {
      const all = this.listPassports({includeArchived: true}).filter(c=>c.system !== 'personal')
      const known = new Set(all.map(c=>c.id))
      for (const id of ids) if (!known.has(id) && id !== PERSONAL_COMPANY_ID) throw new HiveError('not_found', 'Company not found')
      const listed = [...new Set(ids)].filter(id=>known.has(id))
      const order = [...listed, ...all.map(c=>c.id).filter(id=>!listed.includes(id))]
      const up = this.store.db.prepare('UPDATE company_passports SET sort_order=? WHERE id=?')
      order.forEach((id, i)=>up.run(i, id))
    })()
    return this.listPassports()
  }
  /**
   * Moves one repo to `companyId` (Personal = unassign). Future runs and sessions only: past runs keep their stamp.
   * Refused while the repo has open tasks or anything live on it (sessions, queued/running runs, live agents).
   */
  assignRepo(repoId: string, companyId: string): CompanyPassport {
    const q = assignRepoSchema.parse({repoId, companyId})
    this.store.db.transaction(()=> {
      if (!this.store.getRepo(q.repoId)) throw new HiveError('not_found', 'Repository no longer exists')
      const to = this.passport(q.companyId)
      if (to.archivedAt) fail(`Unarchive ${to.name} before assigning repositories to it.`)
      const from = this.scope.companyForRepo(q.repoId)
      if (from.id === to.id) return
      if (this.listTasks().some(t=>t.repoId===q.repoId && OPEN_TASK(t))) fail('Move or finish open tasks on this repository before assigning it to another company.')
      const db = this.store.db
      const live = db.prepare(`SELECT
          (SELECT COUNT(*) FROM sessions WHERE repo_id=? AND status='running') +
          (SELECT COUNT(*) FROM runs WHERE status IN ('queued','running') AND json_valid(target_json) AND json_extract(target_json,'$.repoId')=?) +
          (SELECT COUNT(*) FROM agents WHERE repo_id=? AND status IN ${LIVE_AGENT}) AS n`).get(q.repoId, q.repoId, q.repoId) as {n:number}
      if (live.n) fail('Stop the agents running on this repository before assigning it to another company.')
      if (to.system === 'personal') db.prepare('DELETE FROM company_repos WHERE repo_id=?').run(q.repoId)
      else db.prepare('INSERT INTO company_repos(repo_id,company_id) VALUES(?,?) ON CONFLICT(repo_id) DO UPDATE SET company_id=excluded.company_id').run(q.repoId, to.id)
      this.moveRepoOrder(q.repoId, from.id, to.id)
      // a prompt schedule is bound to its repo: it moves with it (otherwise editing it would be a cross-company write).
      // Workflows (several targets), sessions and past runs keep the company they were created in.
      db.prepare(`UPDATE schedules SET company_id=? WHERE json_valid(target_json) AND json_extract(target_json,'$.kind')='prompt' AND json_extract(target_json,'$.repoId')=?`)
        .run(to.id, q.repoId)
    })()
    return this.passport(q.companyId)
  }
  /** §2.3: per-company repo_order:<id>. Only keys that exist are touched (a missing key means the default order). */
  private moveRepoOrder(repoId: string, from: string, to: string): void {
    const get = this.store.db.prepare('SELECT value FROM meta WHERE key=?')
    const set = this.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
    const read = (key: string): string[] | null => {
      const row = get.get(key) as {value:string}|undefined
      try { const v = row ? JSON.parse(row.value) : null; return Array.isArray(v) ? v : null } catch { return null }
    }
    const a = read(`repo_order:${from}`), b = read(`repo_order:${to}`)
    if (a) set.run(JSON.stringify(a.filter(id=>id!==repoId)), `repo_order:${from}`)
    if (b && !b.includes(repoId)) set.run(JSON.stringify([...b, repoId]), `repo_order:${to}`)
  }
  /** Memory counts come from the passport index; until it registers they are 0. */
  setMemoryCounter(fn: MemoryCounter | null): void { this.memoryCounter = fn }
  /** company:overview: one grouped query per domain. NULL and dangling stamps count for Personal. */
  overview(now = new Date()): CompanyOverview[] {
    const P = PERSONAL_COMPANY_ID
    const db = this.store.db
    const companies = this.listPassports()
    const known = new Set(this.listPassports({includeArchived: true}).map(c=>c.id))
    const day = new Date(now.getTime() - 86_400_000).toISOString(), week = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const out = new Map(companies.map(c=>[c.id, {companyId:c.id,repoCount:0,sessionCount:0,working:0,needsYou:0,failed24h:0,failed7d:0,runs7d:0,lastActivityAt:null as string|null,noteCount:0,ghostCount:0,pendingSuggestions:0}]))
    const add = (rows: Record<string, unknown>[], f: (o: CompanyOverview, r: Record<string, unknown>)=>void) => {
      for (const r of rows) { const o = out.get(known.has(r.c as string) ? r.c as string : P); if (o) f(o, r) }
    }
    const later = (a: string|null, b: unknown) => typeof b === 'string' && b && (!a || b > a) ? b : a
    add(db.prepare(`SELECT COALESCE(cp.id,?) AS c, COUNT(*) AS n FROM repos r LEFT JOIN company_repos cr ON cr.repo_id=r.id LEFT JOIN company_passports cp ON cp.id=cr.company_id GROUP BY 1`).all(P) as Record<string, unknown>[],
      (o, r)=>{ o.repoCount += r.n as number })
    add(db.prepare(`SELECT COALESCE(company_id,?) AS c, COUNT(*) AS n, MAX(MAX(started_at,COALESCE(ended_at,''))) AS last FROM sessions GROUP BY 1`).all(P) as Record<string, unknown>[],
      (o, r)=>{ o.sessionCount += r.n as number; o.lastActivityAt = later(o.lastActivityAt, r.last) })
    add(db.prepare(`SELECT COALESCE(company_id,?) AS c, SUM(status IN ('queued','running')) AS working, SUM(status='failed' AND COALESCE(ended_at,created_at)>=?) AS failed,
        SUM(status='failed' AND COALESCE(ended_at,created_at)>=?) AS failedWeek,
        SUM(created_at>=?) AS week, MAX(MAX(created_at,COALESCE(ended_at,''))) AS last FROM runs GROUP BY 1`).all(P, day, week, week) as Record<string, unknown>[],
      (o, r)=>{ o.working += r.working as number; o.failed24h += r.failed as number; o.failed7d += r.failedWeek as number; o.runs7d += r.week as number; o.lastActivityAt = later(o.lastActivityAt, r.last) })
    // working session roots (run steps are counted through their run above)
    add(db.prepare(`SELECT COALESCE(a.company_id,s.company_id,?) AS c, COUNT(*) AS n FROM agents a LEFT JOIN sessions s ON s.id=a.session_id
        WHERE a.parent_id IS NULL AND a.kind='session' AND a.status IN ('starting','working') GROUP BY 1`).all(P) as Record<string, unknown>[],
      (o, r)=>{ o.working += r.n as number })
    // needs you = open asks + unseen idle live session roots (LIVE.md §4.5)
    add(db.prepare(`SELECT COALESCE(k.company_id,a.company_id,r.company_id,s.company_id,?) AS c, COUNT(*) AS n FROM asks k LEFT JOIN agents a ON a.id=k.agent_id
        LEFT JOIN runs r ON r.id=k.run_id LEFT JOIN sessions s ON s.id=k.session_id WHERE k.status='open' GROUP BY 1`).all(P) as Record<string, unknown>[],
      (o, r)=>{ o.needsYou += r.n as number })
    add(db.prepare(`SELECT COALESCE(a.company_id,s.company_id,?) AS c, COUNT(*) AS n FROM agents a LEFT JOIN sessions s ON s.id=a.session_id
        WHERE a.parent_id IS NULL AND a.kind='session' AND a.needs='idle' AND a.seen=0 AND a.status IN ${LIVE_AGENT} GROUP BY 1`).all(P) as Record<string, unknown>[],
      (o, r)=>{ o.needsYou += r.n as number })
    for (const o of out.values()) {
      if (!this.memoryCounter) break
      try { Object.assign(o, this.memoryCounter(o.companyId) ?? {}) } catch (err) { log.warn('company overview memory counts failed', { companyId: o.companyId, error: String(err) }) }
    }
    return [...out.values()]
  }
  exportPassport(id: string): PassportExport {
    const p = this.passport(id)
    // portable only: no machine ids, paths, order or archive state
    const profile = Object.fromEntries(PROFILE_FIELDS.map(k=>[k, p[k]])) as Pick<CompanyPassportInput, typeof PROFILE_FIELDS[number]>
    return {format:'principia-passport',version:1,passport:{name:p.name,...profile,color:p.color}}
  }
  previewImport(json: string): PassportExport {
    if (json.length>300_000) fail('Passport file is too large')
    try { return passportExportSchema.parse(JSON.parse(json)) } catch { return fail('Invalid Passport. Expected a principia-passport version 1 export; review the JSON before importing.') }
  }
  importPassport(json: string, repoIds: string[]): CompanyPassport { return this.savePassport({...this.previewImport(json).passport,repoIds}) }
  listTasks(companyId?: string): BoardTask[] {
    const rows=(companyId ? this.store.db.prepare('SELECT data FROM company_tasks WHERE company_id=? ORDER BY seq DESC').all(companyId) : this.store.db.prepare('SELECT data FROM company_tasks ORDER BY seq DESC').all()) as {data:string}[]
    return rows.map(r=>readTask(r.data))
  }
  task(id: string): BoardTask {
    const r=this.store.db.prepare('SELECT data FROM company_tasks WHERE id=?').get(id) as {data:string}|undefined
    return r ? readTask(r.data) : fail('Task not found')
  }
  detail(id: string): TaskDetail {
    return {task:this.task(id),activity:(this.store.db.prepare("SELECT id,task_id AS taskId,kind,message,created_at AS createdAt,COALESCE(actor,'system') AS by FROM company_task_activity WHERE task_id=? ORDER BY seq").all(id) as TaskActivity[])}
  }
  /** §1.3: a typed entry; `by` is who caused it (default system). Agent and human comments never wake anyone here. */
  activity(taskId: string, kind: TaskActivityKind, message: string, by: ActivityBy = 'system'): TaskActivity {
    this.task(taskId)
    const a:TaskActivity={id:uid('ta'),taskId,kind,message,createdAt:new Date().toISOString(),by}
    this.store.db.prepare('INSERT INTO company_task_activity(id,task_id,kind,message,created_at,actor) VALUES(?,?,?,?,?,?)').run(a.id,a.taskId,a.kind,a.message,a.createdAt,a.by)
    return a
  }
  private sourceKey(input: CompanyTaskInput): string|null {
    if (input.source==='manual') return null
    if (!input.externalId&&!input.sourceUrl) return fail('Imported tasks need a source URL or external ID')
    // Prefer the full source URL: includes workspace/project identity, avoiding collisions between repositories.
    if (input.sourceUrl) {
      const u=new URL(input.sourceUrl);u.hash=''
      return `${input.source}:${u.toString().replace(/\/$/,'')}`
    }
    return `${input.source}:external:${input.externalId}`
  }
  private validate(input: CompanyTaskInput, taskId?: string, prev: { departmentId?: string|null; agentId?: string|null } = {}): void {
    const p=this.passport(input.companyId)
    if (input.repoId && !p.repoIds.includes(input.repoId)) fail('Choose a repository assigned to this company Passport')
    if (input.assigneeProfileId && !this.store.getProfile(input.assigneeProfileId)) fail('Agent profile not found')
    // a task's department and agent are its own company's, whichever caller (IPC, router, MCP, schedules) writes them
    this.departments.assertTaskRefs(input.companyId,input,prev)
    const walk=(id:string, seen=new Set<string>()):void=> {
      if (id===taskId) fail('Task dependencies cannot form a cycle')
      if (seen.has(id)) return
      seen.add(id)
      const dep=this.task(id)
      if (dep.companyId!==input.companyId) fail('Related tasks must belong to the same company')
      for(const d of dep.dependencyIds) walk(d,seen)
    }
    for(const d of input.dependencyIds) walk(d)
    if (input.parentId) {
      const seen=new Set<string>();let id:string|null=input.parentId
      while(id) { if(id===taskId||seen.has(id)) fail('Parent tasks cannot form a cycle'); seen.add(id);const t=this.task(id);if(t.companyId!==input.companyId) fail('Parent task must belong to the same company');id=t.parentId }
    }
    if (input.status==='done' && !this.depsDone(input)) fail('Complete dependencies before completing this task')
  }
  private depsDone(t: Pick<CompanyTaskInput,'dependencyIds'>): boolean { return t.dependencyIds.every(d=>this.task(d).status==='done') }
  /** A canceled dependency never becomes done: a task waiting on it would sit in blocked(deps) forever. */
  private canceledDep(t: Pick<CompanyTaskInput,'dependencyIds'>): BoardTask|null {
    for(const d of t.dependencyIds) { const dep=this.task(d);if(dep.status==='canceled') return dep }
    return null
  }
  /** blocked(deps) waiting on a canceled dependency → blocked(manual), so it shows in Needs you. Returns the activity text. */
  private parkOnCanceledDep(t: BoardTask): string|null {
    if(t.status!=='blocked'||t.blockReason!=='deps') return null
    const dep=this.canceledDep(t)
    if(!dep) return null
    assertTransition(t,{status:'blocked',blockReason:'manual'},'system',{depCanceled:true})
    t.blockReason='manual'
    return `${dep.identifier} was canceled. Remove it from the dependencies or reopen it, then Unpark.`
  }
  /**
   * §1.4 "system on save": a todo task with unmet dependencies is stored blocked(deps), so the lock shows (parked
   * manual instead when one of them is canceled). Returns the `parked` activity text, or null when nothing changed.
   */
  private lockDeps(t: BoardTask): string|null {
    if (t.status!=='todo' || !this.boardOn() || this.depsDone(t)) return null
    assertTransition(t,{status:'blocked',blockReason:'deps'},'system',{depsDone:false})
    t.status='blocked';t.blockReason='deps'
    return this.parkOnCanceledDep(t) ?? 'Waiting for its dependencies'
  }
  createTask(input: CompanyTaskInput): BoardTask {
    input=taskInputSchema.parse(input)
    if(input.status==='in_progress') fail('Use Run agent to start work, or create the task in To do')
    // §0.7: an agent never marks a task done, not even one it creates
    if(input.source==='agent'&&input.status==='done') fail('An agent cannot create a task as done')
    return this.store.db.transaction(()=> {
      this.validate(input);const key=this.sourceKey(input)
      if(key) { const found=this.store.db.prepare('SELECT data FROM company_tasks WHERE company_id=? AND source_key=?').get(input.companyId,key) as {data:string}|undefined;if(found) return readTask(found.data) }
      const now=new Date().toISOString();const id=uid('task')
      const row=this.store.db.prepare('INSERT INTO company_tasks(id,company_id,source_key,data) VALUES(?,?,?,?)').run(id,input.companyId,key,'{}')
      const task=withTaskDefaults({...input,id,identifier:`PRN-${row.lastInsertRowid}`,runId:null,createdAt:now,updatedAt:now,dependencyIds:[...new Set(input.dependencyIds)]}) as BoardTask
      if(task.status!=='blocked') task.blockReason=null
      else if(!task.blockReason) task.blockReason=this.boardOn()&&task.dependencyIds.length&&!this.depsDone(task)?'deps':'manual'
      const locked=this.lockDeps(task) ?? this.parkOnCanceledDep(task)
      this.writeTask(task);this.activity(id,'created',`Created from ${input.source}`,input.source==='agent'?'agent':input.source==='manual'?'human':'system')
      if(locked) this.activity(id,'parked',locked)
      return task
    })()
  }
  /** One statement: the JSON and its §1.2 query mirrors (status, department_id, agent_id). */
  private writeTask(task: CompanyTask): void {
    this.store.db.prepare('UPDATE company_tasks SET company_id=?,source_key=?,run_id=?,status=?,department_id=?,agent_id=?,data=? WHERE id=?')
      .run(task.companyId,this.sourceKey(task),task.runId,task.status,task.departmentId??null,task.agentId??null,JSON.stringify(task),task.id)
  }
  updateTask(id:string, patch:Partial<CompanyTaskInput>): BoardTask {
    return this.store.db.transaction(()=> {
      const old=this.task(id);const {id:_id,identifier:_identifier,runId:_runId,createdAt:_createdAt,updatedAt:_updatedAt,...fields}=old;const input=taskInputSchema.parse({...fields,...patch})
      return this.applyUpdate(old,input)
    })()
  }
  /**
   * A human edit. Board tasks (with a department or an agent) move only along §1.4; plain company tasks keep today's
   * free status edits. Either way: no edits in flight, the company never changes, and blocked always has a reason.
   */
  private applyUpdate(old:BoardTask,input:CompanyTaskInput): BoardTask {
    assertEditable(old,input)
    if(input.status==='in_progress') fail('Use Run agent to start this task')
    this.validate(input,old.id,old)
    const next=withTaskDefaults({...old,...input,dependencyIds:[...new Set(input.dependencyIds)],updatedAt:new Date().toISOString()}) as BoardTask
    const statusChanged=old.status!==next.status
    if(next.status!=='blocked') next.blockReason=null
    else if(statusChanged&&!input.blockReason) next.blockReason='manual'
    else if(!next.blockReason) next.blockReason=old.blockReason??'manual'
    const board=!!(old.departmentId||old.agentId||next.departmentId||next.agentId)
    const depsDone=this.depsDone(next)
    if(board&&(statusChanged||old.blockReason!==next.blockReason)) assertTransition(old,next,'human',{routed:!!(next.departmentId||next.agentId),depsDone,doneNote:next.doneNote})
    if(statusChanged&&next.status!=='done'&&old.status==='done') next.doneNote=null
    // a new seat or profile never resumes the previous one's provider conversation
    if((next.agentId??null)!==(old.agentId??null)||(next.assigneeProfileId??null)!==(old.assigneeProfileId??null)) next.agentSessionId=null
    let healed=false
    if(next.status==='blocked'&&next.blockReason==='deps'&&depsDone) { next.status='todo';next.blockReason=null;healed=true }
    const locked=this.lockDeps(next)
    this.writeTask(next)
    this.activity(old.id,'updated',old.status!==next.status ? `Status: ${old.status} → ${next.status}` : 'Task details updated','human')
    if(healed) this.activity(old.id,'healed','Every dependency is done')
    if(locked) this.activity(old.id,'parked',locked)
    if(next.status==='done'&&statusChanged&&this.boardOn()) this.heal(next.companyId)
    if(next.status==='canceled'&&statusChanged) this.parkDependents(next)
    return next
  }

  // ---------- DEPARTMENTS.md §1.4, §4, §5: the board ----------

  /** §4.2: prompts are redacted before they leave main (h.vault.redact, plugged in by the board handlers). */
  setRedactor(fn: ((text: string) => string) | null): void { this.redact = fn ?? (s=>s) }
  /** §0.8: the departments flag, plugged in by the board handlers (unset = on, as in tests). */
  setBoardEnabled(fn: (() => boolean) | null): void { this.boardOn = fn ?? (()=>true) }
  /**
   * Heal (§3.1): every blocked(deps) task whose dependencies are all done moves to todo with a `healed` activity and
   * an "unblocked" wake. Returns the healed tasks. Never touches any other block reason.
   */
  heal(companyId?: string): BoardTask[] {
    return this.store.db.transaction(()=> {
      const rows=(companyId ? this.store.db.prepare("SELECT data FROM company_tasks WHERE company_id=? AND (status='blocked' OR status IS NULL) ORDER BY seq").all(companyId)
        : this.store.db.prepare("SELECT data FROM company_tasks WHERE status='blocked' OR status IS NULL ORDER BY seq").all()) as {data:string}[]
      const waiting=rows.map(r=>readTask(r.data)).filter(t=>t.status==='blocked'&&t.blockReason==='deps')
      // a dependency canceled while the task was in flight (or before this rule): park it instead of waiting forever
      for(const t of waiting) {
        const why=this.boardOn() ? this.parkOnCanceledDep(t) : null
        if(why) { this.writeTask({...t,updatedAt:new Date().toISOString()});this.activity(t.id,'parked',why) }
      }
      return waiting.filter(t=>t.blockReason==='deps'&&this.depsDone(t)).map(t=>this.healOne(t))
    })()
  }
  private healOne(t: BoardTask): BoardTask {
    assertTransition(t,{status:'todo'},'system',{depsDone:true})
    const next:BoardTask={...t,status:'todo',blockReason:null,pendingWake:addWake(t.pendingWake,'Unblocked: every dependency is done.'),updatedAt:new Date().toISOString()}
    this.writeTask(next);this.activity(t.id,'healed','Every dependency is done');return next
  }
  /**
   * tasks:assign: department and/or agent (undefined = unchanged, null = clear). Refused in flight or when closed. An
   * agent of a department pulls an unfiled task into it; a triage task leaves the Inbox once routed (§1.4 row 1).
   */
  assign(id: string, refs: { departmentId?: string|null; agentId?: string|null }, by: ActivityBy = 'human', routing?: { by: TaskRouting['by']; reason: string; confidence?: number }): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id)
      if(['done','canceled'].includes(t.status)) fail('Reopen this task before assigning it')
      assertReassignable(t,refs)
      let departmentId=refs.departmentId!==undefined ? refs.departmentId : t.departmentId
      const agentId=refs.agentId!==undefined ? refs.agentId : t.agentId
      const agent=agentId ? this.departments.agent(agentId) : null
      if(agent&&agent.companyId===t.companyId&&agent.departmentId&&refs.departmentId===undefined) departmentId=agent.departmentId
      this.departments.assertTaskRefs(t.companyId,{departmentId,agentId},t)
      const dep=departmentId ? this.departments.department(departmentId) : null
      const reason=routing?.reason ?? (by==='human' ? 'Assigned by you' : by==='agent' ? 'Handed off by an agent' : 'Assigned by a rule')
      const next:BoardTask={...t,departmentId,agentId,routing:{departmentId,agentId,by:routing?.by ?? (by==='human' ? 'human' : 'rule'),reason,...(routing?.confidence!==undefined ? {confidence:routing.confidence} : {})},updatedAt:new Date().toISOString()}
      if(by==='human') next.autoWakes={windowStart:null,n:0}
      // another seat never resumes the previous agent's provider conversation
      if((agentId??null)!==(t.agentId??null)) next.agentSessionId=null
      if(t.status==='triage'&&(departmentId||agentId)) { assertTransition(t,{status:'todo'},by==='agent'?'system':by,{routed:true});next.status='todo' }
      const locked=this.lockDeps(next)
      this.writeTask(next)
      // router rule 1 already says "assigned to <agent>…": keep only what it adds (state, moved department)
      const said=agent?`assigned to ${agent.name}`:null
      const tail=said&&reason.toLowerCase().startsWith(said.toLowerCase()) ? reason.slice(said.length) : `. ${reason}`
      this.activity(id,'assigned',`${agent ? `Assigned to ${agent.name}` : 'Unassigned'}${dep ? ` in ${dep.name}` : ''}${tail}`,by)
      if(locked) this.activity(id,'parked',locked)
      return next
    })()
  }
  /**
   * §2 step 4: stores the model's suggestion (`routing.by:'model'`) on an unrouted triage task, without touching its
   * department, agent or status. Null when the task moved on while the model ran (suggestionApplies): a late suggestion
   * never overwrites a decision. The founder applies it with tasks:acceptRoute.
   */
  suggestRouting(id: string, routing: TaskRouting): BoardTask|null {
    if(routing.by!=='model') fail('Only a model suggestion is stored this way')
    return this.store.db.transaction(()=> {
      const t=this.task(id)
      if(!suggestionApplies(t)) return null
      const next:BoardTask={...t,routing:{departmentId:routing.departmentId,agentId:routing.agentId,by:'model',reason:routing.reason.slice(0,500),...(routing.confidence!==undefined ? {confidence:routing.confidence} : {})},updatedAt:new Date().toISOString()}
      this.writeTask(next)
      return next
    })()
  }
  /** tasks:acceptRoute: applies the model's suggestion (§2 step 4). v1 never applies one by itself. */
  acceptRoute(id: string): BoardTask {
    const t=this.task(id)
    if(t.routing?.by!=='model') fail('This task has no routing suggestion to accept')
    const r=t.routing!
    const out=this.assign(id,{departmentId:r.departmentId,agentId:r.agentId},'human',{by:'model',reason:`Suggestion accepted: ${r.reason}`,...(r.confidence!==undefined ? {confidence:r.confidence} : {})})
    this.activity(id,'routed',`Accepted the suggested routing: ${r.reason}`,'human')
    return out
  }
  /** tasks:answer (§5): blocked(needs_input) → todo with the answer recorded; the same agent resumes with "Answer: …". */
  answer(id: string, answer: string): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id);answer=answer.trim()
      if(t.status!=='blocked'||t.blockReason!=='needs_input'||!t.ask||t.ask.answer) fail('This task is not waiting for an answer')
      assertTransition(t,{status:'todo'},'human',{answer})
      const next:BoardTask={...t,status:'todo',blockReason:null,ask:{...t.ask!,answer,answeredAt:new Date().toISOString()},pendingWake:addWake(t.pendingWake,`Answer: ${answer}`),autoWakes:{windowStart:null,n:0},updatedAt:new Date().toISOString()}
      const locked=this.lockDeps(next)
      this.writeTask(next);this.activity(id,'answered',`Answer: ${answer}`,'human')
      if(locked) this.activity(id,'parked',locked)
      return next
    })()
  }
  /** tasks:approve: in_review → done, human only, with a non-empty done note (§0.7). Heals the tasks waiting on it. */
  approve(id: string, doneNote: string, by: ActivityBy = 'human'): BoardTask {
    const out=this.store.db.transaction(()=> {
      const t=this.task(id);const note=(doneNote ?? '').trim()
      assertTransition(t,{status:'done'},by,{doneNote:note})
      if(t.status!=='in_review') fail('Only a task in review can be approved')
      if(!this.depsDone(t)) fail('Complete dependencies before completing this task')
      const next:BoardTask={...t,status:'done',blockReason:null,doneNote:note,pendingWake:null,updatedAt:new Date().toISOString()}
      this.writeTask(next);this.activity(id,'approved',`Approved: ${note}`,'human')
      return next
    })()
    this.heal(out.companyId)
    return out
  }
  /** tasks:sendBack: in_review → todo; the note becomes the next turn's wake. */
  sendBack(id: string, note: string): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id);note=(note ?? '').trim()
      if(t.status!=='in_review') fail('Only a task in review can be sent back')
      assertTransition(t,{status:'todo'},'human',{note})
      const next:BoardTask={...t,status:'todo',blockReason:null,pendingWake:addWake(t.pendingWake,`Sent back: ${note}`),autoWakes:{windowStart:null,n:0},updatedAt:new Date().toISOString()}
      const locked=this.lockDeps(next)
      this.writeTask(next);this.activity(id,'sent_back',`Sent back: ${note}`,'human')
      if(locked) this.activity(id,'parked',locked)
      return next
    })()
  }
  /** tasks:unpark: blocked (any reason but deps) → todo; resets the automatic wake counter. */
  unpark(id: string): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id)
      if(t.status!=='blocked') fail('This task is not parked')
      if(t.blockReason==='deps') fail('This task waits for its dependencies; it unblocks by itself when they are done')
      const canceled=this.boardOn() ? this.canceledDep(t) : null
      if(canceled) fail(`${canceled.identifier} was canceled. Remove it from the dependencies or reopen it before unparking this task.`)
      assertTransition(t,{status:'todo'},'human')
      const next:BoardTask={...t,status:'todo',blockReason:null,autoWakes:{windowStart:null,n:0},updatedAt:new Date().toISOString()}
      const locked=this.lockDeps(next)
      this.writeTask(next);this.activity(id,'updated',`Unparked (was ${t.blockReason ?? 'blocked'})`,'human')
      if(locked) this.activity(id,'parked',locked)
      return next
    })()
  }
  /** Any task not in flight → canceled, by a human. */
  cancel(id: string): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id)
      assertTransition(t,{status:'canceled'},'human')
      const next:BoardTask={...t,status:'canceled',blockReason:null,pendingWake:null,updatedAt:new Date().toISOString()}
      this.writeTask(next);this.activity(id,'updated',`Status: ${t.status} → canceled`,'human')
      this.parkDependents(next)
      return next
    })()
  }
  /**
   * A canceled dependency never becomes done, so a blocked(deps) task waiting on it would sit in Queued forever. It is
   * parked (manual) instead, which puts it in Needs you with the reason.
   */
  private parkDependents(canceled: BoardTask): void {
    if(!this.boardOn()) return
    const rows=this.store.db.prepare("SELECT data FROM company_tasks WHERE company_id=? AND status='blocked' ORDER BY seq").all(canceled.companyId) as {data:string}[]
    for(const t of rows.map(r=>readTask(r.data))) {
      if(t.blockReason!=='deps'||!t.dependencyIds.includes(canceled.id)) continue
      assertTransition(t,{status:'blocked',blockReason:'manual'},'system',{depCanceled:true})
      this.writeTask({...t,blockReason:'manual',updatedAt:new Date().toISOString()})
      this.activity(t.id,'parked',`${canceled.identifier} was canceled. Remove it from the dependencies or reopen it, then Unpark.`)
    }
  }
  /**
   * Main-only writes to a task while its run is in flight: the report and ask (hivetask tools, report harvest), the
   * provider session id, the pending wake, the wake guard and the handoff count. Never the status.
   */
  patchInFlight(id: string, patch: Partial<Pick<TaskBoardFields,'report'|'ask'|'agentSessionId'|'pendingWake'|'autoWakes'|'handoffs'>>): BoardTask {
    const p=inFlightPatchSchema.parse(patch)
    return this.store.db.transaction(()=> {
      const next:BoardTask={...this.task(id),...p,updatedAt:new Date().toISOString()} as BoardTask
      this.writeTask(next);return next
    })()
  }
  /** The next run end of this task parks with `reason` instead of no_report (a time or wake cap canceled it). */
  expectStop(taskId: string, reason: 'limit'|'interrupted'|'handoff_cap'): void { this.stopReasons.set(taskId,reason) }
  /** Parks an in-flight task whose run or session is gone (no live run to cancel). */
  park(id: string, reason: 'no_report'|'interrupted'|'limit'|'run_failed', message: string): BoardTask {
    return this.store.db.transaction(()=> {
      const t=this.task(id)
      assertTransition(t,{status:'blocked',blockReason:reason},'system')
      const next:BoardTask={...t,status:'blocked',blockReason:reason,runId:null,updatedAt:new Date().toISOString()}
      this.writeTask(next);this.activity(id,reason==='interrupted'?'interrupted':'parked',message);return next
    })()
  }
  /** board:autopilot. Stored in the company row's JSON (§1.1); both default off / DEFAULT_MAX_IN_FLIGHT. */
  setAutopilot(companyId: string, on: boolean, maxInFlight?: number): BoardSettings {
    const c=this.passport(companyId)
    if(on&&c.archivedAt) fail(`Unarchive ${c.name} before turning Autopilot on`)
    if(maxInFlight!==undefined&&(!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>20)) fail('Tasks in flight must be between 1 and 20')
    this.store.db.transaction(()=> {
      const data=this.companyJson(companyId)
      this.store.db.prepare('UPDATE company_passports SET data=? WHERE id=?').run(JSON.stringify({...data,autopilot:on,...(maxInFlight!==undefined ? {maxInFlight} : {})}),companyId)
    })()
    return this.boardSettings(companyId)
  }
  boardSettings(companyId: string): BoardSettings {
    this.passport(companyId)
    const data=this.companyJson(companyId)
    const max=typeof data.maxInFlight==='number'&&Number.isInteger(data.maxInFlight)&&data.maxInFlight>=1 ? data.maxInFlight : DEFAULT_MAX_IN_FLIGHT
    return {companyId,autopilot:data.autopilot===true,maxInFlight:max}
  }
  private companyJson(companyId: string): Record<string, unknown> {
    const row=this.store.db.prepare('SELECT data FROM company_passports WHERE id=?').get(companyId) as {data:string}|undefined
    try { const v=row ? JSON.parse(row.data) : {}; return v && typeof v==='object' ? v : {} } catch { return {} }
  }

  /**
   * §4: starts a task turn. The seat (agentId) decides the profile or workflow; legacy tasks run their
   * assigneeProfileId (or the explicit `profileId` of "Run agent"). cwd: the task's repo, else the agent's default repo,
   * else the company workspace. `actor:'system'` is the dispatcher (paused agents refused); a human click skips the
   * autopilot gate. One in-flight task per agent.
   */
  startTask(id:string, profileId:string|undefined, start:(target:RunTarget, companyId:string, link:TaskRunLink)=>Run, opts:{actor?:'human'|'system'}={}): BoardTask {
    const actor=opts.actor ?? 'human'
    return this.store.db.transaction(()=> {
      let task=this.task(id)
      if(task.status==='in_progress'||(task.runId&&['queued','running'].includes(this.store.getRun(task.runId)?.status??''))) fail('An agent already owns this task')
      if(['done','canceled'].includes(task.status)) fail('Reopen this task before starting an agent')
      if(!this.depsDone(task)) fail('Complete dependencies before starting this task')
      if(task.status==='blocked'&&task.blockReason==='deps') task=this.healOne(task)
      assertTransition(task,{status:'in_progress'},actor,{start:true,depsDone:true})
      this.validate(task,task.id,task)
      const agent=task.agentId ? this.departments.agent(task.agentId) : null
      if(actor==='system') this.assertAutoStart(task,agent)
      if(agent) {
        if(agent.companyId!==task.companyId) fail(`${agent.name} belongs to another company`)
        if(agent.archivedAt) fail(`${agent.name} is archived. Assign another agent.`)
        if(actor==='system'&&agent.pausedAt) fail(`${agent.name} is paused`)
        const busy=this.store.db.prepare("SELECT data FROM company_tasks WHERE agent_id=? AND status='in_progress' AND id<>? LIMIT 1").get(agent.id,task.id) as {data:string}|undefined
        if(busy) fail(`${agent.name} is busy on ${readTask(busy.data).identifier}`)
      }
      const company=this.passport(task.companyId)
      const repoId=task.repoId ?? agent?.data.defaultRepoId ?? null
      if(repoId&&!company.repoIds.includes(repoId)) fail(`The agent's default repository no longer belongs to ${company.name}. Choose a repository on the task.`)
      const cwd=repoId ? this.store.getRepo(repoId)?.path ?? fail('Repository no longer exists') : this.companyWorkspace(task.companyId)
      const wake=task.pendingWake?.reasons.length ? task.pendingWake.reasons : [actor==='human' ? 'Run now: the human started this task.' : 'Assigned: this task is yours.']
      let target:RunTarget;let selected:string|null=task.assigneeProfileId;let resumeSessionId:string|null=null
      if(agent?.kind==='workflow'&&!profileId) {
        if(!this.store.getWorkflow(agent.refId)) fail('The workflow behind this agent no longer exists')
        this.scope.assertSameCompany(task.companyId,{workflowId:agent.refId})
        target={kind:'workflow',workflowId:agent.refId,inputs:{task_identifier:task.identifier,task_title:this.redact(task.title),task_description:this.redact(task.description)}}
      } else {
        selected=profileId ?? (agent?.kind==='profile' ? agent.refId : null) ?? task.assigneeProfileId
        const profile=selected ? this.store.getProfile(selected) : null
        if(!profile) fail('Choose an agent profile')
        if(profile!.adapter==='shell') fail('Choose Claude, Codex, Cursor, or Gemini to work on this task')
        // only the profile that held the conversation resumes it (assigneeProfileId is the last turn's profile)
        resumeSessionId=profile!.adapter==='claude'&&task.agentSessionId&&selected===task.assigneeProfileId ? task.agentSessionId : null
        const prompt=resumeSessionId ? buildResumePrompt(wake) : this.taskPrompt(task,agent,wake)
        target={kind:'prompt',profileId:selected!,repoId,prompt:this.redact(prompt),memory:'read-write'}
      }
      const run=start(target,task.companyId,{taskId:task.id,agentId:agent?.id ?? null,cwd,resumeSessionId})
      // §6: a task's run belongs to the task's company, whatever the engine inferred; §1.2 runs.task_id / agent_id
      this.store.db.prepare('UPDATE runs SET company_id=? WHERE id=?').run(task.companyId,run.id)
      if(this.runLinks) this.store.db.prepare('UPDATE runs SET task_id=?,agent_id=? WHERE id=?').run(task.id,agent?.id ?? null,run.id)
      const updated:BoardTask={...task,status:'in_progress',blockReason:null,runId:run.id,assigneeProfileId:selected,report:null,ask:null,pendingWake:null,updatedAt:new Date().toISOString()}
      this.stopReasons.delete(id)
      this.writeTask(updated);this.activity(id,'started',`${agent ? `${agent.name} started` : 'Agent started'} run ${run.id}`,actor)
      this.syncRun(run)
      return this.task(id)
    })()
  }
  /**
   * §0.6, §3.2: an automatic start (the dispatcher, a follow-up turn, a recurring fire) needs the board on, autopilot
   * on for the company, an `auto` seat, and the company under maxInFlight. Checked inside startTask's transaction, so
   * the gate and the claim cannot interleave with another start. A human click skips it.
   */
  private assertAutoStart(task: BoardTask, agent: CompanyAgent|null): void {
    if(!this.boardOn()) fail('Departments are off; only a human can start a task')
    if(!agent) fail('Only a human can start a task without an agent')
    if(agent!.data.autonomy!=='auto') fail(`${agent!.name} is manual; only a human can start its tasks`)
    const company=this.passport(task.companyId)
    if(company.archivedAt) fail(`${company.name} is archived`)
    const settings=this.boardSettings(task.companyId)
    if(!settings.autopilot) fail(`Autopilot is off for ${company.name}`)
    const n=(this.store.db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress' AND id<>?").get(task.companyId,task.id) as {n:number}).n
    if(n>=settings.maxInFlight) fail(`${company.name} already has ${n} tasks in flight (limit ${settings.maxInFlight})`)
  }
  /** The company workspace (`<userData>/companies/<slug>/workspace`), created on demand; null without company folders. */
  private companyWorkspace(companyId: string): string|null {
    if(!this.scope.companiesRoot) return null
    return this.scope.ensureWorkspace(companyId)
  }
  private taskPrompt(task: BoardTask, agent: CompanyAgent|null, wake: string[]): string {
    const department=task.departmentId ? this.departments.get(task.departmentId) : null
    const deps=task.dependencyIds.map(d=>this.task(d)).map(d=>({identifier:d.identifier,title:d.title,status:d.status,doneNote:d.doneNote}))
    return buildTaskPrompt({task,companyId:task.companyId,department,agent:agent ? {name:agent.name,instructions:agent.data.instructions} : null,deps,activity:this.detail(task.id).activity,wake})
  }
  /**
   * Run end (§1.4, §4.5): ask → blocked(needs_input); report blocked → blocked(agent); report review, or passed with no
   * report (flagged) → in_review; failed → blocked(run_failed); canceled with no report → blocked(no_report).
   */
  syncRun(run: Run): boolean {
    if(!['passed','failed','canceled'].includes(run.status)) return false
    const rows=this.store.db.prepare('SELECT data FROM company_tasks WHERE run_id=?').all(run.id) as {data:string}[]
    let changed=false
    for(const r of rows) { const t=readTask(r.data);if(t.status!=='in_progress')continue
      const end=runEndState(t,{status:run.status as 'passed'|'failed'|'canceled',reason:run.reason},this.depsDone(t),this.stopReasons.get(t.id))
      assertTransition(t,end.to,'system')
      this.stopReasons.delete(t.id)
      const next:BoardTask={...t,status:end.to.status,blockReason:end.to.blockReason ?? null,updatedAt:new Date().toISOString()}
      // waiting on a dependency that was canceled during the run: it would never heal
      const parked=this.parkOnCanceledDep(next)
      this.writeTask(next);this.activity(t.id,end.kind,end.message,end.by);changed=true
      if(parked) this.activity(t.id,'parked',parked)
    }
    return changed
  }
  /** Called once at startup, after engine recovery and before accepting requests. Interrupted tasks are never rerun. */
  reconcile(): void {
    for(const t of this.listTasks()) {
      if(t.status!=='in_progress') continue
      const r=t.runId ? this.store.getRun(t.runId) : null
      if(r && ['passed','failed','canceled'].includes(r.status)) this.syncRun(r)
      else this.park(t.id,'interrupted',`Previous execution${t.runId ? ` ${t.runId}`:''} was interrupted. Review and retry explicitly.`)
    }
  }
}
/** Older rows lack the §1.3 fields; a bad JSON field never hides the task. */
function readTask(data: string): BoardTask { return withTaskDefaults(JSON.parse(data)) as BoardTask }
/** Wake reasons for the next turn, in arrival order (capped, like pendingWake's schema). */
function addWake(w: PendingWake|null, reason: string): PendingWake {
  const reasons=[...(w?.reasons ?? []),reason.slice(0,4000)].slice(-50)
  return {reasons,count:(w?.count ?? 0)+1}
}
