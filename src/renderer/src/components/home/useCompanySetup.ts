/**
 * AUTOPILOT.md §2: the real state behind the setup checklist and the autopilot sheets, for one company. Store slices
 * (company, logo, repos, departments, agents, profiles, settings, Slack) plus four calls main answers (MCP connections,
 * keys, dashboards, schedules), reloaded on their data:changed domain and when the window regains focus (an OAuth
 * sign-in finishes in the browser).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GatewayConnection } from '@shared/gateway'
import { VIBIZ_CONNECTION_ID } from '@shared/gateway'
import type { InstalledDashboard } from '@shared/dashboards'
import { configList } from '@shared/dashboards'
import type { Id, Schedule } from '@shared/types'
import { connectionReaches, socialStatuses, type SocialStatus } from '@shared/socials'
import type { AutopilotContext, CompanyAutopilots } from '@shared/autopilot'
import { hive, useHiveEvent } from '../../lib/hive'
import { reposOf } from '../../lib/companyModel'
import { checklistItems, type ChecklistItem, type SlackSetup, type VibizState } from '../../lib/checklist'
import { departmentsOn, useStore } from '../../state/store'
import { isConnected, isSetUp, useSlack } from '../../state/slack'

export interface CompanySetup {
  items: ChecklistItem[]
  socials: SocialStatus[] | null
  keyNames: Set<string>
  connections: GatewayConnection[] | null
  dashboards: InstalledDashboard[] | null
  schedules: Schedule[] | null
  autopilots: CompanyAutopilots | undefined
  /** the planning context for autopilots (null until the company is known) */
  ctx: AutopilotContext | null
  reload: () => void
  /** poll the connections for a while (an OAuth sign-in in the browser) */
  watchConnections: () => void
}

export function vibizState(connections: readonly GatewayConnection[] | null, companyId: Id): VibizState | null {
  if (!connections) return null
  const c = connections.find((x) => x.id === VIBIZ_CONNECTION_ID)
  if (!c) return 'missing'
  if (!connectionReaches(c, companyId)) return 'signed-out'
  if (c.authStatus === 'connected' || (c.authentication !== 'oauth' && c.hasCredentials)) return 'connected'
  if (c.authStatus === 'connecting') return 'connecting'
  if (c.authStatus === 'error') return 'error'
  return 'signed-out'
}

