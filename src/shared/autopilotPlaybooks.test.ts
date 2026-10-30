import { describe, expect, it } from 'vitest'
import {
  classifyTool,
  guardAction,
  levelRefusal,
  limitsLine,
  matchPlaybooks,
  maxLevel,
  offerDetail,
  offerTitle,
  playbookDef,
  playbookLimits,
  playbookPrompt,
  PLAYBOOKS,
  playbooksOnOf,
  refusedTools,
  parseTargets,
  adsConnectorOf,
  moneyUnit,
  budgetAmountUsd,
  budgetTotalAfter,
  classifyCall,
  readCallArgs,
  dailyBudgetIn,
  guardCall,
  guardedTool,
  missingConnection,
  type PlaybookSignals
} from './autopilotPlaybooks'
import { autopilotLimits, autopilotState, chipLabel, chipShort, willStartLine, withAutopilot } from './autopilotState'

const sig = (p: Partial<PlaybookSignals> = {}): PlaybookSignals => ({ texts: [], tools: [], connections: [], departmentKeys: [], hints: [], ...p })
const ads = playbookDef('ads-watch')

describe('the playbook catalog', () => {
  it('every playbook says what it does, when, what it costs, its limits and a plan per level', () => {
    expect(PLAYBOOKS.map((p) => p.id)).toEqual(['ads-watch', 'social-rhythm', 'site-watch', 'release-digest', 'support-triage', 'revenue-brief', 'outreach-followups'])
    for (const p of PLAYBOOKS) {
      expect(p.summary.length).toBeGreaterThan(20)
      expect(p.cron.split(' ')).toHaveLength(5)
      expect(p.limits.length).toBeGreaterThan(0)
      expect(p.plan[1] && p.plan[2] && p.plan[3]).toBeTruthy()
      expect(p.cost).toMatch(/run/)
    }
    // only the ads watch moves money
    expect(PLAYBOOKS.filter((p) => p.money).map((p) => p.id)).toEqual(['ads-watch'])
  })
  it('the offer reads as a question with the plain plan of the chosen level', () => {
    expect(offerTitle(ads)).toBe('Put your ads on autopilot?')
    expect(offerDetail(ads, 1)).toContain('Level 1 · Watch & report')
    expect(offerDetail(ads, 1)).toContain('Every day at 9:00')
  })
})

describe('matching real work to a playbook', () => {
  it('a run that launched ads with a Meta Ads tool is the ads watch', () => {
    const m = matchPlaybooks(sig({ texts: ['Launched the spring campaign with 3 ad sets'], tools: ['mcp__meta_ads__create_campaign', 'Read'], departmentKeys: ['marketing'] }))
    expect(m[0]!.id).toBe('ads-watch')
    expect(m[0]!.why).toContain('Meta Ads (create campaign)')
  })
  it('words alone need their department; a tool, a connection or the agent’s own hint is enough', () => {
    expect(matchPlaybooks(sig({ texts: ['We launched ads today'] }))).toEqual([])
    expect(matchPlaybooks(sig({ texts: ['We launched ads today'], departmentKeys: ['marketing'] }))[0]!.id).toBe('ads-watch')
    expect(matchPlaybooks(sig({ connections: ['stripe'] }))[0]!.id).toBe('revenue-brief')
    expect(matchPlaybooks(sig({ hints: [{ playbook: 'site-watch', why: 'I deployed the landing page' }] }))[0]).toMatchObject({ id: 'site-watch', why: expect.stringContaining('I deployed the landing page') })
  })
  it('each starting point finds its playbook', () => {
    const cases: [Partial<PlaybookSignals>, string][] = [
      [{ texts: ['Published 3 posts on LinkedIn'], departmentKeys: ['marketing'] }, 'social-rhythm'],
      [{ texts: ['Deployed the new landing page'], tools: ['mcp__vercel__deploy'] }, 'site-watch'],
      [{ texts: ['Merged 4 pull requests'], departmentKeys: ['development'] }, 'release-digest'],
      [{ tools: ['mcp__zendesk__list_tickets'] }, 'support-triage'],
      [{ texts: ['Sent cold emails to 30 prospects'], departmentKeys: ['sales'] }, 'outreach-followups']
    ]
    for (const [s, id] of cases) expect(matchPlaybooks(sig(s))[0]?.id).toBe(id)
  })
  it('is deterministic and ignores unrelated work', () => {
    const s = sig({ texts: ['Fixed the login bug'], tools: ['Edit', 'Bash'], departmentKeys: ['development'] })
    expect(matchPlaybooks(s)).toEqual([])
    const a = sig({ tools: ['mcp__meta_ads__get_insights'], connections: ['stripe'] })
    expect(matchPlaybooks(a)).toEqual(matchPlaybooks(a))
  })
})

