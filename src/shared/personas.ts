/**
 * VOICE.md §4: agent personas. Presentation only: `CompanyAgent.name` stays the role label the router, prompts and
 * activity log use. Everything here is pure and deterministic so main (finalizePlan, departments.saveAgent) and the
 * renderer (resolvePersonas for legacy agents) always agree on who someone is.
 */
import type { CompanyAgent, Department, DepartmentPresetKey } from './company'
import type { PlanAgentRole } from './onboarding'
import { fnv1a, toRoman } from './roman'

/**
 * VOICE.md §5.4: the bust is pure line art, so `BustMaterial` and `BustDrape` are legacy keys kept as stored strings
 * (no migration, no face changes) and never rendered as colours:
 * - `material` = the **facing**: marble and bronze face right, travertine and terracotta face left (`FACING`);
 * - `drape` = the **drapery lines**: purple toga, terracotta cloak, gold tunic, marble herm (`DRAPE_LINE`).
 */
export type BustMaterial = 'marble' | 'travertine' | 'bronze' | 'terracotta'
export type BustHair = 'crop' | 'curls' | 'nodus' | 'wavy' | 'bun' | 'bald' | 'veil'
export type BustBeard = 'none' | 'stubble' | 'full'
export type BustDrape = 'purple' | 'terracotta' | 'gold' | 'marble'
export interface BustLook {
  /** legacy key: picks the facing (`FACING`), never a colour */
  material: BustMaterial
  hair: BustHair
  beard: BustBeard
  laurel: boolean
  /** legacy key: picks the drapery lines (`DRAPE_LINE`), never a colour */
  drape: BustDrape
}
export type BustFacing = 'left' | 'right'
export type BustDrapeLine = 'toga' | 'cloak' | 'tunic' | 'herm'
/** VOICE.md §5.4: which way the profile looks; a left-facing bust is the same drawing mirrored. */
export const FACING: Readonly<Record<BustMaterial, BustFacing>> = { marble: 'right', bronze: 'right', travertine: 'left', terracotta: 'left' }
/** VOICE.md §5.4: the drapery a stored drape key draws. */
export const DRAPE_LINE: Readonly<Record<BustDrape, BustDrapeLine>> = { purple: 'toga', terracotta: 'cloak', gold: 'tunic', marble: 'herm' }
export interface AgentPersona {
  /** curated key ('marcus') or 'custom' */
  key: string
  /** 1..24, renameable */
  name: string
  /** ≤ 120, one line */
  personality: string
  /** ≤ 400, two sentences */
  bio: string
  /** stored, so a list update never changes a face */
  look: BustLook
}
export interface PersonaDef extends Omit<AgentPersona, 'look'> {
  depts: DepartmentPresetKey[]
  roles: PlanAgentRole[]
  base: Pick<BustLook, 'hair' | 'beard'>
}

/** VOICE.md §4.2: limits for `companyAgentDataSchema.persona`. */
export const PERSONA_LIMITS = { key: 24, name: 24, personality: 120, bio: 400 } as const

export const BUST_MATERIALS: readonly BustMaterial[] = ['marble', 'travertine', 'bronze', 'terracotta']
export const BUST_HAIRS: readonly BustHair[] = ['crop', 'curls', 'nodus', 'wavy', 'bun', 'bald', 'veil']
export const BUST_BEARDS: readonly BustBeard[] = ['none', 'stubble', 'full']
export const BUST_DRAPES: readonly BustDrape[] = ['purple', 'terracotta', 'gold', 'marble']

const p = (
  key: string, name: string, depts: DepartmentPresetKey[], roles: PlanAgentRole[], hair: BustHair, beard: BustBeard,
  personality: string, bio: string
): PersonaDef => ({ key, name, personality, bio, depts, roles, base: { hair, beard } })

