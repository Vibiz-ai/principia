/**
 * AUTOPILOT.md §6: autopilot playbooks in main. One row per company and playbook (`autopilot_playbooks`), each owning
 * exactly one ordinary task-mode schedule for one agent, so it stays visible (Schedules) and stops with one switch.
 *
 * - Turn on: the founder's yes (an offer card or Automations › Autopilots). Creates the schedule enabled, with the
 *   prompt for its level and limits. A money playbook is refused above Level 2 unless the request says the founder
 *   raised it (`raise: true`, behind a confirm in the UI).
 * - Pause / resume flip the schedule; a level or limit change rewrites only the schedule's prompt.
 * - After every run of a playbook's card, `guardRun` checks the tools the run called against the level
 *   (autopilotPlaybooks.refusedTools). A refused call pauses the playbook and says why; nothing is resumed by itself.
 *
 * Company isolation: every read and write names the company, and a schedule or agent of another company is never
 * used. No Electron imports (the schedule calls are injected).
 */
import type Database from 'better-sqlite3'
import { HiveError } from '../../shared/errors'
import { agentActive, type CompanyAgent } from '../../shared/company'
import {
  ADS_CONNECTION,
  readCallArgs,
  type AdsConnector,
  classifyCall,
  classifyTool,
  guardCall,
  guardedTool,
  isPlaybookId,
  isWrite,
  missingConnection,
  WAITING_PREFIX,
  waitingLine,
  levelRefusal,
  maxLevel,
  playbookDef,
  playbookLimits,
  playbookPrompt,
  PLAYBOOK_IDS,
  refusedTools,
  type BudgetSet,
  type PlaybookId,
  type PlaybookLevel,
  type PlaybookLimits,
  type PlaybookSummary,
  type PlaybookView
} from '../../shared/autopilotPlaybooks'
import type { Schedule, ScheduleInput } from '../../shared/types'
import type { CompanyStore } from './index'

export interface PlaybookScheduleOps {
  create(input: ScheduleInput & { companyId: string }): Schedule
  update(id: string, input: ScheduleInput): Schedule
  setEnabled(id: string, enabled: boolean): Schedule
  remove(id: string): void
  get(id: string): Schedule | null
}

export interface PlaybooksDeps {
  db: Database.Database
  company: () => CompanyStore
  schedules: PlaybookScheduleOps
  /** experimental.companies + departments (a playbook is a card on the board for an agent) */
  departmentsOn: () => boolean
  /** IANA tz of this Mac */
  tz?: () => string
  now?: () => Date
  onChange?: (companyId: string) => void
  /** what reaches the company (connection ids and names, key names, accounts): a playbook that needs one waits for it */
  connections?: (companyId: string) => string[]
  log?: (message: string, meta: Record<string, unknown>) => void
}

/** One call through the connections gateway (main sees it before it happens). */
export interface GatewayCallInfo {
  runId: string | null
  companyId: string | null
  connection: string
  tool: string
  args?: unknown
  /** the connection's server marks the tool read-only (MCP readOnlyHint) */
  readOnly?: boolean
  /** the known ads connector the server is (from its URL or command, never its name), null when unknown */
  connector?: AdsConnector | null
}

export interface TurnOnOptions {
  level: number
  /** the founder explicitly raised a money playbook to Level 3 (a confirm in the UI) */
  raise?: boolean
  limits?: Partial<PlaybookLimits>
  agentId?: string | null
}

interface Row {
  company_id: string
  playbook_id: string
  schedule_id: string
  agent_id: string | null
  level: number
  raised: number
  limits_json: string
  on_at: string
  paused_at: string | null
  paused_why: string | null
}

