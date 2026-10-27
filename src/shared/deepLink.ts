/**
 * principia:// links (one parser for main and the renderer). A link only ever NAVIGATES: it opens a page, a card, a
 * sheet or a prefilled form. It never approves, spends, deletes, sends, connects or creates anything; the person still
 * clicks the button on the page it opens. Unknown or malformed links parse to null and are ignored.
 *
 *   principia://connect/<tool>[?purpose=<p>]   Settings › Connections, on that tool's card or sheet (tool ids below:
 *                                              every service in the registry, services.ts); `purpose` (dashboard,
 *                                              agentTools, …) only orders the connect sheet (a key first for a dashboard)
 *   principia://settings/<section>             a Settings section (connections, keys, team, providers, …)
 *   principia://board[?task=<id|NC-12>]        the Board, with that task open
 *   principia://board?new=<title>              the Board's quick create, prefilled (nothing is filed until you press it)
 *   principia://chats[/live|all|agents|direct] Chats
 *   principia://chats/session/<id>             one chat
 *   principia://chats/agent/<id>               an agent's thread in Chats
 *   principia://agent/<id>                     an agent's desk
 *   principia://automations[/routines][?add=<templateId>[&at=6:30][&days=tue-sun]]  Automations (the routine to add,
 *                                              and a time for it, are only suggested: the person presses Save)
 *   principia://automations/autopilots[?add=<playbookId>]  Automations › Autopilot, with that autopilot's card open
 *                                              (the person picks the level and presses Turn on)
 *   principia://knowledge[?note=<title>]       Knowledge (the company Passport), searching for that note
 *   principia://forum[/join/<code>]            the Forum
 *   principia://home                           Home
 *   principia://browser[?url=<http(s) url>]    the company browser on the right (opens that page there; nothing is
 *                                              submitted or sent)
 *
 * Every link may carry `?company=<company id>`: it then opens in that company (a link naming a company this Principia
 * does not have is refused by the caller, never opened somewhere else).
 */
import { CONNECTION_CATALOG } from './connectionCatalog'
import { PURPOSES, SERVICE_REGISTRY, type Purpose } from './services'

export const DEEP_LINK_SCHEME = 'principia'
export const DEEP_LINK_MAX = 2048

/** Principia's own account cards (sheets on the Connections page). */
export const OWN_CONNECT_TOOLS = ['instagram', 'github', 'linear', 'slack'] as const
/** Cards Principia shows as "Coming soon" (a link still opens the page on them). */
export const SOON_CONNECT_TOOLS = ['shopify', 'google-business', 'meta-ads'] as const
/** `mcp`: "Add your own MCP server" (the Custom card's editor). */
export const CUSTOM_CONNECT_TOOL = 'mcp'

/** Every tool a principia://connect/<tool> link may name. */
export const CONNECT_TOOL_IDS: readonly string[] = [...new Set<string>([...OWN_CONNECT_TOOLS, ...CONNECTION_CATALOG.map((p) => p.id), ...SERVICE_REGISTRY.map((s) => s.id), ...SOON_CONNECT_TOOLS, CUSTOM_CONNECT_TOOL])]
/** Friendly aliases: what an agent is likely to type. */
const CONNECT_ALIASES: Record<string, string> = { custom: 'mcp', 'mcp-server': 'mcp', ig: 'instagram', gh: 'github', 'google-business-profile': 'google-business', meta: 'meta-ads', gsc: 'google-search-console', 'search-console': 'google-search-console', twitter: 'x', 'fal-ai': 'fal' }

export const SETTINGS_SECTIONS = ['company', 'team', 'connections', 'repos', 'keys', 'danger', 'general', 'providers', 'notifications', 'cloud', 'storage', 'experimental', 'about', 'agents', 'data'] as const
export type DeepLinkSettingsSection = (typeof SETTINGS_SECTIONS)[number]
export const CHAT_FILTERS = ['live', 'all', 'agents', 'direct'] as const
export type DeepLinkChatFilter = (typeof CHAT_FILTERS)[number]

