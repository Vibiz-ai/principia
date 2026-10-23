import { describe, expect, it, vi } from 'vitest'
import { laneOf } from '../../shared/company'
import {
  agentEligibleFor, needsSuggestion, queueCountsFrom, route, routedActivity, routingInUse, routingPatch, shouldReroute, slackChannelOf, suggestInput, suggestionApplies, suggestRoute,
  SUGGEST_TEXT_MAX, SUGGEST_TIMEOUT_MS, type ModelCall, type ModelCallRequest, type RouteAgent, type RouteContext, type RouteDepartment, type RouteTask
} from './router'

const CO = 'co_acme'
const dep = (id: string, key: string, name: string, o: Partial<Omit<RouteDepartment, 'data'>> & { data?: Partial<RouteDepartment['data']> } = {}): RouteDepartment => ({
  id, companyId: CO, key, name, sortOrder: 0, archivedAt: null, createdAt: '2026-10-01T00:00:00Z', ...o,
  data: { charter: { does: `${name} work`, doesNot: '' }, sourceDefaults: [], slackChannels: [], ...o.data }
})
const agent = (id: string, departmentId: string | null, name: string, o: Partial<Omit<RouteAgent, 'data'>> & { autonomy?: 'manual' | 'auto'; capabilities?: string } = {}): RouteAgent => {
  const { autonomy = 'manual', capabilities = '', ...rest } = o
  return { id, companyId: CO, departmentId, name, archivedAt: null, pausedAt: null, createdAt: '2026-10-02T00:00:00Z', ...rest, data: { autonomy, capabilities } }
}
const task = (o: Partial<RouteTask> = {}): RouteTask => ({ companyId: CO, title: 'Write launch post', description: '', source: 'manual', sourceUrl: null, status: 'triage', departmentId: null, agentId: null, ...o })

const dev = dep('dep_dev', 'development', 'Development', { sortOrder: 0, data: { sourceDefaults: ['github', 'sentry'] } })
const mkt = dep('dep_mkt', 'marketing', 'Marketing', { sortOrder: 1 })
const sup = dep('dep_sup', 'support', 'Support', { sortOrder: 2, data: { sourceDefaults: ['slack'], slackChannels: ['C0SUPPORT'] } })
const sales = dep('dep_sal', 'sales', 'Sales', { sortOrder: 3 })
const copy = agent('agt_copy', 'dep_mkt', 'Copywriter')
const fixA = agent('agt_fixa', 'dep_dev', 'Bug fixer A', { autonomy: 'auto', createdAt: '2026-10-02T00:00:00Z' })
const fixB = agent('agt_fixb', 'dep_dev', 'Bug fixer B', { autonomy: 'auto', createdAt: '2026-10-03T00:00:00Z' })
const fixManual = agent('agt_fixm', 'dep_dev', 'Reviewer', { createdAt: '2026-10-01T00:00:00Z' })
const ctx = (o: Partial<RouteContext> = {}): RouteContext => ({ departments: [dev, mkt, sup, sales], agents: [copy, fixA, fixB, fixManual], queueCounts: {}, ...o })

