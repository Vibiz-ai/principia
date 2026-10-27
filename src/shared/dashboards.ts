/**
 * DASHBOARDS.md: the department dashboard catalog and the shapes main and the renderer share.
 *
 * The catalog is data: one `DashboardDef` per dashboard says which departments it is recommended for, which keys it
 * needs (with where to get each one), what the user configures and which widgets it shows. Adding a dashboard means
 * adding an entry here plus a provider in src/main/dashboards/providers. Keys never appear in any type below: the
 * renderer only ever sees key *names* and whether they are present.
 */
import type { DepartmentPresetKey } from './company'
import { keyField, type ServiceKeyField } from './services'

export type DashboardKind = 'gsc' | 'geo' | 'plausible' | 'posthog' | 'stripe' | 'github'
export const DASHBOARD_KINDS: readonly DashboardKind[] = ['gsc', 'geo', 'plausible', 'posthog', 'stripe', 'github']

export type DashboardCategory = 'SEO' | 'AI visibility' | 'Web analytics' | 'Revenue' | 'Engineering'
export const DASHBOARD_CATEGORIES: readonly DashboardCategory[] = ['SEO', 'AI visibility', 'Web analytics', 'Revenue', 'Engineering']

/** How a number is shown. `position` is a rank (lower is better, one decimal); `duration` is seconds. */
export type MetricFormat = 'number' | 'currency' | 'percent' | 'position' | 'duration' | 'score'
/** Which direction of change is good news (drives the delta colour). */
export type GoodWhen = 'up' | 'down' | 'neutral'

/** A key a dashboard reads: the registry's key field (services.ts), so a key has one name everywhere. */
export type DashboardKeyField = ServiceKeyField

export interface DashboardConfigField {
  key: string
  label: string
  required: boolean
  /** `list`: one entry per line (prompts, competitors). */
  kind: 'text' | 'list'
  placeholder?: string
  hint?: string
  /** list only: at most this many entries */
  max?: number
}

export type WidgetDef =
  | { id: string; kind: 'kpi'; title: string; format: MetricFormat; good: GoodWhen; hint?: string }
  | { id: string; kind: 'line'; title: string; format: MetricFormat; hint?: string }
  | { id: string; kind: 'table'; title: string; columns: { key: string; label: string; format?: MetricFormat }[]; hint?: string }

export interface DashboardDef {
  id: DashboardKind
  name: string
  /** The service behind it, for the logo and "Powered by". */
  provider: string
  /** CONNECTIONS.md §5: the registry services it reads (its keys come from their key forms; names never change). */
  services: string[]
  category: DashboardCategory
  tagline: string
  description: string
  /** Recommended in these departments (any department can still add it from the marketplace). */
  departments: DepartmentPresetKey[]
  keys: DashboardKeyField[]
  config: DashboardConfigField[]
  widgets: WidgetDef[]
  /** Scheduled refresh interval. Manual refresh is always available. */
  refreshMinutes: number
  /** Shown when the dashboard can run with no key at all (GEO on the installed Claude CLI, GitHub on `gh`). */
  keylessNote?: string
  /**
   * CONNECTIONS.md §4.3: with no key saved, it can also read through the company's sign-in to this service (its MCP
   * connection). `config`: the fields a sign-in makes unnecessary (the sign-in already picked the project).
   */
  viaSignIn?: { service: string; config: string[] }
}

const PERIOD = 'Last 28 days vs the 28 before'

