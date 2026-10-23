// Title/alias trie (PASSPORT.md §7.2 autolink, §12 stage-0 mentions). Finds plain-text mentions of
// note titles and aliases, longest match first, on word boundaries, outside code, existing links,
// provenance tails and block ids. Terms under `shortExactCaseBelow` characters match in exact case
// only; stoplisted words and terms under `minLength` are never indexed. A term shared by several notes
// is reported as ambiguous and never autolinked.

import { type Span, fencedCodeLines, maskInlineCode, parseBulletLine, scanLinks } from './grammar'
import type { ParsedNote } from './parse'
import { pathStem } from './resolve'

export interface TrieNote {
  id: string
  title: string
  aliases?: string[]
  /** Vault-relative path; the link target is its stem (titles may differ from filenames). */
  path?: string
}

export interface Mention {
  start: number
  end: number
  /** Text as it appears. */
  text: string
  noteId: string
  title: string
  /** Link target to write (`[[target]]`). */
  target: string
  alias: boolean
  /** The text equals the title/alias in exact case. */
  exactCase: boolean
  ambiguous: boolean
  candidates: string[]
}

interface Term {
  noteId: string
  title: string
  target: string
  written: string
  alias: boolean
}

interface Node {
  next: Map<string, Node>
  terms: Term[]
}

export const DEFAULT_STOPLIST = [
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'over', 'about', 'note', 'notes', 'user', 'users',
  'todo', 'fact', 'facts', 'data', 'test', 'tests', 'main', 'home', 'team', 'plan', 'work', 'time', 'page', 'file',
  'files', 'app', 'apps', 'api', 'web', 'new', 'old', 'all', 'any', 'one', 'two', 'yes', 'not', 'are', 'was', 'has',
  'have', 'will', 'can', 'use', 'used', 'uses', 'via', 'per', 'out', 'more', 'less', 'some', 'here', 'there', 'when',
  'what', 'which', 'who', 'how', 'why', 'pro', 'free', 'next', 'last', 'first', 'done', 'open', 'list', 'item', 'items'
]

export interface TrieOptions {
  minLength?: number
  shortExactCaseBelow?: number
  stoplist?: Iterable<string>
}

const WORD_RE = /[\p{L}\p{N}_]/u

function fold(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

export class TitleTrie {
  private root: Node = { next: new Map(), terms: [] }
  private readonly shortExactCaseBelow: number

  constructor(notes: TrieNote[], opts: TrieOptions = {}) {
    const minLength = opts.minLength ?? 3
    this.shortExactCaseBelow = opts.shortExactCaseBelow ?? 4
    const stop = new Set([...(opts.stoplist ?? DEFAULT_STOPLIST)].map(fold))
    for (const n of notes) {
      const target = n.path ? pathStem(n.path) : n.title
      const seen = new Set<string>()
      for (const [written, alias] of [[n.title, false], ...(n.aliases ?? []).map((a) => [a, true] as const)] as Array<[string, boolean]>) {
        const key = fold(written)
        if (key.length < minLength || stop.has(key) || seen.has(key)) continue
        seen.add(key)
        this.insert(key, { noteId: n.id, title: n.title, target, written: written.normalize('NFKC').replace(/\s+/g, ' ').trim(), alias })
      }
    }
  }

  private insert(key: string, term: Term): void {
    let node = this.root
    for (const ch of key) {
      let next = node.next.get(ch)
      if (!next) node.next.set(ch, (next = { next: new Map(), terms: [] }))
      node = next
    }
    node.terms.push(term)
  }

  /**
   * Non-overlapping mentions in one string, leftmost-longest. `skip` ranges (code, links…) are never
   * matched into; `excludeIds` drops self-mentions.
   */
  find(text: string, opts: { skip?: Span[]; excludeIds?: Iterable<string> } = {}): Mention[] {
    const skip = opts.skip ?? []
    const exclude = new Set(opts.excludeIds ?? [])
    const inSkip = (s: number, e: number): boolean => skip.some((r) => s < r.end && r.start < e)
    const out: Mention[] = []
    let s = 0
    while (s < text.length) {
      if ((s > 0 && WORD_RE.test(text[s - 1])) || !WORD_RE.test(text[s])) {
        s++
        continue
      }
      let node: Node | undefined = this.root
      let i = s
      let best: { end: number; terms: Term[] } | null = null
      let pendingSpace = false
      while (node && i < text.length) {
        const ch = text[i]
        if (/\s/.test(ch)) {
          if (pendingSpace) {
            i++
            continue
          }
          pendingSpace = true
          node = node.next.get(' ')
          i++
          continue
        }
        pendingSpace = false
        const lower = ch.toLowerCase()
        node = node.next.get(lower.length === 1 ? lower : ch)
        i++
        if (node && node.terms.length > 0 && (i >= text.length || !WORD_RE.test(text[i]))) best = { end: i, terms: node.terms }
      }
      if (!best || inSkip(s, best.end)) {
        s++
        continue
      }
      const surface = text.slice(s, best.end)
      const folded = surface.replace(/\s+/g, ' ')
      const terms = best.terms.filter((t) => !exclude.has(t.noteId) && ([...t.written].length >= this.shortExactCaseBelow || t.written === folded))
      const ids = [...new Set(terms.map((t) => t.noteId))]
      if (ids.length === 0) {
        s++
        continue
      }
      const pick = terms.find((t) => !t.alias) ?? terms[0]
      out.push({
        start: s,
        end: best.end,
        text: surface,
        noteId: pick.noteId,
        title: pick.title,
        target: pick.target,
        alias: pick.alias,
        exactCase: pick.written === folded,
        ambiguous: ids.length > 1,
        candidates: ids
      })
      s = best.end
    }
    return out
  }
}

/** Ranges a mention may not touch in one body line: inline code, links, URLs. */
export function lineSkipRanges(line: string): Span[] {
  const ranges: Span[] = []
  const masked = maskInlineCode(line)
  for (let j = 0; j < line.length; j++) if (masked[j] !== line[j]) ranges.push({ start: j, end: j + 1 })
  for (const l of scanLinks(masked, { maskCode: false })) ranges.push({ start: l.start, end: l.end })
  for (const m of masked.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi)) ranges.push({ start: m.index!, end: m.index! + m[0].length })
  return ranges
}

