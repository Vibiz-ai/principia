/**
 * DIAGRAMS.md: the `principia-graph` block. Agents write a small JSON object in a fenced block; Principia draws it
 * wherever text is read (agent answers, task briefs, forum posts, vault notes). Agents never write coordinates.
 *
 * Browser-safe and pure (zod only): the schema, the limits, the parser with readable path-based errors, and the
 * splitter that finds blocks in plain text.
 */
import { z } from 'zod'

export const DIAGRAM_FENCE = 'principia-graph'

export const DIAGRAM_LIMITS = { nodes: 150, edges: 300, bytes: 32 * 1024, steps: 40, label: 80, detail: 4000, id: 64 } as const

export const NODE_KINDS = [
  'client',
  'service',
  'database',
  'queue',
  'storage',
  'external',
  'person',
  'function',
  'file',
  'decision',
  'note',
  'task',
  'milestone',
  'metric',
  'group'
] as const
export type DiagramNodeKind = (typeof NODE_KINDS)[number]

export const EDGE_KINDS = ['flow', 'call', 'data', 'async', 'depends', 'blocks'] as const
export type DiagramEdgeKind = (typeof EDGE_KINDS)[number]

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done'] as const
export type DiagramTaskStatus = (typeof TASK_STATUSES)[number]

const id = z.string().trim().min(1).max(DIAGRAM_LIMITS.id)

export const diagramNodeSchema = z.object({
  id,
  kind: z.enum(NODE_KINDS),
  label: z.string().trim().min(1).max(DIAGRAM_LIMITS.label),
  detail: z.string().max(DIAGRAM_LIMITS.detail).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  group: id.optional()
})

export const diagramEdgeSchema = z.object({
  from: id,
  to: id,
  kind: z.enum(EDGE_KINDS).optional(),
  label: z.string().trim().max(DIAGRAM_LIMITS.label).optional()
})

export const diagramStepSchema = z.object({
  title: z.string().trim().min(1).max(DIAGRAM_LIMITS.label),
  focus: z.array(id).max(DIAGRAM_LIMITS.nodes),
  text: z.string().max(DIAGRAM_LIMITS.detail)
})

export const diagramSchema = z.object({
  title: z.string().trim().max(120).optional(),
  direction: z.enum(['right', 'down']).optional(),
  nodes: z.array(diagramNodeSchema).min(1).max(DIAGRAM_LIMITS.nodes),
  edges: z.array(diagramEdgeSchema).max(DIAGRAM_LIMITS.edges).default([]),
  steps: z.array(diagramStepSchema).max(DIAGRAM_LIMITS.steps).optional()
})

export type DiagramNode = z.infer<typeof diagramNodeSchema>
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>
export type DiagramStep = z.infer<typeof diagramStepSchema>
export type Diagram = z.infer<typeof diagramSchema>

/**
 * `warnings` lists what the parser fixed or left out instead of failing the whole block: a status it mapped or
 * dropped, a self-loop, an edge between a node and its own group.
 */
export type DiagramParse = { ok: true; diagram: Diagram; raw: string; warnings: string[] } | { ok: false; error: string; raw: string; tooLarge?: boolean }

/**
 * Status words agents (and the Board) use that are not one of TASK_STATUSES. One wrong status should never cost the
 * whole diagram, so these map to the closest of the five; anything else is dropped with a warning.
 */
const STATUS_ALIASES: Record<string, DiagramTaskStatus> = {
  review: 'in_review',
  reviewing: 'in_review',
  inreview: 'in_review',
  needs_review: 'in_review',
  backlog: 'todo',
  triage: 'todo',
  open: 'todo',
  pending: 'todo',
  planned: 'todo',
  not_started: 'todo',
  new: 'todo',
  doing: 'in_progress',
  inprogress: 'in_progress',
  progress: 'in_progress',
  started: 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  wip: 'in_progress',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  shipped: 'done',
  closed: 'done',
  merged: 'done',
  stuck: 'blocked',
  on_hold: 'blocked',
  waiting: 'blocked'
}

/** The task status a word stands for ("In Review", "in-review", "review" → in_review), or null when there is none. */
export function normalizeStatus(v: unknown): DiagramTaskStatus | null {
  if (typeof v !== 'string') return null
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if ((TASK_STATUSES as readonly string[]).includes(k)) return k as DiagramTaskStatus
  return STATUS_ALIASES[k] ?? STATUS_ALIASES[k.replace(/_/g, '')] ?? null
}