describe('levels and limits, refused in code', () => {
  const rec = (level: 1 | 2 | 3, raised = false) => ({ level, raised, limits: playbookLimits(ads, { maxChanges: 3, budgetCapUsd: 40 }) })
  it('a money playbook stays at Level 2 unless the founder raised it', () => {
    expect(maxLevel(ads, false)).toBe(2)
    expect(maxLevel(ads, true)).toBe(3)
    expect(levelRefusal(ads, 3, false)).toMatch(/moves money/)
    expect(levelRefusal(ads, 3, true)).toBeNull()
    expect(levelRefusal(playbookDef('site-watch'), 3, false)).toBeNull()
    expect(levelRefusal(ads, 4, true)).toMatch(/Level 1, 2 or 3/)
  })
  it('spend is refused below Level 3, without the raise, over the cap or with no amount', () => {
    expect(guardAction(ads, rec(1), { kind: 'spend', amountUsd: 10 }).allowed).toBe(false)
    expect(guardAction(ads, rec(2), { kind: 'spend', amountUsd: 10 }).allowed).toBe(false)
    // a stored Level 3 without the raise is read as Level 2
    expect(guardAction(ads, rec(3, false), { kind: 'spend', amountUsd: 10 }).allowed).toBe(false)
    expect(guardAction(ads, rec(3, false), { kind: 'change' }).allowed).toBe(false)
    expect(guardAction(ads, rec(3, true), { kind: 'spend', amountUsd: 41 })).toEqual({ allowed: false, reason: expect.stringContaining('$40') })
    expect(guardAction(ads, rec(3, true), { kind: 'spend' }).allowed).toBe(false)
    expect(guardAction(ads, rec(3, true), { kind: 'spend', amountUsd: 40 }).allowed).toBe(true)
  })
  it('never creates campaigns, never deletes, never touches other campaigns, whatever the level', () => {
    for (const r of [rec(1), rec(2), rec(3, true)]) {
      expect(guardAction(ads, r, { kind: 'create' }).allowed).toBe(false)
      expect(guardAction(ads, r, { kind: 'delete' }).allowed).toBe(false)
      expect(guardAction(ads, r, { kind: 'change', other: true }).allowed).toBe(false)
      expect(guardAction(ads, r, { kind: 'read' }).allowed).toBe(true)
    }
    expect(guardAction(ads, rec(1), { kind: 'propose' }).allowed).toBe(false)
    expect(guardAction(ads, rec(2), { kind: 'propose' }).allowed).toBe(true)
    // a non-money playbook never spends
    const site = playbookDef('site-watch')
    expect(guardAction(site, { level: 3, raised: true, limits: { maxChanges: 3 } }, { kind: 'spend', amountUsd: 1 }).allowed).toBe(false)
  })
  it('tool calls are classified conservatively and refused for the level', () => {
    expect(classifyTool('get_insights')).toBe('read')
    expect(classifyTool('get_budget')).toBe('read')
    expect(classifyTool('update_adset_budget')).toBe('spend')
    expect(classifyTool('create_campaign')).toBe('create')
    expect(classifyTool('pause_ad')).toBe('change')
    expect(classifyTool('delete_ad')).toBe('delete')
    const run = ['mcp__meta_ads__get_insights', 'mcp__meta_ads__pause_ad', 'mcp__meta_ads__update_adset_budget', 'Bash', 'mcp__hivemem__memory_write']
    expect(refusedTools(ads, rec(1), run).map((r) => r.tool)).toEqual(['mcp__meta_ads__pause_ad', 'mcp__meta_ads__update_adset_budget'])
    expect(refusedTools(ads, rec(3, true), run).map((r) => r.tool)).toEqual(['mcp__meta_ads__update_adset_budget'])
  })
  it('limits are clamped and a money playbook always keeps a budget cap', () => {
    expect(playbookLimits(ads, { maxChanges: 99, budgetCapUsd: -5 })).toEqual({ maxChanges: 5, budgetCapUsd: 50, targets: [] })
    expect(playbookLimits(ads, { targets: ['120', ' 120 ', 'bad id!', 'customers/1/campaigns/2'] }).targets).toEqual(['120', 'customers/1/campaigns/2'])
    expect(parseTargets('120, 121\n122;123')).toEqual(['120', '121', '122', '123'])
    expect(limitsLine(ads, { maxChanges: 3, budgetCapUsd: 50, targets: ['1', '2'] }, 3)).toBe('Up to 3 changes a run · total budget cap $50 a day · changes only the 2 campaigns or ad sets you listed')
    expect(limitsLine(ads, { maxChanges: 3, budgetCapUsd: 50 }, 3)).toMatch(/no campaigns listed yet, so it changes nothing$/)
    expect(playbookLimits(playbookDef('site-watch'), { budgetCapUsd: 10 })).toEqual({ maxChanges: 3 })
    expect(limitsLine(ads, { maxChanges: 3, budgetCapUsd: 50 }, 2)).toBe('Up to 3 changes for your OK a run · total budget cap $50 a day')
    // Level 1 changes nothing: it never reads as if it would
    expect(limitsLine(ads, { maxChanges: 3, budgetCapUsd: 10 }, 1)).toBe('Up to 3 suggestions a run · total budget cap $10 a day')
    expect(limitsLine(playbookDef('social-rhythm'), { maxChanges: 3 }, 3)).toBe('Up to 3 changes a run · at most 3 posts a week')
  })
  it('the prompt repeats the level and the hard limits', () => {
    const p1 = playbookPrompt(ads, { companyName: 'Sunday Bakery', level: 1, raised: false, limits: { maxChanges: 3, budgetCapUsd: 50 } })
    expect(p1).toContain('Level 1, watch and report')
    expect(p1).toContain('no new spend')
    expect(p1).toContain('Never creates new campaigns')
    // Level 3 without the raise is written as Level 2
    const p3 = playbookPrompt(ads, { companyName: 'Sunday Bakery', level: 3, raised: false, limits: { maxChanges: 3, budgetCapUsd: 50 } })
    expect(p3).toContain('Level 2, propose changes')
    const p3r = playbookPrompt(ads, { companyName: 'Sunday Bakery', level: 3, raised: true, limits: { maxChanges: 2, budgetCapUsd: 70 } })
    expect(p3r).toContain('$70')
  })
})

