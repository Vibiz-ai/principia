// The vault writer (PASSPORT.md §6.4, §6.5), main process only. Agents, the UI, migration and accepted suggestions all
// write through `apply`: semantic ops become minimal line splices (shared/vault/patch.ts) applied under one serialized
// queue per vault, with compare-and-swap against the bytes the op was computed from:
//
//   read + hash (base) -> patch -> tmp + fsync -> re-read: changed since base? retry (3x) -> rename() over the original
//   -> register the expected hash (watcher) -> indexNote synchronously -> mem_event + log.jsonl
//
// Ops never guess: a block id that is gone becomes a `mem_conflict` row plus a review item. The writer has no delete:
// archive replaces it, History keeps superseded and invalidated lines, and nothing here removes a file.

import fs from 'node:fs'
import path from 'node:path'
import type { VaultApplyResult, VaultConflict, VaultOp, VaultOpResult, VaultPropertyValue } from '../../../shared/passport'
import { type Actor, type NoteType, type Provenance, normalizeNoteType, parseBulletLine, parseHeading, splitLines, joinLines, formatObservation } from '../../../shared/vault/grammar'
import { type FmValue, fmList } from '../../../shared/vault/frontmatter'
import { isNoteId, newBlockId, newNoteId, textHash } from '../../../shared/vault/ids'
import { normalizeRelType } from '../../../shared/vault/ontology'
import { parseNote, type ParsedNote } from '../../../shared/vault/parse'
import {
  PatchError,
  type ProvInput,
  addAlias,
  appendLine,
  appendObservation,
  appendRelation,
  archive,
  ensureNoteId,
  invalidate,
  linkMention,
  materializeId,
  relocateRemovedFacts,
  removeAlias,
  reinforceTaste,
  restoreLine,
  retargetLinks,
  setProperty,
  supersede
} from '../../../shared/vault/patch'
import { normName, normPath, parseLinkTarget, pathStem } from '../../../shared/vault/resolve'
import { isoDate, renderNote } from '../../../shared/vault/serialize'
import { joinNotePath, pathForNewNote, uniqueStem } from '../../../shared/vault/slug'
import { merge3 } from '../../../shared/vault/diff3'
import { readFileState, sha1, writeTmp, type FileState } from './fsutil'
import { type ConflictRow, findOpResult, insertConflict, insertProposal, saveOpResult } from './indexDb'
import type { NoteRow, VaultIndexer } from './indexer'
import { logEvent } from './log'
import type { WriterLocks } from './lock'
import { isNotePath, toVaultAbs } from './paths'
import { readSnapshot } from './snapshots'
import { ExpectedWrites } from './watcher'

export interface WriteContext {
  actor: Actor
  grantId?: string | null
  runId?: string | null
  sessionId?: string | null
  /** Accepted suggestion id: provenance reads `user via suggestion sg-x`. */
  via?: string | null
  /** Idempotency key (`grantId + MCP call id`): a replay returns the first result. */
  opId?: string | null
  /** The provenance date (`YYYY-MM-DD`) for lines this call writes; default the writer's clock. The migration passes
   * its own run date so a run's lines all carry one date. */
  date?: string
}

export interface WriterHooks {
  /** Runs after the tmp file is written and before the CAS re-check (tests simulate a concurrent editor save here). */
  beforeCommit?: (abs: string, attempt: number) => void
}

export interface WriterOptions {
  locks?: WriterLocks
  expected?: ExpectedWrites
  now?: () => Date
  hooks?: WriterHooks
}

export type SaveResult =
  | { status: 'saved'; hash: string; path: string; noteId: string | null; movedToHistory: number; keptHistory: number }
  | { status: 'conflict'; base: string; ours: string; theirs: string; theirsHash: string; merged: string | null; clean: boolean }
  | { status: 'error'; reason: string }

/** CAS attempts: the first try plus 3 retries (§6.4 step 4). */
const ATTEMPTS = 4
const CONFLICT_CODES = new Set(['block_not_found', 'already_history', 'not_history', 'bad_line', 'bad_span', 'has_anchor'])
/** Frontmatter keys ops may not set directly (identity, or owned by other ops). */
const RESERVED_KEYS = new Set(['id', 'title', 'aliases', 'alias', 'status', 'merged_into', 'created'])

class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly conflict = false
  ) {
    super(message)
  }
}

interface Mutation {
  text: string
  changed: boolean
  blockId?: string | null
}

interface Committed {
  status: 'ok' | 'noop'
  path: string
  noteId: string | null
  hash: string
  baseHash: string | null
  blockId: string | null
}

interface OpOutcome {
  result: Omit<VaultOpResult, 'index'> & { linksRewritten?: number }
  conflict?: VaultConflict
  paths: string[]
  noteIds: string[]
}

export class VaultWriter {
  private queues = new Map<string, Promise<unknown>>()
  readonly expected: ExpectedWrites

  constructor(
    readonly index: VaultIndexer,
    private opts: WriterOptions = {}
  ) {
    this.expected = opts.expected ?? new ExpectedWrites()
  }

