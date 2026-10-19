/**
 * Pure graph builders for the Canvas and the workflow editor preview.
 * Produces @xyflow/react nodes/edges with absolute positions (dagre LR inside each group).
 */
import dagre from '@dagrejs/dagre'
import { notifySlackOf } from './slack'
import type { Edge, Node } from '@xyflow/react'
import type {
  AdapterId,
  AgentProfile,
  CanvasSnapshot,
  Repo,
  RunDetail,
  RunStep,
  Schedule,
  Session,
  StepStatus,
  WorkflowDraft
} from '@shared/types'
import type { Ask } from '@shared/live'
import { depsOf } from './workflow'
import { activityLine, agentVisual, isSeen, isStalled, limitLine, pillsFor, type AgentIndex, type Pill } from './live'
import { absolute, clock, durationMs } from './time'
import { collapseExited, firstLine, runTitle, sessionEndLabel } from './format'

export const NODE_W = 168
export const NODE_H = 44
const GAP = 16
const FRAME_PAD = 12
const FRAME_LABEL = 22

export type VisualStatus = 'idle' | 'queued' | 'running' | 'passed' | 'failed' | 'canceled' | 'scheduled' | 'exited'

export type NodeRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'step'; runId: string; nodeId: string; stepId: string | null }
  | { kind: 'run'; runId: string }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'wfnode'; nodeId: string }
  | { kind: 'repo'; repoId: string | null }
  /** Canvas History layer (AUTHORING.md §8.5): a Claude Code conversation outside Principia. */
  | { kind: 'history'; historyId: string }

export interface CardData extends Record<string, unknown> {
  label: string
  sub: string
  status: VisualStatus
  adapter: AdapterId | null
  ref: NodeRef
  countdownTo?: string | null
  compact?: boolean
  /** Live subagents of this node's agent (LIVE.md §11): up to 4 pills + "+n more". */
  pills?: Pill[]
  morePills?: number
  /** Open asks anywhere in this node's agent tree (amber ring + ⚑ badge). */
  needs?: number
  /** Root agent of this card (step or session), for the drawer's agent tree. */
  agentId?: string | null
  /** The root agent is waiting on the user (open ask, or an unseen "your turn"): amber flag, same as the hub. */
  waiting?: boolean
  /** The root agent is working but silent for Settings.stallMinutes: amber "Stalled?" badge (never auto-killed). */
  stalled?: boolean
  /** Approval card diff (AUTHORING.md §2.2): added green, removed red ghost, changed amber. */
  diff?: 'added' | 'removed' | 'changed'
  /** Runs in the run's git worktree (branch glyph). */
  isolated?: boolean
  /** Muted "nothing to do" styling: the run ended early via HIVE_STOP (AUTHORING.md §5). */
  quiet?: boolean
  /** Canvas History layer card: dashed, never animated, no edges. */
  history?: boolean
}
export interface FrameData extends Record<string, unknown> {
  label: string
  width: number
  height: number
  status: VisualStatus | null
  ref: NodeRef | null
  /** group = a workflow's lane; ghost = a scheduled target with nothing running yet. */
  variant?: 'group' | 'ghost' | 'history'
  meta?: string
  note?: string
}
export type CardNode = Node<CardData, 'card'>
export type FrameNode = Node<FrameData, 'frame'>
export type GraphNode = CardNode | FrameNode

export interface Graph {
  nodes: GraphNode[]
  edges: Edge[]
  width: number
  height: number
}

export function stepVisual(s: StepStatus | undefined): VisualStatus {
  switch (s) {
    case 'running':
      return 'running'
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'skipped':
      return 'canceled'
    case 'pending':
      return 'queued'
    default:
      return 'idle'
  }
}

const EDGE_COLOR = 'var(--edge)'
const RUNNING_COLOR = 'var(--status-running)'
const SCHEDULED_COLOR = 'var(--status-scheduled)'

interface Local {
  id: string
  data: CardData
}
interface LocalEdge {
  from: string
  to: string
  kind: 'dep' | 'loop' | 'room'
  label?: string
  active?: boolean
}

export const PILL_H = 22
const PILLS_PAD = 6
/** Card height: 44 px, plus one 22 px row per subagent pill (and the "+n more" row). Compact chips are 32 px. */
export function cardHeight(d: Pick<CardData, 'compact' | 'pills' | 'morePills'>): number {
  if (d.compact) return 32
  const rows = (d.pills?.length ?? 0) + (d.morePills ? 1 : 0)
  return rows ? NODE_H + rows * PILL_H + PILLS_PAD : NODE_H
}

