/**
 * Turns a policy WritePlan into vault writer ops (PASSPORT.md §7.3) and the agent-facing result (§7.2): folder choice
 * for new notes, autolink of the agent's own fact text, ghost-allowed relations (Inbox stubs only with create_missing),
 * supersede and invalidate as moves to History, soft-id materialization, and proposals for what policy held back.
 * Nothing here writes SQL rows for notes, facts or links: every change is a file patch through the writer, which
 * indexes it and appends mem_event + log.jsonl.
 */
import type { VaultApplyResult, VaultOp, VaultOpResult } from '../../shared/passport'
import type { VaultInvalidateResult, VaultLinkResult, VaultUnresolved, VaultWriteResult } from '../../shared/memory'
import { autolinkText, lineSkipRanges, TitleTrie, type TrieNote } from '../../shared/vault/autolink'
import { scanLinks } from '../../shared/vault/grammar'
import { textHash } from '../../shared/vault/ids'
import { guessTargetType } from '../../shared/vault/ontology'
import { didYouMean, normName, parseLinkTarget, pathStem, tokenJaccard, type ResolvableNote } from '../../shared/vault/resolve'
import { type IndexDB, insertProposal } from './vault/indexDb'
import type { NoteRow, VaultIndexer } from './vault/indexer'
import type { VaultWriter, WriteContext } from './vault/writer'
import type { FactTarget, PlannedFact, WritePlan } from './policy'

export interface SinkDeps {
  index: VaultIndexer
  writer: VaultWriter
  now?: () => Date
}

/** Autolink cap per fact (§7.2). */
export const AUTOLINK_MAX = 5

/** `[[Stem]]`: shortest-path link text that resolves exactly as in Obsidian (basenames are unique per vault). */
export function noteLink(row: Pick<NoteRow, 'path' | 'title'>): string {
  return `[[${pathStem(row.path)}]]`
}
export function lineRef(row: Pick<NoteRow, 'path' | 'title'>, blockId: string | null, fallbackId?: string): string {
  return blockId ? `[[${pathStem(row.path)}#^${blockId}]]` : fallbackId ?? noteLink(row)
}

/** Live notes of one company with aliases: the autolink trie, did-you-mean and the Known notes list read this. */
export function companyNotes(db: IndexDB, companyId: string): (ResolvableNote & TrieNote & { type: string })[] {
  const rows = db
    .prepare(`SELECT id, path, title, type, status FROM mem_note WHERE company_id = ? AND removed_at IS NULL`)
    .all(companyId) as { id: string; path: string; title: string; type: string; status: string }[]
  const aliases = new Map<string, string[]>()
  for (const a of db.prepare('SELECT note_id, alias FROM mem_alias WHERE company_id = ?').all(companyId) as { note_id: string; alias: string }[]) {
    const list = aliases.get(a.note_id) ?? []
    list.push(a.alias)
    aliases.set(a.note_id, list)
  }
  return rows.map((r) => ({ ...r, aliases: aliases.get(r.id) ?? [] }))
}

/** Ghost / ambiguous report for a name, with fuzzy did-you-mean titles (never auto-resolved, §5). */
export function unresolvedFor(index: VaultIndexer, companyId: string, name: string, notes: ResolvableNote[]): VaultUnresolved | null {
  const r = index.resolve(companyId, name)
  if (r.toNote) return null
  const shown = parseLinkTarget(name).target.trim() || name
  if (r.ambiguous) {
    const titles = r.candidates.map((id) => index.noteById(companyId, id)).filter((n): n is NoteRow => !!n).map((n) => noteLink(n))
    return { to: `[[${shown}]]`, status: 'ambiguous', did_you_mean: titles }
  }
  return { to: `[[${shown}]]`, status: 'ghost', did_you_mean: didYouMean(shown, notes).map((d) => `[[${pathStem(notes.find((n) => n.id === d.id)?.path ?? d.title)}]]`) }
}

function firstError(res: VaultApplyResult): string | null {
  const bad = res.results.find((r) => r.status === 'error' || r.status === 'conflict')
  return bad ? (bad.reason ?? bad.status) : null
}

