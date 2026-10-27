/**
 * `connections_list` (the agents' "where do I connect this?"): what one company has connected, and for every tool it
 * has not, the principia://connect/<tool> link that opens its card in Settings › Connections. Pure: main passes in what
 * it knows (the company's accounts, its gateway connections, Slack, Linear). Read-only: nothing here connects anything;
 * the founder clicks the link and signs in on the card.
 */
import type { CompanyAccounts } from '../../shared/company'
import { CONNECTION_CATALOG, presetForUrl } from '../../shared/connectionCatalog'
import { connectionsFor, VIBIZ_CONNECTION_ID, type GatewayConnection } from '../../shared/gateway'
import { connectLink, connectToolId, formatDeepLink, SOON_CONNECT_TOOLS } from '../../shared/deepLink'
import { serviceById, type FormKind, type ServiceStatus } from '../../shared/services'

export const CONNECTIONS_WHERE = 'Settings › Connections'

export interface ConnectionsInput {
  companyId: string
  companyName: string
  /** Personal has no accounts of its own (Instagram, GitHub) */
  personal?: boolean
  accounts?: CompanyAccounts
  /** every saved gateway connection (filtered to this company here) */
  gateway: readonly GatewayConnection[]
  slack: 'connected' | 'set-up' | 'none' | 'unavailable'
  linear: boolean
  /** the company has a repository; without one, developer tools it has not connected are left out (no dev jargon) */
  code?: boolean
  /**
   * CONNECTIONS.md §4.3 S5: every service's status from the resolver. A service connected only by a key (PostHog,
   * Plausible, a Stripe key) counts as connected, and each row says how the agent has it (env var, MCP tools).
   */
  services?: readonly ServiceStatus[]
}

/** Developer tools: offered to a company without code only once connected (or when an agent asks for one by name). */
const DEVELOPER_TOOLS = new Set(['github', 'linear', 'sentry', 'supabase', 'neon'])

export interface ConnectionRow {
  tool: string
  name: string
  status: 'connected' | 'needs_sign_in' | 'turned_off' | 'not_connected' | 'needs_setup' | 'coming_soon'
  /** principia://connect/<tool>?company=…: opens this card (absent for a connected tool) */
  link?: string
  note?: string
  /** how this company has it: a key in the agents' environment, MCP tools, an account, Principia's connector */
  via?: FormKind[]
  /** the environment variables agents get for it (names only) */
  env?: string[]
}
export interface ConnectionsReport {
  company: string
  where: string
  connected: ConnectionRow[]
  /** tools that need the founder: sign in again, turned off, or not connected yet (with the link to each) */
  missing: ConnectionRow[]
  addYourOwn: { link: string; where: string; note: string }
  keys: { link: string; note: string }
  howToHelp: string
}

const SOON_NAMES: Record<string, string> = { shopify: 'Shopify', 'google-business': 'Google Business', 'meta-ads': 'Meta Ads' }

function gatewayRow(c: GatewayConnection, tool: string, name: string, link: string): ConnectionRow {
  if (!c.enabled) return { tool, name, status: 'turned_off', link, note: 'Turned off on its card' }
  // the Vibiz card is there from install, waiting for a first sign-in: not "sign in again"
  if (c.id === VIBIZ_CONNECTION_ID && c.authentication === 'oauth' && (c.authStatus ?? 'disconnected') === 'disconnected') return { tool, name, status: 'not_connected', link, note: 'Not signed in yet: the founder signs in on its card' }
  if (c.authentication === 'oauth' && c.authStatus !== 'connected') return { tool, name, status: 'needs_sign_in', link, note: c.authStatus === 'connecting' ? 'Waiting for the founder to finish signing in' : 'The founder needs to sign in again on its card' }
  if (c.authStatus === 'error') return { tool, name, status: 'needs_sign_in', link, note: 'Needs attention on its card' }
  return { tool, name, status: 'connected' }
}

/** One service's resolver status folded into the rows: connected in any form counts, and the row says how. */
function mergeService(rows: ConnectionRow[], st: ServiceStatus, link: (tool: string) => string): void {
  const def = serviceById(st.serviceId)
  if (!def) return
  const connected = st.forms.filter((f) => f.state === 'connected')
  const via = [...new Set(connected.map((f) => f.kind))]
  // SEC-8: a key another company lends never reaches this company's environment; an own key only when the profile allows it
  const env = [...new Set(connected.flatMap((f) => (f.kind === 'key' && !f.reused ? (f.keyNames ?? []).map((k) => k.name) : [])))]
  const virtual = connected.find((f) => f.virtual)
  const how = [env.length ? `in your environment as ${env.join(', ')} when your profile includes it` : '', virtual ? `its MCP tools through principia_list_tools (connection "${virtual.connectionId}")` : ''].filter(Boolean).join('; ')
  const row = rows.find((r) => r.tool === st.serviceId)
  if (st.state === 'connected') {
    const extra = { via, ...(env.length ? { env } : {}) }
    if (row && row.status === 'connected') Object.assign(row, extra, how && !row.note ? { note: how } : {})
    else if (row) Object.assign(row, { status: 'connected', link: undefined, note: how || row.note }, extra)
    else rows.push({ tool: st.serviceId, name: st.name, status: 'connected', ...extra, ...(how ? { note: how } : {}) })
    if (row && row.link === undefined) delete row.link
    return
  }
  // a service only a key can connect, not on any card yet: offered like the others (PostHog, Plausible, Search Console)
  if (!row && def.card && !def.soon && st.state === 'notConnected') rows.push({ tool: st.serviceId, name: st.name, status: 'not_connected', link: link(st.serviceId), note: def.blurb })
  if (!row && st.state === 'attention') rows.push({ tool: st.serviceId, name: st.name, status: 'needs_sign_in', link: link(st.serviceId), note: st.forms.find((f) => f.problem)?.problem ?? 'Needs attention on its card' })
}

