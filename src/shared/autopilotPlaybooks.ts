/**
 * AUTOPILOT.md §6: autopilot playbooks. "Put it on autopilot": recurring watches matched to real work the team just
 * did (ads launched, posts published, a site deployed, pull requests merged, a support inbox used, Stripe connected,
 * outreach sent). Each playbook is one ordinary schedule for one agent, with a level and hard limits.
 *
 * Levels:
 * - Level 1, watch & report: checks and tells you; changes nothing;
 * - Level 2, propose changes: checks, then asks you to approve each change (approval cards in Needs you);
 * - Level 3, act within limits: makes the routine changes itself inside the hard limits, then tells you.
 *
 * A playbook that moves money (ads budgets) is never above Level 2 unless the founder explicitly raised it, and even
 * then never creates campaigns, changes a goal, goes over the total budget cap or touches other campaigns.
 * `guardAction` is the code that refuses; the prompt only repeats it.
 *
 * Pure: no node or electron imports. Matching is deterministic (tool names, connection ids, words, departments, the
 * run report's optional `recurring` hint), so the same run always makes the same offer.
 */
import type { DepartmentPresetKey } from './company'

export const PLAYBOOK_IDS = ['ads-watch', 'social-rhythm', 'site-watch', 'release-digest', 'support-triage', 'revenue-brief', 'outreach-followups'] as const
export type PlaybookId = (typeof PLAYBOOK_IDS)[number]
export const isPlaybookId = (v: unknown): v is PlaybookId => typeof v === 'string' && (PLAYBOOK_IDS as readonly string[]).includes(v)

export type PlaybookLevel = 1 | 2 | 3
export const PLAYBOOK_LEVELS: readonly PlaybookLevel[] = [1, 2, 3]
export const isPlaybookLevel = (v: unknown): v is PlaybookLevel => v === 1 || v === 2 || v === 3

export const LEVEL_INFO: Record<PlaybookLevel, { name: string; line: string }> = {
  1: { name: 'Watch & report', line: 'Checks and tells you. Changes nothing.' },
  2: { name: 'Propose changes', line: 'Checks, then asks you to approve each change.' },
  3: { name: 'Act within limits', line: 'Makes routine changes itself, inside the hard limits, and tells you after.' }
}
export const levelLabel = (l: PlaybookLevel): string => `Level ${l} · ${LEVEL_INFO[l].name}`

/** Numbers the founder can set per playbook (the rest of the limits are fixed lines). */
export interface PlaybookLimits {
  /** changes proposed (Level 2) or made (Level 3) per run */
  maxChanges: number
  /** money playbooks: the total daily budget cap, in dollars, across the campaigns it watches */
  budgetCapUsd?: number | null
  /**
   * money playbooks: the ids of the campaigns, ad sets and ads it was set up for (the founder lists them). At Level 3 a
   * change must name only these; with none listed it changes nothing.
   */
  targets?: string[]
}
export const LIMIT_RANGES = { maxChanges: { min: 1, max: 5 }, budgetCapUsd: { min: 1, max: 100_000 }, targets: { max: 50 } } as const
/** One id as the founder pastes it ("120210000000001", "act_1/campaigns/2", "customers/1/campaigns/2"). */
const TARGET_ID = /^[A-Za-z0-9_.:/-]{1,120}$/
/** "123, 456\n789" → ["123", "456", "789"]: trimmed, valid, distinct, at most 50. */
export function parseTargets(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : []
  const out: string[] = []
  for (const p of parts) {
    const t = typeof p === 'string' || typeof p === 'number' ? String(p).trim() : ''
    if (t && TARGET_ID.test(t) && !out.includes(t)) out.push(t)
    if (out.length >= LIMIT_RANGES.targets.max) break
  }
  return out
}

export interface PlaybookDef {
  id: PlaybookId
  name: string
  /** the short name the header, Home and the rail use ("Ads watch") */
  short: string
  /** "your ads": the card reads "Put your ads on autopilot?" */
  thing: string
  /** one sentence: what it does */
  summary: string
  cron: string
  cadence: string
  /** the department whose agent runs it (else the lead agent) */
  dept: DepartmentPresetKey | 'lead'
  /** it can move money (ads budgets): never above Level 2 without the founder's explicit raise */
  money: boolean
  /** the level an offer preselects */
  defaultLevel: PlaybookLevel
  /** what one run does at each level, in plain words */
  plan: Record<PlaybookLevel, string>
  /** hard limits, always on, whatever the level */
  limits: string[]
  defaultLimits: PlaybookLimits
  /** what it costs, in plain words */
  cost: string
  /** the after-the-fact reason an offer gives when the run changed something with a tool ("Ads were launched") */
  because: string
  /** what the work was about, for a reason from words alone ("ads": "Marcus worked on ads in LE-8") */
  topic: string
  /**
   * A connection it cannot do anything without (ads-watch reads the ads account). Missing: the offer says "Connect … first"
   * and turning it on waits, paused, until the connection is there (it never runs only to say it sees nothing).
   */
  needs?: { connections: RegExp; label: string; connectId: string }
  /** a count limit checked in code (posts a week, messages a day), on top of `maxChanges` per run */
  caps?: { kinds: readonly PlaybookActionKind[]; max: number; days: number; line: string }
  signals: {
    /** tool names it recognises (mcp__meta_ads__create_campaign, a Bash line naming the API) */
    tools: RegExp
    /** connection ids (principia://connect/<id>, MCP servers, key names) */
    connections: RegExp
    /** words in a run summary, evidence or task title that mean this work happened */
    text: RegExp
    /** departments whose work this usually is (a tie-break, never enough alone) */
    departments: readonly DepartmentPresetKey[]
  }
}

/** An ads account by id, name or key, whatever the connection is called ("meta", "Meta Ads", "pipeboard", GOOGLE_ADS_…). */
export const ADS_CONNECTION = /^(meta|facebook|fb)$|meta[-_ ]?ads|facebook[-_ ]?ads|google[-_ ]?ads|adwords|tiktok[-_ ]?ads|linkedin[-_ ]?ads|pipeboard|_ADS_|ADS_TOKEN|META_ACCESS_TOKEN|^meta[-_ ]|(^|[-_ ])ads($|[-_ ])/i

const RO = 'Read-only: never change, publish, send, spend or delete anything.'

