/**
 * Principia Cloud console: pure view models (docs/CLOUD.md §13.2). Two tabs, Needs you and Runs, plus the header with
 * the Online tile and Pause cloud. No DOM, no fetch: tests run these directly.
 */
import type { CloudAsk, CloudCompany, CloudRunDetail, CloudRunStatus, CloudRunSummary, PassportProposal } from '../../shared/cloud'

export type Tessera = 'ok' | 'needs' | 'fail' | 'running' | 'q'
const TESS: Record<string, Tessera> = { passed: 'ok', needs_input: 'needs', failed: 'fail', running: 'running', queued: 'q', canceled: 'q', skipped: 'q' }
export const tessera = (s: CloudRunStatus | string): Tessera => TESS[s] ?? 'q'

export type Route = { tab: 'needs' } | { tab: 'runs' } | { tab: 'run'; id: string }
/** `#/needs`, `#/runs`, `#/runs/<id>`; anything else is Needs you. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const [a, b] = h.split('/')
  if (a === 'runs' && b) return { tab: 'run', id: decodeURIComponent(b) }
  if (a === 'runs') return { tab: 'runs' }
  return { tab: 'needs' }
}
export const routeHash = (r: Route): string => (r.tab === 'run' ? `#/runs/${encodeURIComponent(r.id)}` : `#/${r.tab}`)

const pad = (n: number): string => String(n).padStart(2, '0')
export function clock(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''
}

export function agentParts(agentName: string | null): { name: string; role: string | null } {
  if (!agentName) return { name: 'An agent', role: null }
  const [name, ...rest] = agentName.split(' · ')
  return { name: name.trim() || 'An agent', role: rest.join(' · ').trim() || null }
}

export interface AskView {
  id: string
  name: string
  role: string | null
  where: string
  question: string
  options: string[]
}
export interface ProposalView {
  companyId: string
  title: string
  line: string
  ids: string[]
}
export interface NeedsView {
  asks: AskView[]
  proposals: ProposalView[]
  count: number
  empty: boolean
}

export function needsView(asks: CloudAsk[], proposals: Record<string, PassportProposal[]>, companies: Pick<CloudCompany, 'id' | 'name'>[]): NeedsView {
  const nameOf = (id: string): string => companies.find((c) => c.id === id)?.name ?? 'Company'
  const open = asks.filter((a) => a.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const av = open.map((a) => {
    const p = agentParts(a.agentName)
    return { id: a.id, name: p.name, role: p.role, where: [nameOf(a.companyId), clock(a.createdAt)].filter(Boolean).join(' · '), question: a.question, options: a.options }
  })
  const pv = Object.entries(proposals)
    .filter(([, list]) => list.length)
    .map(([cid, list]) => ({ companyId: cid, title: `Passport · ${nameOf(cid)}`, line: `${list.length} new ${list.length === 1 ? 'fact' : 'facts'} from cloud agents`, ids: list.map((p) => p.id) }))
  return { asks: av, proposals: pv, count: av.length + pv.length, empty: av.length + pv.length === 0 }
}

/** The answer a tap or the free-text field sends; null when there is nothing to send. */
export function answerPayload(ask: Pick<AskView, 'options'>, input: { option?: string; text?: string }): { answer: string } | null {
  if (input.option !== undefined) return ask.options.includes(input.option) ? { answer: input.option } : null
  const t = (input.text ?? '').trim()
  return t ? { answer: t.slice(0, 8000) } : null
}

export interface RunRow {
  id: string
  title: string
  tess: Tessera
  line: string
  time: string
}
export interface RunGroups {
  running: RunRow[]
  today: RunRow[]
  earlier: RunRow[]
}

const ADAPTER: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', shell: 'Shell' }
const TRIGGER: Record<string, string> = { manual: 'manual', schedule: 'schedule', webhook: 'webhook', desktop: 'run once', console: 'phone', answer: 'answer' }