function layout(items: Local[], edges: LocalEdge[]): { pos: Map<string, { x: number; y: number }>; w: number; h: number } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: 48, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const it of items) g.setNode(it.id, { width: NODE_W, height: cardHeight(it.data) })
  for (const e of edges) if (e.kind !== 'loop' && g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to)
  dagre.layout(g)
  const pos = new Map<string, { x: number; y: number }>()
  let w = 0
  let h = 0
  for (const it of items) {
    const ch = cardHeight(it.data)
    const n = g.node(it.id) as { x: number; y: number } | undefined
    const x = (n?.x ?? NODE_W / 2) - NODE_W / 2
    const y = (n?.y ?? ch / 2) - ch / 2
    pos.set(it.id, { x, y })
    w = Math.max(w, x + NODE_W)
    h = Math.max(h, y + ch)
  }
  return { pos, w, h }
}

/** Live agent overlay for canvas cards: the step/session root agent, its subagent pills and open-ask count. */
export interface CanvasLive {
  idx: AgentIndex
  asks: Ask[] // open
  /** A3 "seen" idle sessions (they stop counting as Needs you). */
  seen?: ReadonlySet<string>
}
function decorate(items: Local[], live: CanvasLive | undefined): void {
  if (!live) return
  const byStep = new Map<string, string>()
  const bySession = new Map<string, string>()
  for (const r of live.idx.roots) {
    if (r.stepId) byStep.set(r.stepId, r.id)
    if (r.kind === 'session' && r.sessionId) bySession.set(r.sessionId, r.id)
  }
  const askRoots = new Map<string, number>()
  const askAgents = new Set<string>()
  for (const a of live.asks) {
    askRoots.set(a.rootId, (askRoots.get(a.rootId) ?? 0) + 1)
    askAgents.add(a.agentId)
  }
  for (const it of items) {
    const ref = it.data.ref
    const rootId = ref.kind === 'step' && ref.stepId ? byStep.get(ref.stepId) : ref.kind === 'session' ? bySession.get(ref.sessionId) : undefined
    if (!rootId) continue
    const { pills, more } = pillsFor(live.idx, rootId, askAgents)
    const needs = askRoots.get(rootId) || undefined
    const root = live.idx.byId.get(rootId)
    const seen = live.seen ?? new Set<string>()
    // same rule as the hub's AgentRow: an open ask in its tree, or the root itself needs you (idle only while unseen)
    const waiting = !!needs || (!!root && agentVisual(root, isSeen(root, seen)) === 'needs')
    let sub = it.data.sub
    if (waiting && root) {
      const what = needs ? 'Waiting for you' : activityLine(root, false)
      const parts = sub.split(' · ')
      const when = parts.length > 1 ? parts[parts.length - 1] : null
      sub = when ? `${what} · ${when}` : what
    }
    if (root && ref.kind === 'session' && root.stopReason === 'rate_limited' && !waiting) sub = limitLine(root)
    it.data = { ...it.data, agentId: rootId, pills: pills.length ? pills : undefined, morePills: more || undefined, needs, waiting: waiting || undefined, stalled: isStalled(root) || undefined, sub }
  }
}

function profileAdapter(profiles: AgentProfile[], id: string | null | undefined): AdapterId | null {
  return profiles.find((p) => p.id === id)?.adapter ?? null
}

function latest(steps: RunStep[], pred: (s: RunStep) => boolean): RunStep | undefined {
  let best: RunStep | undefined
  for (const s of steps) if (pred(s) && (!best || s.seq > best.seq)) best = s
  return best
}
function maxAttempt(steps: RunStep[], nodeId: string): number {
  let m = 0
  for (const s of steps) if (s.nodeId === nodeId) m = Math.max(m, s.attempt)
  return m
}

/**
 * Logical graph of a workflow (draft or run). With `run`, statuses come from its steps.
 * Room nodes expand to one card per participant joined by ⇄ edges.
 */
