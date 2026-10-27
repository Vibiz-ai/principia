/**
 * shared/deepLink.ts → the view a principia:// link opens. Pure: the store does the company switch. Every result is a
 * place to look at; nothing here files, connects, approves or sends.
 */
import type { CompanyTask } from '@shared/company'
import { SERVICE_REGISTRY } from '@shared/services'
import { parseDeepLink, type DeepLink } from '@shared/deepLink'
import { cadenceOf, isRoutineId, parseAt, parseDays, routineDef, routineTimeOf, type RoutineId, type RoutineTime } from '@shared/routines'
import { isPlaybookId, playbookDef } from '@shared/autopilotPlaybooks'
import type { Id } from '@shared/types'
import type { NavTarget } from './nav'

/** An `NC-12` identifier or a task id → the task id of that company's board (null = not on it). */
export function resolveTaskRef(ref: string, tasks: readonly Pick<CompanyTask, 'id' | 'identifier' | 'companyId'>[], companyId: Id | null): Id | null {
  const t = tasks.find((x) => (x.id === ref || (x.identifier ?? '').toUpperCase() === ref.toUpperCase()) && (!companyId || x.companyId === companyId))
  return t?.id ?? null
}

export function deepLinkView(l: DeepLink, o: { nonce: number; taskId?: Id | null }): NavTarget {
  switch (l.kind) {
    case 'connect':
      return { name: 'settings', section: 'connections', connect: l.tool, ...(l.purpose ? { purpose: l.purpose } : {}), nonce: o.nonce }
    case 'settings':
      return { name: 'settings', section: l.section, nonce: o.nonce }
    case 'board':
      if (l.newTitle) return { name: 'tasks', quick: { title: l.newTitle, nonce: o.nonce } }
      return o.taskId ? { name: 'tasks', taskId: o.taskId } : { name: 'tasks' }
    case 'chats':
      return { name: 'chats', ...(l.filter ? { filter: l.filter } : {}), ...(l.chat ? { chat: `${l.chat.kind}:${l.chat.id}` } : {}) }
    case 'agent':
      return { name: 'agentSeat', id: l.agentId, nonce: o.nonce }
    case 'automations':
      if (l.tab === 'autopilots') return { name: 'schedules', tab: 'autopilots', ...(l.add ? { addPlaybook: l.add } : {}), nonce: o.nonce }
      return { name: 'schedules', ...(l.tab === 'routines' || l.add ? { tab: 'routines' as const } : {}), ...(l.add ? { addRoutine: l.add } : {}), ...(l.add && (l.at || l.days) ? { routineTime: { ...(l.at ? { at: l.at } : {}), ...(l.days ? { days: l.days } : {}) } } : {}), nonce: o.nonce }
    case 'knowledge':
      return { name: 'passport', ...(l.note ? { search: l.note } : {}), nonce: o.nonce }
    case 'forum':
      return { name: 'forum', nonce: o.nonce }
    case 'home':
      return { name: 'home' }
    case 'browser':
      // the browser opens beside the current page (state/store openDeepLink); this is where it lands without one
      return { name: 'chats' }
  }
}

export const TOOL_NAMES: Record<string, string> = {
  ...Object.fromEntries(SERVICE_REGISTRY.map((s) => [s.id, s.name])),
  instagram: 'Instagram',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  shopify: 'Shopify',
  'google-business': 'Google Business',
  'meta-ads': 'Meta Ads'
}
const SECTION_NAMES: Record<string, string> = {
  company: 'General', team: 'Team & autonomy', connections: 'Connections', repos: 'Repositories', keys: 'Keys & secrets', danger: 'Danger zone',
  general: 'General', providers: 'AI providers', agents: 'AI providers', notifications: 'Notifications', cloud: 'Cloud sync', phone: 'Phone', storage: 'Storage', data: 'Storage',
  experimental: 'Experimental', about: 'About'
}

/** Plain words for a link an agent wrote as a bare principia:// URL ("Connect Stripe"); null = not a link we open. */
export function deepLinkLabel(href: string): string | null {
  const l = parseDeepLink(href)
  if (!l) return null
  switch (l.kind) {
    case 'connect':
      return l.tool === 'mcp' ? 'Add your own MCP server' : `Connect ${TOOL_NAMES[l.tool] ?? l.tool}`
    case 'settings':
      return `Open Settings › ${SECTION_NAMES[l.section] ?? l.section}`
    case 'board':
      return l.newTitle ? `New task: ${l.newTitle}` : l.task ? `Open ${l.task}` : 'Open the Board'
    case 'chats':
      return 'Open Chats'
    case 'agent':
      return 'Open the agent’s desk'
    case 'automations':
      if (l.tab === 'autopilots') return l.add && isPlaybookId(l.add) ? `Put ${playbookDef(l.add).thing} on autopilot` : 'Open Autopilot'
      if (l.add && isRoutineId(l.add) && (l.at || l.days)) return `Change the ${routineDef(l.add).name} to ${suggestedCadence(l.add, l.at, l.days)}`
      return l.add ? (isRoutineId(l.add) ? `Set up the ${routineDef(l.add).name} routine` : 'See this routine in Automations') : l.tab ? 'Open Routines' : 'Open Automations'
    case 'knowledge':
      return l.note ? `Find “${l.note}” in Knowledge` : 'Open Knowledge'
    case 'forum':
      return 'Open the Forum'
    case 'home':
      return 'Open Home'
    case 'browser':
      return l.url ? `Open ${hostLabel(l.url)} in the browser` : 'Open the browser'
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the page'
  }
}

/** The time a routine link suggests, over the routine's own (a link may name only the time or only the days). */
export function suggestedTime(id: RoutineId, at?: string | null, days?: string | null): RoutineTime | null {
  const base = routineTimeOf(routineDef(id).cron)
  if (!base) return null
  const t = at ? parseAt(at) : base.time
  const d = days ? parseDays(days) : base.days
  return t && d ? { time: t, days: d } : null
}
function suggestedCadence(id: RoutineId, at?: string, days?: string): string {
  const t = suggestedTime(id, at, days)
  return t ? cadenceOf(t) : 'a new time'
}
