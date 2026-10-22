// Vendored from open-passport 0.1.0 (packages/js/src/core/grammar.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Open Passport line grammar (SPEC.md §4). Pure TypeScript: no node imports, no dependencies.
//
//   observation  - [category] text #tags (provenance) ^f-<id>
//   taste        - [likes|dislikes|prefers|avoid] statement (x<count>; example: [[Note]]; "quote") #tags (provenance) ^f-<id>
//   relation     - rel_type [[Target]] (context)? (provenance)? ^r-<id>
//   history      - [superseded] text (by ^f-<id>; provenance) ^f-<id>
//                - [invalidated] text (reason: why; provenance) ^f-<id>
//   provenance   (actor[ via suggestion <id>][ run#<id>| session#<id>], YYYY-MM-DD)

export const TASTE_POLARITIES = ['likes', 'dislikes', 'prefers', 'avoid'] as const
export type Polarity = (typeof TASTE_POLARITIES)[number]

/** Categories that rank first on the company card (SPEC.md §6.3). */
export const CARD_CATEGORIES = ['mission', 'audience', 'brand', 'product', 'goal', 'context', 'constraint'] as const
/** Charter categories on a department note (SPEC.md §3.4). */
export const CHARTER_CATEGORIES = ['does', 'does-not'] as const
export const HISTORY_STATES = ['superseded', 'invalidated'] as const
export type HistoryState = (typeof HISTORY_STATES)[number]