export const PLAYBOOKS: readonly PlaybookDef[] = [
  {
    id: 'ads-watch',
    short: 'Ads watch',
    name: 'Ads watch & creative refresh',
    thing: 'your ads',
    summary: 'Checks your ads every day, flags the ones losing money, and suggests fresh creatives based on what performs.',
    cron: '0 9 * * *',
    cadence: 'Every day at 9:00',
    dept: 'marketing',
    money: true,
    defaultLevel: 1,
    plan: {
      1: 'Daily check of spend, clicks, sign-ups and rejected ads. Flags problems (no sign-ups after $30, click rate under 1%, rejected ads, few clicks reaching the landing page, a silent pixel) and names up to 3 moves.',
      2: 'Everything in Level 1, then up to 3 moves as approval cards: pause a losing ad, try a new creative variant built from what performs. Nothing changes until you approve.',
      3: 'Pauses clear losers and swaps in new creative variants itself, inside the hard limits. Budget changes only when you raised it to Level 3 yourself.'
    },
    limits: ['Never creates new campaigns', 'Never changes a campaign’s goal', 'Never goes over the total budget cap', 'Never touches campaigns it was not set up for', 'No new spend without your yes'],
    defaultLimits: { maxChanges: 3, budgetCapUsd: 50 },
    cost: 'One short run a day on your agent plan. It spends nothing by itself.',
    because: 'Ads were launched or changed',
    topic: 'ads',
    needs: { connections: ADS_CONNECTION, label: 'your ads account (Meta Ads, Google Ads…)', connectId: 'meta-ads' },
    signals: {
      tools: /meta[_-]?ads|facebook[_-]?ads|fb[_-]?ads|google[_-]?ads|adwords|tiktok[_-]?ads|linkedin[_-]?ads|ads?[_-]?manager|(^|_)create_?ad(_?set|_?creative)?($|_)|(^|_)ad_?sets?($|_)|adcreative|marketing[_-]?api|pipeboard/i,
      connections: ADS_CONNECTION,
      // "ads" words, never a bare "campaign" (an email campaign is not an ad) or "CTR" (a typo fix is not ads work)
      text: /\b(launch(ed|ing)?|ran|running|set up|started|created|published|went live with|drafted|wrote|built)\b[^.]{0,60}\b(ads|an ad|the ad|ad campaigns?|ad sets?|ad creatives?|(meta|facebook|instagram|google|tiktok|linkedin) ads?)\b|\b(ad spend|ad budget|ad creatives?|cost per (click|sign-?up|lead)|roas)\b/i,
      departments: ['marketing']
    }
  },
  {
    id: 'social-rhythm',
    short: 'Social posting',
    name: 'Social posting rhythm',
    thing: 'your social posts',
    summary: 'Keeps your posting rhythm: drafts the next posts from what got the most reach and checks how the last ones did.',
    cron: '0 10 * * 1,3,5',
    cadence: 'Mon, Wed and Fri at 10:00',
    dept: 'marketing',
    money: false,
    defaultLevel: 2,
    plan: {
      1: 'Checks how the last posts did (reach, likes, comments) and says what worked.',
      2: 'Checks the last posts, then drafts the next 2 or 3 in your brand voice for your OK. Nothing is published until you approve.',
      3: 'Publishes approved-style posts on the channels you allowed, at most 3 a week, and lists every link.'
    },
    limits: ['At most 3 posts a week', 'Only channels you connected', 'Never replies to or messages people', 'Never deletes posts'],
    defaultLimits: { maxChanges: 3 },
    cost: 'One short run three times a week on your agent plan.',
    because: 'Posts were published',
    topic: 'social posts',
    caps: { kinds: ['publish'], max: 3, days: 7, line: 'At most 3 posts a week' },
    signals: {
      // social servers only: never a bare "threads" (Gmail and Slack threads) or a blog's create_post
      tools: /instagram|linkedin(?![_-]?ads)|twitter|(^|_)x_post|tweet|tiktok(?![_-]?ads)|(^|_)threads_?(publish|post|create)|mcp__threads__|buffer|hootsuite|facebook_?page/i,
      connections: /^(instagram|linkedin|x|twitter|tiktok|threads|buffer)$|INSTAGRAM_|LINKEDIN_ACCESS|X_ACCESS_TOKEN|TIKTOK_ACCESS/i,
      text: /\b(published|posted|drafted|scheduled|wrote)\b[^.]{0,50}\b(posts?|tweets?|reels?|carousels?|threads?)\b|\bsocial (media|posts?|calendar)\b/i,
      departments: ['marketing']
    }
  },
  {
    id: 'site-watch',
    short: 'Site watch',
    name: 'Site watch',
    thing: 'your site',
    summary: 'Checks your site every day: is it up, is it fast, are the SEO basics right, and do sign-ups and purchases still fire.',
    cron: '30 8 * * *',
    cadence: 'Every day at 8:30',
    dept: 'development',
    money: false,
    defaultLevel: 1,
    plan: {
      1: 'Daily check: uptime, page speed, broken links, titles and descriptions, and whether conversion events (sign-up, purchase) still fire. Reports what broke.',
      2: 'Everything in Level 1, then proposes fixes as tasks for your OK.',
      3: 'Files the fixes as tasks for the team and starts the small, safe ones (copy, meta tags) on a branch for review. Never deploys.'
    },
    limits: ['Never deploys or publishes', 'Never changes DNS, domains or billing', 'Changes only go through pull requests you review'],
    defaultLimits: { maxChanges: 3 },
    cost: 'One short run a day on your agent plan.',
    because: 'A site or landing page was deployed',
    topic: 'the site',
    signals: {
      tools: /vercel|netlify|cloudflare[_-]?pages|render\.com|fly(?:ctl)?\b|firebase[_-]?deploy|deploy/i,
      connections: /^(vercel|netlify|cloudflare|render|supabase)$|VERCEL_TOKEN|NETLIFY_AUTH/i,
      text: /\b(deployed|launched|shipped|went live|put live|published)\b[^.]{0,50}\b(site|landing( page)?|website|web ?page|home ?page)\b|\blanding page\b[^.]{0,40}\b(live|deployed)\b/i,
      departments: ['development', 'marketing']
    }
  },
  {
    id: 'release-digest',
    short: 'Release notes',
    name: 'Release notes & PR digest',
    thing: 'your releases',
    summary: 'Every week, turns merged pull requests into plain release notes and lists what still waits for review.',
    cron: '0 16 * * 5',
    cadence: 'Fridays at 16:00',
    dept: 'development',
    money: false,
    defaultLevel: 1,
    plan: {
      1: 'Writes the week’s release notes from merged pull requests and lists open ones waiting for review.',
      2: 'Everything in Level 1, then drafts a changelog entry and a customer update for your OK.',
      3: 'Adds the changelog entry on a branch as a pull request for your review. Never merges or announces.'
    },
    limits: ['Never merges, closes or comments on pull requests', 'Never announces anything outside the company'],
    defaultLimits: { maxChanges: 3 },
    cost: 'One run a week on your agent plan.',
    because: 'Pull requests were merged',
    topic: 'releases',
    signals: {
      tools: /merge_?pull_?request|pr_?merge|gh pr merge|pulls?\.merge/i,
      connections: /^(github|gitlab)$/i,
      text: /\b(merged|merging)\b[^.]{0,40}\b(pr|prs|pull requests?)\b|\b(pr|pull request)s?\b[^.]{0,30}\bmerged\b|\brelease notes?\b|\bchangelog\b/i,
      departments: ['development']
    }
  },
  {
    id: 'support-triage',
    short: 'Support triage',
    name: 'Support triage',
    thing: 'your support inbox',
    summary: 'Sorts new customer questions every weekday, drafts replies for your OK and flags anything urgent.',
    cron: '0 10 * * 1-5',
    cadence: 'Weekdays at 10:00',
    dept: 'support',
    money: false,
    defaultLevel: 2,
    plan: {
      1: 'Sorts new questions by urgency and topic and flags anything urgent (an outage, a refund, an angry customer).',
      2: 'Everything in Level 1, then a draft reply for each one, waiting for your OK. You send them.',
      3: 'Sends replies to simple, known questions (opening hours, how-to links) itself and leaves the rest as drafts.'
    },
    limits: ['Never issues refunds or credits', 'Never promises anything that costs money', 'Never deletes conversations', 'Hard cases always wait for you'],
    defaultLimits: { maxChanges: 5 },
    cost: 'One short run each weekday on your agent plan.',
    because: 'A support inbox was used',
    topic: 'customer support',
    signals: {
      tools: /zendesk|intercom|help_?scout|freshdesk|mcp__front(app)?__|crisp|gorgias|support_?ticket/i,
      connections: /^(zendesk|intercom|helpscout|help-scout|front|freshdesk|crisp|gorgias)$/i,
      text: /\b(support (inbox|tickets?|requests?|emails?)|customer (emails?|questions?|tickets?)|replied to (a )?customers?|help ?desk)\b/i,
      departments: ['support']
    }
  },
  {
    id: 'revenue-brief',
    short: 'Revenue brief',
    name: 'Revenue brief',
    thing: 'your revenue',
    summary: 'Every Monday, a one-screen money brief from Stripe: revenue, new and lost customers, failed payments.',
    cron: '0 8 * * 1',
    cadence: 'Mondays at 8:00',
    dept: 'finance',
    money: false,
    defaultLevel: 1,
    plan: {
      1: 'Weekly brief: revenue, new and cancelled subscriptions, failed payments, and what changed since last week.',
      2: 'Everything in Level 1, then proposes follow-ups (a failed-payment reminder, a churn interview) as tasks for your OK.',
      3: 'Files the follow-ups as tasks for the team. Never touches payments.'
    },
    limits: [RO.replace('Read-only: never', 'Never'), 'Never issues refunds, changes prices or subscriptions'],
    defaultLimits: { maxChanges: 3 },
    cost: 'One run a week on your agent plan.',
    because: 'Stripe was used',
    topic: 'revenue',
    needs: { connections: /^stripe$|stripe|STRIPE_(SECRET|API|RESTRICTED)/i, label: 'Stripe', connectId: 'stripe' },
    signals: {
      tools: /stripe/i,
      connections: /^stripe$|STRIPE_(SECRET|API|RESTRICTED)/i,
      // never a bare "subscriptions" (a subscriptions page is not a revenue question)
      text: /\b(stripe|mrr|arr|monthly (recurring )?revenue|subscription revenue|churn(ed)?|failed payments?)\b/i,
      departments: ['finance']
    }
  },
  {
    id: 'outreach-followups',
    short: 'Outreach follow-ups',
    name: 'Outreach follow-ups',
    thing: 'your outreach',
    summary: 'Every weekday, checks who replied to your outreach, drafts follow-ups for the ones who did not, and flags warm leads.',
    cron: '30 10 * * 1-5',
    cadence: 'Weekdays at 10:30',
    dept: 'sales',
    money: false,
    defaultLevel: 2,
    plan: {
      1: 'Lists replies, warm leads and who is due a follow-up.',
      2: 'Everything in Level 1, then drafts each follow-up for your OK. You send them.',
      3: 'Sends the second follow-up to people who did not reply, at most 20 a day, never a third.'
    },
    limits: ['At most 20 messages a day', 'Never writes to anyone who asked to stop', 'Never more than two follow-ups per person', 'Never buys lists or tools'],
    defaultLimits: { maxChanges: 5 },
    cost: 'One short run each weekday on your agent plan.',
    because: 'Outreach was sent',
    topic: 'outreach',
    caps: { kinds: ['send'], max: 20, days: 1, line: 'At most 20 messages a day' },
    signals: {
      // outreach tools only: one email sent or drafted is not an outreach campaign
      tools: /apollo|lemlist|instantly|hunter|smartlead|mcp__outreach/i,
      connections: /^(apollo|lemlist|instantly|hunter|smartlead)$/i,
      text: /\b(outreach|cold (emails?|messages?|outreach)|prospects?|leads? list|follow[- ]ups? (to|with|for) (leads|prospects))\b/i,
      departments: ['sales']
    }
  }
]
export const playbookDef = (id: PlaybookId): PlaybookDef => PLAYBOOKS.find((p) => p.id === id)!

