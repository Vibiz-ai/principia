/**
 * The write path for inject adapters (PASSPORT.md §7.6). Read-write codex, gemini and cursor steps end their final
 * answer with a `<passport-notes>` block in vault grammar:
 *
 *   <passport-notes>
 *   ### [[Stripe]] (product)
 *   - [decision] We bill monthly through Stripe
 *   - uses [[acme-web]]
 *   </passport-notes>
 *
 * When the step finishes, the block is parsed, every line is screened (secrets, credential shapes, imperative
 * injection), lines already on the note are dropped, and one `harvest` proposal per note is filed, attributed to the
 * run. A human accepts them: there are no silent writes.
 */
import type { StepOutputEvent } from '../../../../shared/engine'
import { isNoteType, parseBulletLine } from '../../../../shared/vault/grammar'
import { sha1Hex, textHash } from '../../../../shared/vault/ids'
import { normalizeRelType } from '../../../../shared/vault/ontology'
import { buildResolver, normName, parseLinkTarget } from '../../../../shared/vault/resolve'
import type { VaultOp } from '../../../../shared/passport'
import { screenText, type FingerprintFile } from '../../screen'
import type { IndexDB } from '../indexDb'
import type { Candidate, VaultView } from './candidates'

export const HARVEST_LIMITS = { notes: 10, factsPerNote: 10, relationsPerNote: 10, textLen: 500, titleLen: 120, blockLen: 20_000 }

export interface HarvestNote {
  title: string
  type: string | null
  facts: { category: string; text: string }[]
  relations: { rel: string; to: string; context: string | null }[]
}

export interface HarvestDrop {
  text: string
  reason: string
}

const BLOCK_RE = /<passport-notes>([\s\S]*?)<\/passport-notes>/gi
/** Open Passport SPEC.md §9.6: the same block as a fenced ```open-passport-notes section (harness-agnostic form). */
const FENCED_RE = /```open-passport-notes[^\n]*\n([\s\S]*?)\n```/g

/** The last complete `<passport-notes>` or ```open-passport-notes block of an answer, or null. */
export function extractHarvestBlock(output: string): string | null {
  let last: { at: number; body: string } | null = null
  for (const re of [BLOCK_RE, FENCED_RE]) for (const m of output.matchAll(re)) if (!last || m.index! > last.at) last = { at: m.index!, body: m[1] }
  return last !== null && last.body.length <= HARVEST_LIMITS.blockLen ? last.body : null
}

/** Parses a block into notes (headings) with their observation and relation lines; anything else is ignored. */
export function parseHarvestBlock(block: string): HarvestNote[] {
  const notes: HarvestNote[] = []
  let cur: HarvestNote | null = null
  let fence = false
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence || !line.trim()) continue
    const h = /^\s{0,3}#{2,4}\s+(.+)$/.exec(line)
    if (h) {
      cur = null
      if (notes.length >= HARVEST_LIMITS.notes) continue
      const head = h[1].trim()
      const lm = /^!?\[\[([^[\]\n]+)\]\](?:\s*\(([^()]+)\))?\s*$/.exec(head)
      const title = (lm ? parseLinkTarget(`[[${lm[1]}]]`).target : head.replace(/\s*\(([^()]+)\)\s*$/, '')).replace(/\s+/g, ' ').trim()
      const typed = (lm ? lm[2] : /\(([^()]+)\)\s*$/.exec(head)?.[1])?.trim().toLowerCase() ?? null
      if (!title || title.length > HARVEST_LIMITS.titleLen || /[[\]]/.test(title)) continue
      cur = { title, type: typed && isNoteType(typed) ? typed : null, facts: [], relations: [] }
      notes.push(cur)
      continue
    }
    if (!cur || !/^\s*[-*+]\s+/.test(line)) continue
    const b = parseBulletLine(line)
    if (b?.kind === 'observation') {
      if (cur.facts.length < HARVEST_LIMITS.factsPerNote && b.text.trim()) cur.facts.push({ category: b.category, text: b.text.trim() })
    } else if (b?.kind === 'relation' || b?.kind === 'bare_link') {
      const to = b.link.target.trim()
      if (to && cur.relations.length < HARVEST_LIMITS.relationsPerNote) cur.relations.push({ rel: b.kind === 'relation' ? normalizeRelType(b.rel) : 'links_to', to, context: b.kind === 'relation' ? b.context : null })
    } else if (!b) {
      // a plain bullet without a [category]: a fact
      const text = line.replace(/^\s*[-*+]\s+/, '').trim()
      if (text && !/^\[[ xX]\]/.test(text) && cur.facts.length < HARVEST_LIMITS.factsPerNote) cur.facts.push({ category: 'fact', text })
    }
  }
  return notes.filter((n) => n.facts.length || n.relations.length)
}

