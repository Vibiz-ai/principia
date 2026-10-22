/**
 * Passport view helpers (PASSPORT.md §10): the vault tree and tag tree, the `[[` / `#` completion used by the source
 * editor, link resolution for reading mode, the live-update rule for an open note, Inbox sections and bulk accept,
 * diff previews and property hints. Pure: no React, no IPC.
 */
import type { NoteId, ProposalKind, VaultGhost, VaultLink, VaultPropertyValue, VaultProposal, VaultTagCount, VaultTreeEntry } from '@shared/passport'
import { NEEDS_DECISION_KINDS } from '@shared/passport'
import { diffLines, splitKeepEol, type MergeRegion } from '@shared/vault/diff3'
import { normName, normPath, pathStem } from '@shared/vault/resolve'
import { fuzzyScore } from './fuzzy'
import type { LinkResolver } from './markdown'

/** Tree rows may carry aliases once main sends them (PASSPORT.md §10 alias completion); absent = none known. */
export type TreeNote = VaultTreeEntry & { aliases?: string[] }

// ---------- vault tree ----------
export interface FolderNode {
  name: string
  /** vault-relative folder path, '' = root */
  path: string
  folders: FolderNode[]
  notes: TreeNote[]
  /** notes in this folder and below */
  count: number
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Folders first (alphabetical), then notes by title; `type` filters notes (folders left empty disappear). */
export function buildFolderTree(entries: TreeNote[], type: string | null = null): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], notes: [], count: 0 }
  const index = new Map<string, FolderNode>([['', root]])
  const folder = (path: string): FolderNode => {
    const hit = index.get(path)
    if (hit) return hit
    const parent = folder(folderOf(path))
    const node: FolderNode = { name: path.split('/').pop()!, path, folders: [], notes: [], count: 0 }
    parent.folders.push(node)
    index.set(path, node)
    return node
  }
  for (const e of entries) {
    if (type && e.type !== type) continue
    folder(folderOf(e.path)).notes.push(e)
  }
  const finish = (n: FolderNode): number => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name))
    n.notes.sort((a, b) => a.title.localeCompare(b.title))
    n.count = n.notes.length + n.folders.reduce((s, f) => s + finish(f), 0)
    n.folders = n.folders.filter((f) => f.count > 0)
    return n.count
  }
  finish(root)
  return root
}