/** A sub-batch op id so a replayed MCP call returns each batch's first result (§6.4 idempotency). */
function step(ctx: WriteContext, name: string): WriteContext {
  return ctx.opId ? { ...ctx, opId: `${ctx.opId}:${name}` } : ctx
}

/** Gives a soft-keyed (`h:`) line a real block id so ops and proposals can target it (§3.2). */
async function materialize(deps: SinkDeps, companyId: string, target: FactTarget, ctx: WriteContext): Promise<string | null> {
  if (target.block_id) return target.block_id
  const res = await deps.writer.apply(companyId, [{ op: 'materializeId', note: target.note_id, line: target.line }], step(ctx, `mat:${target.id}`))
  return res.results[0]?.blockId ?? null
}

interface PendingProposal {
  kind: 'fact_supersede' | 'harvest'
  title: string
  ops: VaultOp[]
  quote: string
  path: string | null
  line: number | null
  why: string
  fingerprint: string
}

function fileProposal(deps: SinkDeps, companyId: string, p: PendingProposal, baseHash: { path: string; hash: string } | null): string | null {
  const now = (deps.now?.() ?? new Date()).toISOString()
  return insertProposal(deps.index.db, {
    companyId,
    kind: p.kind,
    payload: p.ops,
    evidence: [{ path: p.path, line: p.line, quote: p.quote, note: p.why }],
    score: 1,
    source: 'writer',
    fingerprint: p.fingerprint,
    baseHashes: baseHash ? { [baseHash.path]: baseHash.hash } : {},
    createdAt: now
  })
}

// ---------- memory_write ----------