/** Screens every line (§7.3): a hit drops the line, a hit in the title drops the note. Over-long lines are dropped too. */
export function screenHarvest(notes: HarvestNote[], fp: FingerprintFile | null): { notes: HarvestNote[]; dropped: HarvestDrop[] } {
  const dropped: HarvestDrop[] = []
  const hit = (t: string): string | null => {
    const h = screenText(fp, t, { agent: true })
    return h ? `${h.kind}: ${h.label}` : null
  }
  const out: HarvestNote[] = []
  for (const n of notes) {
    const th = hit(n.title)
    if (th) {
      dropped.push({ text: '(note title)', reason: th })
      continue
    }
    const facts = n.facts.filter((f) => {
      const why = f.text.length > HARVEST_LIMITS.textLen ? 'too long' : hit(`${f.category} ${f.text}`)
      if (why) dropped.push({ text: why.startsWith('secret') || why.startsWith('credential') ? '(redacted)' : f.text.slice(0, 120), reason: why })
      return !why
    })
    const relations = n.relations.filter((r) => {
      const why = hit(`${r.rel} ${r.to} ${r.context ?? ''}`)
      if (why) dropped.push({ text: why.startsWith('secret') || why.startsWith('credential') ? '(redacted)' : `${r.rel} [[${r.to}]]`, reason: why })
      return !why
    })
    if (facts.length || relations.length) out.push({ ...n, facts, relations })
  }
  return { notes: out, dropped }
}

/** Should this step's output be harvested? Read-write inject steps of a company that finished. */
export function shouldHarvest(e: StepOutputEvent): boolean {
  return e.memory === 'read-write' && e.transport === 'inject' && !!e.companyId && e.status === 'passed' && e.output.includes('<passport-notes>')
}

/** One `harvest` candidate per note: new lines only (already-present facts and relations are dropped). */
export function harvestCandidates(db: IndexDB, view: VaultView, e: Pick<StepOutputEvent, 'runId' | 'stepId' | 'nodeId' | 'adapter'>, notes: HarvestNote[]): Candidate[] {
  const resolver = buildResolver(view.notes)
  const out: Candidate[] = []
  const factHashes = db.prepare(`SELECT text_hash FROM mem_fact WHERE company_id = ? AND note_id = ? AND status IN ('active','pending')`)
  for (const n of notes) {
    const res = resolver.resolve(n.title)
    if (res.status === 'ambiguous') continue
    const existing = res.status === 'resolved' ? view.byId.get(res.id) : undefined
    if (existing?.status === 'archived') continue
    const name = existing ? existing.stem : n.title
    const have = new Set(existing ? (factHashes.all(view.companyId, existing.id) as { text_hash: string }[]).map((r) => r.text_hash) : [])
    const linked = new Set(existing ? view.edges.filter((x) => x.from === existing.id).map((x) => `${x.rel}|${x.to}`) : [])
    const facts = n.facts.filter((f) => !have.has(textHash(f.text)))
    const relations = n.relations.filter((r) => {
      const t = resolver.resolve(r.to)
      return !(t.status === 'resolved' && (linked.has(`${r.rel}|${t.id}`) || t.id === existing?.id))
    })
    if (!facts.length && !relations.length) continue
    const ops: VaultOp[] = []
    if (!existing) ops.push({ op: 'createNote', title: n.title, type: n.type ?? 'note' })
    for (const f of facts) ops.push({ op: 'observe', note: name, category: f.category, text: f.text })
    for (const r of relations) ops.push({ op: 'relate', from: name, rel: r.rel, to: r.to, ...(r.context ? { context: r.context } : {}) })
    const lines = [...facts.map((f) => `${f.category}|${textHash(f.text)}`), ...relations.map((r) => `${r.rel}|${normName(r.to)}`)].sort()
    const from = `${e.adapter} run#${e.runId}${e.nodeId ? ` (${e.nodeId})` : ''}`
    out.push({
      kind: 'harvest',
      source: 'harvest',
      ops,
      evidence: [
        ...facts.slice(0, 5).map((f) => ({ path: existing?.path ?? null, line: null, quote: `[${f.category}] ${f.text}`, note: `from ${from}` })),
        ...relations.slice(0, 5).map((r) => ({ path: existing?.path ?? null, line: null, quote: `${r.rel} [[${r.to}]]`, note: `from ${from}` }))
      ],
      score: 0.5,
      key: `harvest:${normName(n.title)}:${sha1Hex(lines.join('\n'))}`,
      baseHashes: existing ? { [existing.path]: existing.hash } : {}
    })
  }
  return out
}