export const PLAYBOOKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS autopilot_playbooks (  -- (M) AUTOPILOT.md §6: a playbook a company put on autopilot
  company_id  TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  agent_id    TEXT,
  level       INTEGER NOT NULL,
  raised      INTEGER NOT NULL DEFAULT 0,
  limits_json TEXT NOT NULL DEFAULT '{}',
  on_at       TEXT NOT NULL,
  paused_at   TEXT,
  paused_why  TEXT,
  PRIMARY KEY (company_id, playbook_id)
);
CREATE INDEX IF NOT EXISTS autopilot_playbooks_schedule ON autopilot_playbooks(schedule_id);
CREATE TABLE IF NOT EXISTS autopilot_tool_calls (  -- (M) AUTOPILOT.md §6: outside tool calls of runs, for the guard's counts and the offers
  run_id      TEXT NOT NULL,
  company_id  TEXT,
  playbook_id TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  refused     INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autopilot_tool_calls_run ON autopilot_tool_calls(run_id);
CREATE INDEX IF NOT EXISTS autopilot_tool_calls_pb ON autopilot_tool_calls(company_id, playbook_id, at);
CREATE TABLE IF NOT EXISTS autopilot_budget_sets (  -- (M) AUTOPILOT.md §6: daily budgets a company's playbook runs set, per day, against the total cap
  company_id  TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  day         TEXT NOT NULL,
  target      TEXT,
  usd         REAL NOT NULL,
  run_id      TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autopilot_budget_sets_day ON autopilot_budget_sets(company_id, day);
CREATE INDEX IF NOT EXISTS autopilot_budget_sets_target ON autopilot_budget_sets(company_id, target);
CREATE TABLE IF NOT EXISTS autopilot_playbook_schedules (  -- (M) AUTOPILOT.md §6: every schedule a playbook ever had, so runs and follow-ups of one turned off stay guarded
  schedule_id TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  at          TEXT NOT NULL
);
`
/** Columns added after the first version of autopilot_tool_calls (the refusal's reason and the founder's line). */
const TOOL_CALL_COLUMNS = ['reason TEXT', 'line TEXT']

export class Playbooks {
  constructor(private readonly d: PlaybooksDeps) {
    d.db.exec(PLAYBOOKS_SCHEMA)
    const have = new Set((d.db.prepare('PRAGMA table_info(autopilot_tool_calls)').all() as { name: string }[]).map((c) => c.name))
    for (const col of TOOL_CALL_COLUMNS) if (!have.has(col.split(' ')[0]!)) d.db.exec(`ALTER TABLE autopilot_tool_calls ADD COLUMN ${col}`)
    // playbooks turned on before the history existed
    d.db.exec("INSERT OR IGNORE INTO autopilot_playbook_schedules(schedule_id,company_id,playbook_id,at) SELECT schedule_id,company_id,playbook_id,on_at FROM autopilot_playbooks")
  }

  private now(): string {
    return (this.d.now ? this.d.now() : new Date()).toISOString()
  }
  private changed(companyId: string): void {
    try {
      this.d.onChange?.(companyId)
    } catch {
      /* a UI refresh never fails a write */
    }
  }
  private row(companyId: string, id: string): Row | null {
    return (this.d.db.prepare('SELECT * FROM autopilot_playbooks WHERE company_id=? AND playbook_id=?').get(companyId, id) as Row | undefined) ?? null
  }
  private limitsOf(r: Row): PlaybookLimits {
    let raw: Partial<PlaybookLimits> = {}
    try {
      raw = JSON.parse(r.limits_json) as Partial<PlaybookLimits>
    } catch {
      raw = {}
    }
    return playbookLimits(playbookDef(r.playbook_id as PlaybookId), raw)
  }
  /** The row, when its schedule still exists in the same company (a schedule deleted on Schedules turns it off). */
  private live(companyId: string, id: string): { row: Row; schedule: Schedule } | null {
    const r = this.row(companyId, id)
    if (!r) return null
    const s = this.d.schedules.get(r.schedule_id)
    if (!s || (s.companyId ?? null) !== companyId) return null
    return { row: r, schedule: s }
  }

  /** On for this company (its schedule exists; paused still counts as on: it is never offered again). */
  isOn(companyId: string, id: string): boolean {
    return !!this.live(companyId, id)
  }

  /** Every playbook for one company, on or off, as Automations › Autopilots shows them. */
  list(companyId: string): PlaybookView[] {
    const c = this.d.company()
    c.passport(companyId)
    this.wakeWaiting(companyId)
    return PLAYBOOK_IDS.map((id) => this.view(companyId, id))
  }

  /** Playbooks on per company (every company): the header chip, Home, the rail and All companies read it. */
  summary(): PlaybookSummary {
    const out: PlaybookSummary = {}
    const rows = this.d.db.prepare('SELECT company_id, playbook_id FROM autopilot_playbooks ORDER BY on_at').all() as { company_id: string; playbook_id: string }[]
    for (const r of rows) {
      if (!isPlaybookId(r.playbook_id)) continue
      const v = this.view(r.company_id, r.playbook_id)
      if (!v.on) continue
      ;(out[r.company_id] ??= []).push({ id: v.id, level: v.level, running: v.running, waiting: !!v.waiting })
    }
    return out
  }

  private connectionsOf(companyId: string): string[] | null {
    if (!this.d.connections) return null
    try {
      return this.d.connections(companyId)
    } catch {
      return null
    }
  }

  /**
   * A playbook waiting for its connection (turned on before it was there) starts once the connection is there. Only
   * a pause that said "Waiting for …" is lifted; a pause by the founder or by the guard stays.
   */
  wakeWaiting(companyId: string): PlaybookId[] {
    const rows = this.d.db.prepare('SELECT * FROM autopilot_playbooks WHERE company_id=? AND paused_why LIKE ?').all(companyId, `${WAITING_PREFIX}%`) as Row[]
    if (!rows.length) return []
    const conns = this.connectionsOf(companyId)
    if (!conns) return []
    const woke: PlaybookId[] = []
    for (const r of rows) {
      if (!isPlaybookId(r.playbook_id) || missingConnection(playbookDef(r.playbook_id), conns)) continue
      try {
        this.setPaused(companyId, r.playbook_id, false)
        woke.push(r.playbook_id)
      } catch {
        /* its schedule is gone: nothing to wake */
      }
    }
    return woke
  }

  view(companyId: string, id: PlaybookId): PlaybookView {
    const def = playbookDef(id)
    const l = this.live(companyId, id)
    if (!l) {
      const conns = def.needs ? this.connectionsOf(companyId) : null
      const miss = conns ? missingConnection(def, conns) : null
      return { id, companyId, on: false, level: def.defaultLevel, raised: false, limits: playbookLimits(def, null), scheduleId: null, agentId: null, agentName: null, running: false, pausedWhy: null, lastRunAt: null, lastRunStatus: null, nextRunAt: null, onAt: null, waiting: null, ...(miss ? { needs: { label: miss.label, connectId: miss.connectId } } : {}) }
    }
    const { row, schedule } = l
    const agent = row.agent_id ? this.d.company().departments.getAgent(row.agent_id) : null
    return {
      id,
      companyId,
      on: true,
      level: Math.min(row.level, maxLevel(def, !!row.raised)) as PlaybookLevel,
      raised: !!row.raised,
      limits: this.limitsOf(row),
      scheduleId: schedule.id,
      agentId: row.agent_id,
      agentName: agent ? agent.data.persona?.name || agent.name : null,
      running: schedule.enabled,
      pausedWhy: !schedule.enabled ? row.paused_why : null,
      waiting: !schedule.enabled && row.paused_why?.startsWith(WAITING_PREFIX) && def.needs ? { label: def.needs.label, connectId: def.needs.connectId } : null,
      nearMisses: this.nearMisses(companyId, id),
      lastRunAt: schedule.lastFireAt,
      lastRunStatus: schedule.lastRunStatus,
      nextRunAt: schedule.enabled ? schedule.nextFireAt : null,
      onAt: row.on_at
    }
  }

  /** The agent a playbook goes to: its department's first active seat, else Ops, else company-level, else the first. */
  agentFor(companyId: string, id: PlaybookId, wanted?: string | null): CompanyAgent | null {
    const c = this.d.company()
    const seats = c.departments.listAgents({ companyId }).filter((a) => a.companyId === companyId && agentActive(a) && a.kind === 'profile')
    if (wanted) return seats.find((a) => a.id === wanted) ?? null
    const deps = c.departments.list(companyId).filter((d) => !d.archivedAt)
    const def = playbookDef(id)
    const inDept = (key: string) => {
      const d = deps.find((x) => x.key === key)
      return d ? seats.find((a) => a.departmentId === d.id) ?? null : null
    }
    return (def.dept !== 'lead' ? inDept(def.dept) : null) ?? inDept('ops') ?? seats.find((a) => !a.departmentId) ?? seats[0] ?? null
  }

  private input(companyId: string, id: PlaybookId, agent: CompanyAgent, level: PlaybookLevel, raised: boolean, limits: PlaybookLimits): ScheduleInput {
    const def = playbookDef(id)
    const c = this.d.company()
    const prompt = playbookPrompt(def, { companyName: c.passport(companyId).name, level, raised, limits })
    return {
      name: def.name,
      target: { kind: 'prompt', profileId: agent.refId, repoId: null, prompt, mode: 'task', agentId: agent.id },
      departmentId: agent.departmentId ?? null,
      when: { kind: 'cron', cron: def.cron, tz: this.d.tz?.() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') },
      preset: { kind: 'cron' } as ScheduleInput['preset'],
      enabled: true
    }
  }

  /** The founder's yes: creates the schedule (enabled) for the playbook's agent. On already: changes its level. */
  turnOn(companyId: string, id: string, o: TurnOnOptions): PlaybookView {
    if (!isPlaybookId(id)) throw new HiveError('bad_request', 'Unknown autopilot')
    const def = playbookDef(id)
    const c = this.d.company()
    const co = c.passport(companyId)
    if (co.system === 'personal') throw new HiveError('forbidden', 'Playbooks belong to a company, not Personal')
    if (co.archivedAt) throw new HiveError('conflict', `Unarchive ${co.name} first`)
    if (!this.d.departmentsOn()) throw new HiveError('conflict', 'Playbooks run your departments’ agents. Turn on departments in Settings › Experimental first.')
    const raised = o.raise === true
    const refusal = levelRefusal(def, o.level, raised)
    if (refusal) throw new HiveError('forbidden', refusal)
    if (this.live(companyId, id)) return this.configure(companyId, id, o)
    const agent = this.agentFor(companyId, id, o.agentId)
    if (!agent) throw new HiveError('conflict', o.agentId ? 'Pick an active agent of this company' : `Hire an agent first: ${def.name} needs someone to do it`)
    const level = o.level as PlaybookLevel
    const limits = playbookLimits(def, o.limits)
    // a row left by a schedule deleted on Schedules is replaced
    this.d.db.prepare('DELETE FROM autopilot_playbooks WHERE company_id=? AND playbook_id=?').run(companyId, id)
    const sch = this.d.schedules.create({ ...this.input(companyId, id, agent, level, raised && level === 3, limits), companyId })
    this.d.db
      .prepare('INSERT INTO autopilot_playbooks(company_id,playbook_id,schedule_id,agent_id,level,raised,limits_json,on_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(companyId, id, sch.id, agent.id, level, raised && level === 3 ? 1 : 0, JSON.stringify(limits), this.now())
    this.d.db.prepare('INSERT OR IGNORE INTO autopilot_playbook_schedules(schedule_id,company_id,playbook_id,at) VALUES (?,?,?,?)').run(sch.id, companyId, id, this.now())
    // it never runs only to say it sees nothing: without its connection it waits, paused, and starts once it is there
    const conns = def.needs ? this.connectionsOf(companyId) : null
    const miss = conns ? missingConnection(def, conns) : null
    if (miss) return this.setPaused(companyId, id, true, waitingLine(miss))
    this.changed(companyId)
    return this.view(companyId, id)
  }

  /** A new level or limits: the prompt is rewritten (time and other edits on Schedules stay). Lowering drops the raise. */
  configure(companyId: string, id: string, o: Partial<TurnOnOptions>): PlaybookView {
    if (!isPlaybookId(id)) throw new HiveError('bad_request', 'Unknown autopilot')
    const def = playbookDef(id)
    const l = this.live(companyId, id)
    if (!l) throw new HiveError('not_found', `${def.name} is not on`)
    const level = (o.level ?? Math.min(l.row.level, maxLevel(def, !!l.row.raised))) as PlaybookLevel
    // the raise is only ever kept at Level 3, and only granted by an explicit request
    const raised = level === 3 && (o.raise === true || (o.raise === undefined && !!l.row.raised))
    const refusal = levelRefusal(def, level, raised)
    if (refusal) throw new HiveError('forbidden', refusal)
    const limits = playbookLimits(def, { ...this.limitsOf(l.row), ...(o.limits ?? {}) })
    const agent = l.row.agent_id ? this.d.company().departments.getAgent(l.row.agent_id) : null
    if (agent && agent.companyId === companyId && l.schedule.target.kind === 'prompt') {
      const prompt = playbookPrompt(def, { companyName: this.d.company().passport(companyId).name, level, raised, limits })
      this.d.schedules.update(l.schedule.id, { name: l.schedule.name, target: { ...l.schedule.target, prompt }, departmentId: l.schedule.departmentId ?? null, when: l.schedule.when, preset: l.schedule.preset, enabled: l.schedule.enabled })
    }
    this.d.db.prepare('UPDATE autopilot_playbooks SET level=?, raised=?, limits_json=? WHERE company_id=? AND playbook_id=?').run(level, raised ? 1 : 0, JSON.stringify(limits), companyId, id)
    this.changed(companyId)
    return this.view(companyId, id)
  }

  /** Pause or resume (the schedule's switch). `why`: Principia paused it (a refused action), shown until resumed. */
  setPaused(companyId: string, id: string, paused: boolean, why: string | null = null): PlaybookView {
    if (!isPlaybookId(id)) throw new HiveError('bad_request', 'Unknown autopilot')
    const l = this.live(companyId, id)
    if (!l) throw new HiveError('not_found', `${playbookDef(id).name} is not on`)
    if (l.schedule.enabled === paused) this.d.schedules.setEnabled(l.schedule.id, !paused)
    this.d.db.prepare('UPDATE autopilot_playbooks SET paused_at=?, paused_why=? WHERE company_id=? AND playbook_id=?').run(paused ? this.now() : null, paused ? why : null, companyId, id)
    this.changed(companyId)
    return this.view(companyId, id)
  }

  /** Turn off: removes its schedule (an already-deleted one is fine) and the row. Tasks and runs it made stay. */
  turnOff(companyId: string, id: string): void {
    if (!isPlaybookId(id)) throw new HiveError('bad_request', 'Unknown autopilot')
    const r = this.row(companyId, id)
    if (!r) return
    const s = this.d.schedules.get(r.schedule_id)
    if (s && (s.companyId ?? null) === companyId) this.d.schedules.remove(s.id)
    this.d.db.prepare('DELETE FROM autopilot_playbooks WHERE company_id=? AND playbook_id=?').run(companyId, id)
    this.changed(companyId)
  }

  /** The playbook a schedule belongs to, or null. */
  forSchedule(scheduleId: string): { companyId: string; id: PlaybookId } | null {
    const r = this.d.db.prepare('SELECT company_id, playbook_id FROM autopilot_playbooks WHERE schedule_id=?').get(scheduleId) as { company_id: string; playbook_id: string } | undefined
    return r && isPlaybookId(r.playbook_id) ? { companyId: r.company_id, id: r.playbook_id } : null
  }

  /** The playbook a schedule ever belonged to (one turned off too): its runs and follow-ups stay guarded. */
  private forScheduleEver(scheduleId: string): { companyId: string; id: PlaybookId } | null {
    const now = this.forSchedule(scheduleId)
    if (now) return now
    const r = this.d.db.prepare('SELECT company_id, playbook_id FROM autopilot_playbook_schedules WHERE schedule_id=?').get(scheduleId) as { company_id: string; playbook_id: string } | undefined
    return r && isPlaybookId(r.playbook_id) ? { companyId: r.company_id, id: r.playbook_id } : null
  }

  /**
   * The playbook a run belongs to: its schedule, the standing card of its schedule (source 'schedule'), or a task filed
   * from one (a follow-up whose parent, up to 4 levels, is that card): follow-up work keeps the playbook's level and
   * guard. The run must be of the playbook's own company.
   */
  forRun(runId: string): { companyId: string; id: PlaybookId } | null {
    const run = this.d.db.prepare('SELECT schedule_id, task_id, company_id FROM runs WHERE id=?').get(runId) as { schedule_id: string | null; task_id: string | null; company_id: string | null } | undefined
    if (!run) return null
    let hit = run.schedule_id ? this.forScheduleEver(run.schedule_id) : null
    let taskId = run.task_id
    for (let i = 0; !hit && taskId && i < 5; i++) {
      const t = this.d.db.prepare("SELECT json_extract(data,'$.source') AS source, json_extract(data,'$.externalId') AS ext, json_extract(data,'$.parentId') AS parent FROM company_tasks WHERE json_extract(data,'$.id')=?").get(taskId) as { source: string | null; ext: string | null; parent: string | null } | undefined
      if (!t) break
      if (t.source === 'schedule' && t.ext) hit = this.forScheduleEver(t.ext)
      taskId = t.parent
    }
    return hit && (!run.company_id || run.company_id === hit.companyId) ? hit : null
  }

  /**
   * AUTOPILOT.md §6: the run of a money playbook (and a follow-up of one) loads only Principia's own MCP servers
   * (claude `--strict-mcp-config`) and has no terminal, file writing or web requests, so every call to an ads account
   * goes through the connections gateway, where it is checked before it is made. A playbook turned off still counts
   * (its follow-ups stay restricted). Never throws.
   */
  strictMcpFor(runId: string): boolean {
    try {
      const hit = this.forRun(runId)
      return !!hit && playbookDef(hit.id).money
    } catch {
      return false
    }
  }

  /** The tool calls a run made, in order, repeats kept (every agent of the run, its subagents included). */
  toolsOf(runId: string): string[] {
    try {
      return (this.d.db.prepare("SELECT e.name AS name FROM agent_events e JOIN agents a ON a.id=e.agent_id WHERE a.run_id=? AND e.kind='tool' AND e.name IS NOT NULL ORDER BY e.seq LIMIT 1000").all(runId) as { name: string }[]).map((r) => r.name)
    } catch {
      return []
    }
  }
  /** The calls a run made through the connections gateway, as `mcp__<connection>__<tool>` (the offers read them too). */
  gatewayToolsOf(runId: string): string[] {
    return (this.d.db.prepare('SELECT name FROM autopilot_tool_calls WHERE run_id=? AND refused=0 ORDER BY rowid LIMIT 500').all(runId) as { name: string }[]).map((r) => r.name)
  }
  /** Allowed calls of a playbook's capped kinds inside its window (posts this week, messages today), other runs only. */
  private windowCount(companyId: string, id: PlaybookId, exceptRun: string | null): number {
    const def = playbookDef(id)
    if (!def.caps) return 0
    const since = new Date((this.d.now ? this.d.now() : new Date()).getTime() - def.caps.days * 86_400_000).toISOString()
    const kinds = def.caps.kinds.map(() => '?').join(',')
    return (this.d.db.prepare(`SELECT COUNT(*) AS n FROM autopilot_tool_calls WHERE company_id=? AND playbook_id=? AND refused=0 AND at>=? AND kind IN (${kinds}) AND run_id IS NOT ?`).get(companyId, id, since, ...def.caps.kinds, exceptRun) as { n: number }).n
  }
  private record(runId: string, companyId: string | null, id: PlaybookId | null, name: string, kind: string, refused: boolean, why?: { reason: string; line: string }): void {
    this.d.db
      .prepare('INSERT INTO autopilot_tool_calls(run_id,company_id,playbook_id,name,kind,refused,at,reason,line) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(runId, companyId, id, name.slice(0, 200), kind, refused ? 1 : 0, this.now(), why?.reason.slice(0, 500) ?? null, why?.line.slice(0, 500) ?? null)
    // keep 60 days
    if (Math.random() < 0.02) {
      const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
      this.d.db.prepare('DELETE FROM autopilot_tool_calls WHERE at<?').run(old)
      // budgets keep spending: only an amount replaced by a later one for the same thing goes
      this.d.db.prepare('DELETE FROM autopilot_budget_sets WHERE target IS NOT NULL AND rowid NOT IN (SELECT MAX(rowid) FROM autopilot_budget_sets WHERE target IS NOT NULL GROUP BY company_id, target)').run()
    }
  }

  /** Today in this Mac's time zone ("2026-10-20"): the day a daily budget counts against. */
  private today(): string {
    const now = this.d.now ? this.d.now() : new Date()
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: this.d.tz?.() || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    } catch {
      return now.toISOString().slice(0, 10)
    }
  }
  /**
   * The daily budgets this company's playbook runs set, oldest first, on any day (every playbook of the company
   * counts): a budget set yesterday still spends today, so the total budget cap is a standing total, the latest amount
   * per campaign or ad set.
   */
  budgetSet(companyId: string): BudgetSet[] {
    return (this.d.db.prepare('SELECT target, usd FROM autopilot_budget_sets WHERE company_id=? ORDER BY rowid').all(companyId) as { target: string | null; usd: number }[]).map((r) => ({ target: r.target, usd: r.usd }))
  }

  /**
   * A money playbook's run going on now (started in the last 6 hours), for a call from a grant that is not bound to a
   * playbook run (a chat session's, or another run's): while it runs, such a call is checked as if the playbook made
   * it, so a run cannot reach the ads account through another spawn's folder. A grant of this company is always
   * checked; another company's only for a call that looks like ads (a known ads server, an ads connection id, money or
   * a status in its arguments).
   */
  private liveMoneyRun(c: GatewayCallInfo): { runId: string; hit: { companyId: string; id: PlaybookId } } | null {
    const since = new Date((this.d.now ? this.d.now() : new Date()).getTime() - 6 * 3600_000).toISOString()
    const rows = this.d.db.prepare("SELECT id FROM runs WHERE status='running' AND created_at>=? ORDER BY created_at DESC LIMIT 50").all(since) as { id: string }[]
    let ads: boolean | null = null
    const adsLike = (): boolean => {
      if (ads !== null) return ads
      const a = readCallArgs(c.args, c.connector ?? null)
      return (ads = !!c.connector || ADS_CONNECTION.test(c.connection) || a.money || a.status)
    }
    let other: { runId: string; hit: { companyId: string; id: PlaybookId } } | null = null
    for (const r of rows) {
      if (r.id === c.runId) continue
      const hit = this.forRun(r.id)
      if (!hit || !playbookDef(hit.id).money) continue
      if (c.companyId && hit.companyId === c.companyId) return { runId: r.id, hit }
      if (!other && adsLike()) other = { runId: r.id, hit }
    }
    return other
  }

  /**
   * AUTOPILOT.md §6: a call through the connections gateway, before it happens. In a playbook's run every call is
   * checked against the playbook's level and limits, whatever the connection is called and whatever the tool is
   * called: its arguments count (a budget anywhere in them is money), amounts are converted with the connection's unit
   * and added to the total the company's playbook runs set today, against the total budget cap. Returns the refusal in
   * plain words (the call is not made), or null. Every call is recorded; a refusal also leaves the founder's line (the
   * On autopilot row, and Needs you once the run ends). Never throws: a broken check refuses a playbook's call and lets
   * any other through.
   */
  gatewayCall(c: GatewayCallInfo): string | null {
    const name = `mcp__${c.connection.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}__${c.tool.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)}`
    let hit: { companyId: string; id: PlaybookId } | null = null
    let runId = c.runId
    let borrowed = false
    try {
      hit = c.runId ? this.forRun(c.runId) : null
      if (!hit) {
        // a grant of no playbook run, while a money playbook runs: checked as that run's call (see liveMoneyRun)
        const live = this.liveMoneyRun(c)
        if (!live) {
          if (c.runId) this.record(c.runId, c.companyId, null, name, classifyTool(c.tool), false)
          return null
        }
        hit = live.hit
        runId = live.runId
        borrowed = true
      }
      const l = this.live(hit.companyId, hit.id)
      const def = playbookDef(hit.id)
      if (!l) {
        const line = `${def.short} was off but its run tried ${name.replace(/^mcp__/, '').replace('__', ': ')}; refused.`
        this.record(runId!, hit.companyId, hit.id, name, 'refused', true, { reason: 'This autopilot is off', line })
        this.changed(hit.companyId)
        return 'This playbook is off, so its run makes no outside calls'
      }
      const rec = { level: l.row.level as PlaybookLevel, raised: !!l.row.raised, limits: this.limitsOf(l.row) }
      const runCount = (this.d.db.prepare("SELECT COUNT(*) AS n FROM autopilot_tool_calls WHERE run_id=? AND refused=0 AND kind IN ('change','spend','create','publish','send')").get(runId) as { n: number }).n
      const v = guardCall(def, rec, {
        tool: c.tool,
        connection: c.connection,
        connector: c.connector ?? null,
        args: c.args,
        ...(c.readOnly ? { readOnly: true } : {}),
        runCount,
        windowCount: this.windowCount(hit.companyId, hit.id, null),
        budgetSet: this.budgetSet(hit.companyId)
      })
      if (v.allowed) {
        const day = this.today()
        const ins = this.d.db.prepare('INSERT INTO autopilot_budget_sets(company_id,playbook_id,day,target,usd,run_id,at) VALUES (?,?,?,?,?,?,?)')
        this.d.db.transaction(() => {
          this.record(runId!, hit!.companyId, hit!.id, name, v.kind, false)
          if (v.kind === 'spend') for (const s of v.sets) ins.run(hit!.companyId, hit!.id, day, s.target, s.usd, runId, this.now())
        })()
        return null
      }
      const line = borrowed ? v.line.replace(/; refused\.$/, ' from outside its own run; refused.') : v.line
      this.record(runId!, hit.companyId, hit.id, name, v.kind, true, { reason: v.reason, line })
      this.d.log?.('autopilot: refused a call before it happened', { companyId: hit.companyId, playbook: hit.id, tool: name })
      this.changed(hit.companyId)
      return `${v.reason}. ${def.name} is at Level ${Math.min(l.row.level, maxLevel(def, !!l.row.raised))}: propose this to the founder instead`
    } catch (e) {
      this.d.log?.('autopilot: gateway check failed', { error: String(e) })
      return hit ? 'Principia could not check this call against the playbook’s level, so it was not made' : null
    }
  }

  /** The founder's lines for calls refused lately (newest first): the On autopilot row shows them. */
  nearMisses(companyId: string, id: PlaybookId, days = 7, limit = 8): { at: string; line: string }[] {
    const since = new Date((this.d.now ? this.d.now() : new Date()).getTime() - days * 86_400_000).toISOString()
    return (this.d.db.prepare('SELECT at, line FROM autopilot_tool_calls WHERE company_id=? AND playbook_id=? AND refused=1 AND line IS NOT NULL AND at>=? ORDER BY rowid DESC LIMIT ?').all(companyId, id, since, limit) as { at: string; line: string }[])
  }

  /**
   * After a run of a playbook (or a follow-up of one): every call refused before it was made (through the gateway),
   * and every outside call its level refuses (an MCP server of the agent's own setup, seen only now), pauses the
   * playbook (never resumed by itself) and comes back with the founder's lines, for the Needs you card. Null = not a
   * playbook run, or nothing refused.
   */
  guardRun(runId: string): { companyId: string; id: PlaybookId; refused: { tool: string; reason: string; line: string }[] } | null {
    const hit = this.forRun(runId)
    if (!hit) return null
    const l = this.live(hit.companyId, hit.id)
    if (!l) return null
    const def = playbookDef(hit.id)
    const rec = { level: l.row.level as PlaybookLevel, raised: !!l.row.raised, limits: this.limitsOf(l.row) }
    const before = (this.d.db.prepare('SELECT name, reason, line FROM autopilot_tool_calls WHERE run_id=? AND refused=1 ORDER BY rowid LIMIT 50').all(runId) as { name: string; reason: string | null; line: string | null }[]).map((r) => ({
      tool: r.name,
      reason: r.reason ?? 'Refused by Principia',
      line: r.line ?? `${def.short} tried ${r.name}; refused.`
    }))
    // calls through the gateway were checked before they happened; the rest (an MCP server of the agent's own setup) now
    const direct = this.toolsOf(runId).filter((t) => guardedTool(t))
    const after = refusedTools(def, rec, direct, this.windowCount(hit.companyId, hit.id, runId))
    try {
      for (const t of direct) {
        const kind = classifyCall(def, { tool: t }).kind
        if (isWrite(kind)) this.record(runId, hit.companyId, hit.id, t, kind, after.some((r) => r.tool === t), after.find((r) => r.tool === t))
      }
    } catch {
      /* the counts are best effort */
    }
    const refused = [...before, ...after]
    if (!refused.length) return null
    this.setPaused(hit.companyId, hit.id, true, `Paused by Principia: ${refused[0]!.line}`)
    return { ...hit, refused }
  }
}