export function workflowLocal(
  draft: WorkflowDraft | null,
  run: RunDetail | null,
  profiles: AgentProfile[],
  now: number = Date.now()
): { items: Local[]; edges: LocalEdge[] } {
  const steps = run?.steps ?? []
  const runId = run?.run.id ?? ''
  const items: Local[] = []
  const edges: LocalEdge[] = []
  if (!draft) {
    // prompt run: one card
    const s = latest(steps, () => true)
    const target = run?.run.target
    const adapter = s?.adapter ?? (target?.kind === 'prompt' ? profileAdapter(profiles, target.profileId) : null)
    items.push({
      id: 'prompt',
      data: {
        label: adapter === 'shell' ? 'Shell command' : adapter ? `${adapter[0]!.toUpperCase()}${adapter.slice(1)} prompt` : 'Prompt',
        sub: s ? stepSub(s, run, now) : run && run.run.stopReason === 'rate_limited' ? limitLine(run.run) : run && isTerminal(run.run.status) ? endSub(run.run.status, run.run.reason) : 'waiting',
        status: s ? stepVisual(s.status) : run ? runVisual(run.run.status) : 'idle',
        adapter,
        ref: { kind: 'step', runId, nodeId: 'prompt', stepId: s?.id ?? null }
      }
    })
    return { items, edges }
  }
  const entry = new Map<string, string>() // node id -> card id that receives incoming edges
  const exit = new Map<string, string>()
  const statusOf = new Map<string, VisualStatus>()
  for (const n of draft.nodes) {
    if (n.type === 'room') {
      const ids: string[] = []
      n.participants.forEach((p, i) => {
        const cid = `${n.id}:${i}`
        ids.push(cid)
        const s = latest(steps, (x) => x.nodeId === n.id && x.participantLabel === p.label)
        const rounds = steps.filter((x) => x.nodeId === n.id && x.participantLabel === p.label).length
        const adapter = profileAdapter(profiles, p.profileId) ?? s?.adapter ?? null
        items.push({
          id: cid,
          data: {
            label: p.label || `participant ${i + 1}`,
            sub: [adapter ?? '', run ? `round ${Math.min(rounds, n.rounds)}/${n.rounds}` : `room · ${n.rounds} rounds`].filter(Boolean).join(' · '),
            status: run ? stepVisual(s?.status ?? 'pending') : 'idle',
            adapter,
            ref: run ? { kind: 'step', runId, nodeId: n.id, stepId: s?.id ?? null } : { kind: 'wfnode', nodeId: n.id }
          }
        })
      })
      for (let i = 0; i + 1 < ids.length; i++) edges.push({ from: ids[i]!, to: ids[i + 1]!, kind: 'room' })
      entry.set(n.id, ids[0] ?? n.id)
      exit.set(n.id, ids[0] ?? n.id)
      const s = latest(steps, (x) => x.nodeId === n.id)
      statusOf.set(n.id, run ? stepVisual(s?.status ?? 'pending') : 'idle')
      continue
    }
    const s = latest(steps, (x) => x.nodeId === n.id)
    const attempt = maxAttempt(steps, n.id)
    const profileId = n.type === 'agent' ? n.profileId : n.type === 'check' ? n.profileId : null
    const adapter: AdapterId | null =
      n.type === 'shell' || n.type === 'wait' || (n.type === 'check' && n.command) ? 'shell' : n.type === 'notify' ? null : (profileAdapter(profiles, profileId) ?? s?.adapter ?? null)
    const parts: string[] = []
    parts.push(
      n.type === 'check'
        ? n.command
          ? 'check · command'
          : `check · ${adapter ?? '?'}`
        : n.type === 'shell'
          ? 'command'
          : n.type === 'wait'
            ? `wait · every ${intervalLabel(n.intervalSec)}`
            : n.type === 'notify'
              ? notifySlackOf(n)
                ? 'notify · Slack'
                : 'notify'
              : (adapter ?? n.type)
    )
    const nothing = run?.run.outcome === 'nothing_to_do'
    if (attempt > 1) parts.push(`#${attempt}`)
    if (s?.halt) parts.push(`stopped · ${firstLine(s.halt, 40)}`)
    else if (s?.stopReason === 'rate_limited') parts.push(limitLine(s))
    else if (s?.status === 'failed' && s.error) parts.push(firstLine(s.error, 48))
    else if (s?.status === 'skipped' && nothing) parts.push('skipped')
    else if (s) parts.push(dur(s, now))
    else if (run && isTerminal(run.run.status)) parts.push(nothing ? 'skipped' : 'not run')
    const status = run ? (s ? stepVisual(s.status) : isTerminal(run.run.status) ? 'canceled' : 'queued') : 'idle'
    statusOf.set(n.id, status)
    items.push({
      id: n.id,
      data: {
        label: n.label || n.id,
        sub: parts.join(' · '),
        status,
        adapter,
        ref: run ? { kind: 'step', runId, nodeId: n.id, stepId: s?.id ?? null } : { kind: 'wfnode', nodeId: n.id },
        ...(n.isolate === 'worktree' ? { isolated: true } : {}),
        ...(nothing && (!s || s.status === 'skipped' || !!s.halt) ? { quiet: true } : {})
      }
    })
    entry.set(n.id, n.id)
    exit.set(n.id, n.id)
  }
  for (const n of draft.nodes) {
    for (const d of depsOf(n)) {
      const from = exit.get(d)
      const to = entry.get(n.id)
      if (!from || !to) continue
      const active = run ? statusOf.get(d) === 'passed' && statusOf.get(n.id) === 'running' : false
      edges.push({ from, to, kind: 'dep', active })
    }
    if (n.type === 'check' && n.target && entry.has(n.target)) {
      const att = maxAttempt(steps, n.target)
      edges.push({
        from: n.id,
        to: entry.get(n.target)!,
        kind: 'loop',
        label: run && att > 1 ? `attempt ${att}` : `↺ ≤${n.maxRetries}`
      })
    }
  }
  return { items, edges }
}

