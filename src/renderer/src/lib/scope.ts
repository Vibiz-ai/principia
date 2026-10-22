/**
 * Pure helpers for the company-scoped pages (COMPANY.md C6): which rows a page shows in focused vs All mode, the Keys
 * sections, the portfolio card lines, Canvas node labels and the Company settings hub-note edits. No hive / DOM
 * access, so the views and the tests share one implementation.
 */
import type { CompanyBadge } from './companyModel'
import { agentCompanyResolver, companyLabel, companyOf, isMultiCompany, type ActiveCompany } from './companyModel'
import type { CompanyPassport } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { VaultFact, VaultOp } from '@shared/passport'
import type { Id, Run, SecretMeta, Session } from '@shared/types'
import type { Graph, NodeRef } from './graph'

type Stamped = { companyId?: Id | null }

/** The companyId a scoped list call passes: undefined in All mode (every company). */
export function scopeOf(active: ActiveCompany): Id | undefined {
  return active === 'all' ? undefined : active
}

/** A row belongs on a page scoped to `scope` (undefined = All). NULL stamps read as Personal (§1.4). */
export function inScope(row: Stamped | null | undefined, scope: Id | undefined): boolean {
  return !scope || companyOf(row) === scope
}

export function scopeRows<T extends Stamped>(rows: readonly T[], scope: Id | undefined): T[] {
  return scope ? rows.filter((r) => companyOf(r) === scope) : [...rows]
}

/** All mode with more than Personal: rows carry a company chip (§8.3). */
export function showChips(companies: readonly Pick<CompanyPassport, 'id'>[], active: ActiveCompany): boolean {
  return isMultiCompany(companies) && active === 'all'
}

export interface CompanyGroup<T> {
  companyId: Id
  company: CompanyPassport | undefined
  rows: T[]
}
/** Rows grouped per company in rail order (Personal last); rows of an archived / unknown company follow. */
export function groupByCompany<T extends Stamped>(rows: readonly T[], companies: readonly CompanyPassport[], opts: { keepEmpty?: boolean } = {}): CompanyGroup<T>[] {
  const by = new Map<Id, T[]>()
  for (const r of rows) {
    const id = companyOf(r)
    const l = by.get(id)
    if (l) l.push(r)
    else by.set(id, [r])
  }
  const out: CompanyGroup<T>[] = []
  for (const c of companies) {
    const l = by.get(c.id)
    by.delete(c.id)
    if (l?.length || opts.keepEmpty) out.push({ companyId: c.id, company: c, rows: l ?? [] })
  }
  for (const [companyId, l] of by) out.push({ companyId, company: undefined, rows: l })
  return out
}

// ---------- live agents / asks ----------
/** The agents (roots and subagents) of one company; every agent in All mode. */
export function scopeAgents<A extends AgentNode & Stamped>(agents: readonly A[], sessions: Session[], scope: Id | undefined): A[] {
  if (!scope) return [...agents]
  const resolve = agentCompanyResolver(agents, sessions)
  return agents.filter((a) => resolve(a) === scope)
}

/** Open asks of one company: their own stamp, else their agent's company, else their session's. */
export function scopeAsks<Q extends Ask & Stamped>(asks: readonly Q[], agents: readonly (AgentNode & Stamped)[], sessions: Session[], scope: Id | undefined): Q[] {
  if (!scope) return [...asks]
  const resolve = agentCompanyResolver(agents, sessions)
  const byId = new Map(agents.map((a) => [a.id, a]))
  return asks.filter((q) => (q.companyId || resolve(byId.get(q.agentId) ?? byId.get(q.rootId), q.sessionId)) === scope)
}

// ---------- keys (§4) ----------
export interface KeySection {
  key: string
  /** null = the flat pre-company list (Personal-only user) */
  title: string | null
  /** where new keys of this section are stored: null = Shared */
  companyId: Id | null
  keys: SecretMeta[]
  /** All mode: a company's section (its keys are edited from inside the company) */
  company?: CompanyPassport
}
/**
 * The Keys page sections. Personal-only: one flat list. Focused: "This company" then "Shared". All mode: Shared,
 * then one section per company that has keys.
 */
