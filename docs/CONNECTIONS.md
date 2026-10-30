# Connections: one connection per service, used everywhere

Status: Part 1 built (model, resolver, gateway, `connections_list`, IPC and events; see §9.1), Part 2 open, 2026-10-26, branch `feat/connections-everywhere`. Audience: the engineers building it. Companion to
[MCP-GATEWAY.md](MCP-GATEWAY.md) (the MCP gateway), [KEYS.md](KEYS.md) (key model), [DASHBOARDS.md](DASHBOARDS.md),
[AUTOPILOT.md](AUTOPILOT.md), [LINEAR.md](LINEAR.md), [SLACK.md](SLACK.md) and [COMPANY.md](COMPANY.md) §4 and §6
(per-company keys and connections).

Founder direction: "Wherever a feature or a connection could go, show it as connected right away, whether you have an
API key or an MCP. PostHog, for example: maybe you want to see your sessions, understand something about it, or build
dashboards. Show it there, and show the connector for it. The connection lives at the Principia level (not in the cloud,
not in the code), so it is reused across the whole company. Same for every other connector."

## 0. Decisions in one screen

1. **A service is the unit, not a key or an MCP server.** PostHog is one thing. A company either has PostHog or it
   doesn't, whatever form the credential takes: an API key in the company's keys, an MCP connection to PostHog's MCP
   URL, a browser sign-in (OAuth), or one of Principia's own account connections (GitHub through `gh`, Instagram,
   Slack, Linear).
2. **The service registry is data** (`src/shared/services.ts`, `SERVICE_REGISTRY`). Each entry gives the service's
   id, name, the forms it can be connected with (key names, MCP URL, auth kind), the legacy names and URLs that count as
   that service, and **capabilities**: what a connection unlocks (dashboards, agent tools, session replays, data
   questions, autopilot playbooks…) and which form each one needs. To add a service you add an entry. You write no
   code for each surface.
3. **Credentials stay where they are.** Keys stay in `company_secrets` / `secrets` (vault), MCP connections stay in
   `mcp-connections.json` (gateway), Slack tokens stay in the Slack store, the Linear key stays `LINEAR_API_KEY`, and
   GitHub and Instagram stay in `CompanyAccounts`. The new layer is an **index plus resolver**
   (`src/main/connections/`) that links those pieces to a service per company. Nothing is copied, no key name changes
   and no existing reader breaks. Migration is a derivation: no data moves.
4. **One resolver answers every surface.** `status(companyId, serviceId)` (renderer-safe, names and states only) and
   `credentialsFor(companyId, serviceId, purpose)` (main only) are the only way a surface asks "do we have PostHog?".
   Dashboards, the gateway, autopilot, the checklist, the palette, agent desks, chat context and Settings all go
   through it.
5. **One component on screen: `<ConnectionSlot service="posthog" purpose="dashboard" />`.** When connected it shows
   "PostHog · Connected (key)" and the actions that purpose allows ("See sessions", "Ask about it", "Add dashboard").
   When not connected it shows "Connect PostHog", which opens the one shared Connect sheet (key form, browser sign-in,
   or both). Once you connect anywhere, every slot updates live through `connections:changed`.
6. **A key connection and an MCP connection to the same service are the same connection.** Where the vendor's MCP
   server accepts the key as a bearer token (PostHog personal key, Stripe restricted key, GitHub token, Vibiz `vbz_mcp_`
   token, and others marked in the registry after we check them), a saved key gives the company's agents the vendor's MCP
   tools. The gateway exposes a **key-backed MCP connection** whose header main builds from the key at call time. The
   key is never copied into `mcp-connections.json`. Where one form cannot serve a purpose (an OAuth-only MCP sign-in
   cannot fill a REST dashboard; a PostHog project key `phc_` cannot read data), the slot says so in plain words and
   offers the form that works.
7. **Company level, shared only by an explicit choice.** A connection belongs to one company. "Also use in…" lets
   the founder reuse it in other companies of theirs. That stores a reference, never a copy, and reads resolve through
   the owning company. The vault's existing Shared namespace still counts as "available to every company" for keys.
8. **Keys never reach the renderer or logs** (SPEC K5, KEYS.md). The renderer sees service ids, states, key *names*,
   where they resolve from, and the masked form. Every value a resolver decrypts joins the vault's redaction table as it
   does today.

---

## 1. Audit: where connections, keys, MCP and OAuth live today

### 1.1 Storage (five separate stores, no shared index)

| Store | File | What it holds | Scope |
|---|---|---|---|
| Shared keys | `src/main/vault.ts` (`secrets` table, hive.db) | safeStorage-encrypted values by UPPER_SNAKE name; `resolve(names, companyId)` overlays company keys; global redaction table; `addRedactions` for non-vault tokens | every company |
| Company keys | `src/main/db/companySecrets.ts` (`company_secrets`), `KeyNamespaces` | same cipher; company value overrides Shared; `move` between namespaces | one company |
| MCP connections | `src/main/gateway/service.ts` → `<userData>/mcp-connections.json` (0600) | config + encrypted headers/env + encrypted OAuth state; `companyIds` limits which companies' spawns get it (absent = all); seeds the Vibiz default once | per connection, `companyIds` or global |
| Slack connector | `src/main/connectors/slack/secrets.ts`, `store/sqlite.ts` | bot and app tokens, encrypted; redacted as `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | one workspace per install |
| Linear sync | `src/main/company/sync/wire.ts` | company key `LINEAR_API_KEY` (company_secrets, label "Linear sync") | one company |
| Accounts | `src/shared/company.ts` `CompanyAccounts` on the passport | `instagram` and `github` handles (GitHub = the `gh` login on this Mac, approved for this company); no secret | one company |
| Dashboard keys | `src/main/dashboards/wire.ts` | not a store: dashboards save into company_secrets and read through `vault.resolve` | one company |
| Cloud | `src/main/cloud/exportForCloud.ts`, `src/cloud/gateway.ts` | ticked keys and header connections exported by name; OAuth connections sign in again in the cloud | per move |

### 1.2 Catalogs and matchers (four lists of the same services)

| List | File | Shape | Problem |
|---|---|---|---|
| MCP presets | `src/shared/connectionCatalog.ts` (`CONNECTION_CATALOG`, re-exported by `src/renderer/src/lib/connectionCatalog.ts`) | 15 presets: Vibiz, Granola, Notion, Linear, GitHub, Stripe, Mobbin, Supabase, Neon, Sentry, Firecrawl, Tavily, Figma, HubSpot, Asana; MCP URL + `oauth`/`token` | MCP only; no PostHog, Plausible, GSC; no key names |
| Dashboard catalog | `src/shared/dashboards.ts` (`DASHBOARD_CATALOG`) | 6 dashboards with their own key fields: `GSC_SERVICE_ACCOUNT_JSON`, `PAGESPEED_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `PLAUSIBLE_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `STRIPE_RESTRICTED_KEY`, `GITHUB_TOKEN` | keys only; a Stripe or PostHog MCP sign-in is ignored |
| Social channels | `src/shared/socials.ts` (`SOCIAL_CHANNELS`, `socialStatuses`) | X, LinkedIn, Instagram, TikTok, YouTube; keys + `mcpMatch` fragments + account | already the right idea (key or MCP or account counts), for one domain only |
| Known key labels | `src/shared/cloud.ts` `KNOWN_KEYS` | 30 key names → "Stripe secret key"… | labels only |
| Playbook needs | `src/shared/autopilotPlaybooks.ts` (`needs.connections` regexes, `ADS_CONNECTION`, Stripe `/STRIPE_(SECRET\|API\|RESTRICTED)/`) | regex over connection ids, MCP names, key names | ad-hoc matcher per playbook |
| Deep-link tools | `src/shared/deepLink.ts` (`OWN_CONNECT_TOOLS`, `SOON_CONNECT_TOOLS`, `CONNECT_TOOL_IDS`, aliases) | tool ids for `principia://connect/<tool>` | derived from the MCP catalog + hand lists |

