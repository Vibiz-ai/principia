/**
 * The Passport policy layer (PASSPORT.md §7.3), split out of the v1 `agentWrite` (store.ts). It runs before the writer
 * for every write source (agent RPC, UI, accepted suggestion, migration) and decides, without touching any file:
 *
 * - validation and the screen.ts secret / fingerprint / imperative screens over text, aliases and relation context
 * - the per-grant write budget (facts 1, links 0.25, so linking never exhausts a budget)
 * - per-note hash dedup
 * - the contested-supersede rule (an agent replacing a line a user wrote, pinned or reviewed becomes a proposal)
 * - relation-type normalization
 * - the cross-company check (a grant writes only its own company's vault)
 *
 * The result is a WritePlan; sink.ts turns it into writer ops. Plain reads of passport-index.db plus the budget update.
 */
import type { VaultOp } from '../../shared/passport'
import type { VaultInvalidateArgs, VaultLinkArgs, VaultWriteArgs } from '../../shared/memory'
import { ACTORS, type Actor, cleanCategory, formatObservation, isNoteType, LINKS_TO, parseBulletLine } from '../../shared/vault/grammar'
import { blockIdToV1, isBlockId, parseBlockRef, textHash } from '../../shared/vault/ids'
import { normalizeRelType } from '../../shared/vault/ontology'
import { parseLinkTarget } from '../../shared/vault/resolve'
import type { VaultIndexer } from './vault/indexer'
import { targetNorm } from './vault/indexer'
import type { WriteContext } from './vault/writer'
import { LIMITS, MemoryRefusal, writesLeft, type VaultGrantRow, type VaultGrantStore } from './store'
import { screenText, type FingerprintFile } from './screen'

/** Who is writing. Agents come through the spool with their grant; the UI and accepted suggestions are the user. */
export type WriteSource =
  | { kind: 'agent'; grant: VaultGrantRow; callId?: string | null }
  | { kind: 'user'; via?: string | null }
  | { kind: 'migration' }

export interface PolicyDeps {
  index: VaultIndexer
  grants: VaultGrantStore
  fingerprints(): FingerprintFile | null
  /** "Pause agent writes" */
  paused(): boolean
}

/** Budget weights (§7.3). */
export const WRITE_WEIGHT = { fact: 1, link: 0.25, invalidate: 1 } as const
export const POLICY_LIMITS = { ...LIMITS, tagsPerCall: 10, contextLen: 200, categoryLen: 40, linksPerCall: 20, refsPerCall: 20, summaryLen: 500 }

/** Live fact row fields the policy reads (mem_fact). */
export interface FactTarget {
  id: string
  note_id: string
  block_id: string | null
  line: number
  text: string
  status: string
  actor: string
  pinned: number
  reviewed: number
  category: string
  kind: 'fact' | 'relation'
}

export interface PlannedNote {
  /** As the caller named it. */
  name: string
  /** Existing note (null = to be created). */
  noteId: string | null
  create: { title: string; type: string; folder?: string; summary?: string; aliases: string[]; tags: string[] } | null
  addAliases: string[]
  addTags: string[]
}
export interface PlannedFact {
  text: string
  category: string
  status: 'write' | 'duplicate' | 'contested' | 'quarantined'
  why: string | null
  /** The line this fact replaces (contested: the proposal's target). */
  supersedes: FactTarget | null
  /** duplicate: the existing line */
  existing: { id: string; blockId: string | null; text: string } | null
}
export interface PlannedRelation {
  rel: string
  to: string
  context: string | null
  status: 'write' | 'duplicate'
}
export interface PlannedLink extends PlannedRelation {
  from: string
  fromId: string | null
  /** set when the link cannot be written (unknown source note) */
  error: string | null
}
export interface PlannedInvalidate {
  ref: string
  target: FactTarget | null
  status: 'invalidate' | 'contested' | 'not_found' | 'already_invalid'
}

