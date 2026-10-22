/**
 * Launch step 5 (docs/ONBOARDING.md §7.2): the new company's first Passport notes, written through the vault writer as
 * user ops (`memory.applyOps(companyId, ops, {kind:'user'})`), so the policy's secret screens and the writer's
 * idempotence apply: replaying the same ops after a Retry is a no-op (createNote on an existing title, a duplicate
 * observe or relate line).
 *
 * - notes: Business, Products, Audience, Brand voice, Goals (first 30 days), and one `type: repo` note per repo;
 * - observe bullets from the answers, the scan (stack, README line) and the site read (title, description);
 * - relate: Business → Products / Audience / Brand voice / Goals / each repo, the company hub note → Business; the
 *   website as a Business property.
 *
 * A secret-screen refusal drops the scan and site excerpts and retries once (the founder's own answers stay).
 * No Electron imports.
 */
import { VIBE_INFO, type OnboardingAnswers, type ScanSummary, type SiteSummary } from '../../shared/onboarding'
import type { VaultApplyResult, VaultOp } from '../../shared/passport'

export const PASSPORT_NOTES = {
  business: 'Business',
  products: 'Products',
  audience: 'Audience',
  voice: 'Brand voice',
  goals: 'Goals (first 30 days)'
} as const

const GOAL_TEXT: Record<string, string> = {
  customers: 'Get first customers',
  website: 'Launch a website',
  social: 'Post on social',
  ads: 'Run ads',
  seo: 'Get found on Google',
  ship: 'Fix bugs and ship features',
  support: 'Customer support'
}

export interface PassportSeedInput {
  /** The company hub note's title (the company name, as seeded by the vault). */
  hubTitle: string
  answers: OnboardingAnswers
  scan?: ScanSummary
  site?: SiteSummary
  /** Names of the repos attached to the company (their notes go under Repos/). */
  repoNames: string[]
  /** false on the retry after a secret-screen hit: no scan or site excerpts. */
  excerpts: boolean
}

