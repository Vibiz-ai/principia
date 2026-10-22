// Vendored from open-passport 0.1.0 (packages/js/src/core/importers.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Importers (SPEC.md §8.5): "go where people already are". Turn what a company already has (a ChatGPT or Claude data
// export, a Notion / Obsidian / markdown folder, its website, pasted text) into candidate facts and taste, filed as
// proposals for a person to review: never written silently. Deterministic heuristics only (pure, no network): a
// sentence becomes a candidate when it states something lasting about the business in the first person ("we sell",
// "our customers are", "we never …") or comes from a place people state such things (custom instructions, saved
// memories, an About page). Everything is budgeted, deduplicated, screened (§10) and ranked.
import { cleanText, formatTasteText, normText, parseTaste, quoteExample, type Polarity } from './grammar'
import { newProposalId, type LocalProposal } from './proposals'
import { credentialHit, executableHit, imperativeHit } from './screen'

export type ImportKind = 'chatgpt' | 'claude' | 'folder' | 'url' | 'text'

export interface ImportCandidate {
  kind: 'fact' | 'taste'
  /** the note it belongs on; null = the company card */
  note: string | null
  noteType: string | null
  /** fact category (`fact`, `mission`, `audience`, `product`, `price`, `metric`, `decision`, `role`, `context`, `goal`) */
  category: string
  /** the fact, or the taste statement */
  text: string
  polarity?: Polarity
  /** the source sentence (taste example and review evidence) */
  quote: string
  /** where it came from, e.g. `ChatGPT: "Pricing page rewrite"` */
  from: string
  score: number
}

export interface ImportBudget {
  /** most candidates kept (highest score first) */
  maxCandidates: number
  /** most messages / documents read (newest first) */
  maxMessages: number
  /** characters read per message or document */
  maxCharsPerMessage: number
  /** characters read in total */
  maxTotalChars: number
}
export const DEFAULT_IMPORT_BUDGET: ImportBudget = { maxCandidates: 40, maxMessages: 4000, maxCharsPerMessage: 4000, maxTotalChars: 3_000_000 }

export interface ImportResult {
  kind: ImportKind
  candidates: ImportCandidate[]
  stats: { documents: number; chars: number; sentences: number; candidatesBeforeBudget: number; dropped: number }
  /** a person's name when the export carries one (the owner); never an email */
  owner: string | null
  /** the company name when the source names it (website) */
  company: string | null
  /** the highest-signal text read (instructions, memories, About pages first), for an optional model pass */
  sample: string
}

