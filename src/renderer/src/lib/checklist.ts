/**
 * AUTOPILOT.md §2: the "Get the most out of Principia" checklist on a company's Home. Pure (no store, no React): the
 * card loads the real state and passes it in; every item is checked by what exists, never by a click. Items whose
 * state is still loading (`null` inputs) are left unchecked and marked `pending`, so a slow call never flashes a
 * false "done".
 *
 * Dismiss and collapse are per-viewer conveniences in localStorage (CHECKLIST_KEY), parsed by parseChecklistPrefs.
 */
import { type CompanyAgent, type CompanyPassport, type Department, type DepartmentPresetKey } from '@shared/company'
import type { DashboardKind } from '@shared/dashboards'
import { departmentFor, type AutopilotId, type CompanyAutopilots } from '@shared/autopilot'
import type { SocialStatus } from '@shared/socials'
import type { Id } from '@shared/types'

export type ChecklistItemId =
  | 'logo' | 'passport' | 'repo' | 'departments' | 'agents' | 'marketingDashboards' | 'financeDashboards' | 'socials' | 'vibiz' | 'slack' | 'schedule' | 'autopilot'

/** What the item's button does. The card maps each to a navigation or a sheet. */
export type ChecklistAction =
  | { kind: 'logo' }
  | { kind: 'passport' }
  | { kind: 'repo' }
  | { kind: 'enableDepartments' }
  | { kind: 'addDepartments'; keys: DepartmentPresetKey[] }
  | { kind: 'department'; departmentId: Id; focus: 'agents' | 'dashboards' }
  | { kind: 'socials' }
  | { kind: 'vibiz'; present: boolean }
  | { kind: 'slack' }
  | { kind: 'schedule' }
  | { kind: 'autopilot'; id: AutopilotId }

export interface ChecklistItem {
  id: ChecklistItemId
  title: string
  detail: string
  done: boolean
  /** its inputs are still loading */
  pending?: boolean
  /** e.g. 2 of 3 departments staffed */
  progress?: { n: number; of: number }
  action: ChecklistAction
  actionLabel: string
}

export type VibizState = 'connected' | 'connecting' | 'signed-out' | 'error' | 'missing'
export type SlackSetup = 'connected' | 'set-up' | 'none' | 'unavailable'

export interface ChecklistInput {
  company: Pick<CompanyPassport, 'id' | 'name' | 'mission'>
  hasLogo: boolean
  repoCount: number
  departmentsOn: boolean
  departments: readonly Department[]
  agents: readonly CompanyAgent[]
  /** null = still loading */
  dashboards: readonly { kind: DashboardKind; departmentId: Id | null }[] | null
  socials: readonly SocialStatus[] | null
  vibiz: VibizState | null
  slack: SlackSetup | null
  scheduleCount: number | null
  autopilots: CompanyAutopilots | undefined
  /**
   * Five doors step 3 (design §4.1): only the steps that fit this company. A business with no repository never sees
   * "Connect a repository"; Stripe is suggested only when Finance exists, Search Console only when Marketing does.
   */
  typed?: boolean
}

const MARKETING_KINDS: DashboardKind[] = ['gsc', 'geo']

function dashboardItem(i: ChecklistInput, id: 'marketingDashboards' | 'financeDashboards'): ChecklistItem {
  const dept: DepartmentPresetKey = id === 'marketingDashboards' ? 'marketing' : 'finance'
  const kinds: DashboardKind[] = id === 'marketingDashboards' ? MARKETING_KINDS : ['stripe']
  const title = id === 'marketingDashboards' ? 'Track SEO and AI visibility in Marketing' : 'Track revenue with Stripe in Finance'
  const detail =
    id === 'marketingDashboards'
      ? 'Add the Search Console or GEO dashboard. Marketing agents read the numbers in every task.'
      : 'Add the Stripe dashboard (a read-only restricted key): MRR, new and churned customers, failed payments.'
  const d = departmentFor({ companyId: i.company.id, departments: i.departments }, dept)
  if (!i.departmentsOn) return { id, title, detail, done: false, action: { kind: 'enableDepartments' }, actionLabel: 'Turn on departments' }
  if (!d) return { id, title, detail, done: false, action: { kind: 'addDepartments', keys: [dept] }, actionLabel: `Add ${dept === 'marketing' ? 'Marketing' : 'Finance'}` }
  if (i.dashboards === null) return { id, title, detail, done: false, pending: true, action: { kind: 'department', departmentId: d.id, focus: 'dashboards' }, actionLabel: 'Add dashboard' }
  const done = i.dashboards.some((x) => kinds.includes(x.kind) && x.departmentId === d.id)
  return { id, title, detail, done, action: { kind: 'department', departmentId: d.id, focus: 'dashboards' }, actionLabel: done ? 'Open' : 'Add dashboard' }
}

