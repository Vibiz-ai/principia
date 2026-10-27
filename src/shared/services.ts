/**
 * CONNECTIONS.md §2: the service registry. One entry per outside service (PostHog, Stripe, GitHub, …) says every way a
 * company can connect it (a key in its keys, an MCP connection, an account, one of Principia's own connectors), what a
 * connection unlocks (dashboards, agent tools, data questions, session replays, playbooks…) and the older key names and
 * MCP URLs that mean that service. Data, not code per surface: Settings, dashboards, the gateway, connections_list and
 * principia://connect links all read it. Adding a service is adding an entry here.
 *
 * Also the pure status rules (`serviceStatus`): given what one company has (key names and where they resolve from, its
 * gateway connections, accounts, Slack, Linear), the one state of each service and of each purpose. Main and the
 * renderer agree because they run the same function. Nothing here ever sees a key value. No node or electron imports.
 */
import type { CompanyAccounts } from './company'
import { VIBIZ_CONNECTION_ID, VIBIZ_MCP_URL, connectionsFor, type GatewayConnection } from './gateway'

export type ServiceId = string

/** What a connection can be used for (CONNECTIONS.md §2). */
export type Purpose =
  | 'agentTools' // agents get tools (the vendor's MCP, or the key in their environment)
  | 'dashboard' // a department dashboard reads numbers (REST, main only)
  | 'askData' // "Ask about it": a data question answered through the agent tools
  | 'sessionReplay' // "See sessions": the vendor's session list
  | 'playbook' // an autopilot playbook needs it
  | 'knowledge' // a Knowledge source
  | 'posting' // socials: publish
  | 'sync' // Linear issues ↔ Board, Slack threads
export const PURPOSES: readonly Purpose[] = ['agentTools', 'dashboard', 'askData', 'sessionReplay', 'playbook', 'knowledge', 'posting', 'sync']

export type FormKind = 'key' | 'mcp' | 'account' | 'connector'

export interface ServiceKeyField {
  /** Stored under this name in the company's keys (UPPER_SNAKE_CASE, the Keys page shows it). Never renamed. */
  name: string
  label: string
  required: boolean
  /** One line: what to create and which permissions to give it. */
  hint: string
  link: string
  linkLabel: string
  placeholder?: string
  /** A pasted JSON file (service account) rather than a one-line token. */
  multiline?: boolean
  /** Values that look right but cannot do the job (checked in main; the renderer only gets the reason). */
  refuse?: { pattern: string; reason: string; purposes?: Purpose[] }[]
}

export type AuthForm =
  | {
      kind: 'key'
      keys: ServiceKeyField[]
      /** older names that count as a key of this form (read, never written): canonical → aliases */
      aliases?: Record<string, string[]>
      /** the purposes this key form serves; absent = every capability that lists 'key' */
      serves?: Purpose[]
      /** shown behind "Advanced" with its warning, never as a first choice (Stripe's secret key) */
      advanced?: boolean
      /** one plain line under the form's chip: what this key is for ("For the revenue dashboard") */
      good?: string
    }
  | {
      kind: 'mcp'
      url: string
      /** how the founder signs in to this URL: browser OAuth, or a pasted token in a header */
      auth: 'oauth' | 'token'
      /**
       * The vendor's MCP server also takes this saved key as `Authorization: Bearer <key>` (checked against the vendor's
       * docs on `checked`). `url`: the endpoint for key auth when it differs from the sign-in one (Firecrawl).
       */
      bearerFromKey?: {
        key: string
        url?: string
        checked: string
        /** the key has another job (Linear's Board sync key): agents get the vendor's tools from it only after the founder turns that on */
        optIn?: boolean
        /** another endpoint when a setting says so (PostHog EU: host contains eu.posthog.com) */
        regional?: { setting: string; contains: string; url: string }[]
      }
      /** a plain reason the founder can't sign in in one click yet ("Figma approves new MCP clients") */
      setupRequired?: boolean
    }
  | { kind: 'account'; account: 'github' | 'instagram' }
  | { kind: 'connector'; connector: 'slack' | 'linear' }

export interface Capability {
  purpose: Purpose
  /** "Product analytics dashboard", "Session replays" */
  label: string
  /** forms that can serve it, in preference order */
  via: FormKind[]
  /** dashboards: the DashboardKind ids this service feeds; playbooks: playbook ids */
  refs?: string[]
  /** sessionReplay: a link template over the service's non-secret settings ({host}, {projectId}) */
  open?: string
  /** what it needs, in plain words, when the company's forms can't do it ("The revenue dashboard needs a read-only restricted key (rk_…).") */
  need?: string
}

export type ServiceCategory = 'Analytics' | 'Finance' | 'Development' | 'Projects' | 'Knowledge' | 'Marketing' | 'Data' | 'Research' | 'Design' | 'Sales' | 'Social' | 'AI' | 'Communication' | 'Commerce'

export interface ServiceSetting {
  key: string
  label: string
  /** where to find it, in plain words */
  hint?: string
  /** why it matters (shown instead of "Optional") */
  needed?: string
  placeholder?: string
  /** a choice instead of free text (PostHog: US cloud, EU cloud, self-hosted); `value: ''` = type your own */
  choices?: { label: string; value: string }[]
  /** an https address the service's key is sent to: checked when saved */
  host?: { known: string[] }
}

export interface ServiceDef {
  id: ServiceId
  name: string
  category: ServiceCategory
  /** one line: what an agent can do with it */
  blurb: string
  keywords: string
  forms: AuthForm[]
  capabilities: Capability[]
  /**
   * Identity of a saved MCP connection: `urls` (https origin + path) are exact and count as this service. `fragments`
   * (whole words of a connection's name or id) and `hosts` (its URL's hostname, or a subdomain of it) only suggest it
   * ("looks like PostHog?"): the founder confirms, and a suggestion never feeds a dashboard or a sign-in.
   */
  match?: { urls?: string[]; fragments?: string[]; hosts?: string[] }
  /** one plain line above the key forms when more than one exists: which key to make for what */
  keyGuide?: string
  docs: string
  /** shown under the card ("Sign in with your Vibiz account…") */
  note?: string
  /** listed with its own card even when not connected (key-only extras appear once connected) */
  card: boolean
  /** grouped under "For developers" */
  developer?: boolean
  /** an honest "Coming soon" (nothing to connect yet) */
  soon?: boolean
  /** Principia's own platform, shown first */
  featured?: boolean
  /** non-secret settings every surface shares (PostHog's host and project), with the dashboard config key they mirror */
  settings?: ServiceSetting[]
  /** when the vendor facts here (URLs, key-as-bearer) were last checked */
  checked: string
}