/** "60 s", "5 min", "1 h". */
export function intervalLabel(sec: number): string {
  if (sec < 60 || sec % 60 !== 0) return `${sec} s`
  if (sec < 3600 || sec % 3600 !== 0) return `${sec / 60} min`
  return `${sec / 3600} h`
}

function isTerminal(s: RunDetail['run']['status']): boolean {
  return s !== 'running' && s !== 'queued'
}

/** "failed · Codex not installed", "canceled", "passed". */
function endSub(status: string, reason: string | null): string {
  return reason ? `${status} · ${firstLine(reason, 48)}` : status
}

function stepSub(s: RunStep, run: RunDetail | null, now: number): string {
  if (s.stopReason === 'rate_limited') return limitLine(s)
  if (s.status === 'failed') return endSub('failed', s.error ?? run?.run.reason ?? null)
  const d = dur(s, now)
  return d ? `${s.status} · ${d}` : s.status
}

function dur(s: RunStep, now: number): string {
  if (!s.startedAt) return ''
  return durationMs((s.endedAt ? new Date(s.endedAt).getTime() : now) - new Date(s.startedAt).getTime())
}

export function runVisual(s: RunDetail['run']['status']): VisualStatus {
  return s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : s === 'canceled' ? 'canceled' : s === 'running' ? 'running' : 'queued'
}

function toFlowEdges(prefix: string, edges: LocalEdge[]): Edge[] {
  return edges.map((e, i) => {
    const id = `${prefix}e${i}:${e.from}->${e.to}`
    const source = prefix + e.from
    const target = prefix + e.to
    if (e.kind === 'loop') {
      return {
        id,
        source,
        target,
        sourceHandle: 'loop-out',
        targetHandle: 'loop-in',
        type: 'smoothstep',
        label: e.label,
        className: 'edge-loop',
        style: { stroke: EDGE_COLOR, strokeDasharray: '5 4', strokeWidth: 1.5 },
        labelStyle: { fill: 'var(--text-secondary)', fontSize: 11 },
        labelBgStyle: { fill: 'var(--surface-2)' },
        labelBgPadding: [6, 2] as [number, number],
        labelBgBorderRadius: 999
      }
    }
    if (e.kind === 'room') {
      return {
        id,
        source,
        target,
        type: 'straight',
        label: '⇄',
        style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
        labelStyle: { fill: 'var(--text-secondary)', fontSize: 12 },
        labelBgStyle: { fill: 'var(--canvas-bg)' }
      }
    }
    return {
      id,
      source,
      target,
      type: 'smoothstep',
      animated: !!e.active,
      style: { stroke: e.active ? RUNNING_COLOR : EDGE_COLOR, strokeWidth: 1.5 }
    }
  })
}

/** Editor preview: the draft alone, no frame. */
export function draftGraph(draft: WorkflowDraft, profiles: AgentProfile[]): Graph {
  const { items, edges } = workflowLocal(draft, null, profiles)
  const { pos, w, h } = layout(items, edges)
  const nodes: GraphNode[] = items.map((it) => ({
    id: it.id,
    type: 'card',
    position: pos.get(it.id)!,
    data: it.data,
    draggable: false
  }))
  return { nodes, edges: toFlowEdges('', edges), width: w, height: h }
}

/**
 * Approval card graph (AUTHORING.md §2.2): the proposed draft, with removed nodes of `base` drawn as red ghosts and
 * added / changed nodes tinted. Read-only.
 */
