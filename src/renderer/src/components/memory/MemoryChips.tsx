/** Memory chips outside the Memory page (MEMORY.md §10.6): RunView steps and SessionView panes. */
import { useEffect, useRef, useState } from 'react'
import type { Id } from '@shared/types'
import type { MemoryGrantInfo } from '@shared/memory'
import { MEMORY_MODE_LABEL } from '../../lib/memory'
import { hive, useHiveEvent } from '../../lib/hive'
import { memoryChipText } from '../../lib/live'
import { navigate, openMemoryForRun, openMemoryForSession } from '../../state/store'
import { Icon } from '../Icon'

/** Grants of one run or session; refetched when that run's steps change or memory changes (debounced). */
export function useMemoryGrants(q: { runId?: Id; sessionId?: Id }): MemoryGrantInfo[] {
  const [grants, setGrants] = useState<MemoryGrantInfo[]>([])
  const [n, setN] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bump = (): void => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setN((x) => x + 1)
    }, 400)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useEffect(() => {
    if (!q.runId && !q.sessionId) return setGrants([])
    let live = true
    hive.memory.grants(q.runId ? { runId: q.runId } : { sessionId: q.sessionId }).then(
      (g) => live && setGrants(g),
      () => live && setGrants([]) // memory unavailable: no chip, nothing else changes
    )
    return () => {
      live = false
    }
  }, [q.runId, q.sessionId, n])
  useHiveEvent('run:step', (s) => q.runId && s.runId === q.runId && bump())
  useHiveEvent('memory:changed', (e) => (q.sessionId || (q.runId && e.runIds.includes(q.runId))) && bump())
  return grants
}

function summarize(grants: MemoryGrantInfo[]): { mode: MemoryGrantInfo['mode']; wrote: number; invalidated: number; injected: boolean } | null {
  if (!grants.length) return null
  const mode = grants.some((g) => g.mode === 'read-write') ? 'read-write' : 'read'
  return {
    mode,
    wrote: grants.reduce((a, g) => a + g.wrote.facts + g.wrote.relations, 0),
    invalidated: grants.reduce((a, g) => a + g.wrote.invalidated, 0),
    injected: grants.every((g) => g.transport === 'inject')
  }
}

/** "memory: Read & write · wrote 3" on the selected step; opens the Memory page filtered to this run. */
export function StepMemoryChip({ grants, runId }: { grants: MemoryGrantInfo[]; runId: Id }): React.JSX.Element | null {
  const s = summarize(grants)
  if (!s) return null
  const repoId = grants.find((g) => g.repoId)?.repoId ?? null
  const parts = [`memory: ${MEMORY_MODE_LABEL[s.mode]}${s.injected ? ' (brief only)' : ''}`]
  if (s.mode === 'read-write') parts.push(s.wrote ? `wrote ${s.wrote}` : 'wrote nothing')
  if (s.invalidated) parts.push(`invalidated ${s.invalidated}`)
  return (
    <button type="button" className={`mchip ${s.mode === 'read-write' ? 'mchip--rw' : ''}`} onClick={() => openMemoryForRun(runId, repoId)} title="Show what this run wrote on the Memory page">
      <Icon name="memory" size={11} /> {parts.join(' · ')}
    </button>
  )
}

/** Tiny marker for step rows that used memory. */
export function StepMemoryMark({ grants }: { grants: MemoryGrantInfo[] }): React.JSX.Element | null {
  const s = summarize(grants)
  if (!s) return null
  return (
    <span className="mchip mchip--mini" title={`Shared memory: ${MEMORY_MODE_LABEL[s.mode]}${s.wrote ? ` · wrote ${s.wrote}` : ''}`}>
      M{s.wrote ? ` ${s.wrote}` : ''}
    </span>
  )
}

/** Session pane footer: shown only when the session got a memory grant. */
export function SessionMemoryChip({ sessionId }: { sessionId: Id }): React.JSX.Element | null {
  const grants = useMemoryGrants({ sessionId })
  const s = summarize(grants)
  if (!s) return null
  const repoId = grants.find((g) => g.repoId)?.repoId ?? null
  return (
    <button
      type="button"
      className="pane__footer-item"
      onClick={() => void navigate({ name: 'memory', scope: repoId ? { repoId } : 'global', nonce: Date.now() })}
      title={repoId ? 'This session shares memory with other agents working in this repository' : 'No repository: this session reads global memory only'}
    >
      memory: {MEMORY_MODE_LABEL[s.mode]}
      {s.injected ? ' (brief)' : ''}
      {s.wrote ? ` · wrote ${s.wrote}` : ''} →
    </button>
  )
}