export const DASHBOARD_CATALOG: readonly DashboardDef[] = [
  {
    id: 'gsc',
    name: 'SEO · Search Console',
    provider: 'Google Search Console',
    services: ['google-search-console'],
    category: 'SEO',
    tagline: 'Clicks, impressions, CTR and rank from Google Search.',
    description: 'Search performance straight from Google Search Console: how often you show up, how often people click, your average position, and the queries and pages that bring traffic. Adds a PageSpeed score for your home page.',
    departments: ['marketing'],
    keys: [keyField('google-search-console', 'GSC_SERVICE_ACCOUNT_JSON'), keyField('google-search-console', 'PAGESPEED_API_KEY')],
    config: [
      { key: 'siteUrl', label: 'Property', required: true, kind: 'text', placeholder: 'sc-domain:example.com or https://example.com/', hint: 'Exactly as it appears in Search Console’s property picker.' },
      { key: 'pageSpeedUrl', label: 'PageSpeed page', required: false, kind: 'text', placeholder: 'https://example.com/', hint: 'Defaults to the property’s home page.' }
    ],
    widgets: [
      { id: 'clicks', kind: 'kpi', title: 'Clicks', format: 'number', good: 'up', hint: PERIOD },
      { id: 'impressions', kind: 'kpi', title: 'Impressions', format: 'number', good: 'up', hint: PERIOD },
      { id: 'ctr', kind: 'kpi', title: 'CTR', format: 'percent', good: 'up', hint: 'Clicks ÷ impressions' },
      { id: 'position', kind: 'kpi', title: 'Avg position', format: 'position', good: 'down', hint: 'Impression-weighted, lower is better' },
      { id: 'pagespeed', kind: 'kpi', title: 'PageSpeed (mobile)', format: 'score', good: 'up', hint: 'Lighthouse performance score' },
      { id: 'lcp', kind: 'kpi', title: 'Largest paint', format: 'duration', good: 'down', hint: 'LCP on mobile, seconds' },
      { id: 'daily', kind: 'line', title: 'Clicks and impressions per day', format: 'number' },
      { id: 'queries', kind: 'table', title: 'Top queries', columns: [{ key: 'query', label: 'Query' }, { key: 'clicks', label: 'Clicks', format: 'number' }, { key: 'impressions', label: 'Impr.', format: 'number' }, { key: 'ctr', label: 'CTR', format: 'percent' }, { key: 'position', label: 'Pos.', format: 'position' }] },
      { id: 'pages', kind: 'table', title: 'Top pages', columns: [{ key: 'page', label: 'Page' }, { key: 'clicks', label: 'Clicks', format: 'number' }, { key: 'impressions', label: 'Impr.', format: 'number' }, { key: 'position', label: 'Pos.', format: 'position' }] }
    ],
    refreshMinutes: 6 * 60
  },
  {
    id: 'geo',
    name: 'GEO · AI visibility',
    provider: 'AI answer engines',
    services: ['openai', 'perplexity'],
    category: 'AI visibility',
    tagline: 'How often ChatGPT, Perplexity and Claude name you, and who they name instead.',
    description: 'Asks the questions your buyers ask (“best tool for …”) to the AI answer engines you connect, then measures how often your brand is mentioned, where it ranks among competitors, whether your site is cited, and your share of voice. Runs once a day so you can watch the trend.',
    departments: ['marketing'],
    keys: [
      keyField('openai', 'OPENAI_API_KEY', { required: false, hint: 'Optional. Asks ChatGPT’s model. platform.openai.com → API keys → Create (a project key with Model capabilities is enough).' }),
      keyField('perplexity', 'PERPLEXITY_API_KEY', { required: false, hint: 'Optional, recommended: Perplexity searches the web and returns its citations, so you see whether your site is the source.' })
    ],
    config: [
      { key: 'brand', label: 'Brand', required: true, kind: 'text', placeholder: 'Acme', hint: 'The name people would write in an answer.' },
      { key: 'aliases', label: 'Also matches', required: false, kind: 'list', max: 5, placeholder: 'Acme AI\nacme.com', hint: 'Other spellings, product names or your domain. One per line.' },
      { key: 'domain', label: 'Website', required: false, kind: 'text', placeholder: 'acme.com', hint: 'Counted as a citation when an answer links to it.' },
      { key: 'competitors', label: 'Competitors', required: false, kind: 'list', max: 8, placeholder: 'Globex\nInitech', hint: 'One per line. Share of voice compares you to these.' },
      { key: 'prompts', label: 'Tracked prompts', required: true, kind: 'list', max: 10, placeholder: 'What is the best invoicing tool for freelancers?\nAlternatives to Globex for small teams', hint: 'Questions a buyer would ask an AI. One per line, up to 10.' }
    ],
    widgets: [
      { id: 'mentionRate', kind: 'kpi', title: 'Mention rate', format: 'percent', good: 'up', hint: 'Answers that name you' },
      { id: 'shareOfVoice', kind: 'kpi', title: 'Share of voice', format: 'percent', good: 'up', hint: 'Your mentions ÷ all tracked brands’ mentions' },
      { id: 'avgRank', kind: 'kpi', title: 'Avg rank when named', format: 'position', good: 'down', hint: '1 = named first' },
      { id: 'citationRate', kind: 'kpi', title: 'Cited', format: 'percent', good: 'up', hint: 'Answers that link to your site' },
      { id: 'trend', kind: 'line', title: 'Mention rate and share of voice per run', format: 'percent' },
      { id: 'brands', kind: 'table', title: 'Share of voice', columns: [{ key: 'brand', label: 'Brand' }, { key: 'mentions', label: 'Answers', format: 'number' }, { key: 'share', label: 'Share', format: 'percent' }] },
      { id: 'prompts', kind: 'table', title: 'Tracked prompts', columns: [{ key: 'prompt', label: 'Prompt' }, { key: 'named', label: 'Named you' }, { key: 'rank', label: 'Rank', format: 'position' }, { key: 'instead', label: 'Named instead' }] }
    ],
    refreshMinutes: 24 * 60,
    keylessNote: 'With no key it asks your installed Claude CLI (from memory, no web search). Add OpenAI or Perplexity to cover more engines.'
  },
  {
    id: 'plausible',
    name: 'Web analytics · Plausible',
    provider: 'Plausible',
    services: ['plausible'],
    category: 'Web analytics',
    tagline: 'Visitors, pageviews, bounce rate and where traffic comes from.',
    description: 'Your site’s traffic from Plausible: unique visitors, pageviews, bounce rate and visit duration against the previous period, with the top pages and sources.',
    departments: ['marketing'],
    keys: [keyField('plausible', 'PLAUSIBLE_API_KEY')],
    config: [
      { key: 'siteId', label: 'Site', required: true, kind: 'text', placeholder: 'example.com', hint: 'The domain exactly as it is listed in Plausible.' },
      { key: 'host', label: 'Host', required: false, kind: 'text', placeholder: 'https://plausible.io', hint: 'Only for self-hosted Plausible.' }
    ],
    widgets: [
      { id: 'visitors', kind: 'kpi', title: 'Visitors', format: 'number', good: 'up', hint: PERIOD },
      { id: 'pageviews', kind: 'kpi', title: 'Pageviews', format: 'number', good: 'up', hint: PERIOD },
      { id: 'bounceRate', kind: 'kpi', title: 'Bounce rate', format: 'percent', good: 'down' },
      { id: 'visitDuration', kind: 'kpi', title: 'Visit duration', format: 'duration', good: 'up' },
      { id: 'daily', kind: 'line', title: 'Visitors per day', format: 'number' },
      { id: 'pages', kind: 'table', title: 'Top pages', columns: [{ key: 'page', label: 'Page' }, { key: 'visitors', label: 'Visitors', format: 'number' }] },
      { id: 'sources', kind: 'table', title: 'Top sources', columns: [{ key: 'source', label: 'Source' }, { key: 'visitors', label: 'Visitors', format: 'number' }] }
    ],
    refreshMinutes: 60
  },
  {
    id: 'posthog',
    name: 'Product analytics · PostHog',
    provider: 'PostHog',
    services: ['posthog'],
    category: 'Web analytics',
    tagline: 'Users, pageviews, top pages and referrers from PostHog.',
    description: 'Daily users and pageviews from your PostHog project, against the previous period, with the pages people visit most and the sites that send them.',
    departments: ['marketing', 'development'],
    keys: [keyField('posthog', 'POSTHOG_PERSONAL_API_KEY', { hint: 'PostHog → Settings → Personal API keys → Create. Scope: Query Read and Project Read, limited to this project.' })],
    config: [
      { key: 'projectId', label: 'Project ID', required: true, kind: 'text', placeholder: '12345', hint: 'Settings → Project → Project ID.' },
      { key: 'host', label: 'Host', required: false, kind: 'text', placeholder: 'https://us.posthog.com', hint: 'https://eu.posthog.com for the EU cloud, or your own host.' }
    ],
    viaSignIn: { service: 'posthog', config: ['projectId', 'host'] },
    widgets: [
      { id: 'users', kind: 'kpi', title: 'Users', format: 'number', good: 'up', hint: PERIOD },
      { id: 'pageviews', kind: 'kpi', title: 'Pageviews', format: 'number', good: 'up', hint: PERIOD },
      { id: 'viewsPerUser', kind: 'kpi', title: 'Views per user', format: 'number', good: 'up' },
      { id: 'daily', kind: 'line', title: 'Users and pageviews per day', format: 'number' },
      { id: 'pages', kind: 'table', title: 'Top pages', columns: [{ key: 'page', label: 'Page' }, { key: 'views', label: 'Views', format: 'number' }] },
      { id: 'referrers', kind: 'table', title: 'Top referrers', columns: [{ key: 'referrer', label: 'Referrer' }, { key: 'views', label: 'Views', format: 'number' }] }
    ],
    refreshMinutes: 60
  },
  {
    id: 'stripe',
    name: 'Revenue · Stripe',
    provider: 'Stripe',
    services: ['stripe'],
    category: 'Revenue',
    tagline: 'MRR, new customers, churn, net revenue and failed payments.',
    description: 'The numbers a CFO asks for, computed from your Stripe subscriptions, customers and charges: MRR and its trend, new and churned customers, churn rate, net revenue after refunds, failed payments and ARPU. Read-only: it needs a restricted key that cannot move money.',
    departments: ['finance', 'sales'],
    keys: [keyField('stripe', 'STRIPE_RESTRICTED_KEY')],
    config: [],
    widgets: [
      { id: 'mrr', kind: 'kpi', title: 'MRR', format: 'currency', good: 'up', hint: 'Paying subscriptions, monthly. vs 30 days ago' },
      { id: 'newCustomers', kind: 'kpi', title: 'New customers', format: 'number', good: 'up', hint: 'Last 30 days vs the 30 before' },
      { id: 'churned', kind: 'kpi', title: 'Churned customers', format: 'number', good: 'down', hint: 'Paying 30 days ago, not paying now' },
      { id: 'churnRate', kind: 'kpi', title: 'Churn rate', format: 'percent', good: 'down', hint: 'Churned ÷ paying customers 30 days ago' },
      { id: 'netRevenue', kind: 'kpi', title: 'Net revenue', format: 'currency', good: 'up', hint: 'Successful charges minus refunds, last 30 days' },
      { id: 'failedPayments', kind: 'kpi', title: 'Failed payments', format: 'number', good: 'down', hint: 'Last 30 days' },
      { id: 'arpu', kind: 'kpi', title: 'ARPU', format: 'currency', good: 'up', hint: 'MRR ÷ paying customers' },
      { id: 'payingCustomers', kind: 'kpi', title: 'Paying customers', format: 'number', good: 'up' },
      { id: 'mrrTrend', kind: 'line', title: 'MRR by month', format: 'currency' },
      { id: 'customerFlow', kind: 'line', title: 'New and churned customers by month', format: 'number' },
      { id: 'plans', kind: 'table', title: 'MRR by plan', columns: [{ key: 'plan', label: 'Plan' }, { key: 'subscribers', label: 'Subs', format: 'number' }, { key: 'mrr', label: 'MRR', format: 'currency' }] },
      { id: 'failures', kind: 'table', title: 'Recent failed payments', columns: [{ key: 'customer', label: 'Customer' }, { key: 'when', label: 'When' }, { key: 'amount', label: 'Amount', format: 'currency' }, { key: 'reason', label: 'Reason' }] }
    ],
    refreshMinutes: 60
  },
  {
    id: 'github',
    name: 'Engineering · GitHub',
    provider: 'GitHub',
    services: ['github'],
    category: 'Engineering',
    tagline: 'Pull requests, merge speed, CI health and issues for one repository.',
    description: 'Open and merged pull requests, median time to merge, CI success on the default branch and issue flow for a GitHub repository, with the latest workflow runs and the pull requests waiting for review.',
    departments: ['development'],
    keys: [keyField('github', 'GITHUB_TOKEN', { required: false, hint: 'Optional when the GitHub CLI is signed in on this Mac (gh auth login). Otherwise a fine-grained token with read access to Pull requests, Issues, Actions and Metadata on this repository.' })],
    config: [{ key: 'repo', label: 'Repository', required: true, kind: 'text', placeholder: 'owner/name', hint: 'For example vercel/next.js.' }],
    widgets: [
      { id: 'openPrs', kind: 'kpi', title: 'Open PRs', format: 'number', good: 'neutral' },
      { id: 'mergedPrs', kind: 'kpi', title: 'Merged PRs', format: 'number', good: 'up', hint: 'Last 30 days vs the 30 before' },
      { id: 'timeToMerge', kind: 'kpi', title: 'Median time to merge', format: 'duration', good: 'down', hint: 'PRs merged in the last 30 days' },
      { id: 'ciSuccess', kind: 'kpi', title: 'CI success', format: 'percent', good: 'up', hint: 'Last 50 finished runs on the default branch' },
      { id: 'openIssues', kind: 'kpi', title: 'Open issues', format: 'number', good: 'down' },
      { id: 'issuesClosed', kind: 'kpi', title: 'Issues closed', format: 'number', good: 'up', hint: 'Last 30 days vs the 30 before' },
      { id: 'mergedWeekly', kind: 'line', title: 'Merged PRs per week', format: 'number' },
      { id: 'runs', kind: 'table', title: 'Latest CI runs', columns: [{ key: 'workflow', label: 'Workflow' }, { key: 'branch', label: 'Branch' }, { key: 'result', label: 'Result' }, { key: 'when', label: 'When' }] },
      { id: 'waiting', kind: 'table', title: 'Open pull requests', columns: [{ key: 'title', label: 'Title' }, { key: 'author', label: 'Author' }, { key: 'age', label: 'Open for' }] }
    ],
    refreshMinutes: 30,
    keylessNote: 'Uses the GitHub CLI’s sign-in on this Mac when no token is added.'
  }
]