export function draftDiffGraph(
  draft: WorkflowDraft,
  base: WorkflowDraft | null,
  diff: { added: string[]; removed: string[]; changed: string[] } | null,
  profiles: AgentProfile[]
): Graph {
  const removed = base && diff ? base.nodes.filter((n) => diff.removed.includes(n.id) && !draft.nodes.some((x) => x.id === n.id)) : []
  const keep = new Set([...draft.nodes.map((n) => n.id), ...removed.map((n) => n.id)])
  const merged: WorkflowDraft = {
    ...draft,
    nodes: [...draft.nodes, ...removed.map((n) => ({ ...n, after: n.after.filter((a) => keep.has(a)) }) as typeof n)]
  }
  const { items, edges } = workflowLocal(merged, null, profiles)
  const mark = (nodeId: string): CardData['diff'] =>
    diff ? (diff.removed.includes(nodeId) ? 'removed' : diff.added.includes(nodeId) ? 'added' : diff.changed.includes(nodeId) ? 'changed' : undefined) : undefined
  for (const it of items) {
    const d = it.data.ref.kind === 'wfnode' ? mark(it.data.ref.nodeId) : undefined
    if (d) it.data.diff = d
  }
  const { pos, w, h } = layout(items, edges)
  const nodes: GraphNode[] = items.map((it) => ({ id: it.id, type: 'card', position: pos.get(it.id)!, data: it.data, draggable: false }))
  return { nodes, edges: toFlowEdges('', edges), width: w, height: h }
}

export interface HistoryLane {
  key: string
  label: string
  cards: { id: string; title: string; sub: string }[]
  older: number
}
/**
 * Canvas History layer: one muted lane per repo / folder below the live graph, compact dashed cards, no edges
 * (AUTHORING.md §8.5). Positions continue under `base`.
 */
export function appendHistory(base: Graph, lanes: HistoryLane[]): Graph {
  if (!lanes.length) return base
  const nodes: GraphNode[] = [...base.nodes]
  const x0 = NODE_W + 64
  const perRow = 6
  let y = base.nodes.length ? base.height + 48 : 0
  let maxW = base.width
  for (const ln of lanes) {
    const count = ln.cards.length + (ln.older ? 1 : 0)
    if (!count) continue
    const cols = Math.min(perRow, count)
    const rows = Math.ceil(count / perRow)
    const w = FRAME_PAD * 2 + cols * NODE_W + (cols - 1) * GAP
    const h = FRAME_PAD * 2 + FRAME_LABEL + rows * 32 + (rows - 1) * GAP
    const f = frame(`f:hist:${ln.key}`, ln.label, x0, y, w, h, null, null)
    f.data.variant = 'history'
    f.data.meta = 'Claude Code · outside Principia'
    nodes.push(f)
    ln.cards.forEach((c, i) => {
      nodes.push({
        id: `h:${c.id}`,
        type: 'card',
        position: { x: x0 + FRAME_PAD + (i % perRow) * (NODE_W + GAP), y: y + FRAME_PAD + FRAME_LABEL + Math.floor(i / perRow) * (32 + GAP) },
        data: { label: c.title, sub: c.sub, status: 'exited', adapter: 'claude', ref: { kind: 'history', historyId: c.id }, compact: true, history: true },
        draggable: false
      })
    })
    if (ln.older) {
      const i = ln.cards.length
      nodes.push({
        id: `h:older:${ln.key}`,
        type: 'card',
        position: { x: x0 + FRAME_PAD + (i % perRow) * (NODE_W + GAP), y: y + FRAME_PAD + FRAME_LABEL + Math.floor(i / perRow) * (32 + GAP) },
        data: { label: `+${ln.older} older`, sub: 'Show all on Home', status: 'idle', adapter: null, ref: { kind: 'history', historyId: '' }, compact: true, history: true },
        draggable: false
      })
    }
    y += h + 28
    maxW = Math.max(maxW, x0 + w)
  }
  return { nodes, edges: base.edges, width: maxW, height: y }
}

function frame(id: string, label: string, x: number, y: number, w: number, h: number, ref: NodeRef | null, status: VisualStatus | null): FrameNode {
  return {
    id,
    type: 'frame',
    position: { x, y },
    data: { label, width: w, height: h, ref, status },
    draggable: false,
    selectable: false,
    zIndex: -1,
    style: { width: w, height: h }
  }
}

function sessionCard(s: Session, profiles: AgentProfile[], now: number): Local {
  const prof = profiles.find((p) => p.id === s.profileId)
  const ageMs = now - new Date(s.startedAt).getTime()
  const who = s.adapter === 'shell' ? 'shell' : (prof?.name ?? s.adapter)
  const sub = s.status === 'running' ? `${s.adapter === 'shell' ? 'terminal' : s.adapter} · ${fmtAge(ageMs)}` : sessionEndLabel(s)
  return {
    id: `s:${s.id}`,
    data: {
      // same name as the hub row ("acme-web · Claude"), falling back to the agent's name
      label: s.title || (who === 'shell' ? 'Shell' : who),
      sub,
      status: s.status === 'running' ? 'running' : 'exited',
      adapter: s.adapter,
      ref: { kind: 'session', sessionId: s.id }
    }
  }
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return 'not scheduled'
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'due'
  return `in ${fmtAge(ms)}`
}

const WRAP_W = 1500 // wrap session groups past this width
const LANE_GAP = 28
const GROUP_PAD = 12
const GROUP_LABEL = 26
const COMPACT_H = 32

