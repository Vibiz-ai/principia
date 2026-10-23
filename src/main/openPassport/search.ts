// Vendored from open-passport 0.1.0 (packages/js/src/core/search.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// L2 on demand (SPEC.md §6.5): keyword search over live lines (BM25, grouped per note) and compact note reads.
import { cpCompare, normText, plainText } from './grammar'
import { fmValue, type Note } from './note'
import { liveObservations, liveRelations, noteByName, type PassportModel } from './passport'

export interface SearchHit {
  note: string
  type: string
  path: string
  score: number
  /** best matching live lines, `category: text` / `rel Target` */
  lines: string[]
}

const tokenize = (s: string) => normText(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1)

interface Doc {
  note: Note
  text: string
  tokens: string[]
}

function docsOf(m: PassportModel): Doc[] {
  const docs: Doc[] = []
  for (const n of m.notes) {
    if ((String(fmValue(n, 'status') ?? 'active')).toLowerCase() === 'archived') continue
    const head = `${n.title} ${n.summary}`
    docs.push({ note: n, text: n.summary ? plainText(n.summary) : n.title, tokens: tokenize(head) })
    for (const { obs } of liveObservations(n)) {
      const text = `${obs.category}: ${plainText(obs.text)}`
      docs.push({ note: n, text, tokens: [...tokenize(text), ...tokenize(n.title)] })
    }
    for (const r of liveRelations(n)) {
      const text = `${r.rel} ${plainText(r.target)}${r.context ? ` (${plainText(r.context)})` : ''}`
      docs.push({ note: n, text, tokens: [...tokenize(text), ...tokenize(n.title)] })
    }
  }
  return docs
}

/** BM25 (k1 1.2, b 0.75) over line documents; a note scores its best line plus 0.3 of the rest. */
export function search(m: PassportModel, query: string, opts: { limit?: number; linesPerNote?: number } = {}): SearchHit[] {
  const q = [...new Set(tokenize(query))]
  if (!q.length) return []
  const docs = docsOf(m)
  const N = docs.length
  const avg = docs.reduce((s, d) => s + d.tokens.length, 0) / Math.max(1, N)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  const scored = new Map<Note, { best: number; rest: number; lines: { s: number; text: string }[] }>()
  for (const d of docs) {
    let s = 0
    for (const t of q) {
      const tf = d.tokens.filter((x) => x === t || (t.length >= 4 && x.startsWith(t))).length
      if (!tf) continue
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      s += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.tokens.length / avg))))
    }
    if (s <= 0) continue
    const e = scored.get(d.note) ?? { best: 0, rest: 0, lines: [] }
    if (s > e.best) {
      e.rest += e.best
      e.best = s
    } else e.rest += s
    e.lines.push({ s, text: d.text })
    scored.set(d.note, e)
  }
  const per = opts.linesPerNote ?? 3
  return [...scored.entries()]
    .map(([n, e]) => ({
      note: n.title,
      type: n.type,
      path: n.path,
      score: Math.round((e.best + 0.3 * e.rest) * 1000) / 1000,
      lines: e.lines
        .sort((a, b) => b.s - a.s)
        .slice(0, per)
        .map((l) => l.text)
    }))
    .sort((a, b) => b.score - a.score || cpCompare(a.note, b.note))
    .slice(0, opts.limit ?? 8)
}

export interface NoteView {
  note: string
  type: string
  path: string
  summary: string
  /** live observations with their ids, `[category] text ^id` (ids let a writer supersede them) */
  lines: string[]
  relations: string[]
  backlinks: string[]
}

/** One note, compact: live lines with ids, relations and backlinks (who links here). */
export function getNote(m: PassportModel, name: string): NoteView | null {
  const n = noteByName(m, name)
  if (!n) return null
  const want = new Set([n.title.toLowerCase(), n.path.replace(/\.md$/i, '').toLowerCase()])
  const backlinks: string[] = []
  for (const o of m.notes) {
    if (o === n) continue
    for (const r of liveRelations(o)) if (want.has(r.target.toLowerCase())) backlinks.push(`${o.title} ${r.rel}`)
  }
  return {
    note: n.title,
    type: n.type,
    path: n.path,
    summary: plainText(n.summary),
    lines: liveObservations(n).map(({ obs }) => `[${obs.category}] ${obs.text}${obs.id ? ` ^${obs.id}` : ''}`),
    relations: liveRelations(n).map((r) => `${r.rel} [[${r.target}]]${r.context ? ` (${r.context})` : ''}`),
    backlinks
  }
}