export function keySections(list: readonly SecretMeta[], active: ActiveCompany, companies: readonly CompanyPassport[]): KeySection[] {
  const byName = (a: SecretMeta, b: SecretMeta): number => a.name.localeCompare(b.name)
  const shared = list.filter((k) => !k.companyId).sort(byName)
  if (!isMultiCompany(companies)) return [{ key: 'all', title: null, companyId: null, keys: [...list].sort(byName) }]
  if (active !== 'all') {
    return [
      { key: active, title: 'This company', companyId: active, keys: list.filter((k) => k.companyId === active).sort(byName) },
      { key: 'shared', title: 'Shared', companyId: null, keys: shared }
    ]
  }
  const out: KeySection[] = [{ key: 'shared', title: 'Shared', companyId: null, keys: shared }]
  for (const g of groupByCompany(list.filter((k) => !!k.companyId), companies)) {
    out.push({ key: g.companyId, title: g.company ? companyLabel(g.company, true) : 'Archived company', companyId: g.companyId, keys: g.rows.sort(byName), company: g.company })
  }
  return out
}

/** Shared names a company key of the same name overrides for `companyId` (§4: the company value wins). */
export function overriddenShared(list: readonly SecretMeta[], companyId: Id | null | undefined): Set<string> {
  if (!companyId) return new Set()
  const own = new Set(list.filter((k) => k.companyId === companyId).map((k) => k.name))
  return new Set(list.filter((k) => !k.companyId && own.has(k.name)).map((k) => k.name))
}

/** The keys an agent of `companyId` can receive: Shared plus that company's, one per name (company wins). */
export function keysForCompany(list: readonly SecretMeta[], companyId: Id | null | undefined): SecretMeta[] {
  const out = new Map<string, SecretMeta>()
  for (const k of list) if (!k.companyId) out.set(k.name, k)
  if (companyId) for (const k of list) if (k.companyId === companyId) out.set(k.name, k)
  return [...out.values()]
}

/** Stable identity of a key row: the same name may exist once Shared and once per company. */
export function keyId(k: Pick<SecretMeta, 'name' | 'companyId'>): string {
  return `${k.companyId ?? 'shared'}:${k.name}`
}

// ---------- portfolio (§8.5) ----------
/** Newest `n` runs per company. */
export function lastRunsByCompany(runs: readonly Run[], n = 3): Record<Id, Run[]> {
  const out: Record<Id, Run[]> = {}
  for (const r of [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))) {
    const l = (out[companyOf(r)] ??= [])
    if (l.length < n) l.push(r)
  }
  return out
}

/** "2 need you · 3 working", or "Quiet". */
export function statusLine(b: Pick<CompanyBadge, 'needsYou' | 'working'> | undefined): string {
  const bits: string[] = []
  if (b?.needsYou) bits.push(`${b.needsYou} need${b.needsYou === 1 ? 's' : ''} you`)
  if (b?.working) bits.push(`${b.working} working`)
  return bits.join(' · ') || 'Quiet'
}

