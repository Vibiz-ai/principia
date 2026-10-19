/** Pure helpers for the Memory page and the memory controls elsewhere (MEMORY.md §10). No DOM, no IPC. */
import type { AdapterId, ProviderInfo, WorkflowNode } from '@shared/types'
import type { MemoryEntity, MemoryFact, MemoryFactKind, MemoryMode, MemoryProvenance, MemoryScoreWhy } from '@shared/memory'

const DAY = 86_400_000

// ---------- modes (editor, settings, sessions) ----------
export const MEMORY_MODE_LABEL: Record<MemoryMode, string> = { off: 'Off', read: 'Read', 'read-write': 'Read & write' }

/** CONTRACT §11.3: shell steps and command checks never get memory; agent-reviewer checks read only. */
export function allowedMemoryModes(n: WorkflowNode): MemoryMode[] {
  if (n.type === 'shell' || n.type === 'wait' || n.type === 'notify') return ['off']
  if (n.type === 'check') return n.command !== null ? ['off'] : ['off', 'read']
  return ['off', 'read', 'read-write']
}

/** Renderer mirror of the engine's validation rule (engine validate.ts is normative). null = ok. */
export function memoryProblem(n: WorkflowNode): string | null {
  const m = n.memory
  if (m === undefined || m === 'off') return null
  if (m !== 'read' && m !== 'read-write') return `Step "${n.id}": unknown memory mode "${String(m)}"`
  if (allowedMemoryModes(n).includes(m)) return null
  if (n.type === 'shell' || n.type === 'wait' || n.type === 'notify' || (n.type === 'check' && n.command !== null)) return `Step "${n.id}": ${n.type === 'notify' ? 'notify' : n.type === 'wait' ? 'wait' : 'shell'} steps cannot use memory`
  return `Check "${n.id}": reviewer checks can only read memory`
}

/** "(injected)" for adapters without MCP (cursor, and codex/gemini until verified). */
export function transportNote(adapters: AdapterId[], providers: ProviderInfo[]): string | null {
  const inject = adapters.filter((a) => providers.find((p) => p.id === a)?.memory === 'inject')
  if (!inject.length) return null
  return inject.length === adapters.length ? 'injected: the agent gets a memory brief in its prompt, without memory tools' : 'some agents get the brief only (no memory tools)'
}

// ---------- entity look ----------
/** 8 fixed hues from tokens.css; known types first, unknown types map by hash. */
const TYPE_HUES = ['--accent', '--status-success', '--provider-codex', '--provider-claude', '--status-scheduled', '--status-warning', '--status-running', '--status-idle'] as const
const KNOWN_TYPE: Record<string, (typeof TYPE_HUES)[number]> = {
  component: '--accent',
  api: '--status-success',
  library: '--provider-codex',
  person: '--provider-claude',
  concept: '--status-scheduled',
  task: '--status-warning',
  env: '--status-running',
  file: '--status-idle'
}
export function entityHue(type: string): string {
  const t = type.trim().toLowerCase()
  const known = KNOWN_TYPE[t]
  if (known) return `var(${known})`
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return `var(${TYPE_HUES[h % TYPE_HUES.length]})`
}

export const ENTITY_TYPES = ['component', 'file', 'api', 'library', 'person', 'concept', 'task', 'env', 'other'] as const

/** PO8: entities changed in the last 7 days get the accent ring. */
export function isRecent(iso: string | null | undefined, now = Date.now(), days = 7): boolean {
  if (!iso) return false
  return now - new Date(iso).getTime() < days * DAY
}

/** Pill size: width from the label, height grows with sqrt(active facts). Static sizes, never measured. */
export function entityNodeSize(e: Pick<MemoryEntity, 'name' | 'type' | 'counts'>, marks = 0): { width: number; height: number } {
  // ~7.6px per char of 12px Geist medium, plus dot + paddings (36) and badges
  // the small-caps type line (~6.6px/char) can be wider than a short name
  const label = Math.min(Math.max(e.name.length, Math.ceil(e.type.length * 0.9)), 28)
  const badges = (e.counts.active > 0 ? 28 : 0) + (e.counts.pinned > 0 ? 18 : 0) + (e.counts.pending > 0 ? 18 : 0) + marks * 13
  const width = Math.round(Math.max(104, Math.min(260, 40 + label * 7.6 + badges)))
  const height = Math.round(34 + Math.min(14, Math.sqrt(e.counts.active) * 3))
  return { width, height }
}

