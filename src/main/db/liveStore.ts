/**
 * Repository for the live agent tables (docs/LIVE.md §2): agents, agent_events, asks.
 * Used by main for session-owned rows and (through engineStore.ts) by the engine for run-owned rows.
 * Synchronous (better-sqlite3), no Electron imports. Every text field is redacted + capped on write.
 */
import type { AdapterId, CompanyFilter, CompanyStamped, ISODate, Id } from '../../shared/types'
import type {
  AgentEvent,
  AgentListQuery,
  AgentNode,
  AgentStatus,
  Ask,
  AskAnswer,
  AskOption,
  ModelUsage
} from '../../shared/live'
import { HiveError } from '../../shared/errors'
import path from 'node:path'
import type { DB } from './index'
import { buildPatch, json, stamp } from './mappers'
import { PERSONAL_COMPANY_ID } from '../../shared/company'

export const LIVE_STATUSES: AgentStatus[] = ['starting', 'working', 'needs_you', 'idle']
export const TERMINAL_STATUSES: AgentStatus[] = ['done', 'failed', 'canceled']
export const EVENTS_PER_AGENT = 500
export const MAX_FILES = 50
const DAY = 86400_000

/**
 * "Files changed" are the repo's files only (LIVE.md §8 result cards): a path outside the agent's cwd (the CLI's own
 * memory under ~/.claude, the run's ARTIFACTS_DIR under /var/folders, …) is dropped. Artifacts count separately.
 * Relative paths are taken as relative to cwd.
 */
export function filesInside(cwd: string | null | undefined, files: readonly string[]): string[] {
  const base = cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : null
  const out: string[] = []
  for (const f of files) {
    if (typeof f !== 'string' || !f.trim() || f === '~' || f.startsWith('~/')) continue
    if (!path.isAbsolute(f)) {
      const n = path.normalize(f)
      if (n === '..' || n.startsWith(`..${path.sep}`)) continue
      if (base && !(path.resolve(base, n) + path.sep).startsWith(base + path.sep)) continue
      out.push(f)
      continue
    }
    if (!base || base === path.sep) continue
    const abs = path.resolve(f)
    if (abs.startsWith(base + path.sep)) out.push(f)
  }
  return out
}

const cap = (s: string | null | undefined, n: number): string | null => (s == null ? null : s.length > n ? s.slice(0, n - 1) + '…' : s)

interface AgentRow {
  id: string
  kind: string
  parent_id: string | null
  root_id: string
  session_id: string | null
  run_id: string | null
  step_id: string | null
  provider: string
  repo_id: string | null
  cwd: string
  title: string
  agent_type: string | null
  external_id: string | null
  tool_use_id: string | null
  model: string | null
  depth: number
  background: number
  attribution: string
  status: string
  needs: string | null
  seen: number
  activity: string | null
  last_tool: string | null
  tool_count: number
  mem_reads: number
  files_json: string
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  model_usage_json: string | null
  report: string | null
  stop_reason?: string | null
  reset_at?: string | null
  retry_at?: string | null
  stalled_since?: string | null
  company_id?: string | null
  started_at: string
  updated_at: string
  ended_at: string | null
}
interface EventRow {
  seq: number
  agent_id: string
  ts: string
  kind: string
  tool_use_id: string | null
  name: string | null
  summary: string
  detail: string | null
  state: string | null
  description?: string | null
}
interface AskRow {
  id: string
  agent_id: string
  root_id: string
  session_id: string | null
  run_id: string | null
  step_id: string | null
  provider: string
  kind: string
  channel: string
  gate_id: string | null
  title: string
  detail: string | null
  tool_name: string | null
  tool_input_json: string | null
  question: string | null
  options_json: string
  status: string
  answer_json: string | null
  answered_via: string | null
  created_at: string
  answered_at: string | null
  expires_at: string | null
  draft_id?: string | null
  slack_draft_id?: string | null
  company_id?: string | null
  task_id?: string | null
}