### 1.3 Surfaces that use, ask for or could offer a connection

| # | Surface | File(s) | Today | Gap against the ask |
|---|---|---|---|---|
| S1 | Settings › Connections (company) | `components/connections/ConnectionsPage.tsx`, `lib/connections.ts` (`buildCatalog`, `connectionState`), `GatewayConnections.tsx`, `ConnectionCatalog.tsx`, sheets `InstagramSheet`, `GithubSheet`, `LinearConnectSheet`, `slack/SetupGuide` | One card per MCP preset + own accounts; a preset counts as connected only by MCP URL match; reads `secrets.list` only for `INSTAGRAM_ACCESS_TOKEN` | A saved `POSTHOG_PERSONAL_API_KEY` or `STRIPE_RESTRICTED_KEY` shows nothing; PostHog has no card at all; no "Used by" |
| S2 | Settings › Keys & secrets | `views/KeysView.tsx`, handlers `secrets.ts` | Lists names by namespace, Reveal/Copy/Move, `.env` import | A key does not say which service it connects or what uses it |
| S3 | Department dashboards | `components/dashboards/DepartmentDashboards.tsx`, `DashboardBody.tsx`, `lib/dashboards.ts`, main `dashboards/service.ts` + `wire.ts` + `providers/*`, handler `dashboards.ts` | Own key form per dashboard; `dashboards:keys` looks up names (company, then Shared); reuses a key with the same name | Different names for the same service miss (`POSTHOG_API_KEY` vs `POSTHOG_PERSONAL_API_KEY`); an MCP sign-in to Stripe or PostHog does not count; no "Connect" shared flow |
| S4 | Agents' MCP tools | `main/gateway/service.ts` (`allowed`, `attachment`, `notGrantedMessage`), `gateway/main.ts` (bridge instructions), `cloud/gateway.ts` | Grants MCP connections by root/scope/company; unknown tool → `principia://connect/<tool>` | A saved key never gives agents the vendor's MCP tools |
| S5 | `connections_list` agent tool | `main/company/connectionsReport.ts`, `author/wire.ts`, `author/broker.ts`, `memory/server/tools.ts`, `company/taskTools.ts`, `company/principiaOps.ts` | Report of connected / missing tools with links; keys pointed to Settings › Keys | Key-only services are invisible, so the agent tells the founder to connect PostHog when its key is already there |
| S6 | Agent env (keys) | `main/sessions.ts` (`profile.secretNames`, `vault.resolve(…, companyId)`), `childEnv.ts`, `index.ts` (`LLM_CLI_KEYS`) | Profiles default to every key (`*`); keys reach agents as env vars | Works, but nothing tells the agent "you have PostHog through `POSTHOG_PERSONAL_API_KEY`" |
| S7 | Autopilot playbooks | `shared/autopilotPlaybooks.ts` (`needs`, `signals.connections`), `components/autopilot/PlaybookList.tsx`, `AutopilotOffer.tsx`, `main/company/playbooks.ts`, `main/orchestrator/suggestions.ts` | Regex match over connection ids / names / key names; "Connect … first" link | Regexes duplicate service knowledge; Stripe MCP counts only by a name regex |
| S8 | Routines | `shared/routines.ts` (prompts say "when a help desk is connected (principia_list_tools)") | Prompt text only | No structured need; could declare `needs: ['posthog']` |
| S9 | Setup checklist / Home | `components/home/SetupChecklist.tsx`, `useCompanySetup.ts` (`vibizState`, `socialStatuses`), `lib/checklist.ts` | Vibiz sign-in, socials (key or MCP), Slack, Instagram; saves social keys with `secrets.set` | Hand-built per service |
| S10 | Nudges | `lib/nudges.ts`, `components/home/NudgeCard.tsx` | Parses `principia://connect/<tool>` in task text → "Connect X" | Should hide when the service is already connected in another form |
| S11 | ⌘K palette | `shell/CommandPalette.tsx` | Fixed entries: Slack Connection…, Linear Sync…, Connect Instagram…, Connect GitHub…; keys by name | No entry per service; no "Ask PostHog…" |
| S12 | Orchestrator blockers and ideas | `main/orchestrator/apply.ts`, `suggestions.ts`, `shared/orchestrator.ts` | `needs: 'connection'` with a free `connectionId` → link | Free-text ids; not checked against what is connected |
| S13 | Marketplace | `views/MarketplaceView.tsx`, `shared/marketplace.ts` (`keys?: string[]`) | "N keys to connect" by key name | Should say "Needs PostHog" and count it connected by any form |
| S14 | Workflow editor | `views/WorkflowEditor.tsx` (Slack connection), `shared/authoring.ts` (`slackNotConnected`), `lib/workflow.ts` (`APIFY_API_KEY`) | Slack-only check; referenced keys | Same slot for any service a node needs |
| S15 | Linear on the Board | `components/board/LinearIntegration.tsx`, `views/BoardView.tsx`, `lib/linear.ts` | Linear sync key status | Linear MCP sign-in and the sync key are two cards today |
| S16 | Onboarding | `main/onboarding/keys.ts`, `launch.ts`, `views/onboarding/*`, `shared/onboarding.ts` | Saves `FAL_KEY`, `OPENAI_API_KEY`, `FIRECRAWL_API_KEY` as company keys after a check | Should record these as service connections (fal, OpenAI, Firecrawl) |
| S17 | Department page / agent desks | `views/DepartmentView.tsx`, `views/AgentSeatView.tsx`, `components/desk/*` | Dashboards card; no tool list per agent | "Tools this agent can use": the services this company has connected that reach this agent |
| S18 | Chat context | `main/company/chatContext.ts`, `Hive.passportContext` (+ `DashboardService.contextFor`) | Dashboard numbers block | One line "Connected: PostHog (key), Stripe (MCP)…" so chats know what they can ask |
| S19 | Knowledge / Passport | `components/passport/PassportConnect.tsx`, `views/MemoryView.tsx`, `main/memory/*` | Exports the Passport to other apps; imports | Knowledge sources such as Notion and Granola could come from the same connection (Part 2, offer only) |
| S20 | Cloud move | `main/cloud/exportForCloud.ts`, `shared/cloud.ts` | Ticks keys and header connections by name | Should list services ("PostHog: key goes along; Notion: sign in again in the cloud") |
| S21 | Run / Session views | `views/RunView.tsx`, `views/SessionView.tsx` | Lists key names for a run | Unchanged in Part 1; optional "services this run used" line |
| S22 | Social channels | `shared/socials.ts` | Key or MCP or account | Becomes a registry consumer (the socials list stays, built from registry entries) |

### 1.4 Services involved

From the code and docs: **Vibiz, PostHog, Stripe, GitHub, Linear, Slack, Notion, Granola, Plausible, Google Search
Console (+ PageSpeed), OpenAI, Perplexity, Anthropic, Gemini, fal, Firecrawl, Tavily, Apify, Supabase, Neon, Sentry,
Mobbin, Figma, HubSpot, Asana, Instagram, X, LinkedIn, TikTok, YouTube, Meta Ads, Google Ads, Shopify, Google Business,
Vercel, Resend, ElevenLabs, Airtable, Browserbase, Cloudflare, SerpApi, DataForSEO, Twilio**. Part 1 registers the
first group in §2.4. The rest get entries with `forms: [key]` only, so their keys at least show up as connected
services.