export interface WritePlan {
  companyId: string
  ctx: WriteContext
  source: WriteSource
  note: PlannedNote | null
  facts: PlannedFact[]
  relations: PlannedRelation[]
  links: PlannedLink[]
  invalidations: PlannedInvalidate[]
  reason: string | null
  createMissing: boolean
  writesLeft: number
}

const refuse = (m: string, code: MemoryRefusal['code'] = 'validation'): never => {
  throw new MemoryRefusal(`Refused: ${m}`, code)
}

/** Provenance actor for an adapter: the agent CLIs by name, anything else as claude (the only MCP writer today). */
export function actorForAdapter(adapter: string): Actor {
  return (ACTORS as readonly string[]).includes(adapter) && adapter !== 'user' ? (adapter as Actor) : 'claude'
}

/** The writer context of a source (§3.2 provenance tail; opId = grantId + MCP call id). */
export function contextFor(source: WriteSource): WriteContext {
  if (source.kind === 'agent') {
    const g = source.grant
    return {
      actor: actorForAdapter(g.adapter),
      grantId: g.id,
      runId: g.run_id,
      sessionId: g.session_id,
      opId: source.callId ? `${g.id}:${source.callId}` : null
    }
  }
  if (source.kind === 'migration') return { actor: 'migration' }
  return { actor: 'user', via: source.via ?? null }
}

/**
 * Who may write here. Agents need an open read-write grant of this very company (the cross-company check) and
 * unpaused writes. A repo is no longer required, so a company chat can write (§7.5).
 */
export function assertCanWrite(deps: PolicyDeps, companyId: string, source: WriteSource): void {
  if (source.kind !== 'agent') return
  const g = deps.grants.get(source.grant.id)
  if (!g) refuse('unknown memory grant', 'refused')
  if (g!.company_id !== companyId) refuse('this grant belongs to another company; memory is read-only here', 'refused')
  if (g!.closed_at) refuse('this memory grant is closed (the step or session ended)', 'refused')
  if (g!.mode !== 'read-write') refuse('memory is read-only for this step', 'refused')
  if (deps.paused()) refuse('the user paused agent memory writes', 'refused')
  source.grant.writes = g!.writes
}

/** Screens text from one source: secrets refuse the call; instruction-looking agent text is returned for review. */
function screen(deps: PolicyDeps, texts: string[]): void {
  const fp = deps.fingerprints()
  for (const t of texts) {
    if (!t) continue
    const hit = screenText(fp, t)
    if (hit?.kind === 'secret') refuse(`text contains a stored secret (${hit.label}). Do not store credentials in memory.`)
    if (hit?.kind === 'credential') refuse(`text looks like a credential (${hit.label}). Do not store credentials in memory.`)
  }
}

function imperative(deps: PolicyDeps, source: WriteSource, text: string): string | null {
  if (source.kind !== 'agent') return null
  const hit = screenText(deps.fingerprints(), text, { agent: true })
  return hit?.kind === 'imperative' ? hit.label : null
}

/** A forgivingly named note: `[[Title]]`, title, alias, path or id. Ambiguous names refuse with the candidates. */
export function resolveNoteName(index: VaultIndexer, companyId: string, name: string): string | null {
  const raw = name.trim()
  if (/^n-[0-9a-z]{10}$/.test(raw) || raw.startsWith('h:')) {
    const row = index.noteById(companyId, raw)
    return row && !row.removed_at ? row.id : null
  }
  if (/\.md$/i.test(raw) && !raw.startsWith('[[')) {
    const row = index.noteByPath(companyId, raw)
    if (row && !row.removed_at) return row.id
  }
  const r = index.resolve(companyId, raw)
  if (r.ambiguous) {
    const titles = r.candidates.map((id) => index.noteById(companyId, id)?.title ?? id)
    refuse(`"${raw}" matches several notes: ${titles.map((t) => `[[${t}]]`).join(', ')}; name one exactly`)
  }
  return r.toNote
}