// ---------- levels and limits, enforced here ----------

/** The highest level a playbook may run at: a money playbook stays at Level 2 until the founder raises it. */
export function maxLevel(def: Pick<PlaybookDef, 'money'>, raised: boolean): PlaybookLevel {
  return def.money && !raised ? 2 : 3
}
/** Null when `level` is allowed, else the refusal in plain words. */
export function levelRefusal(def: Pick<PlaybookDef, 'money' | 'name'>, level: number, raised: boolean): string | null {
  if (!isPlaybookLevel(level)) return 'Pick Level 1, 2 or 3'
  if (level > maxLevel(def, raised)) return `${def.name} moves money, so it stays at Level 2 or below unless you raise it to Level 3 yourself`
  return null
}

/** Limits as given, filled and clamped (money playbooks always keep a budget cap). */
export function playbookLimits(def: Pick<PlaybookDef, 'money' | 'defaultLimits'>, raw?: Partial<PlaybookLimits> | null): PlaybookLimits {
  const n = Number(raw?.maxChanges)
  const maxChanges = Number.isFinite(n) ? Math.min(LIMIT_RANGES.maxChanges.max, Math.max(LIMIT_RANGES.maxChanges.min, Math.round(n))) : def.defaultLimits.maxChanges
  if (!def.money) return { maxChanges }
  const b = Number(raw?.budgetCapUsd)
  const budgetCapUsd = Number.isFinite(b) && b > 0 ? Math.min(LIMIT_RANGES.budgetCapUsd.max, Math.max(LIMIT_RANGES.budgetCapUsd.min, Math.round(b))) : (def.defaultLimits.budgetCapUsd ?? 50)
  return { maxChanges, budgetCapUsd, targets: parseTargets(raw?.targets) }
}

/**
 * "Up to 3 changes a run · total budget cap $50 a day". Level 1 changes nothing, so it reads "Up to 3 suggestions a
 * run"; Level 2 proposes ("Up to 3 changes for your OK a run").
 */
export function limitsLine(def: Pick<PlaybookDef, 'money'> & Partial<Pick<PlaybookDef, 'caps'>>, l: PlaybookLimits, level: PlaybookLevel = 3): string {
  const n = l.maxChanges
  const parts = [level === 1 ? `Up to ${n} suggestion${n === 1 ? '' : 's'} a run` : level === 2 ? `Up to ${n} change${n === 1 ? '' : 's'} for your OK a run` : `Up to ${n} change${n === 1 ? '' : 's'} a run`]
  if (level === 3 && def.caps) parts.push(def.caps.line.replace(/^At most/, 'at most'))
  if (def.money && l.budgetCapUsd) parts.push(`total budget cap $${l.budgetCapUsd} a day`)
  if (def.money && level === 3) {
    const n = l.targets?.length ?? 0
    parts.push(n ? `changes only the ${n} campaign${n === 1 ? '' : 's'} or ad set${n === 1 ? '' : 's'} you listed` : 'no campaigns listed yet, so it changes nothing')
  }
  return parts.join(' · ')
}

/** "$10/day", "$10 a day", "10 USD per day" in the work: the daily budget the founder chose (the offer's cap). */
export function dailyBudgetIn(texts: readonly string[]): number | null {
  for (const t of texts) {
    const m = /(?:\$|usd\s?)\s?(\d{1,6}(?:\.\d{1,2})?)\s?(?:usd\s?)?(?:\/|per|a|each)\s?day\b|(\d{1,6}(?:\.\d{1,2})?)\s?(?:usd|dollars)\s?(?:\/|per|a|each)\s?day\b/i.exec(t)
    const n = m ? Number(m[1] ?? m[2]) : NaN
    if (Number.isFinite(n) && n >= LIMIT_RANGES.budgetCapUsd.min && n <= LIMIT_RANGES.budgetCapUsd.max) return Math.round(n)
  }
  return null
}

/**
 * What one tool call (or one proposed step) would do, as the guard sees it:
 * read (look), propose (an approval card), change (pause an ad, edit a draft), spend (budget, bids, buying),
 * create (a new campaign or account), publish / send (outside the company), delete.
 */
export type PlaybookActionKind = 'read' | 'propose' | 'change' | 'spend' | 'create' | 'publish' | 'send' | 'delete'
export interface PlaybookAction {
  kind: PlaybookActionKind
  /** spend: the total daily budget the playbook's runs set today, this call included, in dollars, when known */
  amountUsd?: number
  /** spend: why the amount is not known (a unit Principia does not know, an amount it cannot read) */
  unclear?: string
  /** a money playbook's tool that is not known to only read (not on the read list, not marked read-only) */
  unknown?: boolean
  /** the campaign (or thing) it acts on is not one this playbook was set up for */
  other?: boolean
  /** why `other`: none listed, the call names none, or it names one not listed (plain words) */
  otherWhy?: string
  /** money playbooks: it changes a campaign's goal (objective, optimisation goal, bid strategy) */
  goal?: boolean
  /** money playbooks: it turns a campaign, ad set or ad back on (that restarts its spend) */
  activates?: boolean
  /** money playbooks: a tool that passes any request straight to the ads account (Principia cannot check it) */
  generic?: boolean
  /** writes (change, spend, create, publish, send) this run already made, this one not included */
  runCount?: number
  /** the cap's kinds (`caps`) already done inside its window, this one not included */
  windowCount?: number
}
export interface PlaybookGuardRecord {
  level: PlaybookLevel
  raised: boolean
  limits: PlaybookLimits
}
export type GuardVerdict = { allowed: true } | { allowed: false; reason: string }
const no = (reason: string): GuardVerdict => ({ allowed: false, reason })

/** The one place that says yes or no to what a playbook's run may do. Refusals are plain words for the founder. */
export function guardAction(def: Pick<PlaybookDef, 'money' | 'id' | 'name'> & Partial<Pick<PlaybookDef, 'caps'>>, rec: PlaybookGuardRecord, a: PlaybookAction): GuardVerdict {
  // a stored level above what the playbook allows (an edited row, an older build) counts as the allowed maximum
  const level = Math.min(rec.level, maxLevel(def, rec.raised)) as PlaybookLevel
  if (a.kind === 'read') return { allowed: true }
  if (a.kind === 'delete') return no('A playbook never deletes anything')
  if (a.generic) return no(`${def.name} never uses a tool that passes requests straight to the ads account: Principia cannot check what it would do`)
  if (a.goal) return no('A playbook never changes a campaign’s goal or bid strategy')
  if (a.activates) return no('Turning a campaign, ad set or ad back on restarts its spend, so a playbook never does it by itself')
  if (a.other) return no(a.otherWhy ?? `${def.name} only touches what it was set up for`)
  if (a.kind === 'propose') return level >= 2 ? { allowed: true } : no('Level 1 only watches and reports')
  // a money playbook below Level 3 only uses tools Principia knows only read
  if (a.unknown && level < 3) return no(`At Level ${level}, ${def.name} only uses tools Principia knows only read, and this one may change something`)
  // counted limits: changes per run, and the playbook's own cap (posts a week, messages a day)
  if (WRITES.includes(a.kind) && level >= 3) {
    if ((a.runCount ?? 0) >= rec.limits.maxChanges) return no(`That is more than ${rec.limits.maxChanges} change${rec.limits.maxChanges === 1 ? '' : 's'} in one run`)
    if (def.caps && def.caps.kinds.includes(a.kind) && (a.windowCount ?? 0) >= def.caps.max) return no(`${def.caps.line}, and that limit is reached`)
  }
  if (a.kind === 'create') return def.money ? no('A playbook never creates new campaigns') : level >= 3 ? { allowed: true } : no(`Level ${level} does not create anything`)
  if (a.kind === 'spend') {
    if (!def.money) return no('This playbook never spends money')
    if (level < 3 || !rec.raised) return no('No new spend without your yes: this playbook is at Level ' + level)
    const cap = rec.limits.budgetCapUsd ?? 0
    if (a.unclear) return no(a.unclear)
    if (a.amountUsd === undefined || !Number.isFinite(a.amountUsd)) return no('A budget change needs a known amount to check against the cap')
    if (a.amountUsd > cap) return no(`That would bring the total daily budget it has set to ${usd(a.amountUsd)}, over the total budget cap of $${cap} a day`)
    return { allowed: true }
  }
  if (a.kind === 'publish' || a.kind === 'send' || a.kind === 'change') return level >= 3 ? { allowed: true } : no(`Level ${level} ${level === 1 ? 'only watches and reports' : 'proposes changes for your OK'}`)
  return no('Not something a playbook does')
}