// ---------- facts ----------
export const KIND_ORDER: MemoryFactKind[] = ['decision', 'convention', 'gotcha', 'fact']
export const KIND_LABEL: Record<MemoryFactKind, string> = { decision: 'Decisions', convention: 'Conventions', gotcha: 'Gotchas', fact: 'Facts' }

/** Inspector grouping: live facts (active + pending) by kind, pinned first then newest; history = invalid, newest first. */
export function groupFacts(facts: MemoryFact[]): { groups: { kind: MemoryFactKind; facts: MemoryFact[] }[]; history: MemoryFact[] } {
  const live = facts.filter((f) => f.status !== 'invalid')
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    facts: live.filter((f) => f.kind === kind).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.createdAt < b.createdAt ? 1 : -1))
  })).filter((g) => g.facts.length)
  const history = facts.filter((f) => f.status === 'invalid').sort((a, b) => ((a.invalidatedAt ?? a.updatedAt) < (b.invalidatedAt ?? b.updatedAt) ? 1 : -1))
  return { groups, history }
}

/** Supersede chain ending at `fact`, oldest first (excluding `fact`). Cycle-safe. */
export function supersedeChain(fact: MemoryFact, all: MemoryFact[]): MemoryFact[] {
  const byId = new Map(all.map((f) => [f.id, f]))
  const out: MemoryFact[] = []
  const seen = new Set<string>([fact.id])
  const walk = (f: MemoryFact): void => {
    for (const id of f.supersedes) {
      if (seen.has(id)) continue
      seen.add(id)
      const prev = byId.get(id)
      if (!prev) continue
      walk(prev)
      out.push(prev)
    }
  }
  walk(fact)
  return out
}

/** Agent-written, still active, not yet approved/edited by the user: gets a badge, not a queue (PO7). */
export function isUnreviewed(f: Pick<MemoryFact, 'actor' | 'reviewed' | 'status'>): boolean {
  return f.actor === 'agent' && !f.reviewed && f.status === 'active'
}