/** VOICE.md §4.3, in curated order. */
export const PERSONAS: readonly PersonaDef[] = [
  p('livia', 'Livia', ['development'], ['developer'], 'nodus', 'none', 'Ships quietly, tests loudly.', 'Reads the whole codebase before touching a line. Prefers small, reviewed changes over heroics.'),
  p('vitruvius', 'Vitruvius', ['development', 'marketing'], ['builder'], 'crop', 'full', 'Firmness, usefulness, delight. In that order.', 'Builds sites that load fast and age well. Will ask what the page is for before choosing a font.'),
  p('julia', 'Julia', ['development'], ['developer'], 'wavy', 'none', 'Refactors with a light hand.', "Leaves every file a little tidier than she found it. Writes the test first when nobody's watching."),
  p('decimus', 'Decimus', ['development'], ['developer'], 'curls', 'stubble', 'Counts edge cases like legions.', 'Lives for the empty string and the leap year. Will find the bug you thought was a feature.'),
  p('frontinus', 'Frontinus', ['development', 'ops'], ['developer', 'generalist'], 'bald', 'stubble', 'Fixes the plumbing nobody sees.', 'Keeps builds, deploys and logs flowing. Happiest when nothing happens.'),
  p('marcus', 'Marcus', ['marketing'], ['content'], 'crop', 'none', "Writes like he's late for the Forum.", "Turns your one-liner into posts people finish reading. Drafts three versions and tells you which he'd pick."),
  p('ovid', 'Ovid', ['marketing'], ['content'], 'curls', 'none', 'Turns features into stories.', 'Finds the human moment in every product update. Allergic to buzzwords.'),
  p('flavia', 'Flavia', ['marketing'], ['content', 'researcher'], 'bun', 'none', 'Has an opinion about your headline.', 'Tests five hooks before breakfast. Knows the difference between clever and clear, and picks clear.'),
  p('horace', 'Horace', ['marketing'], ['content'], 'wavy', 'stubble', 'Short lines, strong hooks.', 'Believes every sentence should earn its place. Edits his own drafts harder than you would.'),
  p('petronia', 'Petronia', ['marketing', 'sales'], ['researcher'], 'veil', 'none', 'Knows what the crowd wants by Tuesday.', "Watches competitors and trends so you don't have to. Brings receipts, not rumors."),
  p('aurelia', 'Aurelia', ['sales'], ['researcher', 'generalist'], 'nodus', 'none', 'Remembers every name and every no.', 'Researches leads, drafts outreach, follows up on time. Never sends anything without your nod.'),
  p('lucius', 'Lucius', ['sales'], ['generalist'], 'crop', 'stubble', 'Follow-ups on time, every time.', 'Keeps the pipeline moving one polite nudge at a time. Thinks a good CRM note is a gift to future you.'),
  p('valeria', 'Valeria', ['sales'], ['researcher'], 'wavy', 'none', 'Warm intros, sharp proposals.', "Writes proposals that answer the question before it's asked. Knows when to stop talking."),
  p('gaius', 'Gaius', ['sales'], ['researcher'], 'curls', 'full', 'Knows the lead before the lead knows.', 'Digs through sites, posts and press to prep every call. Hands you three talking points, not thirty.'),
  p('cicero', 'Cicero', ['sales', 'marketing'], ['content'], 'bald', 'none', 'Can argue either side, chooses yours.', "Drafts pitches and replies with a persuasive streak. Keeps it honest: no promises you can't keep."),
  p('cato', 'Cato', ['support'], ['support'], 'crop', 'full', 'Stern about accuracy, gentle with people.', 'Answers customers clearly and checks the facts twice. Escalates anything about money to you.'),
  p('cornelia', 'Cornelia', ['support'], ['support'], 'bun', 'none', 'Answers the question behind the question.', 'Turns repeat questions into help docs. Notices when three tickets are really one bug.'),
  p('felix', 'Felix', ['support'], ['support'], 'curls', 'none', 'Cheerful even on Mondays.', 'Triages the inbox fast and kindly. Hands off anything tricky with a tidy summary.'),
  p('clemens', 'Clemens', ['support'], ['support', 'generalist'], 'wavy', 'full', 'Calms the angriest inbox.', 'Drafts replies that de-escalate without grovelling. Never promises a refund on his own.'),
  p('seneca', 'Seneca', ['ops', 'finance'], ['generalist'], 'bald', 'full', 'Calm under deadlines. Writes the checklist first.', 'Runs recurring reports and internal processes. Believes most fires are just missing checklists.'),
  p('agrippa', 'Agrippa', ['ops'], ['generalist'], 'crop', 'stubble', 'Builds the roads everyone else uses.', 'Sets up tools, vendors and workflows so the team moves faster. Documents everything he touches.'),
  p('octavia', 'Octavia', ['ops'], ['generalist'], 'nodus', 'none', 'Runs a tight calendar.', 'Keeps hiring logistics, meetings and handoffs on track. Sends the agenda before you ask.'),
  p('atticus', 'Atticus', ['finance'], ['generalist'], 'curls', 'stubble', 'Keeps the ledgers and your secrets.', 'Prepares invoices, expenses and runway notes for your review. Never moves a coin himself.'),
  p('portia', 'Portia', ['finance'], ['researcher'], 'veil', 'none', 'Reads the fine print twice.', "Summarizes contracts, bills and terms into plain language. Flags the clause you'd have missed."),
  p('quintus', 'Quintus', ['finance', 'ops'], ['generalist'], 'crop', 'none', 'Five-year plan, quarterly check-ins.', 'Tracks metrics and turns them into a one-page monthly report. Likes charts that need no legend.'),
  p('pliny', 'Pliny', ['marketing', 'sales', 'ops'], ['researcher'], 'wavy', 'full', 'Takes notes on everything.', 'Researches markets, tools and competitors and writes it all down. Cites his sources.'),
  p('tacitus', 'Tacitus', ['ops', 'marketing'], ['researcher'], 'bald', 'stubble', 'Summarizes an empire in three lines.', "Reads long threads and reports so you don't have to. Brief to the point of rudeness, but never wrong."),
  p('junia', 'Junia', ['ops', 'support', 'development'], ['generalist'], 'bun', 'none', 'Does a bit of everything, well.', 'The first teammate in a new department. Picks up whatever needs doing and says what she skipped.'),
  p('claudia', 'Claudia', ['development', 'ops'], ['builder', 'developer'], 'veil', 'none', 'Measures twice, deploys once.', 'Owns releases and checklists. Rolls back without drama when something looks off.'),
  p('hortensia', 'Hortensia', ['sales', 'support'], ['content', 'support'], 'nodus', 'none', 'Speaks up, with good reasons.', 'Writes replies and pitches that are firm and fair. Named after the Roman orator who out-argued the triumvirs.')
]