describe('route: rule 1, explicit agent', () => {
  it('an explicit agent wins over department rules and source defaults', () => {
    const d = route(task({ agentId: 'agt_copy', source: 'github', sourceUrl: 'https://github.com/a/b/issues/1' }), ctx())
    expect(d).toEqual({ departmentId: 'dep_mkt', agentId: 'agt_copy', by: 'human', reason: 'assigned to Copywriter' })
  })
  it('keeps the explicit choice of a paused agent but says so (laneOf then shows Needs you)', () => {
    const paused = agent('agt_p', 'dep_mkt', 'Editor', { pausedAt: '2026-10-05T00:00:00Z' })
    const d = route(task({ agentId: 'agt_p', departmentId: 'dep_mkt', status: 'todo' }), ctx({ agents: [paused, copy] }))
    expect(d).toMatchObject({ agentId: 'agt_p', by: 'human', reason: 'assigned to Editor (paused)' })
    const eligible = agentEligibleFor({ agentId: 'agt_p' }, [paused])
    expect(eligible).toBe(false)
    expect(laneOf({ status: 'todo', departmentId: 'dep_mkt', agentId: 'agt_p', assigneeProfileId: null, blockReason: null }, false, eligible)).toBe('needs_you')
  })
  it('an MCP handoff can be recorded as a rule', () => {
    expect(route(task({ agentId: 'agt_copy' }), ctx({ explicitBy: 'rule' })).by).toBe('rule')
  })
  it('an unknown or other-company agent falls through to the department rules, with a note', () => {
    const foreign = { ...copy, id: 'agt_x', companyId: 'co_beta' }
    const d = route(task({ agentId: 'agt_x', departmentId: 'dep_mkt' }), ctx({ agents: [copy, foreign] }))
    expect(d).toEqual({ departmentId: 'dep_mkt', agentId: 'agt_copy', by: 'rule', reason: 'assigned agent not found; only agent in Marketing' })
  })
})

describe('route: rule 1, consistency and handoffs (review)', () => {
  it('the department follows the explicit agent, so a handoff never writes a cross-department pair', () => {
    const d = route(task({ agentId: 'agt_fixa', departmentId: 'dep_mkt', status: 'todo' }), ctx({ explicitBy: 'rule' }))
    expect(d).toEqual({ departmentId: 'dep_dev', agentId: 'agt_fixa', by: 'rule', reason: 'assigned to Bug fixer A; moved to Development' })
  })
  it('a company-level agent keeps the task\'s department', () => {
    const ceo = agent('agt_ceo', null, 'Chief of staff')
    expect(route(task({ agentId: 'agt_ceo', departmentId: 'dep_mkt' }), ctx({ agents: [ceo, copy] }))).toMatchObject({ departmentId: 'dep_mkt', agentId: 'agt_ceo' })
  })
  it('a machine handoff to an archived agent is dropped; rule 2 runs in that agent\'s department', () => {
    const gone = agent('agt_gone', 'dep_mkt', 'Old writer', { archivedAt: '2026-10-05T00:00:00Z' })
    const d = route(task({ agentId: 'agt_gone' }), ctx({ agents: [gone, copy], explicitBy: 'rule' }))
    expect(d).toEqual({ departmentId: 'dep_mkt', agentId: 'agt_copy', by: 'rule', reason: 'Old writer is archived; only agent in Marketing' })
    // the human's own pick of an archived agent is kept and flagged
    expect(route(task({ agentId: 'agt_gone' }), ctx({ agents: [gone, copy] }))).toMatchObject({ agentId: 'agt_gone', reason: 'assigned to Old writer (archived)' })
  })
  it('an other-company department id is ignored with a note', () => {
    const foreign = dep('dep_x', 'x', 'Elsewhere', { companyId: 'co_beta' })
    const d = route(task({ departmentId: 'dep_x' }), ctx({ departments: [dev, mkt, foreign] }))
    expect(d).toMatchObject({ departmentId: null, agentId: null, reason: 'department not found; no routing rule matched; stays in triage' })
  })
  it('a company-level explicit assignment without a department asks no model suggestion', () => {
    const ceo = agent('agt_ceo', null, 'Chief of staff')
    const d = route(task({ agentId: 'agt_ceo' }), ctx({ agents: [ceo] }))
    expect(d).toMatchObject({ departmentId: null, agentId: 'agt_ceo' })
    expect(needsSuggestion(d)).toBe(false)
    expect(routingPatch({ status: 'triage' }, d).status).toBeUndefined()
  })
})