export function runRow(r: CloudRunSummary, companies: Pick<CloudCompany, 'id' | 'name'>[], now = new Date()): RunRow {
  const co = companies.find((c) => c.id === r.companyId)?.name ?? 'Company'
  const at = r.startedAt ?? r.createdAt
  const sameDay = new Date(at).toDateString() === now.toDateString()
  const when = sameDay ? clock(at) : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const extra = r.status === 'needs_input' ? 'needs you' : r.status === 'running' ? 'running' : r.status === 'queued' ? 'queued' : r.status === 'failed' && r.summary ? r.summary.slice(0, 40) : r.startedAt && r.endedAt ? `${Math.max(1, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000))} min` : ''
  return {
    id: r.id,
    title: r.title,
    tess: tessera(r.status),
    line: [co, TRIGGER[r.trigger] ?? r.trigger, r.adapters.map((a) => ADAPTER[a] ?? a).join(', ')].filter(Boolean).join(' · '),
    time: [when, extra].filter(Boolean).join(' · ')
  }
}

/** Runs grouped: Running (queued, running, waiting on you), Today, Earlier. Newest first in each. */
export function groupRuns(runs: CloudRunSummary[], companies: Pick<CloudCompany, 'id' | 'name'>[], now = new Date()): RunGroups {
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const g: RunGroups = { running: [], today: [], earlier: [] }
  for (const r of sorted) {
    const row = runRow(r, companies, now)
    if (r.status === 'running' || r.status === 'queued' || r.status === 'needs_input') g.running.push(row)
    else if (new Date(r.createdAt).toDateString() === now.toDateString()) g.today.push(row)
    else g.earlier.push(row)
  }
  return g
}

export interface RunDetailView {
  id: string
  title: string
  tess: Tessera
  head: string
  steps: { title: string; tess: Tessera; meta: string; active: boolean }[]
  posts: { author: string; role: string | null; text: string }[]
  cancellable: boolean
  /** what the log shows when it has no lines: still coming while the run is going, else plainly none */
  emptyLog: string
}

export function runDetailView(d: CloudRunDetail, companies: Pick<CloudCompany, 'id' | 'name'>[]): RunDetailView {
  const co = companies.find((c) => c.id === d.companyId)?.name ?? 'Company'
  return {
    id: d.id,
    title: d.title,
    tess: tessera(d.status),
    head: [co, TRIGGER[d.trigger] ?? d.trigger, d.adapters.map((a) => ADAPTER[a] ?? a).join(', '), d.status === 'needs_input' ? 'needs you' : d.status].filter(Boolean).join(' · '),
    steps: d.steps.map((s) => ({ title: s.title, tess: tessera(s.status), meta: [s.adapter === 'shell' ? 'Shell' : (ADAPTER[s.adapter] ?? s.adapter), s.status === 'running' ? 'running' : s.usage ? `${s.usage.inputTokens + s.usage.outputTokens} tok` : ''].filter(Boolean).join(' · '), active: s.status === 'running' })),
    posts: (d.forumPosts ?? []).map((m) => ({ author: m.author.name, role: m.author.role, text: m.text })),
    cancellable: d.status === 'queued' || d.status === 'running' || d.status === 'needs_input',
    emptyLog: d.status === 'queued' || d.status === 'running' ? 'No log yet.' : 'This run wrote no output.'
  }
}

/** GET /v1/runs/:id/log answers `{lines}`, `{text}` or text. Keeps the last `max` lines. */
export function logLines(x: unknown, max = 400): string[] {
  let lines: string[] = []
  if (typeof x === 'string') lines = x.split('\n')
  else if (x && typeof x === 'object') {
    const o = x as { lines?: unknown; text?: unknown }
    if (Array.isArray(o.lines)) lines = o.lines.map(String)
    else if (typeof o.text === 'string') lines = o.text.split('\n')
  }
  return lines.slice(-max)
}
/** Appends SSE log lines to a tail, bounded. */
export const appendLog = (tail: string[], lines: string[], max = 400): string[] => [...tail, ...lines].slice(-max)

export interface HeaderView {
  workspace: string
  online: boolean
  status: string
  paused: boolean
  pauseLabel: string
}
export function headerView(p: { workspace: string | null; online: boolean; paused: boolean }): HeaderView {
  return { workspace: p.workspace ?? 'Principia Cloud', online: p.online, status: p.online ? 'Online' : 'Offline', paused: p.paused, pauseLabel: p.paused ? 'Paused' : 'Pause' }
}

/** List routes may answer an array or `{ <key>: [...] }`. */
export function listOf<T>(x: unknown, key: string): T[] {
  if (Array.isArray(x)) return x as T[]
  const v = x && typeof x === 'object' ? (x as Record<string, unknown>)[key] : undefined
  return Array.isArray(v) ? (v as T[]) : []
}