/** Every item, in the order the card shows them. */
export function checklistItems(i: ChecklistInput): ChecklistItem[] {
  const co = i.company
  const deps = i.departments.filter((d) => d.companyId === co.id && !d.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  // a paused seat is still hired (§2.6: pausing never reads as missing, the checklist does not go backwards)
  const seats = i.agents.filter((a) => a.companyId === co.id && !a.archivedAt)
  const staffed = deps.filter((d) => seats.some((a) => a.departmentId === d.id))
  const firstEmpty = deps.find((d) => !staffed.includes(d))
  const readySocials = i.socials?.filter((s) => s.ready) ?? []
  const anyAutopilot = !!i.autopilots && Object.values(i.autopilots).some(Boolean)
  const items: ChecklistItem[] = [
    { id: 'logo', title: 'Add your logo', detail: i.repoCount > 0 ? 'Shown on the rail, the sidebar and the Portfolio. Picked from your repositories or a file.' : 'Shown on the rail, the sidebar and the Portfolio. Pick an image file.', done: i.hasLogo, action: { kind: 'logo' }, actionLabel: i.hasLogo ? 'Change' : 'Choose logo' },
    { id: 'passport', title: 'Write your mission', detail: 'The Passport tells every agent what the company does, for whom and in which voice.', done: !!co.mission?.trim(), action: { kind: 'passport' }, actionLabel: co.mission?.trim() ? 'Edit' : 'Write it' },
    { id: 'repo', title: 'Connect a repository', detail: 'Development agents work in your code; the logo and stack are read from it.', done: i.repoCount > 0, action: { kind: 'repo' }, actionLabel: i.repoCount > 0 ? 'Add another' : 'Add repository' },
    !i.departmentsOn
      ? { id: 'departments', title: 'Turn on departments', detail: 'Departments, agent seats, the board and dashboards. Settings → Experimental.', done: false, action: { kind: 'enableDepartments' }, actionLabel: 'Turn on' }
      : { id: 'departments', title: 'Set up departments', detail: 'Marketing, Sales, Finance, Development… each with a charter, agents and dashboards.', done: deps.length > 0, action: { kind: 'addDepartments', keys: ['marketing', 'development', 'finance'] }, actionLabel: deps.length ? 'Add more' : 'Add departments' },
    {
      id: 'agents',
      title: 'Hire an agent in every department',
      detail: deps.length ? (firstEmpty ? `${firstEmpty.name} has no agent yet: its tasks wait for you.` : 'Every department has at least one agent.') : 'Add a department first.',
      done: i.departmentsOn && deps.length > 0 && staffed.length === deps.length,
      progress: deps.length ? { n: staffed.length, of: deps.length } : undefined,
      action: !i.departmentsOn ? { kind: 'enableDepartments' } : firstEmpty ? { kind: 'department', departmentId: firstEmpty.id, focus: 'agents' } : deps[0] ? { kind: 'department', departmentId: deps[0].id, focus: 'agents' } : { kind: 'addDepartments', keys: ['marketing', 'development', 'finance'] },
      actionLabel: !i.departmentsOn ? 'Turn on departments' : firstEmpty ? `Add agent to ${firstEmpty.name}` : deps.length ? 'Open' : 'Add departments'
    },
    dashboardItem(i, 'marketingDashboards'),
    dashboardItem(i, 'financeDashboards'),
    {
      id: 'socials',
      title: 'Connect your social channels',
      detail: i.socials === null ? 'X, LinkedIn, Instagram, TikTok, YouTube.' : readySocials.length ? `${readySocials.map((s) => s.name).join(', ')} ready. Agents draft for review; nothing posts unless you allow it per channel.` : 'Instagram, X, LinkedIn, TikTok, YouTube. Until one is connected, agents get each post ready for you to post.',
      done: readySocials.length > 0,
      pending: i.socials === null,
      progress: i.socials ? { n: readySocials.length, of: i.socials.length } : undefined,
      action: { kind: 'socials' },
      actionLabel: readySocials.length ? 'Manage' : 'Connect'
    },
    {
      id: 'vibiz',
      title: 'Sign in to Vibiz',
      detail: i.vibiz === 'error' ? 'The last sign-in failed. Try again.' : i.vibiz === 'connecting' ? 'Finish signing in in your browser.' : 'Brand kit, ad creatives and campaign analytics for your agents.',
      done: i.vibiz === 'connected',
      pending: i.vibiz === null,
      action: { kind: 'vibiz', present: i.vibiz !== 'missing' },
      actionLabel: i.vibiz === 'connected' ? 'Manage' : i.vibiz === 'missing' ? 'Add connection' : 'Sign in'
    },
    {
      id: 'slack',
      title: 'Connect Slack',
      detail: i.slack === 'set-up' ? 'Slack is set up but not connected right now.' : 'Agents read threads and draft replies; alerts reach you in Slack.',
      done: i.slack === 'connected',
      pending: i.slack === null,
      action: { kind: 'slack' },
      actionLabel: i.slack === 'connected' ? 'Open' : 'Connect'
    },
    { id: 'schedule', title: 'Add a schedule', detail: 'Run a workflow or an agent prompt on a cadence, like a weekly report.', done: (i.scheduleCount ?? 0) > 0, pending: i.scheduleCount === null, action: { kind: 'schedule' }, actionLabel: (i.scheduleCount ?? 0) > 0 ? 'Open' : 'New schedule' },
    {
      id: 'autopilot',
      title: 'Turn on a schedule pack',
      detail: 'Marketing or Company: ready-made schedules and recurring agent tasks, built from what you connected above.',
      done: anyAutopilot,
      action: { kind: 'autopilot', id: i.autopilots?.marketing || !i.autopilots?.company ? 'marketing' : 'company' },
      actionLabel: anyAutopilot ? 'Open' : 'See schedule packs'
    }
  ]
  if (!i.typed) return items
  const has = (key: DepartmentPresetKey): boolean => !!departmentFor({ companyId: co.id, departments: i.departments }, key)
  return items.filter((x) => (x.id === 'repo' ? i.repoCount > 0 : x.id === 'financeDashboards' ? i.departmentsOn && has('finance') : x.id === 'marketingDashboards' ? i.departmentsOn && has('marketing') : true))
}

export function checklistProgress(items: readonly ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((x) => x.done).length, total: items.length }
}

/** The first unchecked item (the card highlights it as "Next"). */
export function nextItem(items: readonly ChecklistItem[]): ChecklistItem | null {
  return items.find((x) => !x.done && !x.pending) ?? null
}

// ---------- per-viewer prefs ----------

export const CHECKLIST_KEY = 'principia.checklist.v1'
export interface ChecklistPref {
  collapsed?: boolean
  /** ISO time the card was dismissed; it comes back from the palette ("Show setup checklist") */
  dismissedAt?: string
}
export type ChecklistPrefs = Record<Id, ChecklistPref>

export function parseChecklistPrefs(raw: unknown): ChecklistPrefs {
  const out: ChecklistPrefs = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const r = v as Record<string, unknown>
    const p: ChecklistPref = {}
    if (typeof r.collapsed === 'boolean') p.collapsed = r.collapsed
    if (typeof r.dismissedAt === 'string') p.dismissedAt = r.dismissedAt
    out[id] = p
  }
  return out
}