export function dashboardDef(kind: string): DashboardDef | undefined {
  return DASHBOARD_CATALOG.find((d) => d.id === kind)
}

/**
 * The preset a department behaves like, for recommendations: its key when it is a preset, else a guess from its name
 * ("CFO", "Growth", "Engineering"). null = no recommendations (the marketplace still lists everything).
 */
export function dashboardDepartmentKey(dep: { key: string; name: string }): DepartmentPresetKey | null {
  const s = `${dep.key} ${dep.name}`.toLowerCase()
  const rules: [DepartmentPresetKey, RegExp][] = [
    ['finance', /\b(financ\w*|cfo|accounting|revenue|billing)\b/],
    ['marketing', /\b(marketing|growth|seo|content|brand)\b/],
    ['sales', /\b(sales|bizdev|business development|partnerships)\b/],
    ['development', /\b(development|engineering|dev|product|tech|eng)\b/],
    ['support', /\b(support|success|customer care|helpdesk)\b/],
    ['ops', /\b(ops|operations|admin)\b/]
  ]
  const exact = rules.find(([key]) => key === dep.key)
  if (exact) return exact[0]
  for (const [key, re] of rules) if (re.test(s)) return key
  return null
}

/** Recommended dashboards for a department preset, catalog order. */
export function recommendedFor(key: DepartmentPresetKey | null): DashboardDef[] {
  return key ? DASHBOARD_CATALOG.filter((d) => d.departments.includes(key)) : []
}