interface Lane {
  key: string
  label: string
  runs: RunDetail[]
  schedules: Schedule[]
}

function isActive(rd: RunDetail): boolean {
  return rd.run.status === 'running' || rd.run.status === 'queued'
}
function runAt(rd: RunDetail): string {
  return rd.run.startedAt ?? rd.run.createdAt
}

/** "10:42" today, "Oct 14 10:42" before. */
function when(iso: string, now: number): string {
  const d = new Date(iso)
  const today = new Date(now)
  return d.toDateString() === today.toDateString() ? clock(d) : absolute(d)
}

function runDuration(rd: RunDetail, now: number): string {
  if (!rd.run.startedAt) return 'queued'
  return durationMs((rd.run.endedAt ? new Date(rd.run.endedAt).getTime() : now) - new Date(rd.run.startedAt).getTime())
}

/**
 * Whole canvas, top to bottom:
 *  1. live/recent sessions, one frame per repo, laid out in wrapping rows;
 *  2. one lane per workflow (or scheduled prompt): active runs first, the latest finished run expanded,
 *     older runs collapsed to compact cards; schedule clocks on the left with a dashed edge into their lane
 *     (a ghost lane when the target has not run yet).
 */
/** Exited sessions older than this drop off the canvas (the sidebar still lists them). */
export const RECENT_SESSION_MS = 24 * 60 * 60_000