/** Maps or drops node statuses that are not one of the five, before the schema sees them. */
function forgiveStatuses(data: unknown, warnings: string[]): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const o = data as { nodes?: unknown }
  if (!Array.isArray(o.nodes)) return data
  const nodes = o.nodes.map((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || !('status' in n)) return n
    const node = n as Record<string, unknown>
    const st = node.status
    if (st === undefined || (typeof st === 'string' && (TASK_STATUSES as readonly string[]).includes(st))) return n
    const mapped = normalizeStatus(st)
    if (st === null || (typeof st === 'string' && !st.trim())) {
      const { status: _drop, ...rest } = node
      return rest
    }
    if (mapped) {
      warnings.push(`nodes[${i}].status "${String(st)}" read as ${mapped}`)
      return { ...node, status: mapped }
    }
    warnings.push(`nodes[${i}].status "${String(st)}" left out (use one of ${TASK_STATUSES.join(', ')})`)
    const { status: _drop, ...rest } = node
    return rest
  })
  return { ...o, nodes }
}

/** `nodes[3].kind` from a zod path. */
export function pathLabel(path: readonly PropertyKey[]): string {
  let s = ''
  for (const p of path) s += typeof p === 'number' ? `[${p}]` : s ? `.${String(p)}` : String(p)
  return s || 'The diagram'
}

function at(data: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = data
  for (const p of path) {
    if (v == null || typeof v !== 'object') return undefined
    v = (v as Record<PropertyKey, unknown>)[p]
  }
  return v
}

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? 'text' : `a ${typeof v}`)

/** One readable sentence for the first zod issue: "nodes[3].kind must be one of client, service, …". */
function issueText(issue: z.core.$ZodIssue, data: unknown): string {
  const where = pathLabel(issue.path)
  const value = at(data, issue.path)
  switch (issue.code) {
    case 'invalid_value':
      return `${where} must be one of ${issue.values.map(String).join(', ')}`
    case 'invalid_type':
      if (value === undefined) return `${where} is required`
      return `${where} must be ${issue.expected === 'string' ? 'text' : issue.expected === 'array' ? 'a list' : issue.expected === 'object' ? 'an object' : `a ${issue.expected}`}, not ${typeName(value)}`
    case 'too_small':
      return issue.origin === 'array' ? `${where} needs at least ${String(issue.minimum)} item${Number(issue.minimum) === 1 ? '' : 's'}` : `${where} can't be empty`
    case 'too_big':
      return issue.origin === 'array' ? `${where} can have at most ${String(issue.maximum)} items` : `${where} is too long (at most ${String(issue.maximum)} characters)`
    default:
      return `${where}: ${issue.message}`
  }
}

/**
 * Parses the body of a `principia-graph` block. Never throws. Checks, in order: size (before JSON.parse, so a huge
 * block costs nothing), JSON, node/edge counts ("too large"), the schema, then references (unique ids, edges and
 * steps naming real nodes, groups one level deep).
 */