/** Kinds that count against a run's `maxChanges`. */
const WRITES: readonly PlaybookActionKind[] = ['change', 'spend', 'create', 'publish', 'send']
export const WRITE_KINDS = WRITES

/** "$900", "$12.50" */
export const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/**
 * Tools of ads connections known to only read (Meta through its own server or Pipeboard, Google Ads, TikTok, LinkedIn).
 * On a money playbook, a tool reads only when it is on this list or its server marks it read-only (readOnlyHint):
 * a name that merely starts with get_ or check_ is not enough (`get_or_create_campaign`, `check_and_fix_delivery`).
 */
export const KNOWN_READ_TOOLS: ReadonlySet<string> = new Set([
  // Meta (Marketing API servers)
  'get_ad_accounts', 'get_account_info', 'get_account_pages', 'get_campaigns', 'get_campaign_details', 'get_adsets', 'get_adset_details',
  'get_ads', 'get_ad_details', 'get_ad_creatives', 'get_creative_details', 'get_ad_image', 'get_ad_video', 'get_insights', 'get_ad_insights',
  'get_campaign_insights', 'get_adset_insights', 'get_account_insights', 'list_ad_accounts', 'list_campaigns', 'list_adsets', 'list_ad_sets',
  'list_ads', 'list_ad_creatives', 'list_creatives', 'search_ads_archive', 'search_interests', 'get_interest_suggestions', 'validate_interests',
  'search_behaviors', 'search_demographics', 'search_geo_locations', 'estimate_audience_size', 'get_reach_estimate', 'get_delivery_estimate',
  'get_pixel_events', 'get_pixels', 'list_pixels', 'get_custom_audiences', 'list_custom_audiences',
  // Google Ads
  'list_accessible_customers', 'get_customer', 'search', 'search_stream', 'execute_gaql', 'run_gaql', 'get_campaign_performance',
  'get_ad_performance', 'get_keyword_performance', 'list_ad_groups', 'get_ad_groups',
  // TikTok / LinkedIn
  'get_advertisers', 'get_report', 'get_reports', 'get_ad_groups_report', 'get_campaign_report', 'list_ad_accounts_linkedin', 'get_analytics'
])

const READ_PREFIX = /^(read|get|list|search|query|fetch|find|describe|lookup|look_up|view|show|check|count|estimate|preview|inspect|export|download|insights?|reports?|stats?|analytics?|metrics?)(_|$)|(^|_)insights?$|^(task_report|task_comment|task_list|team_|memory_search|memory_get|principia_list_tools|connections_list)|^(grep|glob|ls|webfetch|websearch|toolsearch|todowrite)$/
const DELETE_WORDS = /(^|_)(delete|remove|destroy|archive|wipe|trash|purge|unpublish|revoke|cancel|disconnect|detach|unlink)(_|$)/
const MONEY_WORDS = /budget|(^|_)bids?(_|$)|bid_?amount|spend|charge|(^|_)pay(ment)?s?(_|$)|purchase|(^|_)buy|top_?up|billing|refund|invoice|cost_?cap/
const NEW_SPEND = /create_?(campaign|ad_?set|account)|new_?(campaign|ad_?set)|(^|_)(duplicate|clone)(_|$)|(^|_)copy_(campaign|ad_?set|ad)(_|$)|_or_create/
const PUBLISH_WORDS = /publish|post_?(to|status|media|photo|video|reel)|create_?(post|tweet|reel|story)|tweet|(^|_)share(_|$)|repost|upload|go_?live/
const SEND_WORDS = /send|reply|message|email|(^|_)dm(_|$)|invite/
const CREATE_WORDS = /(^|_)(create|new|add|insert|make|generate|register|launch|provision|spawn)(_|$)/
/** Words that make any tool a change, wherever they stand in its name (`insights_update`, `check_and_fix_delivery`). */
const CHANGE_WORDS = /(^|_)(update|updates|set|edit|modify|change|fix|apply|upsert|patch|put|write|save|assign|unassign|toggle|pause|resume|enable|disable|activate|deactivate|start|stop|schedule|submit|approve|reject|move|rename|replace|adjust|increase|decrease|raise|lower|scale|boost|sync|import|mark|link|attach|connect|run|execute|trigger|restore|reset|optimi[sz]e|rebalance|allocate|bump|turn|swap|refresh|rotate|retry|mutate|configure|install)(_|$)/

const norm = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-.\s]+/g, '_')

/**
 * The kind of a tool call, from its name alone. Deterministic and conservative: a name that carries a write word
 * anywhere is a write, whatever it starts with (`get_or_create_campaign` creates, `insights_update` changes,
 * `check_and_fix_delivery` changes); a name reads only when it starts with a read verb and carries no write word; and
 * anything else Principia cannot place counts as a change, never as a read.
 */
export function classifyTool(name: string): PlaybookActionKind {
  const n = norm(name)
  if (KNOWN_READ_TOOLS.has(n)) return 'read'
  const writes = DELETE_WORDS.test(n) || NEW_SPEND.test(n) || PUBLISH_WORDS.test(n) || (SEND_WORDS.test(n) && !/draft/.test(n)) || CREATE_WORDS.test(n) || CHANGE_WORDS.test(n)
  if (READ_PREFIX.test(n) && !writes) return 'read'
  if (DELETE_WORDS.test(n)) return 'delete'
  // a new campaign or ad set, or a copy of one (or "get or create" one), is new spend: never by an autopilot
  if (NEW_SPEND.test(n)) return 'create'
  if (MONEY_WORDS.test(n)) return 'spend'
  if (PUBLISH_WORDS.test(n)) return 'publish'
  if (SEND_WORDS.test(n) && !/draft/.test(n)) return 'send'
  if (CREATE_WORDS.test(n)) return 'create'
  return 'change'
}
/** The name carries a write word (a read-only mark from the server never outweighs it). */
const namedWrite = (name: string): boolean => {
  const n = norm(name)
  return !KNOWN_READ_TOOLS.has(n) && (DELETE_WORDS.test(n) || NEW_SPEND.test(n) || PUBLISH_WORDS.test(n) || SEND_WORDS.test(n) || CREATE_WORDS.test(n) || CHANGE_WORDS.test(n) || MONEY_WORDS.test(n))
}

/** Principia's own servers (the board, memory, the Forum, the connections gateway): never a change to the outside. */
const OWN_SERVER = /^mcp__(hive|hivemem|principia|principia[-_]forum)__/i
/**
 * Tool calls a playbook's guard checks: every tool of an outside MCP server, whatever the connection is called (an ads
 * server named "meta" or "pipeboard" counts as much as "meta_ads"). Built-in tools (Read, Edit, Bash…) and Principia's
 * own servers are not changes to the outside. Calls through the connections gateway are checked before they happen.
 */
export const guardedTool = (name: string): boolean => /^mcp__.+__.+/.test(name) && !OWN_SERVER.test(name)

// ---------- what a call's arguments say ----------

/** Keys that carry money (a budget, a bid, a spend cap, an amount): the call is money whatever the tool is called. */
const MONEY_KEY = /budget|(^|_)bids?($|_)|bid_?amount|bid_?cap|spend|amount|cost_?cap|(^|_)price($|_)/
/** Bid targets and pacing (target CPA, ROAS, max CPC, bid strategy, pacing): money with no dollar amount to add up. */
const RATE_KEY = /(^|_)(target_)?(cpa|roas|cpc|cpm|cpv|cpl)($|_)|max_?cpc|(^|_)pacing($|_)|bid_?(strategy|type|constraints?)|bidding/
/** Keys that change what a campaign is for: never changed by a playbook. */
const GOAL_KEY = /^(objective|campaign_objective|optimi[sz]ation_goal|billing_event|conversion_goals?|promoted_object|goal|conversion_event|custom_event_type|destination_type|optimi[sz]ation_event)$/
/** Keys that change when a campaign runs (a lifetime budget's end moves its daily spend). */
const SCHEDULE_KEY = /^(end_time|stop_time|end_date|time_stop|end_date_time|schedule_end_time|run_until)$/
/** Keys that switch something (a campaign's status): the call is a change whatever the tool is called. */
const STATUS_KEY = /(^|_)(status|state|effective_status|configured_status|enabled|paused|active)$/
/** A status value that turns spend back on. */
const ACTIVE_VALUE = /^(active|enabled?|on|resumed?|running|live|unpaused|serving)$/i
/**
 * The thing a budget is set on, most specific first. An account, customer or business id is never a target: two ad
 * sets of one account are two things (`{account_id, adset_id}`).
 */
