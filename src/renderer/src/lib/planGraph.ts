/**
 * PLANS.md §3: the plan graph. Milestones are white-outlined frames laid out left to right by dependsOn (dagre),
 * tasks are cards inside them (dagre on blockers) with a status glyph, each milestone ends in its gate card, and
 * blockers are dashed lines. Pure: the Plans view renders it with GraphView (@xyflow/react).
 */
import dagre from '@dagrejs/dagre'
import type { Edge } from '@xyflow/react'
import type { CompanyTask, TaskStatus } from '@shared/company'
import { milestoneComplete, type Milestone, type Plan } from '@shared/plans'
import { type CardNode, type FrameNode, type Graph, type GraphNode, type VisualStatus } from './graph'

/** plan cards are wider and two lines tall, so titles wrap instead of cutting off (plans.css matches) */
export const NODE_W = 200
export const NODE_H = 58
const PAD = 14
const LABEL = 26
const EDGE = 'var(--edge)'

export function taskVisual(s: TaskStatus | undefined): VisualStatus {
  switch (s) {
    case 'in_progress': return 'running'
    case 'in_review': return 'scheduled'
    case 'done': return 'passed'
    case 'blocked': return 'failed'
    case 'canceled': return 'canceled'
    case 'todo': return 'queued'
    default: return 'idle'
  }
}
const STATUS_TEXT: Record<TaskStatus, string> = { triage: 'inbox', backlog: 'not started', todo: 'next', in_progress: 'working', in_review: 'in review', blocked: 'blocked', done: 'done', canceled: 'canceled' }

export const taskNodeId = (taskId: string) => `task:${taskId}`
export const gateNodeId = (milestoneId: string) => `gate:${milestoneId}`
export const frameNodeId = (milestoneId: string) => `m:${milestoneId}`

function gateText(p: Plan, m: Milestone): { sub: string; status: VisualStatus } {
  if (milestoneComplete(p, m)) return { sub: m.passedAt ? 'passed by you' : 'passed', status: 'passed' }
  if (m.gate.result === 'pass') return { sub: 'checked · waiting for you', status: 'scheduled' }
  if (m.gate.result === 'fail') return { sub: 'failed · fix tasks added', status: 'failed' }
  return { sub: 'not checked yet', status: 'idle' }
}