export const agentFromRow = (r: AgentRow): AgentNode & CompanyStamped => ({
  id: r.id,
  kind: r.kind as AgentNode['kind'],
  parentId: r.parent_id,
  rootId: r.root_id,
  sessionId: r.session_id,
  runId: r.run_id,
  stepId: r.step_id,
  provider: r.provider as AdapterId,
  repoId: r.repo_id,
  cwd: r.cwd,
  title: r.title,
  agentType: r.agent_type,
  externalId: r.external_id,
  toolUseId: r.tool_use_id,
  model: r.model,
  depth: r.depth,
  background: !!r.background,
  attribution: r.attribution as AgentNode['attribution'],
  status: r.status as AgentStatus,
  needs: r.needs as AgentNode['needs'],
  seen: !!r.seen,
  activity: r.activity,
  lastTool: r.last_tool,
  toolCount: r.tool_count,
  memReads: r.mem_reads,
  filesTouched: json<string[]>(r.files_json, []),
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  costUsd: r.cost_usd,
  modelUsage: json<Record<string, ModelUsage> | null>(r.model_usage_json, null),
  report: r.report,
  stopReason: r.stop_reason === 'rate_limited' ? 'rate_limited' : null,
  resetAt: r.reset_at ?? null,
  retryAt: r.retry_at ?? null,
  stalledSince: r.stalled_since ?? null,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  endedAt: r.ended_at,
  companyId: stamp(r.company_id)
})
export const eventFromRow = (r: EventRow): AgentEvent => ({
  seq: r.seq,
  agentId: r.agent_id,
  ts: r.ts,
  kind: r.kind as AgentEvent['kind'],
  toolUseId: r.tool_use_id,
  name: r.name,
  summary: r.summary,
  detail: r.detail,
  state: r.state as AgentEvent['state'],
  ...(r.description ? { description: r.description } : {})
})
export const askFromRow = (r: AskRow): Ask & CompanyStamped => ({
  id: r.id,
  agentId: r.agent_id,
  rootId: r.root_id,
  sessionId: r.session_id,
  runId: r.run_id,
  stepId: r.step_id,
  provider: r.provider as AdapterId,
  // asks.kind/channel CHECKs predate approvals: those are stored as 'question'/'mcp' + draft_id (AUTHORING.md §10)
  // SLACK.md §7.1: 'slack_reply'/'slack' are stored as 'question'/'mcp' + slack_draft_id
  kind: r.draft_id ? 'approval' : r.slack_draft_id ? 'slack_reply' : (r.kind as Ask['kind']),
  channel: r.draft_id ? 'author' : r.slack_draft_id ? 'slack' : (r.channel as Ask['channel']),
  title: r.title,
  detail: r.detail,
  toolName: r.tool_name,
  toolInput: json<unknown>(r.tool_input_json, null),
  question: r.question,
  options: json<AskOption[]>(r.options_json, []),
  status: r.status as Ask['status'],
  answer: json<AskAnswer | null>(r.answer_json, null),
  answeredVia: r.answered_via as Ask['answeredVia'],
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  expiresAt: r.expires_at,
  ...(r.draft_id ? { draftId: r.draft_id } : {}),
  ...(r.slack_draft_id ? { slackDraftId: r.slack_draft_id } : {}),
  companyId: stamp(r.company_id),
  // DEPARTMENTS.md §5: a live ask raised during a task run or task session shows on the task's card
  ...(r.task_id ? { taskId: r.task_id } : {})
})

