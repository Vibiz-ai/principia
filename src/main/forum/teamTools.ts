/**
 * AGENT-COLLAB.md §3: shared situational awareness for agents. Three read-only Forum tools, served to every seat step
 * with the rest of the Forum protocol (MCP, CLI, HTTP):
 *
 * - team_activity: recent runs of the caller's company (who, what, status, duration, cost, a short redacted summary);
 * - team_usage: tokens and dollars by agent, department and model over the last days (reported cost first, else an
 *   estimate from pricing.ts, marked "~"), plus the agent-conversation counters against their caps;
 * - team_board: the company board (open tasks by default) with assignee and block reason.
 *
 * Scoped to the caller's company (resolved from the step token, never from arguments). Outputs are compact text,
 * clipped, redacted through the vault and a secret-shape scrubber: no env, no prompts, no raw logs.
 */
import type Database from 'better-sqlite3'
import type { ForumStore, ForumDirectory } from './store'
import { costOf, fmtUsd, PRICE_SOURCE } from './pricing'
import { stepSummary } from './summary'

export interface TeamTask { identifier: string; title: string; status: string; blockReason: string | null; agentId: string | null; departmentId: string | null; priority: number; updatedAt: string }

export interface TeamDeps {
  db: Database.Database
  store: () => ForumStore
  directory: ForumDirectory
  /** CompanyStore.listTasks(companyId); absent = no board */
  board?: (companyId: string) => TeamTask[]
  companyName?: (companyId: string) => string
  redact?: (s: string) => string
  /** agent conversation counters (collab.ts) */
  collabUsage?: (companyId: string) => { wakesToday: number; capPerDay: number; refusedToday: number } | null
  now?: () => Date
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const HOUR = 3_600_000

/** Secret shapes a vault redaction can miss (keys pasted into output, bearer headers). */
const SECRET_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(Bearer|token|apikey|api_key|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}["']?/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
]
export function scrubSecrets(s: string): string {
  let out = s
  for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]')
  return out
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
function fmtDur(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface RunRow { id: string; title: string; status: string; trigger: string; agent_id: string | null; task_id: string | null; created_at: string; started_at: string | null; ended_at: string | null; outcome: string | null; reason: string | null; kind: string }
interface RootRow { run_id: string | null; model: string | null; provider: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; model_usage_json: string | null; agent_id: string | null }

export class TeamTools {
  constructor(private readonly d: TeamDeps) {}
  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  private clean(s: string): string {
    const r = this.d.redact ? this.d.redact(s) : s
    return scrubSecrets(r)
  }

  /** "@marcus (Copywriter, Marketing)" for an agent seat, or null. */
  private seat(companyId: string, agentId: string | null): { label: string; departmentId: string | null; handle: string | null } | null {
    if (!agentId) return null
    const a = this.d.directory.agents(companyId).find((x) => x.id === agentId)
    if (!a) return null
    const dep = a.departmentId ? this.d.directory.departments(companyId).find((x) => x.id === a.departmentId) : null
    const m = this.d.store().memberForAgent(agentId)
    const who = m ? `@${m.handle}` : (a.personaName ?? a.name)
    return { label: `${who} (${a.name}${dep ? `, ${dep.name}` : ''})`, departmentId: a.departmentId, handle: m?.handle ?? null }
  }

  /** `@handle` or a department key → the agent ids it covers; null = everyone. Throws a refusal line. */
  private who(companyId: string, raw: string | undefined): { agentIds: Set<string>; label: string } | null {
    if (!raw) return null
    const h = raw.trim().replace(/^[@#]/, '').toLowerCase()
    const m = this.d.store().memberByHandle(companyId, h)
    if (m?.agentId) return { agentIds: new Set([m.agentId]), label: `@${m.handle}` }
    const dep = this.d.directory.departments(companyId).find((x) => x.key === h || x.name.toLowerCase() === h)
    if (dep) return { agentIds: new Set(this.d.directory.agents(companyId).filter((a) => a.departmentId === dep.id).map((a) => a.id)), label: dep.name }
    throw new Error(`No agent or department ${raw}`)
  }

  private roots(where: string, args: unknown[]): RootRow[] {
    try {
      return this.d.db
        .prepare(`SELECT a.run_id, a.model, a.provider, a.tokens_in, a.tokens_out, a.cost_usd, a.model_usage_json, r.agent_id FROM agents a LEFT JOIN runs r ON r.id = a.run_id WHERE a.parent_id IS NULL AND ${where}`)
        .all(...args) as RootRow[]
    } catch {
      return [] // no live-agents table (tests, a fresh db)
    }
  }

  /** Cost of a set of runs (reply runs of a conversation, one run). */
  runCost(runIds: string[]): { usd: number | null; estimated: boolean; tokens: number | null } {
    if (!runIds.length) return { usd: null, estimated: false, tokens: null }
    const rows = this.roots(`a.run_id IN (${runIds.map(() => '?').join(',')})`, runIds)
    let usd: number | null = null
    let estimated = false
    let tokens: number | null = null
    for (const r of rows) {
      const c = costOf({ model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd })
      if (c.usd != null) usd = (usd ?? 0) + c.usd
      if (c.estimated) estimated = true
      if (r.tokens_in != null || r.tokens_out != null) tokens = (tokens ?? 0) + (r.tokens_in ?? 0) + (r.tokens_out ?? 0)
    }
    return { usd, estimated, tokens }
  }

  activity(companyId: string, a: { who?: string; hours?: number; limit?: number; status?: string }, selfRunId: string | null = null): string {
    const hours = Math.min(168, Math.max(1, a.hours ?? 24))
    const limit = Math.min(20, Math.max(1, a.limit ?? 8))
    const since = new Date(this.now().getTime() - hours * HOUR).toISOString()
    const filter = this.who(companyId, a.who)
    let rows: RunRow[]
    try {
      rows = this.d.db
        .prepare(`SELECT id, title, status, trigger, agent_id, task_id, created_at, started_at, ended_at, outcome, reason, kind FROM runs WHERE COALESCE(company_id, 'co_personal') = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 400`)
        .all(companyId, since) as RunRow[]
    } catch {
      rows = []
    }
    if (filter) rows = rows.filter((r) => r.agent_id && filter.agentIds.has(r.agent_id))
    if (a.status) rows = rows.filter((r) => r.status === a.status)
    const total = rows.length
    rows = rows.slice(0, limit)
    const head = `team activity · last ${hours}h${filter ? ` · ${filter.label}` : ''} · ${total} run${total === 1 ? '' : 's'}${total > rows.length ? ` (newest ${rows.length})` : ''}`
    if (!rows.length) return `${head}\nno runs`
    const lines = [head]
    for (const r of rows) {
      const seat = this.seat(companyId, r.agent_id)
      const who = seat?.label ?? (r.trigger === 'schedule' || r.trigger === 'catchup' ? 'schedule' : r.kind === 'workflow' ? 'workflow' : 'run')
      const task = r.task_id ? this.taskIdent(r.task_id) : null
      const dur = r.started_at ? fmtDur((r.ended_at ? Date.parse(r.ended_at) : this.now().getTime()) - Date.parse(r.started_at)) : ''
      const cost = this.runCost([r.id])
      const status = r.outcome === 'nothing_to_do' ? 'nothing to do' : r.status
      const meta = [status, dur, cost.usd != null ? fmtUsd(cost.usd, cost.estimated) : null].filter(Boolean).join(' ')
      const title = clip(flat(this.clean(r.title)), 80)
      lines.push(`- ${r.id}${r.id === selfRunId ? ' (you, now)' : ''} ${hhmm(r.created_at)} ${who} ${meta}${task ? ` · ${task}` : ''} · "${title}"`)
      const summary = this.summaryOf(r)
      if (summary) lines.push(`  ${summary}`)
    }
    lines.push('Summaries are redacted and clipped; open a run in Principia for its full log.')
    return clip(lines.join('\n'), 6000)
  }

  private taskIdent(taskId: string): string | null {
    try {
      const row = this.d.db.prepare("SELECT json_extract(data,'$.identifier') AS ident FROM company_tasks WHERE id=?").get(taskId) as { ident: string | null } | undefined
      return row?.ident ?? null
    } catch {
      return null
    }
  }

  private summaryOf(r: RunRow): string | null {
    if (r.status === 'failed' && r.reason) return `failed: ${clip(flat(this.clean(r.reason)), 200)}`
    try {
      const s = this.d.db.prepare("SELECT output, error FROM run_steps WHERE run_id=? AND status IN ('passed','failed') ORDER BY seq DESC LIMIT 1").get(r.id) as { output: string | null; error: string | null } | undefined
      const text = s?.output ? stepSummary(s.output, 400) : s?.error ?? ''
      const out = clip(flat(this.clean(text)), 220)
      return out ? `↳ ${out}` : null
    } catch {
      return null
    }
  }

  usage(companyId: string, a: { days?: number; who?: string }): string {
    const days = Math.min(30, Math.max(1, a.days ?? 7))
    const since = new Date(this.now().getTime() - days * 24 * HOUR).toISOString()
    const filter = this.who(companyId, a.who)
    let rows = this.roots("a.started_at >= ? AND COALESCE(a.company_id, 'co_personal') = ?", [since, companyId])
    if (filter) rows = rows.filter((r) => r.agent_id && filter.agentIds.has(r.agent_id))
    type Acc = { runs: Set<string>; tokens: number; usd: number | null; est: boolean }
    const acc = (): Acc => ({ runs: new Set(), tokens: 0, usd: null, est: false })
    const add = (x: Acc, runId: string | null, tokens: number, usd: number | null, est: boolean) => {
      if (runId) x.runs.add(runId)
      x.tokens += tokens
      if (usd != null) x.usd = (x.usd ?? 0) + usd
      if (est) x.est = true
    }
    const total = acc()
    const byAgent = new Map<string, Acc>()
    const byDep = new Map<string, Acc>()
    const byModel = new Map<string, Acc>()
    for (const r of rows) {
      const tokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0)
      const c = costOf({ model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd })
      add(total, r.run_id, tokens, c.usd, c.estimated)
      const seat = this.seat(companyId, r.agent_id)
      const agentKey = seat?.label ?? 'workflows and chats (no seat)'
      add(byAgent.get(agentKey) ?? byAgent.set(agentKey, acc()).get(agentKey)!, r.run_id, tokens, c.usd, c.estimated)
      const depName = seat?.departmentId ? (this.d.directory.departments(companyId).find((x) => x.id === seat.departmentId)?.name ?? 'Company') : seat ? 'Company' : 'no department'
      add(byDep.get(depName) ?? byDep.set(depName, acc()).get(depName)!, r.run_id, tokens, c.usd, c.estimated)
      // per model: the CLI's split when it reported one, else the root's model
      type Split = Record<string, { tokensIn?: number; tokensOut?: number; costUsd?: number | null }>
      let split: Split | null = null
      try {
        split = r.model_usage_json ? (JSON.parse(r.model_usage_json) as Split) : null
      } catch {
        split = null
      }
      const entries = split ? Object.entries(split) : []
      if (entries.length) {
        for (const [model, u] of entries) {
          const mc = costOf({ model, tokensIn: u.tokensIn ?? 0, tokensOut: u.tokensOut ?? 0, costUsd: u.costUsd ?? null })
          add(byModel.get(model) ?? byModel.set(model, acc()).get(model)!, r.run_id, (u.tokensIn ?? 0) + (u.tokensOut ?? 0), mc.usd, mc.estimated)
        }
      } else {
        const model = r.model ?? `${r.provider} (model not reported)`
        add(byModel.get(model) ?? byModel.set(model, acc()).get(model)!, r.run_id, tokens, c.usd, c.estimated)
      }
    }
    const company = this.d.companyName?.(companyId)
    const line = (x: Acc) => `${x.runs.size} run${x.runs.size === 1 ? '' : 's'} ${fmtTokens(x.tokens)} tok ${fmtUsd(x.usd, x.est)}`
    const top = (m: Map<string, Acc>, n: number) =>
      [...m.entries()]
        .sort((p, q) => (q[1].usd ?? 0) - (p[1].usd ?? 0) || q[1].tokens - p[1].tokens)
        .slice(0, n)
        .map(([k, v]) => `${k} ${line(v)}`)
        .join(' · ')
    const out = [`team usage · last ${days} day${days === 1 ? '' : 's'}${company ? ` · ${company}` : ''}${filter ? ` · ${filter.label}` : ''} · ${line(total)}`]
    if (!rows.length) out.push('no usage recorded')
    else {
      out.push(`by agent: ${top(byAgent, 8)}`)
      out.push(`by department: ${top(byDep, 8)}`)
      out.push(`by model: ${top(byModel, 6)}`)
    }
    const today = new Date(this.now().getTime() - 24 * HOUR).toISOString()
    const day = this.roots("a.started_at >= ? AND COALESCE(a.company_id, 'co_personal') = ?", [today, companyId]).reduce((s, r) => s + (costOf({ model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd }).usd ?? 0), 0)
    out.push(`last 24h: ${fmtUsd(day, false)} across the company`)
    const cu = this.d.collabUsage?.(companyId)
    if (cu) out.push(`agent conversations (24h): ${cu.wakesToday} of ${cu.capPerDay} wakes used${cu.refusedToday ? `, ${cu.refusedToday} refused by the guards` : ''}`)
    out.push(`$ = the CLI's reported cost; ~$ = estimated from ${PRICE_SOURCE}; $? = tokens only (no price for that model). Subscription plans bill the plan, not these rates.`)
    return clip(out.join('\n'), 4000)
  }

  board(companyId: string, a: { status?: string; who?: string; limit?: number; all?: boolean }): string {
    if (!this.d.board) return 'The board is not available in this Principia'
    const limit = Math.min(40, Math.max(1, a.limit ?? 20))
    const filter = this.who(companyId, a.who)
    let tasks = this.d.board(companyId)
    if (a.status) tasks = tasks.filter((t) => t.status === a.status)
    else if (!a.all) tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled')
    if (filter) tasks = tasks.filter((t) => t.agentId && filter.agentIds.has(t.agentId))
    const counts = new Map<string, number>()
    for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
    const order = ['in_progress', 'blocked', 'in_review', 'todo', 'triage', 'backlog', 'done', 'canceled']
    tasks = [...tasks].sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status) || y.priority - x.priority || (x.updatedAt < y.updatedAt ? 1 : -1))
    const head = `team board${filter ? ` · ${filter.label}` : ''} · ${tasks.length} task${tasks.length === 1 ? '' : 's'}${counts.size ? ` (${order.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`).join(', ')})` : ''}`
    if (!tasks.length) return `${head}\nno tasks`
    const lines = [head]
    for (const t of tasks.slice(0, limit)) {
      const seat = this.seat(companyId, t.agentId)
      const dep = !seat && t.departmentId ? this.d.directory.departments(companyId).find((x) => x.id === t.departmentId)?.name : null
      lines.push(`- ${t.identifier} ${t.status}${t.blockReason ? `(${t.blockReason})` : ''} ${seat?.label ?? (dep ? `${dep} (unassigned)` : 'unassigned')} · "${clip(flat(this.clean(t.title)), 90)}"`)
    }
    if (tasks.length > limit) lines.push(`… ${tasks.length - limit} more`)
    return clip(lines.join('\n'), 5000)
  }
}