// ---------- provenance ----------
export function adapterName(a: AdapterId): string {
  return { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', shell: 'Shell' }[a]
}

/** One-line source label: "Claude · run “Nightly refactor” · build". "You" for user rows. */
export function sourceLabel(p: MemoryProvenance | null, opts: { unattributed?: boolean } = {}): string {
  if (opts.unattributed) return 'unknown agent'
  if (!p) return 'You'
  const parts = [p.profileName && p.profileName !== adapterName(p.adapter) ? `${adapterName(p.adapter)} (${p.profileName})` : adapterName(p.adapter)]
  if (p.runTitle) parts.push(`run “${p.runTitle}”`)
  else if (p.sessionId) parts.push('session')
  if (p.nodeLabel || p.nodeId) parts.push(p.nodeLabel || p.nodeId!)
  return parts.join(' · ')
}

/** Distinct runs that wrote the given rows, newest first (run filter picker). */
export function runsFrom(rows: { provenance: MemoryProvenance | null; createdAt: string }[]): { runId: string; title: string; at: string }[] {
  const m = new Map<string, { runId: string; title: string; at: string }>()
  for (const r of rows) {
    const p = r.provenance
    if (!p?.runId) continue
    const cur = m.get(p.runId)
    if (!cur || cur.at < r.createdAt) m.set(p.runId, { runId: p.runId, title: p.runTitle ?? p.runId, at: cur && cur.at > r.createdAt ? cur.at : r.createdAt })
  }
  return [...m.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
}

// ---------- filters the contract leaves to the client ----------
export type TimeWindow = 'any' | '24h' | '7d' | '30d'
export const TIME_WINDOW_LABEL: Record<TimeWindow, string> = { any: 'Any time', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }
export function withinWindow(iso: string, w: TimeWindow, now = Date.now()): boolean {
  if (w === 'any') return true
  const ms = w === '24h' ? DAY : w === '7d' ? 7 * DAY : 30 * DAY
  return now - new Date(iso).getTime() <= ms
}

// ---------- ranking explanation (PO5) ----------
const f2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)
export function whyText(why: MemoryScoreWhy): string {
  const head = why.exact ? 'exact name match' : `text match ${f2(why.bm25)}`
  return `${head} × scope ${f2(why.scope)} × trust ${f2(why.trust)} × recency ${f2(why.recency)}`
}

/** Escape hatch for strings the user types as a relation type: snake_case verb (2..40). */
export function normalizeRelationType(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

// ---------- what the graph shows without a click ----------
export const KIND_GLYPH: Record<MemoryFactKind, string> = { decision: '◆', convention: '≡', gotcha: '!', fact: '·' }
export const KIND_SINGULAR: Record<MemoryFactKind, string> = { decision: 'decision', convention: 'convention', gotcha: 'gotcha', fact: 'fact' }
/** Marks drawn on a node, in this order (plain facts get none: they are the default). */
export const MARK_KINDS: MemoryFactKind[] = ['gotcha', 'decision', 'convention']
const KIND_PRIORITY: Record<MemoryFactKind, number> = { gotcha: 0, decision: 1, convention: 2, fact: 3 }

/** Live facts grouped per entity (the page already loads them for the Facts tab). */
export function factsByEntity(facts: MemoryFact[]): Map<string, MemoryFact[]> {
  const m = new Map<string, MemoryFact[]>()
  for (const f of facts) {
    if (f.status === 'invalid') continue
    const list = m.get(f.entityId)
    if (list) list.push(f)
    else m.set(f.entityId, [f])
  }
  return m
}

/** Hover card order: pinned, then active before pending, then gotcha > decision > convention > fact, then newest. */
export function topFacts(facts: MemoryFact[], n = 3): MemoryFact[] {
  return facts
    .filter((f) => f.status !== 'invalid')
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(a.status === 'pending') - Number(b.status === 'pending') ||
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
        (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
    )
    .slice(0, n)
}

/** Which of the marked kinds an entity has live facts of, in MARK_KINDS order. */
export function kindMarks(facts: MemoryFact[] | undefined): MemoryFactKind[] {
  if (!facts?.length) return []
  const have = new Set(facts.filter((f) => f.status === 'active').map((f) => f.kind))
  return MARK_KINDS.filter((k) => have.has(k))
}

/** Entities that keep their label when zoomed out: the top n by degree, then facts, then name. */
export function landmarkIds(entities: Pick<MemoryEntity, 'id' | 'name' | 'degree' | 'counts'>[], n = 12): Set<string> {
  return new Set(
    [...entities]
      .sort((a, b) => b.degree * 2 + b.counts.active - (a.degree * 2 + a.counts.active) || a.name.localeCompare(b.name))
      .slice(0, n)
      .map((e) => e.id)
  )
}

/** Same normalization idea as the store's entity names: case, spacing and punctuation don't matter. */
export function nameKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./]+/g, ' ')
    .trim()
}

/** Project and global entities that share a name: id -> the other entity's id. */
export function nameTwins(entities: Pick<MemoryEntity, 'id' | 'name' | 'repoId'>[]): Map<string, string> {
  const globals = new Map<string, string>()
  for (const e of entities) if (e.repoId === null) globals.set(nameKey(e.name), e.id)
  const out = new Map<string, string>()
  for (const e of entities) {
    if (e.repoId === null) continue
    const g = globals.get(nameKey(e.name))
    if (!g) continue
    out.set(e.id, g)
    out.set(g, e.id)
  }
  return out
}

