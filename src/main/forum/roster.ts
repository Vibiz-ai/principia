/**
 * ORCHESTRATOR.md §1.1, §2: a company's agent teammates as an agent sees them ("@marcus (Brand Voice Writer,
 * Marketing)"), and finding one from what an agent wrote: a handle, a name, a role, or a mix ("Marcus", "Brand Voice
 * Writer", "Marcus, Brand Voice Writer", "Marcus (Brand Voice Writer, Marketing)"). Only ever inside one company: the
 * roster is built per company, so a name never reaches a seat of another company. Pure.
 */

export interface Teammate {
  memberId: string
  agentId: string
  handle: string
  /** the persona name ("Marcus"), else the role */
  name: string
  /** the seat's role label ("Brand Voice Writer") */
  role: string
  department: string | null
}

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** "@marcus (Brand Voice Writer, Marketing)"; the role is left out when it is the name. */
export function teammateLine(t: Teammate): string {
  const bits = [norm(t.role) !== norm(t.name) ? t.role : null, t.department].filter(Boolean)
  return `@${t.handle}${t.name && norm(t.name) !== norm(t.handle) ? ` ${t.name}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`
}

/**
 * The one teammate `raw` names, or null (nobody, or more than one fits). Each comma or bracket part must fit the same
 * teammate (its handle, name, first name, role or department), and at least one part must name the person (a
 * department alone is the caller's own fallback).
 */
export function findTeammate(roster: readonly Teammate[], raw: string): Teammate | null {
  const text = raw.trim().replace(/^[@#]/, '')
  if (!text) return null
  const whole = norm(text)
  const parts = text
    .split(/[,()[\]]|\s[-–—|/]\s/)
    .map((p) => norm(p.replace(/^[@#]/, '')))
    .filter(Boolean)
  if (!parts.length) return null
  type Fit = { t: Teammate; score: number }
  const fits: Fit[] = []
  for (const t of roster) {
    const handle = norm(t.handle)
    const name = norm(t.name)
    const first = name.split(' ')[0] ?? ''
    const role = norm(t.role)
    const dep = t.department ? norm(t.department) : ''
    // "Marcus Brand Voice Writer", "Brand Voice Writer Marcus": the name and the role in one part
    if (whole === `${name} ${role}` || whole === `${role} ${name}` || whole === handle || whole === name || whole === role) {
      fits.push({ t, score: whole === handle ? 5 : whole === name || whole === `${name} ${role}` || whole === `${role} ${name}` ? 4 : 3 })
      continue
    }
    let score = 0
    let person = false
    let ok = true
    for (const p of parts) {
      if (p === handle || p === name) { score += 3; person = true }
      else if (p === role) { score += 2; person = true }
      else if (first && p === first) { score += 1; person = true }
      else if (dep && p === dep) score += 0.5
      else { ok = false; break }
    }
    if (ok && person) fits.push({ t, score })
  }
  if (!fits.length) return null
  fits.sort((a, b) => b.score - a.score)
  if (fits.length > 1 && fits[0]!.score === fits[1]!.score) return null
  return fits[0]!.t
}