---

## 2. The service registry (`src/shared/services.ts`)

Pure data plus a few pure helpers. No node or electron imports. Both main and the renderer read it.

```ts
export type ServiceId = string // 'posthog', 'stripe', … lowercase, also the principia://connect/<tool> id

export type AuthForm =
  | { kind: 'key'; keys: ServiceKeyField[]; /** older names that count as this key (read, never written) */ aliases?: Record<string, string[]>; check?: KeyCheckId }
  | { kind: 'mcp'; url: string; auth: 'oauth' | 'bearer' | 'none'
      /** the vendor's MCP server accepts this key as `Authorization: Bearer <key>` (checked against its docs, date in `checked`) */
      bearerFromKey?: { key: string; header?: string; prefix?: string }
      setupRequired?: string /** plain reason, e.g. "Figma approves new MCP clients" */ }
  | { kind: 'account'; account: 'github' | 'instagram' }      // CompanyAccounts
  | { kind: 'connector'; connector: 'slack' | 'linear' }      // Principia's own connectors

export interface ServiceKeyField {           // the same fields as DashboardKeyField today (moved here)
  name: string; label: string; required: boolean; hint: string; link: string; linkLabel: string
  placeholder?: string; multiline?: boolean
  /** values that look right but cannot do the job: phc_ (PostHog project key, ingest only), sk_ for a read-only purpose */
  refuse?: { pattern: string; reason: string; purposes?: Purpose[] }[]
}

export type Purpose =
  | 'agentTools'     // agents get tools (MCP, or the key in their env)
  | 'dashboard'      // a department dashboard reads numbers (REST, main only)
  | 'askData'        // "Ask about it": a chat with a data question, answered through the agent tools
  | 'sessionReplay'  // "See sessions": opens the vendor's session list (link) or the agent lists them
  | 'playbook'       // an autopilot playbook needs it
  | 'knowledge'      // a Knowledge source (Notion, Granola)
  | 'posting'        // socials: publish
  | 'sync'           // Linear issues ↔ Board, Slack triggers

export interface Capability {
  purpose: Purpose
  label: string                      // "Product analytics dashboard", "Session replays", "Data questions"
  /** forms that can serve it, in preference order; a purpose no form serves is shown as "needs a <form>" */
  via: AuthForm['kind'][]
  /** for dashboards: the DashboardKind ids this service feeds; for playbooks: playbook ids; for sessions: a URL template */
  refs?: string[]
  open?: string                      // e.g. 'https://{host}/project/{projectId}/replay' (config fields, no secrets)
}

export interface ServiceDef {
  id: ServiceId
  name: string
  category: 'Analytics' | 'Finance' | 'Development' | 'Projects' | 'Knowledge' | 'Marketing' | 'Data' | 'Research' | 'Design' | 'Sales' | 'Social' | 'AI' | 'Communication'
  blurb: string                       // one line: what an agent can do with it
  keywords: string
  forms: AuthForm[]
  capabilities: Capability[]
  /** legacy identity: MCP URL origins+paths, connection names, key names that mean this service */
  match: { urls?: string[]; names?: string[]; keys?: string[] }
  docs: string
  developer?: boolean                  // grouped under "For developers" (DEVELOPER_TOOLS today)
  soon?: boolean                       // Shopify, Google Business, Meta Ads: honest "Coming soon"
  /** when the vendor facts (MCP URL, bearer support) were last checked */
  checked: string
}
export const SERVICE_REGISTRY: readonly ServiceDef[]
export function serviceById(id: string): ServiceDef | undefined
export function serviceForUrl(url: string): ServiceDef | undefined        // replaces presetForUrl
export function serviceForKey(name: string): ServiceDef | undefined       // POSTHOG_API_KEY → posthog
export function serviceForConnection(c: Pick<GatewayConnection, 'id' | 'name' | 'url' | 'command' | 'args'>): ServiceDef | undefined
```

Rules:
- **Compatibility shims.** `CONNECTION_CATALOG` and `presetForUrl` stay exported and are derived from the registry
  (the entries with an `mcp` form), so the existing callers and tests keep working until they move. `DashboardDef.keys`
  becomes `service: ServiceId` + `keys` read from the registry (same names, same fields). `SOCIAL_CHANNELS` is
  built from the registry's `Social` entries. `CONNECT_TOOL_IDS` = registry ids + `mcp`.
- **Key names never change.** A new canonical name only gets added when two features used two names for one
  credential, and the old name stays as an alias that is read and never written. PostHog: canonical
  `POSTHOG_PERSONAL_API_KEY`, alias `POSTHOG_API_KEY`. Stripe has two credentials with different powers (§2.3), so it
  is not an alias case.