export function canvasGraph(snap: CanvasSnapshot, now: number = Date.now(), overlay?: CanvasLive): Graph {
  const nodes: GraphNode[] = []
  const edges: Edge[] = []
  const CONTENT_X = NODE_W + 64
  let y = 0
  let maxW = 0
  const reposById = new Map<string, Repo>(snap.repos.map((r) => [r.id, r]))

  // 1. sessions grouped by repo, running repos first. Only live or recent (24 h) activity earns a group:
  // a "stopped" card for every repo/Chat ever used is noise.
  const recentSince = now - RECENT_SESSION_MS
  const recent = snap.sessions.filter((s) => s.status === 'running' || Date.parse(s.endedAt ?? s.startedAt) >= recentSince)
  const groups = new Map<string, Session[]>()
  for (const s of collapseExited(recent).shown) {
    const k = s.repoId ?? '__chat'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(s)
  }
  const groupList = [...groups.entries()].sort((a, b) => {
    const ra = a[1].some((s) => s.status === 'running') ? 1 : 0
    const rb = b[1].some((s) => s.status === 'running') ? 1 : 0
    return rb - ra
  })
  let gx = CONTENT_X
  let rowH = 0
  for (const [k, list] of groupList) {
    list.sort((a, b) => (a.status === b.status ? (a.startedAt < b.startedAt ? 1 : -1) : a.status === 'running' ? -1 : 1))
    const cards = list.map((s) => sessionCard(s, snap.profiles, now))
    decorate(cards, overlay)
    const perRow = Math.min(cards.length, 4)
    const rows = Math.ceil(cards.length / perRow)
    const rowHs = Array.from({ length: rows }, (_, r) => Math.max(...cards.slice(r * perRow, r * perRow + perRow).map((c) => cardHeight(c.data))))
    const rowY = rowHs.map((_, r) => rowHs.slice(0, r).reduce((a, b) => a + b + GAP, 0))
    const w = FRAME_PAD * 2 + perRow * NODE_W + (perRow - 1) * GAP
    const h = FRAME_PAD * 2 + FRAME_LABEL + rowHs.reduce((a, b) => a + b, 0) + (rows - 1) * GAP
    if (gx > CONTENT_X && gx + w > CONTENT_X + WRAP_W) {
      gx = CONTENT_X
      y += rowH + LANE_GAP
      rowH = 0
    }
    const label = k === '__chat' ? 'Chat (no repo)' : (reposById.get(k)?.name ?? 'Repository')
    const live = list.filter((s) => s.status === 'running').length
    const f = frame(`f:repo:${k}`, label, gx, y, w, h, { kind: 'repo', repoId: k === '__chat' ? null : k }, null)
    f.data.meta = live ? `${live} running` : undefined
    nodes.push(f)
    cards.forEach((c, i) => {
      nodes.push({
        id: c.id,
        type: 'card',
        position: { x: gx + FRAME_PAD + (i % perRow) * (NODE_W + GAP), y: y + FRAME_PAD + FRAME_LABEL + rowY[Math.floor(i / perRow)]! },
        data: c.data,
        draggable: false
      })
    })
    gx += w + GAP * 2
    rowH = Math.max(rowH, h)
    maxW = Math.max(maxW, gx - GAP * 2)
  }
  if (groupList.length) y += rowH + LANE_GAP * 1.5

  // 2. lanes
  const wfName = new Map(snap.workflows.map((w) => [w.id, w.name]))
  const lanes = new Map<string, Lane>()
  const lane = (key: string, label: string): Lane => {
    let l = lanes.get(key)
    if (!l) lanes.set(key, (l = { key, label, runs: [], schedules: [] }))
    return l
  }
  const scheduleById = new Map(snap.schedules.map((s) => [s.id, s]))
  for (const rd of snap.runs) {
    const r = rd.run
    if (r.workflowId) lane(`wf:${r.workflowId}`, rd.workflow?.name ?? wfName.get(r.workflowId) ?? r.title).runs.push(rd)
    else if (r.scheduleId) lane(`sch:${r.scheduleId}`, scheduleById.get(r.scheduleId)?.name ?? 'Scheduled prompt').runs.push(rd)
    else lane('prompts', 'Prompts').runs.push(rd)
  }
  for (const sch of snap.schedules) {
    const t = sch.target
    if (t.kind === 'workflow') lane(`wf:${t.workflowId}`, wfName.get(t.workflowId) ?? sch.name).schedules.push(sch)
    else lane(`sch:${sch.id}`, sch.name).schedules.push(sch)
  }
  const lastAt = (l: Lane): string => l.runs.reduce((m, rd) => (runAt(rd) > m ? runAt(rd) : m), '')
  const laneList = [...lanes.values()].sort((a, b) => {
    const aa = a.runs.some(isActive) ? 1 : 0
    const ba = b.runs.some(isActive) ? 1 : 0
    if (aa !== ba) return ba - aa
    if (!a.runs.length !== !b.runs.length) return a.runs.length ? -1 : 1
    return lastAt(b) > lastAt(a) ? 1 : lastAt(b) < lastAt(a) ? -1 : 0
  })

  for (const ln of laneList) {
    const gid = `f:lane:${ln.key}`
    const inner: GraphNode[] = []
    const innerEdges: Edge[] = []
    let cx = CONTENT_X + GROUP_PAD
    const top = y + GROUP_LABEL
    let contentH = 0
    const sorted = [...ln.runs].sort((a, b) => (isActive(a) !== isActive(b) ? (isActive(a) ? -1 : 1) : runAt(b) > runAt(a) ? 1 : -1))
    const active = sorted.filter(isActive)
    const finished = sorted.filter((rd) => !isActive(rd))
    // only the newest run is expanded (all active ones while something runs); the rest fold into one chip
    const expandFinished = active.length ? 0 : 1
    const expanded = [...active, ...finished.slice(0, expandFinished)]
    const collapsed = finished.slice(expandFinished)

    for (const rd of expanded) {
      const prefix = `r:${rd.run.id}:`
      const { items, edges: le } = workflowLocal(rd.workflow, rd, snap.profiles, now)
      decorate(items, overlay)
      const { pos, w, h } = layout(items, le)
      const hasLoop = le.some((e) => e.kind === 'loop')
      const fw = Math.max(w + FRAME_PAD * 2, 200)
      const fh = h + FRAME_PAD * 2 + FRAME_LABEL + (hasLoop ? 18 : 0)
      const label = ln.key === 'prompts' || ln.key.startsWith('sch:') ? runTitle(rd.run) : when(runAt(rd), now)
      const trig = rd.run.trigger === 'schedule' || rd.run.trigger === 'catchup' ? '◷ ' : ''
      const f = frame(`f:run:${rd.run.id}`, `${trig}${label}`, cx, top, fw, fh, { kind: 'run', runId: rd.run.id }, runVisual(rd.run.status))
      f.data.meta = runDuration(rd, now)
      inner.push(f)
      for (const it of items) {
        const p = pos.get(it.id)!
        inner.push({ id: prefix + it.id, type: 'card', position: { x: cx + FRAME_PAD + p.x, y: top + FRAME_PAD + FRAME_LABEL + p.y }, data: it.data, draggable: false })
      }
      innerEdges.push(...toFlowEdges(prefix, le))
      cx += fw + GAP
      contentH = Math.max(contentH, fh)
    }

    if (collapsed.length) {
      const passed = collapsed.filter((rd) => rd.run.status === 'passed').length
      const failed = collapsed.filter((rd) => rd.run.status === 'failed').length
      const tally = [passed ? `${passed} ✓` : '', failed ? `${failed} ✕` : ''].filter(Boolean).join(' ')
      const newest = collapsed[0]!
      inner.push({
        id: `c:${ln.key}`,
        type: 'card',
        position: { x: cx, y: top },
        draggable: false,
        data: {
          label: `${collapsed.length} earlier run${collapsed.length === 1 ? '' : 's'}`,
          sub: [tally, `last ${when(runAt(newest), now)}`].filter(Boolean).join(' · '),
          status: 'idle',
          adapter: null,
          compact: true,
          ref: { kind: 'run', runId: newest.run.id }
        }
      })
      cx += NODE_W + GAP
      contentH = Math.max(contentH, COMPACT_H)
    }

    if (!ln.runs.length) {
      // ghost target: scheduled but nothing has run in the window yet
      const next = ln.schedules.map((s) => s.nextFireAt).filter(Boolean).sort()[0] ?? null
      const g = frame(`f:ghost:${ln.key}`, 'Not run yet', cx, top, 220, NODE_H + 14, null, null)
      g.data.variant = 'ghost'
      g.data.note = next ? `First run ${countdown(next, now)}` : 'Waiting for its schedule'
      inner.push(g)
      cx += 220 + GAP
      contentH = Math.max(contentH, NODE_H + 14)
    }

    const schedH = ln.schedules.length * (NODE_H + GAP) - GAP
    const gh = GROUP_LABEL + Math.max(contentH, 0) + GROUP_PAD
    const laneH = Math.max(gh, schedH)
    const gw = cx - GAP - CONTENT_X + GROUP_PAD
    const group = frame(gid, ln.label, CONTENT_X, y, gw, gh, null, null)
    group.data.variant = 'group'
    group.zIndex = -2
    group.data.meta = ln.runs.length ? `${ln.runs.length} run${ln.runs.length === 1 ? '' : 's'} · 24h` : undefined
    nodes.push(group, ...inner)
    edges.push(...innerEdges)
    ln.schedules.forEach((sch, i) => {
      nodes.push(scheduleNode(sch, 0, y + i * (NODE_H + GAP) + (ln.schedules.length === 1 ? Math.max(0, (gh - NODE_H) / 2) : 0), now))
      edges.push(scheduleEdge(sch.id, gid))
    })
    y += laneH + LANE_GAP
    maxW = Math.max(maxW, CONTENT_X + gw)
  }
  return { nodes, edges, width: Math.max(maxW, NODE_W), height: y }
}