// ---------- sentence heuristics ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const trimClause = (s: string) =>
  s
    .replace(/^(that|to|the fact that)\s+/i, '')
    .replace(/[\s,;:–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const SKIP = [
  /\?\s*$/,
  /^(can|could|would|will|should|shall|do|does|did|is|are|what|how|why|when|where|which|who)\b/i,
  /\b(if we|what if|suppose|imagine|pretend|hypothetical|for example|e\.g\.|let's say)\b/i,
  /^(write|draft|create|generate|make|give|tell|show|explain|summari[sz]e|translate|rewrite|list|help|fix|debug|find|act as|you are)\b/i,
  /```|<\/?[a-z]+>|https?:\/\/\S+$/i
]

/** Splits prose into candidate sentences (code blocks and quoted replies removed). */
export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .split(/(?<=[.!?])\s+|\n+|(?<=;)\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 320)
}

interface Rule {
  re: RegExp
  kind: 'fact' | 'taste'
  category?: string
  polarity?: Polarity
  /** statement from the match (taste) */
  pick?: (m: RegExpExecArray) => string
  weight: number
}

const WE = String.raw`(?:we|we've|we're|i|i've|i'm|our team|the team|our company|my company)`
const RULES: Rule[] = [
  // taste: what people like and dislike
  { re: new RegExp(String.raw`\b${WE}\s+(?:really\s+|strongly\s+)?(?:love|like|enjoy|appreciate)\s+(.{4,140})`, 'i'), kind: 'taste', polarity: 'likes', pick: (m) => m[1], weight: 0.55 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:really\s+)?(?:hate|dislike|can't stand|cannot stand|don't like|do not like)\s+(.{4,140})`, 'i'), kind: 'taste', polarity: 'dislikes', pick: (m) => m[1], weight: 0.6 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:always\s+|generally\s+|strongly\s+)?prefers?\s+(.{4,140})`, 'i'), kind: 'taste', polarity: 'prefers', pick: (m) => m[1], weight: 0.6 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:never|don't ever|do not ever|refuse to|avoid)\s+(.{4,140})`, 'i'), kind: 'taste', polarity: 'avoid', pick: (m) => m[1], weight: 0.6 },
  { re: /^(?:please\s+)?(?:don't|do not|never)\s+(?:use|add|include|write)\s+(.{3,120})/i, kind: 'taste', polarity: 'dislikes', pick: (m) => m[1], weight: 0.5 },
  { re: /^(?:please\s+)?(?:always\s+)?(?:keep|make)\s+(?:it|things|copy|responses|answers|emails|replies|text)\s+((?:short|concise|brief|plain|simple|casual|formal|direct|friendly|warm|calm)\b.{0,100})/i, kind: 'taste', polarity: 'likes', pick: (m) => `${m[1]} writing`, weight: 0.5 },
  { re: /\b(?:our|the|my)\s+(?:tone|voice|brand voice|writing style)\s+(?:is|should be|must be)\s+(.{3,120})/i, kind: 'taste', polarity: 'likes', pick: (m) => `A ${m[1]} tone`, weight: 0.6 },
  { re: /^(?:please\s+)?(?:always\s+)?avoid\s+(.{4,120})/i, kind: 'taste', polarity: 'avoid', pick: (m) => m[1], weight: 0.45 },
  // facts: what the company is
  { re: /\b(?:our|my|the company's)\s+mission\s+is\s+(?:to\s+)?/i, kind: 'fact', category: 'mission', weight: 0.75 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:sell|build|make|offer|run|develop|design|ship|provide|help)\b`, 'i'), kind: 'fact', category: 'product', weight: 0.6 },
  { re: /\b(?:our|my)\s+(?:customers|clients|users|audience|target (?:market|audience|customers)|ideal customers?|buyers)\s+(?:are|is|include|tend to be)\b/i, kind: 'fact', category: 'audience', weight: 0.7 },
  { re: /\b(?:i am|i'm)\s+(?:the\s+|a\s+|an\s+)?(?:co-?founder|founder|ceo|cto|coo|cfo|owner|head of \w+|vp of \w+|director of \w+|product manager|lead \w+)\b/i, kind: 'fact', category: 'role', weight: 0.7 },
  { re: /(?:\$|€|£)\s?\d[\d,.]*\s*(?:k\b)?\s*(?:\/|per|a)\s*(?:month|mo|year|yr|seat|user|license)\b/i, kind: 'fact', category: 'price', weight: 0.6 },
  { re: /\b(?:we have|we've got|we hit|we reached|we crossed|our (?:mrr|arr|revenue|run rate|churn|nps))\b[^.]*\d/i, kind: 'fact', category: 'metric', weight: 0.55 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:decided|chose|picked|switched to|moved to|are moving to|standardi[sz]ed on)\b`, 'i'), kind: 'fact', category: 'decision', weight: 0.65 },
  { re: /\bwe use\s+[A-Z0-9][\w.+#-]*(?:\s+(?:for|to|as)\s+.{3,100})?/, kind: 'fact', category: 'fact', weight: 0.5 },
  { re: new RegExp(String.raw`\b${WE}\s+(?:are\s+|is\s+)?(?:based|headquartered|located)\s+in\b`, 'i'), kind: 'fact', category: 'context', weight: 0.55 },
  { re: /\b(?:we are|we're)\s+(?:a\s+)?(?:team of\s+\d+|\d+\s+people|bootstrapped|venture[- ]backed|profitable|pre-?seed|seed[- ]stage|series [a-d])\b/i, kind: 'fact', category: 'context', weight: 0.6 },
  { re: /\bour\s+(?:main\s+)?competitors?\s+(?:are|is|include)\b/i, kind: 'fact', category: 'context', weight: 0.55 },
  { re: /\b(?:our|my)\s+(?:goal|north star|focus)\s+(?:is|this (?:year|quarter|month) is|for 20\d\d is)\b/i, kind: 'fact', category: 'goal', weight: 0.6 }
]

/** Third-person memory statements ("User runs a design studio…", ChatGPT memories, Claude memory). */
const MEMORY_SUBJECT = /^(?:the\s+)?user(?:'s)?\b/i
const MEMORY_TASTE: [RegExp, Polarity][] = [
  [/\b(?:prefers|wants)\b/i, 'prefers'],
  [/\b(?:likes|loves|enjoys)\b/i, 'likes'],
  [/\b(?:dislikes|hates|doesn't like|does not like)\b/i, 'dislikes'],
  [/\b(?:avoids|never wants|does not want|doesn't want)\b/i, 'avoid']
]
const CATEGORY_HINTS: [RegExp, string][] = [
  [/\bmission\b/i, 'mission'],
  [/\b(?:customers?|clients?|audience|users are)\b/i, 'audience'],
  [/\b(?:founder|ceo|cto|owner|head of|works as|role)\b/i, 'role'],
  [/(?:\$|€|£)\s?\d|\bpric(?:e|ing)\b/i, 'price'],
  [/\b(?:sells?|builds?|product|startup|company|business|agency|studio|saas|app)\b/i, 'product'],
  [/\bgoal\b/i, 'goal']
]

function screened(s: string): boolean {
  return !credentialHit(s) && !executableHit(s) && !imperativeHit(s) && !/\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(s) && !/\+?\d[\d\s().-]{8,}\d/.test(s)
}

/** Candidates from first-person prose. `weight` scales the score for where the text came from. */
export function extractFromProse(text: string, from: string, weight = 1, opts: { firstPersonOnly?: boolean } = {}): ImportCandidate[] {
  const out: ImportCandidate[] = []
  for (const s of sentences(text)) {
    if (SKIP.some((re) => re.test(s)) || !screened(s)) continue
    // one taste and one fact at most per sentence ("We charge $29 a month and never offer lifetime deals")
    const got = new Set<string>()
    const body = s.replace(/[.!]+$/, '')
    for (const r of RULES) {
      if (got.has(r.kind)) continue
      const m = r.re.exec(body)
      if (!m) continue
      if (opts.firstPersonOnly && r.kind === 'fact' && !/\b(we|we're|we've|our|i|i'm|i've|my)\b/i.test(s)) continue
      const quote = cleanText(s).slice(0, 280)
      if (r.kind === 'taste') {
        const stmt = cap(trimClause(r.pick!(m)).replace(/[.!]+$/, '').replace(/;/g, ','))
        if (stmt.length < 4 || stmt.split(' ').length > 18) continue
        out.push({ kind: 'taste', note: null, noteType: null, category: r.polarity!, polarity: r.polarity, text: stmt.slice(0, 120), quote, from, score: Math.min(0.95, r.weight * weight) })
      } else {
        out.push({ kind: 'fact', note: null, noteType: null, category: r.category!, text: cap(quote.replace(/[.!]+$/, '')), quote, from, score: Math.min(0.95, r.weight * weight) })
      }
      got.add(r.kind)
    }
  }
  return out
}

/** Candidates from third-person memory statements (high signal: the assistant already decided they were lasting). */
export function extractFromMemory(text: string, from: string, owner: string | null): ImportCandidate[] {
  const out: ImportCandidate[] = []
  for (const raw of sentences(text)) {
    if (!screened(raw)) continue
    const s = raw.replace(MEMORY_SUBJECT, owner ?? 'The owner')
    const pred = raw.replace(MEMORY_SUBJECT, '')
    const quote = cleanText(raw).slice(0, 280)
    const taste = MEMORY_TASTE.find(([re]) => re.test(pred))
    if (taste) {
      const after = pred.split(taste[0])[1] ?? ''
      const stmt = cap(trimClause(after.replace(/^\s*(?:to\s+)?/, '')).replace(/[.!]+$/, '').replace(/;/g, ','))
      if (stmt.length >= 4 && stmt.split(' ').length <= 18) {
        out.push({ kind: 'taste', note: null, noteType: null, category: taste[1], polarity: taste[1], text: stmt.slice(0, 120), quote, from, score: 0.8 })
        continue
      }
    }
    const category = CATEGORY_HINTS.find(([re]) => re.test(pred))?.[1]
    if (!category) continue
    out.push({ kind: 'fact', note: null, noteType: null, category, text: cap(cleanText(s).replace(/[.!]+$/, '')).slice(0, 280), quote, from, score: 0.8 })
  }
  return out
}

/** Merges duplicates (same kind and normalized text: the score rises with each sighting), ranks, applies the budget. */
export function rankCandidates(all: ImportCandidate[], budget: ImportBudget): { kept: ImportCandidate[]; before: number } {
  const byKey = new Map<string, ImportCandidate & { seen: number }>()
  for (const c of all) {
    const k = `${c.kind}\u0000${c.polarity ?? c.category}\u0000${c.note ?? ''}\u0000${normText(c.text)}`
    const prev = byKey.get(k)
    if (prev) {
      prev.seen++
      prev.score = Math.min(0.97, Math.max(prev.score, c.score) + 0.05)
    } else byKey.set(k, { ...c, seen: 1 })
  }
  const list = [...byKey.values()].sort((a, b) => b.score - a.score || b.seen - a.seen || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
  return { kept: list.slice(0, budget.maxCandidates).map(({ seen: _s, ...c }) => ({ ...c, score: Math.round(c.score * 100) / 100 })), before: list.length }
}

// ---------- sources ----------

interface Doc {
  text: string
  from: string
  /** sort key, newest first */
  at: number
  memory?: boolean
  weight?: number
}

function finish(kind: ImportKind, docs: Doc[], budget: ImportBudget, owner: string | null, company: string | null, extra: ImportCandidate[] = []): ImportResult {
  let chars = 0
  let n = 0
  let sentencesSeen = 0
  const all: ImportCandidate[] = [...extra]
  let sample = ''
  for (const d of [...docs].sort((a, b) => b.at - a.at)) {
    if (n >= budget.maxMessages || chars >= budget.maxTotalChars) break
    const text = d.text.slice(0, budget.maxCharsPerMessage)
    chars += text.length
    n++
    sentencesSeen += sentences(text).length
    if (sample.length < 24_000) sample += `${text.slice(0, 24_000 - sample.length)}\n`
    all.push(...(d.memory ? extractFromMemory(text, d.from, owner) : extractFromProse(text, d.from, d.weight ?? 1, { firstPersonOnly: kind === 'chatgpt' || kind === 'claude' })))
  }
  // role facts about the owner belong on their person note when the export names them
  if (owner) for (const c of all) if (c.kind === 'fact' && c.category === 'role') Object.assign(c, { note: owner, noteType: 'person' })
  const { kept, before } = rankCandidates(all, budget)
  return { kind, candidates: kept, stats: { documents: n, chars, sentences: sentencesSeen, candidatesBeforeBudget: before, dropped: Math.max(0, before - kept.length) }, owner, company, sample }
}

const parseJson = (s: string | undefined): unknown => {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const fileNamed = (files: Map<string, string>, re: RegExp) => [...files.keys()].find((k) => re.test(k.split('/').pop() ?? ''))
const textOfParts = (parts: unknown): string => (Array.isArray(parts) ? parts.map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('\n') : '')

/** Every string leaf of a JSON value (memory files whose shape is not documented). */
function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 2000) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out, depth + 1)
  return out
}

/** Which kind of export a set of files is. */
export function detectExport(files: Map<string, string>): ImportKind {
  const conv = fileNamed(files, /^conversations\.json$/)
  if (conv) {
    const head = files.get(conv)!.slice(0, 20_000)
    if (/"mapping"\s*:/.test(head)) return 'chatgpt'
    if (/"chat_messages"\s*:/.test(head)) return 'claude'
  }
  return 'folder'
}

/**
 * ChatGPT data export (Settings → Data controls → Export data): `conversations.json` (each conversation a `mapping` of
 * message nodes). Reads the user's own messages, the custom instructions ("About you" / "How should ChatGPT respond":
 * `user_editable_context` messages) and saved memories (assistant messages to the `bio` tool), plus any memories file.
 */
export function importChatGPTExport(files: Map<string, string>, budget: ImportBudget = DEFAULT_IMPORT_BUDGET): ImportResult {
  const docs: Doc[] = []
  const convs = parseJson(files.get(fileNamed(files, /^conversations\.json$/) ?? '')) as unknown[] | null
  for (const c of Array.isArray(convs) ? convs : []) {
    const conv = c as { title?: string; update_time?: number; create_time?: number; mapping?: Record<string, { message?: Record<string, unknown> | null }> }
    const title = String(conv.title ?? 'untitled').slice(0, 80)
    for (const node of Object.values(conv.mapping ?? {})) {
      const msg = node?.message as { author?: { role?: string; name?: string }; content?: Record<string, unknown>; create_time?: number; recipient?: string } | null | undefined
      if (!msg?.content) continue
      const at = Number(msg.create_time ?? conv.update_time ?? conv.create_time ?? 0)
      const ct = String(msg.content.content_type ?? '')
      if (ct === 'user_editable_context') {
        for (const k of ['user_profile', 'user_instructions'] as const) {
          const t = msg.content[k]
          if (typeof t === 'string' && t.trim()) docs.push({ text: t.replace(/^The user provided the following information about themselves[^:]*:/i, '').replace(/^The user provided the additional info about how they would like you to respond:/i, ''), from: k === 'user_profile' ? 'ChatGPT custom instructions (about you)' : 'ChatGPT custom instructions (how to respond)', at: Number.MAX_SAFE_INTEGER, weight: 1.35 })
        }
        continue
      }
      if (msg.recipient === 'bio' || msg.author?.name === 'bio') {
        const t = textOfParts(msg.content.parts) || String(msg.content.text ?? '')
        if (t.trim()) docs.push({ text: t, from: 'ChatGPT memory', at: Number.MAX_SAFE_INTEGER - 1, memory: true })
        continue
      }
      if (msg.author?.role !== 'user' || (ct && ct !== 'text' && ct !== 'multimodal_text')) continue
      const t = textOfParts(msg.content.parts)
      if (t.trim()) docs.push({ text: t, from: `ChatGPT: "${title}"`, at })
    }
  }
  const mem = fileNamed(files, /^(memories|memory|saved_memories)\.(json|txt|md)$/i)
  if (mem) {
    const raw = files.get(mem)!
    const parsed = parseJson(raw)
    docs.push({ text: parsed ? stringLeaves(parsed).join('\n') : raw, from: 'ChatGPT memory', at: Number.MAX_SAFE_INTEGER - 1, memory: true })
  }
  return finish('chatgpt', docs, budget, null, null)
}

/**
 * Claude data export (Settings → Privacy → Export data): `conversations.json` (`chat_messages` with `sender`),
 * `projects.json` (project descriptions, instructions and docs), `users.json` (the owner's name) and any memories file.
 */
export function importClaudeExport(files: Map<string, string>, budget: ImportBudget = DEFAULT_IMPORT_BUDGET): ImportResult {
  const docs: Doc[] = []
  const users = parseJson(files.get(fileNamed(files, /^users\.json$/) ?? '')) as { full_name?: string }[] | null
  const owner = Array.isArray(users) && typeof users[0]?.full_name === 'string' && users[0].full_name.trim() ? cleanText(users[0].full_name).replace(/[[\]#^|]/g, '').slice(0, 80) : null
  const convs = parseJson(files.get(fileNamed(files, /^conversations\.json$/) ?? '')) as unknown[] | null
  for (const c of Array.isArray(convs) ? convs : []) {
    const conv = c as { name?: string; updated_at?: string; chat_messages?: { sender?: string; text?: string; content?: unknown; created_at?: string }[] }
    const title = String(conv.name || 'untitled').slice(0, 80)
    for (const m of conv.chat_messages ?? []) {
      if (m.sender !== 'human') continue
      const t = textOfParts(m.content) || String(m.text ?? '')
      if (t.trim()) docs.push({ text: t, from: `Claude: "${title}"`, at: Date.parse(m.created_at ?? conv.updated_at ?? '') || 0 })
    }
  }
  const projects = parseJson(files.get(fileNamed(files, /^projects\.json$/) ?? '')) as { name?: string; description?: string; prompt_template?: string; docs?: { filename?: string; content?: string }[]; updated_at?: string }[] | null
  for (const p of Array.isArray(projects) ? projects : []) {
    const name = String(p.name ?? 'project').slice(0, 80)
    const at = Date.parse(p.updated_at ?? '') || Number.MAX_SAFE_INTEGER - 2
    if (p.description) docs.push({ text: p.description, from: `Claude project "${name}"`, at, weight: 1.2 })
    if (p.prompt_template) docs.push({ text: p.prompt_template, from: `Claude project "${name}" instructions`, at, weight: 1.3 })
    for (const d of (p.docs ?? []).slice(0, 50)) if (d.content) docs.push({ text: d.content, from: `Claude project "${name}": ${String(d.filename ?? 'doc').slice(0, 60)}`, at, weight: 1.1 })
  }
  const mem = fileNamed(files, /^(memories|memory)\.(json|txt|md)$/i)
  if (mem) {
    const raw = files.get(mem)!
    const parsed = parseJson(raw)
    docs.push({ text: parsed ? stringLeaves(parsed).join('\n') : raw, from: 'Claude memory', at: Number.MAX_SAFE_INTEGER, memory: true })
  }
  return finish('claude', docs, budget, owner, null)
}

/**
 * A Notion export, an Obsidian vault or any folder of markdown / text. Lines already in Open Passport grammar
 * (`- [category] text`) are taken as they are, on the note named by the file; prose goes through the heuristics,
 * About / company / handbook pages weighted up.
 */
export function importMarkdownFolder(files: Map<string, string>, budget: ImportBudget = DEFAULT_IMPORT_BUDGET): ImportResult {
  const docs: Doc[] = []
  const extra: ImportCandidate[] = []
  let i = 0
  for (const [p, text] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!/\.(md|markdown|txt)$/i.test(p)) continue
    i++
    const stem = (p.split('/').pop() ?? p).replace(/\.(md|markdown|txt)$/i, '').replace(/\s+[0-9a-f]{32}$/i, '')
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
    const title = cleanText(h1 || stem).replace(/[[\]#^|]/g, '').slice(0, 120) || 'Imported note'
    const weight = /about|company|mission|overview|handbook|readme|brand|voice|values|pitch/i.test(p) ? 1.3 : 1
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    for (const m of body.matchAll(/^\s*[-*]\s+\[([A-Za-z][\w -]{1,30})\]\s+(.{3,400})$/gm)) {
      const category = m[1].toLowerCase()
      const line = m[2].replace(/\s*\^[fr]-[0-9a-z]{10}\s*$/, '').replace(/\s*\([a-z][a-z0-9_-]{0,31}(?: via suggestion \S+)?(?: (?:run|session)#\S+)?, \d{4}-\d{2}-\d{2}\)\s*$/, '')
      if (!screened(line)) continue
      const polarity = (['likes', 'dislikes', 'prefers', 'avoid'] as const).find((x) => x === category)
      if (polarity) {
        const t = parseTaste(polarity, line)
        extra.push({ kind: 'taste', note: title, noteType: null, category, polarity, text: cleanText(t.statement).slice(0, 120), quote: (t.examples[0] ?? '').replace(/^"|"$/g, '').slice(0, 280), from: p, score: 0.75 })
      } else extra.push({ kind: 'fact', note: title, noteType: null, category, text: cleanText(line).slice(0, 300), quote: cleanText(line).slice(0, 280), from: p, score: 0.75 })
    }
    docs.push({ text: body, from: p, at: -i, weight })
  }
  return finish('folder', docs, budget, null, null, extra)
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Math.min(0x10ffff, Number(d))))
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const metaContent = (html: string, key: string) => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i')
  const tag = re.exec(html)?.[0]
  return tag ? decodeEntities(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? '').trim() : ''
}

/** The readable text of an HTML page: title, meta description, headings and paragraphs (no scripts or styles). */
export function pageText(html: string): { title: string; siteName: string; description: string; headings: string[]; paragraphs: string[] } {
  const clean = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? '')
  const headings = [...clean.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => stripTags(m[1])).filter((s) => s.length > 2 && s.length < 200)
  const paragraphs = [...clean.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)].map((m) => stripTags(m[1])).filter((s) => s.length >= 30 && s.length <= 1200)
  return { title, siteName: metaContent(clean, 'og:site_name'), description: metaContent(clean, 'description') || metaContent(clean, 'og:description'), headings, paragraphs }
}

/** A company's website (homepage, About): a company card draft (name, what it does, tagline) plus prose heuristics. */
export function importWebsite(pages: { url: string; html: string }[], budget: ImportBudget = DEFAULT_IMPORT_BUDGET): ImportResult {
  const docs: Doc[] = []
  const extra: ImportCandidate[] = []
  let company: string | null = null
  pages.forEach((pg, i) => {
    const t = pageText(pg.html)
    if (i === 0) {
      company = cleanText(t.siteName || t.title.split(/\s+[|·–—-]\s+/)[0] || '').replace(/[[\]#^|]/g, '').slice(0, 80) || null
      if (t.description && screened(t.description))
        extra.push({ kind: 'fact', note: null, noteType: 'company', category: 'product', text: cap(cleanText(t.description).replace(/[.!]+$/, '')).slice(0, 240), quote: cleanText(t.description).slice(0, 280), from: `${pg.url} (meta description)`, score: 0.9 })
      const tagline = t.headings[0]
      if (tagline && screened(tagline) && normText(tagline) !== normText(t.description))
        extra.push({ kind: 'fact', note: null, noteType: 'company', category: 'brand', text: `Tagline: "${cleanText(tagline).replace(/["()]/g, "'").slice(0, 150)}"`, quote: cleanText(tagline).slice(0, 280), from: `${pg.url} (headline)`, score: 0.85 })
    }
    docs.push({ text: t.paragraphs.join('\n'), from: pg.url, at: -i, weight: /about|company|story|mission/i.test(pg.url) ? 1.3 : 1.1 })
  })
  return finish('url', docs, budget, null, company, extra)
}

/** Plain pasted text: notes, a pitch, a brief, a memory dump. Open Passport lines are taken as they are. */
export function importText(text: string, budget: ImportBudget = DEFAULT_IMPORT_BUDGET): ImportResult {
  const hasLines = /^\s*[-*]\s+\[[A-Za-z][\w -]{1,30}\]\s+/m.test(text)
  if (hasLines) {
    const r = importMarkdownFolder(new Map([['pasted.md', text]]), budget)
    return { ...r, kind: 'text', candidates: r.candidates.map((c) => (c.note === 'pasted' ? { ...c, note: null } : c)) }
  }
  const memoryish = (text.match(/^(?:the\s+)?user\b/gim) ?? []).length >= 2
  return finish('text', [{ text, from: 'pasted text', at: 0, memory: memoryish, weight: 1.2 }], budget, null, null)
}

// ---------- to proposals ----------

/**
 * Proposals for review: facts grouped per note (one proposal per note, at most 20 lines), each taste its own
 * proposal. Card facts (note null) land on `cardTitle`.
 */
export function candidatesToProposals(cs: ImportCandidate[], meta: { source: string; app?: string; now: string; cardTitle: string; newId?: () => string }): LocalProposal[] {
  const id = meta.newId ?? (() => newProposalId())
  const out: LocalProposal[] = []
  const byNote = new Map<string, { type: string | null; lines: string[]; evidence: string[]; score: number }>()
  for (const c0 of cs) {
    const c = { ...c0 }
    // taste found on a named note (a department, a person) stays on that note as a taste line
    if (c.kind === 'taste' && c.polarity && c.note && c.note !== meta.cardTitle && c.note.toLowerCase() !== 'taste') {
      const ex = /^\[\[[^[\]]+\]\]$/.test(c.quote) ? c.quote : c.quote ? quoteExample(c.quote) : null
      c.category = c.polarity
      c.text = formatTasteText({ statement: c.text, examples: ex ? [ex] : [], count: 1 })
    } else if (c.kind === 'taste' && c.polarity) {
      out.push({
        open_passport_proposal: 1,
        id: id(),
        created: meta.now,
        app: meta.app ?? 'import',
        source: meta.source,
        kind: 'taste',
        taste: { scope: 'company', polarity: c.polarity, text: c.text.replace(/;/g, ',').slice(0, 200), example: (c.quote || c.text).slice(0, 300), stated_by_user: false },
        evidence: [`${c.from}: ${c.quote}`.slice(0, 300)],
        score: c.score
      })
      continue
    }
    const title = c.note ?? meta.cardTitle
    const e = byNote.get(title) ?? { type: c.noteType, lines: [], evidence: [], score: 0 }
    if (e.lines.length >= 20) continue
    e.lines.push(`- [${c.category.replace(/[^a-z0-9 _-]/gi, '').toLowerCase() || 'fact'}] ${c.text.replace(/\s*\^[fr]-[0-9a-z]{10}$/, '')}`)
    if (e.evidence.length < 5) e.evidence.push(`${c.from}: ${c.quote}`.slice(0, 300))
    e.score = Math.max(e.score, c.score)
    byNote.set(title, e)
  }
  for (const [title, e] of byNote)
    out.push({ open_passport_proposal: 1, id: id(), created: meta.now, app: meta.app ?? 'import', source: meta.source, kind: 'notes', notes: [{ title, type: e.type, lines: e.lines }], evidence: e.evidence, score: e.score })
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