- **Every vendor fact carries `checked`.** It covers the MCP URL and whether the MCP server takes the key as a bearer.
  Part 1 confirms each one against the vendor's docs. Until a bearer is confirmed, `bearerFromKey` stays unset and
  the slot says "Sign in to give agents PostHog's tools" (honest, see the catalog's existing `setupRequired` practice).

### 2.1 Example entry: PostHog

```ts
{
  id: 'posthog', name: 'PostHog', category: 'Analytics', checked: '2026-10-26',
  blurb: 'Product analytics, session replays, feature flags and data questions.',
  keywords: 'analytics product events funnels sessions replay recordings feature flags experiments hogql',
  forms: [
    { kind: 'key', keys: [{ name: 'POSTHOG_PERSONAL_API_KEY', label: 'Personal API key', required: true, /* hint/link as DASHBOARD_CATALOG today */
        refuse: [{ pattern: '^phc_', reason: 'That is a project key: it can send events but cannot read them. Create a personal API key instead.' }] }],
      aliases: { POSTHOG_PERSONAL_API_KEY: ['POSTHOG_API_KEY'] }, check: 'posthog' },
    { kind: 'mcp', url: 'https://mcp.posthog.com/mcp', auth: 'oauth', bearerFromKey: { key: 'POSTHOG_PERSONAL_API_KEY' } }
  ],
  capabilities: [
    { purpose: 'dashboard', label: 'Product analytics dashboard', via: ['key'], refs: ['posthog'] },
    { purpose: 'agentTools', label: 'Agent tools (insights, flags, SQL)', via: ['mcp', 'key'] },
    { purpose: 'askData', label: 'Ask about your data', via: ['mcp', 'key'] },
    { purpose: 'sessionReplay', label: 'Session replays', via: ['mcp', 'key'], open: '{host}/project/{projectId}/replay/home' }
  ],
  match: { urls: ['https://mcp.posthog.com/mcp', 'https://mcp.posthog.com/sse'], names: ['posthog'], keys: ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_API_KEY'] },
  docs: 'https://posthog.com/docs/model-context-protocol'
}
```

`{host}` and `{projectId}` come from the service's **non-secret settings** (§3.1), which the dashboard config already
holds (`projectId`, `host`). A PostHog dashboard's install writes them to the connection, and every later surface
reads them from there.

### 2.2 Which form serves which purpose

| Purpose | Key | MCP (bearer from key) | MCP (OAuth) | Account / connector |
|---|---|---|---|---|
| dashboard | yes (REST in main) | n/a | **no**: the OAuth token is bound to the MCP resource. The slot says "Dashboards read PostHog with a personal API key. Your sign-in gives agents PostHog's tools but can't fill a dashboard." [Add key] | GitHub: `gh` (as today) |
| agentTools | env var (as today) **and** the vendor MCP via a key-backed gateway connection | yes | yes | Slack/Linear tools as today |
| askData / sessionReplay | through agent tools | yes | yes | n/a |
| playbook | whatever its capability lists | yes | yes | yes |

A later option (Part 2, PostHog and Stripe only) is a dashboard provider that reads over the vendor's MCP tools
(`query-run` / `execute-sql` on PostHog, `list_subscriptions` on Stripe). That would turn the "no" in the
dashboard/OAuth cell into "yes, with fewer widgets". It ships only if the numbers can be computed the same way.

### 2.3 Key ↔ MCP pairs (to confirm in Part 1; `checked` set when confirmed)

| Service | Key (company keys) | MCP URL | Key as MCP bearer? | Notes shown to the founder |
|---|---|---|---|---|
| PostHog | `POSTHOG_PERSONAL_API_KEY` (alias `POSTHOG_API_KEY`) | `https://mcp.posthog.com/mcp` | expected yes (personal key) | `phc_` project keys can't read |
| Stripe | `STRIPE_RESTRICTED_KEY` (read-only, dashboards), `STRIPE_SECRET_KEY` (agents) | `https://mcp.stripe.com` | expected yes (restricted key) | Dashboards refuse `sk_`; the MCP uses the restricted key, never the secret key, unless the founder picks it |
| GitHub | `GITHUB_TOKEN`; account `gh` | `https://api.githubcopilot.com/mcp/` | yes (PAT, already `auth: token`) | `gh` login is not a token: MCP needs a PAT, git/gh use the login |
| Linear | `LINEAR_API_KEY` (sync) | `https://mcp.linear.app/mcp` | to confirm | Sync and MCP become one card: "Linear · Connected (key: sync + tools)" |
| Vibiz | `VIBIZ_MCP_TOKEN` (`vbz_mcp_…`) | `https://www.vibiz.ai/api/mcp` | yes (gateway.ts comment) | default connection stays |
| Supabase | `SUPABASE_ACCESS_TOKEN` (personal) | `https://mcp.supabase.com/mcp?read_only=true` | to confirm | read-only by default; service-role key is not an MCP credential |
| Neon | `NEON_API_KEY` | `https://mcp.neon.tech/mcp` | to confirm | |
| Sentry | `SENTRY_AUTH_TOKEN` | `https://mcp.sentry.dev/mcp` | likely OAuth only | key still reaches agents as env |
| Notion | `NOTION_API_KEY` / `NOTION_TOKEN` (integration) | `https://mcp.notion.com/mcp` | no (OAuth only) | "Sign in to give agents Notion's tools; the integration key works for scripts only" |
| Plausible | `PLAUSIBLE_API_KEY` | none official | n/a | key only |
| Google Search Console | `GSC_SERVICE_ACCOUNT_JSON`, `PAGESPEED_API_KEY` | none official | n/a | key only |
| Slack | connector tokens | Principia's own Slack connector | n/a | connector form only |
| OpenAI / Perplexity / fal / Firecrawl | `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `FAL_KEY`, `FIRECRAWL_API_KEY` | Firecrawl: `https://mcp.firecrawl.dev/v2/mcp-oauth` (OAuth) | Firecrawl key MCP URL to confirm | GEO dashboard and onboarding read these |

### 2.3.1 Checked on 2026-10-26 (vendor docs)

| Service | Result | Registry |
|---|---|---|
| PostHog | Personal API key as `Authorization: Bearer` (FAQ, "MCP Server" key preset) | `bearerFromKey: POSTHOG_PERSONAL_API_KEY` |
| Stripe | OAuth, or an **agent API key** as bearer. From December 2026 Stripe MCP refuses secret keys and restricted keys without the Agent tag | new key `STRIPE_AGENT_API_KEY` carries the bearer; `STRIPE_RESTRICTED_KEY` stays dashboard-only; `STRIPE_SECRET_KEY` (alias `STRIPE_API_KEY`) reaches agents as env only |
| Linear | API key or OAuth token as bearer (FAQ) | `bearerFromKey: LINEAR_API_KEY` |
| Supabase | Personal access token as bearer | `bearerFromKey: SUPABASE_ACCESS_TOKEN` (the service-role key is env only) |
| Neon | API key as bearer on `/mcp` (not SSE) | `bearerFromKey: NEON_API_KEY` |
| Firecrawl | API key as bearer on `https://mcp.firecrawl.dev/v2/mcp` (sign-in stays on `/v2/mcp-oauth`) | `bearerFromKey` with its own `url` |
| Sentry | "All connections use OAuth" | no bearer; `SENTRY_AUTH_TOKEN` reaches agents as env |
| Notion | OAuth only | no bearer; the integration key is env only |
| GitHub, Vibiz | token / `vbz_mcp_` bearer (already in use) | `bearerFromKey` set |

### 2.4 Part 1 registry

Vibiz, PostHog, Stripe, GitHub, Linear, Slack, Notion, Granola, Plausible, Google Search Console, OpenAI, Perplexity,
fal, Firecrawl, Tavily, Supabase, Neon, Sentry, Mobbin, Figma (setup required), HubSpot (setup required), Asana (setup
required), Instagram, X, LinkedIn, TikTok, YouTube, Shopify/Google Business/Meta Ads (soon). Every name in
`KNOWN_KEYS` gets at least a key-only entry.

---

## 3. Per-company connection index (`src/main/connections/`)

### 3.1 Table `company_connections` (hive.db, created by `ConnectionStore`, no schema version bump; older builds ignore it)

| Column | Meaning |
|---|---|
| `company_id`, `service_id` | primary key: one row per service per company |
| `settings` | JSON, non-secret service settings shared by every surface (`{ host, projectId }` for PostHog, `{ siteId }` for Plausible, `{ siteUrl }` for GSC, `{ teamId }` for Linear). Capped, zod-checked against the registry |
| `mcp_connection_id` | the gateway connection that serves this service for this company (null = none; virtual ids below are not stored) |
| `key_choice` | JSON `{ purpose: keyName }`, which saved key serves which purpose when there are several (Stripe: `dashboard → STRIPE_RESTRICTED_KEY`, `agentTools → STRIPE_RESTRICTED_KEY` by default) |
| `source_company_id` | set when this company **reuses** another company's connection ("Also use in…"); reads resolve through the source |
| `hidden` | the founder said "don't offer this" (no slot nags) |
| `created_at`, `updated_at` | |

The row holds **no credentials** and nothing that is not derivable today. It only stores choices (which connection,
which key, shared from where, settings). Status is always computed live.

### 3.2 Resolver (`ConnectionResolver`, main)

Inputs, injected like `DashboardService`'s: `vault` (names, lookup, resolve), `companySecrets`, `gateway.list()`,
`slack.status()`, `linear.status(companyId)`, `company.passport(id).accounts`, `gh` state, `ConnectionStore`.

```ts
interface FormEvidence {
  kind: 'key' | 'mcp' | 'account' | 'connector'
  state: 'connected' | 'attention' | 'waiting' | 'off'
  detail: string                    // "POSTHOG_PERSONAL_API_KEY (this company) ••••a1b2", "MCP · signed in", "gh: diego"
  keyNames?: { name: string; source: 'company' | 'shared' | 'reused'; masked: string }[]
  connectionId?: string
  problem?: string                  // "Turned down by PostHog on 26 Oct (invalid key)", "phc_ project key cannot read"
}
interface ServiceStatus {           // renderer-safe
  serviceId: string
  state: 'connected' | 'attention' | 'waiting' | 'off' | 'notConnected' | 'setup' | 'soon'
  forms: FormEvidence[]             // every form found, best first
  purposes: Record<Purpose, { ok: boolean; via?: AuthForm['kind']; why?: string; fix?: 'key' | 'signIn' | 'mcp' }>
  settings: Record<string, string>
  sharedFrom?: { companyId: string; name: string }
  usedBy: UsageRef[]                // §3.4
}
status(companyId, serviceId): ServiceStatus
list(companyId): ServiceStatus[]               // every registry service (connected first)
isConnected(companyId, serviceId, purpose?): boolean
/** main only, never over IPC. Throws not_connected with the connect link. Decrypted values join redaction. */
credentialsFor(companyId, serviceId, purpose):
  | { via: 'key'; values: Record<string, string>; settings }   // dashboards, onboarding checks
  | { via: 'mcp'; connectionId: string }                        // gateway grants
  | { via: 'mcpKey'; url: string; headers: Record<string, string> }  // key-backed MCP, built at call time
  | { via: 'account'; handle: string }
  | { via: 'connector' }
```

Evidence rules (one function per form, all pure over the inputs):
- **key**: every required key of the form resolves for the company (company, else Shared, else the reuse source;
  aliases count). `refuse` patterns are checked in main (it reads the value, never returns it). A dashboard's last
  `invalid_key` / `forbidden` status for that key name turns `connected` into `attention` with the problem.
- **mcp**: a gateway connection reaching this company (`connectionsFor` / `connectionReaches`) whose
  `serviceForConnection` is this service; state from `connectionState` (moved from `lib/connections.ts` to
  `src/shared/services.ts` so main and the renderer agree).
- **account**: `accounts.github` + `gh` state; `accounts.instagram`.
- **connector**: Slack status; Linear status.
- The service is `connected` if any form is `connected`. Purposes are computed per capability from the forms that are
  connected. The order in `via` decides which form serves a purpose.

### 3.3 Key-backed MCP connections (gateway)

`GatewayService` gets an optional `virtuals(companyId)` provider from the resolver. For each service where the company
has a usable key whose MCP form has `bearerFromKey`, and no real MCP connection for that service, it adds a virtual
connection `svc:<serviceId>` (http, the registry URL, enabled, scope global, companyIds = [company]). Its headers are
built in `client(s)` at connect time from `credentialsFor(…, 'agentTools')` (`Authorization: Bearer <key>`). The values
join redaction like any gateway credential. Virtual connections are never persisted, never listed as editable, and are
dropped as soon as the key goes or a real connection for the service appears. `allowed()`, `notGrantedMessage`,
`principia_list_tools` and the autopilot guard (`adsConnectorOf`, read-only map) treat them like real connections.
Cloud export lists them as "key goes along, the cloud builds the same connection".

### 3.4 Usage ("Used by")

`usage(companyId, serviceId)`, computed on demand:
- dashboards: `company_dashboards` rows whose kind's `service` is this one (department name),
- agents: agent seats whose profile's `secretNames` covers a key of the service (or `*`), plus every seat when a
  gateway connection for the service reaches them (count, names for the first 3),
- autopilot playbooks and routines that declare `needs: [serviceId]` (§5), on or offered,
- Linear sync, Slack triggers, socials publishing, onboarding schedules.

The card shows it in one line: "Used by: Marketing dashboard, 3 agents, Weekly growth routine".

### 3.5 Migration (derive, never move)

On boot (and in a test helper), `ConnectionStore.backfill()`:
1. For each company: for each gateway connection reaching it with `serviceForConnection` → write `mcp_connection_id`
   if empty.
2. For each installed dashboard: write its config's non-secret fields that the registry marks as service settings
   (`projectId`, `host`, `siteId`, `siteUrl`) into `settings` if empty.
3. Nothing else: key presence is always computed. Keys keep their names, rows and namespaces. Gateway configs keep
   their `companyIds`. A connection saved before companies (no `companyIds`) keeps reaching every company, and the
   card keeps saying "Shared by every company".
4. Idempotent, logged as counts only (`connections: backfill companies=3 links=5`).

Older builds that read the same hive.db ignore the new table. Nothing they rely on changes.

### 3.6 IPC (`src/shared/ipc.ts`, zod in `ipcSchemas.ts`, handler `src/main/handlers/connections.ts`)

| Channel | Request | Answer | Notes |
|---|---|---|---|
| `connections:list` | `{ companyId }` | `ServiceStatus[]` | names, states, masked forms only |
| `connections:get` | `{ companyId, serviceId }` | `ServiceStatus` | |
| `connections:connectKey` | `{ companyId, serviceId, keys: {NAME: value}, settings?, purpose? }` | `ServiceStatus` | pasted values only; `refuse` patterns, then the registry's `check` (reuses the dashboard providers' `validate`, read-only), then `CompanySecrets.set`; a failed check stores nothing |
| `connections:signIn` | `{ companyId, serviceId }` | `ServiceStatus` | creates the gateway connection from the registry's MCP form (companyIds = [company]) if missing, then `gateway.connect` (browser OAuth); same flow as `connectPreset` today, moved to main |
| `connections:settings` | `{ companyId, serviceId, settings }` | `ServiceStatus` | non-secret |
| `connections:choose` | `{ companyId, serviceId, purpose, keyName }` | `ServiceStatus` | Stripe: which key agents use |
| `connections:reuse` | `{ companyId, serviceId, from: companyId }` / `{ …, from: null }` | `ServiceStatus` | "Also use in…", both companies must be this founder's (always true on one Mac); stops reuse with `null` |
| `connections:disconnect` | `{ companyId, serviceId, forms: ('key'\|'mcp')[] }` | `ServiceStatus` | removes this company's own key(s) / connection after a native confirm that names what loses access (from usage) |
| `connections:usage` | `{ companyId, serviceId }` | `UsageRef[]` | |