describe('routing triggers and the unused feature (review)', () => {
  it('create always routes a not-started task, including one with a department or agent set', () => {
    expect(shouldReroute(null, task({ departmentId: 'dep_mkt' }))).toBe(true)
    expect(shouldReroute(null, task({ agentId: 'agt_copy', status: 'todo' }))).toBe(true)
    expect(shouldReroute(null, task({ status: 'backlog' }))).toBe(true)
    expect(shouldReroute(null, task({ status: 'in_progress' }))).toBe(false)
    expect(shouldReroute(null, task({ status: 'done' }))).toBe(false)
  })
  it('an update re-routes a department move without an agent, never an in-flight or assigned task', () => {
    expect(shouldReroute({ title: 'Write launch post', description: '', departmentId: null }, task({ departmentId: 'dep_mkt' }))).toBe(true)
    expect(shouldReroute({ title: 'Write launch post', description: '', departmentId: 'dep_mkt' }, task({ departmentId: 'dep_mkt' }))).toBe(false)
    expect(shouldReroute({ title: 'x', description: '', departmentId: null }, task({ departmentId: 'dep_mkt', agentId: 'agt_copy' }))).toBe(false)
    expect(shouldReroute({ title: 'x', description: '', departmentId: null }, task({ departmentId: 'dep_mkt', status: 'in_progress' }))).toBe(false)
    expect(shouldReroute({ title: 'old', description: '' }, task({ status: 'blocked' }))).toBe(false)
  })
  it('routing is not in use for a company without departments or agents (legacy boards see no change)', () => {
    expect(routingInUse(task(), { departments: [], agents: [] })).toBe(false)
    // other companies' rows and archived ones do not count
    expect(routingInUse(task(), { departments: [{ ...mkt, companyId: 'co_beta' }, { ...dev, archivedAt: '2026-10-05T00:00:00Z' }], agents: [{ ...copy, companyId: 'co_beta' }] })).toBe(false)
    expect(routingInUse(task(), { departments: [mkt], agents: [] })).toBe(true)
    expect(routingInUse(task(), { departments: [], agents: [agent('agt_ceo', null, 'Chief of staff')] })).toBe(true)
  })
})

describe('route: rule 2, department set', () => {
  it('assigns the only active agent, even a manual one', () => {
    expect(route(task({ departmentId: 'dep_mkt' }), ctx())).toEqual({ departmentId: 'dep_mkt', agentId: 'agt_copy', by: 'rule', reason: 'only agent in Marketing' })
  })
  it('with several agents picks the auto agent with the fewest queued tasks', () => {
    const d = route(task({ departmentId: 'dep_dev' }), ctx({ queueCounts: { agt_fixa: 3, agt_fixb: 1, agt_fixm: 0 } }))
    expect(d).toMatchObject({ departmentId: 'dep_dev', agentId: 'agt_fixb', by: 'rule' })
    expect(d.reason).toContain('Bug fixer B is the auto agent in Development with the fewest queued tasks (1)')
  })
  it('breaks equal loads by creation order, independent of input order', () => {
    const a = route(task({ departmentId: 'dep_dev' }), ctx({ agents: [fixB, fixManual, fixA] }))
    const b = route(task({ departmentId: 'dep_dev' }), ctx({ agents: [fixA, fixB, fixManual] }))
    expect(a.agentId).toBe('agt_fixa'); expect(b).toEqual(a)
  })
  it('several agents, none on auto: stays in the department unassigned and lands in Needs you', () => {
    const d = route(task({ departmentId: 'dep_dev', status: 'todo' }), ctx({ agents: [fixManual, { ...fixA, data: { ...fixA.data, autonomy: 'manual' } }] }))
    expect(d).toEqual({ departmentId: 'dep_dev', agentId: null, by: 'human', reason: '2 agents in Development, none on auto; waiting for you to assign' })
    const t = { status: 'todo' as const, ...routingPatch({ status: 'todo' }, d), assigneeProfileId: null, blockReason: null }
    expect(laneOf(t)).toBe('needs_you')
  })
  it('never chooses paused or archived agents', () => {
    const paused = { ...fixA, pausedAt: '2026-10-05T00:00:00Z' }
    const archived = { ...fixB, archivedAt: '2026-10-05T00:00:00Z' }
    const d = route(task({ departmentId: 'dep_dev' }), ctx({ agents: [paused, archived], queueCounts: {} }))
    expect(d).toMatchObject({ departmentId: 'dep_dev', agentId: null, reason: 'no active agent in Development; waiting for you to assign' })
    // one active manual agent beside paused auto ones: it is the only agent
    expect(route(task({ departmentId: 'dep_dev' }), ctx({ agents: [paused, archived, fixManual] })).agentId).toBe('agt_fixm')
    // two left, only one auto: the paused auto agent with the lowest load is skipped
    const d2 = route(task({ departmentId: 'dep_dev' }), ctx({ agents: [paused, fixB, fixManual], queueCounts: { agt_fixa: 0, agt_fixb: 9 } }))
    expect(d2.agentId).toBe('agt_fixb')
  })
  it('ignores company-level agents and agents of other departments or companies', () => {
    const companyLevel = agent('agt_ops', null, 'Generalist', { autonomy: 'auto' })
    const other = { ...agent('agt_b', 'dep_sal', 'Seller'), companyId: 'co_beta' }
    expect(route(task({ departmentId: 'dep_sal' }), ctx({ agents: [companyLevel, other, copy] })).agentId).toBeNull()
  })
  it('an archived department is not routed into; source rules apply instead', () => {
    const d = route(task({ departmentId: 'dep_mkt', source: 'github', sourceUrl: 'https://github.com/a/b/issues/2' }), ctx({ departments: [dev, { ...mkt, archivedAt: '2026-10-05T00:00:00Z' }] }))
    expect(d).toMatchObject({ departmentId: 'dep_dev', by: 'rule' })
    expect(d.reason).toContain('Marketing is archived; github tasks go to Development')
  })
})

