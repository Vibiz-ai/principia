/**
 * Five doors step 4, Settings › Connections (design §4.10, pm-review E12): one catalog per company, consumer tools
 * first, and exactly one state per card. A tool that is connected shows once (in Connected), never again lower down.
 * Pure: the page passes in what it loaded (this company's gateway connections, its own accounts, gh, Slack, Linear).
 */
import type { CompanyAccounts } from '@shared/company'
import { VIBIZ_CONNECTION_ID, type GatewayConnection } from '@shared/gateway'
import { CONNECTION_CATALOG, presetForUrl, type ConnectionPreset } from './connectionCatalog'
import { CUSTOM_CONNECT_TOOL, connectLink } from '@shared/deepLink'

/** One state per card (round 2): never "Not connected" and "Drafts only" on the same card. */
export type CardState = 'connected' | 'attention' | 'waiting' | 'off' | 'notConnected' | 'soon' | 'setup'
export type CardGroup = 'attention' | 'connected' | 'popular' | 'more' | 'developers' | 'custom'
/** What the card's one button does. */
export type CardAction =
  | { kind: 'instagram' }
  | { kind: 'github' }
  | { kind: 'linear' }
  | { kind: 'slack' }
  | { kind: 'preset'; presetId: string }
  | { kind: 'manage'; connectionId: string }
  | { kind: 'signIn'; connectionId: string }
  | { kind: 'custom' }
  | { kind: 'guide'; presetId: string }
  | { kind: 'none' }

export interface ConnCard {
  /** catalog id ('instagram', 'stripe', …) or `conn:<id>` for a connection that matches no catalog tool */
  id: string
  name: string
  /** one line: what an agent can do with it */
  blurb: string
  state: CardState
  /** the chip ("Connected · @northwindcoffee", "Not connected", "Coming soon") */
  chip: string
  /** the account it is connected as, when known */
  account: string | null
  /** a second line under the blurb ("Shared by every company", "Drafts only: you tap Post") */
  note: string | null
  action: CardAction
  actionLabel: string
  group: CardGroup
  keywords: string
}

export interface CatalogInput {
  companyName: string
  /** a company with code (repositories): developer tools are its popular ones */
  code: boolean
  /** the company's content agent, for the Instagram line ("Marcus gets each post ready"); null = "Your agents" */
  writer: string | null
  accounts: CompanyAccounts | undefined
  /** this company's gateway connections (gateway:list with companyId: its own and the shared ones) */
  connections: readonly GatewayConnection[]
  /** gh on this Mac */
  gh: { state: 'ok' | 'signedOut' | 'missing' | 'unknown'; login: string | null }
  slack: 'connected' | 'set-up' | 'none' | 'unavailable'
  /**
   * `problem`: the key was turned down (you fix it); `offline`: the last sync failed on the network or Linear's side
   * ("Synced 21 min ago"), so the card never says Synced while sync is failing
   */
  linear: { connected: boolean; teamKey: string | null; problem: string | null; offline?: { kind: 'network' | 'error'; synced: string } | null }
  /** the company has INSTAGRAM_ACCESS_TOKEN (its own Meta app): agents can post through the API */
  instagramKey: boolean
  companyId: string
  /** Personal has no accounts of its own (Instagram, GitHub): those cards are left out */
  personal?: boolean
}

/** Consumer tools Principia can't sign in to yet: an honest "Coming soon", never a fake Connect. */
const SOON: { id: string; name: string; blurb: string; keywords: string }[] = [
  { id: 'shopify', name: 'Shopify', blurb: 'Orders, products and customers for Support and Marketing.', keywords: 'store shop ecommerce orders products' },
  { id: 'google-business', name: 'Google Business', blurb: 'Reviews and local search for your shop.', keywords: 'google maps reviews local gbp' },
  { id: 'meta-ads', name: 'Meta Ads', blurb: 'Read ad results. Spending always asks you first.', keywords: 'facebook ads advertising meta campaigns' }
]
const POPULAR_BUSINESS = ['instagram', 'stripe', 'slack', 'notion', 'shopify', 'google-business', 'meta-ads', 'vibiz']
const POPULAR_CODE = ['github', 'linear', 'sentry', 'supabase', 'slack']
const DEVELOPER_IDS = new Set(['github', 'linear', 'sentry', 'supabase', 'neon', 'figma', 'asana', 'mobbin'])