The existing `gateway:*`, `secrets:*`, `dashboards:*`, `linear:*`, `slack:*` channels stay. They are the forms'
own management and they keep working.

### 3.7 Events

New push event `connections:changed { companyId: Id | null; serviceId: string | null }` (null = recompute all), added
to the allowed push list. Main emits it after:
- `KeyNamespaces` / `CompanySecrets` / vault change (already funnels into `data:changed {domain:'secrets'}`),
- every gateway `save` / `remove` / `connect` result / `disconnect` / OAuth status change (today the page **polls** at
  1.5 s during sign-in; `OAuthConnection.onStatus` gets a listener that emits instead),
- Slack status change, Linear connect/disconnect/auth failure, `company:update` of `accounts`,
- a dashboard refresh that changes a key's `invalid_key` / `forbidden` status,
- `connections:*` writes.

Emits are coalesced over 150 ms per company. The renderer store (`state/connections.ts`, zustand) holds
`ServiceStatus[]` per company, loads on first use, and refetches only the affected company on the event. Every slot reads
from it, so connecting PostHog in the dashboard form flips the Settings card, the palette, the agent desk and the
checklist within one event.

---

## 4. UI

### 4.1 `<ConnectionSlot>` (`components/connections/ConnectionSlot.tsx`)

```tsx
<ConnectionSlot companyId={id} service="posthog" purpose="dashboard" variant="inline" | "card" | "row" | "chip" />
```

- **Connected, purpose OK**: line-art roundel + "PostHog" + chip "Connected · key" (or "· signed in", "· from
  Northwind"), then the purpose's actions from the capability (`sessionReplay` → "See sessions" opens `open` in the
  company browser; `askData` → "Ask about it" opens a chat with the department's agent, prefilled "Using PostHog: ";
  `dashboard` → "Add dashboard" / no form needed).