export function useCompanySetup(companyId: Id): CompanySetup {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const logo = useStore((s) => s.companyLogos[companyId])
  const allRepos = useStore((s) => s.repos)
  const departments = useStore((s) => s.departments)
  const agents = useStore((s) => s.companyAgents)
  const profiles = useStore((s) => s.profiles)
  const settings = useStore((s) => s.settings)
  const depsOn = useStore((s) => departmentsOn(s))
  const slackAvailable = useSlack((s) => s.available)
  const slackStatus = useSlack((s) => s.status)

  const [connections, setConnections] = useState<GatewayConnection[] | null>(null)
  const [keyNames, setKeyNames] = useState<Set<string> | null>(null)
  const [dashboards, setDashboards] = useState<InstalledDashboard[] | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const alive = useRef(true)
  // set on mount too: StrictMode mounts, unmounts and mounts again
  useEffect(() => {
    alive.current = true
    return () => void (alive.current = false)
  }, [])

  // five doors A1: this company's connections only (shared ones plus its own)
  const loadConnections = useCallback(() => void hive.gateway.list({ companyId }).then((c) => alive.current && setConnections(c), () => alive.current && setConnections((x) => x ?? [])), [companyId])
  const loadKeys = useCallback(() => {
    // `{ companyId: null }` is Shared only; no argument would list every company's keys
    void Promise.all([hive.secrets.list({ companyId }), hive.secrets.list({ companyId: null })]).then(
      ([own, shared]) => alive.current && setKeyNames(new Set([...own, ...shared].map((k) => k.name))),
      () => alive.current && setKeyNames((x) => x ?? new Set())
    )
  }, [companyId])
  const loadDashboards = useCallback(() => {
    if (!depsOn) return setDashboards([])
    void hive.dashboards.list({ companyId }).then((d) => alive.current && setDashboards(d), () => alive.current && setDashboards((x) => x ?? []))
  }, [companyId, depsOn])
  const loadSchedules = useCallback(() => void hive.schedules.list({ companyId }).then((s) => alive.current && setSchedules(s), () => alive.current && setSchedules((x) => x ?? [])), [companyId])
  const reload = useCallback(() => {
    loadConnections()
    loadKeys()
    loadDashboards()
    loadSchedules()
  }, [loadConnections, loadKeys, loadDashboards, loadSchedules])

  useEffect(() => {
    setConnections(null)
    setKeyNames(null)
    setDashboards(null)
    setSchedules(null)
    reload()
  }, [reload])
  useHiveEvent('data:changed', ({ domain }) => {
    if (domain === 'secrets') loadKeys()
    else if (domain === 'dashboards') loadDashboards()
    else if (domain === 'schedules' || domain === 'workflows') loadSchedules()
  })
  useHiveEvent('schedule:updated', () => loadSchedules())
  useEffect(() => {
    const onFocus = (): void => loadConnections()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadConnections])

  // after "Sign in to Vibiz": the browser finishes the OAuth flow; poll for two minutes, stop once connected
  const pollUntil = useRef(0)
  const [polling, setPolling] = useState(false)
  const watchConnections = useCallback(() => {
    pollUntil.current = Date.now() + 120_000
    setPolling(true)
  }, [])
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => {
      if (Date.now() > pollUntil.current) return setPolling(false)
      loadConnections()
    }, 2000)
    return () => clearInterval(t)
  }, [polling, loadConnections])
  const vibiz = vibizState(connections, companyId)
  useEffect(() => {
    if (polling && vibiz === 'connected') setPolling(false)
  }, [polling, vibiz])

  const socials = useMemo(() => (connections && keyNames ? socialStatuses(companyId, keyNames, connections, company?.accounts) : null), [companyId, connections, keyNames, company?.accounts])
  const autopilots = settings?.autopilots?.[companyId]
  const slack: SlackSetup | null = slackAvailable === false ? 'unavailable' : slackAvailable === null ? null : isConnected(slackStatus) ? 'connected' : isSetUp(slackStatus) ? 'set-up' : 'none'
  const repoCount = useMemo(() => reposOf(allRepos, companyId).length, [allRepos, companyId])

  const items = useMemo(
    () =>
      company
        ? checklistItems({
            company,
            hasLogo: !!logo?.dataUrl,
            repoCount,
            departmentsOn: depsOn,
            departments,
            agents,
            dashboards,
            socials,
            vibiz,
            slack,
            scheduleCount: schedules ? schedules.length : null,
            autopilots,
            typed: true
          })
        : [],
    [company, logo, repoCount, depsOn, departments, agents, dashboards, socials, vibiz, slack, schedules, autopilots]
  )

  const ctx = useMemo<AutopilotContext | null>(
    () =>
      company
        ? {
            companyId,
            companyName: company.name,
            departmentsOn: depsOn,
            departments,
            agents,
            dashboards: (dashboards ?? []).map((d) => ({ kind: d.kind, departmentId: d.departmentId, competitors: d.kind === 'geo' ? configList(d.config.competitors) : undefined })),
            socials: socials ?? [],
            profiles,
            defaultAdapter: settings?.defaultAdapter ?? 'claude',
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            passport: { mission: company.mission, audience: company.audience, products: company.products }
          }
        : null,
    [company, companyId, depsOn, departments, agents, dashboards, socials, profiles, settings?.defaultAdapter]
  )

  return { items, socials, keyNames: keyNames ?? new Set(), connections, dashboards, schedules, autopilots, ctx, reload, watchConnections }
}
