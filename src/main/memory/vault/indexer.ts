// Vault indexer (PASSPORT.md §6.2). Files are the source of truth; every derived row in passport-index.db comes from
// parsing them with the shared grammar (src/shared/vault). Incremental indexing and a full rebuild produce the same
// rows: links are resolved against the company's current note set with the same rules as shared/vault/resolve.ts,
// and every change to a note's names (path, basename, title, aliases) re-resolves the links that could point at it.
//
// External deletes keep the note row (`removed_at`) and mark its facts `removed_external`; observations with block ids
// that vanish in an external edit are kept as `removed_external` tombstones. Both feed an `external_removal` review
// item and survive rebuilds, so nothing a file once held is lost from the index while the snapshot keeps the bytes.

import fs from 'node:fs'
import path from 'node:path'
import { parseNote, type ParsedFact, type ParsedLink, type ParsedNote } from '../../../shared/vault/parse'
import { normName, normPath, parseLinkTarget, pathStem } from '../../../shared/vault/resolve'
import { isoDate } from '../../../shared/vault/serialize'
import { blockIdToV1, newNoteId, pathNoteKey, softKey, textHash } from '../../../shared/vault/ids'
import { setProperty } from '../../../shared/vault/patch'
import { atomicWrite, readFileState, sha1, statFile, walkNotes, type FileState } from './fsutil'
import { type IndexDB, insertProposal, vaultRow } from './indexDb'
import { DERIVED_TABLES, PARSER_VERSION, VAULT_FORMAT_VERSION } from './indexSchema'
import { logEvent } from './log'
import { isNotePath, toVaultAbs } from './paths'
import { hasSnapshot, readSnapshot, writeSnapshot } from './snapshots'

export interface ChangedEvent {
  companyId: string
  paths: string[]
  noteIds: string[]
  /** a full rebuild: everything may have changed */
  full?: boolean
}

export interface IndexerOptions {
  now?: () => Date
  onChanged?: (e: ChangedEvent) => void
  /** Whether this process may write the vault (writer.lock held); gates the duplicate-id stamp. */
  canWrite?: (companyId: string, root: string) => boolean
}

export interface IndexNoteOptions {
  /** The writer indexing its own write: skip the external diff log and tombstones. */
  own?: boolean
  /** Do not emit memory:changed (the caller batches). */
  emit?: boolean
  /** Log semantic changes of external edits (default true). */
  log?: boolean
}

export type IndexStatus = 'unchanged' | 'indexed' | 'moved' | 'removed' | 'missing' | 'ignored'

export interface IndexNoteResult {
  status: IndexStatus
  path: string
  noteId: string | null
  hash: string | null
}

export interface RebuildStats {
  notes: number
  facts: number
  links: number
  ms: number
  idsAssigned: number
}

export interface NoteRow {
  id: string
  company_id: string
  path: string
  path_norm: string
  basename_norm: string
  title: string
  norm_title: string
  type: string
  status: string
  pinned: number
  summary: string
  frontmatter_json: string
  repo_id: string | null
  repo_ids_json: string
  hash: string
  mtime_ms: number
  size: number
  created: string | null
  modified: string | null
  parse_warnings_json: string
  indexed_at: string
  removed_at: string | null
}

export type ResolvedTarget = { toNote: string | null; ambiguous: boolean; candidates: string[]; norm: string }

const BATCH = 200
const FTS_BODY_CAP = 20_000
const CONTEXT_CAP = 240

/** Row id of a copied line whose block id another note owns. */
function dupFactId(path: string, factId: string): string {
  return softKey(path, `dup:${factId}`)
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `[[Target]]` text -> the key the resolver compares (resolve.ts step 1 + normalization). */
export function targetNorm(target: string): { name: string; norm: string } {
  const name = parseLinkTarget(target).target.replace(/\\/g, '/')
  return { name, norm: normName(name.replace(/\.md$/i, '')) }
}

interface OldFact {
  id: string
  block_id: string | null
  status: string
  text_hash: string
  text: string
  line: number
  section: string
  category: string
  kind: string
  superseded_by: string | null
  pinned: number
  reviewed: number
  actor: string
  run_id: string | null
  session_id: string | null
  date: string | null
  repo_id: string | null
}

/** Recently indexed contents by hash: the diff3 base of an editor save whose baseHash is no longer on disk (§6.4). */
class RecentTexts {
  private map = new Map<string, string>()
  private bytes = 0
  constructor(private maxBytes = 8 * 1024 * 1024) {}

  put(hash: string, text: string): void {
    if (this.map.has(hash)) {
      this.map.delete(hash)
      this.map.set(hash, text)
      return
    }
    this.map.set(hash, text)
    this.bytes += text.length
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes || this.map.size <= 1) break
      this.map.delete(k)
      this.bytes -= v.length
    }
  }

  get(hash: string): string | null {
    return this.map.get(hash) ?? null
  }
}

export class VaultIndexer {
  private roots = new Map<string, string>()
  private recent = new RecentTexts()
  private st: ReturnType<VaultIndexer['prepare']>

  constructor(
    readonly db: IndexDB,
    private opts: IndexerOptions = {}
  ) {
    this.st = this.prepare()
  }