describe('the Autopilot state, one truth for every surface', () => {
  it('reads the company row', () => {
    expect(autopilotState({ autopilot: true, maxInFlight: 4, monthlyCap: 200 })).toEqual({ mode: 'on', label: 'Autopilot on', maxInFlight: 4, monthlyCap: 200, switchOn: true, playbooks: 0, names: [], active: 0, waiting: 0, paused: 0 })
    expect(autopilotState({}).label).toBe('Autopilot off')
    expect(autopilotState({ autopilot: true, pausedAt: '2026-10-01' })).toMatchObject({ mode: 'held', label: 'Autopilot off while paused' })
    expect(autopilotLimits(autopilotState({ autopilot: true }))).toBe('No limit on tasks at once · no monthly cap')
    expect(autopilotLimits(autopilotState({ maxInFlight: 1, monthlyCap: 80 }))).toBe('Up to 1 task at once · monthly cap $80')
  })
  it('an autopilot that is on makes "is Autopilot on?" answer yes, and names it, even with the switch off', () => {
    const st = autopilotState({ autopilot: false }, [{ name: 'Ads watch', running: true }])
    expect(st).toMatchObject({ mode: 'on', switchOn: false, playbooks: 1, label: 'Autopilot on · Ads watch' })
    expect(chipLabel(st)).toBe('Autopilot on · 1 active')
    expect(chipLabel(autopilotState({}, [{ name: 'Ads watch' }, { name: 'Site watch' }]))).toBe('Autopilot on · 2 active')
    // never overstated: one that only waits for its connection says so, here and on Home
    const wait = autopilotState({}, [{ name: 'Ads watch', running: false, waiting: true }])
    expect(chipLabel(wait)).toBe('Autopilot on · 1 waiting for its connection')
    expect(wait.label).toBe('Autopilot on · Ads watch waiting for its connection')
    expect(withAutopilot('Ledgerline.', wait)).toBe('Ledgerline · Autopilot on: Ads watch waiting for its connection.')
    expect(chipLabel(autopilotState({}, [{ name: 'Ads watch', running: false }, { name: 'Site watch', running: true }]))).toBe('Autopilot on · 1 active · 1 paused')
    // the narrow header's words keep the count and the state
    expect(chipShort(wait)).toBe('Autopilot on · 1 waiting')
    expect(chipShort(autopilotState({}, [{ name: 'Ads watch', running: false }]))).toBe('Autopilot on · 1 paused')
    expect(autopilotState({}, [{ name: 'Ads watch', running: false }]).label).toBe('Autopilot on · Ads watch paused')
    expect(chipShort(st)).toBe('Autopilot on · 1 active')
    expect(withAutopilot('Ledgerline · nothing needs you.', st)).toBe('Ledgerline · nothing needs you · Autopilot on: Ads watch.')
    expect(withAutopilot('Ledgerline.', autopilotState({ autopilot: true }))).toBe('Ledgerline · Autopilot on.')
    expect(withAutopilot('Ledgerline.', autopilotState({}))).toBe('Ledgerline · Autopilot off.')
    expect(autopilotState({}, [{ name: 'Ads watch' }, { name: 'Site watch' }, { name: 'Revenue brief' }]).label).toBe('Autopilot on · 3 playbooks')
    expect(autopilotState({ pausedAt: 'x' }, [{ name: 'Ads watch' }]).mode).toBe('held')
    expect(playbooksOnOf({ co_1: [{ id: 'ads-watch', level: 1, running: true, waiting: false }] }, 'co_1')).toEqual([{ name: 'Ads watch', running: true, waiting: false }])
  })
  it('says how many tasks will start', () => {
    expect(willStartLine(0, 3)).toMatch(/nothing starts/)
    expect(willStartLine(2, 3)).toBe('2 tasks will start right away.')
    expect(willStartLine(7, 3)).toBe('7 tasks are waiting: 3 will start right away, the rest as others finish.')
  })
})