/** The mission line on a card: first non-empty line, trimmed to `max` characters. */
export function missionLine(mission: string | null | undefined, max = 140): string {
  const line = (mission ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// ---------- Canvas (§8.3: All mode shows a company chip) ----------
export interface RefLookups {
  sessions: readonly (Session & Stamped)[]
  runs: readonly (Run & Stamped)[]
  schedules: readonly ({ id: Id } & Stamped)[]
}
/** The company of a Canvas node, or null for nodes that belong to no single company (repo lanes, history). */
export function companyOfRef(ref: NodeRef | null | undefined, l: RefLookups): Id | null {
  if (!ref) return null
  if (ref.kind === 'session') {
    const s = l.sessions.find((x) => x.id === ref.sessionId)
    return s ? companyOf(s) : null
  }
  if (ref.kind === 'run' || ref.kind === 'step') {
    const r = l.runs.find((x) => x.id === ref.runId)
    return r ? companyOf(r) : null
  }
  if (ref.kind === 'schedule') {
    const s = l.schedules.find((x) => x.id === ref.scheduleId)
    return s ? companyOf(s) : null
  }
  return null
}

/**
 * All mode: prefix top-level Canvas cards and workflow lanes with their company name ("Acme · claude · 3m"). Nested
 * agents and steps inside a lane inherit it visually and stay unlabelled.
 */
export function labelGraphCompanies(graph: Graph, l: RefLookups, nameOf: (id: Id) => string): Graph {
  let changed = false
  const nodes = graph.nodes.map((n) => {
    if (n.type === 'card') {
      if (n.data.nestedAgent || n.parentId) return n
      const id = companyOfRef(n.data.ref, l)
      if (!id) return n
      changed = true
      return { ...n, data: { ...n.data, sub: n.data.sub ? `${nameOf(id)} · ${n.data.sub}` : nameOf(id) } }
    }
    const id = companyOfRef(n.data.ref, l)
    if (!id) return n
    changed = true
    return { ...n, data: { ...n.data, meta: n.data.meta ? `${nameOf(id)} · ${n.data.meta}` : nameOf(id) } }
  })
  return changed ? { ...graph, nodes } : graph
}

// ---------- Company settings: profile fields in the hub note (PASSPORT.md §9.3, §10) ----------
/** Profile field → hub-note observation category, as the vault migration writes them. */
export const HUB_CATEGORY = {
  mission: 'mission',
  brandVoice: 'brand',
  audience: 'audience',
  products: 'product',
  goals: 'goal',
  context: 'context',
  constraints: 'constraint'
} as const
export type HubField = keyof typeof HUB_CATEGORY

/** The hub note's active observations of one category, in file order. */
export function hubFacts(facts: readonly VaultFact[], field: HubField): VaultFact[] {
  return facts.filter((f) => f.section === 'obs' && f.status === 'active' && f.category === HUB_CATEGORY[field]).sort((a, b) => a.line - b.line)
}

/** A field's current text: its observations joined one per line. */
export function hubFieldText(facts: readonly VaultFact[], field: HubField): string {
  return hubFacts(facts, field).map((f) => f.text).join('\n')
}

/**
 * Writer ops turning a field into `text` (semantic ops only, never a whole-file write, §6.4). One observation per
 * non-empty line, because the grammar keeps an observation on one line (a newline would be folded into a space).
 * Lines that still match an observation keep it untouched; the remaining changed lines supersede the remaining
 * observations in order (so their old text is kept in History), leftovers are invalidated and extra lines observed.
 * Clearing a field invalidates every observation. Unchanged text yields no ops.
 */
export function hubFieldOps(facts: readonly VaultFact[], field: HubField, text: string, note: string): VaultOp[] {
  const current = hubFacts(facts, field)
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.join('\n') === current.map((f) => f.text.trim()).join('\n')) return []
  const ref = (f: VaultFact): string => f.blockId ?? f.id
  if (!lines.length) return current.map((f) => ({ op: 'invalidate', blockId: ref(f), reason: 'Cleared in Company settings' }))
  // multiset match: an unchanged line keeps its observation, wherever it moved
  const added = [...lines]
  const left: VaultFact[] = []
  for (const f of current) {
    const at = added.indexOf(f.text.trim())
    if (at >= 0) added.splice(at, 1)
    else left.push(f)
  }
  const ops: VaultOp[] = []
  left.forEach((f, i) => {
    const next = added[i]
    ops.push(next !== undefined ? { op: 'supersede', blockId: ref(f), text: next } : { op: 'invalidate', blockId: ref(f), reason: 'Removed in Company settings' })
  })
  for (const next of added.slice(left.length)) ops.push({ op: 'observe', note, category: HUB_CATEGORY[field], text: next })
  return ops
}

/**
 * The company hub note in a vault tree (PASSPORT.md §9.3): a root-level `type: company` note, preferring the one
 * titled like the company. The seed keeps a hub the user brought under another name, and a rename never moves it,
 * so the path is looked up, never derived from the current name.
 */
export function findHubNote<T extends { path: string; title: string; type: string; status: string }>(tree: readonly T[], companyName: string): T | null {
  const hubs = tree.filter((e) => e.type === 'company' && e.status !== 'archived' && !e.path.includes('/'))
  const want = companyName.trim().toLowerCase()
  return hubs.find((e) => e.title.trim().toLowerCase() === want) ?? hubs[0] ?? null
}

/** A writer apply result's failed ops (conflict / error), as one message; null when every op landed. */
export function opFailures(results: readonly { status: string; reason: string | null }[]): string | null {
  const bad = results.filter((r) => r.status === 'conflict' || r.status === 'error')
  if (!bad.length) return null
  const reasons = [...new Set(bad.map((r) => r.reason).filter(Boolean))]
  return `${bad.length} change${bad.length === 1 ? '' : 's'} could not be saved${reasons.length ? `: ${reasons.join('; ')}` : ''}. Reopen Company settings and try again.`
}