  private prepare() {
    const db = this.db
    return {
      noteByPath: db.prepare('SELECT * FROM mem_note WHERE company_id = ? AND path_norm = ?'),
      noteById: db.prepare('SELECT * FROM mem_note WHERE company_id = ? AND id = ?'),
      insertNote: db.prepare(
        `INSERT INTO mem_note (id, company_id, path, path_norm, basename_norm, title, norm_title, type, status, pinned, summary,
           frontmatter_json, repo_id, repo_ids_json, hash, mtime_ms, size, created, modified, parse_warnings_json, indexed_at, removed_at)
         VALUES (@id, @company_id, @path, @path_norm, @basename_norm, @title, @norm_title, @type, @status, @pinned, @summary,
           @frontmatter_json, @repo_id, @repo_ids_json, @hash, @mtime_ms, @size, @created, @modified, @parse_warnings_json, @indexed_at, NULL)`
      ),
      insertAlias: db.prepare('INSERT OR IGNORE INTO mem_alias (company_id, note_id, alias, norm_alias) VALUES (?,?,?,?)'),
      insertFact: db.prepare(
        `INSERT INTO mem_fact (id, company_id, note_id, block_id, line, section, category, kind, text, text_hash, status, superseded_by,
           pinned, reviewed, actor, run_id, session_id, date, repo_id, dup_of)
         VALUES (@id, @company_id, @note_id, @block_id, @line, @section, @category, @kind, @text, @text_hash, @status, @superseded_by,
           @pinned, @reviewed, @actor, @run_id, @session_id, @date, @repo_id, @dup_of)`
      ),
      insertLink: db.prepare(
        `INSERT INTO mem_link (id, company_id, from_note, from_fact, line, rel, norm_rel, origin, to_note, to_text, to_norm, to_heading,
           to_block, display, embed, ambiguous, candidates_json, context, block_id, status, actor, run_id, date, dup_of)
         VALUES (@id, @company_id, @from_note, @from_fact, @line, @rel, @norm_rel, @origin, @to_note, @to_text, @to_norm, @to_heading,
           @to_block, @display, @embed, @ambiguous, @candidates_json, @context, @block_id, @status, @actor, @run_id, @date, @dup_of)`
      ),
      insertTag: db.prepare('INSERT INTO mem_tag (company_id, note_id, fact_id, tag_norm, tag_display, origin, line) VALUES (?,?,?,?,?,?,?)'),
      insertFtsMap: db.prepare('INSERT INTO mem_fts_map (company_id, note_id) VALUES (?, ?)'),
      insertFts: db.prepare('INSERT INTO mem_fts (rowid, ref_kind, ref_id, company_id, note_id, title, body) VALUES (?,?,?,?,?,?,?)'),
      ftsRows: db.prepare('SELECT rowid FROM mem_fts_map WHERE company_id = ? AND note_id = ?'),
      deleteFts: db.prepare('DELETE FROM mem_fts WHERE rowid = ?'),
      deleteFtsMap: db.prepare('DELETE FROM mem_fts_map WHERE company_id = ? AND note_id = ?'),
      deleteNote: db.prepare('DELETE FROM mem_note WHERE company_id = ? AND id = ?'),
      deleteAliases: db.prepare('DELETE FROM mem_alias WHERE company_id = ? AND note_id = ?'),
      deleteLinks: db.prepare('DELETE FROM mem_link WHERE company_id = ? AND from_note = ?'),
      deleteTags: db.prepare('DELETE FROM mem_tag WHERE company_id = ? AND note_id = ?'),
      deleteLiveFacts: db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND note_id = ? AND status != 'removed_external'`),
      deleteTombstone: db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND id = ? AND status = 'removed_external'`),
      factsOf: db.prepare('SELECT * FROM mem_fact WHERE company_id = ? AND note_id = ?'),
      relationsOf: db.prepare(`SELECT id, block_id, status, rel, to_text, context, line FROM mem_link WHERE company_id = ? AND from_note = ? AND origin = 'relation'`),
      aliasesOf: db.prepare('SELECT norm_alias FROM mem_alias WHERE company_id = ? AND note_id = ?'),
      byPath: db.prepare('SELECT id FROM mem_note WHERE company_id = ? AND path_norm = ? AND removed_at IS NULL'),
      byPathSuffix: db.prepare(`SELECT id FROM mem_note WHERE company_id = ? AND path_norm LIKE ? ESCAPE '\\' AND removed_at IS NULL`),
      byBase: db.prepare('SELECT id FROM mem_note WHERE company_id = ? AND basename_norm = ? AND removed_at IS NULL'),
      byTitle: db.prepare('SELECT id FROM mem_note WHERE company_id = ? AND norm_title = ? AND removed_at IS NULL'),
      byAlias: db.prepare(
        `SELECT DISTINCT a.note_id AS id FROM mem_alias a JOIN mem_note n ON n.company_id = a.company_id AND n.id = a.note_id
         WHERE a.company_id = ? AND a.norm_alias = ? AND n.removed_at IS NULL`
      ),
      updateLinkTarget: db.prepare('UPDATE mem_link SET to_note = ?, ambiguous = ?, candidates_json = ? WHERE company_id = ? AND id = ?'),
      touchNote: db.prepare('UPDATE mem_note SET mtime_ms = ?, size = ? WHERE company_id = ? AND id = ?'),
      repoLinks: db.prepare(
        `SELECT DISTINCT n.repo_id AS repo_id FROM mem_link l JOIN mem_note n ON n.company_id = l.company_id AND n.id = l.to_note
         WHERE l.company_id = ? AND l.from_note = ? AND l.origin = 'property' AND l.norm_rel = 'repos' AND n.repo_id IS NOT NULL`
      ),
      setRepoIds: db.prepare('UPDATE mem_note SET repo_ids_json = ? WHERE company_id = ? AND id = ?')
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  // ---------- vault registry ----------

  /** Registers (or moves) a company vault. Returns true when the index must be rebuilt (new vault, new root, parser bump). */
  registerVault(companyId: string, root: string): boolean {
    // one vault per company (§1.8): a shared or nested folder would index one company's notes into another
    const abs = path.resolve(root)
    for (const [other, r] of this.roots) {
      if (other === companyId) continue
      const o = path.resolve(r)
      if (abs === o || abs.startsWith(o + path.sep) || o.startsWith(abs + path.sep)) {
        throw new Error(`The Passport folder ${root} overlaps the vault of company ${other}; each company needs its own folder`)
      }
    }
    this.roots.set(companyId, root)
    const row = vaultRow(this.db, companyId)
    if (!row) {
      this.db
        .prepare('INSERT INTO mem_vault (company_id, root, format_version, parser_version, state) VALUES (?,?,?,0,?)')
        .run(companyId, root, VAULT_FORMAT_VERSION, fs.existsSync(root) ? 'indexing' : 'missing')
      return true
    }
    if (row.root !== root) {
      this.db.prepare(`UPDATE mem_vault SET root = ?, parser_version = 0, state = 'indexing' WHERE company_id = ?`).run(root, companyId)
      return true
    }
    return row.parser_version !== PARSER_VERSION || !row.last_full_scan_at
  }

  root(companyId: string): string {
    const r = this.roots.get(companyId)
    if (!r) throw new Error(`No Passport vault registered for company ${companyId}`)
    return r
  }

  hasVault(companyId: string): boolean {
    return this.roots.has(companyId)
  }

  companies(): string[] {
    return [...this.roots.keys()]
  }

  /** Keeps a text the UI loaded so a later save against its hash can diff3 (P3's `memory:note get` calls this). */
  rememberText(text: string, hash: string): void {
    this.recent.put(hash, text)
  }

  /** A recently seen content for `hash` (indexed or remembered), else the snapshot when it still matches. */
  textForHash(companyId: string, noteId: string | null, hash: string): string | null {
    const hit = this.recent.get(hash)
    if (hit !== null) return hit
    if (!noteId) return null
    const snap = readSnapshot(this.root(companyId), noteId)
    return snap !== null && sha1(snap) === hash ? snap : null
  }

  emitChanged(e: ChangedEvent): void {
    if (!e.full && e.paths.length === 0 && e.noteIds.length === 0) return
    try {
      this.opts.onChanged?.(e)
    } catch {
      // listeners never break indexing
    }
  }

  // ---------- lookups (writer, tools) ----------

  noteByPath(companyId: string, rel: string): NoteRow | null {
    return (this.st.noteByPath.get(companyId, normPath(rel)) as NoteRow | undefined) ?? null
  }

  noteById(companyId: string, id: string): NoteRow | null {
    return (this.st.noteById.get(companyId, id) as NoteRow | undefined) ?? null
  }

  /** §5 resolution against the company's live notes (removed notes never resolve). */
  resolve(companyId: string, target: string, memo?: Map<string, ResolvedTarget>): ResolvedTarget {
    const { name, norm } = targetNorm(target)
    const key = `${name.includes('/') ? 'p' : 'n'}:${norm}`
    const hit = memo?.get(key)
    if (hit) return hit
    const ids = (rows: unknown[]): string[] => [...new Set((rows as { id: string }[]).map((r) => r.id))]
    const decide = (list: string[]): ResolvedTarget | null => {
      if (list.length === 0) return null
      if (list.length === 1) return { toNote: list[0], ambiguous: false, candidates: [], norm }
      return { toNote: null, ambiguous: true, candidates: list.sort(), norm }
    }
    let out: ResolvedTarget | null = null
    if (norm) {
      if (name.includes('/')) {
        const p = normPath(name)
        out = decide(ids(this.st.byPath.all(companyId, p))) ?? decide(ids(this.st.byPathSuffix.all(companyId, `%/${escapeLike(p)}`)))
      } else out = decide(ids(this.st.byBase.all(companyId, norm)))
      out ??= decide(ids(this.st.byTitle.all(companyId, norm))) ?? decide(ids(this.st.byAlias.all(companyId, norm)))
    }
    out ??= { toNote: null, ambiguous: false, candidates: [], norm }
    memo?.set(key, out)
    return out
  }

  /** The note and row of a block id (`f-…`/`r-…`, with or without `^`) among live rows. */
  findBlock(companyId: string, blockId: string): { noteId: string; kind: 'fact' | 'relation'; rowId: string; status: string } | null {
    const id = blockId.replace(/^\^/, '')
    const f = this.db
      .prepare(`SELECT note_id, id, status FROM mem_fact WHERE company_id = ? AND block_id = ? AND status != 'removed_external' ORDER BY line LIMIT 1`)
      .get(companyId, id) as { note_id: string; id: string; status: string } | undefined
    if (f) return { noteId: f.note_id, kind: 'fact', rowId: f.id, status: f.status }
    const r = this.db
      .prepare(`SELECT from_note, id, status FROM mem_link WHERE company_id = ? AND block_id = ? AND origin = 'relation' LIMIT 1`)
      .get(companyId, id) as { from_note: string; id: string; status: string } | undefined
    return r ? { noteId: r.from_note, kind: 'relation', rowId: r.id, status: r.status } : null
  }

  // ---------- incremental ----------

  /** Indexes one vault-relative path (§6.2). A missing file is handled as an external delete. */
  indexNote(companyId: string, rel: string, opts: IndexNoteOptions = {}): IndexNoteResult {
    const root = this.root(companyId)
    if (!isNotePath(rel)) return { status: 'ignored', path: rel, noteId: null, hash: null }
    const abs = toVaultAbs(root, rel)
    let file = readFileState(abs)
    const prev = this.noteByPath(companyId, rel)
    if (!file) {
      if (!prev || prev.removed_at) return { status: 'missing', path: rel, noteId: prev?.id ?? null, hash: null }
      // the whole vault folder vanished (unmounted drive, moved in Finder): not N external deletes
      if (!fs.existsSync(root)) {
        this.db.prepare(`UPDATE mem_vault SET state = 'missing' WHERE company_id = ?`).run(companyId)
        return { status: 'missing', path: rel, noteId: prev.id, hash: null }
      }
      this.markRemoved(companyId, prev, opts)
      return { status: 'removed', path: rel, noteId: prev.id, hash: prev.hash }
    }
    this.recent.put(file.hash, file.text)
    if (prev && !prev.removed_at && prev.hash === file.hash && prev.path === rel) {
      if (prev.mtime_ms !== file.mtimeMs || prev.size !== file.size) this.st.touchNote.run(file.mtimeMs, file.size, companyId, prev.id)
      return { status: 'unchanged', path: rel, noteId: prev.id, hash: file.hash }
    }

    let parsed = this.parse(rel, file)
    let key = parsed.key
    let moved: NoteRow | null = null
    let idAssigned: { from: string; to: string } | null = null
    if (parsed.id) {
      const other = this.noteById(companyId, parsed.id)
      if (other && other.path_norm !== normPath(rel)) {
        const otherAlive = !other.removed_at && statFile(toVaultAbs(root, other.path)) !== null
        if (!otherAlive) moved = other
        else {
          // a copied file: the later one gets a fresh id (the only automatic write, logged)
          const stamped = this.stampFreshId(companyId, root, rel, file)
          if (stamped) {
            idAssigned = { from: parsed.id, to: stamped.id }
            file = stamped.file
            parsed = this.parse(rel, file)
            key = parsed.key
          } else key = pathNoteKey(rel)
        }
      }
    }

    if (!moved && prev?.id !== key) {
      // the key belongs to a row elsewhere: a removed note coming back, or a row whose file is gone
      const same = this.noteById(companyId, key)
      if (same && (same.removed_at || statFile(toVaultAbs(root, same.path)) === null)) moved = same
      else if (same) key = pathNoteKey(rel)
    }

    const at = this.now().toISOString()
    // the previous state of this note for the external diff: same path, or the old path of a move
    const basis = prev && !prev.removed_at ? prev : moved && !moved.removed_at ? moved : null
    let diff: SemanticDiff | null = null
    this.db
      .transaction(() => {
        const replaced = [prev, moved].filter((r): r is NoteRow => !!r)
        const oldKeys = new Set<string>()
        const oldFacts = new Map<string, OldFact>()
        const oldRels = new Map<string, { id: string; block_id: string | null; status: string }>()
        for (const r of replaced) {
          if (r.removed_at && r.id !== key) {
            // a different note now occupies the path of a removed one: free the path, keep the removed row
            this.db.prepare('UPDATE mem_note SET path_norm = ? WHERE company_id = ? AND id = ?').run(`\u0000removed:${r.id}:${r.path_norm}`, companyId, r.id)
            continue
          }
          for (const k of this.namesOf(companyId, r)) oldKeys.add(k)
          oldKeys.add(`\u0001${r.id}`)
          if (!r.removed_at) {
            for (const f of this.st.factsOf.all(companyId, r.id) as OldFact[]) if (f.status !== 'removed_external') oldFacts.set(f.id, f)
            for (const x of this.st.relationsOf.all(companyId, r.id) as { id: string; block_id: string | null; status: string }[]) oldRels.set(x.id, x)
          } else {
            // the note is back (restored or moved back in): drop its removal tombstones and stale its review item
            this.db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'removed_external'`).run(companyId, r.id)
            this.staleRemovalProposals(companyId, r.id)
          }
          this.deleteDerived(companyId, r.id, { keepTombstones: true })
          this.st.deleteNote.run(companyId, r.id)
          if (r.id !== key) {
            this.db.prepare('UPDATE mem_fact SET note_id = ? WHERE company_id = ? AND note_id = ?').run(key, companyId, r.id)
            // operational rows keyed by the note follow its new key (an `h:<path>` note stamped or moved)
            this.db.prepare('UPDATE OR IGNORE mem_layout SET note_id = ? WHERE company_id = ? AND note_id = ?').run(key, companyId, r.id)
          }
        }
        const counts = this.insertNote(companyId, parsed, key, file!, at, { resolve: true })
        if (!opts.own && basis) diff = this.semanticDiff(oldFacts, oldRels, parsed, counts.factIds)
        if (diff && diff.removed.length) this.insertTombstones(companyId, key, diff.removed)
        const oldBlocks = [...oldFacts.values(), ...oldRels.values()].map((x) => x.block_id).filter((b): b is string => !!b)
        this.settleBlocks(companyId, oldBlocks)
        // a line cut here and pasted into another note gave its tombstone way to the live copy: it was moved, not removed
        if (diff && diff.removed.length) {
          const d = diff as SemanticDiff
          d.removed = d.removed.filter((f) => !!this.db.prepare(`SELECT 1 FROM mem_fact WHERE company_id = ? AND id = ? AND note_id = ? AND status = 'removed_external'`).get(companyId, f.id, key))
        }
        const newKeys = new Set(this.namesOf(companyId, this.noteById(companyId, key)!))
        newKeys.add(`\u0001${key}`)
        const touched = this.reresolve(companyId, new Set([...oldKeys, ...newKeys]))
        this.refreshRepoIds(companyId, new Set([key, ...touched, ...this.repoLinkers(companyId, key)]))
      })
      .immediate()

    writeSnapshot(root, key, file.text)
    this.recent.put(file.hash, file.text)
    const d = diff as SemanticDiff | null
    if (opts.log !== false) {
      if (idAssigned) {
        logEvent(this.db, root, { ts: at, companyId, op: 'id_assigned', targetKind: 'note', targetId: idAssigned.to, entityId: idAssigned.to, path: rel, actor: 'system', before: { id: idAssigned.from }, after: { id: idAssigned.to } })
      }
      if (!opts.own) this.logExternal(companyId, root, rel, key, basis ?? (prev?.removed_at || moved?.removed_at ? (prev ?? moved) : null), d, file.hash, at)
    }
    if (d && d.removed.length) this.fileRemovalProposal(companyId, rel, key, d.removed.map((f) => ({ blockId: f.block_id, text: f.text, line: f.line })), basis?.hash ?? null, at)
    if (opts.emit !== false) this.emitChanged({ companyId, paths: [rel], noteIds: [key] })
    return { status: moved ? 'moved' : 'indexed', path: rel, noteId: key, hash: file.hash }
  }

  /**
   * Indexes a set of changed paths (watcher batch, startup scan). Existing files go first so a rename keeping the
   * frontmatter id is a move; then missing paths: an id-less note whose exact bytes reappeared elsewhere in the batch is
   * a move too, anything else is an external delete.
   */
  indexPaths(companyId: string, rels: string[], opts: IndexNoteOptions = {}): IndexNoteResult[] {
    const root = this.root(companyId)
    const uniq = [...new Set(rels.filter(isNotePath))].sort()
    const present: string[] = []
    const missing: string[] = []
    for (const rel of uniq) (statFile(toVaultAbs(root, rel)) ? present : missing).push(rel)
    const results: IndexNoteResult[] = []
    const newHashes = new Map<string, string>()
    for (const rel of present) {
      const before = this.noteByPath(companyId, rel)
      const r = this.indexNote(companyId, rel, { ...opts, emit: false })
      results.push(r)
      if (!before && r.hash && r.noteId) newHashes.set(r.hash, r.noteId)
    }
    for (const rel of missing) {
      const prev = this.noteByPath(companyId, rel)
      if (prev && !prev.removed_at && prev.id.startsWith('h:') && newHashes.has(prev.hash)) {
        this.dropMovedPathNote(companyId, prev, newHashes.get(prev.hash)!)
        results.push({ status: 'moved', path: rel, noteId: newHashes.get(prev.hash)!, hash: prev.hash })
        continue
      }
      results.push(this.indexNote(companyId, rel, { ...opts, emit: false }))
    }
    const changed = results.filter((r) => r.status !== 'unchanged' && r.status !== 'ignored' && r.status !== 'missing')
    if (opts.emit !== false) this.emitChanged({ companyId, paths: changed.map((r) => r.path), noteIds: [...new Set(changed.map((r) => r.noteId).filter((x): x is string => !!x))] })
    return results
  }

  /** Startup scan / periodic rescan: compares (mtime_ms, size), hashes only on difference (§6.2). */
  scan(companyId: string, opts: IndexNoteOptions = {}): IndexNoteResult[] {
    const root = this.root(companyId)
    if (!fs.existsSync(root)) {
      // an unmounted drive or a moved folder: never read that as "every note was deleted"
      this.db.prepare(`UPDATE mem_vault SET state = 'missing' WHERE company_id = ?`).run(companyId)
      return []
    }
    this.db.prepare(`UPDATE mem_vault SET state = 'ready' WHERE company_id = ? AND state = 'missing' AND last_full_scan_at IS NOT NULL`).run(companyId)
    const files = walkNotes(root)
    const rows = this.db.prepare('SELECT path, path_norm, mtime_ms, size FROM mem_note WHERE company_id = ? AND removed_at IS NULL').all(companyId) as {
      path: string
      path_norm: string
      mtime_ms: number
      size: number
    }[]
    const known = new Map(rows.map((r) => [r.path_norm, r]))
    const changed: string[] = []
    const seen = new Set<string>()
    for (const f of files) {
      const pn = normPath(f.rel)
      seen.add(pn)
      const row = known.get(pn)
      if (!row || row.mtime_ms !== f.mtimeMs || row.size !== f.size || row.path !== f.rel) changed.push(f.rel)
    }
    for (const r of rows) if (!seen.has(r.path_norm)) changed.push(r.path)
    return changed.length ? this.indexPaths(companyId, changed, opts) : []
  }

  // ---------- full rebuild ----------

  /** Rebuilds every derived row of one company from its files (§6.2), 200 files per transaction. */
  rebuild(companyId: string): RebuildStats {
    const t0 = Date.now()
    const root = this.root(companyId)
    const at = this.now().toISOString()
    if (!fs.existsSync(root)) {
      // an unmounted drive or a moved folder: keep the index as it is instead of rebuilding it empty
      this.db.prepare(`UPDATE mem_vault SET state = 'missing' WHERE company_id = ?`).run(companyId)
      return { notes: 0, facts: 0, links: 0, ms: Date.now() - t0, idsAssigned: 0 }
    }
    // cleared until the rebuild completes, so a crash midway rebuilds again on the next start (registerVault)
    this.db.prepare(`UPDATE mem_vault SET state = 'indexing', last_full_scan_at = NULL WHERE company_id = ?`).run(companyId)
    const files = walkNotes(root)
    const prevHash = new Map(
      (this.db.prepare('SELECT id, path_norm, hash FROM mem_note WHERE company_id = ? AND removed_at IS NULL').all(companyId) as { id: string; path_norm: string; hash: string }[]).map((r) => [
        r.path_norm,
        r
      ])
    )
    this.db
      .transaction(() => {
        for (const t of DERIVED_TABLES) {
          if (t === 'mem_note') this.db.prepare('DELETE FROM mem_note WHERE company_id = ? AND removed_at IS NULL').run(companyId)
          else if (t === 'mem_fact') this.db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND status != 'removed_external'`).run(companyId)
          else if (t === 'mem_fts_map') {
            this.db.prepare('DELETE FROM mem_fts WHERE rowid IN (SELECT rowid FROM mem_fts_map WHERE company_id = ?)').run(companyId)
            this.db.prepare('DELETE FROM mem_fts_map WHERE company_id = ?').run(companyId)
          } else this.db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(companyId)
        }
      })
      .immediate()

    const seenIds = new Set<string>()
    const stats: RebuildStats = { notes: 0, facts: 0, links: 0, ms: 0, idsAssigned: 0 }
    const snapshots: Array<{ key: string; text: string }> = []
    const assigned: Array<{ rel: string; from: string; to: string }> = []
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH)
      const loaded: Array<{ rel: string; file: FileState; parsed: ParsedNote; key: string }> = []
      for (const f of batch) {
        let file = readFileState(f.abs)
        if (!file) continue
        let parsed = this.parse(f.rel, file)
        let key = parsed.key
        if (parsed.id && seenIds.has(parsed.id)) {
          const stamped = this.stampFreshId(companyId, root, f.rel, file)
          if (stamped) {
            assigned.push({ rel: f.rel, from: parsed.id, to: stamped.id })
            file = stamped.file
            parsed = this.parse(f.rel, file)
            key = parsed.key
          } else key = pathNoteKey(f.rel)
        }
        seenIds.add(key)
        loaded.push({ rel: f.rel, file, parsed, key })
      }
      this.db
        .transaction(() => {
          for (const { rel, file, parsed, key } of loaded) {
            const removed = this.noteById(companyId, key)
            if (removed?.removed_at) {
              this.db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'removed_external'`).run(companyId, key)
              this.staleRemovalProposals(companyId, key)
              this.st.deleteNote.run(companyId, key)
            }
            const squatter = this.noteByPath(companyId, rel)
            if (squatter?.removed_at) {
              this.db.prepare('UPDATE mem_note SET path_norm = ? WHERE company_id = ? AND id = ?').run(`\u0000removed:${squatter.id}:${squatter.path_norm}`, companyId, squatter.id)
            }
            const c = this.insertNote(companyId, parsed, key, file, at, { resolve: false })
            stats.notes++
            stats.facts += c.facts
            stats.links += c.links
            const before = prevHash.get(normPath(rel))
            if (!before || before.hash !== file.hash || before.id !== key || !hasSnapshot(root, key)) snapshots.push({ key, text: file.text })
          }
        })
        .immediate()
    }

    this.db
      .transaction(() => {
        const memo = new Map<string, ResolvedTarget>()
        const links = this.db.prepare('SELECT id, to_text FROM mem_link WHERE company_id = ?').all(companyId) as { id: string; to_text: string }[]
        for (const l of links) {
          const r = this.resolve(companyId, l.to_text, memo)
          if (r.toNote || r.ambiguous) this.st.updateLinkTarget.run(r.toNote, r.ambiguous ? 1 : 0, r.ambiguous ? JSON.stringify(r.candidates) : null, companyId, l.id)
        }
        const ids = (this.db.prepare('SELECT id FROM mem_note WHERE company_id = ? AND removed_at IS NULL').all(companyId) as { id: string }[]).map((r) => r.id)
        this.refreshRepoIds(companyId, new Set(ids))
        this.db
          .prepare(`UPDATE mem_vault SET parser_version = ?, format_version = ?, last_full_scan_at = ?, state = 'ready' WHERE company_id = ?`)
          .run(PARSER_VERSION, VAULT_FORMAT_VERSION, at, companyId)
      })
      .immediate()

    for (const s of snapshots) writeSnapshot(root, s.key, s.text)
    for (const a of assigned) {
      stats.idsAssigned++
      logEvent(this.db, root, { ts: at, companyId, op: 'id_assigned', targetKind: 'note', targetId: a.to, entityId: a.to, path: a.rel, actor: 'system', before: { id: a.from }, after: { id: a.to } })
    }
    stats.ms = Date.now() - t0
    this.emitChanged({ companyId, paths: [], noteIds: [], full: true })
    return stats
  }

  // ---------- external removal ----------

  /** Inbox "Accept removal": drops the index rows of a note whose file is gone (the log and snapshot keep it). */
  acceptRemoval(companyId: string, noteId: string): boolean {
    const row = this.noteById(companyId, noteId)
    if (!row?.removed_at) return false
    const at = this.now().toISOString()
    this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM mem_fact WHERE company_id = ? AND note_id = ?').run(companyId, noteId)
        this.st.deleteNote.run(companyId, noteId)
        this.staleRemovalProposals(companyId, noteId, 'accepted')
      })
      .immediate()
    logEvent(this.db, this.roots.get(companyId) ?? null, { ts: at, companyId, op: 'accept_removal', targetKind: 'note', targetId: noteId, entityId: noteId, path: row.path, actor: 'user' })
    return true
  }

  /** Inbox "Accept removal" for tombstoned lines of a live note. */
  acceptRemovedFacts(companyId: string, factIds: string[]): number {
    let n = 0
    for (const id of factIds) n += this.db.prepare(`DELETE FROM mem_fact WHERE company_id = ? AND id = ? AND status = 'removed_external'`).run(companyId, id).changes
    return n
  }

  private markRemoved(companyId: string, prev: NoteRow, opts: IndexNoteOptions): void {
    const root = this.root(companyId)
    const at = this.now().toISOString()
    let removedFacts: OldFact[] = []
    this.db
      .transaction(() => {
        removedFacts = (this.st.factsOf.all(companyId, prev.id) as OldFact[]).filter((f) => f.status === 'active')
        const ownedBlocks = this.ownedBlocks(companyId, prev.id)
        const keys = new Set(this.namesOf(companyId, prev))
        keys.add(`\u0001${prev.id}`)
        this.deleteDerived(companyId, prev.id, { keepTombstones: true, keepFacts: true })
        this.db.prepare(`UPDATE mem_fact SET status = 'removed_external' WHERE company_id = ? AND note_id = ?`).run(companyId, prev.id)
        this.db.prepare('UPDATE mem_note SET removed_at = ? WHERE company_id = ? AND id = ?').run(at, companyId, prev.id)
        this.settleBlocks(companyId, ownedBlocks)
        const touched = this.reresolve(companyId, keys)
        this.refreshRepoIds(companyId, touched)
      })
      .immediate()
    if (opts.log !== false) {
      logEvent(this.db, root, { ts: at, companyId, op: 'removed_external', targetKind: 'note', targetId: prev.id, entityId: prev.id, path: prev.path, actor: 'user', baseHash: prev.hash })
    }
    this.fileRemovalProposal(
      companyId,
      prev.path,
      prev.id,
      removedFacts.map((f) => ({ blockId: f.block_id, text: f.text, line: f.line })),
      prev.hash,
      at,
      true
    )
    if (opts.emit !== false) this.emitChanged({ companyId, paths: [prev.path], noteIds: [prev.id] })
  }

  /** An id-less note renamed outside Principia: same bytes at a new path. Its old rows go quietly. */
  private dropMovedPathNote(companyId: string, prev: NoteRow, newKey: string): void {
    this.db
      .transaction(() => {
        const keys = new Set(this.namesOf(companyId, prev))
        keys.add(`\u0001${prev.id}`)
        const owned = this.ownedBlocks(companyId, prev.id)
        this.deleteDerived(companyId, prev.id, { keepTombstones: true })
        this.db.prepare('UPDATE mem_fact SET note_id = ? WHERE company_id = ? AND note_id = ?').run(newKey, companyId, prev.id)
        this.db.prepare('UPDATE OR IGNORE mem_layout SET note_id = ? WHERE company_id = ? AND note_id = ?').run(newKey, companyId, prev.id)
        this.st.deleteNote.run(companyId, prev.id)
        this.settleBlocks(companyId, owned)
        const touched = this.reresolve(companyId, keys)
        this.refreshRepoIds(companyId, touched)
      })
      .immediate()
  }

  /** Block ids a note's live rows own (facts and relations). */
  private ownedBlocks(companyId: string, noteId: string): string[] {
    const f = this.db.prepare(`SELECT block_id FROM mem_fact WHERE company_id = ? AND note_id = ? AND block_id IS NOT NULL`).all(companyId, noteId) as { block_id: string }[]
    const r = this.db.prepare(`SELECT block_id FROM mem_link WHERE company_id = ? AND from_note = ? AND block_id IS NOT NULL`).all(companyId, noteId) as { block_id: string }[]
    return [...f, ...r].map((x) => x.block_id)
  }

  private staleRemovalProposals(companyId: string, noteId: string, status: 'stale' | 'accepted' = 'stale'): void {
    const rows = this.db
      .prepare(`SELECT id, payload_json FROM mem_proposal WHERE company_id = ? AND kind = 'external_removal' AND status = 'pending'`)
      .all(companyId) as { id: string; payload_json: string }[]
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json) as { noteId?: string }
        if (p.noteId === noteId) this.db.prepare('UPDATE mem_proposal SET status = ?, decided_at = ? WHERE id = ?').run(status, this.now().toISOString(), r.id)
      } catch {
        // foreign payload
      }
    }
  }

  /**
   * The `external_removal` review item (§6.2): Restore or Accept removal. The payload is not a writer op list:
   * `{ noteId, path, wholeNote, blockIds }`; Restore rewrites the snapshot (`VaultWriter.restoreRemoved`).
   */
  private fileRemovalProposal(
    companyId: string,
    path: string,
    noteId: string,
    lines: Array<{ blockId: string | null; text: string; line: number }>,
    baseHash: string | null,
    at: string,
    wholeNote = false
  ): void {
    if (!wholeNote && lines.length === 0) return
    const blockIds = lines.map((l) => l.blockId).filter((x): x is string => !!x)
    insertProposal(this.db, {
      companyId,
      kind: 'external_removal',
      payload: { noteId, path, wholeNote, blockIds },
      evidence: wholeNote
        ? [{ path, line: null, quote: `${path} was deleted outside Principia`, note: noteId }]
        : lines.map((l) => ({ path, line: l.line, quote: l.text, note: noteId })),
      score: 1,
      source: 'indexer',
      fingerprint: `external_removal:${noteId}:${wholeNote ? `note:${baseHash ?? ''}` : blockIds.sort().join(',')}`,
      baseHashes: baseHash ? { [path]: baseHash } : {},
      createdAt: at
    })
  }

  // ---------- row writing ----------

  private parse(rel: string, file: FileState): ParsedNote {
    return parseNote(file.text, { path: rel, defaultDate: isoDate(file.mtimeMs) })
  }

  /** Path, basename, title and alias keys a note answers to (for re-resolution). */
  private namesOf(companyId: string, r: NoteRow): string[] {
    const aliases = (this.st.aliasesOf.all(companyId, r.id) as { norm_alias: string }[]).map((a) => a.norm_alias)
    return [r.path_norm, r.basename_norm, r.norm_title, ...aliases].filter(Boolean)
  }

  private deleteDerived(companyId: string, noteId: string, opts: { keepTombstones?: boolean; keepFacts?: boolean } = {}): void {
    this.st.deleteAliases.run(companyId, noteId)
    this.st.deleteLinks.run(companyId, noteId)
    this.st.deleteTags.run(companyId, noteId)
    for (const r of this.st.ftsRows.all(companyId, noteId) as { rowid: number }[]) this.st.deleteFts.run(r.rowid)
    this.st.deleteFtsMap.run(companyId, noteId)
    if (opts.keepFacts) return
    if (opts.keepTombstones) this.st.deleteLiveFacts.run(companyId, noteId)
    else this.db.prepare('DELETE FROM mem_fact WHERE company_id = ? AND note_id = ?').run(companyId, noteId)
  }

  private insertNote(
    companyId: string,
    parsed: ParsedNote,
    key: string,
    file: FileState,
    at: string,
    opts: { resolve: boolean }
  ): { facts: number; links: number; factIds: Map<string, string> } {
    const rel = parsed.path
    this.st.insertNote.run({
      id: key,
      company_id: companyId,
      path: rel,
      path_norm: normPath(rel),
      basename_norm: normName(pathStem(rel)),
      title: parsed.title,
      norm_title: normName(parsed.title),
      type: parsed.type,
      status: parsed.status,
      pinned: parsed.pinned ? 1 : 0,
      summary: parsed.summary,
      frontmatter_json: JSON.stringify(parsed.data),
      repo_id: parsed.repoId,
      repo_ids_json: JSON.stringify(parsed.repoId ? [parsed.repoId] : []),
      hash: file.hash,
      mtime_ms: file.mtimeMs,
      size: file.size,
      created: parsed.created,
      modified: parsed.modified,
      parse_warnings_json: JSON.stringify(parsed.warnings),
      indexed_at: at
    })
    for (const a of parsed.aliases) {
      const n = normName(a)
      if (n) this.st.insertAlias.run(companyId, key, a, n)
    }

    // facts: ids are unique per note (parser); across notes a copied block id falls back to a soft key
    const factIds = new Map<string, string>()
    for (const f of parsed.facts) {
      const id = this.insertFact(companyId, key, rel, f, parsed.repoId)
      factIds.set(f.id, id)
    }

    const memo = opts.resolve ? new Map<string, ResolvedTarget>() : undefined
    const L = parsed.lines.lines
    let links = 0
    parsed.links.forEach((l, i) => {
      if (l.attachment) return
      this.insertLink(companyId, key, l, i, parsed, factIds, L, memo)
      links++
    })

    for (const t of parsed.tags) this.st.insertTag.run(companyId, key, t.factId ? (factIds.get(t.factId) ?? t.factId) : null, t.norm, t.tag, t.origin, t.line)

    const title = [parsed.title, ...parsed.aliases].join(' ')
    const body = L.slice(parsed.bodyStart).join('\n').slice(0, FTS_BODY_CAP)
    this.insertFts(companyId, key, 'note', key, title, body)
    for (const f of parsed.facts) this.insertFts(companyId, key, 'fact', factIds.get(f.id) ?? f.id, parsed.title, f.text)
    // incremental only: a rebuild inserts in path order, so the first row of a block id is already its owner
    if (opts.resolve) {
      const own = [...parsed.facts, ...parsed.relations].map((x) => x.blockId).filter((b): b is string => !!b)
      if (own.length) this.settleBlocks(companyId, own)
    }
    return { facts: parsed.facts.length, links, factIds }
  }

  private insertFts(companyId: string, noteId: string, kind: 'note' | 'fact', refId: string, title: string, body: string): void {
    const rowid = Number(this.st.insertFtsMap.run(companyId, noteId).lastInsertRowid)
    this.st.insertFts.run(rowid, kind, refId, companyId, noteId, title, body)
  }

  private insertFact(companyId: string, noteId: string, rel: string, f: ParsedFact, repoId: string | null): string {
    const row = {
      id: f.id,
      company_id: companyId,
      note_id: noteId,
      block_id: f.blockId,
      line: f.line,
      section: f.section,
      category: f.category,
      kind: f.kind,
      text: f.text,
      text_hash: textHash(f.text),
      status: f.status,
      superseded_by: f.supersededBy ? (blockIdToV1(f.supersededBy) ?? f.supersededBy) : null,
      pinned: f.pinned ? 1 : 0,
      reviewed: 0,
      actor: f.prov.actor,
      run_id: f.prov.runId,
      session_id: f.prov.sessionId,
      date: f.prov.date,
      repo_id: repoId,
      dup_of: null as string | null
    }
    if (f.blockId) this.st.deleteTombstone.run(companyId, f.id)
    try {
      this.st.insertFact.run(row)
      return row.id
    } catch (e) {
      if (!String((e as { code?: string }).code).startsWith('SQLITE_CONSTRAINT') || !f.blockId) throw e
      // a copied line: the block id lives in another note too; `settleBlocks` decides who owns it
      row.id = dupFactId(rel, f.id)
      row.dup_of = f.blockId
      row.block_id = null
      this.st.insertFact.run(row)
      return row.id
    }
  }

  private renameFactRefs(companyId: string, noteId: string, from: string, to: string): void {
    this.db.prepare('UPDATE mem_link SET from_fact = ? WHERE company_id = ? AND from_note = ? AND from_fact = ?').run(to, companyId, noteId, from)
    this.db.prepare('UPDATE mem_tag SET fact_id = ? WHERE company_id = ? AND note_id = ? AND fact_id = ?').run(to, companyId, noteId, from)
    this.db
      .prepare(`UPDATE mem_fts SET ref_id = ? WHERE rowid IN (SELECT rowid FROM mem_fts_map WHERE company_id = ? AND note_id = ?) AND ref_kind = 'fact' AND ref_id = ?`)
      .run(to, companyId, noteId, from)
  }

  /**
   * A block id copied into several notes belongs to the live row with the smallest path, the order a rebuild inserts
   * them in, so ownership never depends on which file was indexed first or on later moves. The others are keyed as
   * copies (`dup_of`) and never targeted. A tombstone gives way to a live copy.
   */
  private settleBlocks(companyId: string, blockIds: Iterable<string>): void {
    const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    for (const blockId of new Set(blockIds)) {
      const v1 = blockIdToV1(blockId)
      if (!v1) continue
      if (blockId.startsWith('f-')) {
        const rows = this.db
          .prepare(
            `SELECT f.id, f.note_id, f.status, n.path, n.removed_at FROM mem_fact f JOIN mem_note n ON n.company_id = f.company_id AND n.id = f.note_id
             WHERE f.company_id = ? AND (f.id = ? OR f.dup_of = ?)`
          )
          .all(companyId, v1, blockId) as { id: string; note_id: string; status: string; path: string; removed_at: string | null }[]
        const live = rows.filter((r) => r.status !== 'removed_external' && !r.removed_at).sort(byPath)
        const owner = rows.find((r) => r.id === v1)
        const best = live[0]
        if (!best || best.id === v1) continue
        if (owner) {
          if (owner.status === 'removed_external') this.st.deleteTombstone.run(companyId, v1)
          else {
            const soft = dupFactId(owner.path, v1)
            this.db.prepare('UPDATE mem_fact SET id = ?, dup_of = block_id, block_id = NULL WHERE company_id = ? AND id = ?').run(soft, companyId, v1)
            this.renameFactRefs(companyId, owner.note_id, v1, soft)
          }
        }
        this.db.prepare('UPDATE mem_fact SET id = ?, block_id = dup_of, dup_of = NULL WHERE company_id = ? AND id = ?').run(v1, companyId, best.id)
        this.renameFactRefs(companyId, best.note_id, best.id, v1)
      } else {
        const rows = this.db
          .prepare(
            `SELECT l.id, l.from_note, n.path FROM mem_link l JOIN mem_note n ON n.company_id = l.company_id AND n.id = l.from_note
             WHERE l.company_id = ? AND (l.id = ? OR l.dup_of = ?) AND n.removed_at IS NULL`
          )
          .all(companyId, v1, blockId) as { id: string; from_note: string; path: string }[]
        const best = rows.sort(byPath)[0]
        if (!best || best.id === v1) continue
        const owner = rows.find((r) => r.id === v1)
        if (owner) this.db.prepare('UPDATE mem_link SET id = ?, dup_of = block_id, block_id = NULL WHERE company_id = ? AND id = ?').run(`l:${owner.from_note}:${v1}`, companyId, v1)
        this.db.prepare('UPDATE mem_link SET id = ?, block_id = dup_of, dup_of = NULL WHERE company_id = ? AND id = ?').run(v1, companyId, best.id)
      }
    }
  }

  private insertLink(
    companyId: string,
    noteId: string,
    l: ParsedLink,
    i: number,
    parsed: ParsedNote,
    factIds: Map<string, string>,
    L: string[],
    memo: Map<string, ResolvedTarget> | undefined
  ): string {
    const { norm } = targetNorm(l.target)
    const relation = l.origin === 'relation' && l.relationId ? parsed.relations.find((r) => r.id === l.relationId) : undefined
    const fact = l.factId ? parsed.facts.find((f) => f.id === l.factId) : undefined
    const prov = relation?.prov ?? fact?.prov ?? null
    const resolved = memo ? this.resolve(companyId, l.target, memo) : null
    const lineText = l.origin === 'property' ? '' : (L[l.line] ?? '').trim().slice(0, CONTEXT_CAP)
    const row = {
      id: relation ? relation.id : `l:${noteId}:${i}`,
      company_id: companyId,
      from_note: noteId,
      from_fact: l.factId ? (factIds.get(l.factId) ?? l.factId) : null,
      line: l.line,
      rel: relation ? relation.rel : l.rel,
      norm_rel: l.rel,
      origin: l.origin,
      to_note: resolved?.toNote ?? null,
      to_text: l.target,
      to_norm: norm,
      to_heading: l.heading,
      to_block: l.block,
      display: l.display,
      embed: l.embed ? 1 : 0,
      ambiguous: resolved?.ambiguous ? 1 : 0,
      candidates_json: resolved?.ambiguous ? JSON.stringify(resolved.candidates) : null,
      context: relation ? relation.context : lineText || null,
      block_id: relation?.blockId ?? null,
      status: l.status,
      actor: prov?.actor ?? null,
      run_id: prov?.runId ?? null,
      date: prov?.date ?? null,
      dup_of: null as string | null
    }
    try {
      this.st.insertLink.run(row)
    } catch (e) {
      if (!String((e as { code?: string }).code).startsWith('SQLITE_CONSTRAINT') || !relation?.blockId) throw e
      // a copied relation line (see settleBlocks)
      row.dup_of = relation.blockId
      row.id = `l:${noteId}:${row.id}`
      row.block_id = null
      this.st.insertLink.run(row)
    }
    return row.id
  }

  /** Re-resolves every link whose target could be one of `keys` (norm names, or `\u0001<noteId>` for current targets). */
  private reresolve(companyId: string, keys: Set<string>): Set<string> {
    const names = [...keys].filter((k) => !k.startsWith('\u0001'))
    const ids = [...keys].filter((k) => k.startsWith('\u0001')).map((k) => k.slice(1))
    const bases = new Set<string>()
    for (const n of names) bases.add(n.split('/').pop() ?? n)
    const rows = new Map<string, { id: string; from_note: string; to_text: string; to_note: string | null; ambiguous: number; candidates_json: string | null }>()
    const collect = (sql: string, args: unknown[]): void => {
      for (const r of this.db.prepare(sql).all(...args) as Array<{ id: string; from_note: string; to_text: string; to_note: string | null; ambiguous: number; candidates_json: string | null }>) rows.set(r.id, r)
    }
    const cols = 'id, from_note, to_text, to_note, ambiguous, candidates_json'
    for (let i = 0; i < names.length; i += 400) {
      const chunk = names.slice(i, i + 400)
      collect(`SELECT ${cols} FROM mem_link WHERE company_id = ? AND to_norm IN (${chunk.map(() => '?').join(',')})`, [companyId, ...chunk])
    }
    for (const id of ids) collect(`SELECT ${cols} FROM mem_link WHERE company_id = ? AND to_note = ?`, [companyId, id])
    for (const b of bases) collect(`SELECT ${cols} FROM mem_link WHERE company_id = ? AND to_norm LIKE ? ESCAPE '\\'`, [companyId, `%/${escapeLike(b)}`])
    const memo = new Map<string, ResolvedTarget>()
    const touched = new Set<string>()
    for (const r of rows.values()) {
      const res = this.resolve(companyId, r.to_text, memo)
      const cand = res.ambiguous ? JSON.stringify(res.candidates) : null
      if (res.toNote === r.to_note && (res.ambiguous ? 1 : 0) === r.ambiguous && cand === r.candidates_json) continue
      this.st.updateLinkTarget.run(res.toNote, res.ambiguous ? 1 : 0, cand, companyId, r.id)
      touched.add(r.from_note)
    }
    return touched
  }

  /** Notes whose `repos:` property links point at `noteId`. */
  private repoLinkers(companyId: string, noteId: string): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT from_note FROM mem_link WHERE company_id = ? AND to_note = ? AND origin = 'property' AND norm_rel = 'repos'`).all(companyId, noteId) as {
        from_note: string
      }[]
    ).map((r) => r.from_note)
  }

  /** repo_ids_json = the note's own repo_id plus the repo_id of every note its `repos:` property links resolve to. */
  private refreshRepoIds(companyId: string, noteIds: Set<string>): void {
    for (const id of noteIds) {
      const n = this.noteById(companyId, id)
      if (!n || n.removed_at) continue
      const ids = new Set<string>()
      if (n.repo_id) ids.add(n.repo_id)
      for (const r of this.st.repoLinks.all(companyId, id) as { repo_id: string }[]) ids.add(r.repo_id)
      const json = JSON.stringify([...ids].sort())
      if (json !== n.repo_ids_json) this.st.setRepoIds.run(json, companyId, id)
    }
  }

  // ---------- external edit diff ----------

  private semanticDiff(
    oldFacts: Map<string, OldFact>,
    oldRels: Map<string, { id: string; block_id: string | null; status: string }>,
    parsed: ParsedNote,
    factIds: Map<string, string>
  ): SemanticDiff {
    const d: SemanticDiff = { created: [], updated: [], removed: [], relCreated: [], relChanged: [], relRemoved: [] }
    const newIds = new Set<string>()
    for (const f of parsed.facts) {
      const id = factIds.get(f.id) ?? f.id
      newIds.add(id)
      const old = oldFacts.get(id)
      if (!old) d.created.push({ id, blockId: f.blockId, text: f.text, status: f.status, actor: f.prov.actor })
      else if (old.status !== f.status || old.text_hash !== textHash(f.text)) d.updated.push({ id, blockId: f.blockId, from: old.status, to: f.status, text: f.text })
    }
    for (const [id, old] of oldFacts) {
      // only Principia-stamped lines are tracked; hand-written soft keys change with their text
      if (!newIds.has(id) && old.block_id && old.status === 'active') d.removed.push(old)
    }
    const relNew = new Map(parsed.relations.map((r) => [r.id, r]))
    for (const r of parsed.relations) {
      const old = oldRels.get(r.id)
      if (!old) d.relCreated.push({ id: r.id, blockId: r.blockId, rel: r.normRel, target: r.link.target })
      else if (old.status !== r.status) d.relChanged.push({ id: r.id, blockId: r.blockId, from: old.status, to: r.status })
    }
    for (const [id, old] of oldRels) if (!relNew.has(id) && old.block_id) d.relRemoved.push({ id, blockId: old.block_id })
    return d
  }

  private insertTombstones(companyId: string, noteId: string, removed: OldFact[]): void {
    for (const f of removed) {
      try {
        this.st.insertFact.run({ ...f, company_id: companyId, note_id: noteId, status: 'removed_external' })
      } catch {
        // the line moved to another note in the same edit: it is not removed
      }
    }
  }

  private logExternal(companyId: string, root: string, rel: string, key: string, prev: NoteRow | null, d: SemanticDiff | null, hash: string, at: string): void {
    const base = { ts: at, companyId, entityId: key, path: rel, baseHash: prev?.hash ?? null, newHash: hash, after: { external: true } }
    if (!prev || prev.removed_at) {
      logEvent(this.db, root, { ...base, op: prev?.removed_at ? 'restore' : 'create', targetKind: 'note', targetId: key, actor: 'user' })
      return
    }
    if (!d) return
    for (const c of d.created) logEvent(this.db, root, { ...base, op: 'create', targetKind: 'fact', targetId: c.id, blockId: c.blockId, actor: c.actor, after: { external: true, text: c.text, status: c.status } })
    for (const u of d.updated) {
      const op = u.from !== u.to ? (u.to === 'active' ? 'restore' : u.to === 'invalid' ? 'invalidate' : 'supersede') : 'update'
      logEvent(this.db, root, { ...base, op, targetKind: 'fact', targetId: u.id, blockId: u.blockId, actor: 'user', before: { status: u.from }, after: { external: true, status: u.to, text: u.text } })
    }
    for (const r of d.removed) logEvent(this.db, root, { ...base, op: 'removed_external', targetKind: 'fact', targetId: r.id, blockId: r.block_id, actor: 'user', before: { text: r.text } })
    for (const r of d.relCreated) logEvent(this.db, root, { ...base, op: 'create', targetKind: 'relation', targetId: r.id, blockId: r.blockId, actor: 'user', after: { external: true, rel: r.rel, target: r.target } })
    for (const r of d.relChanged) {
      logEvent(this.db, root, { ...base, op: r.to === 'active' ? 'restore' : 'invalidate', targetKind: 'relation', targetId: r.id, blockId: r.blockId, actor: 'user', before: { status: r.from }, after: { external: true, status: r.to } })
    }
    for (const r of d.relRemoved) logEvent(this.db, root, { ...base, op: 'removed_external', targetKind: 'relation', targetId: r.id, blockId: r.blockId, actor: 'user' })
    if (!d.created.length && !d.updated.length && !d.removed.length && !d.relCreated.length && !d.relChanged.length && !d.relRemoved.length && prev.path !== rel) {
      logEvent(this.db, root, { ...base, op: 'rename', targetKind: 'note', targetId: key, actor: 'user', before: { path: prev.path }, after: { external: true, path: rel } })
    }
  }

  // ---------- the one automatic write ----------

  private stampFreshId(companyId: string, root: string, rel: string, file: FileState): { id: string; file: FileState } | null {
    if (this.opts.canWrite && !this.opts.canWrite(companyId, root)) return null
    const id = newNoteId()
    let text: string
    try {
      text = setProperty(file.text, 'id', id).text
    } catch {
      return null // unparseable frontmatter is never rewritten
    }
    const abs = toVaultAbs(root, rel)
    const now = readFileState(abs)
    if (!now || now.hash !== file.hash) return null // changed under us; the next event re-runs this
    atomicWrite(abs, text)
    const after = readFileState(abs)
    return after ? { id, file: after } : null
  }
}

interface SemanticDiff {
  created: Array<{ id: string; blockId: string | null; text: string; status: string; actor: string }>
  updated: Array<{ id: string; blockId: string | null; from: string; to: string; text: string }>
  removed: OldFact[]
  relCreated: Array<{ id: string; blockId: string | null; rel: string; target: string }>
  relChanged: Array<{ id: string; blockId: string | null; from: string; to: string }>
  relRemoved: Array<{ id: string; blockId: string | null }>
}

/** Every derived row of a company in a stable order, without timestamps (tests compare incremental vs rebuild). */
export function dumpDerived(db: IndexDB, companyId: string): Record<string, unknown[]> {
  const q = (sql: string): unknown[] => db.prepare(sql).all(companyId)
  return {
    notes: q(
      `SELECT id, path, path_norm, basename_norm, title, norm_title, type, status, pinned, summary, frontmatter_json, repo_id, repo_ids_json, hash,
         created, modified, parse_warnings_json, removed_at IS NOT NULL AS removed FROM mem_note WHERE company_id = ? ORDER BY id`
    ),
    aliases: q('SELECT note_id, alias, norm_alias FROM mem_alias WHERE company_id = ? ORDER BY note_id, norm_alias'),
    facts: q(
      `SELECT id, note_id, block_id, line, section, category, kind, text, text_hash, status, superseded_by, pinned, actor, run_id, session_id, date, repo_id, dup_of
       FROM mem_fact WHERE company_id = ? ORDER BY id`
    ),
    links: q(
      `SELECT id, from_note, from_fact, line, rel, norm_rel, origin, to_note, to_text, to_norm, to_heading, to_block, display, embed, ambiguous,
         candidates_json, context, block_id, status, actor, run_id, date, dup_of FROM mem_link WHERE company_id = ? ORDER BY id`
    ),
    tags: q('SELECT note_id, fact_id, tag_norm, tag_display, origin, line FROM mem_tag WHERE company_id = ? ORDER BY note_id, line, tag_norm, origin, fact_id'),
    fts: q(
      `SELECT f.ref_kind, f.ref_id, f.note_id, f.title, f.body FROM mem_fts_map m JOIN mem_fts f ON f.rowid = m.rowid
       WHERE m.company_id = ? ORDER BY f.note_id, f.ref_kind, f.ref_id`
    )
  }
}