describe('route: rule 3, nothing set', () => {
  it('Slack channel first, from the trigger or the permalink', () => {
    const viaTrigger = route(task({ source: 'slack', sourceUrl: null }), ctx({ trigger: { kind: 'slack', channelId: 'C0SUPPORT', departmentId: 'dep_mkt' } }))
    expect(viaTrigger).toEqual({ departmentId: 'dep_sup', agentId: null, by: 'rule', reason: 'Slack channel C0SUPPORT routes to Support; no active agent in Support; waiting for you to assign' })
    expect(slackChannelOf({ source: 'slack', sourceUrl: 'https://acme.slack.com/archives/C0SUPPORT/p1729000000000100' })).toBe('C0SUPPORT')
    expect(route(task({ source: 'slack', sourceUrl: 'https://acme.slack.com/archives/C0SUPPORT/p1729000000000100' }), ctx()).departmentId).toBe('dep_sup')
  })
  it('a channel routed to a department beats another department whose sourceDefaults list slack', () => {
    const mktSlack = { ...mkt, sortOrder: 0, data: { ...mkt.data, slackChannels: ['C0LAUNCH'] } }
    const supEarly = { ...sup, sortOrder: -1 }
    const d = route(task({ source: 'slack' }), ctx({ departments: [supEarly, mktSlack], trigger: { kind: 'slack', channelId: 'C0LAUNCH' } }))
    expect(d).toMatchObject({ departmentId: 'dep_mkt', agentId: 'agt_copy' })
  })
  it('then sourceDefaults, then step 2 inside that department', () => {
    const d = route(task({ source: 'sentry', sourceUrl: 'https://sentry.io/issues/1' }), ctx({ queueCounts: { agt_fixa: 2, agt_fixb: 2 } }))
    expect(d).toMatchObject({ departmentId: 'dep_dev', agentId: 'agt_fixa', by: 'rule' })
    expect(d.reason).toMatch(/^sentry tasks go to Development; Bug fixer A is the auto agent/)
  })
  it('sourceDefaults shared by two departments pick the first in sidebar order', () => {
    const a = { ...sales, sortOrder: 5, data: { ...sales.data, sourceDefaults: ['posthog' as const] } }
    const b = { ...mkt, sortOrder: 1, data: { ...mkt.data, sourceDefaults: ['posthog' as const] } }
    expect(route(task({ source: 'posthog' }), ctx({ departments: [a, b] })).departmentId).toBe('dep_mkt')
    expect(route(task({ source: 'posthog' }), ctx({ departments: [b, a] })).departmentId).toBe('dep_mkt')
  })
  it('then the Slack trigger\'s own department', () => {
    const d = route(task({ source: 'slack' }), ctx({ departments: [dev, mkt], trigger: { kind: 'slack', channelId: 'C0RANDOM', departmentId: 'dep_mkt' } }))
    expect(d).toEqual({ departmentId: 'dep_mkt', agentId: 'agt_copy', by: 'rule', reason: 'the Slack trigger belongs to Marketing; only agent in Marketing' })
  })
  it('archived or other-company departments never match', () => {
    const archivedSup = { ...sup, archivedAt: '2026-10-05T00:00:00Z' }
    const betaDev = { ...dev, id: 'dep_bdev', companyId: 'co_beta' }
    expect(route(task({ source: 'slack', sourceUrl: 'https://acme.slack.com/archives/C0SUPPORT/p1' }), ctx({ departments: [archivedSup] })).departmentId).toBeNull()
    expect(route(task({ source: 'github', sourceUrl: 'https://github.com/a/b/issues/3' }), ctx({ departments: [betaDev] })).departmentId).toBeNull()
  })
  it('no match: stays in triage with a reason, and step 4 may suggest', () => {
    const d = route(task(), ctx())
    expect(d).toEqual({ departmentId: null, agentId: null, by: 'rule', reason: 'no routing rule matched; stays in triage' })
    expect(needsSuggestion(d)).toBe(true)
    expect(routingPatch({ status: 'triage' }, d)).toEqual({ routing: d, departmentId: null, agentId: null })
  })
  it('is deterministic: same input, same decision, regardless of list order', () => {
    const t = task({ source: 'github', sourceUrl: 'https://github.com/a/b/issues/4' })
    const one = route(t, ctx())
    for (let i = 0; i < 5; i++) expect(route(t, ctx({ departments: [sales, sup, mkt, dev], agents: [fixManual, fixB, copy, fixA] }))).toEqual(one)
  })
})