const AGENT_COLS: Record<string, { col: string; kind?: 'json' | 'bool' }> = {
  kind: { col: 'kind' },
  parentId: { col: 'parent_id' },
  rootId: { col: 'root_id' },
  sessionId: { col: 'session_id' },
  runId: { col: 'run_id' },
  stepId: { col: 'step_id' },
  provider: { col: 'provider' },
  repoId: { col: 'repo_id' },
  cwd: { col: 'cwd' },
  title: { col: 'title' },
  agentType: { col: 'agent_type' },
  externalId: { col: 'external_id' },
  toolUseId: { col: 'tool_use_id' },
  model: { col: 'model' },
  depth: { col: 'depth' },
  background: { col: 'background', kind: 'bool' },
  attribution: { col: 'attribution' },
  status: { col: 'status' },
  needs: { col: 'needs' },
  seen: { col: 'seen', kind: 'bool' },
  activity: { col: 'activity' },
  lastTool: { col: 'last_tool' },
  toolCount: { col: 'tool_count' },
  memReads: { col: 'mem_reads' },
  filesTouched: { col: 'files_json', kind: 'json' },
  tokensIn: { col: 'tokens_in' },
  tokensOut: { col: 'tokens_out' },
  costUsd: { col: 'cost_usd' },
  modelUsage: { col: 'model_usage_json', kind: 'json' },
  report: { col: 'report' },
  stopReason: { col: 'stop_reason' },
  resetAt: { col: 'reset_at' },
  retryAt: { col: 'retry_at' },
  stalledSince: { col: 'stalled_since' },
  startedAt: { col: 'started_at' },
  updatedAt: { col: 'updated_at' },
  endedAt: { col: 'ended_at' }
}
const ASK_COLS: Record<string, { col: string; kind?: 'json' | 'bool' }> = {
  title: { col: 'title' },
  detail: { col: 'detail' },
  status: { col: 'status' },
  answer: { col: 'answer_json', kind: 'json' },
  answeredVia: { col: 'answered_via' },
  answeredAt: { col: 'answered_at' },
  expiresAt: { col: 'expires_at' },
  options: { col: 'options_json', kind: 'json' },
  gateId: { col: 'gate_id' }
}

export interface OpenAskQuery {
  runId?: Id
  stepId?: Id
  sessionId?: Id
  rootId?: Id
}

export class LiveStore {
  constructor(
    readonly db: DB,
    private redact: (s: string) => string = (s) => s,
    private now: () => Date = () => new Date()
  ) {}

  /** asks.task_id is healed by openDatabase (DEPARTMENTS.md §1.2); a bare test db may lack it. */
  private askTaskCol: boolean | null = null
  private hasAskTask(): boolean {
    this.askTaskCol ??= (this.db.prepare('PRAGMA table_info(asks)').all() as { name: string }[]).some((c) => c.name === 'task_id')
    return this.askTaskCol
  }

  private ts(): ISODate {
    return this.now().toISOString()
  }
  private red(s: string | null | undefined, n: number): string | null {
    return s == null ? null : cap(this.redact(s), n)
  }
  /** Redacts + caps the text fields of an agent patch. */
  private cleanAgent<T extends Partial<AgentNode>>(a: T, cwd: string | null | undefined): T {
    const o: Partial<AgentNode> = { ...a }
    if (o.title !== undefined) o.title = this.red(o.title, 200) ?? ''
    if (o.activity !== undefined) o.activity = this.red(o.activity, 120)
    if (o.lastTool !== undefined) o.lastTool = this.red(o.lastTool, 200)
    if (o.report !== undefined) o.report = this.red(o.report, 8192)
    if (o.filesTouched !== undefined) o.filesTouched = [...new Set(filesInside(cwd, o.filesTouched))].slice(0, MAX_FILES)
    return o as T
  }

