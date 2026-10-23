// Vendored from open-passport 0.1.0 (packages/js/src/core/merge.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Three-way merge of passports (SPEC.md §7): notes matched by `id` (else path), lines by `^f-`/`^r-` id (else by
// normalized text), frontmatter by key, prose by section. Merges never delete a note; conflicts keep ours and are
// reported for review. Taste reinforcement counts merge as counters: base + (ours - base) + (theirs - base).
import { formatTasteText, normText, parseLine, type Line } from './grammar'
import { byteOrder, MANIFEST, RENDERS_DIR, type AnyFiles } from './manifest'
import { parseFrontmatter, serializeFrontmatter, type FrontmatterEntry } from './note'

export interface MergeConflict {
  path: string
  kind: 'line' | 'frontmatter' | 'prose' | 'modify_delete' | 'file'
  /** line id, frontmatter key or section heading */
  key: string | null
  base: string | null
  ours: string | null
  theirs: string | null
}

export interface MergeStats {
  notesAdded: number
  linesAdded: number
  linesUpdated: number
  linesRemoved: number
  reinforced: number
  deduped: number
}

export interface MergeResult {
  files: AnyFiles
  conflicts: MergeConflict[]
  stats: MergeStats
}

const dec = new TextDecoder()
const asText = (v: string | Uint8Array | undefined): string | undefined => (v === undefined ? undefined : typeof v === 'string' ? v : dec.decode(v))
const sameBytes = (a: string | Uint8Array | undefined, b: string | Uint8Array | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b
  if (typeof a === 'string' && typeof b === 'string') return a === b
  const x = typeof a === 'string' ? new TextEncoder().encode(a) : a
  const y = typeof b === 'string' ? new TextEncoder().encode(b) : b
  return x.length === y.length && x.every((v, i) => v === y[i])
}
const isMeta = (p: string) => p === MANIFEST || p.startsWith(`${RENDERS_DIR}/`)
const noteKey = (path: string, text: string) => {
  const id = parseFrontmatter(text).entries.find((e) => e.key === 'id')?.value
  return typeof id === 'string' && id.trim() ? `id:${id.trim()}` : `path:${path}`
}

/** Merges `theirs` into `ours` against their common `base` (null = no common ancestor: a two-way union). */
export function merge3(base: AnyFiles | null, ours: AnyFiles, theirs: AnyFiles): MergeResult {
  const conflicts: MergeConflict[] = []
  const stats: MergeStats = { notesAdded: 0, linesAdded: 0, linesUpdated: 0, linesRemoved: 0, reinforced: 0, deduped: 0 }
  const out: AnyFiles = new Map()
  const index = (files: AnyFiles | null) => {
    const m = new Map<string, string>()
    if (!files) return m
    for (const [p, v] of files) if (!isMeta(p)) m.set(/\.md$/i.test(p) ? noteKey(p, asText(v)!) : `path:${p}`, p)
    return m
  }
  const bi = index(base)
  const oi = index(ours)
  const ti = index(theirs)
  for (const [p, v] of ours) if (!isMeta(p)) out.set(p, v)
  const keys = [...new Set([...oi.keys(), ...ti.keys()])].sort(byteOrder)
  for (const k of keys) {
    const op = oi.get(k)
    const tp = ti.get(k)
    const bp = bi.get(k)
    const B = bp !== undefined ? base!.get(bp) : undefined
    const O = op !== undefined ? ours.get(op) : undefined
    const T = tp !== undefined ? theirs.get(tp) : undefined
    if (O !== undefined && T === undefined) continue
    if (O === undefined && T !== undefined) {
      if (B !== undefined && sameBytes(B, T)) continue // ours deleted it, theirs did not touch it
      let path = tp!
      for (let i = 2; out.has(path); i++) path = tp!.replace(/(\.[^./]+)?$/, ` (${i})$1`)
      out.set(path, T)
      if (B !== undefined) conflicts.push({ path, kind: 'modify_delete', key: null, base: asText(B) ?? null, ours: null, theirs: asText(T) ?? null })
      else stats.notesAdded++
      continue
    }
    // both sides have it
    const path = op === bp && tp !== bp && tp !== undefined ? tp : op!
    if (path !== op) out.delete(op!)
    if (sameBytes(O, T) || sameBytes(B, T)) {
      out.set(path, O!)
      continue
    }
    if (sameBytes(B, O)) {
      out.set(path, T!)
      if (/\.md$/i.test(path)) countLineChanges(asText(B) ?? '', asText(T)!, stats)
      continue
    }
    if (!/\.md$/i.test(path)) {
      out.set(path, O!)
      conflicts.push({ path, kind: 'file', key: null, base: null, ours: null, theirs: null })
      continue
    }
    out.set(path, mergeNote(path, asText(B) ?? null, asText(O)!, asText(T)!, conflicts, stats))
  }
  return { files: out, conflicts, stats }
}