const TARGET_KEYS = ['ad_id', 'creative_id', 'adset_id', 'ad_set_id', 'ad_group_id', 'adgroup_id', 'campaign_budget_id', 'budget_id', 'campaign_id', 'resource_name', 'object_id', 'adset', 'ad_set', 'campaign', 'id'] as const
/** Ids the founder's list is checked against (account, customer and creative ids are not things a playbook is set up for). */
const SCOPE_KEY = /^(ad|adset|ad_set|ad_group|adgroup|campaign|campaign_budget|budget)_ids?$|^resource_names?$/
/** Lists whose items' bare `id` is a campaign, ad set or ad (`adsets: [{id, daily_budget}]`). */
const SCOPE_LIST = /^(ads|adsets|ad_sets|ad_groups|adgroups|campaigns|budgets|campaign_budgets)$/
/** In a field list (`{name: 'daily_budget', value: 900}`), the keys that name the field and that hold its value. */
const FIELD_NAME = ['name', 'field', 'key', 'param', 'parameter', 'path', 'attribute'] as const
const FIELD_VALUE = ['value', 'new_value', 'amount', 'to'] as const
/** A string that carries a budget as text ("daily_budget=90000", "\"bid_amount\": 50"). */
const MONEY_IN_TEXT = /\b(daily_budget|lifetime_budget|budget(_amount)?|bid_amount|bid|spend_cap|amount(_micros)?|target_cpa\w*|target_roas)\b\s*["']?\s*[=:]\s*["']?\s*-?\d/i
const FORM = /^[\w.[\]%-]+=[^&]*(&[\w.[\]%-]+=[^&]*)*$/
const MAX_DEPTH = 8
const MAX_NODES = 2000

/** One budget amount a call sets: the thing it sets it on (null = unknown, never merged with another) and dollars a day. */
export interface BudgetSet {
  target: string | null
  usd: number
}

/**
 * A known ads connector, from the server's identity (its URL, or the command and arguments that start it), never from
 * the name the founder gave the connection. Null = Principia does not know this server: it believes none of its
 * read-only marks and reads none of its amounts.
 */
export type AdsConnector = 'meta' | 'google' | 'tiktok' | 'linkedin'
const CONNECTORS: readonly [AdsConnector, RegExp][] = [
  ['meta', /meta[-_]?ads|facebook[-_]?ads|(^|[/.-])fb[-_]?ads|graph\.facebook\.com|facebook\.com\/(v\d|ads)/i],
  ['google', /google[-_]?ads|googleads\.googleapis\.com|adwords/i],
  ['tiktok', /tiktok[-_]?ads|business-api\.tiktok\.com/i],
  ['linkedin', /linkedin[-_]?ads|api\.linkedin\.com\/rest\/ad/i]
]
export function adsConnectorOf(server: { url?: string | null; command?: string | null; args?: readonly string[] | null }): AdsConnector | null {
  const id = [server.url ?? '', server.command ?? '', ...(server.args ?? [])].join(' ')
  const hits = CONNECTORS.filter(([, re]) => re.test(id))
  // one server, one connector: a server that matches two (a "meta and google ads" bundle) is not known
  return hits.length === 1 ? hits[0]![0] : null
}

/** The money unit of a connection's budgets. Meta takes cents (daily_budget 1000 = $10), Google micros. */
export type MoneyUnit = 'usd' | 'cents' | 'micros'
/**
 * The unit a budget key is in: the key's own word first (`_cents`, `_micros`), else the known connector's unit (Meta:
 * cents; TikTok and LinkedIn: whole currency units; Google only ever in micros). Null = unknown: the call is refused
 * rather than guessed.
 */
export function moneyUnit(connector: AdsConnector | null | undefined, key: string): MoneyUnit | null {
  const k = norm(key)
  if (/micros?/.test(k)) return 'micros'
  if (/cents|minor/.test(k)) return 'cents'
  if (connector === 'meta') return 'cents'
  if (connector === 'tiktok' || connector === 'linkedin') return 'usd'
  return null
}
const toUsd = (n: number, unit: MoneyUnit): number => (unit === 'cents' ? n / 100 : unit === 'micros' ? n / 1_000_000 : n)

export interface CallArgsFacts {
  /** a money key is somewhere in the arguments (any depth, arrays, JSON text and field lists included) */
  money: boolean
  /** a status key is somewhere in the arguments */
  status: boolean
  /** a status key other than `effective_status` (which an ads account only ever reads: a filter) */
  statusSet: boolean
  /** a status is set to on (ACTIVE, ENABLED, paused: false): spend restarts */
  activates: boolean
  /** a goal, objective or bid strategy is set */
  goal: boolean
  /** a campaign's end is moved (a lifetime budget's daily spend changes) */
  schedule: boolean
  /** every campaign, ad set, ad or budget id the call names (account and customer ids left out) */
  ids: string[]
  /** every amount the call sets, in dollars */
  sets: BudgetSet[]
  /** why an amount cannot be read (a unit Principia does not know, a value it cannot read, arguments too deep) */
  unclear: string | null
}

const numeric = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^\s*\$?\s*\d{1,12}(\.\d+)?\s*$/.test(v)) return Number(v.replace(/[$\s]/g, ''))
  return null
}
/** A budget key without its unit word: `daily_budget_cents` and `daily_budget` are one budget. */
const budgetSlot = (key: string): string => norm(key).replace(/_(cents|micros?|minor|amount|amount_micros|value)$/, '')

/**
 * Reads a call's arguments at any depth, arrays and nested objects included (`adsets: [{daily_budget: 900}]`), JSON
 * or form text inside a string (`params: '{"daily_budget":90000}'`) and field lists (`{name: 'daily_budget', value:
 * 900}`): whether they carry money, a status, a goal, which ids they name, and every amount they set, converted to
 * dollars with the connector's unit. An amount that cannot be read, in a unit Principia does not know, with no thing it
 * is set on, or too deep makes the whole call unclear (refused).
 */