export const LINE_ID_RE = /^[fr]-[0-9a-z]{10}$/
const ACTOR = '[a-z][a-z0-9_-]{0,31}'
const PROV_BODY = `(${ACTOR})(?: via suggestion ([A-Za-z0-9_-]+))?(?: run#([A-Za-z0-9_-]+))?(?: session#([A-Za-z0-9_-]+))?, (\\d{4}-\\d{2}-\\d{2})`
const PROV_BODY_RE = new RegExp(`^${PROV_BODY}$`)
const PROV_TAIL_RE = new RegExp(`\\s\\(${PROV_BODY}\\)$`)
const ANCHOR_TAIL_RE = /\s\^([A-Za-z0-9-]+)\s*$/
const BULLET_RE = /^(\s*)[-*+][ \t]+/
const TASK_RE = /^\s*[-*+][ \t]+\[.\](?:\s|$)/
const CATEGORY_RE = /^\[([^[\]()]{2,}?)\][ \t]+(?=\S)/
const REL_RE = /^("([^"\n]+)"|[A-Za-z][A-Za-z0-9_-]*)[ \t]+\[\[([^[\]\n]+?)\]\](?:\s+\(([^()]*)\))?$/
const TAG_RE = /(^|[\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g
const WIKILINK_RE = /!?\[\[([^[\]\n]+?)\]\]/g

export interface Provenance {
  actor: string
  via: string | null
  run: string | null
  session: string | null
  date: string
}

export interface Taste {
  polarity: Polarity
  /** the statement without the taste meta and tags */
  statement: string
  /** `[[Note]]` targets and `"quotes"`, as written */
  examples: string[]
  /** reinforcements; 1 when absent */
  count: number
}

interface LineBase {
  /** `f-…` / `r-…` without the caret, or null */
  id: string | null
  prov: Provenance | null
  /** the line as written */
  raw: string
}
export interface ObservationLine extends LineBase {
  kind: 'observation'
  category: string
  /** text between category and provenance, tags included */
  text: string
  tags: string[]
  taste: Taste | null
}
export interface RelationLine extends LineBase {
  kind: 'relation'
  rel: string
  target: string
  context: string | null
}
export interface HistoryLine extends LineBase {
  kind: 'history'
  state: HistoryState
  text: string
  supersededBy: string | null
  reason: string | null
}
export type Line = ObservationLine | RelationLine | HistoryLine

// ---------- provenance ----------

export function parseProvenance(s: string): Provenance | null {
  const m = PROV_BODY_RE.exec(s.trim())
  return m ? { actor: m[1], via: m[2] ?? null, run: m[3] ?? null, session: m[4] ?? null, date: m[5] } : null
}

export function formatProvenance(p: Provenance): string {
  let s = p.actor
  if (p.via) s += ` via suggestion ${p.via}`
  if (p.run) s += ` run#${p.run}`
  else if (p.session) s += ` session#${p.session}`
  return `(${s}, ${p.date})`
}

// ---------- links and tags ----------

/** `[[Target#h|alias]]` -> `Target`. */
export function linkTarget(inner: string): string {
  return inner.split(/\\?\|/)[0].split('#')[0].trim()
}

/** Every `[[link]]` target in a text. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(WIKILINK_RE)].map((m) => linkTarget(m[1])).filter(Boolean)
}

export function tagsIn(text: string): string[] {
  const src = text.replace(WIKILINK_RE, (m) => ' '.repeat(m.length)).replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
  return [...src.matchAll(TAG_RE)].map((m) => m[2].replace(/\/+$/, '').toLowerCase())
}

/** Plain text for renders: links become their display text, tags and code ticks go, whitespace collapses. */
export function plainText(text: string): string {
  return text
    .replace(WIKILINK_RE, (_m, inner: string) => {
      const parts = inner.split(/\\?\|/)
      return (parts[1] ?? linkTarget(inner)).trim()
    })
    .replace(TAG_RE, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .trim()
}

// ---------- taste ----------

export function isPolarity(s: string): s is Polarity {
  return (TASTE_POLARITIES as readonly string[]).includes(s)
}

const TASTE_META_RE = /\s\((?:x(\d+)(?:;\s*|$))?(?:example:\s*(.*?))?\)$/

/** Splits a taste observation's text into statement, examples and count. */
export function parseTaste(polarity: Polarity, text: string): Taste {
  let core = text
  const trailingTags = /(\s+#[A-Za-z0-9_/-]+)+$/.exec(core)
  if (trailingTags) core = core.slice(0, trailingTags.index)
  let count = 1
  let examples: string[] = []
  const m = TASTE_META_RE.exec(core)
  if (m && (m[1] || m[2] !== undefined)) {
    count = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1
    examples = (m[2] ?? '')
      .split(/;\s*/)
      .map((e) => e.trim())
      .filter(Boolean)
    core = core.slice(0, m.index)
  }
  return { polarity, statement: core.trim(), examples, count }
}

export function formatTasteText(t: Pick<Taste, 'statement' | 'examples' | 'count'>, tags: string[] = []): string {
  const meta: string[] = []
  if (t.count > 1) meta.push(`x${t.count}`)
  if (t.examples.length) meta.push(`example: ${t.examples.join('; ')}`)
  let s = cleanText(t.statement)
  if (meta.length) s += ` (${meta.join('; ')})`
  for (const tag of tags) if (!tagsIn(s).includes(tag.toLowerCase())) s += ` #${tag}`
  return s
}

/** A quoted example: inner `"` become `'`, newlines collapse, at most 200 chars. */
export function quoteExample(q: string): string {
  const t = q.replace(/["\r\n]+/g, (c) => (c === '"' ? "'" : ' ')).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  return `"${t.length > 200 ? `${t.slice(0, 199)}…` : t}"`
}

// ---------- lines ----------

export function cleanText(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

/** True for a bullet that is a task checkbox (`- [ ]`, `- [x]`). Never an observation. */
export function isTaskLine(line: string): boolean {
  return TASK_RE.test(line)
}

function stripTail(body: string): { core: string; id: string | null; prov: Provenance | null } {
  let core = body
  let id: string | null = null
  const a = ANCHOR_TAIL_RE.exec(core)
  if (a) {
    if (LINE_ID_RE.test(a[1])) id = a[1]
    core = core.slice(0, a.index)
  }
  core = core.replace(/\s+$/, '')
  let prov: Provenance | null = null
  const p = PROV_TAIL_RE.exec(core)
  if (p) {
    prov = { actor: p[1], via: p[2] ?? null, run: p[3] ?? null, session: p[4] ?? null, date: p[5] }
    core = core.slice(0, p.index).replace(/\s+$/, '')
  }
  return { core, id, prov }
}

/**
 * Classifies one line. `inHistory` is true under a `## History` heading. Returns null for prose, headings,
 * task checkboxes, link-list items and bullets that are neither observations nor relations.
 */
export function parseLine(raw: string, inHistory = false): Line | null {
  const bm = BULLET_RE.exec(raw)
  if (!bm || isTaskLine(raw)) return null
  const body = raw.slice(bm[0].length)
  if (/^!?\[[^\]]*\]\(/.test(body)) return null
  const { core, id, prov } = stripTail(body)
  const cat = CATEGORY_RE.exec(core)
  if (cat) {
    const category = cat[1].trim().toLowerCase()
    const text = core.slice(cat[0].length).trim()
    if (inHistory && (HISTORY_STATES as readonly string[]).includes(category)) return parseHistory(category as HistoryState, text, id, prov, raw)
    const taste = isPolarity(category) ? parseTaste(category, text) : null
    return { kind: 'observation', category, text, tags: tagsIn(text), taste, id, prov, raw }
  }
  const r = REL_RE.exec(core)
  if (r) return { kind: 'relation', rel: (r[2] ?? r[1]).trim(), target: linkTarget(r[3]), context: r[4]?.trim() || null, id, prov, raw }
  return null
}

function parseHistory(state: HistoryState, rest: string, id: string | null, prov: Provenance | null, raw: string): HistoryLine {
  let text = rest
  let supersededBy: string | null = null
  let reason: string | null = null
  const d = /\s\(([^()]*)\)$/.exec(text)
  if (d) {
    let detail = d[1]
    const cut = detail.lastIndexOf('; ')
    if (cut >= 0) {
      const p = parseProvenance(detail.slice(cut + 2))
      if (p) {
        prov = p
        detail = detail.slice(0, cut)
      }
    }
    const by = /^by \^([fr]-[0-9a-z]{10})$/.exec(detail)
    if (by) supersededBy = by[1]
    else if (detail.startsWith('reason: ')) reason = detail.slice(8).trim()
    if (by || reason !== null) text = text.slice(0, d.index).trimEnd()
  }
  return { kind: 'history', state, text, supersededBy, reason, id, prov, raw }
}

export interface ObservationInput {
  category: string
  text: string
  prov?: Provenance | null
  id?: string | null
}

export function formatObservation(o: ObservationInput): string {
  let line = `- [${o.category.replace(/[[\]()]/g, '').trim()}] ${cleanText(o.text)}`
  if (o.prov) line += ` ${formatProvenance(o.prov)}`
  if (o.id) line += ` ^${o.id}`
  return line
}

export function formatRelation(r: { rel: string; target: string; context?: string | null; prov?: Provenance | null; id?: string | null }): string {
  const rel = /^[A-Za-z][A-Za-z0-9_-]*$/.test(r.rel) ? r.rel : `"${r.rel.replace(/"/g, "'")}"`
  let line = `- ${rel} [[${r.target}]]`
  if (r.context) line += ` (${r.context.replace(/[()]/g, '')})`
  if (r.prov) line += ` ${formatProvenance(r.prov)}`
  if (r.id) line += ` ^${r.id}`
  return line
}

export function formatHistory(h: { state: HistoryState; text: string; supersededBy?: string | null; reason?: string | null; prov?: Provenance | null; id?: string | null }): string {
  const detail: string[] = []
  if (h.state === 'superseded' && h.supersededBy) detail.push(`by ^${h.supersededBy}`)
  if (h.state === 'invalidated' && h.reason) detail.push(`reason: ${cleanText(h.reason.replace(/[()]/g, ' '))}`)
  if (h.prov) detail.push(formatProvenance(h.prov).slice(1, -1))
  let line = `- [${h.state}] ${cleanText(h.text)}`
  if (detail.length) line += ` (${detail.join('; ')})`
  if (h.id) line += ` ^${h.id}`
  return line
}

/** Normalized identity of a statement: NFKC, lowercase, links/tags/punctuation runs flattened. */
export function normText(s: string): string {
  return plainText(s).normalize('NFKC').toLowerCase().replace(/[“”"'`]/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim()
}

/** SPEC.md §6.4: every ordering compares strings by Unicode code point (never locale collation). */
export function cpCompare(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d) return d < 0 ? -1 : 1
  }
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0
}

// ---------- ids ----------

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
/** A fresh `f-`/`r-` line id from a random source (defaults to crypto.getRandomValues). */
export function newLineId(kind: 'f' | 'r', random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  let s = ''
  for (const b of random(10)) s += B36[b % 36]
  return `${kind}-${s}`
}
