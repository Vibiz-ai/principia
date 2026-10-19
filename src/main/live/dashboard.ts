/**
 * Home "since you were last here" (docs/LIVE.md §8). One query function over hive.db (+ memory facts), no Electron.
 * Real data only: cost is summed only from what CLIs reported; null when nothing was reported.
 */
import type { Artifact, ISODate, Id, NextFire, Run, Schedule, StatusSnapshot } from '../../shared/types'
import type { ActivityDay, AgentNode, ComingUp, DashboardData, LearnedFact, ModelUsage, RunCard } from '../../shared/live'
import type { Store } from '../db/store'
import { filesInside, type LiveStore } from '../db/liveStore'

const DAY = 86400_000
export const LAST_SEEN_KEY = 'home_last_seen_at'
export const ACTIVITY_DAYS = 14
const MORNING_BRIEF = /^morning-brief.*\.md$/i

export interface DashboardDeps {
  store: Store
  live: LiveStore
  status(): StatusSnapshot
  nextRuns(limit: number): NextFire[]
  factsSince?(since: ISODate, limit: number): LearnedFact[]
  now?: () => Date
}

/** since = arg ?? meta.home_last_seen_at ?? now-24h, clamped to >= now-7d (and <= now). */
export function resolveSince(arg: string | undefined, lastSeen: string | null, now: Date): ISODate {
  const floor = now.getTime() - 7 * DAY
  const raw = arg ?? lastSeen ?? new Date(now.getTime() - DAY).toISOString()
  const t = Date.parse(raw)
  const v = Number.isFinite(t) ? Math.min(Math.max(t, floor), now.getTime()) : now.getTime() - DAY
  return new Date(v).toISOString()
}

/** YYYY-MM-DD in local time. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface RootUsageRow {
  run_id: string | null
  model: string | null
  provider: string
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  model_usage_json: string | null
  files_json: string
  started_at: string
  cwd?: string | null
}

function parseUsage(s: string | null): Record<string, ModelUsage> | null {
  if (!s) return null
  try {
    const v = JSON.parse(s) as Record<string, ModelUsage>
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function runCard(d: DashboardDeps, run: Run): RunCard {
  const db = d.store.db
  const roots = db
    .prepare(
      `SELECT run_id, model, provider, tokens_in, tokens_out, cost_usd, model_usage_json, files_json, started_at, cwd
       FROM agents WHERE run_id = ? AND parent_id IS NULL`
    )
    .all(run.id) as RootUsageRow[]
  let cost: number | null = null
  let tin = 0
  let tout = 0
  let anyTokens = false
  const files = new Set<string>()
  for (const r of roots) {
    if (r.cost_usd != null) cost = (cost ?? 0) + r.cost_usd
    if (r.tokens_in != null || r.tokens_out != null) {
      anyTokens = true
      tin += r.tokens_in ?? 0
      tout += r.tokens_out ?? 0
    }
    try {
      // repo files only (rows written before the store filtered them may still hold ~/.claude or ARTIFACTS_DIR paths)
      for (const f of filesInside(r.cwd, JSON.parse(r.files_json) as string[])) files.add(f)
    } catch {
      /* ignore */
    }
  }
  const arts = d.store.listArtifacts({ runId: run.id, limit: 50 })
  const artifacts = [...arts.filter((a) => a.kind === 'image'), ...arts.filter((a) => a.kind !== 'image')].slice(0, 4)
  let failedStep: RunCard['failedStep'] = null
  if (run.status === 'failed') {
    const s = db
      .prepare("SELECT id, node_id, error FROM run_steps WHERE run_id = ? AND status = 'failed' ORDER BY seq LIMIT 1")
      .get(run.id) as { id: string; node_id: string; error: string | null } | undefined
    if (s) failedStep = { stepId: s.id, nodeId: s.node_id, error: s.error ? (s.error.split('\n').find((l) => l.trim()) ?? null) : null }
  }
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN
  return {
    run,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
    costUsd: cost,
    tokens: anyTokens ? { in: tin, out: tout } : null,
    filesChanged: files.size,
    files: [...files].slice(0, 5),
    artifacts,
    failedStep
  }
}