export function parseDiagram(raw: string): DiagramParse {
  const fail = (error: string, tooLarge = false): DiagramParse => ({ ok: false, error, raw, ...(tooLarge ? { tooLarge } : {}) })
  const bytes = new TextEncoder().encode(raw).length
  if (bytes > DIAGRAM_LIMITS.bytes) return fail(`This diagram is too large to draw: ${Math.ceil(bytes / 1024)} KB (the limit is 32 KB).`, true)
  if (!raw.trim()) return fail('The block is empty. Write a JSON object with nodes and edges.')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return fail(`The JSON doesn't parse: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as { nodes?: unknown; edges?: unknown }
    if (Array.isArray(o.nodes) && o.nodes.length > DIAGRAM_LIMITS.nodes)
      return fail(`This diagram is too large to draw: ${o.nodes.length} nodes (the limit is ${DIAGRAM_LIMITS.nodes}).`, true)
    if (Array.isArray(o.edges) && o.edges.length > DIAGRAM_LIMITS.edges)
      return fail(`This diagram is too large to draw: ${o.edges.length} edges (the limit is ${DIAGRAM_LIMITS.edges}).`, true)
  }
  const warnings: string[] = []
  data = forgiveStatuses(data, warnings)
  const r = diagramSchema.safeParse(data)
  if (!r.success) return fail(issueText(r.error.issues[0]!, data))
  const d = r.data
  const byId = new Map<string, DiagramNode>()
  for (const [i, n] of d.nodes.entries()) {
    if (byId.has(n.id)) return fail(`nodes[${i}].id "${n.id}" is used twice`)
    byId.set(n.id, n)
  }
  // agents often name a group without declaring it ("group": "Foundations"): the group is made for them
  const made: DiagramNode[] = []
  for (const [i, n] of d.nodes.entries()) {
    if (!n.group || byId.has(n.group)) continue
    if (d.nodes.length + made.length >= DIAGRAM_LIMITS.nodes) return fail(`nodes[${i}].group "${n.group}" is not a node id`)
    const g: DiagramNode = { id: n.group, kind: 'group', label: n.group.slice(0, DIAGRAM_LIMITS.label) }
    byId.set(g.id, g)
    made.push(g)
    warnings.push(`group "${n.group}" was not a node, so it was added`)
  }
  d.nodes.push(...made)
  for (const [i, n] of d.nodes.entries()) {
    if (!n.group) continue
    const g = byId.get(n.group)!
    if (g.kind !== 'group') return fail(`nodes[${i}].group "${n.group}" must point at a node of kind group`)
    if (n.kind === 'group') return fail(`nodes[${i}] is a group inside a group; groups nest one level only`)
  }
  for (const [i, e] of d.edges.entries()) {
    if (!byId.has(e.from)) return fail(`edges[${i}].from "${e.from}" is not a node id`)
    if (!byId.has(e.to)) return fail(`edges[${i}].to "${e.to}" is not a node id`)
  }
  // edges that can't be drawn as a line between two cards: left out, with a warning, rather than drawn as stubs
  d.edges = d.edges.filter((e, i) => {
    if (e.from === e.to) {
      warnings.push(`edges[${i}] from "${e.from}" to itself left out`)
      return false
    }
    if (byId.get(e.from)?.group === e.to || byId.get(e.to)?.group === e.from) {
      warnings.push(`edges[${i}] between "${e.from}" and "${e.to}" left out: a node already sits inside its group`)
      return false
    }
    return true
  })
  for (const [i, s] of (d.steps ?? []).entries()) {
    const j = s.focus.findIndex((f) => !byId.has(f))
    if (j >= 0) return fail(`steps[${i}].focus[${j}] "${s.focus[j]}" is not a node id`)
  }
  return { ok: true, diagram: d, raw, warnings }
}

export type TextSegment = { t: 'text'; v: string } | { t: 'diagram'; raw: string; closed: boolean }

const OPEN_RE = new RegExp(`^ {0,3}(\`{3,}|~{3,})\\s*${DIAGRAM_FENCE}\\s*$`)

/** true when the text holds at least one ```principia-graph fence (cheap check before splitting). */
export const hasDiagram = (text: string | null | undefined): boolean => !!text && text.includes(DIAGRAM_FENCE) && splitDiagrams(text).some((s) => s.t === 'diagram')

/**
 * Splits plain text (agent answers, forum posts, task briefs) into prose and diagram blocks. Only the
 * `principia-graph` fence is taken; other fences stay in the prose. An unclosed fence runs to the end (closed: false).
 */
export function splitDiagrams(text: string): TextSegment[] {
  const lines = text.split(/\r?\n/)
  const out: TextSegment[] = []
  let prose: string[] = []
  const flush = (): void => {
    const v = prose.join('\n')
    if (v.trim()) out.push({ t: 'text', v: v.replace(/^\n+|\n+$/g, '') })
    prose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_RE.exec(lines[i]!)
    if (!m) {
      prose.push(lines[i]!)
      continue
    }
    const fence = m[1]!
    const body: string[] = []
    let closed = false
    i++
    for (; i < lines.length; i++) {
      const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!)
      if (c && c[1]![0] === fence[0] && c[1]!.length >= fence.length) {
        closed = true
        break
      }
      body.push(lines[i]!)
    }
    flush()
    out.push({ t: 'diagram', raw: body.join('\n'), closed })
  }
  flush()
  return out
}

/** What the Visualize action asks the agent (chat composer, ⌘K, forum /visualize). */
export const visualizePrompt = (what: string): string => `Draw ${what.trim().replace(/[.\s]+$/, '')} as a ${DIAGRAM_FENCE}.`

/**
 * The Forum `/visualize @agent what` message, or null when it would go unanswered: without an @agent nobody is asked,
 * and without a subject there is nothing to draw.
 */
export function forumVisualizeAsk(handles: readonly string[], what: string): string | null {
  if (!handles.length || !what.trim()) return null
  return `${handles.map((h) => `@${h} `).join('')}${visualizePrompt(what)}`
}