export function readCallArgs(args: unknown, connector: AdsConnector | null = null): CallArgsFacts {
  const out: CallArgsFacts = { money: false, status: false, statusSet: false, activates: false, goal: false, schedule: false, ids: [], sets: [], unclear: null }
  let nodes = 0
  const unclear = (why: string): void => {
    out.unclear ??= why
  }
  const idOf = (o: Record<string, unknown>): string | null => {
    const keys = new Map(Object.entries(o).map(([k, v]) => [norm(k), v] as const))
    for (const k of TARGET_KEYS) {
      const v = keys.get(k)
      if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim().slice(0, 120)
    }
    return null
  }
  /** the ids a call acts on: campaign, ad set, ad and budget ids at any depth; a bare `id` only of the call itself or of a listed campaign, ad set or ad */
  const noteIds = (o: Record<string, unknown>, depth: number, parentKey: string | null): void => {
    for (const [k, v] of Object.entries(o)) {
      const key = norm(k)
      const scoped = SCOPE_KEY.test(key) || (key === 'id' && (depth === 0 || (parentKey !== null && SCOPE_LIST.test(parentKey))))
      if (!scoped) continue
      for (const x of Array.isArray(v) ? v : [v]) if ((typeof x === 'string' || typeof x === 'number') && String(x).trim() && out.ids.length < 200) out.ids.push(String(x).trim().slice(0, 120))
    }
  }
  /** a money key's value: a number, or an object/array holding numbers (LinkedIn's {amount, currencyCode}) */
  const amount = (key: string, v: unknown, target: string | null, depth: number): void => {
    if (RATE_KEY.test(norm(key))) return unclear('Principia does not change bid targets, bid strategies or pacing by itself')
    const n = numeric(v)
    if (n !== null) {
      const unit = moneyUnit(connector, key)
      if (!unit) return unclear('Principia does not know whether this ads connection counts budgets in dollars, cents or micros, so it changes no budget through it')
      // with no campaign or ad set it is for, it cannot be added up: refused, but the founder's line still says the amount
      if (!target) unclear('A budget change needs the campaign or ad set it is for, so Principia can add it to the total')
      out.sets.push({ target: target ? `${target}|${budgetSlot(key)}` : null, usd: toUsd(n, unit) })
      return
    }
    if (v && typeof v === 'object') {
      const before = out.sets.length
      walk(v, depth + 1, target, key)
      if (out.sets.length === before && !out.unclear) unclear('A budget change needs an amount Principia can read')
      return
    }
    if (typeof v === 'string') {
      const inner = parsedText(v)
      if (inner !== undefined) {
        const before = out.sets.length
        walk(inner, depth + 1, target, key)
        if (out.sets.length === before && !out.unclear) unclear('A budget change needs an amount Principia can read')
        return
      }
    }
    // null, true, "a lot", a negative number: never guessed
    unclear('A budget change needs an amount Principia can read')
  }
  const status = (key: string, v: unknown): void => {
    out.status = true
    if (key !== 'effective_status') out.statusSet = true
    if ((typeof v === 'string' && ACTIVE_VALUE.test(v.trim())) || (v === true && /(^|_)(enabled|active)$/.test(key)) || (v === false && /(^|_)paused$/.test(key))) out.activates = true
    // a status that cannot be read could be ACTIVE
    else if (v !== null && typeof v === 'object') out.activates = true
  }
  /** JSON or form text inside a string, as an object (undefined = plain text) */
  const parsedText = (t: string): unknown => {
    const s = t.trim()
    if (/^[[{]/.test(s)) {
      try {
        return JSON.parse(s)
      } catch {
        return undefined
      }
    }
    if (FORM.test(s) && s.includes('=')) {
      try {
        const o: Record<string, string> = {}
        for (const [k, v] of new URLSearchParams(s)) o[k] = v
        return o
      } catch {
        return undefined
      }
    }
    return undefined
  }
  const walk = (v: unknown, depth: number, inherited: string | null, moneyParent: string | null, parentKey: string | null = null): void => {
    // arguments too deep or too large to read could hide a budget: they count as money, with no amount it can read
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      out.money = true
      return unclear('The call’s arguments are too large for Principia to check')
    }
    if (typeof v === 'string') {
      const inner = parsedText(v)
      if (inner !== undefined && typeof inner === 'object') return walk(inner, depth, inherited, moneyParent, parentKey)
      if (MONEY_IN_TEXT.test(v)) {
        out.money = true
        unclear('The call carries a budget as text Principia cannot read')
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, inherited, moneyParent, parentKey)
      return
    }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    noteIds(o, depth, parentKey)
    // the thing a budget is set on is named in the same object, else the nearest object above that names one
    const target = idOf(o) ?? inherited
    // a field list entry: {name: 'daily_budget', value: 900} (a filter, with an operator, is a read)
    const fieldKey = FIELD_NAME.map((k) => o[k]).find((x): x is string => typeof x === 'string')
    const valueKey = FIELD_VALUE.find((k) => k in o)
    if (fieldKey && valueKey && !('operator' in o) && !('op' in o)) {
      const f = norm(fieldKey)
      if (MONEY_KEY.test(f) || RATE_KEY.test(f)) {
        out.money = true
        amount(f, o[valueKey], target, depth)
      } else if (STATUS_KEY.test(f)) status(f, o[valueKey])
      else if (GOAL_KEY.test(f)) out.goal = true
      else if (SCHEDULE_KEY.test(f)) out.schedule = true
    }
    for (const [k, x] of Object.entries(o)) {
      const key = norm(k)
      if (MONEY_KEY.test(key) || RATE_KEY.test(key)) {
        out.money = true
        amount(moneyParent && /^(amount|value|micro_amount|amount_micros)$/.test(key) ? `${moneyParent}_${key}` : key, x, target, depth)
        continue
      }
      if (STATUS_KEY.test(key)) status(key, x)
      if (GOAL_KEY.test(key)) out.goal = true
      if (SCHEDULE_KEY.test(key)) out.schedule = true
      if (x && (typeof x === 'object' || typeof x === 'string')) walk(x, depth + 1, target, moneyParent, key)
    }
  }
  walk(args, 0, null, null)
  out.ids = [...new Set(out.ids)]
  return out
}

/** The call's arguments name a budget, a bid, an amount or a spend cap, at any depth (arrays included). */
export function hasBudgetKey(args: unknown): boolean {
  return readCallArgs(args).money
}

/** The largest single amount a call sets, in dollars (null when it sets none it can read). */
export function budgetAmountUsd(args: unknown, connector: AdsConnector | null = 'meta'): number | null {
  const f = readCallArgs(args, connector)
  return f.sets.length ? Math.max(...f.sets.map((s) => s.usd)) : null
}

/**
 * The total daily budget after a call: the latest amount per thing the playbook ever set (a call that sets the same ad
 * set again replaces its earlier amount; a budget set yesterday still spends today), plus every amount whose thing is
 * unknown (never merged). Amounts of one call add up.
 */
export function budgetTotalAfter(prior: readonly BudgetSet[], next: readonly BudgetSet[]): number {
  const byTarget = new Map<string, number>()
  let loose = 0
  for (const s of prior) {
    if (s.target === null) loose += s.usd
    else byTarget.set(s.target, s.usd)
  }
  const fresh = new Map<string, number>()
  for (const s of next) {
    if (s.target === null) loose += s.usd
    else fresh.set(s.target, (fresh.get(s.target) ?? 0) + s.usd)
  }
  for (const [t, v] of fresh) byTarget.set(t, v)
  let total = loose
  for (const v of byTarget.values()) total += v
  return Math.round(total * 100) / 100
}

/** What the guard made of one call: its kind, what it would set, and the line the founder sees when it is refused. */
export interface CallFacts {
  kind: PlaybookActionKind
  unknown: boolean
  sets: BudgetSet[]
  unclear: string | null
  /** money playbooks: it changes a goal, turns spend back on, or passes requests straight through */
  goal: boolean
  activates: boolean
  generic: boolean
  /** the campaign, ad set, ad or budget ids it names */
  ids: string[]
  /** the total daily budget the playbook has set with this call, when it sets money */
  totalUsd?: number
}

/** Tools that pass any request straight to the ads account ("api_request", "graphql", "batch"): never a playbook's. */
const GENERIC = /(^|_)(request|requests|call|api|graphql|passthrough|pass_through|proxy|raw|http|https|invoke|batch|execute|exec|query|mutate|rpc|curl|endpoint)(_|$)/
/** Names that turn spend back on (`resume_campaign`, `enable_ad_set`). */
const ACTIVATE_NAME = /(^|_)(resume|enable|activate|reactivate|unpause|start|restart|unarchive|turn_on|relaunch|launch)(_|$)/

/**
 * The kind of one call, from its name and its arguments together:
 * - arguments that carry a budget, bid, spend or amount (at any depth) make it money (`spend`), whatever its name;
 *   a status key makes it a change;
 * - a write word anywhere in its name makes it a write (`get_or_create_campaign` creates);
 * - on a money playbook, it reads only when the server is a known ads connector and the tool is a known read
 *   (`KNOWN_READ_TOOLS`) or that server marks it read-only; anything else is `unknown` (refused below Level 3);
 * - on a money playbook, a goal change, turning spend back on and a pass-through tool are flagged (refused at every
 *   level).
 */
export function classifyCall(
  def: Pick<PlaybookDef, 'money'>,
  call: { tool: string; args?: unknown; connection?: string; connector?: AdsConnector | null; readOnly?: boolean; trustNames?: boolean }
): Omit<CallFacts, 'totalUsd'> {
  const bare = bareToolName(call.tool)
  const n = norm(bare)
  const connector = call.connector ?? null
  const a = readCallArgs(call.args, connector)
  // a money playbook believes the read list and read-only marks of known ads servers only
  // (after a run, a read that already happened is not refused: `trustNames`)
  const trusted = !def.money || connector !== null || call.trustNames === true
  const knownRead = trusted && KNOWN_READ_TOOLS.has(n)
  let kind = classifyTool(bare)
  const generic = def.money && !knownRead && GENERIC.test(n)
  if (a.money && kind !== 'delete' && kind !== 'create') kind = 'spend'
  // a status on a known read of a known ads server is a filter (`get_ads {effective_status: ['ACTIVE']}`)
  else if (a.status && kind === 'read' && (!knownRead || a.statusSet)) kind = 'change'
  let unknown = false
  if (kind === 'read' && def.money && !(knownRead || (trusted && call.readOnly))) unknown = true
  // a server's read-only mark is believed only for a name with no write word and arguments with no money or status
  if (kind === 'change' && call.readOnly && trusted && !generic && !namedWrite(bare) && !a.money && !a.status) kind = 'read'
  if (unknown) kind = 'change'
  const reads = kind === 'read'
  const goal = def.money && !reads && !knownRead && a.goal
  const activates = def.money && !reads && kind !== 'delete' && (a.activates || ACTIVATE_NAME.test(n))
  let unclear = kind === 'spend' ? a.unclear ?? (a.sets.length ? null : 'A budget change needs an amount Principia can read') : null
  // moving a campaign's end moves its spend: money with no amount to add up
  if (def.money && !reads && !knownRead && a.schedule && kind !== 'delete' && kind !== 'create') {
    kind = 'spend'
    unclear ??= 'Changing when a campaign ends changes what it spends a day, so Principia does not do it by itself'
  }
  return { kind, unknown, sets: a.sets, unclear, goal, activates, generic, ids: a.ids }
}

/** `mcp__meta_ads__update_ad` → `meta_ads` */
const serverOf = (name: string): string | null => /^mcp__(.+?)__.+$/.exec(name)?.[1] ?? null
export const serverOfTool = serverOf

/**
 * Tool calls of a finished run that the playbook's level refuses, with the reason and the founder's line (the playbook
 * is paused and the founder told). `tools` is every call in order (repeats count against `maxChanges`, and a tool
 * refused more than once says how often). A call seen only after the run comes from a server Principia does not know
 * and has no arguments to read, so a budget call is refused: budget changes within the cap only pass the gateway's
 * check before the call.
 */
export function refusedTools(def: PlaybookDef, rec: PlaybookGuardRecord, tools: readonly string[], windowCount = 0): { tool: string; reason: string; line: string }[] {
  const out: { tool: string; reason: string; line: string; n: number }[] = []
  let writes = 0
  let capped = windowCount
  for (const t of tools) {
    if (!guardedTool(t)) continue
    const f = classifyCall(def, { tool: t, trustNames: true })
    const v = guardAction(def, rec, { kind: f.kind, unknown: f.unknown, goal: f.goal, activates: f.activates, generic: f.generic, runCount: writes, windowCount: capped, ...(f.unclear ? { unclear: f.unclear } : {}) })
    if (WRITES.includes(f.kind)) writes++
    if (def.caps?.kinds.includes(f.kind)) capped++
    if (v.allowed) continue
    const had = out.find((r) => r.tool === t)
    if (had) had.n++
    else out.push({ tool: t, reason: v.reason, line: refusalLine(def, t, f), n: 1 })
  }
  return out.map(({ n, ...r }) => (n > 1 ? { ...r, line: r.line.replace(/; refused\.$/, `; refused ${n} times.`) } : r))
}

/** The `other` check: at Level 3 a money playbook's change names only what it was set up for. */
function scopeRefusal(def: Pick<PlaybookDef, 'money' | 'name' | 'short'>, rec: PlaybookGuardRecord, f: Pick<CallFacts, 'kind' | 'ids'>): string | null {
  if (!def.money || !WRITES.includes(f.kind)) return null
  const level = Math.min(rec.level, maxLevel(def, rec.raised))
  if (level < 3) return null
  const targets = rec.limits.targets ?? []
  if (!targets.length) return `${def.name} has no campaigns or ad sets listed, so it changes nothing. List the ones it may change in Automations`
  if (!f.ids.length) return `The call names no campaign or ad set, so Principia cannot check it is one ${def.short} was set up for`
  const ok = (id: string) => targets.some((t) => t === id || id.endsWith(`/${t}`) || t.endsWith(`/${id}`))
  const stray = f.ids.find((id) => !ok(id))
  return stray ? `${def.name} only touches the campaigns and ad sets you listed, and ${stray.slice(0, 40)} is not one of them` : null
}

/** One call through the connections gateway, checked before it happens. `budgetSet`: what the company's playbooks set, latest per thing. */
export function guardCall(
  def: PlaybookDef,
  rec: PlaybookGuardRecord,
  call: { tool: string; connection?: string; connector?: AdsConnector | null; args?: unknown; readOnly?: boolean; runCount: number; windowCount: number; budgetSet?: readonly BudgetSet[] }
): GuardVerdict & CallFacts & { line: string } {
  const f = classifyCall(def, call)
  const totalUsd = f.kind === 'spend' && !f.unclear ? budgetTotalAfter(call.budgetSet ?? [], f.sets) : undefined
  const otherWhy = scopeRefusal(def, rec, f)
  const v = guardAction(def, rec, {
    kind: f.kind,
    unknown: f.unknown,
    goal: f.goal,
    activates: f.activates,
    generic: f.generic,
    ...(otherWhy ? { other: true, otherWhy } : {}),
    runCount: call.runCount,
    windowCount: call.windowCount,
    ...(f.unclear ? { unclear: f.unclear } : {}),
    ...(totalUsd !== undefined ? { amountUsd: totalUsd } : {})
  })
  const facts: CallFacts = { ...f, ...(totalUsd !== undefined ? { totalUsd } : {}) }
  return { ...v, ...facts, line: v.allowed ? '' : refusalLine(def, call.connection ? `mcp__${call.connection}__${call.tool}` : call.tool, facts, rec, !!otherWhy) }
}
export const isWrite = (k: PlaybookActionKind): boolean => WRITES.includes(k)
/** `mcp__meta_ads__update_ad` → `update_ad` */
export function bareToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name)
  return m ? m[1]! : name.slice(Math.max(name.lastIndexOf('.'), name.lastIndexOf('/')) + 1)
}