export type DeepLink = { companyId?: string } & (
  | { kind: 'connect'; tool: string; purpose?: Purpose }
  | { kind: 'settings'; section: DeepLinkSettingsSection }
  | { kind: 'board'; task?: string; newTitle?: string }
  | { kind: 'chats'; filter?: DeepLinkChatFilter; chat?: { kind: 'session' | 'agent'; id: string } }
  | { kind: 'agent'; agentId: string }
  | { kind: 'automations'; tab?: 'routines' | 'autopilots'; add?: string; at?: string; days?: string }
  | { kind: 'knowledge'; note?: string }
  | { kind: 'forum'; joinCode?: string }
  | { kind: 'home' }
  | { kind: 'browser'; url?: string }
)

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const COMPANY_ID = /^co_[a-z0-9_]{1,60}$/
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const INVITE = /^[A-Za-z0-9_-]{4,128}$/

/** Plain text from a query value: no control characters, trimmed, capped. Empty = absent. */
function text(v: string | null, max: number): string | undefined {
  if (v === null) return undefined
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  return t || undefined
}

/** An http(s) address a browser link may open (no credentials in it), normalized; null = not one. */
function webUrl(raw: string): string | null {
  if (raw.length > 1500) return null
  try {
    const u = new URL(raw)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null
    return u.href
  } catch {
    return null
  }
}

/** `stripe`, `Stripe`, `ig` → the catalog id; null = not a tool Principia knows. */
export function connectToolId(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  const id = CONNECT_ALIASES[t] ?? t
  return TOOL_ID.test(id) && CONNECT_TOOL_IDS.includes(id) ? id : null
}

/** A principia:// link, or null (wrong scheme, unknown page, a bad id, too long). Never throws. */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || !raw || raw.length > DEEP_LINK_MAX) return null
  const m = /^principia:(?:\/\/)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw.trim())
  if (!m) return null
  let segs: string[]
  try {
    segs = m[1]!.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  } catch {
    return null
  }
  if (segs.some((s) => !s || s.length > 200 || /[\u0000-\u001f/\\]/.test(s))) return null
  const q = new URLSearchParams(m[2] ?? '')
  const company = q.get('company')
  if (company !== null && !COMPANY_ID.test(company)) return null
  const scope = company ? { companyId: company } : {}
  const [page, a, b, ...rest] = segs.map((s, i) => (i === 0 ? s.toLowerCase() : s))
  const none = (n: number): boolean => segs.length <= n
  switch (page) {
    case 'connect': {
      if (!a || b !== undefined) return null
      const tool = connectToolId(a)
      const purpose = q.get('purpose')
      if (purpose !== null && !(PURPOSES as readonly string[]).includes(purpose)) return null
      return tool ? { kind: 'connect', tool, ...(purpose ? { purpose: purpose as Purpose } : {}), ...scope } : null
    }
    case 'connections':
      if (!a) return { kind: 'settings', section: 'connections', ...scope }
      return none(2) && connectToolId(a) ? { kind: 'connect', tool: connectToolId(a)!, ...scope } : null
    case 'settings': {
      if (!a) return { kind: 'settings', section: 'company', ...scope }
      const section = a.toLowerCase()
      if (section === 'connections' && b && none(3)) return connectToolId(b) ? { kind: 'connect', tool: connectToolId(b)!, ...scope } : null
      return none(2) && (SETTINGS_SECTIONS as readonly string[]).includes(section) ? { kind: 'settings', section: section as DeepLinkSettingsSection, ...scope } : null
    }
    case 'board':
    case 'tasks': {
      if (a !== undefined) return a && ID.test(a) && none(2) ? { kind: 'board', task: a, ...scope } : null
      const task = q.get('task')
      if (task !== null && !ID.test(task)) return null
      const newTitle = text(q.get('new'), 200)
      return { kind: 'board', ...(task ? { task } : {}), ...(!task && newTitle ? { newTitle } : {}), ...scope }
    }
    case 'chats':
    case 'chat': {
      if (!a) return { kind: 'chats', ...scope }
      const f = a.toLowerCase()
      if ((CHAT_FILTERS as readonly string[]).includes(f) && none(2)) return { kind: 'chats', filter: f as DeepLinkChatFilter, ...scope }
      if ((f === 'session' || f === 'agent') && b && ID.test(b) && !rest.length) return { kind: 'chats', chat: { kind: f, id: b }, ...scope }
      return null
    }
    case 'agent':
    case 'agents':
      return a && ID.test(a) && none(2) ? { kind: 'agent', agentId: a, ...scope } : null
    case 'autopilots': {
      if (a !== undefined) return null
      const add = q.get('add')
      if (add !== null && !TEMPLATE_ID.test(add)) return null
      return { kind: 'automations', tab: 'autopilots', ...(add ? { add } : {}), ...scope }
    }
    case 'automations':
    case 'routines': {
      if (page === 'automations' && a?.toLowerCase() === 'autopilots') {
        if (!none(2)) return null
        const add = q.get('add')
        if (add !== null && !TEMPLATE_ID.test(add)) return null
        return { kind: 'automations', tab: 'autopilots', ...(add ? { add } : {}), ...scope }
      }
      const tab = page === 'routines' || a?.toLowerCase() === 'routines'
      if (a !== undefined && a.toLowerCase() !== 'routines') return null
      if (!none(2)) return null
      const add = q.get('add')
      if (add !== null && !TEMPLATE_ID.test(add)) return null
      // a suggested time for that routine: only with add, and only when it reads as a time and days
      const at = add ? q.get('at') : null
      const days = add ? q.get('days') : null
      if (at !== null && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) return null
      if (days !== null && !/^[a-z]{3,8}(?:-[a-z]{3})?(?:,[a-z]{3}(?:-[a-z]{3})?){0,6}$/i.test(days)) return null
      return { kind: 'automations', ...(tab ? { tab: 'routines' as const } : {}), ...(add ? { add } : {}), ...(at ? { at } : {}), ...(days ? { days: days.toLowerCase() } : {}), ...scope }
    }
    case 'knowledge':
    case 'passport': {
      if (a !== undefined) return null
      const note = text(q.get('note'), 200)
      return { kind: 'knowledge', ...(note ? { note } : {}), ...scope }
    }
    case 'forum':
      if (!a) return { kind: 'forum', ...scope }
      return a.toLowerCase() === 'join' && b && INVITE.test(b) && !rest.length ? { kind: 'forum', joinCode: b, ...scope } : null
    case 'home':
      return none(1) ? { kind: 'home', ...scope } : null
    case 'browser': {
      if (!none(1)) return null
      const url = q.get('url')
      if (url === null) return { kind: 'browser', ...scope }
      return webUrl(url) ? { kind: 'browser', url: webUrl(url)!, ...scope } : null
    }
    default:
      return null
  }
}