export function typeCounts(entries: TreeNote[]): { type: string; count: number }[] {
  const m = new Map<string, number>()
  for (const e of entries) m.set(e.type, (m.get(e.type) ?? 0) + 1)
  return [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

export function recentNotes(entries: TreeNote[], n = 8): TreeNote[] {
  return entries
    .filter((e) => e.modified)
    .sort((a, b) => (b.modified! < a.modified! ? -1 : b.modified! > a.modified! ? 1 : a.title.localeCompare(b.title)))
    .slice(0, n)
}

// ---------- tag tree ----------
export interface TagNode {
  /** last segment */
  name: string
  /** full nested tag (`team/founding`) */
  tag: string
  /** notes tagged exactly this */
  count: number
  /** notes tagged this or below (upper bound: a note with two child tags counts twice) */
  total: number
  children: TagNode[]
}

export function buildTagTree(tags: VaultTagCount[]): TagNode[] {
  const roots: TagNode[] = []
  const index = new Map<string, TagNode>()
  const node = (tag: string): TagNode => {
    const hit = index.get(tag)
    if (hit) return hit
    const cut = tag.lastIndexOf('/')
    const n: TagNode = { name: cut < 0 ? tag : tag.slice(cut + 1), tag, count: 0, total: 0, children: [] }
    index.set(tag, n)
    if (cut < 0) roots.push(n)
    else node(tag.slice(0, cut)).children.push(n)
    return n
  }
  for (const t of tags) {
    const tag = t.tag.replace(/^#/, '').replace(/\/+$/, '').toLowerCase()
    if (!tag) continue
    node(tag).count += t.count
  }
  const finish = (n: TagNode): number => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.total = n.count + n.children.reduce((s, c) => s + finish(c), 0)
    return n.total
  }
  roots.forEach(finish)
  return roots.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

// ---------- link resolution for reading mode ----------
/**
 * Resolves like the index (§5), from what the view already has: the open note's outgoing links (exact, the index's
 * own answer), then a unique path, basename, title or alias over the tree. Several matches stay a ghost.
 */
export function makeResolver(entries: TreeNote[], outgoing: VaultLink[] = []): LinkResolver {
  const byText = new Map<string, { noteId: string; title: string } | null>()
  for (const l of outgoing) {
    const k = normName(l.toText)
    if (l.toNote && l.toTitle) byText.set(k, { noteId: l.toNote, title: l.toTitle })
    else if (!byText.has(k)) byText.set(k, null)
  }
  const add = (m: Map<string, TreeNote[]>, k: string, e: TreeNote): void => {
    if (!k) return
    const list = m.get(k)
    if (!list) m.set(k, [e])
    else if (!list.includes(e)) list.push(e)
  }
  const paths = new Map<string, TreeNote[]>()
  const bases = new Map<string, TreeNote[]>()
  const titles = new Map<string, TreeNote[]>()
  const aliases = new Map<string, TreeNote[]>()
  for (const e of entries) {
    add(paths, normPath(e.path), e)
    add(bases, normName(pathStem(e.path)), e)
    add(titles, normName(e.title), e)
    for (const a of e.aliases ?? []) add(aliases, normName(a), e)
  }
  const unique = (list: TreeNote[] | undefined): { noteId: string; title: string } | null | undefined =>
    !list ? undefined : list.length === 1 ? { noteId: list[0]!.id, title: list[0]!.title } : null
  return (target) => {
    const k = normName(target)
    if (byText.has(k)) return byText.get(k) ?? null
    if (target.includes('/')) {
      const p = normPath(target)
      const exact = unique(paths.get(p))
      if (exact !== undefined) return exact
      const suffix = entries.filter((e) => normPath(e.path).endsWith(`/${p}`))
      return suffix.length === 1 ? { noteId: suffix[0]!.id, title: suffix[0]!.title } : null
    }
    for (const m of [bases, titles, aliases]) {
      const r = unique(m.get(k))
      if (r !== undefined) return r
    }
    return null
  }
}

// ---------- [[ and # completion ----------
export interface CompletionContext {
  kind: 'link' | 'tag'
  /** offset of the first query character (after `[[` or `#`) */
  start: number
  query: string
}

/** An open `[[query` or `#query` right before the caret, on the same line and outside inline code. */
export function completionContext(text: string, caret: number): CompletionContext | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const before = text.slice(lineStart, caret)
  if (((before.match(/`/g) ?? []).length & 1) === 1) return null
  const open = before.lastIndexOf('[[')
  if (open >= 0) {
    const q = before.slice(open + 2)
    if (!q.includes(']]') && !q.includes('[') && !/[|#^]/.test(q) && q.length <= 120) return { kind: 'link', start: lineStart + open + 2, query: q }
  }
  const tag = /(^|[\s(,;])#([A-Za-z0-9_/-]*)$/.exec(before)
  if (tag) {
    // a bare `#` at line start may become a heading: it opens only once a tag character follows
    if (tag.index === 0 && tag[1] === '' && tag[2] === '') return null
    return { kind: 'tag', start: caret - tag[2]!.length, query: tag[2]! }
  }
  return null
}

export interface CompletionItem {
  kind: 'note' | 'alias' | 'ghost' | 'tag' | 'new'
  label: string
  detail: string
  /** text inserted between `[[` and `]]` (or after `#`) */
  insert: string
  noteId?: NoteId
}

/**
 * `[[` suggestions: fuzzy over titles, aliases and ghosts (§10). Picking an alias inserts `Title|alias`, never a bare
 * alias, so the file resolves the same in real Obsidian. A query that matches nothing exactly offers a new ghost link.
 */
export function linkCompletions(query: string, notes: TreeNote[], ghosts: VaultGhost[], limit = 12): CompletionItem[] {
  const q = query.trim()
  const scored: { item: CompletionItem; s: number }[] = []
  for (const n of notes) {
    if (n.status === 'archived') continue
    const s = q ? fuzzyScore(q, n.title) : 0
    if (s >= 0) scored.push({ item: { kind: 'note', label: n.title, detail: folderOf(n.path) || n.type, insert: n.title, noteId: n.id }, s: s + (n.pinned ? 5 : 0) })
    for (const a of n.aliases ?? []) {
      if (!q) continue
      const sa = fuzzyScore(q, a)
      if (sa >= 0) scored.push({ item: { kind: 'alias', label: a, detail: `alias of ${n.title}`, insert: `${n.title}|${a}`, noteId: n.id }, s: sa - 1 })
    }
  }
  for (const g of ghosts) {
    const s = q ? fuzzyScore(q, g.text) : -1
    if (s >= 0 || (!q && g.inbound >= 2)) scored.push({ item: { kind: 'ghost', label: g.text, detail: `no note yet · ${g.inbound} link${g.inbound === 1 ? '' : 's'}`, insert: g.text }, s: Math.max(0, s) - 20 })
  }
  scored.sort((a, b) => b.s - a.s || a.item.label.localeCompare(b.item.label))
  const out: CompletionItem[] = []
  const seen = new Set<string>()
  for (const { item } of scored) {
    const k = `${item.kind === 'alias' ? 'a' : 'n'}:${normName(item.insert)}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
    if (out.length >= limit) break
  }
  if (q && !out.some((i) => normName(i.label) === normName(q))) out.push({ kind: 'new', label: q, detail: 'link to a new note', insert: q })
  return out
}

export function tagCompletions(query: string, tags: VaultTagCount[], limit = 12): CompletionItem[] {
  const q = query.trim().toLowerCase()
  return tags
    .map((t) => ({ t, s: q ? fuzzyScore(q, t.tag) : t.count }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.t.tag.localeCompare(b.t.tag))
    .slice(0, limit)
    .map(({ t }) => ({ kind: 'tag' as const, label: `#${t.display || t.tag}`, detail: `${t.count}`, insert: t.display || t.tag }))
}

/** Replaces the open query with the pick; closes `]]` unless already there. Returns the new text and caret. */
export function applyCompletion(text: string, caret: number, ctx: CompletionContext, item: CompletionItem): { text: string; caret: number } {
  if (ctx.kind === 'tag') {
    const after = text.slice(caret)
    const rest = /^[A-Za-z0-9_/-]*/.exec(after)![0]
    const next = text.slice(0, ctx.start) + item.insert + ' ' + after.slice(rest.length).replace(/^ /, '')
    return { text: next, caret: ctx.start + item.insert.length + 1 }
  }
  const after = text.slice(caret)
  // swallow the rest of a partially typed target up to an existing `]]` on this line
  const close = /^[^\n[\]]*\]\]/.exec(after)
  const tail = close ? after.slice(close[0].length) : after
  const next = `${text.slice(0, ctx.start)}${item.insert}]]${tail}`
  return { text: next, caret: ctx.start + item.insert.length + 2 }
}

/** `[[Title#^f-x]]` for "Copy block link". */
export function blockLink(title: string, blockId: string): string {
  return `[[${title}#^${blockId.replace(/^\^/, '')}]]`
}

// ---------- live updates of the open note ----------
export type LiveAction = 'none' | 'replace' | 'banner'
/**
 * An index change touched the open note (agent write, Obsidian edit): a clean editor takes the new text in place;
 * a dirty one keeps the user's text and shows "Changed by …: Merge" (§10). Same hash = nothing to do.
 */
export function liveAction(o: { baseHash: string | null; diskHash: string; dirty: boolean }): LiveAction {
  if (o.baseHash === o.diskHash) return 'none'
  return o.dirty ? 'banner' : 'replace'
}

/**
 * A save answer arriving after the user moved to another note (blur saved, then a click in the tree opened the next
 * one) belongs to the note left behind: applying it would show the old note under the new one's draft, and the next
 * autosave would write the new note's text into the old file. A lost compare-and-swap there can only be reported.
 */
export function saveLanding(o: { openNoteId: string | null | undefined; savedNoteId: string; status: 'saved' | 'conflict' }): 'apply' | 'ignore' | 'report' {
  if (o.openNoteId === o.savedNoteId) return 'apply'
  return o.status === 'saved' ? 'ignore' : 'report'
}

// ---------- persisted view settings ----------
/**
 * Saved settings over defaults, one section at a time: an object section merges key by key (a field added by a
 * newer build gets its default), an array or scalar is taken only if the saved value has the same shape. Anything
 * else (a corrupt or foreign localStorage value) falls back to the default.
 */
export function mergeSections<T extends object>(defaults: T, saved: unknown): T {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults
  const src = saved as Record<string, unknown>
  const out = { ...defaults } as Record<string, unknown>
  for (const [k, dv] of Object.entries(defaults)) {
    const sv = src[k]
    if (sv === undefined) continue
    if (Array.isArray(dv)) out[k] = Array.isArray(sv) ? sv : dv
    else if (dv && typeof dv === 'object') out[k] = sv && typeof sv === 'object' && !Array.isArray(sv) ? { ...dv, ...sv } : dv
    else out[k] = typeof sv === typeof dv ? sv : dv
  }
  return out as T
}

/** Above this many graph nodes ghosts and orphans start hidden (§10). */
export const HUGE_VAULT = 5000
/** Filters for a vault's first graph load with no saved settings: unchanged, or ghosts and orphans off when huge. */
export function firstLoadFilters<F extends { existingOnly?: boolean; orphans?: boolean }>(total: number, f: F): F | null {
  if (total <= HUGE_VAULT || (f.existingOnly && f.orphans === false)) return null
  return { ...f, existingOnly: true, orphans: false }
}

// ---------- Inbox ----------
export type InboxSection = 'decision' | 'taste' | 'links' | 'notes' | 'merges' | 'relations' | 'harvest'
export const INBOX_SECTIONS: { key: InboxSection; label: string }[] = [
  { key: 'decision', label: 'Needs decision' },
  { key: 'taste', label: 'Taste' },
  { key: 'links', label: 'Link suggestions' },
  { key: 'notes', label: 'New notes' },
  { key: 'merges', label: 'Merges' },
  { key: 'relations', label: 'Relation typing' },
  { key: 'harvest', label: 'Harvested notes' }
]
const SECTION_OF: Record<ProposalKind, InboxSection> = {
  fact_supersede: 'decision',
  conflict: 'decision',
  external_removal: 'decision',
  assign_company: 'decision',
  import_conflict: 'decision',
  taste: 'taste',
  link: 'links',
  retarget: 'links',
  disambiguate: 'links',
  alias_rewrite: 'links',
  rename_links: 'links',
  entity: 'notes',
  merge: 'merges',
  relation: 'relations',
  relation_type: 'relations',
  harvest: 'harvest'
}
export function inboxSection(p: Pick<VaultProposal, 'kind' | 'needsDecision'>): InboxSection {
  return p.needsDecision || (NEEDS_DECISION_KINDS as readonly string[]).includes(p.kind) ? 'decision' : (SECTION_OF[p.kind] ?? 'links')
}
export function groupInbox(items: VaultProposal[]): { key: InboxSection; label: string; items: VaultProposal[] }[] {
  return INBOX_SECTIONS.map((s) => ({ ...s, items: items.filter((p) => inboxSection(p) === s.key).sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt)) })).filter((s) => s.items.length)
}

/** ⇧A only batches deterministic sources (§10): stage 0 and 1, never the LLM, harvest or decisions. */
export const DETERMINISTIC_SOURCES = new Set(['mentions', 'ghosts', 'dupes', 'ontology', 'cooccur', 'similar'])
export const BULK_THRESHOLD = 0.75
/** Every pending proposal of the same kind and source as `p` scoring at least the threshold (p included). */
export function bulkAcceptIds(items: VaultProposal[], p: VaultProposal, threshold = BULK_THRESHOLD): string[] {
  if (!DETERMINISTIC_SOURCES.has(p.source) || inboxSection(p) === 'decision') return []
  return items.filter((x) => x.status === 'pending' && x.kind === p.kind && x.source === p.source && !x.needsDecision && (x.score >= threshold || x.id === p.id)).map((x) => x.id)
}

// ---------- diff preview ----------
export interface DiffRow {
  kind: '+' | '-' | ' ' | '…'
  text: string
}
/** Line diff of a proposal preview, with `context` unchanged lines around each change and the rest folded. */
export function diffRows(before: string, after: string, context = 2): DiffRow[] {
  const strip = (l: string): string => l.replace(/\r?\n$/, '')
  const ops = diffLines(splitKeepEol(before), splitKeepEol(after))
  const rows: DiffRow[] = []
  ops.forEach((op, i) => {
    if (op.op === 'delete') for (const l of op.lines) rows.push({ kind: '-', text: strip(l) })
    else if (op.op === 'insert') for (const l of op.lines) rows.push({ kind: '+', text: strip(l) })
    else {
      const lines = op.lines.map(strip)
      const head = i === 0 ? 0 : context
      const tail = i === ops.length - 1 ? 0 : context
      if (lines.length <= head + tail + 1) for (const l of lines) rows.push({ kind: ' ', text: l })
      else {
        for (const l of lines.slice(0, head)) rows.push({ kind: ' ', text: l })
        rows.push({ kind: '…', text: `${lines.length - head - tail} unchanged lines` })
        for (const l of lines.slice(lines.length - tail)) rows.push({ kind: ' ', text: l })
      }
    }
  })
  return rows
}

// ---------- properties ----------
/** Expected properties per type (warn-only schema hints, §4 / `_schema/<Type>.md`). */
export const SCHEMA_HINTS: Record<string, string[]> = {
  person: ['company'],
  customer: ['company', 'owner'],
  offer: ['company'],
  product: ['company'],
  repo: ['repo_id', 'company'],
  decision: ['owner'],
  meeting: ['company'],
  process: ['owner']
}
/** Keys the panel shows in the header rather than as editable fields. */
export const SYSTEM_PROPERTIES = new Set(['id', 'title', 'created', 'modified', 'source', 'merged_into'])

export function missingProperties(type: string, props: Record<string, VaultPropertyValue>): string[] {
  return (SCHEMA_HINTS[type] ?? []).filter((k) => {
    const v = props[k]
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  })
}

const LINK_VALUE_RE = /^\s*\[\[([^[\]\n]+)\]\]\s*$/
export function isLinkValue(v: VaultPropertyValue): boolean {
  return typeof v === 'string' ? LINK_VALUE_RE.test(v) : Array.isArray(v) && v.length > 0 && v.every((x) => LINK_VALUE_RE.test(x))
}
/** `"[[Acme]]"` -> `Acme` (display part dropped). */
export function linkValueTitle(v: string): string | null {
  const m = LINK_VALUE_RE.exec(v)
  return m ? m[1]!.split('|')[0]!.split('#')[0]!.trim() : null
}
export function toLinkValue(title: string): string {
  return `[[${title}]]`
}
export type PropertyKind = 'checkbox' | 'number' | 'date' | 'list' | 'link' | 'links' | 'text'
export function propertyKind(key: string, v: VaultPropertyValue): PropertyKind {
  if (typeof v === 'boolean' || key === 'pinned') return 'checkbox'
  if (typeof v === 'number') return 'number'
  if (Array.isArray(v)) return isLinkValue(v) || key === 'repos' ? 'links' : 'list'
  if (typeof v === 'string' && isLinkValue(v)) return 'link'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (['company', 'owner', 'merged_into'].includes(key)) return 'link'
  return 'text'
}

// ---------- merge ----------
export type MergePick = 'ours' | 'theirs' | 'both'
/** The merged text for the merge view's picks (an unpicked conflict keeps mine; the view blocks saving until picked). */
export function joinRegions(regions: MergeRegion[], picks: Record<number, MergePick>): string {
  let out = ''
  regions.forEach((r, i) => {
    if (r.stable) out += r.lines.join('')
    else if (!r.conflict) out += r.merged.join('')
    else {
      const p = picks[i] ?? 'ours'
      const body = p === 'ours' ? r.ours : p === 'theirs' ? r.theirs : [...r.ours, ...r.theirs]
      // keeping both must not glue the last line of one side onto the first of the other
      out += body.map((l, k) => (k < body.length - 1 && !l.endsWith('\n') ? `${l}\n` : l)).join('')
    }
  })
  return out
}