describe('QA fixes: the guard sees every outside tool, and unsure ones are changes', () => {
  const rec = (level: 1 | 2 | 3, raised = false, cap = 30) => ({ level, raised, limits: { maxChanges: 3, budgetCapUsd: cap, targets: ['a', 'b'] } })
  it('an ads server without "ads" in its name is checked (meta, pipeboard)', () => {
    const run = ['mcp__meta__pause_ad', 'mcp__meta__update_campaign', 'mcp__meta__set_daily_budget', 'mcp__meta__get_insights', 'mcp__hive__task_report', 'mcp__principia__principia_call_tool', 'Bash']
    expect(refusedTools(ads, rec(1), run).map((r) => r.tool)).toEqual(['mcp__meta__pause_ad', 'mcp__meta__update_campaign', 'mcp__meta__set_daily_budget'])
    expect(guardedTool('mcp__pipeboard__update_ad')).toBe(true)
    expect(guardedTool('mcp__hivemem__memory_write')).toBe(false)
    expect(guardedTool('Bash')).toBe(false)
  })
  it('unknown writes are changes; reads by their verb; copies of ad sets are new spend; share publishes', () => {
    expect(classifyTool('duplicate_ad_set')).toBe('create')
    expect(classifyTool('copy_campaign')).toBe('create')
    expect(classifyTool('update_ad_copy')).toBe('change')
    expect(classifyTool('share')).toBe('publish')
    expect(classifyTool('frobnicate')).toBe('change')
    expect(classifyTool('search_ads_archive')).toBe('read')
    expect(classifyTool('archive_campaign')).toBe('delete')
    expect(refusedTools(ads, rec(1), ['mcp__meta_ads__duplicate_ad_set']).length).toBe(1)
    expect(refusedTools(playbookDef('social-rhythm'), { level: 1, raised: false, limits: { maxChanges: 3 } }, ['mcp__linkedin__share']).length).toBe(1)
    expect(refusedTools(ads, rec(1), ['mcp__meta_ads__search_ads_archive'])).toEqual([])
  })
  it('after the run, repeats count against the changes a run may make', () => {
    const r = refusedTools(playbookDef('site-watch'), { level: 3, raised: false, limits: { maxChanges: 2 } }, ['mcp__gh__update_issue', 'mcp__gh__update_issue', 'mcp__gh__update_issue'])
    expect(r).toEqual([{ tool: 'mcp__gh__update_issue', reason: expect.stringMatching(/more than 2 changes/), line: 'Site watch tried to make a change with Gh (update issue); refused.' }])
  })
  it('a raised Level 3 changes a budget within the cap, read from the call (cents when the key says so)', () => {
    // Meta takes cents: daily_budget 2500 is $25; a key that says its unit wins
    expect(budgetAmountUsd({ adset_id: 'a', daily_budget: '2500' }, 'meta')).toBe(25)
    expect(budgetAmountUsd({ adgroup_id: 'a', budget: 25 }, 'tiktok')).toBe(25)
    expect(budgetAmountUsd({ adset_id: 'a', daily_budget_cents: 2500 }, null)).toBe(25)
    expect(budgetAmountUsd({ resource_name: 'customers/1/campaignBudgets/2', amount_micros: 25_000_000 }, 'google')).toBe(25)
    expect(budgetAmountUsd({ adset_id: 'a', adset: { daily_budget: 4000, bid_amount: 200 } }, 'meta')).toBe(40)
    expect(budgetAmountUsd({ name: 'x' })).toBeNull()
    const call = (r: ReturnType<typeof rec>, tool: string, args: unknown, connector: 'meta' | null = 'meta') => guardCall(ads, r, { tool, connection: 'meta', connector, args, runCount: 0, windowCount: 0 })
    expect(call(rec(3, true), 'set_daily_budget', { adset_id: 'a', daily_budget: 2500 }).allowed).toBe(true)
    expect(call(rec(3, true), 'set_daily_budget', { adset_id: 'a', daily_budget: 8000 }).allowed).toBe(false)
    // a change that carries a budget is money whatever the tool is called
    expect(call(rec(2), 'update_adset', { adset_id: 'a', daily_budget: 500 })).toMatchObject({ allowed: false, kind: 'spend' })
    expect(call(rec(3, true), 'set_daily_budget', { adset_id: 'a' }).allowed).toBe(false)
    // a server whose unit Principia does not know (it is not a known ads server) changes no budget
    expect(call(rec(3, true), 'set_daily_budget', { adset_id: 'a', daily_budget: 5 }, null)).toMatchObject({ allowed: false, reason: expect.stringMatching(/dollars, cents or micros/) })
  })
})

describe('QA fixes: offers only for the work they fit, with a true reason', () => {
  it('one-off work is not offered an autopilot', () => {
    const none: Partial<PlaybookSignals>[] = [
      { texts: ['Set up the email campaign for the newsletter launch'], tools: ['Read', 'Write'], departmentKeys: ['marketing'] },
      { tools: ['mcp__gmail__search_threads', 'mcp__slack__get_threads'] },
      { tools: ['mcp__gmail__send_email'], departmentKeys: ['operations'] },
      { tools: ['mcp__gmail__draft_email'] },
      { tools: ['mcp__shopify__storefront_update'] },
      { texts: ['Fixed the CTR typo on the landing page'], departmentKeys: ['marketing'] },
      { texts: ['Built the subscriptions page'], departmentKeys: ['finance'] },
      { tools: ['mcp__wordpress__create_post'] }
    ]
    for (const s of none) expect(matchPlaybooks(sig(s)).map((m) => m.id)).toEqual([])
  })
  it('the reason says what happened: a tool that changed, a tool that read, the words, or the agent’s own hint', () => {
    expect(matchPlaybooks(sig({ tools: ['mcp__meta__create_ad'] }))[0]!.why).toBe('Ads were launched or changed: the agent used Meta (create ad).')
    expect(matchPlaybooks(sig({ tools: ['mcp__meta_ads__get_insights'] }))[0]!.why).toBe('The agent checked ads with Meta Ads (get insights).')
    const draft = matchPlaybooks(sig({ texts: ['Drafted 2 Meta ads at $10/day'], departmentKeys: ['marketing'], who: 'Ovid', taskRef: 'LE-8' }))[0]!
    expect(draft).toMatchObject({ id: 'ads-watch', why: 'Ovid worked on ads in LE-8.', budgetUsd: 10 })
    // a hint is the agent's own words, never "Stripe is connected"
    expect(matchPlaybooks(sig({ hints: [{ playbook: 'revenue-brief', why: 'the founder checks bookings revenue every week' }] }))[0]!.why).toBe('The founder checks bookings revenue every week.')
  })
  it('reads the daily budget the founder named', () => {
    expect(dailyBudgetIn(['Budget: $10/day for 2 weeks'])).toBe(10)
    expect(dailyBudgetIn(['spend 25 USD per day'])).toBe(25)
    expect(dailyBudgetIn(['$10 a day'])).toBe(10)
    expect(dailyBudgetIn(['we raised $2M'])).toBeNull()
  })
  it('knows when the connection it needs is missing', () => {
    expect(missingConnection(ads, [])).toMatchObject({ connectId: 'meta-ads' })
    expect(missingConnection(ads, ['meta'])).toBeNull()
    expect(missingConnection(ads, ['Pipeboard Ads'])).toBeNull()
    expect(missingConnection(ads, ['META_ACCESS_TOKEN'])).toBeNull()
    expect(missingConnection(playbookDef('revenue-brief'), ['github'])).toMatchObject({ connectId: 'stripe' })
    expect(missingConnection(playbookDef('site-watch'), [])).toBeNull()
  })
})