/** VOICE.md §4.3 department pools; the first entry is the default for agents created later. */
export const DEPT_POOLS: Readonly<Record<DepartmentPresetKey, readonly string[]>> = {
  development: ['livia', 'vitruvius', 'julia', 'decimus', 'claudia', 'frontinus', 'junia'],
  marketing: ['marcus', 'ovid', 'flavia', 'horace', 'petronia', 'cicero', 'pliny', 'tacitus', 'vitruvius'],
  sales: ['aurelia', 'lucius', 'valeria', 'gaius', 'cicero', 'petronia', 'hortensia', 'pliny'],
  support: ['cato', 'cornelia', 'felix', 'clemens', 'hortensia', 'junia'],
  ops: ['seneca', 'agrippa', 'octavia', 'frontinus', 'quintus', 'tacitus', 'junia', 'claudia', 'pliny'],
  finance: ['atticus', 'seneca', 'portia', 'quintus']
}
/** Agents with no department. */
export const NO_DEPT_POOL: readonly string[] = ['junia', 'seneca', 'pliny']

/** VOICE.md §4.3 role pools (onboarding plan). */
export const ROLE_POOLS: Readonly<Record<PlanAgentRole, readonly string[]>> = {
  developer: ['livia', 'julia', 'decimus', 'claudia'],
  builder: ['vitruvius', 'claudia'],
  content: ['marcus', 'ovid', 'flavia', 'horace', 'cicero', 'hortensia'],
  researcher: ['pliny', 'aurelia', 'gaius', 'valeria', 'petronia', 'tacitus', 'portia'],
  support: ['cato', 'cornelia', 'felix', 'clemens'],
  generalist: ['junia', 'seneca', 'agrippa', 'lucius', 'octavia']
}

/** The "faces" of the brand always wear a laurel. */
export const LAUREL_ALWAYS: ReadonlySet<string> = new Set(['marcus', 'livia', 'aurelia', 'cato', 'seneca'])

const BY_KEY: ReadonlyMap<string, PersonaDef> = new Map(PERSONAS.map((d) => [d.key, d]))
export const personaDef = (key: string): PersonaDef | undefined => BY_KEY.get(key)

/**
 * The old same-colour pairs (marble drape on a marble or travertine bust, terracotta on terracotta, §4.1). Busts are
 * line art now and these keys are a facing and a drapery, but the redraw stays so `lookFor` keeps every existing
 * persona's face and the variety stays evenly spread.
 */
const SAME_COLOUR: Partial<Record<BustMaterial, BustDrape>> = { marble: 'marble', travertine: 'marble', terracotta: 'terracotta' }