// ---------- one note ----------

interface BodyLine {
  raw: string
  section: string
  line: Line | null
  /** `id:<id>` for id'd lines, `t:<text key>` for other fact lines, null for structure and prose */
  key: string | null
}

function parseBody(body: string[]): BodyLine[] {
  let section = ''
  let fence = false
  return body.map((raw) => {
    if (/^ {0,3}(```|~~~)/.test(raw)) {
      fence = !fence
      return { raw, section, line: null, key: null }
    }
    if (!fence) {
      const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw)
      if (h) {
        if (h[1].length === 2) section = h[2].trim()
        return { raw, section, line: null, key: null }
      }
    }
    const line = fence ? null : parseLine(raw, section.toLowerCase() === 'history')
    return { raw, section, line, key: line ? lineKey(line) : null }
  })
}

function lineKey(l: Line): string {
  if (l.id) return `id:${l.id}`
  if (l.kind === 'observation') return `t:o:${l.category}:${normText(l.taste ? l.taste.statement : l.text)}`
  if (l.kind === 'relation') return `t:r:${l.rel.toLowerCase()}:${normText(l.target)}`
  return `t:h:${normText(l.text)}`
}
/** Text identity of a line, used to dedupe lines added on both sides under different ids. */
function textKey(l: Line): string {
  return lineKey({ ...l, id: null } as Line)
}

const isHistorySection = (s: string) => s.toLowerCase() === 'history'
const isHeading = (raw: string) => /^ {0,3}#{1,6}\s/.test(raw)

function splitNote(text: string): { fm: FrontmatterEntry[]; body: string[]; hasFm: boolean } {
  const f = parseFrontmatter(text)
  const body = f.body.split(/\r?\n/)
  if (body.length && body[body.length - 1] === '') body.pop()
  return { fm: f.entries, body, hasFm: f.present }
}

function countLineChanges(base: string, next: string, stats: MergeStats): void {
  const b = new Set(parseBody(splitNote(base).body).map((l) => l.raw))
  for (const l of parseBody(splitNote(next).body)) if (l.key && !b.has(l.raw)) stats.linesAdded++
}

function mergeFrontmatter(path: string, B: FrontmatterEntry[] | null, O: FrontmatterEntry[], T: FrontmatterEntry[], conflicts: MergeConflict[]): FrontmatterEntry[] {
  const get = (list: FrontmatterEntry[] | null, k: string) => list?.find((e) => e.key === k)
  const raw = (e: FrontmatterEntry | undefined) => (e ? e.raw.join('\n') : undefined)
  const out: FrontmatterEntry[] = []
  const keys = [...O.map((e) => e.key), ...T.map((e) => e.key).filter((k) => !O.some((e) => e.key === k))]
  for (const k of keys) {
    const b = get(B, k)
    const o = get(O, k)
    const t = get(T, k)
    if (!k) {
      if (o) out.push(o)
      continue
    }
    if (raw(o) === raw(t)) {
      if (o) out.push(o)
    } else if (raw(b) === raw(o)) {
      if (t) out.push(t)
    } else if (raw(b) === raw(t)) {
      if (o) out.push(o)
    } else if ((k === 'modified' || k === 'updated') && o && t) {
      out.push(String(o.value) >= String(t.value) ? o : t)
    } else {
      if (o) out.push(o)
      conflicts.push({ path, kind: 'frontmatter', key: k, base: raw(b) ?? null, ours: raw(o) ?? null, theirs: raw(t) ?? null })
    }
  }
  return out
}

/** Index after which a new line of `section` goes: after its last fact line, else after the heading (and a blank). */
function insertionPoint(res: BodyLine[], section: string): number {
  const want = section.toLowerCase()
  let head = -1
  let last = -1
  for (let i = 0; i < res.length; i++) {
    const l = res[i]
    if (isHeading(l.raw) && /^ {0,3}##\s/.test(l.raw) && l.section.toLowerCase() === want) head = i
    if (l.section.toLowerCase() === want && l.key) last = i
  }
  if (last >= 0) return last + 1
  if (head >= 0) return head + 1 + (res[head + 1] && !res[head + 1].raw.trim() ? 1 : 0)
  if (!want) {
    // the untitled top section: after the leading prose, before the first `##`
    const firstH2 = res.findIndex((l) => /^ {0,3}##\s/.test(l.raw))
    return firstH2 < 0 ? res.length : firstH2
  }
  return -1
}

function insertLine(res: BodyLine[], l: BodyLine): void {
  let at = insertionPoint(res, l.section)
  if (at < 0) {
    // a missing section is created before History (History stays last)
    const hist = res.findIndex((x) => /^ {0,3}##\s/.test(x.raw) && isHistorySection(x.section))
    const pos = hist >= 0 && !isHistorySection(l.section) ? hist : res.length
    const block: BodyLine[] = []
    if (pos > 0 && res[pos - 1].raw.trim()) block.push({ raw: '', section: res[pos - 1].section, line: null, key: null })
    block.push({ raw: `## ${l.section}`, section: l.section, line: null, key: null })
    res.splice(pos, 0, ...block, ...(pos < res.length ? [{ raw: '', section: l.section, line: null, key: null }] : []))
    at = pos + block.length
  }
  res.splice(at, 0, l)
}

const proseOf = (lines: BodyLine[], section: string) =>
  lines
    .filter((l) => l.section === section && !l.key && !isHeading(l.raw))
    .map((l) => l.raw)
    .join('\n')
    .trim()

function mergeNote(path: string, Btext: string | null, Otext: string, Ttext: string, conflicts: MergeConflict[], stats: MergeStats): string {
  const B = Btext !== null ? splitNote(Btext) : null
  const O = splitNote(Otext)
  const T = splitNote(Ttext)
  const fm = mergeFrontmatter(path, B?.fm ?? null, O.fm, T.fm, conflicts)
  const bl = B ? parseBody(B.body) : []
  const ol = parseBody(O.body)
  const tl = parseBody(T.body)
  const byKey = (ls: BodyLine[]) => new Map(ls.filter((l) => l.key).map((l) => [l.key!, l]))
  const bk = byKey(bl)
  const ok = byKey(ol)
  const tk = byKey(tl)
  const res: BodyLine[] = ol.map((l) => ({ ...l }))
  const ourText = new Map(ol.filter((l) => l.line).map((l) => [textKey(l.line!), l]))

  // prose, per section: one side changed it -> that side
  const sections = [...new Set([...ol.map((l) => l.section), ...tl.map((l) => l.section)])]
  for (const s of sections) {
    const b = proseOf(bl, s)
    const o = proseOf(ol, s)
    const t = proseOf(tl, s)
    if (o === t || b === t) continue
    if (b === o && ol.some((l) => l.section === s)) {
      const theirs = tl.filter((l) => l.section === s && !l.key && !isHeading(l.raw))
      const first = res.findIndex((l) => l.section === s && !l.key && !isHeading(l.raw))
      const keep = res.filter((l) => !(l.section === s && !l.key && !isHeading(l.raw)))
      const at = first < 0 ? keep.length : res.slice(0, first).filter((l) => !(l.section === s && !l.key && !isHeading(l.raw))).length
      keep.splice(at, 0, ...theirs.map((l) => ({ ...l })))
      res.splice(0, res.length, ...keep)
    } else if (b !== o) conflicts.push({ path, kind: 'prose', key: s || '(top)', base: b, ours: o, theirs: t })
  }

  const find = (key: string) => res.findIndex((l) => l.key === key)
  // lines both sides have, or ours has
  for (const o of ol) {
    if (!o.key) continue
    const b = bk.get(o.key)
    const t = tk.get(o.key)
    const i = find(o.key)
    if (i < 0) continue
    if (!t) {
      if (b && b.raw === o.raw) {
        res.splice(i, 1)
        stats.linesRemoved++
      } else if (b) conflicts.push({ path, kind: 'modify_delete', key: o.key.slice(3), base: b.raw, ours: o.raw, theirs: null })
      continue
    }
    if (t.raw === o.raw) continue
    if (b && b.raw === t.raw) continue
    if (b && b.raw === o.raw) {
      place(res, i, t)
      stats.linesUpdated++
      continue
    }
    const counted = reinforce(b?.line ?? null, o.line, t.line)
    if (counted !== null) {
      res[i] = { ...res[i], raw: counted, line: parseLine(counted, isHistorySection(res[i].section)) }
      stats.reinforced++
      continue
    }
    conflicts.push({ path, kind: 'line', key: o.key.startsWith('id:') ? o.key.slice(3) : o.key, base: b?.raw ?? null, ours: o.raw, theirs: t.raw })
  }
  // lines only theirs has, in their order
  for (const t of tl) {
    if (!t.key || ok.has(t.key)) continue
    const b = bk.get(t.key)
    if (b) {
      if (b.raw === t.raw) continue // ours removed it
      conflicts.push({ path, kind: 'modify_delete', key: t.key.slice(3), base: b.raw, ours: null, theirs: t.raw })
      insertLine(res, { ...t })
      continue
    }
    const twin = t.line ? ourText.get(textKey(t.line)) : undefined
    if (twin) {
      // added on both sides under different ids: one line; taste counts add up
      const i = res.indexOf(res.find((l) => l.key === twin.key)!)
      const o = twin.line
      if (i >= 0 && o?.kind === 'observation' && o.taste && t.line?.kind === 'observation' && t.line.taste) {
        const raw = withCount(o, o.taste.count + t.line.taste.count)
        res[i] = { ...res[i], raw, line: parseLine(raw) }
        stats.reinforced++
      } else stats.deduped++
      continue
    }
    insertLine(res, { ...t })
    stats.linesAdded++
  }
  const body = res.map((l) => l.raw).join('\n')
  const fmText = O.hasFm || T.hasFm ? serializeFrontmatter(fm) : ''
  return `${fmText}${body}\n`
}

/** Replaces ours with theirs at `i`; a line that changed state (live <-> History) moves to its new section. */
function place(res: BodyLine[], i: number, t: BodyLine): void {
  const wasHistory = isHistorySection(res[i].section)
  const nowHistory = isHistorySection(t.section)
  if (wasHistory === nowHistory) {
    res[i] = { ...res[i], raw: t.raw, line: t.line }
    return
  }
  res.splice(i, 1)
  insertLine(res, { ...t })
}

function withCount(o: Extract<Line, { kind: 'observation' }>, count: number): string {
  const text = formatTasteText({ statement: o.taste!.statement, examples: o.taste!.examples, count }, trailingTags(o.text))
  return rebuild(o, text)
}

function trailingTags(text: string): string[] {
  const m = /(\s+#[A-Za-z0-9_/-]+)+$/.exec(text)
  return m ? m[0].trim().split(/\s+/).map((t) => t.slice(1)) : []
}

function rebuild(o: Extract<Line, { kind: 'observation' }>, text: string): string {
  const head = /^(\s*[-*+][ \t]+\[[^\]]+\][ \t]+)/.exec(o.raw)?.[1] ?? `- [${o.category}] `
  const tail = o.raw.slice(o.raw.indexOf(o.text) + o.text.length)
  return `${head}${text}${tail}`
}

/**
 * Taste lines that differ only in their count merge as counters. Examples are unioned (ours first). Returns the
 * merged raw line, or null when the lines differ in anything else.
 */
function reinforce(b: Line | null, o: Line | null, t: Line | null): string | null {
  if (o?.kind !== 'observation' || t?.kind !== 'observation' || !o.taste || !t.taste) return null
  if (o.category !== t.category || normText(o.taste.statement) !== normText(t.taste.statement)) return null
  const bc = b?.kind === 'observation' && b.taste ? b.taste.count : 1
  const count = Math.max(1, bc + (o.taste.count - bc) + (t.taste.count - bc))
  const examples = [...o.taste.examples, ...t.taste.examples.filter((e) => !o.taste!.examples.includes(e))].slice(0, 5)
  return rebuild(o, formatTasteText({ statement: o.taste.statement, examples, count }, trailingTags(o.text)))
}