export async function sinkWrite(deps: SinkDeps, plan: WritePlan): Promise<VaultWriteResult> {
  const { index, writer } = deps
  const companyId = plan.companyId
  const ctx = plan.ctx
  const pn = plan.note!
  const out: VaultWriteResult = {
    note: `[[${pn.create?.title ?? pn.name}]]`,
    created: false,
    path: null,
    written: [],
    duplicates: [],
    similar: [],
    linked: [],
    autolinked: [],
    unresolved: [],
    pending: [],
    conflicts: [],
    hints: { unlinked: [] },
    next: null,
    writes_left: plan.writesLeft
  }

  // 1. the note: create it (type folder, or concept in Inbox/), or add aliases and tags to it
  let noteId = pn.noteId
  const noteOps: VaultOp[] = []
  if (pn.create) {
    const c = pn.create
    noteOps.push({ op: 'createNote', title: c.title, type: c.type, ...(c.folder ? { folder: c.folder } : {}), ...(c.summary ? { summary: c.summary } : {}), ...(c.aliases.length ? { aliases: c.aliases } : {}), ...(c.tags.length ? { properties: { tags: c.tags } } : {}) })
  } else if (noteId) {
    for (const a of pn.addAliases) noteOps.push({ op: 'addAlias', note: noteId, alias: a })
    if (pn.addTags.length) {
      const have = (index.db.prepare(`SELECT tag_display FROM mem_tag WHERE company_id = ? AND note_id = ? AND origin = 'frontmatter'`).all(companyId, noteId) as { tag_display: string }[]).map((t) => t.tag_display)
      const merged = [...new Set([...have, ...pn.addTags])]
      if (merged.length !== have.length) noteOps.push({ op: 'setProperty', note: noteId, key: 'tags', value: merged })
    }
  }
  if (noteOps.length) {
    const res = await writer.apply(companyId, noteOps, step(ctx, 'note'))
    const err = firstError(res)
    if (pn.create) {
      const r0 = res.results[0]
      if (!r0 || r0.status === 'error' || !r0.noteId) throw new Error(err ?? 'could not create the note')
      noteId = r0.noteId
      out.created = r0.status === 'ok'
    } else if (err) out.conflicts.push(err)
  }
  const note = noteId ? index.noteById(companyId, noteId) : null
  if (!note) throw new Error(`the note "${pn.name}" is not in this Passport`)
  out.note = noteLink(note)
  out.path = note.path

  const notes = companyNotes(index.db, companyId)
  const trie = new TitleTrie(notes)

  // 2. facts and relations of this note in one writer batch
  const ops: VaultOp[] = []
  const opFacts: { fact: PlannedFact; text: string; index: number }[] = []
  const pendingProps: PendingProposal[] = []
  for (const f of plan.facts) {
    if (f.status === 'duplicate') {
      out.duplicates.push({ ref: lineRef(note, f.existing?.blockId ?? null, f.existing?.id), text: f.existing?.text ?? f.text })
      continue
    }
    // autolink counts as the agent's write: exact, unambiguous title/alias matches outside code and links
    const al = plan.source.kind === 'agent' ? autolinkText(f.text, trie, { max: AUTOLINK_MAX, excludeIds: [note.id] }) : { text: f.text, linked: [] }
    for (const l of al.linked) {
      const row = notes.find((n) => n.id === l.noteId)
      if (row) out.autolinked.push(`[[${pathStem(row.path)}]]`)
    }
    for (const m of trie.find(al.text, { skip: lineSkipRanges(al.text), excludeIds: [note.id] }).filter((m) => m.ambiguous).slice(0, 3)) {
      out.hints.unlinked.push(`"${m.text}" could mean ${m.candidates.slice(0, 3).map((id) => `[[${pathStem(notes.find((n) => n.id === id)?.path ?? id)}]]`).join(' or ')}; link the one you mean`)
    }
    if (f.status === 'quarantined' || f.status === 'contested') {
      const target = f.supersedes
      let blockId: string | null = null
      if (f.status === 'contested' && target) blockId = await materialize(deps, companyId, target, ctx)
      const proposalOps: VaultOp[] =
        f.status === 'contested' && blockId ? [{ op: 'supersede', blockId, text: al.text }] : [{ op: 'observe', note: note.id, category: f.category, text: al.text }]
      pendingProps.push({
        kind: f.status === 'contested' ? 'fact_supersede' : 'harvest',
        title: f.status === 'contested' ? `Replace a line in ${noteLink(note)}` : `Agent fact for ${noteLink(note)}`,
        ops: proposalOps,
        quote: f.status === 'contested' && target ? target.text : al.text,
        path: note.path,
        line: target?.line ?? null,
        why: f.why ?? '',
        fingerprint: `${f.status === 'contested' ? 'fact_supersede' : 'quarantine'}:${note.id}:${blockId ?? ''}:${textHash(al.text)}`
      })
      out.pending.push({ text: al.text, why: f.why ?? '', proposal: null })
      continue
    }
    let op: VaultOp
    if (f.supersedes) {
      const blockId = await materialize(deps, companyId, f.supersedes, ctx)
      op = blockId ? { op: 'supersede', blockId, text: al.text } : { op: 'observe', note: note.id, category: f.category, text: al.text }
    } else op = { op: 'observe', note: note.id, category: f.category, text: al.text }
    opFacts.push({ fact: f, text: al.text, index: ops.length })
    ops.push(op)
  }
  const relIndex: { rel: string; to: string; index: number }[] = []
  for (const r of plan.relations) {
    const display = `[[${r.to}]]`
    if (r.status === 'duplicate') {
      out.linked.push({ to: display, via: 'relation (exists)', type: r.rel })
      continue
    }
    if (plan.createMissing) {
      const res = index.resolve(companyId, r.to)
      if (!res.toNote && !res.ambiguous) ops.push({ op: 'createNote', title: r.to, type: guessTargetType(r.rel) ?? 'concept', folder: 'Inbox' })
    }
    relIndex.push({ rel: r.rel, to: r.to, index: ops.length })
    ops.push({ op: 'relate', from: note.id, rel: r.rel, to: r.to, ...(r.context ? { context: r.context } : {}) })
  }
  let res: VaultApplyResult = { results: [], conflicts: [] }
  if (ops.length) res = await writer.apply(companyId, ops, step(ctx, 'body'))
  const fresh = index.noteById(companyId, note.id) ?? note
  for (const of of opFacts) {
    const r: VaultOpResult | undefined = res.results[of.index]
    if (!r) continue
    if (r.status === 'ok') out.written.push({ ref: lineRef(fresh, r.blockId), text: of.text })
    else if (r.status === 'noop') out.duplicates.push({ ref: lineRef(fresh, r.blockId), text: of.text })
    else out.conflicts.push(r.reason ?? r.status)
  }
  for (const ri of relIndex) {
    const r = res.results[ri.index]
    if (!r) continue
    if (r.status === 'ok' || r.status === 'noop') out.linked.push({ to: `[[${ri.to}]]`, via: r.status === 'ok' ? 'relation' : 'relation (exists)', type: ri.rel })
    else out.conflicts.push(r.reason ?? r.status)
  }

  // 3. proposals for held-back lines (after the batch, so a proposal never races the writes above)
  for (const [i, p] of pendingProps.entries()) {
    const cur = index.noteById(companyId, note.id)
    // out.pending and pendingProps are pushed together, so they align
    out.pending[i].proposal = fileProposal(deps, companyId, p, cur ? { path: cur.path, hash: cur.hash } : null)
  }

  // 4. what the agent should know next: links in its own text, ghosts, near-duplicates
  const unresolved = new Map<string, VaultUnresolved>()
  const consider = (name: string) => {
    const key = normName(name)
    if (!key || unresolved.has(key)) return
    const u = unresolvedFor(index, companyId, name, notes)
    if (u) unresolved.set(key, u)
  }
  for (const of of opFacts) {
    for (const l of scanLinks(of.text)) {
      if (l.target) {
        consider(l.target)
        if (index.resolve(companyId, l.target).toNote) out.linked.push({ to: `[[${l.target}]]`, via: 'fact', type: 'links_to' })
      }
    }
  }
  for (const ri of relIndex) consider(ri.to)
  out.unresolved = [...unresolved.values()]
  const active = index.db
    .prepare(`SELECT id, block_id, text FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'active' AND dup_of IS NULL`)
    .all(companyId, note.id) as { id: string; block_id: string | null; text: string }[]
  const writtenTexts = new Set(out.written.map((w) => normName(w.text)))
  for (const w of out.written) {
    for (const f of active) {
      if (writtenTexts.has(normName(f.text)) || out.similar.length >= 3) continue
      if (tokenJaccard(w.text, f.text) >= 0.5) out.similar.push({ ref: lineRef(fresh, f.block_id, f.id), text: f.text })
    }
  }
  out.next = nextHint(out, fresh, index, companyId)
  return out
}