const usable = (c: GatewayConnection): boolean => c.enabled && c.authStatus !== 'error' && (c.authentication === 'oauth' ? c.authStatus === 'connected' : c.hasCredentials || c.transport === 'stdio' || c.authentication === 'none' || c.authentication === undefined)

/** A gateway connection's one state. */
export function connectionState(c: GatewayConnection): { state: CardState; chip: string } {
  if (!c.enabled) return { state: 'off', chip: 'Turned off' }
  if (c.authStatus === 'error') return { state: 'attention', chip: 'Needs attention' }
  if (c.authStatus === 'connecting') return { state: 'waiting', chip: 'Waiting for sign-in' }
  // the Vibiz card is there from install: never signed in is "Not signed in", not a problem to fix
  if (c.id === VIBIZ_CONNECTION_ID && c.authentication === 'oauth' && (c.authStatus ?? 'disconnected') === 'disconnected') return { state: 'notConnected', chip: 'Not signed in' }
  if (c.authentication === 'oauth' && c.authStatus !== 'connected') return { state: 'attention', chip: 'Sign-in needed' }
  return usable(c) ? { state: 'connected', chip: 'Connected' } : { state: 'attention', chip: 'Needs a key' }
}

/** "Shared by every company" for a connection saved before companies, else null (it is this company's own). */
function sharedNote(c: GatewayConnection): string | null {
  return c.companyIds?.length ? null : 'Shared by every company'
}

function presetCard(p: ConnectionPreset, conns: readonly GatewayConnection[]): ConnCard {
  const conn = conns.find((c) => c.url && presetForUrl(c.url)?.id === p.id)
  const base = { id: p.id, name: p.name, blurb: p.description, account: null, keywords: `${p.keywords} ${p.category}`, group: 'more' as CardGroup }
  if (conn) {
    const st = connectionState(conn)
    const fresh = st.state === 'notConnected'
    const action: CardAction = (st.state === 'attention' || fresh) && conn.authentication === 'oauth' ? { kind: 'signIn', connectionId: conn.id } : { kind: 'manage', connectionId: conn.id }
    return { ...base, ...st, note: fresh ? null : sharedNote(conn), action, actionLabel: action.kind === 'signIn' ? (fresh ? 'Sign in' : 'Sign in again') : 'Manage', group: st.state === 'off' || fresh ? 'more' : 'connected' }
  }
  if (p.setupRequired) return { ...base, state: 'setup', chip: 'Needs setup', note: null, action: { kind: 'guide', presetId: p.id }, actionLabel: 'How to set up' }
  return { ...base, state: 'notConnected', chip: 'Not connected', note: null, action: { kind: 'preset', presetId: p.id }, actionLabel: 'Connect' }
}

/**
 * Every card of the catalog for one company, grouped: Connected first (each connected tool exactly once), then
 * Popular for this company (consumer tools first for a shop, developer tools first for a code company), More tools,
 * For developers, and Custom (MCP) last.
 */