/** Marketplace search: every word must match name, tagline, provider, category or description. */
export function searchDashboards(query: string, filter: { department?: DepartmentPresetKey | 'all'; category?: DashboardCategory | 'all' } = {}): DashboardDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return DASHBOARD_CATALOG.filter((d) => {
    if (filter.department && filter.department !== 'all' && !d.departments.includes(filter.department)) return false
    if (filter.category && filter.category !== 'all' && d.category !== filter.category) return false
    const hay = `${d.name} ${d.tagline} ${d.provider} ${d.category} ${d.description} ${d.departments.join(' ')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// ---------- snapshots ----------

export interface KpiValue {
  value: number | null
  /** The same metric for the comparison period; null = no comparison. */
  previous: number | null
}
export interface SeriesPoint {
  /** ISO date (YYYY-MM-DD) or timestamp */
  t: string
  v: number
}
export interface Series {
  label: string
  points: SeriesPoint[]
}
export type TableRow = Record<string, string | number | null>

export interface DashboardSnapshot {
  fetchedAt: string
  /** Human label of the period the KPIs cover. */
  period: string
  /** ISO 4217 code for `currency` formatted values. */
  currency?: string
  kpis: Record<string, KpiValue>
  series: Record<string, Series[]>
  tables: Record<string, TableRow[]>
  /** Non-fatal problems (PageSpeed quota hit, a capped page count). */
  warnings?: string[]
  /** Fixture data (marketplace preview or HIVE_DASHBOARD_FIXTURES), always labelled in the UI. */
  sample?: boolean
}

export type DashboardErrorCode = 'invalid_key' | 'forbidden' | 'rate_limited' | 'network' | 'no_data' | 'config' | 'unavailable'
export interface DashboardStatus {
  state: 'ok' | 'error' | 'loading' | 'never'
  code?: DashboardErrorCode
  message?: string
  /** When the last attempt ended. */
  at?: string
}

export type DashboardConfig = Record<string, string | string[]>

export interface DashboardKeyState {
  name: string
  required: boolean
  /** Where the value resolves from (company keys win over Shared); null = missing. */
  source: 'company' | 'shared' | null
}

export interface InstalledDashboard {
  id: string
  companyId: string
  departmentId: string | null
  kind: DashboardKind
  config: DashboardConfig
  status: DashboardStatus
  snapshot: DashboardSnapshot | null
  keys: DashboardKeyState[]
  /** CONNECTIONS.md §4.3: reads with a saved key, or through the company's sign-in to the service (no key) */
  via?: 'key' | 'signIn'
  createdAt: string
  updatedAt: string
}

export interface DashboardInstallInput {
  companyId: string
  departmentId: string | null
  kind: DashboardKind
  config: DashboardConfig
  /** Newly pasted values only, by key name. A missing name reuses the saved key. Crosses IPC once, never comes back. */
  keys: Record<string, string>
}

/** Where a key would come from before install (the form's "Using your saved key" line). */
export interface DashboardKeyLookup {
  name: string
  source: 'company' | 'shared' | null
  masked: string | null
}

// ---------- shared number helpers (main computes, the renderer formats) ----------

/** Relative change, or null when there is nothing to compare with. */
export function deltaRatio(value: number | null, previous: number | null): number | null {
  if (value == null || previous == null) return null
  if (previous === 0) return value === 0 ? 0 : null
  return (value - previous) / Math.abs(previous)
}

/** 'good' | 'bad' | 'flat' for a change, given which direction is good. */
export function deltaTone(ratio: number | null, good: GoodWhen): 'good' | 'bad' | 'flat' {
  if (ratio == null || Math.abs(ratio) < 0.005 || good === 'neutral') return 'flat'
  return (ratio > 0) === (good === 'up') ? 'good' : 'bad'
}

/** Config list values arrive as string[] or newline text; trimmed, empties dropped. */
export function configList(v: string | string[] | undefined): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []
  return arr.map((s) => s.trim()).filter(Boolean)
}
export function configText(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v.join(' ') : (v ?? '')).trim()
}

/** One metric for display ("$12.3K", "4.2%", "11.4", "2.5 s", "82"). `compact` shortens big numbers. */
export function formatMetric(value: number | null | undefined, format: MetricFormat, opts: { currency?: string; compact?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const compact = (opts.compact ?? true) && Math.abs(value) >= 10_000
  const num = (v: number, digits = 0): string =>
    new Intl.NumberFormat('en-US', compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: digits }).format(v)
  switch (format) {
    case 'currency': {
      const code = (opts.currency ?? 'USD').toUpperCase()
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0 }) }).format(value)
      } catch {
        return `${num(value, 2)} ${code}`
      }
    }
    case 'percent':
      return `${(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`
    case 'position':
      return value.toFixed(1)
    case 'score':
      return String(Math.round(value))
    case 'duration':
      if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} s`
      if (value < 3600) return `${Math.floor(value / 60)}m ${String(Math.round(value % 60)).padStart(2, '0')}s`
      if (value < 48 * 3600) return `${(value / 3600).toFixed(1)} h`
      return `${(value / 86_400).toFixed(1)} d`
    default:
      return num(value, Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0)
  }
}

/** "+4.2%" / "−3%" for a delta ratio; '' without one. */
export function formatDelta(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return ''
  const p = ratio * 100
  const s = Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p)).toString()
  return `${p >= 0 ? '+' : '−'}${s}%`
}
