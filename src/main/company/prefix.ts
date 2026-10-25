/**
 * Five doors step 2: per-company task prefixes. Every company numbers its own tasks (NC-1, LA-1, HD-1), so an agency
 * never sees one client's task count in another's ids. Personal keeps PRN, so a Personal-only user sees no change.
 * Pure: the store persists the prefix and the counter in the company row JSON (`taskPrefix`, `taskSeq`).
 */
import { PERSONAL_COMPANY_ID } from '../../shared/company'

/** The prefix Personal keeps (the pre-company identifiers). Never handed to another company. */
export const PERSONAL_PREFIX = 'PRN'
export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,4}$/
/** "NC-12": a task identifier of any company (case-insensitive on input; stored uppercase). */
export const TASK_IDENT_RE = /^([A-Z][A-Z0-9]{1,4})-(\d{1,7})$/i

const letters = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9\s_\-./&]/g, '').toUpperCase()

/** Candidate prefixes for a company name, best first: word initials, then the first word's letters, then numbered. */
export function prefixCandidates(name: string): string[] {
  const words = letters(name).split(/[\s_\-./&]+/).filter(Boolean)
  const out: string[] = []
  const push = (p: string) => {
    if (PREFIX_RE.test(p) && !out.includes(p)) out.push(p)
  }
  if (words.length >= 2) push(words.slice(0, 3).map((w) => w[0]).join('').slice(0, 2))
  if (words.length >= 3) push(words.slice(0, 3).map((w) => w[0]).join(''))
  const first = words[0] ?? ''
  if (/^[A-Z]/.test(first)) {
    push(first.slice(0, 2))
    push(first.slice(0, 3))
    if (words[1]) push(first.slice(0, 2) + words[1][0])
  }
  const base = out[0] ?? 'CO'
  for (let i = 2; i < 100; i++) push(`${base.slice(0, 3)}${i}`)
  return out
}

/** The first free prefix for a company (PRN only for Personal; never one another company holds). */
export function pickPrefix(companyId: string, name: string, taken: ReadonlySet<string>): string {
  if (companyId === PERSONAL_COMPANY_ID) return PERSONAL_PREFIX
  for (const p of prefixCandidates(name)) if (p !== PERSONAL_PREFIX && !taken.has(p)) return p
  return `CO${Math.floor(taken.size + 1)}`
}

/** A prefix the founder typed: trimmed, uppercase; null when it is not 2-5 letters/digits starting with a letter. */
export function normalizePrefix(raw: string): string | null {
  const p = raw.trim().toUpperCase().replace(/-+$/, '')
  return PREFIX_RE.test(p) ? p : null
}