describe('writing a decision', () => {
  it('a rule decision sets department and agent and moves triage to todo', () => {
    const d = route(task({ departmentId: 'dep_mkt' }), ctx())
    expect(routingPatch({ status: 'triage' }, d)).toEqual({ routing: d, departmentId: 'dep_mkt', agentId: 'agt_copy', status: 'todo' })
    expect(routingPatch({ status: 'backlog' }, d).status).toBeUndefined()
  })
  it('the routed activity carries the reason and who decided', () => {
    const c = ctx()
    expect(routedActivity(route(task({ departmentId: 'dep_mkt' }), c), c)).toEqual({ kind: 'routed', by: 'system', message: 'Routed to Marketing / Copywriter: only agent in Marketing' })
    expect(routedActivity(route(task({ agentId: 'agt_copy' }), c), c).by).toBe('human')
    expect(routedActivity(route(task(), c), c).message).toBe('Not routed: no routing rule matched; stays in triage')
    expect(routedActivity({ departmentId: 'dep_dev', agentId: null, by: 'model', reason: 'stack trace', confidence: 0.72 }, c).message).toBe('Suggested Development (72% sure): stack trace')
  })
  it('queue counts and reroute triggers', () => {
    expect(queueCountsFrom([
      { agentId: 'a', status: 'todo', blockReason: null }, { agentId: 'a', status: 'in_progress', blockReason: null }, { agentId: 'a', status: 'blocked', blockReason: 'deps' },
      { agentId: 'a', status: 'blocked', blockReason: 'needs_input' }, { agentId: 'a', status: 'done', blockReason: null }, { agentId: null, status: 'todo', blockReason: null }
    ])).toEqual({ a: 3 })
    expect(shouldReroute(null, task())).toBe(true)
    expect(shouldReroute({ title: 'Write launch post', description: '' }, task())).toBe(false)
    expect(shouldReroute({ title: 'old', description: '' }, task())).toBe(true)
    expect(shouldReroute({ title: 'old', description: '' }, task({ status: 'todo' }))).toBe(false)
    expect(shouldReroute({ title: 'old', description: '' }, task({ departmentId: 'dep_mkt' }))).toBe(false)
  })
})