const CHECKED = '2026-10-26'
const ALL_AGENT: Capability = { purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key'] }
const KEY_AGENT: Capability = { purpose: 'agentTools', label: 'Agents get the key', via: ['key'] }
const MCP_AGENT: Capability = { purpose: 'agentTools', label: 'Agent tools', via: ['mcp'] }
const key = (name: string, label: string, hint: string, link: string, linkLabel: string, extra: Partial<ServiceKeyField> = {}): ServiceKeyField => ({ name, label, required: true, hint, link, linkLabel, ...extra })
/** A key-only service (its keys reach agents as environment variables). */
const keyOnly = (id: string, name: string, category: ServiceCategory, blurb: string, keys: ServiceKeyField[], docs: string, extra: Partial<ServiceDef> = {}, aliases?: Record<string, string[]>): ServiceDef => ({
  id, name, category, blurb, keywords: `${name.toLowerCase()} ${category.toLowerCase()}`, forms: [{ kind: 'key', keys, ...(aliases ? { aliases } : {}) }], capabilities: [KEY_AGENT], docs, card: false, checked: CHECKED, ...extra
})

/**
 * The registry. The order of the entries with an MCP form is the order of the MCP presets (CONNECTION_CATALOG), so it
 * starts with Vibiz.
 */
export const SERVICE_REGISTRY: readonly ServiceDef[] = [
  {
    id: VIBIZ_CONNECTION_ID, name: 'Vibiz', category: 'Marketing', featured: true, card: true, checked: CHECKED,
    blurb: 'Brand kit, ad creatives, campaigns, and analytics for your companies.',
    keywords: 'ads creatives marketing brand growth social campaigns analytics content',
    forms: [
      { kind: 'mcp', url: VIBIZ_MCP_URL, auth: 'oauth', bearerFromKey: { key: 'VIBIZ_MCP_TOKEN', checked: CHECKED } },
      { kind: 'key', keys: [key('VIBIZ_MCP_TOKEN', 'Workspace token', 'Vibiz → Settings → MCP → Create token (vbz_mcp_…). Gives agents the workspace it was made for.', 'https://www.vibiz.ai/docs/mcp', 'Vibiz MCP tokens', { placeholder: 'vbz_mcp_…' })] }
    ],
    capabilities: [ALL_AGENT, { purpose: 'playbook', label: 'Marketing autopilot', via: ['mcp', 'key'] }],
    docs: 'https://www.vibiz.ai/docs/mcp', note: 'Sign in with your Vibiz account. Agents get the workspace you choose during sign-in.'
  },
  {
    id: 'granola', name: 'Granola', category: 'Knowledge', card: true, checked: CHECKED,
    blurb: 'Meeting notes, decisions, and follow-ups.', keywords: 'meetings transcripts calls notes',
    forms: [{ kind: 'mcp', url: 'https://mcp.granola.ai/mcp', auth: 'oauth' }],
    capabilities: [MCP_AGENT, { purpose: 'knowledge', label: 'Meeting notes agents can look up', via: ['mcp'] }],
    docs: 'https://docs.granola.ai/help-center/sharing/integrations/mcp', note: 'Sign in to Granola. Enterprise workspaces may require an admin to enable MCP.'
  },
  {
    id: 'notion', name: 'Notion', category: 'Knowledge', card: true, checked: CHECKED,
    blurb: 'Company docs, wikis, and project knowledge.', keywords: 'documents wiki pages databases',
    forms: [
      // Notion's MCP server is OAuth only: an integration key works for scripts, not for its MCP tools
      { kind: 'mcp', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
      { kind: 'key', keys: [key('NOTION_API_KEY', 'Integration secret', 'Notion → Settings → Connections → Develop or manage integrations → New integration → Internal integration secret. Then share the pages it may read with it.', 'https://www.notion.so/profile/integrations', 'Notion integrations', { placeholder: 'ntn_…' })], aliases: { NOTION_API_KEY: ['NOTION_TOKEN'] } }
    ],
    capabilities: [ALL_AGENT, { purpose: 'knowledge', label: 'Docs agents can look up', via: ['mcp'] }],
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp', note: 'Your workspace admin may restrict which MCP clients can connect.'
  },
  {
    id: 'linear', name: 'Linear', category: 'Projects', card: true, developer: true, checked: CHECKED,
    blurb: 'Issues, projects, roadmaps, and team updates.', keywords: 'tasks tickets engineering planning issues sync tracker board',
    forms: [
      { kind: 'connector', connector: 'linear' },
      // linear.app/docs/mcp (FAQ): the server takes an API key or OAuth token as Authorization: Bearer
      // the key is the Board sync's: agents get Linear's tools from it only when the founder turns that on
      { kind: 'mcp', url: 'https://mcp.linear.app/mcp', auth: 'oauth', bearerFromKey: { key: 'LINEAR_API_KEY', checked: CHECKED, optIn: true } },
      { kind: 'key', keys: [key('LINEAR_API_KEY', 'Linear API key', 'Linear → Settings → Security & access → Personal API keys → New key.', 'https://linear.app/settings/account/security', 'Linear API keys', { placeholder: 'lin_api_…' })] }
    ],
    capabilities: [{ purpose: 'sync', label: 'Issues sync with the Board', via: ['connector'], need: 'Pick a team on Linear’s card to sync the Board; the key is enough.' }, ALL_AGENT],
    docs: 'https://linear.app/docs/mcp'
  },
  {
    id: 'github', name: 'GitHub', category: 'Development', card: true, developer: true, checked: CHECKED,
    blurb: 'Repositories, pull requests, and issues.', keywords: 'code git engineering review gh pull requests pr repository',
    forms: [
      { kind: 'account', account: 'github' },
      { kind: 'mcp', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', bearerFromKey: { key: 'GITHUB_TOKEN', checked: CHECKED } },
      { kind: 'key', keys: [key('GITHUB_TOKEN', 'GitHub token', 'A fine-grained token with read access to Pull requests, Issues, Actions and Metadata on the repositories agents need.', 'https://github.com/settings/personal-access-tokens/new', 'Create a fine-grained token', { placeholder: 'github_pat_…' })] }
    ],
    capabilities: [{ purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key', 'account'] }, { purpose: 'dashboard', label: 'Engineering dashboard', via: ['key', 'account'], refs: ['github'] }],
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    note: 'Use a GitHub personal access token with access to the repositories you need. This connects MCP tools; it does not sign in the git or gh commands.'
  },
  {
    id: 'stripe', name: 'Stripe', category: 'Finance', card: true, checked: CHECKED,
    blurb: 'Payments, customers, and subscriptions.', keywords: 'billing invoices revenue money payments',
    forms: [
      // docs.stripe.com/mcp: OAuth, or an agent API key as bearer (from December 2026 plain restricted and secret keys are refused)
      { kind: 'mcp', url: 'https://mcp.stripe.com', auth: 'oauth', bearerFromKey: { key: 'STRIPE_AGENT_API_KEY', checked: CHECKED } },
      {
        kind: 'key', serves: ['dashboard', 'playbook', 'agentTools'], good: 'For the revenue dashboard and the revenue brief. Read-only.',
        keys: [key('STRIPE_RESTRICTED_KEY', 'Restricted key (read-only)', 'Stripe → Developers → API keys → Create restricted key. Set Customers, Subscriptions and Charges to Read and everything else to None. Never paste a secret key (sk_…).', 'https://dashboard.stripe.com/apikeys/create', 'Create a restricted key', {
          placeholder: 'rk_live_…', refuse: [{ pattern: '^sk_(live|test)_', reason: 'That is a secret key, which can move money. Create a restricted key with Read on Customers, Subscriptions and Charges instead.' }]
        })]
      },
      {
        kind: 'key', serves: ['agentTools', 'askData', 'playbook'], good: 'For agents: Stripe’s own tools and questions about revenue.',
        keys: [key('STRIPE_AGENT_API_KEY', 'Agent API key', 'Stripe → Developers → API keys → Create agent key, with only the permissions agents need. Stripe’s MCP tools accept it. Never a secret key (sk_…).', 'https://docs.stripe.com/keys#agent-keys', 'Stripe agent keys', {
          placeholder: 'rk_…', refuse: [{ pattern: '^sk_(live|test)_', reason: 'That is a secret key, which can move money. Agents need a Stripe agent key, or sign in to Stripe instead.' }]
        })]
      },
      { kind: 'key', serves: ['agentTools', 'playbook'], advanced: true, good: 'Can move money. Agents get it in their environment only, never as tools.', keys: [key('STRIPE_SECRET_KEY', 'Secret key', 'Stripe → Developers → API keys. A secret key can move money: agents get it in their environment only.', 'https://dashboard.stripe.com/apikeys', 'Stripe API keys', { placeholder: 'sk_live_…' })], aliases: { STRIPE_SECRET_KEY: ['STRIPE_API_KEY'] } }
    ],
    capabilities: [
      ALL_AGENT,
      { purpose: 'dashboard', label: 'Revenue dashboard', via: ['key'], refs: ['stripe'], need: 'The revenue dashboard needs a read-only restricted key (rk_…).' },
      { purpose: 'askData', label: 'Ask about revenue', via: ['mcp'] },
      { purpose: 'playbook', label: 'Revenue brief autopilot', via: ['mcp', 'key'], refs: ['revenue-brief'] }
    ],
    keyGuide: 'For the revenue dashboard: a restricted key (read-only). For agents: an agent key, or sign in. Both together need two keys.',
    docs: 'https://docs.stripe.com/mcp'
  },
  {
    id: 'posthog', name: 'PostHog', category: 'Analytics', card: true, checked: CHECKED,
    blurb: 'Product analytics, session replays, feature flags and data questions.',
    keywords: 'analytics product events funnels sessions replay recordings feature flags experiments hogql',
    forms: [
      { kind: 'key', keys: [key('POSTHOG_PERSONAL_API_KEY', 'Personal API key', 'PostHog → Settings → Personal API keys → Create. For dashboards: Query Read and Project Read, limited to this project. Agents also get PostHog’s tools from this key.', 'https://posthog.com/docs/api#private-endpoint-authentication', 'PostHog personal API keys', {
        placeholder: 'phx_…', refuse: [{ pattern: '^phc_', reason: 'That is a project key: it can send events but cannot read them. Create a personal API key instead.' }]
      })], aliases: { POSTHOG_PERSONAL_API_KEY: ['POSTHOG_API_KEY'] } },
      // posthog.com/docs/model-context-protocol/faq: a personal API key works as Authorization: Bearer
      { kind: 'mcp', url: 'https://mcp.posthog.com/mcp', auth: 'oauth', bearerFromKey: { key: 'POSTHOG_PERSONAL_API_KEY', checked: CHECKED, regional: [{ setting: 'host', contains: 'eu.posthog.com', url: 'https://mcp-eu.posthog.com/mcp' }] } }
    ],
    capabilities: [
      { purpose: 'dashboard', label: 'Product analytics dashboard', via: ['key', 'mcp'], refs: ['posthog'] },
      { purpose: 'agentTools', label: 'Agent tools (insights, flags, SQL)', via: ['mcp', 'key'] },
      { purpose: 'askData', label: 'Ask about your data', via: ['mcp', 'key'] },
      { purpose: 'sessionReplay', label: 'Session replays', via: ['mcp', 'key'], open: '{host}/project/{projectId}/replay/home' }
    ],
    match: { urls: ['https://mcp.posthog.com/mcp', 'https://mcp.posthog.com/sse', 'https://mcp-eu.posthog.com/mcp'], fragments: ['posthog'], hosts: ['posthog.com'] },
    settings: [
      { key: 'projectId', label: 'Project ID', hint: 'PostHog → Settings → Project → Project ID (a number).', needed: 'Needed for the dashboard and session links.', placeholder: '12345' },
      { key: 'host', label: 'Region', hint: 'Where your PostHog account lives: the address you sign in at.', choices: [{ label: 'US cloud', value: 'https://us.posthog.com' }, { label: 'EU cloud', value: 'https://eu.posthog.com' }, { label: 'Self-hosted', value: '' }], host: { known: ['https://us.posthog.com', 'https://eu.posthog.com', 'https://app.posthog.com'] } }
    ],
    docs: 'https://posthog.com/docs/model-context-protocol'
  },
  {
    id: 'mobbin', name: 'Mobbin', category: 'Design', card: true, developer: true, checked: CHECKED,
    blurb: 'Design references and product inspiration.', keywords: 'screenshots ui ux patterns',
    forms: [{ kind: 'mcp', url: 'https://api.mobbin.com/mcp', auth: 'oauth' }], capabilities: [MCP_AGENT], docs: 'https://docs.mobbin.com/mcp/clients/overview'
  },
  {
    id: 'supabase', name: 'Supabase', category: 'Data', card: true, developer: true, checked: CHECKED,
    blurb: 'Postgres databases and app infrastructure.', keywords: 'sql storage backend database',
    forms: [
      // supabase.com/docs/guides/getting-started/mcp: a personal access token as Authorization: Bearer
      { kind: 'mcp', url: 'https://mcp.supabase.com/mcp?read_only=true', auth: 'oauth', bearerFromKey: { key: 'SUPABASE_ACCESS_TOKEN', checked: CHECKED } },
      { kind: 'key', keys: [key('SUPABASE_ACCESS_TOKEN', 'Personal access token', 'Supabase → Account → Access tokens → Generate new token. Not the service-role key: that one is for your app, not for MCP.', 'https://supabase.com/dashboard/account/tokens', 'Supabase access tokens', { placeholder: 'sbp_…' })] },
      { kind: 'key', serves: ['agentTools'], keys: [key('SUPABASE_SERVICE_ROLE_KEY', 'Service-role key', 'Project settings → API → service_role. Agents get it in their environment only.', 'https://supabase.com/dashboard/project/_/settings/api', 'Supabase API keys')] }
    ],
    capabilities: [ALL_AGENT], docs: 'https://supabase.com/docs/guides/ai-tools/mcp', note: 'Starts in read-only mode. You can add project_ref to the server URL to restrict it to one Supabase project.'
  },
  {
    id: 'neon', name: 'Neon', category: 'Data', card: true, developer: true, checked: CHECKED,
    blurb: 'Serverless Postgres projects and branches.', keywords: 'database sql backend',
    forms: [
      // neon.com/docs/ai/connect-mcp-clients-to-neon: an API key as Authorization: Bearer on /mcp
      { kind: 'mcp', url: 'https://mcp.neon.tech/mcp', auth: 'oauth', bearerFromKey: { key: 'NEON_API_KEY', checked: CHECKED } },
      { kind: 'key', keys: [key('NEON_API_KEY', 'Neon API key', 'Neon Console → Account settings → API keys → Create new API key.', 'https://console.neon.tech/app/settings/api-keys', 'Neon API keys', { placeholder: 'napi_…' })] }
    ],
    capabilities: [ALL_AGENT], docs: 'https://neon.com/docs/ai/connect-mcp-clients-to-neon'
  },
  {
    id: 'sentry', name: 'Sentry', category: 'Development', card: true, developer: true, checked: CHECKED,
    blurb: 'Errors, performance, and production issues.', keywords: 'monitoring bugs observability incidents',
    forms: [
      // mcp.sentry.dev: "All connections use OAuth"; a token still reaches agents as an environment variable
      { kind: 'mcp', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
      { kind: 'key', keys: [key('SENTRY_AUTH_TOKEN', 'Auth token', 'Sentry → Settings → Auth tokens → Create new token.', 'https://sentry.io/settings/account/api/auth-tokens/', 'Sentry auth tokens', { placeholder: 'sntryu_…' })] }
    ],
    capabilities: [ALL_AGENT], docs: 'https://mcp.sentry.dev/'
  },
  {
    id: 'firecrawl', name: 'Firecrawl', category: 'Research', card: true, checked: CHECKED,
    blurb: 'Turn websites into usable research and data.', keywords: 'scraping crawling web search extraction',
    forms: [
      // docs.firecrawl.dev/mcp-server: sign-in at /v2/mcp-oauth, an API key as bearer at /v2/mcp
      { kind: 'mcp', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', auth: 'oauth', bearerFromKey: { key: 'FIRECRAWL_API_KEY', url: 'https://mcp.firecrawl.dev/v2/mcp', checked: CHECKED } },
      { kind: 'key', keys: [key('FIRECRAWL_API_KEY', 'Firecrawl API key', 'firecrawl.dev → Dashboard → API keys.', 'https://www.firecrawl.dev/app/api-keys', 'Firecrawl API keys', { placeholder: 'fc-…' })] }
    ],
    capabilities: [ALL_AGENT], match: { urls: ['https://mcp.firecrawl.dev/v2/mcp'] }, docs: 'https://docs.firecrawl.dev/mcp-server/oauth'
  },
  {
    id: 'tavily', name: 'Tavily', category: 'Research', card: true, checked: CHECKED,
    blurb: 'Search the web and extract source material.', keywords: 'research search scraping browsing',
    forms: [{ kind: 'mcp', url: 'https://mcp.tavily.com/mcp/', auth: 'oauth' }, { kind: 'key', keys: [key('TAVILY_API_KEY', 'Tavily API key', 'app.tavily.com → API keys.', 'https://app.tavily.com/home', 'Tavily API keys', { placeholder: 'tvly-…' })] }],
    capabilities: [ALL_AGENT], docs: 'https://docs.tavily.com/documentation/mcp'
  },
  {
    id: 'figma', name: 'Figma', category: 'Design', card: true, developer: true, checked: CHECKED,
    blurb: 'Design files, components, and UI context.', keywords: 'design ui ux mockups',
    forms: [{ kind: 'mcp', url: 'https://mcp.figma.com/mcp', auth: 'oauth', setupRequired: true }], capabilities: [MCP_AGENT],
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    note: 'Figma requires approval for new MCP clients. Principia is not yet an approved client. See Figma’s setup guide for supported clients and the local desktop server.'
  },
  {
    id: 'hubspot', name: 'HubSpot', category: 'Sales', card: true, checked: CHECKED,
    blurb: 'CRM contacts, companies, and sales context.', keywords: 'crm pipeline marketing deals customers',
    forms: [{ kind: 'mcp', url: 'https://mcp.hubspot.com', auth: 'oauth', setupRequired: true }, { kind: 'key', keys: [key('HUBSPOT_ACCESS_TOKEN', 'Private app token', 'HubSpot → Settings → Integrations → Private apps → Create, then copy its access token.', 'https://developers.hubspot.com/docs/api/private-apps', 'HubSpot private apps', { placeholder: 'pat-…' })] }],
    capabilities: [ALL_AGENT], docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    note: 'HubSpot requires registered OAuth app credentials. Principia’s gateway currently supports automatic registration, so direct HubSpot sign-in is not available yet.'
  },
  {
    id: 'asana', name: 'Asana', category: 'Projects', card: true, developer: true, checked: CHECKED,
    blurb: 'Team tasks, projects, and work tracking.', keywords: 'tasks planning operations',
    forms: [{ kind: 'mcp', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth', setupRequired: true }], capabilities: [MCP_AGENT],
    docs: 'https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server',
    note: 'Asana V2 requires a registered client ID and secret. Direct Asana sign-in needs registered-client support in Principia first.'
  },
  // ---- key and account services (no MCP preset) ----
  {
    id: 'plausible', name: 'Plausible', category: 'Analytics', card: true, checked: CHECKED,
    blurb: 'Privacy-friendly web analytics: visitors, pages and sources.', keywords: 'analytics web traffic visitors pageviews',
    forms: [{ kind: 'key', keys: [key('PLAUSIBLE_API_KEY', 'Stats API key', 'Plausible → Account settings → API keys → New API key → Stats API.', 'https://plausible.io/docs/stats-api', 'Plausible Stats API', { placeholder: 'Paste the key' })] }],
    capabilities: [{ purpose: 'dashboard', label: 'Web analytics dashboard', via: ['key'], refs: ['plausible'] }, KEY_AGENT],
    match: { fragments: ['plausible'], hosts: ['plausible.io'] },
    settings: [
      { key: 'siteId', label: 'Site', hint: 'The site’s domain exactly as Plausible lists it, without https://.', needed: 'Needed for the dashboard.', placeholder: 'example.com' },
      { key: 'host', label: 'Host', hint: 'Leave empty for plausible.io. Only for a self-hosted Plausible.', placeholder: 'https://plausible.io', host: { known: ['https://plausible.io'] } }
    ],
    docs: 'https://plausible.io/docs/stats-api'
  },
  {
    id: 'google-search-console', name: 'Google Search Console', category: 'Analytics', card: true, checked: CHECKED,
    blurb: 'Clicks, impressions and rank from Google Search, plus PageSpeed.', keywords: 'seo search google gsc pagespeed rank queries',
    forms: [{
      kind: 'key',
      keys: [
        key('GSC_SERVICE_ACCOUNT_JSON', 'Service account JSON', 'Google Cloud → IAM → Service accounts → create one → Keys → Add key → JSON. Turn on the Search Console API, then add the account’s email as a Restricted user of your property in Search Console.', 'https://developers.google.com/webmaster-tools/v1/how-tos/authorizing', 'Search Console API access', { multiline: true, placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "…" }' }),
        key('PAGESPEED_API_KEY', 'PageSpeed API key', 'Optional. Without it PageSpeed still runs, with a lower daily quota. Google Cloud → APIs & Services → Credentials → API key.', 'https://developers.google.com/speed/docs/insights/v5/get-started#APIKey', 'Get a PageSpeed key', { required: false, placeholder: 'AIza…' })
      ]
    }],
    capabilities: [{ purpose: 'dashboard', label: 'SEO dashboard', via: ['key'], refs: ['gsc'] }, KEY_AGENT],
    settings: [{ key: 'siteUrl', label: 'Property', hint: 'The property as Search Console lists it: https://example.com/ or sc-domain:example.com.', needed: 'Needed for the dashboard.' }], docs: 'https://developers.google.com/webmaster-tools'
  },
  {
    id: 'slack', name: 'Slack', category: 'Communication', card: true, checked: CHECKED,
    blurb: 'Agents read threads and draft replies; alerts reach you in Slack.', keywords: 'slack chat messages channels alerts',
    forms: [{ kind: 'connector', connector: 'slack' }],
    capabilities: [{ purpose: 'agentTools', label: 'Slack tools', via: ['connector'] }, { purpose: 'sync', label: 'Threads and alerts', via: ['connector'] }], docs: 'https://api.slack.com/apps'
  },
  {
    id: 'openai', name: 'OpenAI', category: 'AI', card: true, checked: CHECKED,
    blurb: 'GPT models for agents, and ChatGPT answers for AI visibility.', keywords: 'openai gpt chatgpt ai models geo',
    forms: [{ kind: 'key', keys: [key('OPENAI_API_KEY', 'OpenAI key', 'platform.openai.com → API keys → Create (a project key with Model capabilities is enough).', 'https://platform.openai.com/api-keys', 'OpenAI API keys', { placeholder: 'sk-…' })] }],
    capabilities: [KEY_AGENT, { purpose: 'dashboard', label: 'AI visibility dashboard', via: ['key'], refs: ['geo'] }], docs: 'https://platform.openai.com/docs'
  },
  {
    id: 'perplexity', name: 'Perplexity', category: 'AI', card: true, checked: CHECKED,
    blurb: 'Web answers with citations, for research and AI visibility.', keywords: 'perplexity search answers citations geo research',
    forms: [{ kind: 'key', keys: [key('PERPLEXITY_API_KEY', 'Perplexity key', 'Perplexity searches the web and returns its citations, so you see whether your site is the source.', 'https://www.perplexity.ai/account/api/keys', 'Perplexity API keys', { placeholder: 'pplx-…' })] }],
    capabilities: [KEY_AGENT, { purpose: 'dashboard', label: 'AI visibility dashboard', via: ['key'], refs: ['geo'] }], docs: 'https://docs.perplexity.ai'
  },
  {
    id: 'fal', name: 'fal', category: 'AI', card: true, checked: CHECKED,
    blurb: 'Image and video generation for creatives.', keywords: 'fal images video generation creatives',
    forms: [{ kind: 'key', keys: [key('FAL_KEY', 'fal key', 'fal.ai → Dashboard → Keys → Add key.', 'https://fal.ai/dashboard/keys', 'fal keys')], aliases: { FAL_KEY: ['FAL_API_KEY'] } }],
    capabilities: [KEY_AGENT], docs: 'https://fal.ai/docs'
  },
  {
    id: 'instagram', name: 'Instagram', category: 'Social', card: true, checked: CHECKED,
    blurb: 'Agents get each post ready (picture, caption, hashtags) for your OK.', keywords: 'instagram social posts ig meta reels',
    forms: [
      { kind: 'account', account: 'instagram' },
      { kind: 'key', serves: ['posting', 'agentTools'], keys: [key('INSTAGRAM_ACCESS_TOKEN', 'Access token', 'Needs an Instagram professional account and a Meta app with the instagram_content_publish permission.', 'https://developers.facebook.com/docs/instagram-platform/content-publishing', 'Instagram content publishing'), key('INSTAGRAM_USER_ID', 'Instagram account id', 'The Instagram professional account id the token posts as.', 'https://developers.facebook.com/docs/instagram-platform/content-publishing', 'Instagram content publishing')] }
    ],
    capabilities: [{ purpose: 'posting', label: 'Posting', via: ['key', 'mcp'] }, { purpose: 'agentTools', label: 'Drafts for your OK', via: ['account', 'key', 'mcp'] }],
    match: { fragments: ['instagram'], hosts: ['instagram.com'] }, docs: 'https://developers.facebook.com/docs/instagram-platform/content-publishing'
  },
  {
    id: 'x', name: 'X (Twitter)', category: 'Social', card: false, checked: CHECKED,
    blurb: 'Post and read on X.', keywords: 'x twitter social posts',
    forms: [{ kind: 'key', keys: [
      key('X_API_KEY', 'API key (consumer key)', 'X developer portal → your app → Keys and tokens.', 'https://developer.x.com/en/portal/dashboard', 'X developer portal'),
      key('X_API_SECRET', 'API key secret', 'X developer portal → your app → Keys and tokens.', 'https://developer.x.com/en/portal/dashboard', 'X developer portal'),
      key('X_ACCESS_TOKEN', 'Access token', 'Generate it with Read and write permissions.', 'https://developer.x.com/en/portal/dashboard', 'X developer portal'),
      key('X_ACCESS_TOKEN_SECRET', 'Access token secret', 'Generated with the access token.', 'https://developer.x.com/en/portal/dashboard', 'X developer portal')
    ] }],
    capabilities: [{ purpose: 'posting', label: 'Posting', via: ['mcp', 'key'] }, { purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key'] }],
    match: { fragments: ['twitter'], hosts: ['x.com', 'twitter.com'] }, docs: 'https://developer.x.com/en/portal/dashboard'
  },
  {
    id: 'linkedin', name: 'LinkedIn', category: 'Social', card: false, checked: CHECKED, blurb: 'Post as your member account.', keywords: 'linkedin social posts',
    forms: [{ kind: 'key', keys: [key('LINKEDIN_ACCESS_TOKEN', 'Member access token', 'An app with Share on LinkedIn and a token with the w_member_social scope.', 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin', 'Share on LinkedIn')] }],
    capabilities: [{ purpose: 'posting', label: 'Posting', via: ['mcp', 'key'] }, { purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key'] }],
    match: { fragments: ['linkedin'], hosts: ['linkedin.com'] }, docs: 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin'
  },
  {
    id: 'tiktok', name: 'TikTok', category: 'Social', card: false, checked: CHECKED, blurb: 'Post videos (private until TikTok audits the app).', keywords: 'tiktok social video',
    forms: [{ kind: 'key', keys: [key('TIKTOK_ACCESS_TOKEN', 'User access token', 'A TikTok developer app with the Content Posting API and video.publish.', 'https://developers.tiktok.com/doc/content-posting-api-get-started', 'TikTok Content Posting API')] }],
    capabilities: [{ purpose: 'posting', label: 'Posting', via: ['mcp', 'key'] }, { purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key'] }],
    match: { fragments: ['tiktok'], hosts: ['tiktok.com', 'tiktokapis.com'] }, docs: 'https://developers.tiktok.com/doc/content-posting-api-get-started'
  },
  {
    id: 'youtube', name: 'YouTube', category: 'Social', card: false, checked: CHECKED, blurb: 'Channel and video stats.', keywords: 'youtube video social stats',
    forms: [{ kind: 'key', keys: [key('YOUTUBE_API_KEY', 'YouTube Data API key', 'Google Cloud → enable the YouTube Data API v3 → Credentials → API key.', 'https://developers.google.com/youtube/v3/getting-started', 'YouTube Data API')] }],
    capabilities: [{ purpose: 'agentTools', label: 'Agent tools', via: ['mcp', 'key'] }],
    match: { fragments: ['youtube'], hosts: ['youtube.com'] }, docs: 'https://developers.google.com/youtube/v3/getting-started'
  },
  // ---- honest "Coming soon" ----
  { id: 'shopify', name: 'Shopify', category: 'Commerce', card: true, soon: true, checked: CHECKED, blurb: 'Orders, products and customers for Support and Marketing.', keywords: 'store shop ecommerce orders products', forms: [{ kind: 'key', keys: [key('SHOPIFY_ACCESS_TOKEN', 'Admin API token', 'Shopify admin → Apps → Develop apps → your app → Admin API access token.', 'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin', 'Shopify access tokens')] }], capabilities: [KEY_AGENT], docs: 'https://shopify.dev' },
  { id: 'google-business', name: 'Google Business', category: 'Marketing', card: true, soon: true, checked: CHECKED, blurb: 'Reviews and local search for your shop.', keywords: 'google maps reviews local gbp', forms: [], capabilities: [], docs: 'https://developers.google.com/my-business' },
  { id: 'meta-ads', name: 'Meta Ads', category: 'Marketing', card: true, soon: true, checked: CHECKED, blurb: 'Read ad results. Spending always asks you first.', keywords: 'facebook ads advertising meta campaigns', forms: [], capabilities: [], docs: 'https://developers.facebook.com/docs/marketing-apis' },
  // ---- key-only extras (shown once connected) ----
  keyOnly('anthropic', 'Anthropic', 'AI', 'Claude models through the API.', [key('ANTHROPIC_API_KEY', 'Anthropic key', 'console.anthropic.com → API keys → Create key.', 'https://console.anthropic.com/settings/keys', 'Anthropic API keys')], 'https://docs.anthropic.com'),
  keyOnly('gemini', 'Gemini', 'AI', 'Google’s Gemini models.', [key('GEMINI_API_KEY', 'Gemini key', 'aistudio.google.com → Get API key.', 'https://aistudio.google.com/app/apikey', 'Gemini API keys')], 'https://ai.google.dev'),
  keyOnly('replicate', 'Replicate', 'AI', 'Run open models in the cloud.', [key('REPLICATE_API_TOKEN', 'Replicate token', 'replicate.com → Account → API tokens.', 'https://replicate.com/account/api-tokens', 'Replicate tokens')], 'https://replicate.com/docs'),
  keyOnly('elevenlabs', 'ElevenLabs', 'AI', 'Voices and speech.', [key('ELEVENLABS_API_KEY', 'ElevenLabs key', 'elevenlabs.io → Profile → API keys.', 'https://elevenlabs.io/app/settings/api-keys', 'ElevenLabs keys')], 'https://elevenlabs.io/docs'),
  keyOnly('resend', 'Resend', 'Communication', 'Send email.', [key('RESEND_API_KEY', 'Resend key', 'resend.com → API keys → Create.', 'https://resend.com/api-keys', 'Resend keys')], 'https://resend.com/docs'),
  keyOnly('sendgrid', 'SendGrid', 'Communication', 'Send email.', [key('SENDGRID_API_KEY', 'SendGrid key', 'SendGrid → Settings → API keys → Create.', 'https://app.sendgrid.com/settings/api_keys', 'SendGrid keys')], 'https://www.twilio.com/docs/sendgrid'),
  keyOnly('twilio', 'Twilio', 'Communication', 'SMS and calls.', [key('TWILIO_AUTH_TOKEN', 'Auth token', 'Twilio Console → Account info → Auth token.', 'https://console.twilio.com', 'Twilio Console')], 'https://www.twilio.com/docs'),
  keyOnly('apify', 'Apify', 'Research', 'Scrapers and automation actors.', [key('APIFY_API_TOKEN', 'Apify token', 'console.apify.com → Settings → Integrations → API token.', 'https://console.apify.com/settings/integrations', 'Apify tokens')], 'https://docs.apify.com', {}, { APIFY_API_TOKEN: ['APIFY_TOKEN'] }),
  keyOnly('serpapi', 'SerpApi', 'Research', 'Search engine results.', [key('SERPAPI_API_KEY', 'SerpApi key', 'serpapi.com → Dashboard → API key.', 'https://serpapi.com/manage-api-key', 'SerpApi key')], 'https://serpapi.com'),
  keyOnly('browserbase', 'Browserbase', 'Research', 'Cloud browsers for agents.', [key('BROWSERBASE_API_KEY', 'Browserbase key', 'browserbase.com → Settings → API key.', 'https://www.browserbase.com/settings', 'Browserbase settings')], 'https://docs.browserbase.com'),
  keyOnly('airtable', 'Airtable', 'Data', 'Bases and records.', [key('AIRTABLE_API_KEY', 'Airtable token', 'airtable.com → Builder hub → Personal access tokens.', 'https://airtable.com/create/tokens', 'Airtable tokens')], 'https://airtable.com/developers/web/api'),
  keyOnly('cloudflare', 'Cloudflare', 'Development', 'DNS, Workers and pages.', [key('CLOUDFLARE_API_TOKEN', 'API token', 'dash.cloudflare.com → My profile → API tokens.', 'https://dash.cloudflare.com/profile/api-tokens', 'Cloudflare tokens')], 'https://developers.cloudflare.com', { developer: true }),
  keyOnly('vercel', 'Vercel', 'Development', 'Deployments and projects.', [key('VERCEL_TOKEN', 'Vercel token', 'vercel.com → Account settings → Tokens.', 'https://vercel.com/account/tokens', 'Vercel tokens')], 'https://vercel.com/docs', { developer: true })
]

// ---------- lookups ----------

const BY_ID = new Map(SERVICE_REGISTRY.map((s) => [s.id, s]))
export function serviceById(id: string | null | undefined): ServiceDef | undefined {
  return id ? BY_ID.get(id) : undefined
}

export function keyForms(s: ServiceDef): Extract<AuthForm, { kind: 'key' }>[] {
  return s.forms.filter((f): f is Extract<AuthForm, { kind: 'key' }> => f.kind === 'key')
}
export function mcpForm(s: ServiceDef): Extract<AuthForm, { kind: 'mcp' }> | undefined {
  return s.forms.find((f): f is Extract<AuthForm, { kind: 'mcp' }> => f.kind === 'mcp')
}
/** Every key field of a service (all its key forms). */
export function serviceKeyFields(id: string): ServiceKeyField[] {
  const s = serviceById(id)
  return s ? keyForms(s).flatMap((f) => f.keys) : []
}
/** A key field by name, for a dashboard or a form that reuses it (`over` changes the dashboard-specific bits). */
export function keyField(serviceId: string, name: string, over: Partial<ServiceKeyField> = {}): ServiceKeyField {
  const f = serviceKeyFields(serviceId).find((k) => k.name === name)
  if (!f) throw new Error(`services: ${serviceId} has no key ${name}`)
  return { ...f, ...over }
}

/** canonical name → its aliases, across the registry */
const ALIASES = new Map<string, string[]>()
for (const s of SERVICE_REGISTRY) for (const f of keyForms(s)) for (const [canon, olds] of Object.entries(f.aliases ?? {})) ALIASES.set(canon, [...(ALIASES.get(canon) ?? []), ...olds])
/** Older names that count as `name` (read, never written). POSTHOG_PERSONAL_API_KEY → [POSTHOG_API_KEY]. */
export function keyAliases(name: string): string[] {
  return ALIASES.get(name) ?? []
}
/** `names` plus every alias of each (the names to look up). */
export function withAliases(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((n) => [n, ...keyAliases(n)]))]
}
/** Values under canonical names: a canonical name missing from `found` takes its first alias that is present. */
export function foldAliases<T>(names: readonly string[], found: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const n of names) {
    if (found[n] !== undefined) out[n] = found[n]
    else for (const a of keyAliases(n)) if (found[a] !== undefined) { out[n] = found[a]; break }
  }
  return out
}

const KEY_TO_SERVICE = new Map<string, string>()
for (const s of SERVICE_REGISTRY) for (const f of keyForms(s)) for (const k of f.keys) { KEY_TO_SERVICE.set(k.name, s.id); for (const a of keyAliases(k.name)) KEY_TO_SERVICE.set(a, s.id) }
/** POSTHOG_API_KEY → PostHog. Undefined for a name no service claims. */
export function serviceForKey(name: string): ServiceDef | undefined {
  return serviceById(KEY_TO_SERVICE.get(name))
}

const endpoint = (url: string): { origin: string; path: string } | null => {
  try {
    const u = new URL(url)
    return { origin: u.origin, path: u.pathname.replace(/\/$/, '') }
  } catch {
    return null
  }
}
/** The service an MCP URL belongs to (https origin and path, exactly; query strings like ?project_ref= do not matter). */
export function serviceForUrl(url: string): ServiceDef | undefined {
  const p = endpoint(url)
  if (!p || !p.origin.startsWith('https://')) return undefined
  return SERVICE_REGISTRY.find((s) => {
    const urls = [...s.forms.flatMap((f) => (f.kind === 'mcp' ? [f.url, ...(f.bearerFromKey?.url ? [f.bearerFromKey.url] : [])] : [])), ...(s.match?.urls ?? [])]
    return urls.some((u) => {
      const c = endpoint(u)
      return !!c && c.origin === p.origin && c.path === p.path
    })
  })
}
/**
 * The service a saved gateway connection IS: only by its exact https URL (CONNECTIONS.md §3.4). A name, a command or a
 * look-alike host never makes a connection count as a service (a server named "PostHog insights" at another host is
 * not PostHog): see `suggestServiceForConnection`.
 */
export function serviceForConnection(c: Pick<GatewayConnection, 'url'>): ServiceDef | undefined {
  return c.url ? serviceForUrl(c.url) : undefined
}

/** The hostname of a connection's URL ("mcp.posthog.com"), or its command for a local server. */
export function connectionHost(c: Pick<GatewayConnection, 'url' | 'command'>): string {
  if (c.url) {
    try {
      return new URL(c.url).host
    } catch {
      return c.url.slice(0, 60)
    }
  }
  return c.command ? `${c.command.split('/').pop()} on this Mac` : 'this Mac'
}

const words = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
/**
 * The service a connection only LOOKS like (a whole word of its name or id, or its host under the vendor's domain):
 * shown as "looks like PostHog?" for the founder to confirm. Never identity: a suggestion connects nothing by itself.
 */
export function suggestServiceForConnection(c: Pick<GatewayConnection, 'id' | 'name' | 'url' | 'command' | 'args'>): ServiceDef | undefined {
  if (serviceForConnection(c)) return undefined
  let host = ''
  try {
    host = c.url ? new URL(c.url).hostname.toLowerCase() : ''
  } catch {
    host = ''
  }
  const ws = new Set([...words(c.id), ...words(c.name), ...(c.command ? words(c.command) : []), ...(c.args ?? []).flatMap(words)])
  return SERVICE_REGISTRY.find((s) => (s.match?.hosts ?? []).some((h) => host === h || host.endsWith(`.${h}`)) || (s.match?.fragments ?? []).some((f) => ws.has(f)))
}

/** Search over name, blurb, keywords and category; every word must match. */
export function searchServices(query: string): ServiceDef[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return SERVICE_REGISTRY.filter((s) => words.every((w) => `${s.name} ${s.blurb} ${s.keywords} ${s.category}`.toLowerCase().includes(w)))
}

// ---------- one gateway connection's state (shared by Settings and the resolver) ----------

export type ConnState = 'connected' | 'attention' | 'waiting' | 'off' | 'notConnected' | 'soon' | 'setup'

const usable = (c: GatewayConnection): boolean => c.enabled && c.authStatus !== 'error' && (c.authentication === 'oauth' ? c.authStatus === 'connected' : c.hasCredentials || c.transport === 'stdio' || c.authentication === 'none' || c.authentication === undefined)

/** A gateway connection's one state, with its chip. */
export function connectionState(c: GatewayConnection): { state: ConnState; chip: string } {
  if (!c.enabled) return { state: 'off', chip: 'Turned off' }
  if (c.authStatus === 'error') return { state: 'attention', chip: 'Needs attention' }
  if (c.authStatus === 'connecting') return { state: 'waiting', chip: 'Waiting for sign-in' }
  // the Vibiz card is there from install: never signed in is "Not signed in", not a problem to fix
  if (c.id === VIBIZ_CONNECTION_ID && c.authentication === 'oauth' && (c.authStatus ?? 'disconnected') === 'disconnected') return { state: 'notConnected', chip: 'Not signed in' }
  if (c.authentication === 'oauth' && c.authStatus !== 'connected') return { state: 'attention', chip: 'Sign-in needed' }
  return usable(c) ? { state: 'connected', chip: 'Connected' } : { state: 'attention', chip: 'Needs a key' }
}

// ---------- status (CONNECTIONS.md §3.2), pure ----------

/** Where a key resolves from for one company (never its value). `reused`: from the company it is reused from. */
export interface KeyPresence {
  name: string
  source: 'company' | 'shared' | 'reused' | null
  masked: string | null
}

export interface FormEvidence {
  kind: FormKind
  state: 'connected' | 'attention' | 'waiting' | 'off'
  /** plain words: "POSTHOG_PERSONAL_API_KEY (this company)", "PostHog (mcp.posthog.com) · signed in", "GitHub as @diego" */
  detail: string
  keyNames?: KeyPresence[]
  connectionId?: string
  /** a key-backed MCP connection the gateway builds from the saved key (never stored) */
  virtual?: boolean
  problem?: string
  /** read from another company ("Also use in…"): `from` names it */
  reused?: boolean
  from?: string
  /** mcp: the connection's URL is the registry's own (a founder-confirmed look-alike is not, and never feeds a dashboard) */
  exact?: boolean
  /** mcp: how the connection authenticates (a token header is not a sign-in) */
  auth?: 'oauth' | 'token' | 'none'
  /** mcp: the saved connection's own name and host, so the founder sees which server it is */
  name?: string
  host?: string
}

export interface PurposeState {
  ok: boolean
  label: string
  via?: FormKind
  /** why it can't, in plain words (the service is connected, but not in a form that does this) */
  why?: string
  /** what would fix it: add a key, or sign in */
  fix?: 'key' | 'signIn'
  /** the key form that would do it (Stripe's dashboard: the restricted key) */
  fixKey?: string
}

export interface UsageRef {
  kind: 'dashboard' | 'agents' | 'playbook' | 'routine' | 'sync' | 'posting' | 'company'
  label: string
  id?: string
}

/** Renderer-safe: names, states and masked forms only. */
export interface ServiceStatus {
  serviceId: string
  name: string
  category: ServiceCategory
  state: ConnState
  chip: string
  forms: FormEvidence[]
  purposes: Partial<Record<Purpose, PurposeState>>
  settings: Record<string, string>
  sharedFrom?: { companyId: string; name: string } | null
  usedBy: UsageRef[]
  /** principia://connect/<service>?company=… */
  link: string
  card: boolean
  /** saved connections that only look like this service ("looks like PostHog?"): the founder confirms one or not */
  suggested?: { connectionId: string; name: string; host: string }[]
  /** Linear: agents may get the vendor's tools from the sync key (the founder turned it on) */
  keyTools?: boolean
}

/** What one company has, as the status rules need it. */
export interface CompanyHoldings {
  companyId: string
  /** every key name the company can read (own, Shared, reused), with where it resolves from */
  keys: readonly KeyPresence[]
  /** every saved gateway connection (filtered to this company here) */
  connections: readonly GatewayConnection[]
  accounts?: CompanyAccounts | null
  gh?: 'ok' | 'signedOut' | 'missing' | 'unknown'
  slack: 'connected' | 'set-up' | 'none' | 'unavailable'
  linear: { connected: boolean; problem: string | null }
  /** key names (stored or canonical) a check turned down (refuse pattern, invalid key): name → plain reason. The key is off for everything. */
  keyProblems?: Readonly<Record<string, string>>
  /** a key that works but lacks a permission for one purpose (a dashboard's forbidden): name → purpose → reason */
  scopeProblems?: Readonly<Record<string, Partial<Record<Purpose, string>>>>
}

/** The per-company choices for one service (company_connections), as the status rules read them. */
export interface ServiceChoice {
  mcpConnectionId?: string | null
  /** the founder picked `mcpConnectionId` themselves ("Use it"): a look-alike counts for agent tools only then */
  mcpConfirmed?: boolean
  settings?: Record<string, string>
  /** reused from this company (its holdings are passed as `source`) */
  sourceCompany?: { companyId: string; name: string } | null
  hidden?: boolean
  /** which key serves which purpose; `agentTools` naming an opt-in bearer key turns its tools on (Linear) */
  keyChoice?: Partial<Record<Purpose, string>>
}

const SOURCE_WORD: Record<'company' | 'shared' | 'reused', string> = { company: 'this company', shared: 'Shared', reused: 'another company' }
const STATE_RANK: Record<FormEvidence['state'], number> = { connected: 0, attention: 1, waiting: 2, off: 3 }

/** The KeyPresence for a canonical key name: itself, else its first older name that is present. */
function findKey(name: string, byName: ReadonlyMap<string, KeyPresence>): KeyPresence | undefined {
  const own = byName.get(name)
  if (own) return own
  for (const a of keyAliases(name)) {
    const alias = byName.get(a)
    if (alias) return alias
  }
  return undefined
}

function keyEvidence(s: ServiceDef, form: Extract<AuthForm, { kind: 'key' }>, h: CompanyHoldings): FormEvidence | null {
  const byName = new Map(h.keys.filter((k) => k.source).map((k) => [k.name, k]))
  const required = form.keys.filter((k) => k.required)
  const pairs = form.keys.map((k) => ({ field: k, have: findKey(k.name, byName) })).filter((p): p is { field: ServiceKeyField; have: KeyPresence } => !!p.have)
  const ok = required.length ? required.every((k) => !!findKey(k.name, byName)) : pairs.length > 0
  if (!ok) return null
  // a problem is recorded under the canonical name (a dashboard's key) or the stored one (a refuse check): either counts
  const problem = pairs.map((p) => h.keyProblems?.[p.have.name] ?? h.keyProblems?.[p.field.name]).find(Boolean)
  return {
    kind: 'key',
    state: problem ? 'attention' : 'connected',
    detail: pairs.map((p) => `${p.have.name} (${SOURCE_WORD[p.have.source!]})`).join(', '),
    keyNames: pairs.map((p) => p.have),
    ...(problem ? { problem } : {})
  }
}

/** The saved connections that ARE this service here: its exact URL, or the one the founder confirmed. */
function mcpEvidence(s: ServiceDef, h: CompanyHoldings, choice?: ServiceChoice): FormEvidence[] {
  const mine = connectionsFor(h.connections, h.companyId)
  const matches = mine.filter((c) => serviceForConnection(c)?.id === s.id || (choice?.mcpConfirmed && c.id === choice.mcpConnectionId))
  return matches.map((c) => {
    const st = connectionState(c)
    const state: FormEvidence['state'] = st.state === 'connected' ? 'connected' : st.state === 'waiting' ? 'waiting' : st.state === 'off' ? 'off' : 'attention'
    const auth: FormEvidence['auth'] = c.authentication === 'oauth' ? 'oauth' : c.hasCredentials ? 'token' : 'none'
    const how = auth === 'oauth' ? st.chip.toLowerCase() : st.state === 'connected' ? (auth === 'token' ? 'with a token' : 'connected') : st.chip.toLowerCase()
    const host = connectionHost(c)
    return {
      kind: 'mcp' as const, state, detail: `${c.name} (${host}) · ${how}${c.companyIds?.length ? '' : ' · shared by every company'}`, connectionId: c.id,
      exact: serviceForConnection(c)?.id === s.id, auth, name: c.name, host,
      ...(st.state === 'notConnected' ? { problem: 'not signed in yet' } : {})
    }
  }).filter((e) => e.problem !== 'not signed in yet')
}

function accountEvidence(form: Extract<AuthForm, { kind: 'account' }>, h: CompanyHoldings): FormEvidence | null {
  const acct = h.accounts?.[form.account]
  if (!acct) return null
  if (form.account === 'github' && (h.gh === 'missing' || h.gh === 'signedOut')) return { kind: 'account', state: 'attention', detail: `GitHub as ${acct.handle}`, problem: h.gh === 'missing' ? 'The GitHub CLI (gh) isn’t on this Mac any more.' : 'gh is signed out on this Mac. Run gh auth login in Terminal.' }
  return { kind: 'account', state: 'connected', detail: `${form.account === 'github' ? 'GitHub' : 'Instagram'} as ${acct.handle}` }
}

function connectorEvidence(form: Extract<AuthForm, { kind: 'connector' }>, h: CompanyHoldings): FormEvidence | null {
  if (form.connector === 'slack') {
    if (h.slack === 'connected') return { kind: 'connector', state: 'connected', detail: 'Principia’s Slack app' }
    if (h.slack === 'set-up') return { kind: 'connector', state: 'attention', detail: 'Principia’s Slack app', problem: 'Set up, but not connected right now.' }
    return null
  }
  if (!h.linear.connected) return null
  return { kind: 'connector', state: h.linear.problem ? 'attention' : 'connected', detail: 'Board sync', ...(h.linear.problem ? { problem: h.linear.problem } : {}) }
}

/** The stored key the vendor's MCP takes as a bearer, when it is connected and not turned down (its real stored name). */
export function bearerKeyEvidence(s: ServiceDef, forms: readonly FormEvidence[]): KeyPresence | undefined {
  const bearer = mcpForm(s)?.bearerFromKey
  if (!bearer) return undefined
  const names = [bearer.key, ...keyAliases(bearer.key)]
  for (const f of forms) if (f.kind === 'key' && f.state === 'connected') for (const k of f.keyNames ?? []) if (names.includes(k.name)) return k
  return undefined
}

/**
 * Every form of `s` this company has, best first. `source`: the holdings of the company it is reused from (its
 * name in `sourceName`), read as that company's: "POSTHOG_API_KEY (from Ledgerline)".
 */
export function serviceEvidence(s: ServiceDef, h: CompanyHoldings, choice?: ServiceChoice, source?: CompanyHoldings | null, sourceName?: string): FormEvidence[] {
  const out: FormEvidence[] = []
  const take = (hold: CompanyHoldings, reused: boolean): void => {
    const from = sourceName ?? 'another company'
    for (const f of s.forms) {
      const ev = f.kind === 'key' ? keyEvidence(s, f, hold) : f.kind === 'account' ? accountEvidence(f, hold) : f.kind === 'connector' ? connectorEvidence(f, hold) : null
      if (!ev) continue
      if (!reused) out.push(ev)
      // reuse reads the other company's keys and sign-ins only: accounts and Principia's connectors stay per company
      else if (ev.kind === 'key') out.push({ ...ev, reused: true, from, detail: (ev.keyNames ?? []).map((k) => `${k.name} (from ${from})`).join(', '), keyNames: ev.keyNames?.map((k) => ({ ...k, source: 'reused' as const })) })
    }
    if (mcpForm(s) || s.match?.urls) for (const ev of mcpEvidence(s, hold, reused ? undefined : choice)) out.push(reused ? { ...ev, reused: true, from, detail: `${ev.detail} · from ${from}` } : ev)
  }
  take(h, false)
  if (source) take(source, true)
  // a key the vendor's MCP server takes as a bearer gives agents its tools (when no real MCP connection is working);
  // a key with another job (Linear's sync key) only once the founder turned that on
  const mcp = mcpForm(s)
  const optedIn = !mcp?.bearerFromKey?.optIn || choice?.keyChoice?.agentTools === mcp.bearerFromKey.key
  if (mcp?.bearerFromKey && optedIn && !out.some((e) => e.kind === 'mcp' && e.state === 'connected')) {
    const k = bearerKeyEvidence(s, out)
    const ev = k && out.find((e) => e.kind === 'key' && e.keyNames?.includes(k))
    if (k && ev) out.push({ kind: 'mcp', state: 'connected', detail: `with ${k.name}${ev.reused ? ` (from ${ev.from})` : ''}`, connectionId: virtualConnectionId(s.id), virtual: true, exact: true, ...(ev.reused ? { reused: true, from: ev.from } : {}) })
  }
  return out.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
}

/** The id the gateway gives a key-backed connection (CONNECTIONS.md §3.3). */
export const virtualConnectionId = (serviceId: string): string => `svc:${serviceId}`

/** The key form a key evidence belongs to. */
function formOf(s: ServiceDef, ev: FormEvidence): Extract<AuthForm, { kind: 'key' }> | undefined {
  const names = new Set(ev.keyNames?.map((k) => k.name))
  return keyForms(s).find((f) => f.keys.some((k) => names.has(k.name) || keyAliases(k.name).some((a) => names.has(a))))
}

/** A held form in a few words, for "Your agent API key can't be used for it." */
function heldWords(s: ServiceDef, ev: FormEvidence): string {
  if (ev.kind === 'key') {
    const f = formOf(s, ev)
    const words = f ? f.keys.map((k) => k.label).join(' + ').replace(/\s*\(.*?\)/g, '') : 'key'
    return words.charAt(0).toLowerCase() + words.slice(1)
  }
  if (ev.kind === 'mcp') return ev.virtual ? 'key' : ev.auth === 'oauth' ? 'sign-in' : 'MCP connection'
  return ev.kind === 'account' ? 'account' : 'Principia connector'
}

/** Which purposes the connected forms serve; for the rest, why not and what fixes it. */
export function purposeStates(s: ServiceDef, forms: readonly FormEvidence[], h?: Pick<CompanyHoldings, 'scopeProblems'>): Partial<Record<Purpose, PurposeState>> {
  const out: Partial<Record<Purpose, PurposeState>> = {}
  const connected = forms.filter((f) => f.state === 'connected')
  const scope = (purpose: Purpose, ev: FormEvidence): string | undefined => {
    for (const k of ev.keyNames ?? []) {
      const p = h?.scopeProblems?.[k.name]?.[purpose]
      if (p) return p
      for (const f of formOf(s, ev)?.keys ?? []) if (keyAliases(f.name).includes(k.name) || f.name === k.name) {
        const q = h?.scopeProblems?.[f.name]?.[purpose]
        if (q) return q
      }
    }
    return undefined
  }
  const serves = (purpose: Purpose, ev: FormEvidence): boolean => {
    if (ev.kind === 'mcp' && !ev.exact && (purpose === 'dashboard' || purpose === 'sessionReplay')) return false
    // a dashboard reads a key over REST or a real sign-in, never the tools built from a key (that is the key itself)
    if (ev.kind === 'mcp' && ev.virtual && purpose === 'dashboard') return false
    if (ev.kind !== 'key') return true
    // a reused key is never in this company's agents' environment: agents reach it only through the MCP built from it
    if (ev.reused && purpose === 'agentTools') return false
    if (scope(purpose, ev)) return false
    const form = formOf(s, ev)
    return !form?.serves || form.serves.includes(purpose)
  }
  for (const cap of s.capabilities) {
    const via = cap.via.find((kind) => connected.some((f) => f.kind === kind && serves(cap.purpose, f)))
    if (via) {
      out[cap.purpose] = { ok: true, label: cap.label, via }
      continue
    }
    const need = cap.via[0]!
    const fix = need === 'key' ? 'key' : need === 'mcp' ? 'signIn' : undefined
    // the key form that would do it (the first one serving this purpose, never an advanced one)
    const fixForm = keyForms(s).find((f) => !f.advanced && (!f.serves || f.serves.includes(cap.purpose)))
    const scoped = connected.map((f) => scope(cap.purpose, f)).find(Boolean)
    // the tools built from a key are that key: named once
    const held = [...new Set(connected.filter((f) => !f.virtual).map((f) => heldWords(s, f)))]
    const needText = cap.need ?? `${cap.label} needs ${need === 'key' ? 'a key' : need === 'mcp' ? `a sign-in to ${s.name}` : need === 'account' ? 'an account' : 'Principia’s connector'}.`
    const why = scoped ?? (held.length ? `${needText} Your ${held.join(' and ')} can’t be used for it.` : undefined)
    out[cap.purpose] = {
      ok: false,
      label: cap.label,
      ...(why ? { why } : {}),
      ...(fix ? { fix } : {}),
      ...(fix === 'key' && fixForm ? { fixKey: fixForm.keys[0]!.name } : {})
    }
  }
  return out
}

/** The one state of a service for a company, with its chip ("Connected · key", "Not connected", "Coming soon"). */
export function overallState(s: ServiceDef, forms: readonly FormEvidence[]): { state: ConnState; chip: string } {
  const best = forms[0]
  if (!best) {
    if (s.soon) return { state: 'soon', chip: 'Coming soon' }
    const mcp = mcpForm(s)
    if (mcp?.setupRequired && s.forms.length === 1) return { state: 'setup', chip: 'Needs setup' }
    return { state: 'notConnected', chip: 'Not connected' }
  }
  const top = forms.filter((f) => f.state === best.state && !f.virtual)
  const word = (f: FormEvidence): string => (f.kind === 'key' ? 'key' : f.kind === 'mcp' ? (f.auth === 'oauth' ? 'signed in' : 'MCP') : f.kind === 'account' ? 'account' : 'connected')
  const words = [...new Set(top.map(word))]
  if (best.state === 'connected') return { state: 'connected', chip: `Connected · ${words.join(' + ') || 'key'}` }
  if (best.state === 'attention') return { state: 'attention', chip: 'Needs attention' }
  if (best.state === 'waiting') return { state: 'waiting', chip: 'Waiting for sign-in' }
  return { state: 'off', chip: 'Turned off' }
}

/** One service for one company, everything but usage and the link (the resolver adds those). */
export function serviceStatus(s: ServiceDef, h: CompanyHoldings, choice?: ServiceChoice, source?: CompanyHoldings | null): Omit<ServiceStatus, 'usedBy' | 'link'> {
  const forms = serviceEvidence(s, h, choice, source, choice?.sourceCompany?.name)
  const { state, chip } = overallState(s, forms)
  const held = new Set(forms.map((f) => f.connectionId).filter(Boolean))
  const suggested = connectionsFor(h.connections, h.companyId)
    .filter((c) => !held.has(c.id) && suggestServiceForConnection(c)?.id === s.id)
    .map((c) => ({ connectionId: c.id, name: c.name, host: connectionHost(c) }))
  const bearer = mcpForm(s)?.bearerFromKey
  return {
    serviceId: s.id,
    name: s.name,
    category: s.category,
    state,
    chip,
    forms,
    purposes: purposeStates(s, forms, h),
    settings: { ...(choice?.settings ?? {}) },
    sharedFrom: choice?.sourceCompany ?? null,
    card: s.card,
    ...(suggested.length ? { suggested } : {}),
    ...(bearer?.optIn ? { keyTools: choice?.keyChoice?.agentTools === bearer.key } : {})
  }
}

/** A capability's `open` link filled from settings ("{host}/project/{projectId}/replay/home"); null when a field is missing. */
export function capabilityLink(template: string | undefined, settings: Record<string, string>, defaults: Record<string, string> = {}): string | null {
  if (!template) return null
  let missing = false
  const url = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = settings[k] || defaults[k]
    if (!v) missing = true
    return v ?? ''
  })
  if (missing) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** The MCP endpoint a saved key is sent to as a bearer, for this company's settings (PostHog EU → mcp-eu). */
export function bearerUrl(s: ServiceDef, settings: Record<string, string>): string | null {
  const mcp = mcpForm(s)
  if (!mcp?.bearerFromKey) return null
  for (const r of mcp.bearerFromKey.regional ?? []) if ((settings[r.setting] ?? '').toLowerCase().includes(r.contains)) return r.url
  return mcp.bearerFromKey.url ?? mcp.url
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|metadata(\..*)?)$/i
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/
/**
 * A setting's value, checked when it is saved (CONNECTIONS.md §3.1): a host the service's key is sent to must be a
 * public https address with no credentials or path (no IP addresses, no localhost, no cloud metadata). Returns the
 * value to store (a host is reduced to its origin) or the plain reason it can't be saved.
 */
export function checkSetting(f: ServiceSetting, raw: string): { value: string } | { error: string } {
  const v = raw.trim()
  if (!v || !f.host) return { value: v }
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return { error: `${f.label}: “${v.slice(0, 60)}” is not a web address. Use https://…` }
  }
  if (u.protocol !== 'https:') return { error: `${f.label} must start with https://` }
  if (u.username || u.password) return { error: `${f.label} can’t contain a user name or password.` }
  const host = u.hostname.toLowerCase()
  if (IP_LITERAL.test(host) || PRIVATE_HOST.test(host) || !host.includes('.')) return { error: `${f.label} must be a public address like https://posthog.example.com, not an IP address or a local name.` }
  if (u.pathname !== '/' && u.pathname !== '') return { error: `${f.label} is just the address, without a path (https://${u.host}).` }
  return { value: u.origin }
}