/** One line, trimmed and capped (observation bullets are single lines). */
export function oneLine(s: string | undefined | null, max = 400): string {
  const t = (s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** A note title safe for the vault (no path separators or wikilink brackets). */
export function noteTitle(s: string, fallback: string): string {
  const t = oneLine(s, 120).replace(/[\\/[\]|#^:*?"<>]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return t || fallback
}

function voiceLine(a: OnboardingAnswers): string {
  const parts: string[] = []
  if (a.voiceVibe) parts.push(`Sounds ${VIBE_INFO[a.voiceVibe].voice}.`)
  if (a.voiceText.trim()) parts.push(oneLine(a.voiceText, 600))
  return parts.join(' ')
}

/** The §7.2 step 5 ops. Pure. */
export function buildPassportOps(input: PassportSeedInput): VaultOp[] {
  const a = input.answers
  const N = PASSPORT_NOTES
  const ops: VaultOp[] = []
  const observe = (note: string, category: string, text: string) => {
    const t = oneLine(text, 500)
    if (t) ops.push({ op: 'observe', note, category, text: t })
  }
  const repos = [...new Set(input.repoNames.map((r) => noteTitle(r, '')).filter(Boolean))]

  ops.push({ op: 'createNote', title: N.business, type: 'concept', ...(oneLine(a.oneLiner, 280) ? { summary: oneLine(a.oneLiner, 280) } : {}) })
  ops.push({ op: 'createNote', title: N.products, type: 'product', ...(oneLine(a.products, 280) ? { summary: oneLine(a.products, 280) } : {}) })
  ops.push({ op: 'createNote', title: N.audience, type: 'customer', ...(oneLine(a.audience, 280) ? { summary: oneLine(a.audience, 280) } : {}) })
  ops.push({ op: 'createNote', title: N.voice, type: 'brand', ...(voiceLine(a) ? { summary: oneLine(voiceLine(a), 280) } : {}) })
  ops.push({ op: 'createNote', title: N.goals, type: 'concept', summary: 'What should happen in the first 30 days.' })
  for (const r of repos) ops.push({ op: 'createNote', title: r, type: 'repo' })

  // the founder's answers
  observe(N.business, 'fact', a.oneLiner)
  observe(N.products, 'fact', a.products)
  observe(N.audience, 'fact', a.audience)
  observe(N.voice, 'convention', voiceLine(a))
  if (a.avoid.trim()) observe(N.voice, 'convention', `Words to avoid: ${a.avoid}`)
  for (const g of a.goals) {
    const text = g === 'other' ? a.goalOther : GOAL_TEXT[g]
    if (text) observe(N.goals, 'goal', text)
  }
  if (a.instagram.trim()) observe(N.business, 'fact', `Instagram: ${a.instagram}`)
  observe(N.business, 'constraint', 'Never post, send, spend, deploy or sign up for anything without approval.')

  // scan and site excerpts (dropped on the retry after a secret-screen hit)
  if (input.excerpts) {
    if (input.scan?.stack.length) observe(N.business, 'fact', `Built with ${input.scan.stack.slice(0, 12).join(', ')}`)
    for (const r of input.scan?.repos ?? []) {
      const title = noteTitle(r.label.split('/').pop() ?? r.label, '')
      const target = repos.includes(title) ? title : null
      if (!target) continue
      if (r.stack.length) observe(target, 'fact', `Stack: ${r.stack.slice(0, 12).join(', ')}`)
      if (r.readmeLine || r.description) observe(target, 'fact', r.description || r.readmeLine || '')
    }
    if (input.site?.title || input.site?.ogTitle) observe(N.business, 'fact', `Website title: ${input.site.ogTitle || input.site.title}`)
    if (input.site?.description || input.site?.ogDescription) observe(N.business, 'fact', `Website says: ${input.site.ogDescription || input.site.description}`)
  }

  // the graph
  ops.push({ op: 'relate', from: N.business, rel: 'sells', to: N.products })
  ops.push({ op: 'relate', from: N.business, rel: 'serves', to: N.audience })
  ops.push({ op: 'relate', from: N.business, rel: 'speaks in', to: N.voice })
  ops.push({ op: 'relate', from: N.business, rel: 'aims for', to: N.goals })
  for (const r of repos) ops.push({ op: 'relate', from: N.business, rel: 'built in', to: r })
  const hub = oneLine(input.hubTitle, 160)
  if (hub && hub.toLowerCase() !== N.business.toLowerCase()) ops.push({ op: 'relate', from: hub, rel: 'described in', to: N.business })
  const site = oneLine(a.siteUrl || input.site?.url || '', 300)
  if (site) ops.push({ op: 'setProperty', note: N.business, key: 'website', value: site })
  return ops
}

/** The memory surface step 5 needs (MemoryService satisfies it). */
export interface PassportWriter {
  ensure(companyId: string): unknown
  applyOps(companyId: string, ops: VaultOp[], source?: { kind: 'user' }): Promise<VaultApplyResult>
}

/** True for the policy's secret / credential screen refusal (memory/policy.ts `screen`). */
export function isSecretScreenHit(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /stored secret|looks like a credential/i.test(m)
}

export interface PassportSeedResult {
  /** Vault-relative paths of the notes this call created (not the ones that already existed). */
  created: string[]
  /** The excerpts were dropped after a secret-screen hit. */
  excerptsDropped: boolean
}

/**
 * Ensures the vault, applies the ops, and on a secret-screen hit retries once without the scan/site excerpts. Any
 * other refusal (and a second hit) throws: the soft step fails with Retry / Continue without this.
 */
export async function seedPassport(memory: PassportWriter, companyId: string, input: Omit<PassportSeedInput, 'excerpts'>): Promise<PassportSeedResult> {
  memory.ensure(companyId)
  const created = (r: VaultApplyResult) =>
    r.results.filter((x, i) => x.status === 'ok' && x.path && ops[i]?.op === 'createNote').map((x) => x.path as string)
  let ops = buildPassportOps({ ...input, excerpts: true })
  try {
    return { created: created(await memory.applyOps(companyId, ops, { kind: 'user' })), excerptsDropped: false }
  } catch (e) {
    if (!isSecretScreenHit(e)) throw e
  }
  ops = buildPassportOps({ ...input, excerpts: false })
  return { created: created(await memory.applyOps(companyId, ops, { kind: 'user' })), excerptsDropped: true }
}
