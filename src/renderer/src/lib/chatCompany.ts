/**
 * "Start a company from this chat" (shared/chatCompany.ts), renderer side, pure: what the confirmation card shows
 * and what a confirmed card hands the onboarding (`ChatSeed`, applied by the reducer's `seedFromChat`).
 */
import { proposalBrief, type CompanyProposal, type EmblemVariant } from '@shared/chatCompany'
import type { FolderCandidate } from '@shared/onboarding'
import type { ChatSeed } from '../state/onboarding'
import { tildify } from './format'

/** The card's logo choice: a generated emblem, or the initial (Change Logo… later either way). */
export type CardLogo = { kind: 'emblem'; variant: EmblemVariant } | { kind: 'initials' }

export interface CardEdits {
  name: string
  brief: string
  logo: CardLogo
}

/** The card's starting values: the chat's name and brief (the website joins the brief), the arch emblem. */
export function cardDefaults(p: Pick<CompanyProposal, 'name' | 'brief' | 'website'>): CardEdits {
  return { name: p.name, brief: proposalBrief({ name: '', brief: p.brief, website: p.website }), logo: { kind: 'emblem', variant: 'arch' } }
}

/** What the card says about the logo. */
export function logoNote(p: Pick<CompanyProposal, 'repo'>, logo: CardLogo): string {
  if (p.repo) return logo.kind === 'emblem' ? 'The repo’s own logo is used when it has one; otherwise this emblem.' : 'The repo’s own logo is used when it has one; otherwise the initial.'
  return logo.kind === 'emblem' ? 'A line-art emblem. Change it any time with Change Logo….' : 'The initial on the coin. Change it any time with Change Logo….'
}

/** The repo line of the card ("~/code/bakery", "github.com/acme/bakery"). */
export function repoLabel(p: Pick<CompanyProposal, 'repo'>): string | null {
  if (!p.repo) return null
  if (p.repo.kind === 'url') return p.repo.url.replace(/^https:\/\//, '').replace(/\.git$/, '')
  return tildify(p.repo.path)
}

/**
 * A confirmed card → the onboarding seed. A local folder rides along only when the inspection allows it (not another
 * company's, not blocked); a clone link needs a folder to clone into. `skipped` says why a repo was left out.
 */
export function seedFor(
  p: Pick<CompanyProposal, 'id' | 'repo'>,
  edits: CardEdits,
  ctx: { candidate?: FolderCandidate | null; cloneDir?: string | null } = {}
): { seed: ChatSeed; skipped: string | null } {
  const name = edits.name.replace(/\s+/g, ' ').trim()
  const body = edits.brief.trim()
  const brief = name && !body.toLowerCase().startsWith(name.toLowerCase()) ? `${name}\n${body}`.trim() : body
  const seed: ChatSeed = {
    proposalId: p.id,
    name,
    brief,
    logo: edits.logo.kind === 'emblem' ? { variant: edits.logo.variant, keepDetected: !!p.repo } : null
  }
  let skipped: string | null = null
  if (p.repo?.kind === 'local') {
    const c = ctx.candidate
    if (!c) skipped = 'That folder could not be read, so the company starts without it.'
    else if (c.blockedReason) skipped = `${c.blockedReason}. The company starts without it.`
    else if (c.ownedBy && !c.ownedBy.personal) skipped = `That folder belongs to ${c.ownedBy.name}, so the company starts without it.`
    else seed.repo = c.existingRepoId ? { kind: 'local', path: c.path, existingRepoId: c.existingRepoId } : { kind: 'local', path: c.path }
  } else if (p.repo?.kind === 'url') {
    if (ctx.cloneDir?.startsWith('/')) seed.github = { url: p.repo.url, parentDir: ctx.cloneDir }
    else skipped = 'No folder to clone into, so the company starts without the repo. Add it later from the company.'
  }
  // a repo-less company keeps the plain emblem (nothing to detect)
  if (!seed.repo && !seed.github && seed.logo) seed.logo = { ...seed.logo, keepDetected: false }
  return { seed, skipped }
}