export function activity(d: DashboardDeps, now: Date): { days: ActivityDay[]; successRate: number | null } {
  const db = d.store.db
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (ACTIVITY_DAYS - 1))
  const startIso = start.toISOString()
  const days = new Map<string, ActivityDay & { models: Map<string, { tokens: number; costUsd: number | null }> }>()
  for (let i = 0; i < ACTIVITY_DAYS; i++) {
    const day = localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
    days.set(day, { date: day, runs: 0, passed: 0, failed: 0, tokens: 0, costUsd: null, byModel: [], models: new Map() })
  }
  const runs = db.prepare('SELECT status, created_at FROM runs WHERE created_at >= ?').all(startIso) as { status: string; created_at: string }[]
  let passed = 0
  let failed = 0
  for (const r of runs) {
    const day = days.get(localDay(r.created_at))
    if (!day) continue
    day.runs++
    if (r.status === 'passed') {
      day.passed++
      passed++
    } else if (r.status === 'failed') {
      day.failed++
      failed++
    }
  }
  const roots = db
    .prepare(
      `SELECT run_id, model, provider, tokens_in, tokens_out, cost_usd, model_usage_json, files_json, started_at
       FROM agents WHERE parent_id IS NULL AND started_at >= ?`
    )
    .all(startIso) as RootUsageRow[]
  for (const r of roots) {
    const day = days.get(localDay(r.started_at))
    if (!day) continue
    const usage = parseUsage(r.model_usage_json)
    const add = (model: string, tokens: number, cost: number | null) => {
      const m = day.models.get(model) ?? { tokens: 0, costUsd: null }
      m.tokens += tokens
      if (cost != null) m.costUsd = (m.costUsd ?? 0) + cost
      day.models.set(model, m)
      day.tokens += tokens
    }
    if (usage && Object.keys(usage).length) {
      for (const [model, u] of Object.entries(usage)) add(model, (u.tokensIn ?? 0) + (u.tokensOut ?? 0), u.costUsd ?? null)
      // root cost is authoritative (claude total_cost_usd includes subagents); per-model costs only split it
      if (r.cost_usd != null) day.costUsd = (day.costUsd ?? 0) + r.cost_usd
      else {
        const sum = Object.values(usage).reduce<number | null>((acc, u) => (u.costUsd == null ? acc : (acc ?? 0) + u.costUsd), null)
        if (sum != null) day.costUsd = (day.costUsd ?? 0) + sum
      }
    } else {
      const tokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0)
      if (tokens || r.cost_usd != null) add(r.model ?? r.provider, tokens, r.cost_usd)
      if (r.cost_usd != null) day.costUsd = (day.costUsd ?? 0) + r.cost_usd
    }
  }
  const out: ActivityDay[] = [...days.values()].map(({ models, ...day }) => {
    const sorted = [...models.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
    const top = sorted.slice(0, 5).map(([model, m]) => ({ model, tokens: m.tokens, costUsd: m.costUsd }))
    const rest = sorted.slice(5)
    if (rest.length) {
      top.push({
        model: 'other',
        tokens: rest.reduce((a, [, m]) => a + m.tokens, 0),
        costUsd: rest.reduce<number | null>((a, [, m]) => (m.costUsd == null ? a : (a ?? 0) + m.costUsd), null)
      })
    }
    return { ...day, byModel: top }
  })
  return { days: out, successRate: passed + failed ? passed / (passed + failed) : null }
}

function comingUp(d: DashboardDeps): ComingUp[] {
  const fires = d.nextRuns(5)
  const byId = new Map<Id, Schedule>()
  for (const s of d.store.listSchedules()) byId.set(s.id, s)
  return fires.map((f) => ({ scheduleId: f.scheduleId, name: f.name, at: f.at, sentence: byId.get(f.scheduleId)?.sentence ?? '' }))
}

function morningBrief(d: DashboardDeps): Artifact | null {
  const rows = d.store.db
    .prepare("SELECT id FROM artifacts WHERE lower(name) LIKE 'morning-brief%' AND lower(name) LIKE '%.md' ORDER BY mtime DESC LIMIT 20")
    .all() as { id: string }[]
  for (const r of rows) {
    const a = d.store.getArtifact(r.id)
    if (a && MORNING_BRIEF.test(a.name)) return a
  }
  return null
}

export function dashboard(d: DashboardDeps, arg?: { since?: string }): DashboardData {
  const now = d.now?.() ?? new Date()
  const lastSeenAt = d.store.getMeta(LAST_SEEN_KEY)
  const since = resolveSince(arg?.since, lastSeenAt, now)
  const live = d.live.liveTrees(400)
  const idle: AgentNode[] = live.filter((a) => a.kind === 'session' && a.parentId === null && a.needs === 'idle')
  let learned: LearnedFact[] = []
  try {
    learned = d.factsSince?.(since, 10) ?? []
  } catch {
    learned = []
  }
  return {
    since,
    lastSeenAt,
    status: d.status(),
    needsYou: { asks: d.live.listOpenAsks(), idle },
    done: d.store.endedRunsSince(since, 20).map((r) => runCard(d, r)),
    learned,
    activity: activity(d, now),
    live,
    comingUp: comingUp(d),
    morningBrief: morningBrief(d)
  }
}

export function markSeen(store: Store, now = new Date()): void {
  store.setMeta(LAST_SEEN_KEY, now.toISOString())
}
