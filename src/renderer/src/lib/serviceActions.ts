/**
 * CONNECTIONS.md §4.1: what a connected service lets the founder do right where it shows ("See sessions", "Ask about
 * your data"), and the plain-word lines every slot shares ("Used by: Marketing dashboard, 3 agents"). Pure: the slot,
 * the palette and the desk call `run` with their own context.
 */
import { capabilityLink, serviceById, type Purpose, type ServiceStatus } from '@shared/services'

export interface ServiceAction {
  id: 'sessions' | 'ask'
  label: string
  /** sessions: the https link to open in the company browser */
  url?: string
  /** ask: the first message of the new chat */
  prompt?: string
}

const HOST_DEFAULTS: Record<string, Record<string, string>> = { posthog: { host: 'https://us.posthog.com' } }
/** When the project is not known yet: the vendor opens its last project (PostHog redirects /replay/home). */
const NO_PROJECT: Record<string, string> = { posthog: '{host}/replay/home' }

/** The actions a connected service offers (none when not connected, or when its form cannot do them). */
export function serviceActions(st: ServiceStatus | null | undefined): ServiceAction[] {
  if (!st || st.state !== 'connected') return []
  const s = serviceById(st.serviceId)
  if (!s) return []
  const out: ServiceAction[] = []
  for (const cap of s.capabilities) {
    if (!st.purposes[cap.purpose]?.ok) continue
    if (cap.purpose === 'sessionReplay') {
      const defaults = HOST_DEFAULTS[s.id] ?? {}
      const url = capabilityLink(cap.open, st.settings, defaults) ?? capabilityLink(NO_PROJECT[s.id], st.settings, defaults)
      if (url) out.push({ id: 'sessions', label: 'See sessions', url })
    }
    if (cap.purpose === 'askData') out.push({ id: 'ask', label: cap.label, prompt: askPrompt(st.name) })
  }
  return out
}

/** The first message of an "Ask about it" chat. */
export function askPrompt(service: string): string {
  return `Use this company’s ${service} connection, through Principia’s tools (principia_list_tools, then principia_call_tool), to answer my questions about our data. Never another ${service} tool or MCP server: it may be another company’s account. Start with a short read of the last 7 days: the main numbers, what changed, and anything unusual. Then ask me what I want to dig into.`
}

/** What a connection does now, in a few words ("revenue dashboard, agent tools"); empty when nothing yet. */
export function unlockedLine(st: Pick<ServiceStatus, 'purposes'> | null | undefined): string {
  return Object.values(st?.purposes ?? {})
    .filter((p) => p?.ok)
    .map((p) => p!.label.toLowerCase())
    .join(', ')
}

/** "Marketing dashboard, 3 agents, Revenue brief" (empty when nothing uses it yet). */
export function usedByLine(st: ServiceStatus | null | undefined): string {
  return (st?.usedBy ?? []).map((u) => u.label).join(', ')
}

/** How it is connected, in a few words ("key", "sign-in", "key + sign-in", "from Northwind"). */
export function viaWords(st: ServiceStatus): string {
  if (st.sharedFrom) return `from ${st.sharedFrom.name}`
  const kinds = [...new Set(st.forms.filter((f) => f.state === 'connected' && !f.virtual).map((f) => f.kind))]
  const w: Record<string, string> = { key: 'key', mcp: 'sign-in', account: 'account', connector: 'Principia' }
  return kinds.map((k) => w[k]).join(' + ')
}

/** Everything a service can unlock, with whether this connection unlocks it now. */
export function unlocks(st: ServiceStatus | null | undefined, serviceId: string): { purpose: Purpose; label: string; ok: boolean; why?: string }[] {
  const s = serviceById(serviceId)
  if (!s) return []
  return s.capabilities.map((c) => ({ purpose: c.purpose, label: c.label, ok: !!st?.purposes[c.purpose]?.ok, why: st?.purposes[c.purpose]?.why }))
}

/** The two letters of a service's roundel ("PH", "St"). */
export function serviceMonogram(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  const w = words[0] ?? '?'
  if (/^[A-Z][a-z]+[A-Z]/.test(w)) return (w[0]! + w.slice(1).match(/[A-Z]/)![0]).toUpperCase()
  return w.slice(0, 1).toUpperCase() + w.slice(1, 2).toLowerCase()
}

/** The tone of a status, as the chips colour it. */
export function stateTone(st: ServiceStatus | null | undefined): 'ok' | 'needs' | 'run' | 'grey' {
  if (!st) return 'grey'
  return st.state === 'connected' ? 'ok' : st.state === 'attention' ? 'needs' : st.state === 'waiting' ? 'run' : 'grey'
}
