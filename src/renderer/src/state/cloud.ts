/**
 * Cloud slice (docs/CLOUD.md §13.1): the link state from main, the workspace summary, recent runs, open asks and
 * passport proposals. Snapshot via invoke, then live through evt:cloud (main polls every 30 s and follows SSE). Kept
 * out of the global store like the Forum and Slack slices. Holds no token or key: main never sends one.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { CloudAsk, CloudRunSummary, PassportProposal, WorkspaceSummary } from '@shared/cloud'
import type { CloudDesktopEvent, CloudLinkState } from '@shared/types'
import { errorMessage, hive } from '../lib/hive'
import { openAsks, pendingFacts } from '../lib/cloud'

export interface CloudSlice {
  state: CloudLinkState | null
  summary: WorkspaceSummary | null
  runs: CloudRunSummary[]
  asks: CloudAsk[]
  proposals: Record<string, PassportProposal[]>
  error: string | null
  loading: boolean
}

const EMPTY: CloudSlice = { state: null, summary: null, runs: [], asks: [], proposals: {}, error: null, loading: false }
let st: CloudSlice = EMPTY
const ls = new Set<() => void>()
export const getCloud = (): CloudSlice => st
function set(p: Partial<CloudSlice> | ((s: CloudSlice) => Partial<CloudSlice>)): void {
  st = { ...st, ...(typeof p === 'function' ? p(st) : p) }
  for (const l of ls) l()
}
export function useCloud<T>(sel: (s: CloudSlice) => T): T {
  return useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => sel(st)
  )
}
/** Test hook. */
export function resetCloud(next: Partial<CloudSlice> = {}): void {
  st = { ...EMPTY, ...next }
  for (const l of ls) l()
}

let started = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
/** Loads the link state once and follows evt:cloud. Safe to call from every consumer. */
export function ensureCloud(): void {
  if (started || !hive?.cloud) return
  started = true
  hive.on('cloud', (e: CloudDesktopEvent) => onEvent(e))
  void hive.cloud
    .state()
    .then((state) => {
      set({ state })
      if (state.linked) void refreshCloud()
    })
    .catch(() => {
      started = false
    })
}

function onEvent(e: CloudDesktopEvent): void {
  if (e.kind === 'state') {
    const was = st.state
    set({ state: e.state })
    if (e.state.linked && (!was?.linked || was.workspace?.id !== e.state.workspace?.id)) void refreshCloud()
    if (!e.state.linked) set({ summary: null, runs: [], asks: [], proposals: {} })
    return
  }
  if (e.kind === 'changes') return refreshSoon()
  const ev = e.event
  if (ev.kind === 'run') set((s) => ({ runs: [ev.run, ...s.runs.filter((r) => r.id !== ev.run.id)] }))
  else if (ev.kind === 'ask') set((s) => ({ asks: [ev.ask, ...s.asks.filter((a) => a.id !== ev.ask.id)] }))
  else if (ev.kind === 'provider') set((s) => (s.summary ? { summary: { ...s.summary, providers: s.summary.providers.map((p) => (p.adapter === ev.account.adapter ? ev.account : p)) } } : {}))
  else if (ev.kind === 'workspace') set((s) => (s.summary ? { summary: { ...s.summary, workspace: ev.workspace } } : {}))
}

function refreshSoon(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void refreshCloud(), 200)
}

/** Summary, runs, asks and the proposals of companies with new facts. */
export async function refreshCloud(): Promise<void> {
  if (!st.state?.linked) return
  set({ loading: true })
  try {
    const [summary, runs, asks] = await Promise.all([hive.cloud.summary(), hive.cloud.runs({ limit: 50 }), hive.cloud.asks()])
    const withFacts = summary.companies.filter((c) => (c.passport?.pendingProposals ?? 0) > 0)
    const proposals = Object.fromEntries(await Promise.all(withFacts.map(async (c) => [c.id, await hive.cloud.proposals({ companyId: c.id }).catch(() => [])] as const)))
    set({ summary, runs, asks, proposals, error: null, loading: false })
  } catch (e) {
    set({ error: errorMessage(e), loading: false })
  }
}

export async function answerAsk(id: string, answer: string): Promise<void> {
  const a = await hive.cloud.answer({ id, answer })
  set((s) => ({ asks: s.asks.map((x) => (x.id === id ? a : x)) }))
}

export async function decideProposal(companyId: string, proposalId: string, decision: 'accept' | 'reject'): Promise<void> {
  await hive.cloud.decideProposal({ companyId, proposalId, decision })
  set((s) => ({ proposals: { ...s.proposals, [companyId]: (s.proposals[companyId] ?? []).filter((p) => p.id !== proposalId) } }))
  refreshSoon()
}

export function setCloudState(state: CloudLinkState): void {
  set({ state })
}

/** Sidebar badge: open cloud asks plus new passport facts. Starts the slice on first use. */
export function useCloudBadge(): number {
  useEffect(() => ensureCloud(), [])
  return useCloud((s) => (s.state?.linked ? openAsks(s.asks).length || s.state.openAsks : 0) + (s.state?.linked ? pendingFacts(s.summary) : 0))
}
/** Company ids in the cloud and schedule ids placed there (the cloud marks). */
export function useCloudPlacement(): { companies: string[]; schedules: string[] } {
  useEffect(() => ensureCloud(), [])
  const companies = useCloud((s) => s.state?.cloudCompanyIds ?? NONE)
  const schedules = useCloud((s) => s.state?.cloudScheduleIds ?? NONE)
  return { companies, schedules }
}
const NONE: string[] = []