export function buildCatalog(i: CatalogInput): ConnCard[] {
  const cards: ConnCard[] = []
  // Instagram: drafts only (pm-review E12: Connected names the account)
  const ig = i.accounts?.instagram
  const who = i.writer ?? 'Your agents'
  if (ig || i.instagramKey) {
    cards.push({
      id: 'instagram', name: 'Instagram', blurb: ig ? `${ig.handle} is connected. ${who} gets each post ready: picture, caption and hashtags. You tap Post.` : 'Agents post with your own Meta app’s token (Keys & secrets).',
      state: 'connected', chip: 'Connected', account: ig?.handle ?? null,
      note: ig && !i.instagramKey ? 'Drafts only: Instagram doesn’t let apps post for you yet.' : null,
      action: { kind: 'instagram' }, actionLabel: 'Manage', group: 'connected', keywords: 'instagram social posts ig meta reels'
    })
  } else {
    cards.push({
      id: 'instagram', name: 'Instagram', blurb: `${who} gets each post ready (picture, caption, hashtags) for your OK. You tap Post.`,
      state: 'notConnected', chip: 'Not connected', account: null, note: null, action: { kind: 'instagram' }, actionLabel: 'Connect Instagram', group: 'more', keywords: 'instagram social posts ig meta reels'
    })
  }
  // GitHub: the gh login on this Mac, with this company's OK
  const gh = i.accounts?.github
  if (gh) {
    const lost = i.gh.state !== 'ok' && i.gh.state !== 'unknown'
    cards.push({
      id: 'github', name: 'GitHub', blurb: `Connected as ${gh.handle}. Agents push their task branches and open pull requests with your gh login.`,
      state: lost ? 'attention' : 'connected', chip: lost ? 'Needs attention' : 'Connected', account: gh.handle,
      note: lost ? (i.gh.state === 'missing' ? 'The GitHub CLI (gh) isn’t on this Mac any more.' : 'gh is signed out on this Mac. Run gh auth login in Terminal.') : null,
      action: { kind: 'github' }, actionLabel: 'Manage', group: 'connected', keywords: 'github git gh pull requests pr code repository'
    })
  } else {
    cards.push({
      id: 'github', name: 'GitHub', blurb: 'Lets agents push branches and open pull requests. Uses your gh login from this Mac.',
      state: 'notConnected', chip: 'Not connected', account: null, note: i.gh.state === 'ok' && i.gh.login ? `Found on this Mac: ${i.gh.login}` : null,
      action: { kind: 'github' }, actionLabel: i.gh.state === 'ok' ? 'Use my gh login' : 'Connect GitHub', group: 'more', keywords: 'github git gh pull requests pr code repository'
    })
  }
  // Linear: the Board sync (and the agent tool, through its MCP card state below)
  if (i.linear.connected) {
    const off = i.linear.problem ? null : (i.linear.offline ?? null)
    cards.push({
      id: 'linear', name: 'Linear', blurb: `Issues in ${i.linear.teamKey ?? 'your team'} sync with the Board both ways.`,
      state: i.linear.problem || off ? 'attention' : 'connected',
      chip: i.linear.problem ? 'Needs attention' : off ? (off.kind === 'network' ? 'Offline' : 'Sync problem') : `Synced · ${i.linear.teamKey ?? 'Linear'}`,
      account: i.linear.teamKey,
      note: i.linear.problem ?? (off ? `${off.kind === 'network' ? 'Can’t reach Linear right now' : 'Linear didn’t accept the last sync'}. ${off.synced}; Principia keeps trying on its own.` : null),
      action: { kind: 'linear' }, actionLabel: 'Manage', group: 'connected', keywords: 'linear issues tickets sync tracker board'
    })
  } else {
    cards.push({ id: 'linear', name: 'Linear', blurb: 'Sync issues with the Board both ways, and let agents use Linear.', state: 'notConnected', chip: 'Not connected', account: null, note: null, action: { kind: 'linear' }, actionLabel: 'Connect Linear', group: 'more', keywords: 'linear issues tickets sync tracker board' })
  }
  // Slack: Principia's own Slack app
  const slackOn = i.slack === 'connected'
  if (i.slack !== 'unavailable')
    cards.push({
      id: 'slack', name: 'Slack', blurb: 'Agents read threads and draft replies; alerts reach you in Slack.',
      state: slackOn ? 'connected' : i.slack === 'set-up' ? 'attention' : 'notConnected', chip: slackOn ? 'Connected' : i.slack === 'set-up' ? 'Needs attention' : 'Not connected', account: null,
      note: i.slack === 'set-up' ? 'Set up, but not connected right now.' : null, action: { kind: 'slack' }, actionLabel: slackOn ? 'Manage' : i.slack === 'set-up' ? 'Reconnect' : 'Connect Slack',
      group: slackOn || i.slack === 'set-up' ? 'connected' : 'more', keywords: 'slack chat messages channels alerts'
    })
  // the MCP catalog (Linear's MCP joins the Linear card: one card per tool)
  const linearMcp = i.connections.find((c) => c.url && presetForUrl(c.url)?.id === 'linear')
  for (const p of CONNECTION_CATALOG) {
    if (p.id === 'linear' || p.id === 'github') continue
    cards.push(presetCard(p, i.connections))
  }
  if (linearMcp) {
    const lin = cards.find((c) => c.id === 'linear')!
    const st = connectionState(linearMcp)
    if (!i.linear.connected && st.state === 'connected') Object.assign(lin, { state: 'connected', chip: 'Connected · agents', group: 'connected', blurb: 'Agents read and update Linear issues. Sync with the Board is off.', actionLabel: 'Manage' })
  }
  for (const s of SOON) cards.push({ ...s, state: 'soon', chip: 'Coming soon', account: null, note: null, action: { kind: 'none' }, actionLabel: '', group: 'more' })
  // a connection that matches no catalog tool is its own card (connected or not, it is this company's)
  for (const c of i.connections) {
    if (c.url && presetForUrl(c.url)) continue
    const st = connectionState(c)
    cards.push({ id: `conn:${c.id}`, name: c.name, blurb: c.url ?? [c.command, ...(c.args ?? [])].join(' '), ...st, account: null, note: sharedNote(c), action: st.state === 'attention' && c.authentication === 'oauth' ? { kind: 'signIn', connectionId: c.id } : { kind: 'manage', connectionId: c.id }, actionLabel: 'Manage', group: 'connected', keywords: `${c.name} mcp custom` })
  }
  cards.push({ id: 'custom', name: 'Custom (MCP)', blurb: 'Any MCP server URL or command.', state: 'notConnected', chip: '', account: null, note: null, action: { kind: 'custom' }, actionLabel: 'Add server', group: 'custom', keywords: 'mcp custom server url command advanced' })
  // place each not-connected card
  const popular = i.code ? POPULAR_CODE : POPULAR_BUSINESS
  for (const c of cards) {
    if (c.group === 'connected' || c.group === 'custom') continue
    c.group = popular.includes(c.id) ? 'popular' : DEVELOPER_IDS.has(c.id) ? 'developers' : 'more'
  }
  // the Connected section holds only what works: a card that needs you (sign in again, a lost gh, Linear offline)
  // sits in its own section above it, so "Connected" never shows a "Sign-in needed" card
  for (const c of cards) if (c.group === 'connected' && (c.state === 'attention' || c.state === 'waiting')) c.group = 'attention'
  const order = (c: ConnCard): number => (c.group === 'popular' ? popular.indexOf(c.id) : 0)
  const rank: Record<CardGroup, number> = { attention: 0, connected: 1, popular: 2, more: 3, developers: 4, custom: 5 }
  const own = i.personal ? cards.filter((c) => c.id !== 'instagram' && c.id !== 'github') : cards
  return own.map((c, n) => ({ c, n })).sort((a, b) => rank[a.c.group] - rank[b.c.group] || order(a.c) - order(b.c) || a.n - b.n).map((x) => x.c)
}