// ---------- live agents: "3 read · 1 saved" (LIVE.md §7) ----------
/** One shared grants cache for many chips (hub rows, canvas pills): one request per run/session, refetched on memory:changed. */
const grantCache = new Map<string, { grants: MemoryGrantInfo[] | null; inflight: boolean; subs: Set<() => void> }>()
let grantInvalidate: ReturnType<typeof setTimeout> | null = null
let grantWired = false
function grantKey(o: { runId?: Id | null; sessionId?: Id | null }): string | null {
  return o.runId ? `r:${o.runId}` : o.sessionId ? `s:${o.sessionId}` : null
}
function fetchGrants(key: string): void {
  const e = grantCache.get(key)
  if (!e || e.inflight) return
  e.inflight = true
  const [kind, id] = [key.slice(0, 1), key.slice(2)]
  hive.memory.grants(kind === 'r' ? { runId: id } : { sessionId: id }).then(
    (g) => {
      e.grants = g
      e.inflight = false
      e.subs.forEach((f) => f())
    },
    () => {
      e.grants = []
      e.inflight = false
      e.subs.forEach((f) => f())
    }
  )
}
function wireGrants(): void {
  if (grantWired) return
  grantWired = true
  hive.on('memory:changed', () => {
    if (grantInvalidate) return
    grantInvalidate = setTimeout(() => {
      grantInvalidate = null
      for (const [k, e] of grantCache) if (e.subs.size) fetchGrants(k)
        else grantCache.delete(k)
    }, 500)
  })
}
export function useSharedGrants(o: { runId?: Id | null; sessionId?: Id | null }): MemoryGrantInfo[] | null {
  const key = grantKey(o)
  const [, setN] = useState(0)
  useEffect(() => {
    if (!key) return
    wireGrants()
    let e = grantCache.get(key)
    if (!e) grantCache.set(key, (e = { grants: null, inflight: false, subs: new Set() }))
    const sub = (): void => setN((x) => x + 1)
    e.subs.add(sub)
    if (e.grants === null) fetchGrants(key)
    return () => {
      e!.subs.delete(sub)
    }
  }, [key])
  return key ? (grantCache.get(key)?.grants ?? null) : null
}

/**
 * "3 read · 1 saved" for a step, session or hub row. Reads come from the live agent tree (tool calls counted in
 * hive.db), saved from the grant. Brief-only grants say "brief". Click opens the Memory page filtered to that run.
 */
export function AgentMemoryChip({ owner, reads, repoId, mini = false }: { owner: { runId?: Id | null; stepId?: Id | null; sessionId?: Id | null }; reads: number; repoId?: Id | null; mini?: boolean }): React.JSX.Element | null {
  const all = useSharedGrants(owner.runId ? { runId: owner.runId } : { sessionId: owner.sessionId })
  const grants = (all ?? []).filter((g) => (owner.stepId ? g.stepId === owner.stepId : true))
  const saved = grants.reduce((a, g) => a + g.wrote.facts + g.wrote.relations, 0)
  const briefOnly = grants.length > 0 && grants.every((g) => g.transport === 'inject')
  const grantReads = grants.reduce((a, g) => a + (g.reads ?? 0), 0)
  const text = memoryChipText({ reads: Math.max(reads, grantReads), saved, briefOnly, granted: grants.length > 0 })
  if (!text) return null
  const repo = repoId ?? grants.find((g) => g.repoId)?.repoId ?? null
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (owner.runId) openMemoryForRun(owner.runId, repo)
    else if (owner.sessionId) openMemoryForSession(owner.sessionId, repo)
  }
  return (
    <button type="button" className={`mchip ${saved ? 'mchip--rw' : ''} ${mini ? 'mchip--mini' : ''}`} onClick={open} title={briefOnly ? 'Got a memory brief in its prompt (no memory tools). Click to see what it saved.' : 'Memory searches by this agent and its subagents · facts it saved. Click to see them on the Memory page.'}>
      <Icon name="memory" size={11} /> {text}
    </button>
  )
}
