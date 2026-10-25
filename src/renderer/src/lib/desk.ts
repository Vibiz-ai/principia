/**
 * Five doors step 3: the words and decisions behind Home's Ask box, the Team cards and the agent desk. Pure: no hive,
 * no store, no DOM, so every sentence is tested on its own (desk.test.ts).
 *
 * - autonomyPhrase: the ONE phrase per agent ("Asks before posting" / "Acts on its own"), the same string on the Team
 *   card, the agent page toggle and onboarding (design §2.7).
 * - routeAsk: who gets a request typed in the Ask box ("→ Marcus · Content Writer"): an @name first, then the
 *   request's words against each agent's role and department, then the company's first agent.
 * - paraphrase / deskReply (PM D11): the agent restates the request in a full sentence, never a truncated quote; a
 *   request that matches work already queued is merged into it ("I'm already on … (from setup); I'll add …").
 * - statusSentence: one plain sentence per agent (design §2.6 status vocabulary), glyph + word, never colour alone.
 * - weekTiles: Home's This week row, 3 tiles (PM C10): tasks done, drafts approved (pull requests in a code company),
 *   plan use, which Claude doesn't report yet, so it says so instead of a number (PM risk: never a fake 31%).
 */
import type { CompanyTask } from '@shared/company'

// ---------- autonomy ----------

/** Words that decide what an agent asks before doing. First match wins, role before department. */
const ASK_BEFORE: [RegExp, string][] = [
  [/support|customer|reception|front desk|office|liaison|inbox|reply|responder|patient/i, 'replying'],
  [/\bads?\b|advert|campaign|paid|media buy|finance|budget|spend|account/i, 'spending'],
  [/content|writer|copy|social|instagram|brand|marketing|blog|seo|newsletter|editor|post/i, 'posting'],
  [/develop|engineer|\bdev\b|\bcode\b|coder|\bqa\b|\btest|devops|frontend|backend|software/i, 'merging'],
  [/report|analyst|research|insight|data/i, 'sending anything out'],
  [/ops|operation|fulfil|logistic|supply|inventory|order/i, 'ordering']
]

/**
 * One phrase per agent, shared by Team, the agent page and onboarding. An agent with autonomy 'auto' "Acts on its
 * own"; every other agent "Asks before {what its role would do in the world}", or "Asks before acting".
 */
export function autonomyPhrase(o: { auto: boolean; role?: string | null; department?: string | null }): string {
  if (o.auto) return 'Acts on its own'
  for (const src of [o.role, o.department]) {
    if (!src) continue
    for (const [re, verb] of ASK_BEFORE) if (re.test(src)) return `Asks before ${verb}`
  }
  return 'Asks before acting'
}

// ---------- routing ----------

export interface DeskAgent {
  id: string
  /** persona name ("Marcus"), or the role label when personas are off */
  name: string
  /** role label ("Content Writer") */
  role: string
  department?: string | null
  paused?: boolean
}

/** What a request is about, and which roles handle it. Every rule that matches adds to an agent's score. */
const ROUTES: [RegExp, RegExp][] = [
  [/\b(post|posts|instagram|caption|captions|blog|copy|newsletter|content|tweet|tiktok|social|headline|homepage|landing|brand voice|write|writing)\b/i, /content|writer|copy|social|brand|editor|blog/i],
  [/\b(ad|ads|campaign|campaigns|meta|google ads|audience|targeting|competitor|competitors)\b/i, /\bads?\b|advert|strategist|campaign|growth/i],
  [/\b(refund|customer|customers|email|emails|reply|replies|support|order|orders|complaint|ticket|patient|patients|appointment|appointments|office|front desk|reception|approval|approvals|packet)\b/i, /support|customer|responder|office|liaison|reception/i],
  [/\b(bug|bugs|fix|code|test|tests|pr|branch|feature|field|deploy|api|crash|error|invoice pdf|refactor)\b/i, /develop|engineer|\bdev\b|builder|\bcode\b|coder|\bqa\b/i],
  [/\b(review|reviews)\b/i, /review/i],
  [/\b(stock|inventory|plan|planning|checklist|report|reports|reporting|dashboard|metrics|numbers|priorit\w*|fulfil\w*|supplier|suppliers|schedule|ops|performance)\b/i, /ops|operation|planner|coordinator|report|analyst/i],
  [/\b(seo|keyword|keywords|search|google|rank|ranking)\b/i, /seo|search|marketing|analyst/i]
]
/** Words in a role that say nothing about the work ("Report Builder": "report" counts, "builder" does not). */
const ROLE_GENERIC = new Set('analyst builder specialist agent assistant lead manager officer helper partner expert person team member'.split(' '))

const MENTION = /(^|\s)@([\p{L}\p{N}_-]+)/u