/** `[[Ana#^f-x]]`, `^f-x`, `f-x`, `mfa_x`, `mrel_x` or a soft `h:` key -> the live line (fact or relation) of this company. */
export function findLine(index: VaultIndexer, companyId: string, ref: string): FactTarget | null {
  const raw = ref.trim()
  const db = index.db
  let blockId = parseBlockRef(raw)
  if (!blockId) {
    const m = /^(mfa|mrel)_([0-9a-z]{10})$/.exec(raw)
    if (m) blockId = `${m[1] === 'mfa' ? 'f' : 'r'}-${m[2]}`
  }
  const fact = (where: string, arg: string) =>
    db
      .prepare(
        `SELECT id, note_id, block_id, line, text, status, actor, pinned, reviewed, category FROM mem_fact
         WHERE company_id = ? AND ${where} AND status != 'removed_external' AND dup_of IS NULL ORDER BY line LIMIT 1`
      )
      .get(companyId, arg) as Omit<FactTarget, 'kind'> | undefined
  const rel = (where: string, arg: string) =>
    db
      .prepare(
        `SELECT id, from_note AS note_id, block_id, line, rel || ' [[' || to_text || ']]' AS text, status, ifnull(actor, 'user') AS actor,
           0 AS pinned, 0 AS reviewed, rel AS category
         FROM mem_link WHERE company_id = ? AND origin = 'relation' AND ${where} AND dup_of IS NULL LIMIT 1`
      )
      .get(companyId, arg) as Omit<FactTarget, 'kind'> | undefined
  let hit: FactTarget | null = null
  if (blockId && isBlockId(blockId)) {
    const f = fact('block_id = ?', blockId)
    if (f) hit = { ...f, kind: 'fact' }
    else {
      const r = rel('block_id = ?', blockId)
      if (r) hit = { ...r, kind: 'relation' }
    }
  } else if (raw.startsWith('h:')) {
    const f = fact('id = ?', raw)
    if (f) hit = { ...f, kind: 'fact' }
    else {
      const r = rel('id = ?', raw)
      if (r) hit = { ...r, kind: 'relation' }
    }
  }
  if (!hit) return null
  const note = index.noteById(companyId, hit.note_id)
  return note && !note.removed_at ? hit : null
}

/** The v1 pending rule (§6.5): an agent may not silently replace a line a user wrote, pinned or reviewed. */
export function isContested(source: WriteSource, line: Pick<FactTarget, 'actor' | 'pinned' | 'reviewed'>): boolean {
  if (source.kind !== 'agent') return false
  return line.actor === 'user' || line.actor.startsWith('user ') || !!line.pinned || !!line.reviewed
}