  // ---------- agents ----------
  /** COMPANY.md §3: explicit companyId, else subagents inherit their root's; roots take their session's or run's. */
  insertAgent(a: AgentNode & CompanyStamped): AgentNode & CompanyStamped {
    const c = this.cleanAgent(a, a.cwd)
    this.db
      .prepare(
        `INSERT INTO agents(id, kind, parent_id, root_id, session_id, run_id, step_id, provider, repo_id, cwd, title, agent_type,
          external_id, tool_use_id, model, depth, background, attribution, status, needs, seen, activity, last_tool, tool_count,
          mem_reads, files_json, tokens_in, tokens_out, cost_usd, model_usage_json, report, started_at, updated_at, ended_at, company_id)
         VALUES (@id, @kind, @parentId, @rootId, @sessionId, @runId, @stepId, @provider, @repoId, @cwd, @title, @agentType,
          @externalId, @toolUseId, @model, @depth, @background, @attribution, @status, @needs, @seen, @activity, @lastTool,
          @toolCount, @memReads, @files, @tokensIn, @tokensOut, @costUsd, @modelUsage, @report, @startedAt, @updatedAt, @endedAt,
          COALESCE(@companyId, (SELECT r.company_id FROM agents r WHERE r.id = @rootId AND r.id <> @id),
            (SELECT company_id FROM sessions WHERE id = @sessionId), (SELECT company_id FROM runs WHERE id = @runId), '${PERSONAL_COMPANY_ID}'))`
      )
      .run({
        ...c,
        background: c.background ? 1 : 0,
        seen: c.seen ? 1 : 0,
        files: JSON.stringify(c.filesTouched ?? []),
        modelUsage: c.modelUsage ? JSON.stringify(c.modelUsage) : null,
        companyId: a.companyId ?? null
      })
    return this.getAgent(a.id)!
  }