describe('PM review: the money check reads the whole call, never only its name', () => {
  const rec = (level: 1 | 2 | 3, raised = false, cap = 10) => ({ level, raised, limits: { maxChanges: 5, budgetCapUsd: cap, targets: ['1', 'a', 'b', 'c', 'd'] } })
  const call = (r: ReturnType<typeof rec>, tool: string, args: unknown, extra: { readOnly?: boolean; budgetSet?: { target: string | null; usd: number }[]; connection?: string; connector?: 'meta' | 'google' | null } = {}) =>
    guardCall(ads, r, { tool, connection: extra.connection ?? 'meta', connector: 'connector' in extra ? extra.connector : 'meta', args, runCount: 0, windowCount: 0, ...extra })

  it('refuses the exact calls that got through at Level 1, each with the founder’s line', () => {
    const a = call(rec(1), 'get_or_create_campaign', { daily_budget: 500 })
    expect(a).toMatchObject({ allowed: false, kind: 'create' })
    expect(a.line).toBe('Ads watch tried to create something new with Meta (get or create campaign); refused.')
    const b = call(rec(1), 'check_and_fix_delivery', { status: 'ACTIVE' })
    expect(b).toMatchObject({ allowed: false, kind: 'change', activates: true })
    expect(b.line).toBe('Ads watch tried to turn a campaign, ad set or ad back on with Meta (check and fix delivery); refused.')
    const c = call(rec(1), 'insights_update', { daily_budget: 900 })
    expect(c).toMatchObject({ allowed: false, kind: 'spend' })
    // the same calls are refused at Level 2 and through a server named anything
    for (const t of [['get_or_create_campaign', { daily_budget: 500 }], ['check_and_fix_delivery', { status: 'ACTIVE' }], ['insights_update', { daily_budget: 900 }]] as const) {
      expect(call(rec(2), t[0], t[1]).allowed).toBe(false)
      expect(call(rec(1), t[0], t[1], { connection: 'pipeboard', connector: null }).allowed).toBe(false)
    }
  })

  it('names with a write word anywhere are writes, whatever they start with', () => {
    expect(classifyTool('get_or_create_campaign')).toBe('create')
    expect(classifyTool('check_and_fix_delivery')).toBe('change')
    expect(classifyTool('insights_update')).toBe('change')
    expect(classifyTool('preview_and_apply_changes')).toBe('change')
    expect(classifyTool('export_then_delete_ads')).toBe('delete')
    expect(classifyTool('report_and_set_budget')).toBe('spend')
    expect(classifyTool('stats_enable_campaign')).toBe('change')
    expect(classifyTool('metrics_pause_ad')).toBe('change')
    expect(classifyTool('set_status')).toBe('change')
    expect(classifyTool('enable_campaign')).toBe('change')
    expect(classifyTool('pause_campaign')).toBe('change')
    expect(classifyTool('create_ad')).toBe('create')
    expect(classifyTool('delete_campaign')).toBe('delete')
    expect(classifyTool('getOrCreateCampaign')).toBe('create')
    // plain reads still read
    expect(classifyTool('get_insights')).toBe('read')
    expect(classifyTool('list_campaigns')).toBe('read')
  })

  it('arguments that carry money or a status make the call money or a change, at any depth', () => {
    expect(classifyCall(ads, { tool: 'get_insights', args: { date_preset: 'last_7d' }, connector: 'meta' })).toMatchObject({ kind: 'read', unknown: false })
    expect(classifyCall(ads, { tool: 'get_insights', args: { filters: [{ daily_budget: 900 }] }, connector: 'meta' }).kind).toBe('spend')
    expect(classifyCall(ads, { tool: 'get_insights', args: { campaigns: [{ id: '1', status: 'ACTIVE' }] }, connector: 'meta' }).kind).toBe('change')
    // effective_status is a filter an ads account only reads: a known read stays a read
    expect(classifyCall(ads, { tool: 'get_ads', args: { effective_status: ['ACTIVE'] }, connector: 'meta' }).kind).toBe('read')
    expect(classifyCall(ads, { tool: 'report', args: { patch: { bid_amount: 50 } }, connector: 'meta' }).kind).toBe('spend')
    expect(classifyCall(ads, { tool: 'stats', args: { spend_cap: 1 }, connector: 'meta' }).kind).toBe('spend')
    expect(classifyCall(ads, { tool: 'metrics', args: { lifetime_amount: '12' }, connector: 'meta' }).kind).toBe('spend')
  })

  it('on a money playbook a tool reads only from the read list or when its server marks it read-only', () => {
    // a read-looking name that is not known: refused at Level 1 and 2, as a tool that may change something
    expect(classifyCall(ads, { tool: 'get_delivery_report', connector: 'meta' })).toMatchObject({ kind: 'change', unknown: true })
    const v = call(rec(1), 'get_delivery_report', {})
    expect(v).toMatchObject({ allowed: false })
    expect(v.line).toBe('Ads watch tried Meta (get delivery report), which may change something; refused.')
    expect(call(rec(2), 'get_delivery_report', {}).allowed).toBe(false)
    // its server says it only reads: fine
    expect(call(rec(1), 'get_delivery_report', {}, { readOnly: true }).allowed).toBe(true)
    // a read-only mark never outweighs a write word or money in the arguments
    expect(call(rec(1), 'set_budget_quietly', {}, { readOnly: true }).allowed).toBe(false)
    expect(call(rec(1), 'get_campaign_stats', { daily_budget: 900 }, { readOnly: true }).allowed).toBe(false)
    // known reads read; a playbook that moves no money keeps reading by the verb
    expect(call(rec(1), 'get_insights', { date_preset: 'yesterday' }).allowed).toBe(true)
    expect(call(rec(1), 'search_ads_archive', { q: 'shoes' }).allowed).toBe(true)
    expect(classifyCall(playbookDef('site-watch'), { tool: 'get_uptime' })).toMatchObject({ kind: 'read', unknown: false })
    // a server Principia does not know as an ads server: neither its read-only marks nor the read list are believed
    expect(call(rec(1), 'get_delivery_report', {}, { readOnly: true, connector: null }).allowed).toBe(false)
    expect(call(rec(1), 'get_insights', {}, { connector: null }).allowed).toBe(false)
    expect(call(rec(1), 'api_request', { path: '/act_1/campaigns' }, { readOnly: true }).allowed).toBe(false)
  })

  it('budget amounts inside arrays and nested objects count; an unclear amount is refused', () => {
    const f = readCallArgs({ campaign_id: 'c1', daily_budget: 800, adsets: [{ id: 'as1', daily_budget: 90000 }] }, 'meta')
    expect(f.sets).toEqual([{ target: 'c1|daily_budget', usd: 8 }, { target: 'as1|daily_budget', usd: 900 }])
    expect(f.ids).toEqual(['c1', 'as1'])
    // the PM's call: $8 + an ad set at $900, Level 3 raised, cap $10
    const v = call(rec(3, true), 'update_campaign', { campaign_id: '1', daily_budget: 800, adsets: [{ daily_budget: 90000 }] })
    expect(v).toMatchObject({ allowed: false, kind: 'spend', totalUsd: 908 })
    expect(v.line).toBe('Ads watch tried to change a budget to $900, a total of $908 a day against a cap of $10; refused.')
    // a budget Principia cannot read is refused, never guessed
    for (const bad of [{ daily_budget: 'a lot' }, { daily_budget: null }, { daily_budget: -5 }, { adsets: [{ daily_budget: true }] }, { budget: {} }].map((b) => ({ campaign_id: '1', ...b })))
      expect(call(rec(3, true), 'update_campaign', bad)).toMatchObject({ allowed: false, reason: expect.stringMatching(/amount Principia can read/) })
    // too deep to check: refused
    let deep: Record<string, unknown> = { campaign_id: '1', daily_budget: 100 }
    for (let i = 0; i < 12; i++) deep = { child: deep }
    expect(call(rec(3, true), 'update_campaign', deep).allowed).toBe(false)
    // LinkedIn's {amount, currencyCode} is read in whole units; Google's micros
    expect(readCallArgs({ campaign_id: 'c', dailyBudget: { amount: '7.50', currencyCode: 'USD' } }, 'linkedin').sets).toEqual([{ target: 'c|daily_budget', usd: 7.5 }])
    expect(readCallArgs({ resource_name: 'r', campaign_budget: { amount_micros: 3_000_000 } }, 'google').sets).toEqual([{ target: 'r|campaign_budget', usd: 3 }])
    // Google never counts in plain units: a budget without micros is not guessed
    expect(readCallArgs({ resource_name: 'r', amount: 3 }, 'google').unclear).toMatch(/dollars, cents or micros/)
  })

  it('the total budget cap is the total the playbook’s runs set, never one call at a time', () => {
    // the PM's sequence: three $10 calls, then one at $908, with a $10 cap
    let today: { target: string | null; usd: number }[] = []
    const step = (args: unknown) => {
      const v = call(rec(3, true, 10), 'update_adset', args, { budgetSet: today })
      if (v.allowed) today = [...today, ...v.sets]
      return v
    }
    expect(step({ adset_id: 'a', daily_budget: 1000 }).allowed).toBe(true)
    expect(step({ adset_id: 'b', daily_budget: 1000 })).toMatchObject({ allowed: false, totalUsd: 20 })
    expect(step({ adset_id: 'c', daily_budget: 1000 }).allowed).toBe(false)
    const big = step({ adset_id: 'd', daily_budget: 90800 })
    expect(big).toMatchObject({ allowed: false, reason: expect.stringMatching(/total daily budget it has set to \$918, over the total budget cap of \$10/) })
    expect(big.line).toBe('Ads watch tried to change a budget to $908, a total of $918 a day against a cap of $10; refused.')
    // setting the same ad set again replaces its amount (lowering it is fine)
    expect(step({ adset_id: 'a', daily_budget: 600 }).allowed).toBe(true)
    expect(step({ adset_id: 'b', daily_budget: 400 }).allowed).toBe(true)
    expect(budgetTotalAfter(today, [])).toBe(10)
    // an amount whose ad set is unknown is never merged with another
    expect(budgetTotalAfter([{ target: null, usd: 6 }], [{ target: null, usd: 6 }])).toBe(12)
  })

  it('"no ads this week" offers nothing; ads that ran still do', () => {
    const base = { tools: [], connections: [], departmentKeys: ['marketing'], hints: [] }
    for (const t of ['We decided: no ads this week, organic posts only.', 'Not running ads this week.', 'We ran no ads this week.', 'Skip the ad spend for now.', 'Paused all ad creatives until the new site is live.'])
      expect(matchPlaybooks({ ...base, texts: [t] }).map((m) => m.id)).not.toContain('ads-watch')
    expect(matchPlaybooks({ ...base, texts: ['Launched two Meta ads at $10/day.'] }).map((m) => m.id)).toContain('ads-watch')
  })
})