function scheduleNode(s: Schedule, x: number, y: number, now: number): CardNode {
  return {
    id: `sch:${s.id}`,
    type: 'card',
    position: { x, y },
    draggable: false,
    data: {
      label: s.name,
      sub: `◷ ${countdown(s.nextFireAt, now)}`,
      status: 'scheduled',
      adapter: null,
      ref: { kind: 'schedule', scheduleId: s.id },
      countdownTo: s.nextFireAt
    }
  }
}

function scheduleEdge(scheduleId: string, targetId: string): Edge {
  return {
    id: `e:sch:${scheduleId}`,
    source: `sch:${scheduleId}`,
    target: targetId,
    type: 'smoothstep',
    style: { stroke: SCHEDULED_COLOR, strokeDasharray: '5 4', strokeWidth: 1.5 }
  }
}

/** Merge a live run/step update into a canvas snapshot (immutable). */
export function applyRunUpdate(snap: CanvasSnapshot, run: RunDetail['run']): CanvasSnapshot {
  const i = snap.runs.findIndex((r) => r.run.id === run.id)
  if (i < 0) return { ...snap, runs: [{ run, steps: [], workflow: null }, ...snap.runs] }
  const runs = [...snap.runs]
  runs[i] = { ...runs[i]!, run }
  return { ...snap, runs }
}
export function applyStepUpdate(snap: CanvasSnapshot, step: RunStep): CanvasSnapshot {
  const i = snap.runs.findIndex((r) => r.run.id === step.runId)
  if (i < 0) return snap
  const rd = snap.runs[i]!
  const j = rd.steps.findIndex((s) => s.id === step.id)
  const steps = j < 0 ? [...rd.steps, step] : rd.steps.map((s) => (s.id === step.id ? step : s))
  const runs = [...snap.runs]
  runs[i] = { ...rd, steps }
  return { ...snap, runs }
}
export function applySessionUpdate(snap: CanvasSnapshot, s: Session): CanvasSnapshot {
  const j = snap.sessions.findIndex((x) => x.id === s.id)
  const sessions = j < 0 ? [s, ...snap.sessions] : snap.sessions.map((x) => (x.id === s.id ? s : x))
  return { ...snap, sessions }
}
export function applyScheduleUpdate(snap: CanvasSnapshot, s: Schedule): CanvasSnapshot {
  const others = snap.schedules.filter((x) => x.id !== s.id)
  return { ...snap, schedules: s.enabled ? [...others, s] : others }
}