  updateAgent(id: Id, patch: Partial<Omit<AgentNode, 'id'>>): AgentNode {
    const cur = this.getAgent(id)
    if (!cur) throw new HiveError('not_found', `agent ${id} not found`)
    // Terminal statuses are final (LIVE.md §1.2): late events never reopen a node.
    let p = this.cleanAgent(patch, patch.cwd ?? cur.cwd)
    if (TERMINAL_STATUSES.includes(cur.status) && p.status && !TERMINAL_STATUSES.includes(p.status)) {
      const { status: _s, needs: _n, ...rest } = p
      void _s
      void _n
      p = rest
    }
    const { set, params } = buildPatch({ updatedAt: this.ts(), ...p } as Record<string, unknown>, AGENT_COLS)
    if (set) this.db.prepare(`UPDATE agents SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
    return this.getAgent(id)!
  }

  getAgent(id: Id): (AgentNode & CompanyStamped) | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return r ? agentFromRow(r) : null
  }
  rootOfSession(sessionId: Id): AgentNode | null {
    const r = this.db
      .prepare("SELECT * FROM agents WHERE session_id = ? AND kind = 'session' ORDER BY started_at DESC LIMIT 1")
      .get(sessionId) as AgentRow | undefined
    return r ? agentFromRow(r) : null
  }
  rootOfStep(stepId: Id): AgentNode | null {
    const r = this.db
      .prepare("SELECT * FROM agents WHERE step_id = ? AND kind = 'step' ORDER BY started_at DESC LIMIT 1")
      .get(stepId) as AgentRow | undefined
    return r ? agentFromRow(r) : null
  }
  /** Every agent of a root's tree, root first, then by start time. */
  tree(rootId: Id): AgentNode[] {
    return (
      this.db.prepare('SELECT * FROM agents WHERE root_id = ? ORDER BY depth, started_at').all(rootId) as AgentRow[]
    ).map(agentFromRow)
  }
  /** Descendants of any node (not including it). */
  descendants(id: Id): AgentNode[] {
    const a = this.getAgent(id)
    if (!a) return []
    const all = this.tree(a.rootId)
    const out: AgentNode[] = []
    const want = new Set([id])
    for (const n of all) {
      if (n.parentId && want.has(n.parentId)) {
        out.push(n)
        want.add(n.id)
      }
    }
    return out
  }

  listAgents(q: AgentListQuery & CompanyFilter = {}): (AgentNode & CompanyStamped)[] {
    const where: string[] = []
    const params: unknown[] = []
    const statusPart: string[] = []
    if (q.companyId) {
      where.push(`COALESCE(company_id, '${PERSONAL_COMPANY_ID}') = ?`)
      params.push(q.companyId)
    }
    if (q.status?.length) {
      statusPart.push(`status IN (${q.status.map(() => '?').join(',')})`)
      params.push(...q.status)
    }
    if (q.since) {
      statusPart.push('(ended_at IS NOT NULL AND ended_at >= ?)')
      params.push(q.since)
    }
    if (statusPart.length) where.push(`(${statusPart.join(' OR ')})`)
    if (q.runId) {
      where.push('run_id = ?')
      params.push(q.runId)
    }
    if (q.sessionId) {
      where.push('session_id = ?')
      params.push(q.sessionId)
    }
    if (q.rootsOnly) where.push('parent_id IS NULL')
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000)
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${limit}`
    return (this.db.prepare(sql).all(...params) as AgentRow[]).map(agentFromRow)
  }

  /** Live roots and all their descendants (<= limit rows). */
  liveTrees(limit = 400): AgentNode[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM agents WHERE root_id IN (SELECT id FROM agents WHERE parent_id IS NULL AND status IN ('starting','working','needs_you','idle'))
           ORDER BY root_id, depth, started_at LIMIT ?`
        )
        .all(limit) as AgentRow[]
    ).map(agentFromRow)
  }
  /** Trees of the given runs/sessions (roots + subagents), capped. */
  treesFor(q: { runIds: Id[]; sessionIds: Id[] }, limit = 400): AgentNode[] {
    const parts: string[] = []
    const params: unknown[] = []
    if (q.runIds.length) {
      parts.push(`run_id IN (${q.runIds.map(() => '?').join(',')})`)
      params.push(...q.runIds)
    }
    if (q.sessionIds.length) {
      parts.push(`session_id IN (${q.sessionIds.map(() => '?').join(',')})`)
      params.push(...q.sessionIds)
    }
    if (!parts.length) return []
    return (
      this.db
        .prepare(`SELECT * FROM agents WHERE ${parts.join(' OR ')} ORDER BY started_at DESC LIMIT ?`)
        .all(...params, limit) as AgentRow[]
    ).map(agentFromRow)
  }

  /** Sum of mem_reads over every agent of a step's or session's trees (memory chip "n read"). */
  memReads(q: { stepId?: Id; sessionId?: Id }): number {
    if (q.stepId)
      return (this.db.prepare('SELECT COALESCE(SUM(mem_reads), 0) AS n FROM agents WHERE step_id = ?').get(q.stepId) as { n: number }).n
    if (q.sessionId)
      return (this.db.prepare('SELECT COALESCE(SUM(mem_reads), 0) AS n FROM agents WHERE session_id = ?').get(q.sessionId) as { n: number }).n
    return 0
  }

  // ---------- events ----------
  appendAgentEvents(agentId: Id, events: Omit<AgentEvent, 'seq' | 'agentId'>[]): AgentEvent[] {
    if (!events.length) return []
    const ins = this.db.prepare(
      `INSERT INTO agent_events(agent_id, ts, kind, tool_use_id, name, summary, detail, state${this.eventDescription() ? ', description' : ''}) VALUES (?,?,?,?,?,?,?,?${this.eventDescription() ? ',?' : ''})`
    )
    const seqs: number[] = []
    this.db.transaction(() => {
      for (const e of events) {
        const r = ins.run(
          agentId,
          e.ts || this.ts(),
          e.kind,
          e.toolUseId ?? null,
          this.red(e.name, 200),
          this.red(e.summary, 200) ?? '',
          this.red(e.detail, 4096),
          e.state ?? null,
          ...(this.eventDescription() ? [this.red(e.description ?? null, 200)] : [])
        )
        seqs.push(Number(r.lastInsertRowid))
      }
      this.enforceCap(agentId)
    })()
    return this.eventsBySeq(seqs)
  }

  private descCol: boolean | undefined
  /** agent_events.description exists (healed in by migrate; an older test db may lack it) */
  private eventDescription(): boolean {
    if (this.descCol === undefined) this.descCol = (this.db.prepare('PRAGMA table_info(agent_events)').all() as { name: string }[]).some((c) => c.name === 'description')
    return this.descCol
  }

  private enforceCap(agentId: Id): void {
    const n = (this.db.prepare('SELECT count(*) AS n FROM agent_events WHERE agent_id = ?').get(agentId) as { n: number }).n
    if (n <= EVENTS_PER_AGENT) return
    this.db
      .prepare(
        `DELETE FROM agent_events WHERE seq IN (SELECT seq FROM agent_events WHERE agent_id = ? AND kind NOT IN ('ask','answer')
         ORDER BY seq LIMIT ?)`
      )
      .run(agentId, n - EVENTS_PER_AGENT)
  }

  private eventsBySeq(seqs: number[]): AgentEvent[] {
    if (!seqs.length) return []
    return (
      this.db.prepare(`SELECT * FROM agent_events WHERE seq IN (${seqs.map(() => '?').join(',')}) ORDER BY seq`).all(...seqs) as EventRow[]
    ).map(eventFromRow)
  }

  /** Updates the newest event of that tool call (tool result for a running tool). */
  updateAgentEvent(agentId: Id, toolUseId: string, patch: Pick<AgentEvent, 'state' | 'detail'>): AgentEvent | null {
    const r = this.db
      .prepare("SELECT seq FROM agent_events WHERE agent_id = ? AND tool_use_id = ? AND kind = 'tool' ORDER BY seq DESC LIMIT 1")
      .get(agentId, toolUseId) as { seq: number } | undefined
    if (!r) return null
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.state !== undefined) {
      sets.push('state = ?')
      params.push(patch.state)
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?')
      params.push(this.red(patch.detail, 4096))
    }
    if (sets.length) this.db.prepare(`UPDATE agent_events SET ${sets.join(', ')} WHERE seq = ?`).run(...params, r.seq)
    return this.eventsBySeq([r.seq])[0] ?? null
  }

  hasToolEvent(agentId: Id, toolUseId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM agent_events WHERE agent_id = ? AND tool_use_id = ? AND kind = 'tool'").get(agentId, toolUseId)
  }

  listEvents(agentId: Id, opts: { beforeSeq?: number; limit?: number } = {}): AgentEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
    const rows = (
      opts.beforeSeq
        ? this.db.prepare('SELECT * FROM agent_events WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(agentId, opts.beforeSeq, limit)
        : this.db.prepare('SELECT * FROM agent_events WHERE agent_id = ? ORDER BY seq DESC LIMIT ?').all(agentId, limit)
    ) as EventRow[]
    return rows.reverse().map(eventFromRow)
  }

  // ---------- asks ----------
  /**
   * COMPANY.md §3: denormalized for badges, from the agent (else its run or session). DEPARTMENTS.md §5: asks.task_id
   * from the ask itself, else its run's runs.task_id, else its session's sessions.task_id.
   */
  insertAsk(a: Ask & CompanyStamped & { gateId?: string | null; taskId?: Id | null }): Ask & CompanyStamped {
    this.db
      .prepare(
        `INSERT INTO asks(id, agent_id, root_id, session_id, run_id, step_id, provider, kind, channel, gate_id, title, detail,
          tool_name, tool_input_json, question, options_json, status, answer_json, answered_via, created_at, answered_at, expires_at, draft_id, slack_draft_id,
          company_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
          COALESCE(?, (SELECT company_id FROM agents WHERE id = ?), (SELECT company_id FROM runs WHERE id = ?), (SELECT company_id FROM sessions WHERE id = ?), '${PERSONAL_COMPANY_ID}'))`
      )
      .run(
        a.id,
        a.agentId,
        a.rootId,
        a.sessionId,
        a.runId,
        a.stepId,
        a.provider,
        a.kind === 'approval' || a.kind === 'slack_reply' ? 'question' : a.kind,
        a.channel === 'author' || a.channel === 'slack' ? 'mcp' : a.channel,
        a.gateId ?? null,
        this.red(a.title, 300) ?? '',
        this.red(a.detail, 300),
        a.toolName,
        a.toolInput == null ? null : cap(this.redact(JSON.stringify(a.toolInput)), 4096),
        this.red(a.question, 2000),
        JSON.stringify(a.options ?? []),
        a.status,
        a.answer ? JSON.stringify(a.answer) : null,
        a.answeredVia,
        a.createdAt,
        a.answeredAt,
        a.expiresAt,
        a.draftId ?? null,
        a.slackDraftId ?? null,
        a.companyId ?? null,
        a.agentId,
        a.runId,
        a.sessionId
      )
    if (this.hasAskTask())
      this.db
        .prepare('UPDATE asks SET task_id = COALESCE(?, (SELECT task_id FROM runs WHERE id = ?), (SELECT task_id FROM sessions WHERE id = ?)) WHERE id = ?')
        .run(a.taskId ?? null, a.runId, a.sessionId, a.id)
    return this.getAsk(a.id)!
  }

  updateAsk(id: Id, patch: Partial<Omit<Ask, 'id'>> & { gateId?: string | null }): Ask {
    const p: Record<string, unknown> = { ...patch }
    if (patch.answer) {
      p.answer = {
        ...patch.answer,
        ...(patch.answer.text != null ? { text: this.redact(patch.answer.text) } : {}),
        ...(patch.answer.message != null ? { message: this.redact(patch.answer.message) } : {})
      }
    }
    const { set, params } = buildPatch(p, ASK_COLS)
    if (set) this.db.prepare(`UPDATE asks SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
    const a = this.getAsk(id)
    if (!a) throw new HiveError('not_found', `ask ${id} not found`)
    return a
  }

  getAsk(id: Id): (Ask & CompanyStamped) | null {
    const r = this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as AskRow | undefined
    return r ? askFromRow(r) : null
  }
  gateIdOf(id: Id): string | null {
    return (this.db.prepare('SELECT gate_id FROM asks WHERE id = ?').get(id) as { gate_id: string | null } | undefined)?.gate_id ?? null
  }
  askByGate(gateId: string): Ask | null {
    const r = this.db.prepare('SELECT * FROM asks WHERE gate_id = ? ORDER BY created_at DESC LIMIT 1').get(gateId) as AskRow | undefined
    return r ? askFromRow(r) : null
  }

  listOpenAsks(q: OpenAskQuery = {}): Ask[] {
    const where = ["status = 'open'"]
    const params: unknown[] = []
    for (const [k, col] of [
      ['runId', 'run_id'],
      ['stepId', 'step_id'],
      ['sessionId', 'session_id'],
      ['rootId', 'root_id']
    ] as const) {
      if (q[k]) {
        where.push(`${col} = ?`)
        params.push(q[k])
      }
    }
    return (this.db.prepare(`SELECT * FROM asks WHERE ${where.join(' AND ')} ORDER BY created_at`).all(...params) as AskRow[]).map(askFromRow)
  }

  listAsks(q: { status?: 'open' | 'all'; runId?: Id; sessionId?: Id; limit?: number; companyId?: Id } = {}): (Ask & CompanyStamped)[] {
    const where: string[] = []
    const params: unknown[] = []
    if ((q.status ?? 'open') === 'open') where.push("status = 'open'")
    if (q.companyId) {
      where.push(`COALESCE(company_id, '${PERSONAL_COMPANY_ID}') = ?`)
      params.push(q.companyId)
    }
    if (q.runId) {
      where.push('run_id = ?')
      params.push(q.runId)
    }
    if (q.sessionId) {
      where.push('session_id = ?')
      params.push(q.sessionId)
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000)
    const open = (q.status ?? 'open') === 'open'
    const sql = `SELECT * FROM asks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ${open ? 'ASC' : 'DESC'} LIMIT ${limit}`
    return (this.db.prepare(sql).all(...params) as AskRow[]).map(askFromRow)
  }

  /** A3: live session roots waiting for the user whose pane has not been seen. */
  unseenIdleRoots(): AgentNode[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM agents WHERE parent_id IS NULL AND kind = 'session' AND needs = 'idle' AND seen = 0
           AND status IN ('starting','working','needs_you','idle') ORDER BY updated_at`
        )
        .all() as AgentRow[]
    ).map(agentFromRow)
  }

  /** StatusSnapshot.needsYou (LIVE.md §4.5): open asks + unseen idle live session roots. */
  needsYouCount(): number {
    return this.openAskCount() + this.unseenIdleRoots().length
  }

  /** Every ask (any status) of a root's tree, newest first. */
  asksForRoot(rootId: Id, limit = 200): Ask[] {
    return (
      this.db.prepare('SELECT * FROM asks WHERE root_id = ? ORDER BY created_at DESC LIMIT ?').all(rootId, Math.min(Math.max(limit, 1), 1000)) as AskRow[]
    ).map(askFromRow)
  }

  openAskCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM asks WHERE status = 'open'").get() as { n: number }).n
  }

  /** A4(a): close every open ask of a root's tree. Returns the updated asks. */
  cancelOpenAsksForRoot(rootId: Id, via: Ask['answeredVia'] = null): Ask[] {
    // approval and Slack draft asks outlive their owner (AUTHORING.md §2.1, SLACK.md §8.3)
    const open = this.listOpenAsks({ rootId }).filter((a) => a.kind !== 'approval' && a.kind !== 'slack_reply')
    const at = this.ts()
    return open.map((a) => this.updateAsk(a.id, { status: 'canceled', answeredVia: via, answeredAt: at }))
  }

  // ---------- boot + retention ----------
  /** Boot recovery (LIVE.md §1.2): live agents -> failed "Hive quit"; open asks -> canceled. */
  bootRecover(): { agents: number; asks: number } {
    const at = this.ts()
    return this.db.transaction(() => {
      const asks = this.db
        // approval asks stay open: their draft survives restarts (AUTHORING.md §2.1, §10)
        .prepare("UPDATE asks SET status = 'canceled', answered_at = ? WHERE status = 'open' AND draft_id IS NULL AND slack_draft_id IS NULL")
        .run(at).changes
      const agents = this.db
        .prepare(
          `UPDATE agents SET status = 'failed', needs = NULL, activity = 'Hive quit', ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE status IN ('starting','working','needs_you','idle')`
        )
        .run(at, at).changes
      // CONTRACT §13: nothing is stalled after a restart, and a session's pending resume died with its pane
      this.db.prepare('UPDATE agents SET stalled_since = NULL WHERE stalled_since IS NOT NULL').run()
      this.db.prepare("UPDATE agents SET retry_at = NULL WHERE kind = 'session' AND retry_at IS NOT NULL").run()
      return { agents, asks }
    })()
  }

  /** Events of agents ended > 30 days ago; agent rows (and their asks) ended > 90 days ago; orphan session trees. */
  retention(): { events: number; agents: number } {
    const nowMs = this.now().getTime()
    const d30 = new Date(nowMs - 30 * DAY).toISOString()
    const d90 = new Date(nowMs - 90 * DAY).toISOString()
    return this.db.transaction(() => {
      const events = this.db
        .prepare('DELETE FROM agent_events WHERE agent_id IN (SELECT id FROM agents WHERE ended_at IS NOT NULL AND ended_at < ?)')
        .run(d30).changes
      const agents = this.db
        .prepare(
          `DELETE FROM agents WHERE root_id IN (SELECT id FROM agents WHERE parent_id IS NULL AND ended_at IS NOT NULL AND ended_at < ?)
           OR (kind = 'session' AND session_id NOT IN (SELECT id FROM sessions) AND ended_at IS NOT NULL)`
        )
        .run(d90).changes
      this.db.prepare('DELETE FROM asks WHERE agent_id NOT IN (SELECT id FROM agents)').run()
      return { events, agents }
    })()
  }

  /** Drops the agent trees of deleted sessions (sessions.pruneOld / sessions:remove). */
  deleteSessionTrees(sessionId: Id): void {
    this.db.prepare('DELETE FROM agents WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM asks WHERE session_id = ?').run(sessionId)
  }
}