export function connectionsReport(i: ConnectionsInput, opts: { tool?: string } = {}): ConnectionsReport {
  const link = (tool: string): string => connectLink(tool, i.companyId)
  const rows: ConnectionRow[] = []
  if (!i.personal) {
    rows.push(i.accounts?.instagram ? { tool: 'instagram', name: 'Instagram', status: 'connected', note: `${i.accounts.instagram.handle}: agents get posts ready; the founder taps Post` } : { tool: 'instagram', name: 'Instagram', status: 'not_connected', link: link('instagram') })
    rows.push(i.accounts?.github ? { tool: 'github', name: 'GitHub', status: 'connected', note: `${i.accounts.github.handle} (the gh login on this Mac)` } : { tool: 'github', name: 'GitHub', status: 'not_connected', link: link('github') })
  }
  const mine = connectionsFor(i.gateway, i.companyId)
  const linearMcp = mine.find((c) => c.url && presetForUrl(c.url)?.id === 'linear')
  rows.push(i.linear || (linearMcp && gatewayRow(linearMcp, 'linear', 'Linear', '').status === 'connected') ? { tool: 'linear', name: 'Linear', status: 'connected' } : { tool: 'linear', name: 'Linear', status: 'not_connected', link: link('linear') })
  if (i.slack !== 'unavailable') rows.push(i.slack === 'connected' ? { tool: 'slack', name: 'Slack', status: 'connected' } : { tool: 'slack', name: 'Slack', status: i.slack === 'set-up' ? 'needs_sign_in' : 'not_connected', link: link('slack') })
  for (const p of CONNECTION_CATALOG) {
    if (p.id === 'linear' || p.id === 'github') continue
    const conn = mine.find((c) => c.url && presetForUrl(c.url)?.id === p.id)
    if (conn) rows.push(gatewayRow(conn, p.id, p.name, link(p.id)))
    else if (p.setupRequired) rows.push({ tool: p.id, name: p.name, status: 'needs_setup', link: link(p.id), note: 'Not available to connect in one click yet' })
    else rows.push({ tool: p.id, name: p.name, status: 'not_connected', link: link(p.id) })
  }
  for (const id of SOON_CONNECT_TOOLS) rows.push({ tool: id, name: SOON_NAMES[id] ?? id, status: 'coming_soon', note: 'Principia cannot connect it yet' })
  // the founder's own MCP servers (no catalog tool): connected under their own name
  for (const c of mine) if (!(c.url && presetForUrl(c.url))) rows.push({ ...gatewayRow(c, 'mcp', c.name, link('mcp')), tool: 'mcp' })
  for (const st of i.services ?? []) mergeService(rows, st, link)
  const want = opts.tool ? connectToolId(opts.tool) : null
  const pick = (r: ConnectionRow): boolean => !opts.tool || r.tool === want || r.name.toLowerCase() === opts.tool.trim().toLowerCase()
  const dev = (r: ConnectionRow): boolean => i.code === false && !opts.tool && r.status !== 'connected' && DEVELOPER_TOOLS.has(r.tool)
  const shown = rows.filter((r) => pick(r) && !dev(r))
  return {
    company: i.companyName,
    where: CONNECTIONS_WHERE,
    connected: shown.filter((r) => r.status === 'connected'),
    missing: shown.filter((r) => r.status !== 'connected'),
    addYourOwn: { link: link('mcp'), where: `${CONNECTIONS_WHERE} › Custom (MCP) › Add server`, note: 'Any other tool with an MCP server (a URL or a command) can be added there.' },
    keys: { link: formatDeepLink({ kind: 'settings', section: 'keys', companyId: i.companyId }), note: 'A key saved in Settings › Keys & secrets for a service (POSTHOG_PERSONAL_API_KEY, STRIPE_SECRET_KEY…) connects that service: it is listed above as connected, with the variable name.' },
    howToHelp:
      'When something you need is not connected, tell the founder in plain words and give the exact link from this list (it opens the card in Settings › Connections; they sign in there). Never ask them to paste passwords or keys into the chat.'
  }
}