- **Connected, purpose not OK** (OAuth sign-in but the dashboard needs a key): plain sentence from `why` + one button
  from `fix` ("Add a personal API key").
- **Not connected**: "Connect PostHog" (secondary button; primary only where it blocks the thing on screen). It opens
  `<ConnectSheet>`.
- **Attention**: "PostHog turned down the key on 26 Oct. Update key" / "Sign in again".
- `variant="chip"` for dense places (palette rows, desk tool lists). `"card"` is the Settings card.
- Never shows a key value, never a vendor name beyond the service's own (Vibiz Stack's no-vendor rule does not apply to
  third-party services the founder connects themselves).
- No warm colours, line art roundels (VOICE.md §5, DASHBOARDS.md §9).

### 4.2 `<ConnectSheet>` (one flow for every surface)

Tabs only when the service has both forms: **"Paste a key"** (fields from the registry: label, hint, "where to get
it", password field or textarea, "Using the saved key from Shared ••••  Replace") and **"Sign in"** (browser OAuth,
same toast and live update as today). The order follows the purpose: a key first when a dashboard asked, sign-in first
when agent tools asked. A line under the form says what the connection will unlock ("Unlocks: dashboard, agent tools,
session replays, data questions") and, when relevant, what this form can't do. The footer reuses the dashboard key
form's footer: checked read-only, stored encrypted, never shown again. After success the sheet closes, a toast says
"PostHog connected for Northwind. Agents get it from their next session", and every slot updates.

`principia://connect/<service>?company=…&purpose=dashboard` opens the same sheet over Settings › Connections. A link
still only navigates and never connects (deepLink.ts rule). `purpose` is a new optional query parameter.

### 4.3 Where slots go

| Surface | Change |
|---|---|
| S1 Settings › Connections | Cards come from `connections:list`, one per registry service (keeps groups: Needs you, Connected, Popular for X, More, For developers, Custom). A key-only connection shows as Connected with "via key". Each card gets "Used by" and "Also use in…". PostHog, Plausible and GSC get cards. Linear's two forms merge into one card |
| S2 Keys page | Each key row gets the service chip it belongs to ("PostHog · used by Marketing dashboard") via `serviceForKey` |
| S3 Dashboards | Recommended cards use `<ConnectionSlot purpose="dashboard">`: "PostHog connected · Add" adds with **no key form** (only config fields, prefilled from the connection's settings). The key form becomes `<ConnectSheet purpose="dashboard">`. `dashboards:keys` answers from the resolver (aliases and reuse count) |
| S4 Agent tools | Virtual key-backed connections (§3.3). Bridge instructions list connected services by name |
| S5 `connections_list` | Built from `resolver.list`: each row `{ tool, name, status, via: ['key','mcp'], purposes, link }`, so the agent stops asking for something the company already has and knows *how* it has it (env var name or MCP tools) |
| S7/S8 Autopilot, routines | `needs: { service: 'stripe', purpose: 'playbook' }` replaces the regexes for registry services (ads keep `ADS_CONNECTION` until Meta Ads exists in the registry). Offers show the slot inline |
| S9/S10 Checklist, nudges | Checklist rows for Vibiz/socials/Slack read the resolver. "Connect your analytics" row = slot for PostHog or Plausible. Nudges drop a `connect:<tool>` ask when the service is connected in any form |
| S11 Palette | One "Connect X…" item per registry service not connected; for connected ones "X: See sessions", "Ask X…", "Open X card". Exact-match on name and keywords |
| S12 Orchestrator | `connectionId` is normalized with `connectToolId` + registry; a blocker for a connected service is dropped with a log line |
| S13 Marketplace | `keys` map to services: "Needs PostHog" counted connected by any form |
| S14 Workflow editor | The Slack check becomes a `chip` slot. Nodes that reference service keys show the service slot |
| S15 Board › Linear | `LinearIntegration` uses the Linear service card (sync + tools) |
| S16 Onboarding | Saved keys go through `connections:connectKey` (same names), so fal/OpenAI/Firecrawl show as connected services |
| S17 Department page, agent desk | "Tools this agent can use": chips for every connected service that reaches the seat, and "Connect more" → Settings |
| S18 Chat context | One capped line in `passportContext`: "Connected services: PostHog (key, tools), Stripe (sign-in)…" from cached status (no decrypt) |
| S19 Knowledge | Notion/Granola slots under Knowledge "Sources" (offer only; ingestion is not in this plan) |
| S20 Cloud move | Lists services, not raw names, with what moves |

---

## 5. Declaring needs (data, not code)

Anything that needs a service declares it with the registry id:

```ts
needs?: { service: ServiceId; purpose: Purpose; label?: string }[]   // playbooks, routines, marketplace items, dashboard defs
```

`DashboardDef` gets `service: 'posthog'`. Its `keys` field is read from the registry entry's key form, so the names stay
identical. GEO lists `services: ['openai', 'perplexity']` as optional. Playbooks: `stripe-watch` →
`{ service: 'stripe', purpose: 'playbook' }`. Socials: `SOCIAL_CHANNELS` entries reference their registry ids.

## 6. How to add a service

1. Add a `ServiceDef` to `SERVICE_REGISTRY`: id, name, category, blurb, keywords, `forms` (key fields with hint and link,
   MCP URL and auth, `bearerFromKey` only after checking the vendor's docs), `capabilities`, `match` (URLs, names, key
   names), `docs`, `checked`.
2. If a key form should be checked before saving, add a `KeyCheckId` (reuse a dashboard provider's `validate` when there
   is one; otherwise one cheap read-only request in `src/main/connections/checks.ts`).
3. If it feeds a dashboard, set `DashboardDef.service`. If a playbook or routine needs it, add `needs`.
4. Run `npm test`: the registry tests (§8) check ids are unique, the URLs are https, key names are UPPER_SNAKE, every
   capability's `via` names a form the service has, and every `match.urls` resolves back to the service.
5. Nothing else. Settings, the palette, `connections_list`, deep links and slots pick it up.

## 7. Security

- `credentialsFor` is main only. No IPC returns it, and its result is never logged. Every value goes through
  `vault.addRedactions` or is already in the table.
- Virtual MCP headers are built per client and are never written to `mcp-connections.json` or a grant directory
  (the bridge sees the grant dir only, as today).
- Reuse across companies is a reference that the founder chose. A company's agents never get another company's
  connection without that row (COMPANY.md §6 holds; `enforced()` applies to virtuals too).
- `refuse` patterns are evaluated in main. The renderer only gets the reason.
- Error text from vendors goes through `dashboards/http.ts scrub` before reaching the renderer.

## 8. Tests and QA

Unit (vitest, pure): registry invariants; `serviceForUrl/Key/Connection` (PostHog key alias, Stripe two keys, MCP URL
with query string); resolver evidence for each form, including: key only → connected for `dashboard` + `agentTools`;
OAuth MCP only → connected, `dashboard.ok=false` with `fix:'key'`; both; `phc_` refused; reuse from another company;
connection limited to another company does not count; turned-off MCP → `off`; dashboard `invalid_key` → `attention`.
Gateway: a virtual `svc:posthog` is granted, carries the bearer at call time, and is dropped when the key is removed or a real
connection appears; redaction contains the value. Backfill: idempotent, no key or config changes (snapshot of
`secrets`, `company_secrets`, `mcp-connections.json` before and after). `connectionsReport` includes key-only
services. IPC schemas refuse unknown services and oversized settings.

QA (test instance per the worktree rules, CDP driver, fake keys + `HIVE_DASHBOARD_FIXTURES=1`):
1. Seed a company with only `POSTHOG_PERSONAL_API_KEY` (fixture-valid). Marketing › Dashboards shows "PostHog
   connected · Add". Add with no key form. Settings › Connections shows PostHog Connected · key, Used by: Marketing
   dashboard. Palette has "PostHog: See sessions".
2. Remove the key on the Keys page. Every one of those surfaces flips to "Connect PostHog" without a reload.
3. Connect Stripe through the slot on the Finance dashboard card. The Stripe watch playbook offer stops saying
   "Connect Stripe first".
4. An agent session's `connections_list` lists PostHog as connected via key with the env var name. `principia_list_tools`
   lists `svc:posthog` (only when the bearer is confirmed; against a stub MCP server in tests).
5. Screenshots of each slot state, dark theme, phone-width check not needed (desktop).

---

## 9. Build plan

### Part 1: model, resolver, agents, Settings (no surface regresses)

1. `src/shared/services.ts`: types, `SERVICE_REGISTRY` (§2.4), helpers. Move `connectionState`/`usable` here from
   `lib/connections.ts`. Derive `CONNECTION_CATALOG`, `presetForUrl`, `CONNECT_TOOL_IDS`, and the social channels from it.
   Check every vendor fact (MCP URL, key-as-bearer) against the vendor's docs, then set `checked`.
2. `DashboardDef.service` + keys read from the registry (names unchanged; `DASHBOARD_CATALOG` tests stay green).
3. `src/main/connections/{store,resolver,checks,wire}.ts`: `company_connections` table, backfill, resolver, usage,
   `credentialsFor`. Wire it in `index.ts` / `Hive`.
4. Events: `connections:changed` emitted from secrets, gateway (save/remove/connect/OAuth status listener), Slack,
   Linear, company accounts, dashboard status. Coalesced.
5. IPC `connections:*` + zod schemas + handler. Renderer `state/connections.ts` store and `useConnection` hook.
6. Gateway virtual key-backed connections (§3.3) for services whose bearer is confirmed. Bridge instructions list
   connected services.
7. `connectionsReport` rebuilt on the resolver (key-only services count; `via` and env var names in rows).
8. Settings › Connections renders resolver cards (PostHog/Plausible/GSC appear; key-only = Connected · key; Linear
   merged; Used by; Also use in…). `<ConnectionSlot>` and `<ConnectSheet>` built here, first used on these cards.
   `principia://connect/<id>?purpose=` parses.
9. Tests (§8 unit) and the backfill snapshot test. `npm run typecheck`, `npm test`, `npm run lint`.
10. Commit and open the PR.

Exit: an existing install opens with every connection it had, now also showing key-only services as connected. Agents
see them in `connections_list`. No dashboard, gateway, Linear or Slack behaviour changes except additions.

### 9.1 Part 1 as built

- `src/shared/services.ts`: registry (≈45 services), lookups, aliases (`POSTHOG_API_KEY`, `STRIPE_API_KEY`, `NOTION_TOKEN`,
  `FAL_API_KEY`, `APIFY_TOKEN`), `connectionState` (moved from the renderer), and the pure status rules
  (`serviceStatus`, `purposeStates`). A service can have several key forms; `serves` says which purposes each key
  serves (Stripe). `CONNECTION_CATALOG`, dashboard keys (`DashboardDef.services`) and social keys are derived from it.
- `src/main/connections/`: `store.ts` (`company_connections` + backfill), `resolver.ts` (status, list, `credentialsFor`,
  `virtuals`, reuse, key choice), `events.ts` (`connections:changed`, 150 ms), `wire.ts` (Hive wiring, usage: dashboards,
  agents, playbooks, Linear sync, Slack), `resolveAliases.ts` (dashboards read the old key name).
- Gateway: `virtuals`, `reuses` and `onChange` options; `svc:<service>` connections are granted per company, the header
  is read at call time, a real connection to the same service wins, and nothing is persisted.
- `connections_list`: key-only services count, rows carry `via` and `env` (names only). Playbooks' "waiting for
  Stripe" sees any form.
- IPC: `connections:*` (handler `src/main/handlers/connections.ts`), event `connections:changed`, error code
  `not_connected`. Renderer store `state/connections.ts` (`useConnections`, `useConnection`) for Part 2's slots.
- Emitters: secrets handlers, dashboards (save, status), gateway (save, remove, sign-in status), Linear connect and
  disconnect, Slack status, `company:update` of an account.
- Not in Part 1 (Part 2): the Settings cards on the resolver, `<ConnectionSlot>` / `<ConnectSheet>`, every surface in §4.3.

### Part 2: slots everywhere, capabilities, QA

1. Dashboards: recommended cards and the key form → `<ConnectionSlot purpose="dashboard">` / `<ConnectSheet>`; add with
   no key when connected; settings prefilled; `dashboards:keys` on the resolver.
2. Autopilot playbooks, routines, marketplace items: `needs: { service, purpose }`; offers and "Connect … first" use the
   slot; orchestrator blockers normalized and dropped when connected.
3. Setup checklist, nudges, palette (connect / See sessions / Ask… per service), workflow editor, Board › Linear,
   onboarding key saves through `connections:connectKey`.
4. Agent desk / department page "Tools this agent can use". Chat context line. Knowledge "Sources" offer for
   Notion/Granola. Cloud move lists services.
5. Capability actions: `sessionReplay` open links (PostHog), `askData` chat prefill; optional MCP-backed dashboard read
   for PostHog/Stripe (§2.2) only if numbers match the REST provider on fixtures.
6. Keys page service chips. "Also use in…" across companies with native confirm.
7. QA pass (§8) by a separate QA agent on the test instance. Screenshots in `docs/qa/connections/`. Fix pass. Update
   DASHBOARDS.md §3, MCP-GATEWAY.md (virtual connections), AUTOPILOT.md (needs), this doc's Status.

### 9.2 Part 2 as built (UI everywhere)

One component pair, one status, every surface:

- `components/connections/ConnectionSlot.tsx`: `<ConnectionSlot companyId service purpose variant>` with variants
  `row` (one line: roundel, name, chip, "Used by" or "Unlocks", actions or Connect), `inline` (inside another card:
  "PostHog connected · key") and `chip` (dense lists). Connected *for the purpose* shows the capability actions
  (`lib/serviceActions.ts`): `sessionReplay` → **See sessions** (PostHog's `{host}/project/{projectId}/replay/home`,
  or `{host}/replay/home` while the project is unknown, opened in the company browser), `askData` → **Ask about your
  data** (a new chat in the department, first message asks for a 7-day read). Connected but not for this purpose says
  why (`purposes[p].why`) with the one fix. Also `<ConnectedServiceChips>` and `<ChatServiceStarters>`.
- `components/connections/ConnectSheet.tsx`: the one connect flow, mounted once (`ConnectSheetHost` in App, also over
  the first-run flow) and opened from anywhere with `openConnect(companyId, serviceId, purpose?)`
  (`state/connections.ts`). Shows how the company has it (forms, problems, reuse), "Used by", what it unlocks with
  what the chosen form can't do, the service's shared settings (PostHog host and project), **Also use in…** (another
  company reads this one's connection by reference, `connections:reuse`), Disconnect (main confirms natively), and the
  ways to connect: **Paste a key** (registry fields, several key forms as a choice, saved masked, `connections:connectKey`),
  **Sign in** (`connections:signIn`, closes itself when `connections:changed` reports the sign-in), or the service's own
  setup (GitHub, Instagram, Slack, Linear sheets). Tab order follows the purpose's `via`.
- **Dashboards read through a sign-in** (PostHog): `DashboardDef.viaSignIn = { service, config }`. With no key saved
  and a working (non key-backed) MCP connection to the service, `DashboardService` reads through it
  (`deps.mcp` → `GatewayService.toolNames` / `callTool`, main only, never over IPC). The PostHog provider runs its
  HogQL with the server's SQL tool, either `execute-sql` or the single `exec` tool (`call --json execute-sql {…}`);
  answers are read from structured content, JSON text, or the `|`-separated table text the live server sends, as JSON
  `results` or bare (`mcpRows`, checked against the live server 2026-10-30); a busy server is retried once; vendor text
  is never quoted. A key always wins;
  the project id and host become optional through a sign-in. `InstalledDashboard.via` says which. The registry's
  PostHog `dashboard` capability is `via: ['key', 'mcp']`; Stripe's stays key only (its MCP has no REST-equivalent read).
  A server answer the reader can't parse fails with "add a personal API key instead".
- Dashboards also read a key from the company a service is reused from (`dashboards/wire.ts` `resolve`).

Surfaces (§4.3):

| Surface | As built |
|---|---|
| S1 Settings › Connections | `buildCatalog({ …, services })` merges `connections:list`: a card connected in any form is Connected with the resolver's chip; services with no preset (PostHog by key, Plausible, Search Console, OpenAI once connected) get cards; a service that takes a key opens the shared sheet; every card says "Used by" (connected) or "Unlocks" (not); a "What it is for" filter (Agent tools, Dashboards, Data questions, Knowledge, Autopilot, Posting, Sync) groups by need; `principia://connect/<id>?purpose=` opens the sheet. Reloads on `connections:changed` |
| S2 Keys | each key row names its service and what uses it ("PostHog · used by Marketing dashboard") |
| S3 Dashboards | recommended cards show the inline slot; "Add" with no key form when connected (settings prefilled from the service; "Use another key" to override); "Or skip the key: sign in to PostHog"; marketplace "PostHog connected · key"; an installed PostHog dashboard has See sessions / Ask about your data and a "via sign-in" pill |
| S7 Autopilot | playbook "Needs Stripe" lines and Needs-you offers are slots (`purpose: 'playbook'`), connect in place |
| S9 Checklist | "Connect your product analytics" (PostHog, Plausible or Search Console in any form; opens the sheet); Vibiz done by its token too |
| S10 Nudges | no "Connect X" nudge for a service connected in any form |
| S11 ⌘K | one row per registry service: "Connect PostHog…" or "PostHog connection" (chip, used by), plus "PostHog: See sessions" and "Ask PostHog about your data…" |
| S13 Marketplace | missing keys that belong to a service show that service's slot |
| S16 Onboarding | keys saved at launch emit `connections:changed`; Ready shows "Connected for {name}" chips and a PostHog (code) or Stripe slot |
| S17 Agent desk | "Tools {name} can use": chips of every service whose `agentTools` is ok, "+ Connect more" |
| S18 Chat | `passportContext` adds "## Connected services (this company)" (names, env var names, MCP; never values) from `ConnectionResolver.contextBlock`; an empty chat shows "Connected here: …" and one "Ask PostHog how last week went" starter per data service |
| S19 Knowledge | Knowledge › "Sources": slots for every service with a `knowledge` capability (Notion, Granola), offer only |

Not changed in Part 2: workflow editor (S14), Board › Linear (S15, Settings' Linear card already merges sync and MCP),
orchestrator blockers (S12), cloud move (S20), run views (S21).

### 9.3 QA round (as built)

Three QA passes (a newcomer, a power user, an attacker) found these; each is fixed at the root and has a test
(`main/connections/__tests__/qa-round.test.ts`, `main/dashboards/__tests__/checkKey.test.ts`, `gateway/__tests__/virtual.test.ts`,
`renderer/src/lib/connectionsEverywhere.test.ts`).

- **Identity is the exact https URL.** `serviceForConnection` matches only a registry URL (origin + path, https). A name
  or host that only looks like a service (`match.fragments` as whole words, `match.hosts` by domain) is a *suggestion*
  ("looks like PostHog?"): the founder confirms it (`connections:confirm`, stored as `mcp_confirmed`) and then it serves
  agent tools only, never a dashboard, a session link or a sign-in. Older name-based links no longer count. Dropbox is
  not X. Disconnect removes exactly the connections that ARE the service here, and the confirm names each by name and host.
- **Keys are checked and turned-down keys show everywhere.** `connectKey` always runs the vendor's read-only check: the
  dashboard's own when its settings are known, else a key-only check (`provider.checkKey`; PostHog: `/api/users/@me/`,
  US then EU, which also finds the EU host). A rejected key stores nothing; an unreachable vendor saves it as "not
  checked". A rejection of a saved key at add-dashboard time or on an agent's call (HTTP 401 on a key-backed connection)
  is recorded in `company_connections.key_problems` and the service is Needs attention on every surface (Settings card
  with Fix, checklist, palette, desk). A missing dashboard permission (`forbidden`) marks only the dashboard purpose:
  agents keep the tools from the same key. A 403 that says the key is invalid counts as a turned-down key.
- **Stripe.** A secret key (`sk_…`) is refused as an agent key and never becomes MCP tools. The key tab says which key
  does what (`keyGuide`, each form's `good` line, "This key unlocks … It can't do …" per chosen form); the secret key
  is behind "Advanced". The playbook capability is "Revenue brief autopilot" (`revenue-brief`).
- **Profiles.** A key-backed connection (`svc:<service>`) reaches a spawn only when its profile's `secretNames` may read
  that key (`['*']` or the name); none when the caller passes no list. The Linear sync key gives agents Linear's tools
  only after the founder turns that on (`bearerFromKey.optIn`, `connections:keyTools`).
- **The founder's own MCP servers.** A spawn that reaches a service through Principia gets `--disallowedTools mcp__<id>`
  for it, so a Claude-level `posthog` server (another account) is not used; the context block and "Ask about your data"
  say to use Principia's tools only.
- **Reuse.** "Use the one from Ledgerline" is the first choice in a company that lacks the service
  (`connections:sources`). Personal never reuses a company's connection; a source with nothing to lend is refused; the
  lender's "Used by" lists the borrowers, its "Also use in…" leaves them out, and its Disconnect names them (and ends
  their reuse). A borrower reads the lender's host and project and cannot change where the lent key goes; it sees
  "KEY (from Ledgerline)", "Stop using Ledgerline's PostHog" instead of Disconnect, and no env var for the lent key
  (agents reach it through the MCP built from it). Archiving a company ends every reuse of it for good.
- **Settings are checked when saved:** a host is a public https address with no path or credentials (no IP literals,
  localhost or metadata names). PostHog asks for its region as a choice (US cloud, EU cloud, self-hosted with a warning)
  and says where the Project ID is and what needs it. The key-backed connection uses PostHog's EU MCP for an EU host.
- **Older key names.** Disconnect removes `POSTHOG_API_KEY` and other aliases and names them; Replace saves under the new
  name and removes the old one; the sheet names the key actually found.
- **Surfaces.** One service monogram everywhere; the sheet closes when the founder switches company; Knowledge shows
  its Sources beside every note; the New chat dialog shows the connected-services starters; routing sources and
  playbooks show their connection's state; the checklist row offers a small chooser; the dashboard marketplace says
  "Stripe connected · needs a restricted key for this dashboard" and the add dialog explains why.