export interface AutolinkResult {
  text: string
  linked: Array<{ noteId: string; title: string; matched: string; alias: boolean }>
}

/**
 * memory_write autolink: wraps exact, unambiguous, case-insensitive title/alias matches in an agent's
 * fact text as `[[Target]]` or `[[Target|as written]]`, outside code and links, at most `max` per text.
 */
export function autolinkText(text: string, trie: TitleTrie, opts: { max?: number; excludeIds?: Iterable<string> } = {}): AutolinkResult {
  const max = opts.max ?? 5
  const mentions = trie
    .find(text, { skip: lineSkipRanges(text), excludeIds: opts.excludeIds })
    .filter((m) => !m.ambiguous)
    .slice(0, max)
  let out = text
  for (const m of [...mentions].reverse()) {
    const rendered = m.text === m.target ? `[[${m.target}]]` : `[[${m.target}|${m.text}]]`
    out = out.slice(0, m.start) + rendered + out.slice(m.end)
  }
  return { text: out, linked: mentions.map((m) => ({ noteId: m.noteId, title: m.title, matched: m.text, alias: m.alias })) }
}

export interface NoteMention extends Mention {
  line: number
}

/**
 * Unlinked mentions across a parsed note's body (stage-0 suggestions, "unlinked mentions" panel):
 * skips frontmatter, fenced code, headings, existing links, categories, provenance and block ids,
 * and the note itself.
 */
export function findNoteMentions(note: ParsedNote, trie: TitleTrie, opts: { excludeIds?: Iterable<string> } = {}): NoteMention[] {
  const L = note.lines.lines
  const code = note.code.length === L.length ? note.code : fencedCodeLines(L, note.bodyStart)
  const exclude = new Set(opts.excludeIds ?? [])
  exclude.add(note.key)
  const out: NoteMention[] = []
  for (let i = note.bodyStart; i < L.length; i++) {
    const line = L[i]
    if (code[i] || /^\s{0,3}#{1,6}(\s|$)/.test(line)) continue
    const skip = lineSkipRanges(line)
    const b = parseBulletLine(line, note.sections[i] === 'history')
    if (b) {
      skip.push(b.spans.marker)
      for (const s of [b.spans.category, b.spans.prov, b.spans.anchor, b.spans.detail, b.spans.rel]) if (s) skip.push(s)
    }
    for (const m of trie.find(line, { skip, excludeIds: exclude })) out.push({ ...m, line: i })
  }
  return out
}
