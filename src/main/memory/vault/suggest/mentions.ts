/**
 * Stage 0 `link` suggestions (PASSPORT.md §12): unlinked plain-text mentions of note titles and aliases, found with the
 * shared title trie (3+ characters, a stoplist of common words, names under 4 characters only in exact case). Code,
 * existing links, frontmatter, headings, provenance tails, History lines and self-mentions are skipped. One proposal
 * per (note, target): the first mention, the Obsidian way. A note that already links the target gets none.
 * Score = exactness (title 0.9, alias 0.8) x length x case; ambiguous terms are never suggested.
 */
import { findNoteMentions, TitleTrie, type NoteMention } from '../../../../shared/vault/autolink'
import { parseNote, type ParsedNote } from '../../../../shared/vault/parse'
import type { Candidate, VaultView, ViewNote } from './candidates'
import { liveNotes } from './candidates'

export const MENTION_MIN_SCORE = 0.5

export function buildTrie(notes: ViewNote[]): TitleTrie {
  return new TitleTrie(notes.map((n) => ({ id: n.id, title: n.title, aliases: n.aliases, path: n.path })))
}

/** Score of one mention: exact title 0.9, alias 0.8; longer names and exact case score higher. */
export function mentionScore(m: Pick<NoteMention, 'alias' | 'exactCase' | 'text' | 'ambiguous'>): number {
  if (m.ambiguous) return 0
  const base = m.alias ? 0.8 : 0.9
  const len = Math.min(1, 0.75 + [...m.text].length / 24)
  return Math.round(base * len * (m.exactCase ? 1 : 0.85) * 1000) / 1000
}

/** Unlinked, unambiguous mentions in a parsed note, first per target, excluding targets the note already links. */
export function noteMentions(parsed: ParsedNote, trie: TitleTrie, opts: { selfId: string; linked: Set<string> }): NoteMention[] {
  const seen = new Set<string>()
  const out: NoteMention[] = []
  for (const m of findNoteMentions(parsed, trie, { excludeIds: [opts.selfId] })) {
    if (m.ambiguous || parsed.sections[m.line] === 'history') continue
    if (opts.linked.has(m.noteId) || seen.has(m.noteId)) continue
    seen.add(m.noteId)
    out.push(m)
  }
  return out
}

/** Notes this note already links to (resolved, active). */
export function linkedFrom(view: VaultView, noteId: string): Set<string> {
  const s = new Set<string>()
  for (const e of view.edges) if (e.from === noteId) s.add(e.to)
  return s
}

export interface NoteText {
  text: string
  hash: string
}

/** `link` candidates for the given notes (null = every live note). `read` returns the note's current bytes. */
export function mentionCandidates(view: VaultView, noteIds: string[] | null, read: (n: ViewNote) => NoteText | null, trie?: TitleTrie): Candidate[] {
  const live = liveNotes(view)
  const t = trie ?? buildTrie(live)
  const sources = noteIds ? noteIds.map((id) => view.byId.get(id)).filter((n): n is ViewNote => !!n && n.status !== 'archived') : live
  const out: Candidate[] = []
  for (const src of sources) {
    const file = read(src)
    if (!file) continue
    const parsed = parseNote(file.text, { path: src.path })
    for (const m of noteMentions(parsed, t, { selfId: src.id, linked: linkedFrom(view, src.id) })) {
      const target = view.byId.get(m.noteId)
      if (!target) continue
      const score = mentionScore(m)
      if (score < MENTION_MIN_SCORE) continue
      out.push({
        kind: 'link',
        source: 'mentions',
        ops: [{ op: 'linkMention', note: src.stem, line: m.line, span: { start: m.start, end: m.end }, target: target.stem, text: m.text }],
        evidence: [{ path: src.path, line: m.line, quote: parsed.lines.lines[m.line].trim().slice(0, 300), note: `mentions [[${target.stem}]]${m.alias ? ` (alias "${m.text}")` : ''}` }],
        score,
        key: `link:${src.id}:${target.id}`,
        baseHashes: { [src.path]: file.hash }
      })
    }
  }
  return out
}

/**
 * Re-anchors a `linkMention` after its note changed (§12 stale handling): the first unlinked mention of `target` in the
 * new text, or null when the mention is gone or the note now links the target.
 */
export function reanchorMention(text: string, src: ViewNote, target: ViewNote, linked: Set<string>): { line: number; span: { start: number; end: number }; text: string; quote: string } | null {
  if (linked.has(target.id)) return null
  const parsed = parseNote(text, { path: src.path })
  const trie = buildTrie([target])
  const m = noteMentions(parsed, trie, { selfId: src.id, linked })[0]
  return m ? { line: m.line, span: { start: m.start, end: m.end }, text: m.text, quote: parsed.lines.lines[m.line].trim().slice(0, 300) } : null
}