/**
 * The founder's line for a refused call: "Ads watch tried to change a budget to $900; refused." Plain words, the
 * amount when it is known, the tool in brackets otherwise.
 */
export function refusalLine(
  def: Pick<PlaybookDef, 'short'>,
  tool: string,
  f: Pick<CallFacts, 'kind' | 'sets' | 'unknown' | 'unclear' | 'totalUsd'> & Partial<Pick<CallFacts, 'goal' | 'activates' | 'generic'>>,
  rec?: PlaybookGuardRecord,
  other = false
): string {
  const what = toolLabel(tool)
  const biggest = f.sets.length ? Math.max(...f.sets.map((s) => s.usd)) : null
  const cap = rec?.limits.budgetCapUsd
  let did: string
  if (f.generic) did = `tried to send a raw request to the ads account with ${what}`
  else if (f.goal) did = `tried to change a campaign’s goal with ${what}`
  else if (f.activates) did = `tried to turn a campaign, ad set or ad back on with ${what}`
  else if (other && f.kind !== 'delete') did = `tried to change something it was not set up for with ${what}`
  else if (f.kind === 'spend' && f.unclear?.startsWith('Principia does not change bid targets')) did = `tried to change a bid target or pacing with ${what}`
  else if (f.kind === 'spend' && f.unclear?.startsWith('Changing when a campaign ends')) did = `tried to change when a campaign ends with ${what}`
  else if (f.kind === 'spend') {
    if (biggest !== null && f.totalUsd !== undefined && cap !== undefined && cap !== null && f.totalUsd > cap && f.totalUsd > biggest)
      did = `tried to change a budget to ${usd(biggest)}, a total of ${usd(f.totalUsd)} a day against a cap of $${cap}`
    else if (biggest !== null) did = `tried to change a budget to ${usd(biggest)}`
    else did = `tried to change a budget with ${what}${f.unclear ? ', in an amount Principia could not read' : ''}`
  } else if (f.kind === 'create') did = `tried to create something new with ${what}`
  else if (f.kind === 'delete') did = `tried to delete something with ${what}`
  else if (f.kind === 'publish') did = `tried to publish with ${what}`
  else if (f.kind === 'send') did = `tried to send a message with ${what}`
  else if (f.unknown) did = `tried ${what}, which may change something`
  else did = `tried to make a change with ${what}`
  return `${def.short} ${did}; refused.`
}

// ---------- matching real work to a playbook ----------

export interface PlaybookSignals {
  /** a run summary, its evidence, a task title */
  texts: readonly string[]
  /** tool names the run called */
  tools: readonly string[]
  /** connections the company has or the run named (ids, key names) */
  connections: readonly string[]
  /** the department of the task or agent */
  departmentKeys: readonly string[]
  /** the run report's own `recurring` hint */
  hints: readonly { playbook?: string; why: string }[]
  /** who did the work and where ("Marcus", "LE-8"), for a reason from words alone */
  who?: string | null
  taskRef?: string | null
}
export interface PlaybookMatch {
  id: PlaybookId
  score: number
  /** plain words: why this offer, now */
  why: string
  /** the daily budget the work named ("$10/day"), for a money playbook's cap */
  budgetUsd?: number
}