describe('suggestRoute: step 4 model suggestion (mocked)', () => {
  const answer = (o: object) => vi.fn<ModelCall>(async () => `Sure:\n${JSON.stringify(o)}`)

  it('calls the model headless, with no tools and a 20 s timeout, and never applies the suggestion', async () => {
    const call = answer({ departmentKey: 'development', agentId: 'agt_fixb', confidence: 0.8, reason: 'a crash report' })
    const t = task({ title: 'App crashes on login', description: 'TypeError at auth.ts:12' })
    const r = await suggestRoute(t, ctx(), { call })
    expect(call).toHaveBeenCalledTimes(1)
    const req = call.mock.calls[0][0] as ModelCallRequest
    expect(req.tools).toEqual([]); expect(req.headless).toBe(true); expect(req.maxTurns).toBe(1)
    expect(req.timeoutMs).toBe(SUGGEST_TIMEOUT_MS); expect(SUGGEST_TIMEOUT_MS).toBe(20_000)
    expect(req.signal).toBeInstanceOf(AbortSignal)
    expect(req.system).toContain('development (Development)'); expect(req.system).toContain('agent agt_fixb "Bug fixer B"')
    expect(req.input).toContain('App crashes on login')
    expect(r?.suggestion).toEqual({ departmentKey: 'development', agentId: 'agt_fixb', confidence: 0.8, reason: 'a crash report' })
    expect(r?.routing).toEqual({ departmentId: 'dep_dev', agentId: 'agt_fixb', by: 'model', reason: 'a crash report', confidence: 0.8 })
    // only routing is written: department, agent and status stay, so the task stays in triage
    const patch = routingPatch({ status: 'triage' }, r!.routing)
    expect(patch).toEqual({ routing: r!.routing })
    expect(needsSuggestion(r!.routing)).toBe(false)
  })
  it('redacts the task text, then caps it at 2000 chars', async () => {
    const call = answer({ departmentKey: 'marketing', agentId: null, confidence: 0.5, reason: 'copy' })
    const secret = 'sk-live-SECRETVALUE'
    const description = `token ${secret} and ghp_${'a'.repeat(36)} ` + 'x'.repeat(5000)
    await suggestRoute(task({ description }), ctx(), { call, redact: s => s.split(secret).join('[redacted]') })
    const req = call.mock.calls[0][0] as ModelCallRequest
    expect(req.input.length).toBeLessThanOrEqual(SUGGEST_TEXT_MAX); expect(SUGGEST_TEXT_MAX).toBe(2000)
    expect(req.input).not.toContain(secret); expect(req.input).toContain('[redacted]')
    expect(req.input).not.toContain('ghp_aaaa'); expect(req.input).toContain('••••credential')
    expect(req.system).not.toContain('xxxxx')
    // redaction runs before the cap: a secret straddling the cap is never cut into an unredactable piece
    const edge = 'y'.repeat(1990) + ` ghp_${'b'.repeat(36)}`
    expect(suggestInput({ title: 't', description: edge, source: 'manual' })).not.toContain('ghp_b')
  })
  it('times out after 20 s and returns no suggestion, aborting the call', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const call: ModelCall = (req) => new Promise(() => { req.signal.addEventListener('abort', () => { aborted = true }) })
      const p = suggestRoute(task(), ctx(), { call })
      await vi.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS - 1)
      let settled = false; void p.then(() => { settled = true })
      await Promise.resolve(); expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await p).toBeNull(); expect(aborted).toBe(true)
      // a caller cannot raise the timeout above 20 s
      const spy = vi.fn<ModelCall>(async () => '{}')
      await suggestRoute(task(), ctx(), { call: spy, timeoutMs: 120_000 })
      expect(spy.mock.calls[0][0].timeoutMs).toBe(SUGGEST_TIMEOUT_MS)
    } finally { vi.useRealTimers() }
  })
  it('drops paused, archived, hallucinated and other-department agents; keeps the department', async () => {
    const paused = { ...fixA, pausedAt: '2026-10-05T00:00:00Z' }
    for (const agentId of ['agt_fixa', 'agt_nope', 'agt_copy']) {
      const r = await suggestRoute(task(), ctx({ agents: [paused, fixB, copy] }), { call: answer({ departmentKey: 'development', agentId, confidence: 0.6, reason: 'code' }) })
      expect(r?.routing).toMatchObject({ departmentId: 'dep_dev', agentId: null, by: 'model' })
    }
    const req = vi.fn<ModelCall>(async () => '{}')
    await suggestRoute(task(), ctx({ agents: [paused, fixB] }), { call: req })
    expect(req.mock.calls[0][0].system).not.toContain('agt_fixa')
  })
  it('returns null on an unknown or archived department, malformed output, or a failing call; never throws', async () => {
    const archivedMkt = { ...mkt, archivedAt: '2026-10-05T00:00:00Z' }
    expect(await suggestRoute(task(), ctx(), { call: answer({ departmentKey: 'legal', agentId: null, confidence: 1, reason: 'x' }) })).toBeNull()
    expect(await suggestRoute(task(), ctx({ departments: [dev, archivedMkt] }), { call: answer({ departmentKey: 'marketing', agentId: null, confidence: 1, reason: 'x' }) })).toBeNull()
    expect(await suggestRoute(task(), ctx(), { call: async () => 'I think marketing' })).toBeNull()
    expect(await suggestRoute(task(), ctx(), { call: async () => '{"departmentKey": 3}' })).toBeNull()
    expect(await suggestRoute(task(), ctx(), { call: async () => { throw new Error('spawn failed') } })).toBeNull()
    const none = vi.fn<ModelCall>()
    expect(await suggestRoute(task(), ctx({ departments: [] }), { call: none })).toBeNull()
    expect(none).not.toHaveBeenCalled()
  })
  it('clamps confidence and redacts and caps the reason', async () => {
    const r = await suggestRoute(task(), ctx(), { call: answer({ departmentKey: 'marketing', agentId: null, confidence: 7, reason: `launch copy ghp_${'c'.repeat(36)} ` + 'z'.repeat(600) }) })
    expect(r?.routing.confidence).toBe(1)
    expect(r?.routing.reason).not.toContain('ghp_c')
    expect(r!.routing.reason.length).toBeLessThanOrEqual(300)
  })
})