/** The single best follow-up (§7.2 `next`). */
function nextHint(out: VaultWriteResult, note: NoteRow, index: VaultIndexer, companyId: string): string | null {
  const ghost = out.unresolved.find((u) => u.status === 'ghost' && u.did_you_mean.length)
  if (ghost) return `${ghost.to.slice(2, -2)} is a ghost. If you meant ${ghost.did_you_mean[0]}, call memory_link.`
  const amb = out.unresolved.find((u) => u.status === 'ambiguous')
  if (amb) return `${amb.to} matches several notes (${amb.did_you_mean.join(', ')}); link the exact title.`
  if (out.pending.length) return 'Some lines await the user in the Passport Inbox; do not write them again.'
  if (out.similar.length) return `${out.similar[0].ref} looks similar; supersede it by ^id instead of keeping both.`
  const degree = (index.db.prepare('SELECT count(*) AS n FROM mem_link WHERE company_id = ? AND (from_note = ? OR to_note = ?)').get(companyId, note.id, note.id) as { n: number }).n
  if (degree === 0) return `${noteLink(note)} has no links yet; link it to related notes with memory_link.`
  return null
}

// ---------- memory_link ----------

export async function sinkLinks(deps: SinkDeps, plan: WritePlan): Promise<VaultLinkResult> {
  const { index, writer } = deps
  const companyId = plan.companyId
  const notes = companyNotes(index.db, companyId)
  const out: VaultLinkResult = { linked: [], unresolved: [], writes_left: plan.writesLeft }
  const ops: VaultOp[] = []
  const slots: number[] = []
  for (const l of plan.links) {
    const from = l.fromId ? index.noteById(companyId, l.fromId) : null
    const fromName = from ? noteLink(from) : `[[${parseLinkTarget(l.from).target}]]`
    if (l.error || !from) {
      out.linked.push({ from: fromName, type: l.rel, to: `[[${l.to}]]`, ref: null, result: 'error', why: l.error ?? 'unknown note' })
      slots.push(-1)
      continue
    }
    if (l.status === 'duplicate') {
      out.linked.push({ from: fromName, type: l.rel, to: `[[${l.to}]]`, ref: null, result: 'duplicate' })
      slots.push(-1)
      continue
    }
    out.linked.push({ from: fromName, type: l.rel, to: `[[${l.to}]]`, ref: null, result: 'added' })
    slots.push(ops.length)
    ops.push({ op: 'relate', from: from.id, rel: l.rel, to: l.to, ...(l.context ? { context: l.context } : {}) })
  }
  if (ops.length) {
    const res = await writer.apply(companyId, ops, step(plan.ctx, 'links'))
    slots.forEach((slot, i) => {
      if (slot < 0) return
      const r = res.results[slot]
      const item = out.linked[i]
      if (!r || r.status === 'error' || r.status === 'conflict') {
        item.result = 'error'
        item.why = r?.reason ?? 'not written'
        return
      }
      if (r.status === 'noop') item.result = 'duplicate'
      const from = index.noteById(companyId, r.noteId ?? '')
      item.ref = from ? lineRef(from, r.blockId) : null
    })
  }
  const seen = new Set<string>()
  for (const l of plan.links) {
    const key = normName(l.to)
    if (seen.has(key)) continue
    seen.add(key)
    const u = unresolvedFor(index, companyId, l.to, notes)
    if (u) out.unresolved.push(u)
  }
  return out
}