/** The note's live line hash, as the writer and indexer compute it (text with tags, no category or provenance). */
export function observationHash(category: string, text: string, tags?: string[]): string {
  const probe = parseBulletLine(formatObservation({ category, text, tags }))
  return textHash(probe && probe.kind === 'observation' ? probe.text : text)
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.replace(/^#/, '').trim()).filter((t) => /^[A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*$/.test(t)))]
}

function takeBudget(deps: PolicyDeps, source: WriteSource, weight: number): number {
  if (source.kind !== 'agent') return LIMITS.writesPerGrant
  return deps.grants.takeWrites(source.grant, Math.round(weight * 100) / 100)
}

// ---------- memory_write ----------

export function planWrite(deps: PolicyDeps, companyId: string, source: WriteSource, args: VaultWriteArgs): WritePlan {
  assertCanWrite(deps, companyId, source)
  const name = (args.note ?? args.entity ?? '').replace(/^\[\[|\]\]$/g, '').trim()
  const facts = args.facts ?? []
  const relations = args.relations ?? []
  const aliases = (args.aliases ?? []).map((a) => a.trim()).filter(Boolean)
  const tags = cleanTags(args.tags)
  const summary = args.summary?.replace(/\s+/g, ' ').trim() ?? ''
  if (!name || name.length > LIMITS.nameLen) refuse(`note must be 1..${LIMITS.nameLen} chars`)
  if (!facts.length && !relations.length && !aliases.length && !tags.length && !summary) refuse('give at least one fact, relation, alias, tag or a summary')
  if (facts.length > LIMITS.factsPerCall) refuse(`at most ${LIMITS.factsPerCall} facts per call`)
  if (relations.length > LIMITS.relationsPerCall) refuse(`at most ${LIMITS.relationsPerCall} relations per call`)
  if (aliases.length > LIMITS.aliasesPerCall) refuse(`at most ${LIMITS.aliasesPerCall} aliases`)
  if (tags.length > POLICY_LIMITS.tagsPerCall) refuse(`at most ${POLICY_LIMITS.tagsPerCall} tags`)
  if (summary.length > POLICY_LIMITS.summaryLen) refuse(`summary must be at most ${POLICY_LIMITS.summaryLen} chars`)
  if (aliases.some((a) => a.length > LIMITS.nameLen)) refuse(`aliases must be 1..${LIMITS.nameLen} chars`)
  for (const f of facts) {
    if (typeof f.text !== 'string' || f.text.trim().length < 3 || f.text.length > LIMITS.factLen) refuse(`each fact must be 3..${LIMITS.factLen} chars`)
    if (f.kind !== undefined && (typeof f.kind !== 'string' || !cleanCategory(f.kind) || f.kind.length > POLICY_LIMITS.categoryLen)) refuse(`kind must be a short category (fact, decision, convention, gotcha, …)`)
  }
  for (const r of relations) {
    if (!r.type || r.type.trim().length < 2 || r.type.length > LIMITS.typeLen) refuse(`relation type must be 2..${LIMITS.typeLen} chars`)
    if (!r.to?.trim() || r.to.length > LIMITS.nameLen + 4) refuse('relation "to" must name a note')
    if (r.context && r.context.length > POLICY_LIMITS.contextLen) refuse(`relation context must be at most ${POLICY_LIMITS.contextLen} chars`)
  }
  screen(deps, [name, summary, ...aliases, ...tags, ...facts.map((f) => f.text), ...relations.map((r) => `${r.type} ${r.to} ${r.context ?? ''}`)])

  const noteId = resolveNoteName(deps.index, companyId, name)
  const typed = args.type?.trim().toLowerCase()
  const note: PlannedNote = {
    name,
    noteId,
    create: noteId
      ? null
      : {
          title: parseLinkTarget(name).target.trim() || name,
          // §7.2: type from the argument, else `concept` in Inbox/
          type: typed && isNoteType(typed) ? typed : 'concept',
          folder: typed && isNoteType(typed) ? undefined : 'Inbox',
          summary: summary || undefined,
          aliases,
          tags
        },
    addAliases: noteId ? aliases : [],
    addTags: noteId ? tags : []
  }

  const plannedFacts: PlannedFact[] = []
  const seen = new Set<string>()
  for (const f of facts) {
    const text = f.text.trim()
    const category = cleanCategory(f.kind ?? 'fact') || 'fact'
    const hash = observationHash(category, text)
    if (seen.has(hash)) continue
    seen.add(hash)
    const existing = noteId
      ? (deps.index.db
          .prepare(`SELECT id, block_id, text FROM mem_fact WHERE company_id = ? AND note_id = ? AND text_hash = ? AND status = 'active' LIMIT 1`)
          .get(companyId, noteId, hash) as { id: string; block_id: string | null; text: string } | undefined)
      : undefined
    if (existing) {
      plannedFacts.push({ text, category, status: 'duplicate', why: null, supersedes: null, existing: { id: existing.id, blockId: existing.block_id, text: existing.text } })
      continue
    }
    let supersedes: FactTarget | null = null
    let why: string | null = null
    for (const ref of ([] as string[]).concat(f.supersedes ?? []).slice(0, 10)) {
      const line = findLine(deps.index, companyId, ref)
      if (!line || line.kind !== 'fact' || line.status !== 'active') {
        why = `${ref} is not an active fact here; added as a new fact`
        continue
      }
      if (!noteId || line.note_id !== noteId) {
        why = `${ref} belongs to another note; added as a new fact`
        continue
      }
      supersedes = line
      break
    }
    const imp = imperative(deps, source, text)
    if (imp) {
      plannedFacts.push({ text, category, status: 'quarantined', why: `looks like an instruction (${imp}); awaits user review`, supersedes, existing: null })
      continue
    }
    if (supersedes && isContested(source, supersedes)) {
      plannedFacts.push({ text, category, status: 'contested', why: `the line it replaces was written or approved by the user; your fact awaits review`, supersedes, existing: null })
      continue
    }
    plannedFacts.push({ text, category, status: 'write', why, supersedes, existing: null })
  }

  const plannedRels: PlannedRelation[] = []
  for (const r of relations) {
    const rel = normalizeRelType(r.type) || LINKS_TO
    const to = parseLinkTarget(r.to).target.trim()
    const dup = noteId ? relationExists(deps.index, companyId, noteId, rel, to) : false
    plannedRels.push({ rel, to, context: r.context?.trim() || null, status: dup ? 'duplicate' : 'write' })
  }

  const weight =
    plannedFacts.filter((f) => f.status !== 'duplicate').length * WRITE_WEIGHT.fact + plannedRels.filter((r) => r.status === 'write').length * WRITE_WEIGHT.link
  const left = takeBudget(deps, source, weight)
  return {
    companyId,
    ctx: contextFor(source),
    source,
    note,
    facts: plannedFacts,
    relations: plannedRels,
    links: [],
    invalidations: [],
    reason: null,
    createMissing: !!args.create_missing,
    writesLeft: left
  }
}

function relationExists(index: VaultIndexer, companyId: string, fromId: string, rel: string, to: string): boolean {
  return !!index.db
    .prepare(`SELECT 1 FROM mem_link WHERE company_id = ? AND from_note = ? AND origin = 'relation' AND norm_rel = ? AND to_norm = ? AND status = 'active' LIMIT 1`)
    .get(companyId, fromId, rel, targetNorm(to).norm)
}

// ---------- memory_link ----------

export function planLinks(deps: PolicyDeps, companyId: string, source: WriteSource, args: VaultLinkArgs): WritePlan {
  assertCanWrite(deps, companyId, source)
  const links = args.links ?? []
  if (!links.length || links.length > POLICY_LIMITS.linksPerCall) refuse(`give 1..${POLICY_LIMITS.linksPerCall} links`)
  for (const l of links) {
    if (!l.from?.trim() || !l.to?.trim() || l.from.length > LIMITS.nameLen + 4 || l.to.length > LIMITS.nameLen + 4) refuse('each link needs "from" and "to" notes')
    if (l.type !== undefined && (l.type.trim().length < 2 || l.type.length > LIMITS.typeLen)) refuse(`relation type must be 2..${LIMITS.typeLen} chars`)
    if (l.context && l.context.length > POLICY_LIMITS.contextLen) refuse(`link context must be at most ${POLICY_LIMITS.contextLen} chars`)
  }
  screen(deps, links.map((l) => `${l.from} ${l.type ?? ''} ${l.to} ${l.context ?? ''}`))
  const planned: PlannedLink[] = []
  for (const l of links) {
    const rel = normalizeRelType(l.type ?? 'relates_to') || 'relates_to'
    const to = parseLinkTarget(l.to).target.trim()
    let fromId: string | null = null
    let error: string | null = null
    try {
      fromId = resolveNoteName(deps.index, companyId, l.from)
      if (!fromId) error = `no note named "${parseLinkTarget(l.from).target}"; create it with memory_write first`
    } catch (e) {
      error = e instanceof Error ? e.message.replace(/^Refused: /, '') : String(e)
    }
    const dup = fromId ? relationExists(deps.index, companyId, fromId, rel, to) : false
    planned.push({ from: l.from, fromId, rel, to, context: l.context?.trim() || null, status: dup ? 'duplicate' : 'write', error })
  }
  const weight = planned.filter((l) => l.status === 'write' && !l.error).length * WRITE_WEIGHT.link
  const left = takeBudget(deps, source, weight)
  return { companyId, ctx: contextFor(source), source, note: null, facts: [], relations: [], links: planned, invalidations: [], reason: null, createMissing: false, writesLeft: left }
}

// ---------- memory_invalidate ----------

export function planInvalidate(deps: PolicyDeps, companyId: string, source: WriteSource, args: VaultInvalidateArgs): WritePlan {
  assertCanWrite(deps, companyId, source)
  const refs = [...new Set((args.refs ?? []).map((r) => r.trim()).filter(Boolean))]
  const reason = args.reason?.replace(/\s+/g, ' ').trim() ?? ''
  if (!refs.length || refs.length > POLICY_LIMITS.refsPerCall) refuse(`give 1..${POLICY_LIMITS.refsPerCall} refs`)
  if (!reason || reason.length > LIMITS.reasonLen) refuse(`reason must be 1..${LIMITS.reasonLen} chars`)
  if (args.replaced_by && args.replaced_by.length > LIMITS.nameLen + 40) refuse('replaced_by is too long')
  screen(deps, [reason, args.replaced_by ?? ''])
  const items: PlannedInvalidate[] = refs.map((ref) => {
    const target = findLine(deps.index, companyId, ref)
    if (!target) return { ref, target: null, status: 'not_found' }
    if (target.status !== 'active') return { ref, target, status: 'already_invalid' }
    return { ref, target, status: isContested(source, target) ? 'contested' : 'invalidate' }
  })
  const fullReason = args.replaced_by ? `${reason}; replaced by ${args.replaced_by.trim()}` : reason
  const left = takeBudget(deps, source, items.filter((i) => i.status === 'invalidate').length * WRITE_WEIGHT.invalidate)
  return { companyId, ctx: contextFor(source), source, note: null, facts: [], relations: [], links: [], invalidations: items, reason: fullReason, createMissing: false, writesLeft: left }
}

// ---------- direct ops (UI, accepted suggestions, migration) ----------

/** Text an op would put into a file (screened before any write). */
export function opTexts(op: VaultOp): string[] {
  switch (op.op) {
    case 'createNote':
      return [op.title, op.summary ?? '', ...(op.aliases ?? []), ...Object.values(op.properties ?? {}).flatMap((v) => (Array.isArray(v) ? v : v == null ? [] : [String(v)]))]
    case 'observe':
      return [op.text, ...(op.tags ?? [])]
    case 'relate':
      return [op.rel, op.to, op.context ?? '']
    case 'supersede':
      return [op.text]
    case 'invalidate':
      return [op.reason]
    case 'setProperty':
      return [op.key, ...(Array.isArray(op.value) ? op.value : op.value == null ? [] : [String(op.value)])]
    case 'addAlias':
      return [op.alias]
    case 'rename':
      return [op.newTitle]
    case 'reinforce':
      return [op.example ?? '']
    default:
      return []
  }
}

/**
 * Policy for ops that arrive already shaped (Passport UI, accepted proposals, migration): the cross-company and
 * pause checks for agents, the secret screens, relation-type normalization. Returns the ops to hand to the writer.
 */
export function checkOps(deps: PolicyDeps, companyId: string, source: WriteSource, ops: VaultOp[]): VaultOp[] {
  assertCanWrite(deps, companyId, source)
  if (!ops.length) refuse('no changes')
  screen(deps, ops.flatMap(opTexts))
  if (source.kind === 'agent') {
    const imp = ops.flatMap(opTexts).map((t) => imperative(deps, source, t)).find(Boolean)
    if (imp) refuse(`text looks like an instruction (${imp})`)
  }
  return ops.map((op) => (op.op === 'relate' ? { ...op, rel: normalizeRelType(op.rel) || op.rel } : op))
}

/** v1 id of a vault line, for callers that still speak `mfa_`/`mrel_`. */
export const v1IdOf = (blockId: string | null): string | null => (blockId ? blockIdToV1(blockId) : null)
export { writesLeft }