const enc = encodeURIComponent
const withQuery = (base: string, q: Record<string, string | undefined>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `${base}?${s}` : base
}

/** The canonical link text of a parsed link (parseDeepLink(formatDeepLink(x)) deep-equals x). */
export function formatDeepLink(l: DeepLink): string {
  const c = l.companyId
  switch (l.kind) {
    case 'connect':
      return withQuery(`principia://connect/${enc(l.tool)}`, { purpose: l.purpose, company: c })
    case 'settings':
      return withQuery(`principia://settings/${l.section}`, { company: c })
    case 'board':
      return withQuery('principia://board', { task: l.task, new: l.newTitle, company: c })
    case 'chats':
      return withQuery(`principia://chats${l.chat ? `/${l.chat.kind}/${enc(l.chat.id)}` : l.filter ? `/${l.filter}` : ''}`, { company: c })
    case 'agent':
      return withQuery(`principia://agent/${enc(l.agentId)}`, { company: c })
    case 'automations':
      if (l.tab === 'autopilots') return withQuery('principia://automations/autopilots', { add: l.add, company: c })
      return withQuery(`principia://automations${l.tab ? '/routines' : ''}`, { add: l.add, at: l.at, days: l.days, company: c })
    case 'knowledge':
      return withQuery('principia://knowledge', { note: l.note, company: c })
    case 'forum':
      return withQuery(`principia://forum${l.joinCode ? `/join/${enc(l.joinCode)}` : ''}`, { company: c })
    case 'home':
      return withQuery('principia://home', { company: c })
    case 'browser':
      return withQuery('principia://browser', { url: l.url, company: c })
  }
}

/** principia://connect/<tool>[?purpose=…][&company=…]; an unknown tool links to "add your own MCP server". */
export function connectLink(tool: string, companyId?: string | null, purpose?: Purpose): string {
  return formatDeepLink({ kind: 'connect', tool: connectToolId(tool) ?? CUSTOM_CONNECT_TOOL, ...(purpose ? { purpose } : {}), ...(companyId ? { companyId } : {}) })
}

/** A principia:// URL (for renderers deciding between "open in app" and "open in browser"). */
export const isDeepLinkUrl = (s: string): boolean => /^principia:/i.test(s)