// ---------- memory_invalidate ----------

export async function sinkInvalidate(deps: SinkDeps, plan: WritePlan): Promise<VaultInvalidateResult> {
  const { index, writer } = deps
  const companyId = plan.companyId
  const out: VaultInvalidateResult = { items: [], writes_left: plan.writesLeft }
  const reason = plan.reason ?? 'invalidated'
  for (const it of plan.invalidations) {
    if (it.status === 'not_found' || it.status === 'already_invalid' || !it.target) {
      out.items.push({ ref: it.ref, result: it.status === 'already_invalid' ? 'already_invalid' : 'not_found' })
      continue
    }
    const blockId = await materialize(deps, companyId, it.target, plan.ctx)
    if (!blockId) {
      out.items.push({ ref: it.ref, result: 'conflict', why: 'the line changed; read the note again' })
      continue
    }
    const note = index.noteById(companyId, it.target.note_id)
    if (it.status === 'contested') {
      const id = fileProposal(
        deps,
        companyId,
        {
          kind: 'fact_supersede',
          title: `Invalidate a line in ${note ? noteLink(note) : 'a note'}`,
          ops: [{ op: 'invalidate', blockId, reason }],
          quote: it.target.text,
          path: note?.path ?? null,
          line: it.target.line,
          why: `the line was written or approved by the user (reason given: ${reason})`,
          fingerprint: `invalidate:${blockId}:${textHash(reason)}`
        },
        note ? { path: note.path, hash: note.hash } : null
      )
      out.items.push({ ref: note ? lineRef(note, blockId) : it.ref, result: 'contested', why: `user-approved line; awaits review${id ? ` (${id})` : ''}` })
      continue
    }
    const res = await writer.apply(companyId, [{ op: 'invalidate', blockId, reason }], step(plan.ctx, `inv:${blockId}`))
    const r = res.results[0]
    const ref = note ? lineRef(note, blockId) : it.ref
    if (r?.status === 'ok' || r?.status === 'noop') out.items.push({ ref, result: 'invalidated' })
    else out.items.push({ ref, result: 'conflict', why: r?.reason ?? 'not written' })
  }
  return out
}