/** Words that say the work did not happen ("no ads this week", "not running ads", "skip the ads", "paused the ads"). */
const NEGATION = /\b(no|not|don[’']?t|do not|didn[’']?t|did not|never|without|skip(ped|ping)?|stop(ped|ping)?|paus(e|ed|ing)|cancel(l?ed|ling)?|hold(ing)? off|instead of|rather than|won[’']?t|will not|zero)\b/i
/** The pattern matches somewhere the clause does not deny it ("we ran no ads this week" offers nothing). */
export function affirmed(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (const m of text.matchAll(g)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)
    const clause = before.split(/[.;:!?,]|\bbut\b|\band\b/i).pop() ?? ''
    if (!NEGATION.test(clause) && !NEGATION.test(m[0])) return true
  }
  return false
}

/** Score needed for an offer: a tool, a connection or the agent's own hint is enough; words need their department. */
export const MATCH_THRESHOLD = 3
const W = { hint: 5, tool: 3, connection: 3, text: 2, department: 1 } as const

/** Playbooks the signals point to, best first. Deterministic: the same signals give the same list. */
export function matchPlaybooks(s: PlaybookSignals): PlaybookMatch[] {
  const out: PlaybookMatch[] = []
  for (const def of PLAYBOOKS) {
    let score = 0
    // the reason says only what happened: a tool that changed something, one that read, a connection, or the words
    const hint = s.hints.find((h) => h.playbook === def.id)
    if (hint) score += W.hint
    const tools = s.tools.filter((t) => def.signals.tools.test(t))
    const wrote = tools.find((t) => isWrite(classifyTool(bareToolName(t))) || classifyTool(bareToolName(t)) === 'create')
    const tool = wrote ?? tools[0]
    if (tool) score += W.tool
    const conn = s.connections.find((c) => def.signals.connections.test(c))
    if (conn) score += W.connection
    const words = s.texts.some((t) => affirmed(t, def.signals.text))
    if (words) score += W.text
    if (score > 0 && s.departmentKeys.some((d) => (def.signals.departments as readonly string[]).includes(d))) score += W.department
    if (score < MATCH_THRESHOLD) continue
    const why = hint
      ? `${capital(hint.why.replace(/\.$/, ''))}.`
      : wrote
        ? `${def.because}: the agent used ${toolLabel(wrote)}.`
        : tool
          ? `The agent checked ${def.topic} with ${toolLabel(tool)}.`
          : conn
            ? `${connectionLabel(conn)} is connected.`
            : `${s.who ?? 'The team'} worked on ${def.topic}${s.taskRef ? ` in ${s.taskRef}` : ''}.`
    const budget = def.money ? dailyBudgetIn(s.texts) : null
    out.push({ id: def.id, score, why, ...(budget ? { budgetUsd: budget } : {}) })
  }
  return out.sort((a, b) => b.score - a.score || PLAYBOOK_IDS.indexOf(a.id) - PLAYBOOK_IDS.indexOf(b.id))
}

/** `mcp__meta_ads__create_campaign` → "Meta Ads (create campaign)" */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  const words = (s: string) => s.replace(/[_-]+/g, ' ').trim()
  if (!m) return words(name)
  const server = words(m[1]!).replace(/\b[a-z]/g, (c) => c.toUpperCase())
  return `${server} (${words(m[2]!)})`
}
const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
const connectionLabel = (id: string): string => (/^[A-Z0-9_]+$/.test(id) ? id : id.replace(/[._:-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()))

// ---------- the offer and the schedule it makes ----------

/** "Put your ads on autopilot?" */
export const offerTitle = (def: Pick<PlaybookDef, 'thing'>): string => `Put ${def.thing} on autopilot?`
/** The playbook needs a connection the company does not have (null = nothing missing). */
export function missingConnection(def: Pick<PlaybookDef, 'needs'>, connections: readonly string[]): PlaybookDef['needs'] | null {
  if (!def.needs) return null
  return connections.some((c) => def.needs!.connections.test(c)) ? null : def.needs
}
/** The paused line while a playbook waits for its connection (Principia resumes it once the connection is there). */
export const waitingLine = (needs: NonNullable<PlaybookDef['needs']>): string => `Waiting for ${needs.label}: connect it and this starts by itself.`
export const WAITING_PREFIX = 'Waiting for '
/** The highest level an offer card turns on: Level 2 (Level 3 is its own step, behind a confirm, in Automations). */
export const OFFER_MAX_LEVEL: PlaybookLevel = 2

/** The plain plan an offer shows under its title. */
export function offerDetail(def: PlaybookDef, level: PlaybookLevel): string {
  return `${def.summary} ${def.cadence}. ${levelLabel(level)}: ${def.plan[level]}`
}

export interface PlaybookPromptCtx {
  companyName: string
  level: PlaybookLevel
  raised: boolean
  limits: PlaybookLimits
}

/** The prompt one fire hands the agent (a task-mode card: it has the board tools). */
export function playbookPrompt(def: PlaybookDef, ctx: PlaybookPromptCtx): string {
  const level = Math.min(ctx.level, maxLevel(def, ctx.raised)) as PlaybookLevel
  const rules: string[] = []
  if (level === 1) rules.push('Level 1, watch and report: look and report only. Do not change, pause, publish, send, spend or delete anything. End with up to ' + ctx.limits.maxChanges + ' moves the founder could make, each in one line.')
  if (level === 2) rules.push(`Level 2, propose changes: do not make any change yourself. Propose up to ${ctx.limits.maxChanges} changes, each as its own question to the founder in your report (blockers with needs "decision"), so each one becomes an approval card in Needs you.`)
  if (level === 3) rules.push(`Level 3, act within limits: you may make up to ${ctx.limits.maxChanges} routine changes yourself, inside the hard limits below; propose anything else for the founder's OK. List every change you made.`)
  if (def.money) {
    const targets = ctx.limits.targets ?? []
    rules.push(
      level === 3 && ctx.raised
        ? `Money: the total daily budget across the campaigns you watch stays at or under $${ctx.limits.budgetCapUsd}. Never raise it above that: Principia adds up the latest budget this autopilot set on each campaign and ad set, on any day, and refuses what goes over. Pass budgets in the ads account’s own unit (Meta counts cents: 1000 is $10), with the id of the campaign or ad set they are for.`
        : 'Money: no new spend, no budget or status change. Use only tools that read (get insights, list campaigns); Principia refuses any other tool of the ads account. Propose changes instead.'
    )
    if (level === 3) rules.push(targets.length ? `Change only these campaigns, ad sets and ads, named by id in every call: ${targets.join(', ')}. Principia refuses any other.` : 'No campaigns are listed for you to change, so change nothing: propose changes instead.')
    rules.push('Never turn a paused campaign, ad set or ad back on, never change a goal or bid strategy: propose it. This run has no terminal, no file writing and no web requests: reach the ads account only through Principia’s connections.')
  }
  if (level === 3 && def.caps) rules.push(`${def.caps.line}: Principia counts and refuses the rest.`)
  rules.push('Principia checks your calls to the company’s connections against this level and refuses what the level does not allow. A refused call means: propose it to the founder instead.')
  return [
    `${def.name} for ${ctx.companyName}. ${def.summary}`,
    `What to do this run: ${def.plan[level]}`,
    ...rules,
    `Hard limits, whatever happens: ${def.limits.join('; ')}. Never delete anything.`,
    'If a tool or connection you need is missing, say so and give the founder its link from connections_list. Finish with task_report for review.'
  ].join('\n\n')
}

/** What Automations › Autopilot and the offer card show for one playbook of one company. */
export interface PlaybookView {
  id: PlaybookId
  companyId: string
  on: boolean
  level: PlaybookLevel
  raised: boolean
  limits: PlaybookLimits
  scheduleId: string | null
  agentId: string | null
  agentName: string | null
  /** the schedule is enabled (off = paused) */
  running: boolean
  /** why it was paused by Principia (a refused action), null when the founder paused it or it runs */
  pausedWhy: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  nextRunAt: string | null
  onAt: string | null
  /** calls refused lately, in the founder's words ("Ads watch tried to change a budget to $900; refused."), newest first */
  nearMisses?: { at: string; line: string }[]
  /** on, but paused until its connection is there ("Waiting for your ads account") */
  waiting: { label: string; connectId: string } | null
  /** off, and the connection it needs is missing (Automations shows "Connect … first") */
  needs?: { label: string; connectId: string }
}

/** The playbooks on, per company id (`waiting`: on, paused until its connection is there). */
export type PlaybookSummary = Record<string, { id: PlaybookId; level: PlaybookLevel; running: boolean; waiting: boolean }[]>

/** The autopilots on for one company, as autopilotState reads them ("Ads watch"). */
export function playbooksOnOf(summary: PlaybookSummary | null | undefined, companyId: string): { name: string; running: boolean; waiting: boolean }[] {
  return (summary?.[companyId] ?? []).filter((p) => isPlaybookId(p.id)).map((p) => ({ name: playbookDef(p.id).short, running: p.running, waiting: !!p.waiting }))
}