/** The agent an @name points at (persona or first word of the role), case-insensitive. */
export function mentioned(text: string, agents: readonly DeskAgent[]): DeskAgent | null {
  const m = text.match(MENTION)
  if (!m) return null
  const k = m[2]!.toLowerCase()
  return agents.find((a) => a.name.toLowerCase() === k) ?? agents.find((a) => a.name.toLowerCase().startsWith(k) || a.role.toLowerCase().split(/\s+/)[0] === k) ?? null
}

export type RouteBy = 'mention' | 'words' | 'default'
/**
 * Who gets the request: @name, else the words, else the first active agent. null when the company has no agent.
 * `unknown`: an @name nobody in this company has ("@Livia" in Harbor): the request goes by its words and the box says so.
 * Words score every agent (a rule for its role 2, for its department 1, a word of its own role 3), so "the monthly
 * report" reaches the Report Builder, not the first analyst listed.
 */
export function routeAsk(text: string, agents: readonly DeskAgent[]): { agent: DeskAgent; by: RouteBy; unknown?: string } | null {
  if (!agents.length) return null
  const at = mentioned(text, agents)
  if (at) return { agent: at, by: 'mention' }
  const named = text.match(MENTION)?.[2]
  const unknown = named ? { unknown: named } : {}
  const words = stripMention(text)
  if (words) {
    const active = agents.filter((a) => !a.paused)
    const pool = active.length ? active : agents
    const asked = contentWords(words)
    let best: { a: DeskAgent; score: number } | null = null
    for (const a of pool) {
      let score = 0
      for (const [about, roles] of ROUTES) {
        if (!about.test(words)) continue
        if (roles.test(a.role)) score += 2
        else if (a.department && roles.test(a.department)) score += 1
      }
      for (const w of contentWords(a.role)) if (!ROLE_GENERIC.has(w) && asked.has(w)) score += 3
      if (score > 0 && (!best || score > best.score)) best = { a, score }
    }
    if (best) return { agent: best.a, by: 'words', ...unknown }
  }
  return { agent: agents.find((a) => !a.paused) ?? agents[0]!, by: 'default', ...unknown }
}

// ---------- paraphrase ----------

