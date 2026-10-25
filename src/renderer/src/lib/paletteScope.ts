/**
 * Five doors A1: what the ⌘K palette may list from live state. Inside a company it lists that company's asks, drafts,
 * working agents and running sessions only (never another client's); All companies (or "Search all companies")
 * lists every company's. Pure, so the leak test checks the same function the palette uses.
 */
import type { AuthorDraft } from '@shared/authoring'
import type { Ask } from '@shared/live'
import type { Id, Session } from '@shared/types'
import { companyOf, type LiveItem } from './companyModel'
import { workingIn, type LiveTruth } from './liveTruth'

export interface PaletteSources {
  /** open asks (approvals have their own Review row), oldest first, each with its company */
  asks: { ask: Ask; companyId: Id }[]
  drafts: AuthorDraft[]
  /** working roots (subagents folded into them), newest first */
  working: LiveItem[]
  sessions: Session[]
}

export function paletteSources(i: { asks: Iterable<Ask & { companyId?: Id | null }>; drafts: Iterable<AuthorDraft>; sessions: readonly Session[]; truth: LiveTruth }, scope: Id | undefined): PaletteSources {
  const own = (co: Id): boolean => !scope || co === scope
  const askCompany = new Map(i.truth.needs.filter((n) => n.askId).map((n) => [n.askId!, n.companyId]))
  const asks = [...i.asks]
    .filter((a) => a.status === 'open' && a.kind !== 'approval')
    .map((ask) => ({ ask, companyId: ask.companyId || askCompany.get(ask.id) || i.truth.companyOf(ask.agentId) }))
    .filter((x) => own(x.companyId))
    .sort((a, b) => (a.ask.createdAt < b.ask.createdAt ? -1 : 1))
  return {
    asks,
    drafts: [...i.drafts].filter((d) => d.status === 'pending' && own(companyOf(d))),
    working: workingIn(i.truth, scope ?? 'all').items,
    sessions: i.sessions.filter((s) => s.status === 'running' && own(companyOf(s)))
  }
}