/**
 * VOICE.md §4.1: the curated hair and beard, the rest from fnv1a(seed) with seed = companyId + ':' + agentRef.
 * `material` picks the facing and `drape` the drapery lines (§5.4); a drape on an old same-colour pair is redrawn
 * from the other three, exactly as before, so no stored or derived face changes.
 */
export function lookFor(def: PersonaDef, seed: string): BustLook {
  const h = fnv1a(seed)
  const material = BUST_MATERIALS[h % 4]
  let drape = BUST_DRAPES[(h >>> 3) % 4]
  if (SAME_COLOUR[material] === drape) {
    const others = BUST_DRAPES.filter((d) => d !== drape)
    drape = others[(h >>> 9) % others.length]
  }
  const laurel = (h >>> 6) % 3 === 0 || LAUREL_ALWAYS.has(def.key)
  return { material, hair: def.base.hair, beard: def.base.beard, laurel, drape }
}

export interface PickPersonaInput {
  departmentKey: DepartmentPresetKey | null
  role?: PlanAgentRole
  /** persona names already taken in the company (compared case-insensitively) */
  used: ReadonlySet<string>
  /**
   * names other companies' agents already have: avoided while a free name is left, so an agency's clients never seem
   * to share one Marcus (five doors round 2, Priya). Soft: when every name is used somewhere, a repeat across companies
   * beats a numeral; within one company names stay unique.
   */
  avoid?: ReadonlySet<string>
  /** companyId + ':' + agentRef; only the look depends on it */
  seed: string
}

function persona(def: PersonaDef, seed: string, name = def.name): AgentPersona {
  return { key: def.key, name, personality: def.personality, bio: def.bio, look: lookFor(def, seed) }
}

/**
 * VOICE.md §4.1, deterministic: role pool, then department pool, then every persona, first unused name wins. When
 * all are used, the department's first persona gets the smallest free numeral ("Marcus II").
 */
export function pickPersona(i: PickPersonaInput): AgentPersona {
  const used = new Set<string>()
  for (const n of i.used) used.add(n.trim().toLowerCase())
  const dept = i.departmentKey && DEPT_POOLS[i.departmentKey] ? DEPT_POOLS[i.departmentKey] : NO_DEPT_POOL
  const order = [...(i.role ? ROLE_POOLS[i.role] ?? [] : []), ...dept, ...PERSONAS.map((d) => d.key)]
  if (i.avoid?.size) {
    const avoid = new Set([...i.avoid].map((n) => n.trim().toLowerCase()))
    for (const key of order) {
      const def = BY_KEY.get(key)
      if (def && !used.has(def.name.toLowerCase()) && !avoid.has(def.name.toLowerCase())) return persona(def, i.seed)
    }
  }
  for (const key of order) {
    const def = BY_KEY.get(key)
    if (def && !used.has(def.name.toLowerCase())) return persona(def, i.seed)
  }
  const def = BY_KEY.get(dept[0])!
  for (let n = 2; n <= 3999; n++) {
    const name = `${def.name} ${toRoman(n)}`
    if (!used.has(name.toLowerCase())) return persona(def, i.seed, name)
  }
  // 3998 numbered copies of one name: unreachable in practice, but never loop forever or throw
  return persona(def, i.seed, `${def.name} ${used.size + 1}`.slice(0, PERSONA_LIMITS.name))
}

// ---------- resolving (stored first, then display-only personas for legacy agents) ----------

export type PersonaAgentLike = Pick<CompanyAgent, 'id' | 'companyId' | 'departmentId' | 'name' | 'archivedAt' | 'createdAt'> & { data?: unknown }
export type PersonaDepartmentLike = Pick<Department, 'id' | 'key'>

const isLook = (v: unknown): v is BustLook => {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  return (
    (BUST_MATERIALS as readonly unknown[]).includes(l.material) &&
    (BUST_HAIRS as readonly unknown[]).includes(l.hair) &&
    (BUST_BEARDS as readonly unknown[]).includes(l.beard) &&
    (BUST_DRAPES as readonly unknown[]).includes(l.drape) &&
    typeof l.laurel === 'boolean'
  )
}