describe('adversarial review: handoffs into archived departments, stale suggestions', () => {
  const archivedMkt = { ...mkt, archivedAt: '2026-10-05T00:00:00Z' }
  it('a machine handoff never moves a task into an archived department, even to an active agent there', () => {
    const d = route(task({ agentId: 'agt_copy', departmentId: 'dep_dev', status: 'todo' }), ctx({ departments: [dev, archivedMkt], explicitBy: 'rule' }))
    expect(d.departmentId).toBe('dep_dev')
    expect(d.agentId).not.toBe('agt_copy')
    expect(d.reason).toMatch(/^Copywriter's department Marketing is archived; /)
    // with no department of its own the task falls to rule 3, never to the archived one
    const loose = route(task({ agentId: 'agt_copy' }), ctx({ departments: [dev, archivedMkt], explicitBy: 'rule' }))
    expect(loose).toMatchObject({ departmentId: null, agentId: null, reason: "Copywriter's department Marketing is archived; no routing rule matched; stays in triage" })
    // the human's own pick is kept and flagged
    expect(route(task({ agentId: 'agt_copy' }), ctx({ departments: [dev, archivedMkt] }))).toMatchObject({ departmentId: 'dep_mkt', agentId: 'agt_copy', reason: 'assigned to Copywriter (Marketing is archived)' })
  })
  it('an agent whose department id is foreign or dangling never leaks that id into the task', () => {
    const stray = agent('agt_s', 'dep_beta_ops', 'Stray')
    const foreignDep = dep('dep_beta_ops', 'ops', 'Beta ops', { companyId: 'co_beta' })
    for (const explicitBy of ['human', 'rule'] as const) {
      const d = route(task({ agentId: 'agt_s' }), ctx({ departments: [dev, mkt, foreignDep], agents: [stray, copy], explicitBy }))
      expect(d).toMatchObject({ departmentId: null, agentId: null, reason: "Stray's department not found; no routing rule matched; stays in triage" })
    }
  })
  it('a company-level agent never carries a foreign or dangling department id of the task into the decision', () => {
    const lead = agent('agt_lead', null, 'Lead')
    const foreignDep = dep('dep_beta_ops', 'ops', 'Beta ops', { companyId: 'co_beta' })
    for (const departmentId of ['dep_beta_ops', 'dep_gone']) {
      const d = route(task({ agentId: 'agt_lead', departmentId }), ctx({ departments: [dev, mkt, foreignDep], agents: [lead, copy] }))
      expect(d).toMatchObject({ departmentId: null, agentId: 'agt_lead' })
    }
    expect(route(task({ agentId: 'agt_lead', departmentId: 'dep_mkt' }), ctx({ agents: [lead, copy] }))).toMatchObject({ departmentId: 'dep_mkt', agentId: 'agt_lead' })
  })
  it('suggestRoute spends no model call on a task already placed or out of triage', async () => {
    const call = vi.fn<ModelCall>(async () => '{"departmentKey":"marketing","agentId":null,"confidence":1,"reason":"x"}')
    expect(await suggestRoute(task({ departmentId: 'dep_mkt' }), ctx(), { call })).toBeNull()
    expect(await suggestRoute(task({ agentId: 'agt_copy' }), ctx(), { call })).toBeNull()
    expect(await suggestRoute(task({ status: 'todo' }), ctx(), { call })).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('a nonsense timeout falls back to 20 s and a throwing redactor never escapes', async () => {
    for (const timeoutMs of [0, -5, Number.NaN, Infinity]) {
      const spy = vi.fn<ModelCall>(async () => '{}')
      await suggestRoute(task(), ctx(), { call: spy, timeoutMs })
      expect(spy.mock.calls[0][0].timeoutMs).toBe(SUGGEST_TIMEOUT_MS)
    }
    let n = 0
    const flaky = (s: string) => { if (++n > 1 && s.includes('copy')) throw new Error('vault locked'); return s }
    // redaction of the input works, the reason's redaction throws: null, not a rejection
    const call = vi.fn<ModelCall>(async () => '{"departmentKey":"marketing","agentId":null,"confidence":1,"reason":"copy"}')
    await expect(suggestRoute(task({ title: 'plain' }), ctx({ departments: [mkt], agents: [] }), { call, redact: flaky })).resolves.toBeNull()
    expect(n).toBeGreaterThan(1)
    await expect(suggestRoute(task(), ctx(), { call, redact: () => { throw new Error('vault locked') } })).resolves.toBeNull()
  })
  it('a late suggestion never overwrites a routing that placed the task', () => {
    expect(suggestionApplies({ status: 'triage', departmentId: null, agentId: null, routing: null })).toBe(true)
    expect(suggestionApplies({ status: 'triage', departmentId: null, agentId: null, routing: { departmentId: null, agentId: null, by: 'rule', reason: 'no routing rule matched' } })).toBe(true)
    expect(suggestionApplies({ status: 'triage', departmentId: null, agentId: null, routing: { departmentId: 'dep_dev', agentId: null, by: 'model', reason: 'older suggestion' } })).toBe(true)
    // the human routed (or a rule did) while the model ran
    expect(suggestionApplies({ status: 'todo', departmentId: 'dep_mkt', agentId: null, routing: { departmentId: 'dep_mkt', agentId: null, by: 'human', reason: 'x' } })).toBe(false)
    expect(suggestionApplies({ status: 'triage', departmentId: null, agentId: 'agt_ceo', routing: null })).toBe(false)
    expect(suggestionApplies({ status: 'triage', departmentId: null, agentId: null, routing: { departmentId: 'dep_mkt', agentId: null, by: 'human', reason: 'cleared later' } })).toBe(false)
    expect(suggestionApplies({ status: 'canceled', departmentId: null, agentId: null })).toBe(false)
  })
})