describe('attack review: Level 3 keeps to the cap, to what it was set up for, and to calls Principia can read', () => {
  const rec = (targets: string[] = ['A', 'B', 'C', '1', 'customers/9/campaignBudgets/7'], cap = 10) => ({ level: 3 as const, raised: true, limits: { maxChanges: 5, budgetCapUsd: cap, targets } })
  const call = (tool: string, args: unknown, o: { targets?: string[]; budgetSet?: { target: string | null; usd: number }[]; connector?: 'meta' | 'google' | null } = {}) =>
    guardCall(ads, rec(o.targets), { tool, connection: 'ads', connector: 'connector' in o ? o.connector : 'meta', args, runCount: 0, windowCount: 0, ...(o.budgetSet ? { budgetSet: o.budgetSet } : {}) })

  it('turning a campaign back on restarts its spend: refused at every level; pausing is fine at Level 3', () => {
    const on = call('update_campaign', { campaign_id: '1', status: 'ACTIVE' })
    expect(on).toMatchObject({ allowed: false, activates: true, reason: expect.stringMatching(/restarts its spend/) })
    expect(on.line).toBe('Ads watch tried to turn a campaign, ad set or ad back on with Ads (update campaign); refused.')
    expect(call('resume_campaign', { campaign_id: '1' }).allowed).toBe(false)
    expect(call('update_ad_set', { adset_id: 'A', configured_status: 'enabled' }).allowed).toBe(false)
    expect(call('update_ad', { ad_id: 'A', paused: false }).allowed).toBe(false)
    expect(call('update_fields', { campaign_id: '1', fields: [{ name: 'status', value: 'ACTIVE' }] }).allowed).toBe(false)
    expect(call('update_campaign', { campaign_id: '1', status: 'PAUSED' }).allowed).toBe(true)
  })

  it('changes only what the founder listed: none listed, none named, or one not listed are refused', () => {
    expect(call('pause_ad', { ad_id: 'A' }, { targets: [] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/no campaigns or ad sets listed/) })
    expect(call('pause_ad', {})).toMatchObject({ allowed: false, reason: expect.stringMatching(/names no campaign or ad set/) })
    const stray = call('pause_ad', { ad_id: 'Z' })
    expect(stray).toMatchObject({ allowed: false, reason: expect.stringMatching(/Z is not one of them/) })
    expect(stray.line).toBe('Ads watch tried to change something it was not set up for with Ads (pause ad); refused.')
    // one listed and one not, in a list: refused
    expect(call('pause_ads', { ad_ids: ['A', 'Z'] }).allowed).toBe(false)
    expect(call('update_campaign', { campaign_id: '1', adsets: [{ id: 'Z', name: 'x' }] }).allowed).toBe(false)
    expect(call('pause_ad', { ad_id: 'A', account_id: 'act_1' }).allowed).toBe(true)
    // a creative or an interest id is not a thing it is set up for (swapping a creative on a listed ad is fine)
    expect(call('update_ad', { ad_id: 'A', creative: { creative_id: '555' } }).allowed).toBe(true)
    // Google resource names match by their last part
    expect(call('update_budget', { resource_name: 'customers/9/campaignBudgets/7', amount_micros: 5_000_000 }, { connector: 'google' }).allowed).toBe(true)
  })

  it('two ad sets of one account are two budgets, never merged by the account id', () => {
    const a = readCallArgs({ account_id: 'act_1', adset_id: 'A', daily_budget: 1000 }, 'meta')
    const b = readCallArgs({ account_id: 'act_1', adset_id: 'B', daily_budget: 1000 }, 'meta')
    expect(budgetTotalAfter(a.sets, b.sets)).toBe(20)
    expect(call('update_adset', { account_id: 'act_1', adset_id: 'B', daily_budget: 1000 }, { budgetSet: a.sets })).toMatchObject({ allowed: false, totalUsd: 20 })
    const g1 = readCallArgs({ customer_id: '9', budget_id: '7', amount_micros: 5_000_000 }, 'google')
    const g2 = readCallArgs({ customer_id: '9', budget_id: '8', amount_micros: 5_000_000 }, 'google')
    expect(budgetTotalAfter(g1.sets, g2.sets)).toBe(10)
    // a budget with no campaign or ad set to put it on is refused (it could not be added up)
    expect(call('update_adset', { account_id: 'act_1', daily_budget: 500 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/names no campaign or ad set/) })
    expect(readCallArgs({ account_id: 'act_1', daily_budget: 500 }, 'meta').unclear).toMatch(/campaign or ad set it is for/)
  })

  it('a budget written as text, JSON, form fields or a field list is read; one it cannot read is refused', () => {
    expect(call('update_campaign', { campaign_id: '1', fields: [{ name: 'daily_budget', value: 90000 }] })).toMatchObject({ allowed: false, kind: 'spend', totalUsd: 900 })
    expect(call('update_campaign', { campaign_id: '1', params: '{"daily_budget":90000}' })).toMatchObject({ allowed: false, kind: 'spend', totalUsd: 900 })
    expect(call('update_campaign', { campaign_id: '1', body: 'daily_budget=90000&name=x' })).toMatchObject({ allowed: false, kind: 'spend', totalUsd: 900 })
    expect(call('update_campaign', { campaign_id: '1', note: 'set daily_budget: 900 please' })).toMatchObject({ allowed: false, kind: 'spend', reason: expect.stringMatching(/as text/) })
    // within the cap, as JSON text, it is counted like any other
    expect(call('update_campaign', { campaign_id: '1', params: '{"daily_budget":500}' })).toMatchObject({ allowed: true, totalUsd: 5 })
    // a filter on spend (an operator) is a read, not a change
    expect(classifyCall(ads, { tool: 'get_insights', args: { filtering: [{ field: 'spend', operator: 'GREATER_THAN', value: 100 }] }, connector: 'meta' }).kind).toBe('read')
  })

  it('pass-through tools, bid targets, goals and end dates are refused at Level 3', () => {
    for (const t of ['api_request', 'graphql', 'batch', 'call_api', 'raw_http', 'query_meta']) expect(call(t, { campaign_id: '1', path: '/1' }), t).toMatchObject({ allowed: false, generic: true })
    expect(call('api_request', { campaign_id: '1' }).line).toBe('Ads watch tried to send a raw request to the ads account with Ads (api request); refused.')
    expect(call('update_campaign', { campaign_id: '1', target_cpa_micros: 5_000_000 }, { connector: 'google' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/bid targets/) })
    expect(call('update_campaign', { campaign_id: '1', target_cpa_micros: 5_000_000 }, { connector: 'google' }).line).toBe('Ads watch tried to change a bid target or pacing with Ads (update campaign); refused.')
    expect(call('update_campaign', { campaign_id: '1', target_roas: 3.5 }).allowed).toBe(false)
    expect(call('update_campaign', { campaign_id: '1', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }).allowed).toBe(false)
    expect(call('update_campaign', { campaign_id: '1', objective: 'OUTCOME_SALES' })).toMatchObject({ allowed: false, goal: true, reason: expect.stringMatching(/goal/) })
    expect(call('update_adset', { adset_id: 'A', optimization_goal: 'LINK_CLICKS' }).allowed).toBe(false)
    const ends = call('update_adset', { adset_id: 'A', end_time: '2027-01-01' })
    expect(ends).toMatchObject({ allowed: false, kind: 'spend', reason: expect.stringMatching(/ends/) })
    expect(ends.line).toBe('Ads watch tried to change when a campaign ends with Ads (update adset); refused.')
  })

  it('the money unit comes from the server’s identity, never the connection’s name', () => {
    expect(adsConnectorOf({ url: 'https://mcp.pipeboard.co/meta-ads-mcp' })).toBe('meta')
    expect(adsConnectorOf({ url: 'https://mcp.pipeboard.co/google-ads-mcp' })).toBe('google')
    expect(adsConnectorOf({ url: 'https://mcp.pipeboard.co/mcp' })).toBeNull()
    expect(adsConnectorOf({ command: 'npx', args: ['-y', 'meta-ads-mcp'] })).toBe('meta')
    expect(adsConnectorOf({ command: 'npx', args: ['meta-ads-mcp', 'google-ads-mcp'] })).toBeNull()
    expect(adsConnectorOf({ url: 'https://example.com/metadata' })).toBeNull()
    expect(moneyUnit('google', 'daily_budget')).toBeNull()
    expect(moneyUnit('google', 'amount_micros')).toBe('micros')
    expect(moneyUnit(null, 'daily_budget')).toBeNull()
    expect(moneyUnit('meta', 'daily_budget')).toBe('cents')
  })

  it('a tool refused more than once says how often', () => {
    const r = refusedTools(ads, { level: 1, raised: false, limits: { maxChanges: 3, budgetCapUsd: 10 } }, Array.from({ length: 10 }, () => 'mcp__meta__update_campaign'))
    expect(r).toHaveLength(1)
    expect(r[0]!.line).toBe('Ads watch tried to make a change with Meta (update campaign); refused 10 times.')
  })
})