/** Type legend rows: every type on the graph, most common first. */
export function typeCounts(entities: Pick<MemoryEntity, 'type'>[]): { type: string; count: number }[] {
  const m = new Map<string, number>()
  for (const e of entities) {
    const t = e.type.trim().toLowerCase() || 'other'
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

/**
 * The always-included part of the agents' brief (search.ts buildBrief): active pinned facts, newest first,
 * until the 1,500-char pinned budget runs out. Lines are approximated as "name: text" (the brief adds a kind tag).
 */
export const BRIEF_PINNED_CHARS = 1500
export function briefPinned(facts: MemoryFact[]): { included: MemoryFact[]; overflow: MemoryFact[] } {
  const pinned = facts.filter((f) => f.status === 'active' && f.pinned).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  const included: MemoryFact[] = []
  const overflow: MemoryFact[] = []
  let used = 0
  let full = false
  for (const f of pinned) {
    const len = f.entityName.length + f.text.length + 16
    if (full || used + len > BRIEF_PINNED_CHARS) {
      full = true
      overflow.push(f)
      continue
    }
    included.push(f)
    used += len + 1
  }
  return { included, overflow }
}

/** Key knowledge per kind (gotchas, decisions, conventions): active, trusted first (pinned, yours/approved), newest. */
export function keyKnowledge(facts: MemoryFact[], perKind = 4): { kind: MemoryFactKind; facts: MemoryFact[]; total: number }[] {
  const trust = (f: MemoryFact): number => (f.pinned ? 2 : f.actor === 'user' || f.reviewed ? 1 : 0)
  return MARK_KINDS.map((kind) => {
    const all = facts.filter((f) => f.status === 'active' && f.kind === kind)
    all.sort((a, b) => trust(b) - trust(a) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return { kind, facts: all.slice(0, perKind), total: all.length }
  }).filter((g) => g.total > 0)
}

/** Entities with facts written in the last `days` that the capped overview doesn't show (newest first). */
export function recentOffGraph(facts: MemoryFact[], shown: Set<string>, now = Date.now(), days = 7, n = 5): { id: string; name: string }[] {
  const out = new Map<string, { id: string; name: string; at: string }>()
  for (const f of facts) {
    if (shown.has(f.entityId) || f.status === 'invalid' || !isRecent(f.createdAt, now, days)) continue
    const cur = out.get(f.entityId)
    if (!cur || cur.at < f.createdAt) out.set(f.entityId, { id: f.entityId, name: f.entityName, at: f.createdAt })
  }
  return [...out.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, n)
    .map(({ id, name }) => ({ id, name }))
}

/**
 * Mode a new node starts with (LIVE.md §7, F4): agent and room steps read and write project memory, reviewer checks
 * read, shell steps and command checks get none. Existing nodes keep what they had (absent = off).
 */
export function defaultMemoryMode(n: WorkflowNode): MemoryMode | undefined {
  const allowed = allowedMemoryModes(n)
  if (allowed.includes('read-write')) return 'read-write'
  return allowed.includes('read') ? 'read' : undefined
}

/** One-click mode for every step: each step gets the closest mode it allows (reviewer checks cap at Read). */
export function applyMemoryToAll<T extends WorkflowNode>(nodes: T[], mode: MemoryMode): T[] {
  return nodes.map((n) => {
    const allowed = allowedMemoryModes(n)
    if (allowed.length < 2) return n
    const m: MemoryMode = allowed.includes(mode) ? mode : mode === 'read-write' && allowed.includes('read') ? 'read' : 'off'
    return { ...n, memory: m === 'off' ? undefined : m }
  })
}

/** The workflow-wide mode shown in the editor: the shared mode of every memory-capable step, or 'mixed'. */
export function workflowMemoryMode(nodes: WorkflowNode[]): MemoryMode | 'mixed' | null {
  const capable = nodes.filter((n) => allowedMemoryModes(n).length > 1)
  if (!capable.length) return null
  // a reviewer check on Read counts as "Read & write" for the workflow when the rest write
  const modes = new Set(capable.map((n) => n.memory ?? 'off'))
  if (modes.size === 1) return [...modes][0]!
  const rw = capable.every((n) => (n.memory ?? 'off') === 'read-write' || (n.type === 'check' && (n.memory ?? 'off') === 'read'))
  return rw ? 'read-write' : 'mixed'
}
