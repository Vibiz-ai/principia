/**
 * AUTOPILOT.md §3: the social channels the setup checklist and the Marketing autopilot know about.
 *
 * None of these networks publishes an official remote MCP server Principia can sign in to (checked 2026-10-24), so the
 * honest path is the network's own developer API: the user creates an app in the official developer portal and pastes
 * the token into the company's Keys. Agents then see the key in their environment (profiles default to every key).
 * A user-added MCP connection whose name or URL names the network also counts.
 *
 * Posting is never automatic: the Marketing autopilot drafts for review, and publishes to a channel only after the user
 * turned that channel on explicitly (AutopilotRecord.publish).
 */
import type { GatewayConnection } from './gateway'
import { serviceById, serviceForConnection, serviceKeyFields, suggestServiceForConnection } from './services'

/** CONNECTIONS.md §2: a channel's keys and MCP name fragments come from its registry entry (one name per key everywhere). */
const socialKeys = (id: SocialId): SocialKey[] => serviceKeyFields(id).map(({ name, label, required }) => ({ name, label, required }))
const socialMatch = (id: SocialId): string[] => serviceById(id)?.match?.fragments ?? [id]

export type SocialId = 'x' | 'linkedin' | 'instagram' | 'tiktok' | 'youtube'
export const SOCIAL_IDS: readonly SocialId[] = ['x', 'linkedin', 'instagram', 'tiktok', 'youtube']

export interface SocialKey {
  /** company key name (UPPER_SNAKE_CASE, shown on the Keys page) */
  name: string
  label: string
  required: boolean
}
export interface SocialChannel {
  id: SocialId
  name: string
  /** What the key lets an agent do: `post` = the API can publish; `read` = stats only (drafts stay drafts). */
  can: 'post' | 'read'
  keys: SocialKey[]
  /** The official developer setup page. */
  docs: string
  docsLabel: string
  /** One or two plain sentences: what to create, which permission, and the catch. */
  setup: string
  /** Whole words of an MCP connection's name that mean this network (its host is matched by domain). */
  mcpMatch: string[]
}

export const SOCIAL_CHANNELS: readonly SocialChannel[] = [
  {
    id: 'x',
    name: 'X (Twitter)',
    can: 'post',
    keys: socialKeys('x'),
    docs: 'https://developer.x.com/en/portal/dashboard',
    docsLabel: 'X developer portal',
    setup: 'Create a project and app in the X developer portal, set its permissions to Read and write, then generate the access token and secret for your account. Posting needs an X API plan that includes write access.',
    mcpMatch: socialMatch('x')
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    can: 'post',
    keys: socialKeys('linkedin'),
    docs: 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin',
    docsLabel: 'Share on LinkedIn',
    setup: 'Create an app at linkedin.com/developers, add the “Share on LinkedIn” and “Sign In with LinkedIn” products, and generate a token with the w_member_social scope. Member tokens expire after 60 days.',
    mcpMatch: socialMatch('linkedin')
  },
  {
    id: 'instagram',
    name: 'Instagram',
    can: 'post',
    keys: socialKeys('instagram'),
    docs: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    docsLabel: 'Instagram content publishing',
    setup: 'Needs an Instagram professional (Business or Creator) account and a Meta app with the instagram_content_publish permission. Publishing for accounts you do not own needs Meta app review.',
    mcpMatch: socialMatch('instagram')
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    can: 'post',
    keys: socialKeys('tiktok'),
    docs: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    docsLabel: 'TikTok Content Posting API',
    setup: 'Create a TikTok developer app with the Content Posting API and the video.publish scope. Until TikTok audits the app, everything it posts is private to your account.',
    mcpMatch: socialMatch('tiktok')
  },
  {
    id: 'youtube',
    name: 'YouTube',
    can: 'read',
    keys: socialKeys('youtube'),
    docs: 'https://developers.google.com/youtube/v3/getting-started',
    docsLabel: 'YouTube Data API',
    setup: 'Google Cloud → enable the YouTube Data API v3 → Credentials → API key. A key reads public channel and video stats; uploading needs Google sign-in, which Principia does not do yet, so YouTube stays drafts-only.',
    mcpMatch: socialMatch('youtube')
  }
]

export function socialChannel(id: string): SocialChannel | undefined {
  return SOCIAL_CHANNELS.find((c) => c.id === id)
}

/**
 * How a channel is set up for one company. `mcp`: an enabled MCP connection; `key`: every required key is saved;
 * `account`: the account was named in Settings › Connections (five doors step 4: Instagram, drafts only), so agents
 * draft for it and the founder posts.
 */
export type SocialState = 'mcp' | 'key' | 'account' | 'partial' | 'missing'
export interface SocialStatus {
  id: SocialId
  name: string
  state: SocialState
  /** set up enough that an agent can use it (mcp or key) */
  ready: boolean
  /** ready and the API can publish (YouTube with a key can only read) */
  canPost: boolean
  /** required key names not saved yet */
  missingKeys: string[]
  /** the MCP connection that counts, when state is `mcp`; the account handle when state is `account` */
  connection: string | null
}

/** A connection that reaches this company: enabled, and either unscoped or scoped to it. */
export function connectionReaches(c: Pick<GatewayConnection, 'enabled' | 'companyIds'>, companyId: string): boolean {
  return c.enabled && (!c.companyIds || c.companyIds.length === 0 || c.companyIds.includes(companyId))
}

/**
 * Every channel's status for one company. `keyNames`: the key names that resolve for it (its own keys plus Shared).
 * A connection counts once it is usable: OAuth signed in, or saved credentials for a token/stdio server.
 */
export function socialStatuses(companyId: string, keyNames: ReadonlySet<string>, connections: readonly GatewayConnection[], accounts?: { instagram?: { handle: string } | null } | null): SocialStatus[] {
  return SOCIAL_CHANNELS.map((ch) => {
    const conn = connections.find((c) => {
      if (!connectionReaches(c, companyId)) return false
      const usable = c.authentication === 'oauth' ? c.authStatus === 'connected' : c.hasCredentials || c.transport === 'stdio'
      if (!usable) return false
      // its exact URL, or a whole word of its name or its host under the network's domain (never a substring: Dropbox is not X)
      return (serviceForConnection(c) ?? suggestServiceForConnection(c))?.id === ch.id
    })
    const required = ch.keys.filter((k) => k.required)
    const missingKeys = required.filter((k) => !keyNames.has(k.name)).map((k) => k.name)
    const account = ch.id === 'instagram' ? (accounts?.instagram?.handle ?? null) : null
    const state: SocialState = conn ? 'mcp' : missingKeys.length === 0 ? 'key' : account ? 'account' : missingKeys.length < required.length ? 'partial' : 'missing'
    const ready = state === 'mcp' || state === 'key' || state === 'account'
    return { id: ch.id, name: ch.name, state, ready, canPost: (state === 'mcp' || state === 'key') && (state === 'mcp' || ch.can === 'post'), missingKeys, connection: conn?.name ?? (state === 'account' ? account : null) }
  })
}
