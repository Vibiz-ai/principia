/**
 * Company chips and choosers for the scoped pages (COMPANY.md §8.3, C6). Pages never keep their own company selector:
 * they read the shell's focus through `useScope`, pass `scope` to every list call, show a chip per row in All mode,
 * and use `CompanyChooser` / `pickCompany` where an action needs one company.
 */
import { useMemo } from 'react'
import type { CompanyPassport } from '@shared/company'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { Id } from '@shared/types'
import { agentCompanyResolver, companyLabel, useActiveCompany, type ActiveCompany } from '../lib/company'
import { nativeMenu } from '../lib/hive'
import { indexAgents, type AgentIndex } from '../lib/live'
import { showChips } from '../lib/scope'
import { CompanyAvatar } from '../shell/CompanyRail'
import { useAgentIndex, useLiveTruth, useOpenAsks } from '../state/live'
import { useStore } from '../state/store'

export interface Scope {
  active: ActiveCompany
  /** the companyId list calls pass; undefined = All companies */
  scope: Id | undefined
  company: CompanyPassport | null
  companies: CompanyPassport[]
  /** more than Personal: the company UI exists at all */
  multi: boolean
  /** All mode with several companies: rows show a company chip */
  chips: boolean
  /** bumps on every focus change; key scoped loads on it */
  nonce: number
}

export function useScope(): Scope {
  const { active, company, scopeId, multi } = useActiveCompany()
  const companies = useStore((s) => s.companies)
  const nonce = useStore((s) => s.scopeNonce)
  return { active, scope: scopeId, company, companies, multi, chips: showChips(companies, active), nonce }
}

/** Avatar + name of a row's company. Rendered only in All mode unless `always` (session panes, drawers). */
export function CompanyChip({ companyId, always = false, avatarOnly = false, size = 14, className = '' }: { companyId: Id | null | undefined; always?: boolean; avatarOnly?: boolean; size?: number; className?: string }): React.JSX.Element | null {
  const companies = useStore((s) => s.companies)
  const active = useActiveCompany().active
  if (!(always ? companies.length >= 2 : showChips(companies, active))) return null
  const id = companyId || PERSONAL_COMPANY_ID
  const c = companies.find((x) => x.id === id)
  const name = c ? companyLabel(c) : 'Archived company'
  return (
    <span className={`co-chip ${avatarOnly ? 'co-chip--avatar' : ''} ${className}`} title={c ? companyLabel(c, true) : 'This company is archived'}>
      <CompanyAvatar company={{ id: c?.id, name, color: c?.color ?? 'var(--series-other)' }} size={size} />
      {!avatarOnly && <span className="co-chip__name">{name}</span>}
    </span>
  )
}

/**
 * All mode: a row owned by another component (agent rows, ask cards) gets its company avatar in a slim left column,
 * leaving the row itself untouched. Focused mode renders the row as is.
 */
export function CompanyTagged({ companyId, chips, children }: { companyId: Id | null | undefined; chips: boolean; children: React.ReactNode }): React.JSX.Element {
  if (!chips) return <>{children}</>
  return (
    <div className="co-tagged">
      <CompanyChip companyId={companyId} avatarOnly size={16} className="co-tagged__chip" />
      <div className="co-tagged__body">{children}</div>
    </div>
  )
}

/** Resolves a live agent's company (stamp, root, session, Personal), the same way the rail badges do. */
export function useAgentCompany(): (a: AgentNode | undefined) => Id {
  const agents = useStore((s) => s.agents)
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const resolve = agentCompanyResolver(Object.values(agents), sessions)
    return (a) => resolve(a)
  }, [agents, sessions])
}

/** Native menu of the listed companies; resolves the picked id or null. `exclude` greys out the current one. */
export async function pickCompany(companies: CompanyPassport[], opts: { title?: string; exclude?: Id | null } = {}): Promise<Id | null> {
  const id = await nativeMenu([
    ...(opts.title ? [{ id: '__title', label: opts.title, enabled: false }, { type: 'separator' as const }] : []),
    ...companies.map((c) => ({ id: c.id, label: companyLabel(c, true), enabled: c.id !== opts.exclude }))
  ])
  return id && id !== '__title' ? id : null
}

/** All mode "Pick a company" (§8.3) for pages whose rows are edited from inside one company. */
export function CompanyChooser({ title, text, onPick, companies: given }: { title: string; text: React.ReactNode; onPick: (id: Id) => void; companies?: CompanyPassport[] }): React.JSX.Element {
  const all = useStore((s) => s.companies)
  const companies = given ?? all
  return (
    <div className="co-chooser">
      <div className="co-chooser__title">{title}</div>
      <div className="co-chooser__text">{text}</div>
      <div className="co-chooser__grid">
        {companies.map((c) => (
          <button key={c.id} type="button" className="co-chooser__item" onClick={() => onPick(c.id)}>
            <CompanyAvatar company={c} size={28} />
            <span className="co-chooser__name">{companyLabel(c, true)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Live agents and open asks of the focused company (every company in All mode), for Home, Agents and Canvas. */
export function useScopedLive(scope: Id | undefined): { idx: AgentIndex; asks: Ask[] } {
  const all = useAgentIndex()
  const allAsks = useOpenAsks()
  // five doors A2: the same company resolution as LIVE, the rail and the counts (lib/liveTruth), so Chats › Live never
  // lists an agent another surface files under another company
  const truth = useLiveTruth()
  return useMemo(() => {
    if (!scope) return { idx: all, asks: allAsks }
    const agents = [...all.byId.values()].filter((a) => truth.companyOf(a.id) === scope)
    const askCo = new Map(truth.needs.filter((n) => n.askId).map((n) => [n.askId!, n.companyId]))
    return { idx: indexAgents(agents), asks: allAsks.filter((q) => (askCo.get(q.id) ?? truth.companyOf(q.agentId)) === scope) }
  }, [all, allAsks, truth, scope])
}