/** `data.persona` when it is well-formed (VOICE.md §4.2: a stored persona that fails to parse is dropped). */
export function storedPersona(agent: { data?: unknown } | null | undefined): AgentPersona | null {
  const data = agent?.data
  const p = data && typeof data === 'object' ? (data as { persona?: unknown }).persona : undefined
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (
    typeof o.key !== 'string' || o.key.length > PERSONA_LIMITS.key ||
    !name || name.length > PERSONA_LIMITS.name ||
    typeof o.personality !== 'string' || o.personality.length > PERSONA_LIMITS.personality ||
    typeof o.bio !== 'string' || o.bio.length > PERSONA_LIMITS.bio ||
    !isLook(o.look)
  ) return null
  return { key: o.key, name, personality: o.personality, bio: o.bio, look: { ...o.look } }
}

const byCreated = (a: PersonaAgentLike, b: PersonaAgentLike): number => {
  const ca = a.createdAt ?? ''
  const cb = b.createdAt ?? ''
  return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
// type-only import of company.ts: it imports this module for the persona schema, so no value import back
const presetKey = (key: string): DepartmentPresetKey | null =>
  Object.prototype.hasOwnProperty.call(DEPT_POOLS, key) ? (key as DepartmentPresetKey) : null

/**
 * agentId -> persona for every agent. Per company: stored personas first (they reserve their names), then the rest
 * in createdAt order via pickPersona. Archived agents still get a face but never reserve a name, so no two
 * non-archived agents of a company share one. Shared so main (departments.saveAgent, onboarding) can reserve the
 * names legacy agents already display, and a new agent never takes a name someone is shown with.
 */
export function resolvePersonas(
  agents: readonly PersonaAgentLike[],
  departments: readonly PersonaDepartmentLike[] = []
): Map<string, AgentPersona> {
  const deptKey = new Map<string, DepartmentPresetKey | null>(departments.map((d) => [d.id, presetKey(d.key)]))
  const out = new Map<string, AgentPersona>()
  const byCompany = new Map<string, PersonaAgentLike[]>()
  for (const a of agents) {
    const list = byCompany.get(a.companyId)
    if (list) list.push(a)
    else byCompany.set(a.companyId, [a])
  }
  for (const [companyId, list] of byCompany) {
    const sorted = [...list].sort(byCreated)
    const used = new Set<string>()
    const pending: PersonaAgentLike[] = []
    for (const a of sorted) {
      const p = storedPersona(a)
      // a stored duplicate (two rows edited to the same name) keeps the earliest; the later one is re-resolved
      if (p && (a.archivedAt || !used.has(p.name.toLowerCase()))) {
        out.set(a.id, p)
        if (!a.archivedAt) used.add(p.name.toLowerCase())
      } else pending.push(a)
    }
    const active = pending.filter((a) => !a.archivedAt)
    const archived = pending.filter((a) => a.archivedAt)
    for (const a of [...active, ...archived]) {
      const p = pickPersona({
        departmentKey: a.departmentId ? deptKey.get(a.departmentId) ?? null : null,
        used,
        seed: `${companyId}:${a.id}`
      })
      out.set(a.id, p)
      if (!a.archivedAt) used.add(p.name.toLowerCase())
    }
  }
  return out
}

/** The names every other company's non-archived agents are shown with: pickPersona's `avoid` for a new agent. */
export function personaNamesElsewhere(
  companyId: string | null,
  agents: readonly PersonaAgentLike[],
  departments: readonly PersonaDepartmentLike[] = []
): Set<string> {
  const others = agents.filter((a) => a.companyId !== companyId && !a.archivedAt)
  const resolved = resolvePersonas(others, departments)
  const out = new Set<string>()
  for (const a of others) {
    const p = resolved.get(a.id)
    if (p) out.add(p.name.toLowerCase())
  }
  return out
}

/**
 * The names a company's non-archived agents are shown with (stored or resolved), lowercased: the `used` set for
 * pickPersona when main creates an agent. `exceptId` leaves one agent out (its own name when it is renamed); the
 * others keep the names they resolve to with it present, so leaving it out never shifts anyone else's name.
 */
export function usedPersonaNames(
  companyId: string,
  agents: readonly PersonaAgentLike[],
  departments: readonly PersonaDepartmentLike[] = [],
  exceptId?: string
): Set<string> {
  const mine = agents.filter((a) => a.companyId === companyId)
  const resolved = resolvePersonas(mine, departments)
  const used = new Set<string>()
  for (const a of mine) {
    if (exceptId && a.id === exceptId) continue
    const p = resolved.get(a.id)
    if (p && !a.archivedAt) used.add(p.name.toLowerCase())
  }
  return used
}