/** Removes @names (anywhere) and a leading "Marcus," address. */
export function stripMention(text: string): string {
  return text.replace(/(^|\s)@[\p{L}\p{N}_-]+[,:]?/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** Politeness and addressing in front of the request, removed one layer at a time ("Hey, can you also please …"). */
const OPENERS: RegExp[] = [
  /^(?:hey|hi|hello|ok|okay|so|um|yo|right)\b[,!.]?\s+/i,
  /^(?:and\s+)?also,?\s+/i,
  /^and\s+/i,
  /^(?:please|pls|plz|kindly)[,]?\s+/i,
  /^(?:can|could|would|will)\s+(?:you|u|someone|somebody|anyone|anybody|one of you)(?:\s+(?:please|also|kindly|maybe|just))*\s+/i,
  /^(?:i|we)\s+(?:need|want|would like|'d like|’d like)\s+(?:you|someone|somebody|one of you)\s+to\s+/i,
  /^(?:i|we)(?:'d| would|’d)\s+love\s+(?:it\s+if\s+)?(?:you|someone)\s+(?:to\s+|could\s+|would\s+)?/i,
  /^(?:i|we)\s+need\s+(?=(?:a|an|the|some|our|my|\d+)\s)/i,
  /^(?:someone|somebody)\s+(?:should|needs to|has to|must)\s+/i,
  /^(?:you\s+should|you\s+need\s+to|go\s+ahead\s+and|let'?s|let’s)\s+/i,
  /^(?:is\s+it|would\s+it\s+be)\s+possible\s+(?:for\s+you\s+)?to\s+/i,
  /^(?:just|quickly|now)\s+/i
]
function stripOpeners(s: string): string {
  let out = s.trim()
  for (let i = 0; i < 8; i++) {
    const before = out
    for (const re of OPENERS) out = out.replace(re, '')
    out = out.trim()
    if (out === before) break
  }
  return out
}

const VERBS = new Set(
  ('write draft make create fix add send reply research find plan prepare update check review post build design look set schedule refund email call ' +
    'summarize summarise analyze analyse compare clean organize organise translate edit rewrite test ship launch get give put help figure think come list ' +
    'collect track order book change move remove delete improve optimize optimise rank map propose outline brainstorm audit answer respond read sort tidy ' +
    'polish shorten expand turn start finish draw run price cancel invite follow ask tell show explain pick choose keep stop do redo ' +
    'mention include use cover highlight feature note focus try remind prep share announce reach contact message go work drop').split(' ')
)
/** Verbs a question may end on ("how did the ads do", "why did orders drop"): the subject ends before one of them. */
const Q_VERBS = new Set([...VERBS, ...'perform happen grow feel mean cost need want have see say like know convert land open close react spend earn pay rise fall fail succeed matter take become sell buy lose win look seem stand'.split(' ')])
const AUX = /^(is|are|was|were|do|does|did|can|could|should|will|would|have|has|had)$/i
const WH = /^(what|how|why|which|who|when|where|whom|whose)$/i

// first person (the founder) becomes second person (the agent talking back), and back
const SWAP: Record<string, string> = { i: 'you', me: 'you', my: 'your', mine: 'yours', we: 'you', us: 'you', our: 'your', ours: 'yours', myself: 'yourself', ourselves: 'yourselves', "i'm": "you're", "we're": "you're", "i've": "you've", "we've": "you've", "i'll": "you'll", "we'll": "you'll", "i'd": "you'd", "we'd": "you'd", your: 'my', yours: 'mine', yourself: 'myself', "you're": "I'm", "you've": "I've", "you'll": "I'll", "you'd": "I'd" }
/** A word after which "you" is the subject ("make sure you…", "what you think"), so it becomes "I", not "me". */
const SUBJ_BEFORE = new Set('and but so or that what how why when where if whether because which who sure think know guess hope once while until unless though before after as'.split(' '))
/** A word after "you" that shows it is the subject ("you don't", "you can", "you think"). */
const SUBJ_AFTER = /^(do|don't|don’t|did|didn't|can|can't|could|couldn't|will|won't|would|wouldn't|should|shouldn't|must|might|may|have|haven't|had|need|want|think|know|see|like|get|make|post|send|write|use|go|keep|are|aren't|were|weren't)$/i

/** Swaps persons, word by word, with subject "you" as "I" (and "you are" as "I am"). */
export function swapPersons(s: string): string {
  const parts = s.split(/(\s+)/)
  const words = parts.filter((_, i) => i % 2 === 0)
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!
    const m = raw.match(/^([^\p{L}']*)([\p{L}'’]+)([^\p{L}']*)$/u)
    if (!m) {
      out.push(raw)
      continue
    }
    const [, pre, w, post] = m as unknown as [string, string, string, string]
    const lw = w.toLowerCase().replace('’', "'")
    let r: string | undefined
    if (lw === 'you') {
      const prev = (words[i - 1] ?? '').toLowerCase().replace(/[^\p{L}']/gu, '')
      const next = (words[i + 1] ?? '').toLowerCase().replace(/[^\p{L}'’]/gu, '')
      const subject = i === 0 || SUBJ_BEFORE.has(prev) || SUBJ_AFTER.test(next) || /[,;:]$/.test(words[i - 1] ?? '')
      r = subject ? 'I' : 'me'
      // "you are" -> "I am", "you were" -> "I was"
      if (subject && /^(are|were|aren't|weren't)$/i.test(next)) {
        const v = next.toLowerCase()
        words[i + 1] = (words[i + 1] ?? '').replace(/^(are|were|aren't|weren't)/i, v === 'are' ? 'am' : v === 'were' ? 'was' : v === "aren't" ? "am not" : "wasn't")
      }
    } else if (lw === 'i' || lw === 'we') {
      const next = (words[i + 1] ?? '').toLowerCase()
      r = 'you'
      if (/^(am|was)\b/.test(next)) words[i + 1] = (words[i + 1] ?? '').replace(/^(am|was)/i, next.startsWith('am') ? 'are' : 'were')
    } else r = SWAP[lw]
    if (!r) {
      out.push(raw)
      continue
    }
    // capitals: keep a leading capital except for "I", which is always upper case
    const cap = w[0] === w[0]!.toUpperCase() && lw !== 'i' && r !== 'I' && !r.startsWith('I')
    out.push(pre + (cap ? r[0]!.toUpperCase() + r.slice(1) : r) + post)
  }
  return parts.map((p, i) => (i % 2 === 0 ? out[i / 2]! : p)).join('')
}
function lowerFirst(s: string): string {
  // keep acronyms and proper names ("NW-7", "SEO" stay as typed)
  return s.length > 1 && s[1] === s[1]!.toLowerCase() && !/^I\b/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s
}
function upperFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
/** Ends the text as a sentence: one full stop, never "?." or "..". */
export function asSentence(s: string): string {
  const t = s.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

/** did → past tense, does → third person: "how did the ads do" → "how the ads did". */
const IRREGULAR_PAST: Record<string, string> = { do: 'did', go: 'went', get: 'got', make: 'made', see: 'saw', come: 'came', take: 'took', give: 'gave', run: 'ran', buy: 'bought', sell: 'sold', have: 'had', say: 'said', feel: 'felt', find: 'found', think: 'thought', know: 'knew', grow: 'grew', fall: 'fell', rise: 'rose', lose: 'lost', win: 'won', pay: 'paid', spend: 'spent', send: 'sent', write: 'wrote', become: 'became', cost: 'cost', put: 'put', set: 'set', mean: 'meant', stand: 'stood', keep: 'kept', read: 'read', tell: 'told', build: 'built', bring: 'brought' }
export function pastTense(v: string): string {
  const w = v.toLowerCase()
  if (IRREGULAR_PAST[w]) return IRREGULAR_PAST[w]!
  if (/e$/.test(w)) return w + 'd'
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ied'
  if (w.length <= 4 && /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(w)) return w + w.slice(-1) + 'ed'
  return w + 'ed'
}
function thirdPerson(v: string): string {
  const w = v.toLowerCase()
  if (w === 'have') return 'has'
  if (w === 'do' || w === 'go') return w + 'es'
  if (/(s|sh|ch|x|z)$/.test(w)) return w + 'es'
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies'
  return w + 's'
}

/**
 * A direct question as the agent says it back, already person-swapped: "how did your ads do" → "how your ads did",
 * "is the shop ready" → "whether the shop is ready", "which keywords should you rank for" → "which keywords you
 * should rank for". null when the words do not fit the pattern (the caller says it another way).
 */
export function indirectQuestion(q: string): string | null {
  const w = q.split(/\s+/).filter(Boolean)
  if (!w.length) return null
  let lead: string[] = []
  let rest = w
  if (WH.test(w[0]!)) {
    // "which keywords should…", "how many posts did…", "what time is…": the wh-phrase runs up to the auxiliary
    const ai = w.findIndex((x, i) => i > 0 && AUX.test(x))
    if (ai < 0) return w.join(' ') // "what competitors are running" is already a clause
    if (ai > 3) return null
    lead = w.slice(0, ai)
    rest = w.slice(ai)
  } else if (AUX.test(w[0]!)) lead = ['whether']
  else return null
  const aux = rest[0]!.toLowerCase()
  const tail = rest.slice(1)
  if (!tail.length) return [...lead, aux].join(' ')
  if (/^(is|are|was|were)$/.test(aux)) {
    // the subject runs up to an -ing word or a preposition, else to the end: "how are your ads doing" / "what is the best time to post"
    const k = tail.findIndex((x, i) => i > 0 && (/ing$/i.test(x) || /^(for|in|on|at|with|by|from|ready|done|live|open|working|right|wrong|good|bad|ok|okay|up|down)$/i.test(x)))
    const cut = k < 0 ? tail.length : k
    const subj = tail.slice(0, cut)
    const be = /^(i)$/i.test(subj.join(' ')) ? (aux === 'is' || aux === 'are' ? 'am' : 'was') : aux
    return [...lead, ...subj, be, ...tail.slice(cut)].join(' ')
  }
  // do/does/did/modal + subject + verb + rest: the subject ends before the first verb we know (after one word)
  const vi = tail.findIndex((x, i) => i > 0 && Q_VERBS.has(x.toLowerCase()))
  if (vi < 0) return null
  const subj = tail.slice(0, vi)
  const verb = tail[vi]!
  const after = tail.slice(vi + 1)
  const single = subj.length === 1 && /^(he|she|it|this|that|[\p{Lu}][\p{L}]+)$/u.test(subj[0]!) && !/^(I|You|We|They)$/.test(subj[0]!)
  const v = aux === 'did' ? pastTense(verb) : aux === 'does' || (aux === 'do' && single) ? thirdPerson(verb) : aux === 'do' ? verb : `${aux} ${verb}`
  return [...lead, ...subj, v, ...after].join(' ')
}

type Clause = { kind: 'do' | 'about' | 'question'; clause: string }
/** One sentence of the request: what kind it is and its words in the agent's voice. */
function clauseOf(sentence: string): Clause | null {
  let s = stripOpeners(sentence)
  s = s.replace(/[\s,]*(please|pls|thanks|thank you|thx|cheers|ty)[.!]*$/i, '').trim()
  if (!s || /^(thanks|thank you|thx|cheers|ty)\b/i.test(s)) return null
  const first = (s.split(/\s+/)[0] ?? '').toLowerCase()
  const verb = VERBS.has(first)
  const question = !verb && (/\?\s*$/.test(s) || WH.test(first) || AUX.test(first))
  s = swapPersons(s.replace(/[.!?\s]+$/, ''))
  if (question) {
    const ind = indirectQuestion(lowerFirst(s))
    return { kind: 'question', clause: ind ?? lowerFirst(s) }
  }
  // "do the homepage copy, mention the launch" reads "do the homepage copy, and mention the launch"
  if (verb) return { kind: 'do', clause: lowerFirst(s).replace(/,\s+(?!and\b)(?=([\p{L}]+)\b)/gu, (m, w: string) => (VERBS.has(w.toLowerCase()) ? ', and ' : m)) }
  return { kind: 'about', clause: STOP.has(first) ? lowerFirst(s) : s }
}

/** The request as the agent would say it back: the whole of it, person-swapped, never cut. */
export function requestClause(text: string): { kind: 'do' | 'about' | 'question'; clause: string; context: string[] } {
  const body = stripMention(text).replace(/\s*\n+\s*/g, ' ').trim()
  const sentences = body.split(/(?<=[.!?])\s+(?=\S)/).map((x) => x.trim()).filter(Boolean)
  const clauses = sentences.map(clauseOf).filter((c): c is Clause => !!c)
  if (!clauses.length) return { kind: 'about', clause: 'this', context: [] }
  // the ask is the first thing to do (or the first question); statements around it are context ("Thursday you launch …")
  const asks = clauses.filter((c) => c.kind === 'do')
  const main = asks[0] ?? clauses.find((c) => c.kind === 'question') ?? clauses[0]!
  const more = asks.slice(1).map((c) => c.clause)
  const context = clauses.filter((c) => c !== main && c.kind !== 'do').map((c) => upperFirst(c.kind === 'question' ? `${c.clause}?` : c.clause))
  return { kind: main.kind, clause: [main.clause, ...more].join(', and '), context }
}

/** "I'll write a post about your new decaf" / "I'll work on Instagram posts for next week" / "I'll find out how …". */
export function paraphrase(text: string): string {
  const { kind, clause, context } = requestClause(text)
  const head = kind === 'question' ? `I'll find out ${clause} and answer you here` : kind === 'do' ? `I'll ${clause}` : `I'll work on ${clause}`
  return context.length ? `${head}. Noted: ${context.map((c) => asSentence(c).replace(/\.$/, '')).join('; ')}` : head
}

/** A task title for the request: sentence case, the first sentence, at most 120 characters cut at a word. */
export function taskTitleFor(text: string): string {
  const body = stripMention(text).replace(/\s+/g, ' ').trim()
  const sentences = body.split(/(?<=[.!?])\s+(?=\S)/).map((x) => stripOpeners(x)).filter(Boolean)
  // the sentence that asks for something, not the context in front of it ("Thursday we launch. Can you get posts ready?")
  const pick = sentences.find((x) => VERBS.has((x.split(/\s+/)[0] ?? '').toLowerCase())) ?? sentences[0] ?? ''
  // "Get posts ready?" was "Can you get posts ready?": a request, not a question
  let s = pick.replace(VERBS.has((pick.split(/\s+/)[0] ?? '').toLowerCase()) ? /[.!?\s]+$/ : /[.!\s]+$/, '')
  if (s.length > 120) s = s.slice(0, 120).replace(/\s+\S*$/, '') + '…'
  return s ? upperFirst(s) : 'New request'
}

// ---------- duplicates (D11) ----------

const STOP = new Set(
  ('the a an and or for with about from into onto this that these those our your my their its of to in on at by be is are was were it as up out ' +
    'please can could would will you me we us i some any all new next week weeks one two three just also more make write draft get do someone').split(' ')
)
function stem(w: string): string {
  return w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '')
}
export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue
    const s = stem(raw)
    if (s.length >= 3 && !STOP.has(s)) out.add(s)
  }
  return out
}
/** Content words that name the topic (verbs left out: "update the guide" is about the guide). */
function topicWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of contentWords(text)) if (!VERBS.has(w) && !VERBS.has(w.replace(/e$/, ''))) out.add(w)
  return out
}
/** The part of a request that names the work: "update the brand voice guide" of "… with emoji rules, and …". */
function mainClause(text: string): string {
  const s = stripOpeners(stripMention(text))
  // "add X to the Y" / "mention X in the Y": the work it joins is Y
  const into = s.match(/^(?:add|include|put|mention|work|fold|use)\b.*?\b(?:to|in|into|on)\s+(?:the|my|our|your|this|that)\s+(.+?)(?:[,;.!?]|$)/i)
  if (into) return into[1]!
  return s.split(/[,;.!?]|\s+(?:and|with|but|plus|also)\s+/i)[0] ?? s
}

type DupTask = Pick<CompanyTask, 'id' | 'title' | 'status'> & { description?: string }
const OPEN = new Set(['todo', 'backlog', 'triage', 'in_progress', 'blocked', 'in_review'])
/**
 * The agent's open task this request repeats: at least two shared content words covering half of the task's title,
 * and the part of the request that names the work brings at most one word the task does not have ("a blog post about
 * teeth whitening for the La Jolla clinic" is new work, not the monthly blog post). The best match wins.
 */
export function findDuplicate<T extends DupTask>(text: string, tasks: readonly T[]): T | null {
  const ask = contentWords(stripMention(text))
  if (ask.size < 2) return null
  const named = topicWords(mainClause(text))
  let best: { t: T; score: number } | null = null
  for (const t of tasks) {
    if (!OPEN.has(t.status)) continue
    const title = contentWords(t.title)
    const both = new Set([...title, ...contentWords((t.description ?? '').slice(0, 400))])
    let hitTitle = 0
    let hit = 0
    for (const w of ask) {
      if (title.has(w)) hitTitle++
      if (both.has(w)) hit++
    }
    if (hit < 2 || hitTitle < 1) continue
    let fresh = 0
    for (const w of named) if (!both.has(w)) fresh++
    if (fresh > 1) continue
    const score = hit / Math.min(ask.size, Math.max(title.size, 2))
    if (score >= 0.5 && (!best || score > best.score)) best = { t, score }
  }
  return best?.t ?? null
}
/** What the request adds to the task it joins: its parts the task does not already say ("mention the launch on Thursday"). */
export function additionTo(text: string, title: string): string {
  const { clause } = requestClause(text)
  const known = contentWords(title)
  const parts = clause.split(/,\s*|;\s*|\s+and\s+(?=(?:also\s+)?(?:mention|add|include|make|use|put|keep|say|show|note|cover|highlight|feature)\b)/i).map((p) => p.trim().replace(/^and\s+/i, '')).filter(Boolean)
  const kept = parts.filter((p) => {
    const w = topicWords(p)
    return [...w].some((x) => !known.has(x))
  })
  return (kept.length ? kept : parts).join(', ')
}

// ---------- the reply ----------

export type TaskOrigin = 'setup' | 'you' | 'board' | 'linear' | 'github' | 'schedule' | 'agent'
const ORIGIN_WORDS: Record<TaskOrigin, string> = { setup: 'from setup', you: 'you asked earlier', board: 'from the Board', linear: 'from Linear', github: 'from GitHub', schedule: 'from a schedule', agent: 'a teammate passed it to me' }
export const DESK_PREFIX = 'desk:'
/** Where a task came from, in the words the agent uses ("from setup"). */
export function taskOrigin(t: Pick<CompanyTask, 'source' | 'externalId' | 'createdAt'>, companyCreatedAt?: string | null): TaskOrigin {
  if (t.externalId?.startsWith(DESK_PREFIX)) return 'you'
  if (t.source === 'linear') return 'linear'
  if (t.source === 'github') return 'github'
  if (t.source === 'schedule') return 'schedule'
  if (t.source === 'agent') return 'agent'
  // onboarding creates the first tasks with the company: within ten minutes of it is "from setup"
  if (companyCreatedAt && Math.abs(Date.parse(t.createdAt) - Date.parse(companyCreatedAt)) < 10 * 60_000) return 'setup'
  return 'board'
}

export interface ReplyInput {
  request: string
  /** the agent's autonomy phrase */
  autonomy: string
  /** the open task the request was merged into, and where it stands */
  merged?: { title: string; origin: TaskOrigin; status?: CompanyTask['status']; waitingOnOther?: boolean } | null
  /** the task the agent is busy with, when the new one waits behind it */
  busyWith?: string | null
  /** the agent starts its next task by itself (acts on its own, Autopilot on); else it waits for your Start */
  startsNext?: boolean
  /** the company is paused (its name), or the agent is */
  pausedCompany?: string | null
  agentPaused?: boolean
}
/** "Sentence case" a title for the middle of a sentence: "the week's posts", not "The Week's Posts". */
function inSentence(title: string): string {
  const t = title.replace(/[.!?\s]+$/, '')
  return STOP.has((t.split(/\s+/)[0] ?? '').toLowerCase()) || VERBS.has((t.split(/\s+/)[0] ?? '').toLowerCase()) ? lowerFirst(t) : t
}
/** write → writing, draft → drafting, plan → planning, make → making, tidy → tidying. */
export function gerund(verb: string): string {
  const v = verb.toLowerCase()
  if (/ie$/.test(v)) return v.slice(0, -2) + 'ying'
  if (/[^aeiou]e$/.test(v) && v !== 'be') return v.slice(0, -1) + 'ing'
  if (v.length <= 4 && /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(v)) return v + v.slice(-1) + 'ing'
  return v + 'ing'
}
/** "I finished writing a post about your new decaf. It’s ready for your OK." */
export function finishedLine(title: string): string {
  return `I finished ${workPhrase(title)}. It’s ready for your OK.`
}
/** The work as the agent names it: "writing a post about your new decaf", or "the Instagram week plan". */
function workPhrase(title: string): string {
  const t = swapPersons(title.replace(/[.!?\s]+$/, ''))
  const [first, ...rest] = t.split(/\s+/)
  if (first && VERBS.has(first.toLowerCase()) && rest.length) return `${gerund(first)} ${rest.join(' ')}`
  return inSentence(t)
}
/**
 * D11: the agent restates the request in a full sentence (never a truncated quote, never an echo with "?.") and says
 * truthfully what happens next: it starts now, it waits behind the current task (by itself, or until you press
 * Start), or it waits for the resume. A merged request names the work it joins, where that came from and where it
 * stands ("already drafting" only when it is being drafted), and says only what the request adds.
 */
export function deskReply(o: ReplyInput): string {
  const will = paraphrase(o.request)
  // a question gets an answer here, not a draft for your OK
  const question = requestClause(o.request).kind === 'question'
  const after = question ? '' : o.autonomy === 'Acts on its own' ? "I'll tell you in Needs you when it's done." : `${o.autonomy.replace(/^Asks/, 'I ask')}, so it comes to Needs you for your OK first.`
  const pausedTail = o.pausedCompany ? ` ${o.pausedCompany} is paused, so I pick it up when you resume.` : o.agentPaused ? " I'm paused, so I pick it up when you resume me." : ''
  if (o.merged) {
    const add = additionTo(o.request, o.merged.title)
    const where = ORIGIN_WORDS[o.merged.origin]
    const work = workPhrase(o.merged.title)
    const st = o.merged.status ?? 'in_progress'
    if (st === 'in_progress') return `Got it. I'm already ${/ing\b/.test(work.split(' ')[0] ?? '') ? work : `on ${work}`} (${where}); I'll add this: ${asSentence(add)}${pausedTail}`
    if (st === 'in_review') return `Got it. ${upperFirst(work)} (${where}) is waiting for your OK; I've added this to it for the next round: ${asSentence(add)}${pausedTail}`
    const state = o.merged.waitingOnOther ? 'waiting on another task first' : 'not started yet'
    const start = pausedTail || o.merged.waitingOnOther ? '' : o.startsNext ? '' : ' Press Start when you want me on it.'
    return `Got it. ${upperFirst(work)} is already in my queue (${where}), ${state}. I've added this to it: ${asSentence(add)}${pausedTail}${start}`
  }
  if (o.pausedCompany) return `Got it. ${asSentence(will)} ${o.pausedCompany} is paused, so it waits in my queue until you resume.`
  if (o.agentPaused) return `Got it. ${asSentence(will)} I'm paused, so it waits in my queue until you resume me.`
  if (o.busyWith) {
    const next = o.startsNext ? "I start this right after, on my own." : 'This waits in my Queue: press Start when you want me on it.'
    const busy = workPhrase(o.busyWith)
    return `Got it. ${asSentence(will)} I'm still ${/ing$/.test(busy.split(' ')[0] ?? '') ? busy : `on ${busy}`}. ${next}${after ? ` ${after}` : ''}`
  }
  return `On it. ${asSentence(will)}${after ? ` ${after}` : ''}`
}

// ---------- status sentence ----------

export type StatusKind = 'working' | 'needs' | 'ready' | 'idle' | 'paused' | 'failed'
export interface StatusSentence {
  kind: StatusKind
  /** ● ◆ ○ ‖ ✕ */
  glyph: string
  text: string
}
export const STATUS_GLYPH: Record<StatusKind, string> = { working: '●', needs: '◆', ready: '○', idle: '○', paused: '‖', failed: '✕' }
type SeatLike = {
  current: Pick<CompanyTask, 'identifier' | 'title'> | null
  /** To do, in order; an item with `waiting` cannot start yet (a task it depends on is not done) */
  queue: (Pick<CompanyTask, 'identifier' | 'title'> & { waiting?: boolean })[]
  review: Pick<CompanyTask, 'identifier' | 'title'>[]
  parked: (Pick<CompanyTask, 'identifier' | 'title' | 'blockReason'>)[]
  kind: string
}
/** The task as a sentence names it: "NW-7 Instagram week plan" in a code company, the title alone otherwise (C7). */
export function taskName(t: Pick<CompanyTask, 'identifier' | 'title'>, code: boolean): string {
  return code ? `${t.identifier} ${t.title}` : t.title
}
/**
 * Design §2.6: one sentence per agent. Company pause before agent pause; working before what waits; a live ask on
 * the task in flight is "Asking you about …".
 */
export function statusSentence(o: { seat: SeatLike; agentPaused: boolean; companyPaused?: string | null; code: boolean; since?: string | null; activity?: string | null }): StatusSentence {
  const s = o.seat
  const name = (t: Pick<CompanyTask, 'identifier' | 'title'>): string => taskName(t, o.code)
  const make = (kind: StatusKind, text: string): StatusSentence => ({ kind, glyph: STATUS_GLYPH[kind], text })
  if (o.companyPaused) return make('paused', `Paused with ${o.companyPaused}${s.current ? `: ${name(s.current)} is saved` : ''}`)
  if (o.agentPaused) return make('paused', s.current ? `Paused by you: ${name(s.current)} is saved` : 'Paused by you')
  if (s.current) {
    if (s.kind === 'needs') return make('needs', `Asking you about ${name(s.current)}`)
    const doing = o.activity ? `: ${o.activity.charAt(0).toLowerCase()}${o.activity.slice(1)}` : ''
    return make('working', `Working on ${name(s.current)}${doing}${o.since ? ` · ${o.since}` : ''}`)
  }
  if (s.review.length) return make('needs', s.review.length === 1 ? `Waiting for your OK on ${name(s.review[0]!)}` : `Waiting for your OK on ${s.review.length} things`)
  const questions = s.parked.filter((t) => t.blockReason === 'needs_input')
  if (questions.length) return make('needs', `Has a question about ${name(questions[0]!)}`)
  if (s.parked.length) return make('failed', `Stopped on ${name(s.parked[0]!)}: needs you to look`)
  // "Ready" only for work that can start now; work waiting on another task says so, with no Start
  const ready = s.queue.filter((t) => !t.waiting)
  if (ready.length) return make('ready', `Ready: ${name(ready[0]!)}${s.queue.length > 1 ? ` (+${s.queue.length - 1} more)` : ''}`)
  if (s.queue.length) return make('idle', `Waiting on another task before ${name(s.queue[0]!)}`)
  return make('idle', 'Nothing assigned')
}

/**
 * A task that waits on another one: blocked on its dependencies, or To do while a task it depends on is not done
 * (tasks:start refuses it: "Complete dependencies before starting this task").
 */
export function waitsOnOther(t: Pick<CompanyTask, 'status' | 'blockReason' | 'dependencyIds'>, all: readonly Pick<CompanyTask, 'id' | 'status'>[]): boolean {
  if (t.status === 'blocked' && t.blockReason === 'deps') return true
  return (t.dependencyIds ?? []).some((d) => all.find((x) => x.id === d)?.status !== 'done')
}

// ---------- Home ----------

/** "Northwind Coffee · 3 things need you, 1 agent is working." (the 5-second answer) */
export function homeHeadline(o: { company: string; needs: number; working: number; paused: boolean; agents: number; chats?: number }): string {
  const needs = o.needs === 0 ? 'nothing needs you' : `${o.needs} thing${o.needs === 1 ? '' : 's'} need${o.needs === 1 ? 's' : ''} you`
  // the banner below says what paused means; the line only says the state
  if (o.paused) return `${o.company} · paused, ${needs}.`
  if (o.agents === 0) return `${o.company} · ${needs}. Hire a team to give them work.`
  const working = o.working === 0 ? 'no agent is working' : `${o.working} agent${o.working === 1 ? ' is' : 's are'} working`
  // your own chats are not agents: said apart, so "1 agent is working" never means your chat
  const chats = o.chats ? `; ${o.chats === 1 ? 'one of your chats is' : `${o.chats} of your chats are`} running` : ''
  return `${o.company} · ${needs}, ${working}${chats}.`
}

/** "Good morning, Maya" (the user's own name when known, E12). */
export function greeting(now: Date, name?: string | null): string {
  const h = now.getHours()
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

/** Monday 00:00 of this week, local time. */
export function weekStart(now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

export interface WeekTile {
  key: 'done' | 'approved' | 'prs' | 'plan'
  label: string
  value: string
  detail: string
}
type WeekTask = Pick<CompanyTask, 'status' | 'updatedAt'> & { report?: CompanyTask['report']; work?: CompanyTask['work']; doneNote?: string | null }
/**
 * PM C10: three tiles. Tasks done this week; drafts approved (a task that came back for review and is now done), or
 * pull requests opened in a code company; plan use, which Claude doesn't report yet, said in words.
 */
export function weekTiles(tasks: readonly WeekTask[], o: { now: Date; code: boolean; waitingReview: number; paused: boolean; planPercent?: number | null }): WeekTile[] {
  const from = weekStart(o.now).getTime()
  const thisWeek = (t: WeekTask): boolean => Date.parse(t.updatedAt) >= from
  const done = tasks.filter((t) => t.status === 'done' && thisWeek(t)).length
  const tiles: WeekTile[] = [{ key: 'done', label: 'Tasks done', value: String(done), detail: o.paused ? 'this week, before the pause' : 'this week' }]
  if (o.code) {
    const prs = tasks.filter((t) => !!t.work?.pr && thisWeek(t)).length
    tiles.push({ key: 'prs', label: 'Pull requests', value: String(prs), detail: o.waitingReview ? `${o.waitingReview} waiting for your review` : 'opened this week' })
  } else {
    // approved = came back for review (a report), or approved from Home / the desk ("Approved: …")
    const approved = tasks.filter((t) => t.status === 'done' && (t.report?.outcome === 'review' || !!t.doneNote?.startsWith('Approved')) && thisWeek(t)).length
    tiles.push({ key: 'approved', label: 'Drafts approved', value: String(approved), detail: o.waitingReview ? `${o.waitingReview} waiting for you` : 'this week' })
  }
  tiles.push(
    o.planPercent != null
      ? { key: 'plan', label: 'Claude plan', value: `${Math.round(o.planPercent)}%`, detail: 'of this week used →' }
      : { key: 'plan', label: 'Claude plan', value: '—', detail: "Claude doesn't report plan limits yet →" }
  )
  return tiles
}