export function planGraph(p: Plan, tasks: readonly CompanyTask[], agentName: (id: string | null) => string = () => '', waits: Readonly<Record<string, string>> = {}): Graph {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const nodes: GraphNode[] = []
  const edges: Edge[] = []
  // inner layouts first: each milestone's size feeds the outer layout
  const inner = new Map<string, { pos: Map<string, { x: number; y: number }>; w: number; h: number }>()
  for (const m of p.milestones) {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 40, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    const own = p.tasks.filter(t => t.milestoneId === m.id)
    for (const t of own) g.setNode(t.id, { width: NODE_W, height: NODE_H })
    g.setNode(gateNodeId(m.id), { width: NODE_W, height: NODE_H })
    for (const t of own) for (const b of t.blockers) if (own.some(x => x.id === b)) g.setEdge(b, t.id)
    // the gate comes after every task nothing else in the milestone waits for
    for (const t of own) if (!own.some(x => x.blockers.includes(t.id))) g.setEdge(t.id, gateNodeId(m.id))
    dagre.layout(g)
    const pos = new Map<string, { x: number; y: number }>()
    let w = NODE_W, h = NODE_H
    for (const id of g.nodes()) {
      const n = g.node(id) as { x: number; y: number }
      const x = n.x - NODE_W / 2, y = n.y - NODE_H / 2
      pos.set(id, { x, y })
      w = Math.max(w, x + NODE_W); h = Math.max(h, y + NODE_H)
    }
    inner.set(m.id, { pos, w, h })
  }
  const outer = new dagre.graphlib.Graph()
  outer.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 70, marginx: 0, marginy: 0 })
  outer.setDefaultEdgeLabel(() => ({}))
  for (const m of p.milestones) { const i = inner.get(m.id)!; outer.setNode(m.id, { width: i.w + PAD * 2, height: i.h + PAD * 2 + LABEL }) }
  for (const m of p.milestones) for (const d of m.dependsOn) if (outer.hasNode(d)) outer.setEdge(d, m.id)
  dagre.layout(outer)
  let width = 0, height = 0
  for (const m of p.milestones) {
    const i = inner.get(m.id)!
    const n = outer.node(m.id) as { x: number; y: number; width: number; height: number }
    const fx = n.x - n.width / 2, fy = n.y - n.height / 2
    width = Math.max(width, fx + n.width); height = Math.max(height, fy + n.height)
    const done = milestoneComplete(p, m)
    const rows = p.tasks.filter(t => t.milestoneId === m.id).map(t => t.taskId ? byId.get(t.taskId) : undefined)
    const live = rows.some(t => t?.status === 'in_progress')
    const frame: FrameNode = {
      id: frameNodeId(m.id), type: 'frame', position: { x: fx, y: fy },
      data: { label: `${m.key} · ${m.title}`, width: n.width, height: n.height, ref: { kind: 'wfnode', nodeId: frameNodeId(m.id) }, status: done ? 'passed' : live ? 'running' : null, variant: 'group', meta: agentName(m.agentId) || undefined },
      draggable: false, selectable: false, zIndex: -1, style: { width: n.width, height: n.height }
    }
    nodes.push(frame)
    // a ready milestone that has not started says why on its next card (QA: it waited silently)
    const waitOn = waits[m.id] ? p.tasks.find(x => x.milestoneId === m.id && x.taskId && ['backlog', 'todo'].includes(byId.get(x.taskId)?.status ?? ''))?.id : undefined
    for (const t of p.tasks.filter(x => x.milestoneId === m.id)) {
      const row = t.taskId ? byId.get(t.taskId) : undefined
      const at = i.pos.get(t.id)!
      const card: CardNode = {
        id: t.taskId ? taskNodeId(t.taskId) : `draft:${t.id}`, type: 'card', position: { x: fx + PAD + at.x, y: fy + PAD + LABEL + at.y },
        data: {
          label: t.title, sub: row ? `${row.identifier} · ${t.id === waitOn ? waits[m.id] : STATUS_TEXT[row.status]}${t.fix ? ' · fix' : ''}` : t.touches.length ? t.touches.slice(0, 2).join(', ') : 'draft',
          status: taskVisual(row?.status), adapter: null, ref: { kind: 'wfnode', nodeId: t.taskId ? taskNodeId(t.taskId) : `draft:${t.id}` }
        },
        draggable: false
      }
      nodes.push(card)
    }
    const gate = gateText(p, m)
    const gp = i.pos.get(gateNodeId(m.id))!
    nodes.push({ id: gateNodeId(m.id), type: 'card', position: { x: fx + PAD + gp.x, y: fy + PAD + LABEL + gp.y }, data: { label: 'Gate', sub: gate.sub, status: gate.status, adapter: null, ref: { kind: 'wfnode', nodeId: gateNodeId(m.id) }, compact: false }, draggable: false })
  }
  const nodeOf = (planTaskId: string) => { const t = p.tasks.find(x => x.id === planTaskId); return t ? (t.taskId ? taskNodeId(t.taskId) : `draft:${t.id}`) : null }
  for (const t of p.tasks) {
    const to = nodeOf(t.id)
    for (const b of t.blockers) {
      const from = nodeOf(b)
      if (from && to) edges.push({ id: `b:${b}->${t.id}`, source: from, target: to, type: 'smoothstep', className: 'edge-blocker', style: { stroke: EDGE, strokeDasharray: '5 4', strokeWidth: 1.4 } })
    }
    if (to && !p.tasks.some(x => x.milestoneId === t.milestoneId && x.blockers.includes(t.id))) edges.push({ id: `g:${t.id}`, source: to, target: gateNodeId(t.milestoneId), type: 'smoothstep', style: { stroke: EDGE, strokeWidth: 1.2, opacity: 0.6 } })
  }
  for (const m of p.milestones) for (const d of m.dependsOn) edges.push({ id: `m:${d}->${m.id}`, source: gateNodeId(d), target: frameNodeId(m.id), type: 'smoothstep', style: { stroke: EDGE, strokeWidth: 1.6 } })
  return { nodes, edges, width, height }
}