export const GROUP_TITLE: Record<CardGroup, (companyName: string, code: boolean) => string> = {
  attention: () => 'Needs attention',
  connected: () => 'Connected',
  popular: (n, code) => (code ? 'Popular for software companies' : `Popular for ${n}`),
  more: () => 'More tools',
  developers: () => 'For developers',
  custom: () => 'Custom'
}

/** The search box: every word must match the name, the blurb or the keywords. */
export function searchCards(cards: readonly ConnCard[], query: string): ConnCard[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!words.length) return [...cards]
  return cards.filter((c) => {
    const hay = `${c.name} ${c.blurb} ${c.keywords}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** "@northwindcoffee" from "northwindcoffee", "@northwindcoffee", "instagram.com/northwindcoffee/"; null if not a handle. */
export function instagramAccount(raw: string): string | null {
  const s = raw.trim()
  const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i.exec(s)
  const name = url ? url[1]! : s.replace(/^@/, '')
  return /^[A-Za-z0-9._]{1,30}$/.test(name) && !/^\.|\.$|\.\./.test(name) ? `@${name.toLowerCase()}` : null
}

/**
 * The link a card's Copy link puts on the clipboard: principia://connect/<tool>?company=<id>, which opens this card (or
 * its sheet) in this company, whichever company is open later. A one-off connection (`conn:<id>`) and a Coming soon
 * card (nothing to connect yet) have none.
 */
export function cardLink(c: Pick<ConnCard, 'id'> & { state?: ConnCard['state'] }, companyId?: string | null): string | null {
  if (c.id.startsWith('conn:') || c.state === 'soon') return null
  return connectLink(c.id === 'custom' ? CUSTOM_CONNECT_TOOL : c.id, companyId)
}