  private get db() {
    return this.index.db
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /** Why this process may not write the vault (another Principia holds writer.lock), or null. */
  readOnlyReason(companyId: string): string | null {
    if (!this.opts.locks) return null
    const st = this.opts.locks.acquire(this.index.root(companyId))
    return st.held ? null : (st.reason ?? 'read-only')
  }

  /** One serialized queue per vault: appends commute, so N agents observing one note never lose an update. */
  private enqueue<T>(companyId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(companyId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.queues.set(
      companyId,
      next.catch(() => undefined)
    )
    return next
  }

  // ---------- public API ----------

  apply(companyId: string, ops: VaultOp[], ctx: WriteContext): Promise<VaultApplyResult> {
    return this.enqueue(companyId, () => this.applyNow(companyId, ops, ctx))
  }

  /** Principia editor save (§6.4): stale base -> diff3; removed block-id lines move to History, never dropped. */
  save(companyId: string, req: { path: string; baseHash: string; text: string }, ctx: WriteContext): Promise<SaveResult> {
    return this.enqueue(companyId, () => this.saveNow(companyId, req, ctx))
  }

  /** Inbox "Restore" for an external delete: writes the snapshot back to its path (or a free one next to it). */
  restoreRemoved(companyId: string, noteId: string, ctx: WriteContext): Promise<VaultOpResult> {
    return this.enqueue(companyId, () => this.restoreRemovedNow(companyId, noteId, ctx))
  }

  /** Inbox "Restore" for observations removed from a live note outside Principia: re-appends them with their block ids. */
  restoreRemovedLines(companyId: string, noteId: string, factIds: string[], ctx: WriteContext): Promise<VaultOpResult> {
    return this.enqueue(companyId, () => this.restoreLinesNow(companyId, noteId, factIds, ctx))
  }

  // ---------- apply ----------

  private applyNow(companyId: string, ops: VaultOp[], ctx: WriteContext): VaultApplyResult {
    if (ctx.opId) {
      const replay = findOpResult<VaultApplyResult>(this.db, companyId, ctx.opId)
      if (replay) return replay
    }
    const results: VaultOpResult[] = []
    const conflicts: VaultConflict[] = []
    const ro = this.readOnlyReason(companyId)
    const paths = new Set<string>()
    const noteIds = new Set<string>()
    ops.forEach((op, index) => {
      if (ro) {
        results.push({ index, status: 'error', path: null, noteId: null, blockId: null, hash: null, reason: ro })
        return
      }
      let out: OpOutcome
      try {
        out = this.applyOp(companyId, op, ctx)
      } catch (e) {
        out = this.failure(companyId, op, e)
      }
      results.push({ index, ...out.result })
      if (out.conflict) conflicts.push(out.conflict)
      out.paths.forEach((p) => paths.add(p))
      out.noteIds.forEach((n) => noteIds.add(n))
    })
    const res: VaultApplyResult = { results, conflicts }
    // a read-only refusal is not a result to replay: the same call may succeed once the lock is free
    if (ctx.opId && !ro) saveOpResult(this.db, companyId, ctx.opId, res, this.now().toISOString())
    this.index.emitChanged({ companyId, paths: [...paths], noteIds: [...noteIds] })
    return res
  }

  private failure(companyId: string, op: VaultOp, e: unknown): OpOutcome {
    const code = e instanceof PatchError || e instanceof OpError ? e.code : 'error'
    const message = e instanceof Error ? e.message : String(e)
    const isConflict = (e instanceof OpError && e.conflict) || (e instanceof PatchError && CONFLICT_CODES.has(e.code))
    if (!isConflict) {
      return { result: { status: 'error', path: null, noteId: null, blockId: null, hash: null, reason: `${code}: ${message}` }, paths: [], noteIds: [] }
    }
    const target = (e as { target?: { path: string; noteId: string | null; baseHash: string | null; currentHash: string | null } }).target
    const conflict = this.recordConflict(companyId, op, target?.path ?? '', `${code}: ${message}`, target?.baseHash ?? null, target?.currentHash ?? null)
    return {
      result: { status: 'conflict', path: target?.path ?? null, noteId: target?.noteId ?? null, blockId: blockOf(op), hash: target?.currentHash ?? null, reason: conflict.reason },
      conflict,
      paths: [],
      noteIds: []
    }
  }

  /** A conflict row plus its review item (§6.4: never guessed). */
  private recordConflict(companyId: string, op: VaultOp, rel: string, reason: string, baseHash: string | null, currentHash: string | null): VaultConflict {
    const at = this.now().toISOString()
    const row: ConflictRow = insertConflict(this.db, { companyId, path: rel, op, reason, baseHash, currentHash, createdAt: at })
    insertProposal(this.db, {
      companyId,
      kind: 'conflict',
      payload: [op],
      evidence: [{ path: rel || null, line: null, quote: reason, note: null }],
      score: 1,
      source: 'writer',
      fingerprint: `conflict:${row.id}`,
      baseHashes: rel && currentHash ? { [rel]: currentHash } : {},
      createdAt: at
    })
    return { id: row.id, companyId, path: rel, op, reason, baseHash, currentHash, createdAt: at, resolvedAt: null }
  }

  /** The line as it was before the last invalidate/supersede of `blockId` (mem_event.before_json), parsed. */
  private originalLine(companyId: string, blockId: string): { category: string | null; prov: Provenance | null } | null {
    const row = this.db
      .prepare(`SELECT before_json FROM mem_event WHERE company_id = ? AND block_id = ? AND op IN ('invalidate','supersede') AND before_json IS NOT NULL ORDER BY seq DESC LIMIT 1`)
      .get(companyId, blockId.replace(/^\^/, '')) as { before_json: string } | undefined
    if (!row) return null
    try {
      const line = (JSON.parse(row.before_json) as { line?: unknown }).line
      if (typeof line !== 'string') return null
      const b = parseBulletLine(line)
      if (!b) return null
      return { category: b.kind === 'observation' ? b.category : null, prov: b.prov }
    } catch {
      return null
    }
  }

  private prov(ctx: WriteContext): ProvInput {
    return { actor: ctx.actor, runId: ctx.runId ?? null, sessionId: ctx.sessionId ?? null, via: ctx.via ?? null, date: ctx.date ?? isoDate(this.now()) }
  }

  private applyOp(companyId: string, op: VaultOp, ctx: WriteContext): OpOutcome {
    switch (op.op) {
      case 'createNote':
        return this.createNote(companyId, op, ctx)
      case 'observe': {
        const note = this.resolveNote(companyId, op.note)
        const prov = this.prov(ctx)
        const probe = parseBulletLine(formatObservation({ category: op.category, text: op.text, tags: op.tags }))
        const hash = textHash(probe && probe.kind === 'observation' ? probe.text : op.text)
        return this.edit(companyId, op, note, ctx, 'create', 'fact', (text) => {
          const parsed = parseNote(text)
          const dup = parsed.facts.find((f) => f.status === 'active' && textHash(f.text) === hash)
          if (dup) return { text, changed: false, blockId: dup.blockId }
          return appendObservation(text, { category: op.category, text: op.text, tags: op.tags, prov })
        })
      }
      case 'relate': {
        const note = this.resolveNote(companyId, op.from)
        const target = this.linkTarget(companyId, op.to)
        const rel = op.rel.trim()
        const prov = this.prov(ctx)
        return this.edit(companyId, op, note, ctx, 'create', 'relation', (text) => {
          const parsed = parseNote(text)
          const dup = parsed.relations.find((r) => r.status === 'active' && r.normRel === normalizeRelType(rel) && normName(r.link.target) === normName(target.target))
          if (dup) return { text, changed: false, blockId: dup.blockId }
          return appendRelation(text, { rel, target: target.target, display: target.display, context: op.context ?? null, prov })
        })
      }
      case 'supersede': {
        const { note, blockId } = this.blockNote(companyId, op.blockId)
        const prov = this.prov(ctx)
        let before: { line: string } | undefined
        return this.edit(companyId, op, note, ctx, 'supersede', 'fact', (text) => ((before = rawLineOf(text, blockId)), supersede(text, blockId, { text: op.text }, prov)), blockId, () => before)
      }
      case 'invalidate': {
        const { note, blockId, kind } = this.blockNote(companyId, op.blockId)
        const prov = this.prov(ctx)
        let before: { line: string } | undefined
        return this.edit(companyId, op, note, ctx, 'invalidate', kind, (text) => ((before = rawLineOf(text, blockId)), invalidate(text, blockId, op.reason, prov)), blockId, () => before)
      }
      case 'restoreLine': {
        const { note, blockId, kind } = this.blockNote(companyId, op.blockId)
        // §6.5: the History line keeps only who moved it; the line comes back with its original category and
        // provenance, read from the invalidate/supersede event that moved it (else the restorer's provenance)
        const original = this.originalLine(companyId, blockId)
        const prov = original?.prov?.date ? { ...original.prov, date: original.prov.date } : this.prov(ctx)
        return this.edit(companyId, op, note, ctx, 'restore', kind, (text) => restoreLine(text, blockId, { prov, ...(original?.category ? { category: original.category } : {}) }), blockId)
      }
      case 'reinforce': {
        const { note, blockId } = this.blockNote(companyId, op.blockId)
        let before: { line: string } | undefined
        return this.edit(companyId, op, note, ctx, 'update', 'fact', (text) => ((before = rawLineOf(text, blockId)), reinforceTaste(text, blockId, op.example ?? null)), blockId, () => before)
      }
      case 'setProperty': {
        const key = op.key.trim()
        if (!key || RESERVED_KEYS.has(key.toLowerCase())) throw new OpError('reserved_key', `"${op.key}" cannot be set with setProperty`)
        const note = this.resolveNote(companyId, op.note)
        return this.edit(companyId, op, note, ctx, 'property', 'property', (text) => setProperty(text, key, toFm(op.value)))
      }
      case 'addAlias': {
        const note = this.resolveNote(companyId, op.note)
        return this.edit(companyId, op, note, ctx, 'alias', 'alias', (text) => addAlias(text, op.alias))
      }
      case 'archive': {
        const note = this.resolveNote(companyId, op.note)
        return this.edit(companyId, op, note, ctx, 'archive', 'note', (text) => archive(text))
      }
      case 'linkMention': {
        const note = this.resolveNote(companyId, op.note)
        const target = this.linkTarget(companyId, op.target)
        return this.edit(companyId, op, note, ctx, 'link', 'link', (text) => linkMention(text, op.line, op.span, target.target, op.text))
      }
      case 'materializeId': {
        const note = this.resolveNote(companyId, op.note)
        return this.edit(companyId, op, note, ctx, 'materialize', 'fact', (text) => materializeId(text, op.line))
      }
      case 'rename':
        return this.rename(companyId, op, ctx)
      case 'merge':
        return this.merge(companyId, op, ctx)
      default:
        throw new OpError('unknown_op', `unknown op ${(op as { op: string }).op}`)
    }
  }

  // ---------- targets ----------

  /** A note named as `[[Title]]`, title, alias, path or note id; ghosts and ambiguous names are errors. */
  private resolveNote(companyId: string, name: string): NoteRow {
    const raw = name.trim()
    let row: NoteRow | null = null
    if (isNoteId(raw) || raw.startsWith('h:')) row = this.index.noteById(companyId, raw)
    else if (/\.md$/i.test(raw) && !raw.startsWith('[[')) row = this.index.noteByPath(companyId, raw)
    if (!row) {
      const r = this.index.resolve(companyId, raw)
      if (r.ambiguous) {
        const titles = r.candidates.map((id) => this.index.noteById(companyId, id)?.title ?? id)
        throw new OpError('ambiguous', `"${raw}" matches several notes: ${titles.map((t) => `[[${t}]]`).join(', ')}`)
      }
      if (r.toNote) row = this.index.noteById(companyId, r.toNote)
    }
    if (!row || row.removed_at) throw new OpError('note_not_found', `no note named "${raw}"`)
    return row
  }

  /** The `[[target|display]]` to write for a name: the real basename for existing notes, the cleaned name for ghosts. */
  private linkTarget(companyId: string, name: string): { target: string; display: string | null } {
    const typed = parseLinkTarget(name).target.trim()
    if (!typed) throw new OpError('empty_target', 'a link needs a target')
    const r = this.index.resolve(companyId, typed)
    const row = r.toNote ? this.index.noteById(companyId, r.toNote) : null
    if (!row) return { target: typed, display: null }
    const stem = pathStem(row.path)
    return { target: stem, display: normName(typed) !== normName(stem) ? typed : null }
  }

  private blockNote(companyId: string, ref: string): { note: NoteRow; blockId: string; kind: 'fact' | 'relation' } {
    const blockId = ref.replace(/^.*#\^/, '').replace(/\]\]$/, '').replace(/^\^/, '').trim()
    const hit = this.index.findBlock(companyId, blockId)
    const note = hit ? this.index.noteById(companyId, hit.noteId) : null
    if (!hit || !note || note.removed_at) {
      throw Object.assign(new OpError('block_not_found', `^${blockId} is not in this Passport (edited or deleted?)`, true), {
        target: { path: '', noteId: null, baseHash: null, currentHash: null }
      })
    }
    return { note, blockId, kind: hit.kind }
  }

  // ---------- the CAS write ----------

  /**
   * Read-patch-write with compare-and-swap (§6.4 steps 2-5). `mutate` runs on the current bytes every attempt.
   * `create` writes a new file and refuses to overwrite one. Indexes synchronously; returns the committed state.
   */
  private commit(companyId: string, rel: string, mutate: (text: string, file: FileState | null) => Mutation, opts: { create?: boolean; touch?: boolean; noteId?: string | null } = {}): Committed & { mutation: Mutation } {
    const root = this.index.root(companyId)
    const abs = toVaultAbs(root, rel)
    let last: FileState | null = null
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const base = readFileState(abs)
      last = base
      if (opts.create ? base !== null : base === null) {
        throw Object.assign(new OpError(opts.create ? 'exists' : 'note_missing', opts.create ? `${rel} already exists` : `${rel} is gone`, !opts.create), {
          target: { path: rel, noteId: opts.noteId ?? null, baseHash: base?.hash ?? null, currentHash: base?.hash ?? null }
        })
      }
      let m: Mutation
      try {
        m = mutate(base?.text ?? '', base)
        if (m.changed && opts.touch !== false && !opts.create) m = { ...m, text: this.touch(m.text) }
      } catch (e) {
        if (e instanceof PatchError || e instanceof OpError) Object.assign(e, { target: { path: rel, noteId: opts.noteId ?? null, baseHash: base?.hash ?? null, currentHash: base?.hash ?? null } })
        throw e
      }
      if (!m.changed) {
        return { status: 'noop', path: rel, noteId: opts.noteId ?? null, hash: base!.hash, baseHash: base!.hash, blockId: m.blockId ?? null, mutation: m }
      }
      const tmp = writeTmp(abs, m.text)
      this.opts.hooks?.beforeCommit?.(abs, attempt)
      const now = readFileState(abs)
      const moved = opts.create ? now !== null : !now || now.hash !== base!.hash || now.mtimeMs !== base!.mtimeMs || now.size !== base!.size
      if (moved) {
        last = now
        continue // a human saved mid-op: recompute from the new bytes (the tmp is overwritten next attempt)
      }
      const hash = sha1(m.text)
      this.expected.register(abs, hash)
      fs.renameSync(tmp, abs)
      const r = this.index.indexNote(companyId, rel, { own: true, emit: false })
      return { status: 'ok', path: rel, noteId: r.noteId, hash, baseHash: base?.hash ?? null, blockId: m.blockId ?? null, mutation: m }
    }
    throw Object.assign(new OpError('cas_exhausted', `${rel} kept changing while writing; try again`, true), {
      target: { path: rel, noteId: opts.noteId ?? null, baseHash: last?.hash ?? null, currentHash: last?.hash ?? null }
    })
  }

  /** Every Principia edit gives the note a real id (§3.1) and bumps `modified`. Unparseable frontmatter is never rewritten. */
  private touch(text: string): string {
    const parsed = parseNote(text)
    if ((parsed.frontmatter && !parsed.frontmatter.ok) || parsed.warnings.includes('frontmatter is not closed')) {
      throw new OpError('unparseable', 'the note frontmatter does not parse; edit it in Obsidian first')
    }
    let t = ensureNoteId(text, newNoteId()).text
    t = setProperty(t, 'modified', isoDate(this.now())).text
    return t
  }

  private edit(
    companyId: string,
    op: VaultOp,
    note: NoteRow,
    ctx: WriteContext,
    eventOp: string,
    kind: 'note' | 'fact' | 'relation' | 'alias' | 'property' | 'link',
    mutate: (text: string) => Mutation,
    blockHint?: string,
    beforeOf?: () => unknown
  ): OpOutcome {
    const c = this.commit(companyId, note.path, (text) => mutate(text), { noteId: note.id })
    const blockId = c.blockId ?? blockHint ?? null
    if (c.status === 'ok') {
      this.log(companyId, ctx, { op: eventOp, kind, targetId: blockId ?? c.noteId ?? note.id, noteId: c.noteId ?? note.id, path: c.path, blockId, baseHash: c.baseHash, newHash: c.hash, after: opSummary(op), before: beforeOf?.() })
    }
    return {
      result: { status: c.status, path: c.path, noteId: c.noteId ?? note.id, blockId, hash: c.hash, reason: null },
      paths: c.status === 'ok' ? [c.path] : [],
      noteIds: c.status === 'ok' ? [c.noteId ?? note.id] : []
    }
  }

  private log(
    companyId: string,
    ctx: WriteContext,
    e: { op: string; kind: 'note' | 'fact' | 'relation' | 'alias' | 'property' | 'link'; targetId: string; noteId: string; path: string; blockId: string | null; baseHash: string | null; newHash: string | null; after?: unknown; before?: unknown }
  ): void {
    logEvent(this.db, this.index.root(companyId), {
      ts: this.now().toISOString(),
      companyId,
      op: e.op,
      targetKind: e.kind,
      targetId: e.targetId,
      entityId: e.noteId,
      path: e.path,
      blockId: e.blockId,
      actor: ctx.via ? `${ctx.actor} via suggestion ${ctx.via}` : ctx.actor,
      grantId: ctx.grantId ?? null,
      runId: ctx.runId ?? null,
      opId: ctx.opId ?? null,
      baseHash: e.baseHash,
      newHash: e.newHash,
      before: e.before,
      after: e.after
    })
  }

  // ---------- createNote ----------

  private createNote(companyId: string, op: Extract<VaultOp, { op: 'createNote' }>, ctx: WriteContext): OpOutcome {
    const title = op.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new OpError('empty_title', 'a note needs a title')
    const existing = this.index.resolve(companyId, title)
    if (existing.toNote) {
      const row = this.index.noteById(companyId, existing.toNote)!
      return { result: { status: 'noop', path: row.path, noteId: row.id, blockId: null, hash: row.hash, reason: 'a note with this name exists' }, paths: [], noteIds: [] }
    }
    const type: NoteType = normalizeNoteType(op.type)
    const folder = op.folder?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (folder) {
      toVaultAbs(this.index.root(companyId), `${folder}/x.md`)
      if (!isNotePath(`${folder}/x.md`)) throw new OpError('bad_folder', `"${op.folder}" is not a note folder`)
    }
    const root = this.index.root(companyId)
    const taken = new Set<string>()
    const isTaken = (key: string): boolean =>
      taken.has(key) || !!this.db.prepare('SELECT 1 FROM mem_note WHERE company_id = ? AND basename_norm = ? AND removed_at IS NULL').get(companyId, key)
    const properties: Array<[string, FmValue]> = []
    for (const [k, v] of Object.entries(op.properties ?? {})) {
      const fm = toFm(v)
      if (fm === undefined || RESERVED_KEYS.has(k.toLowerCase()) || ['type', 'modified', 'source', 'tags'].includes(k.toLowerCase())) continue
      properties.push([k, fm])
    }
    const tags = Array.isArray(op.properties?.tags) ? (op.properties!.tags as string[]) : undefined
    const id = newNoteId()
    const text = renderNote({
      id,
      title,
      type,
      aliases: (op.aliases ?? []).map((a) => a.trim()).filter((a) => a && normName(a) !== normName(title)),
      tags,
      properties,
      created: isoDate(this.now()),
      source: sourceOf(ctx),
      summary: op.summary ?? null
    })
    for (let i = 0; i < 20; i++) {
      const rel = pathForNewNote({ title, type, folder: folder ?? null }, isTaken)
      if (fs.existsSync(toVaultAbs(root, rel))) {
        taken.add(normName(pathStem(rel)))
        continue
      }
      const c = this.commit(companyId, rel, () => ({ text, changed: true }), { create: true, touch: false, noteId: id })
      this.log(companyId, ctx, { op: 'create', kind: 'note', targetId: id, noteId: id, path: rel, blockId: null, baseHash: null, newHash: c.hash, after: { title, type } })
      return { result: { status: 'ok', path: rel, noteId: c.noteId ?? id, blockId: null, hash: c.hash, reason: null }, paths: [rel], noteIds: [c.noteId ?? id] }
    }
    throw new OpError('no_path', `could not find a free filename for "${title}"`)
  }

  // ---------- rename ----------

  private rename(companyId: string, op: Extract<VaultOp, { op: 'rename' }>, ctx: WriteContext): OpOutcome {
    const note = this.resolveNote(companyId, op.note)
    const newTitle = op.newTitle.replace(/\s+/g, ' ').trim()
    if (!newTitle) throw new OpError('empty_title', 'a note needs a title')
    const root = this.index.root(companyId)
    const oldTitle = note.title
    const oldStem = pathStem(note.path)
    const oldKeys = new Set([normName(oldStem), normName(oldTitle)])
    if (normName(newTitle) === normName(oldTitle) && newTitle === oldTitle) {
      return { result: { status: 'noop', path: note.path, noteId: note.id, blockId: null, hash: note.hash, reason: null }, paths: [], noteIds: [] }
    }
    const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''
    const taken = (key: string): boolean =>
      key !== note.basename_norm && !!this.db.prepare('SELECT 1 FROM mem_note WHERE company_id = ? AND basename_norm = ? AND removed_at IS NULL').get(companyId, key)
    let newRel = joinNotePath(dir, uniqueStem(newTitle, note.type, taken))
    for (let n = 2; normPath(newRel) !== note.path_norm && fs.existsSync(toVaultAbs(root, newRel)) && n < 50; n++) {
      newRel = joinNotePath(dir, `${uniqueStem(newTitle, note.type, taken)} ${n}`)
    }
    // rename() replaces an existing target: never let it clobber a note the index has not seen yet
    if (normPath(newRel) !== note.path_norm && fs.existsSync(toVaultAbs(root, newRel))) throw new OpError('exists', `${newRel} already exists`)

    // 1. the note itself: title, H1, old title kept as an alias
    const c = this.commit(
      companyId,
      note.path,
      (text) => {
        let t = setProperty(text, 'title', newTitle).text
        t = addAlias(t, oldTitle).text
        t = renameH1(t, oldTitle, newTitle)
        return { text: t, changed: t !== text }
      },
      { noteId: note.id }
    )
    let finalRel = note.path
    // 2. the file
    if (newRel !== note.path) {
      fs.mkdirSync(path.dirname(toVaultAbs(root, newRel)), { recursive: true })
      fs.renameSync(toVaultAbs(root, note.path), toVaultAbs(root, newRel))
      const st = readFileState(toVaultAbs(root, newRel))
      if (st) this.expected.register(toVaultAbs(root, newRel), st.hash)
      // a case-only rename on a case-insensitive disk: both spellings stat, so index only the new one
      if (normPath(newRel) === note.path_norm) this.index.indexNote(companyId, newRel, { own: true, emit: false })
      else this.index.indexPaths(companyId, [note.path, newRel], { own: true, emit: false })
      finalRel = newRel
    }
    const noteId = this.index.noteByPath(companyId, finalRel)?.id ?? c.noteId ?? note.id
    const newStem = pathStem(finalRel)
    this.log(companyId, ctx, { op: 'rename', kind: 'note', targetId: noteId, noteId, path: finalRel, blockId: null, baseHash: c.baseHash, newHash: c.hash, before: { path: note.path, title: oldTitle }, after: { path: finalRel, title: newTitle } })

    // 3. vault-wide [[Old]] -> [[New]] (links that named the old basename or title; alias links keep resolving)
    const matches = (target: string): boolean => {
      const { name, norm } = { name: parseLinkTarget(target).target.replace(/\\/g, '/'), norm: normName(parseLinkTarget(target).target.replace(/\.md$/i, '')) }
      if (name.includes('/')) return oldKeys.has(normName((name.split('/').pop() ?? '').replace(/\.md$/i, '')))
      return oldKeys.has(norm)
    }
    const paths = [finalRel]
    let rewritten = 0
    for (const linker of this.linkersOf(companyId, noteId)) {
      const row = this.index.noteById(companyId, linker)
      if (!row || row.removed_at) continue
      try {
        let count = 0
        const r = this.commit(
          companyId,
          row.path,
          (text) => {
            const out = retargetLinks(text, matches, newStem)
            count = out.count
            return out
          },
          { noteId: row.id }
        )
        if (r.status === 'ok') {
          rewritten += count
          paths.push(r.path)
          this.log(companyId, ctx, { op: 'link', kind: 'link', targetId: row.id, noteId: row.id, path: r.path, blockId: null, baseHash: r.baseHash, newHash: r.hash, after: { renamed: { from: oldTitle, to: newTitle } } })
        }
      } catch {
        // one unwritable linker does not undo the rename; the stale links still resolve through the alias
      }
    }
    return {
      result: { status: 'ok', path: finalRel, noteId, blockId: null, hash: this.index.noteById(companyId, noteId)?.hash ?? c.hash, reason: null, linksRewritten: rewritten },
      paths,
      noteIds: [noteId]
    }
  }

  private linkersOf(companyId: string, noteId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT from_note FROM mem_link WHERE company_id = ? AND to_note = ? ORDER BY from_note').all(companyId, noteId) as { from_note: string }[]).map(
      (r) => r.from_note
    )
  }

  // ---------- merge B into A ----------

  private merge(companyId: string, op: Extract<VaultOp, { op: 'merge' }>, ctx: WriteContext): OpOutcome {
    const b = this.resolveNote(companyId, op.from)
    const a = this.resolveNote(companyId, op.into)
    if (a.id === b.id) throw new OpError('same_note', 'cannot merge a note into itself')
    const aStem = pathStem(a.path)
    const bStem = pathStem(b.path)
    const paths = new Set<string>()
    const memo = new Map()
    const pointsAtB = (target: string): boolean => this.index.resolve(companyId, target, memo).toNote === b.id

    // 1. links to B become [[A|B]]
    for (const linker of this.linkersOf(companyId, b.id)) {
      if (linker === b.id) continue
      const row = this.index.noteById(companyId, linker)
      if (!row || row.removed_at) continue
      try {
        const r = this.commit(companyId, row.path, (text) => retargetLinks(text, pointsAtB, aStem, { keepOldAsDisplay: true }), { noteId: row.id })
        if (r.status === 'ok') {
          paths.add(r.path)
          this.log(companyId, ctx, { op: 'link', kind: 'link', targetId: row.id, noteId: row.id, path: r.path, blockId: null, baseHash: r.baseHash, newHash: r.hash, after: { merged: { from: b.title, into: a.title } } })
        }
      } catch {
        // one unwritable linker does not abort the merge halfway; its links still resolve to the archived B
      }
    }

    // 2. B's active observations and aliases onto A
    const bFile = readFileState(toVaultAbs(this.index.root(companyId), b.path))
    const bNote: ParsedNote | null = bFile ? parseNote(bFile.text) : null
    const facts = (bNote?.facts ?? []).filter((f) => f.status === 'active' && f.section === 'obs')
    const aliases = bNote ? fmList(bNote.data.aliases) : []
    const prov = this.prov(ctx)
    const suffix = ` (merged from [[${bStem}]])`
    const ra = this.commit(
      companyId,
      a.path,
      (text) => {
        let t = text
        const have = new Set(parseNote(t).facts.filter((f) => f.status === 'active').map((f) => textHash(f.text.replace(suffix, ''))))
        for (const f of facts) {
          if (have.has(textHash(f.text))) continue
          have.add(textHash(f.text))
          const line = formatObservation({ category: f.category, text: `${f.text}${suffix}`, prov: f.provExplicit && f.prov.date ? { ...f.prov, date: f.prov.date } : prov, blockId: newBlockId('f') })
          t = appendLine(t, 'observations', line).text
        }
        for (const al of aliases) t = addAlias(t, al).text
        return { text: t, changed: t !== text }
      },
      { noteId: a.id }
    )
    if (ra.status === 'ok') paths.add(ra.path)

    // 3. B: aliases moved away, archived with merged_into
    const rb = this.commit(
      companyId,
      b.path,
      (text) => {
        let t = text
        for (const al of aliases) t = removeAlias(t, al).text
        t = archive(t, aStem).text
        return { text: t, changed: t !== text }
      },
      { noteId: b.id }
    )
    if (rb.status === 'ok') paths.add(rb.path)
    this.log(companyId, ctx, { op: 'merge', kind: 'note', targetId: b.id, noteId: a.id, path: a.path, blockId: null, baseHash: ra.baseHash, newHash: ra.hash, after: { from: b.title, into: a.title, facts: facts.length } })
    return {
      result: { status: 'ok', path: a.path, noteId: ra.noteId ?? a.id, blockId: null, hash: ra.hash, reason: null },
      paths: [...paths],
      noteIds: [a.id, b.id]
    }
  }

  // ---------- editor save ----------

  private saveNow(companyId: string, req: { path: string; baseHash: string; text: string }, ctx: WriteContext): SaveResult {
    const ro = this.readOnlyReason(companyId)
    if (ro) return { status: 'error', reason: ro }
    if (!isNotePath(req.path)) return { status: 'error', reason: `${req.path} is not a note path` }
    const prov = this.prov(ctx)
    let moved = 0
    let kept = 0
    let conflict: SaveResult | null = null
    try {
      const c = this.commit(
        companyId,
        req.path,
        (current, file) => {
          let ours = req.text
          if (file && file.hash !== req.baseHash) {
            const row = this.index.noteByPath(companyId, req.path)
            const base = this.index.textForHash(companyId, row?.id ?? null, req.baseHash)
            const m = base !== null ? merge3(base, req.text, current) : null
            if (!m || !m.clean) {
              conflict = { status: 'conflict', base: base ?? '', ours: req.text, theirs: current, theirsHash: file.hash, merged: m ? m.text : null, clean: false }
              return { text: current, changed: false }
            }
            ours = m.text
          }
          const r = relocateRemovedFacts(current, ours, prov)
          moved = r.moved.length
          kept = r.kept.length
          return { text: r.text, changed: r.text !== current }
        },
        { touch: false }
      )
      if (conflict) return conflict
      const noteId = c.noteId ?? this.index.noteByPath(companyId, req.path)?.id ?? null
      if (c.status === 'ok') {
        this.log(companyId, ctx, { op: 'update', kind: 'note', targetId: noteId ?? req.path, noteId: noteId ?? req.path, path: req.path, blockId: null, baseHash: c.baseHash, newHash: c.hash, after: { editor: true, movedToHistory: moved, keptHistory: kept } })
        this.index.emitChanged({ companyId, paths: [req.path], noteIds: noteId ? [noteId] : [] })
      }
      return { status: 'saved', hash: c.hash, path: req.path, noteId, movedToHistory: moved, keptHistory: kept }
    } catch (e) {
      if (e instanceof OpError && e.code === 'note_missing') return { status: 'error', reason: `${req.path} no longer exists` }
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  private restoreLinesNow(companyId: string, noteId: string, factIds: string[], ctx: WriteContext): VaultOpResult {
    const row = this.index.noteById(companyId, noteId)
    const fail = (reason: string): VaultOpResult => ({ index: 0, status: 'error', path: row?.path ?? null, noteId, blockId: null, hash: null, reason })
    const ro = this.readOnlyReason(companyId)
    if (ro) return fail(ro)
    if (!row || row.removed_at) return fail('the note is not in the vault')
    const tombs = factIds.length
      ? (this.db
          .prepare(`SELECT id, block_id, category, text FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'removed_external' AND id IN (${factIds.map(() => '?').join(',')}) ORDER BY line`)
          .all(companyId, noteId, ...factIds) as { id: string; block_id: string | null; category: string; text: string }[])
      : []
    if (tombs.length === 0) return fail('nothing to restore')
    const prov = this.prov(ctx)
    const c = this.commit(
      companyId,
      row.path,
      (text) => {
        let t = text
        const present = new Set(parseNote(t).facts.map((f) => f.blockId).filter(Boolean))
        for (const f of tombs) {
          if (f.block_id && present.has(f.block_id)) continue
          t = appendObservation(t, { category: f.category, text: f.text, prov, blockId: f.block_id }).text
        }
        return { text: t, changed: t !== text }
      },
      { noteId }
    )
    if (c.status === 'ok') {
      this.log(companyId, ctx, { op: 'restore', kind: 'fact', targetId: noteId, noteId, path: c.path, blockId: null, baseHash: c.baseHash, newHash: c.hash, after: { restored: tombs.map((f) => f.block_id ?? f.id) } })
      this.index.emitChanged({ companyId, paths: [c.path], noteIds: [noteId] })
    }
    return { index: 0, status: c.status, path: c.path, noteId: c.noteId ?? noteId, blockId: null, hash: c.hash, reason: null }
  }

  // ---------- restore an external delete ----------

  private restoreRemovedNow(companyId: string, noteId: string, ctx: WriteContext): VaultOpResult {
    const row = this.index.noteById(companyId, noteId)
    const fail = (reason: string): VaultOpResult => ({ index: 0, status: 'error', path: row?.path ?? null, noteId, blockId: null, hash: null, reason })
    const ro = this.readOnlyReason(companyId)
    if (ro) return fail(ro)
    if (!row?.removed_at) return fail('the note is not removed')
    const root = this.index.root(companyId)
    const text = readSnapshot(root, noteId)
    if (text === null) return fail('no snapshot to restore from')
    let rel = row.path
    for (let n = 2; fs.existsSync(toVaultAbs(root, rel)) && n < 50; n++) rel = joinNotePath(path.posix.dirname(row.path) === '.' ? '' : path.posix.dirname(row.path), `${pathStem(row.path)} ${n}`)
    const c = this.commit(companyId, rel, () => ({ text, changed: true }), { create: true, touch: false, noteId })
    this.log(companyId, ctx, { op: 'restore', kind: 'note', targetId: noteId, noteId, path: rel, blockId: null, baseHash: null, newHash: c.hash })
    this.index.emitChanged({ companyId, paths: [rel], noteIds: [noteId] })
    return { index: 0, status: 'ok', path: rel, noteId: c.noteId ?? noteId, blockId: null, hash: c.hash, reason: null }
  }
}

// ---------- helpers ----------

function blockOf(op: VaultOp): string | null {
  return 'blockId' in op ? op.blockId.replace(/^\^/, '') : null
}

function toFm(v: VaultPropertyValue | undefined): FmValue | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) return v.map(String)
  return v
}

function sourceOf(ctx: WriteContext): string {
  if (ctx.via || ctx.actor === 'suggestion') return 'suggestion'
  if (ctx.actor === 'user') return 'user'
  if (ctx.actor === 'migration') return 'migration'
  return 'agent'
}

function opSummary(op: VaultOp): unknown {
  const { op: kind, ...rest } = op as VaultOp & Record<string, unknown>
  return { op: kind, ...rest }
}

/** Rewrites the first `# Old` heading to `# New` (only when it still says the old title). */
function renameH1(text: string, oldTitle: string, newTitle: string): string {
  const parsed = parseNote(text)
  const h = parsed.headings.find((x) => x.level === 1)
  if (!h || normName(h.text) !== normName(oldTitle)) return text
  const l = splitLines(text)
  const line = l.lines[h.line]
  if (!parseHeading(line)) return text
  l.lines[h.line] = line.replace(/^(\s{0,3}#\s+).*?(\s+#*\s*)?$/, (_m, pre: string) => `${pre}${newTitle}`)
  return joinLines(l)
}

/** The raw line carrying `^blockId`, for the event log (restore reads its category and provenance back). */
function rawLineOf(text: string, blockId: string): { line: string } | undefined {
  const tail = `^${blockId.replace(/^\^/, '')}`
  const line = text.split(/\r?\n/).find((l) => l.trimEnd().endsWith(tail))
  return line === undefined ? undefined : { line }
}
