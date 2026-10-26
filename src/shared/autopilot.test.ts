import { describe, expect, it } from 'vitest'
import type { CompanyAgent, Department } from './company'
import { agentFor, AUTOPILOT_STEPS, buildStep, contentChannels, departmentFor, missingFor, planAutopilot, planStep, setAutopilot, stepPrompt, withStep, type AutopilotContext } from './autopilot'
import { socialStatuses, SOCIAL_CHANNELS } from './socials'
import type { GatewayConnection } from './gateway'

const dep = (id: string, key: string, name = key[0]!.toUpperCase() + key.slice(1), p: Partial<Department> = {}): Department =>
  ({ id, companyId: 'co_a', key, name, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} as Department['data'], ...p }) as Department
const agent = (id: string, departmentId: string | null, p: Partial<CompanyAgent> = {}): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId, kind: 'profile', refId: 'prof_claude', name: `Agent ${id}`, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '',
    data: { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } }, ...p }) as CompanyAgent

const socialsWith = (keys: string[], connections: GatewayConnection[] = []) => socialStatuses('co_a', new Set(keys), connections)
const LINKEDIN = ['LINKEDIN_ACCESS_TOKEN']

const ctx = (p: Partial<AutopilotContext> = {}): AutopilotContext => ({
  companyId: 'co_a',
  companyName: 'Sunday Bakery',
  departmentsOn: true,
  departments: [dep('dep_m', 'marketing'), dep('dep_f', 'finance'), dep('dep_o', 'ops')],
  agents: [agent('agt_m', 'dep_m'), agent('agt_f', 'dep_f'), agent('agt_o', 'dep_o')],
  dashboards: [{ kind: 'gsc', departmentId: 'dep_m' }, { kind: 'stripe', departmentId: 'dep_f' }],
  socials: socialsWith(LINKEDIN),
  profiles: [{ id: 'prof_claude', adapter: 'claude', name: 'Claude' }, { id: 'prof_sh', adapter: 'shell', name: 'Shell' }],
  defaultAdapter: 'claude',
  tz: 'Europe/Madrid',
  passport: { mission: 'Bread for the neighbourhood', audience: '', products: 'Sourdough' },
  ...p
})

describe('socials', () => {
  it('a channel is ready when every required key resolves, partial when some do', () => {
    const st = socialsWith(['X_API_KEY', 'X_API_SECRET', ...LINKEDIN])
    expect(st.find((s) => s.id === 'linkedin')).toMatchObject({ state: 'key', ready: true, canPost: true, missingKeys: [] })
    expect(st.find((s) => s.id === 'x')).toMatchObject({ state: 'partial', ready: false, missingKeys: ['X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] })
    expect(st.find((s) => s.id === 'tiktok')).toMatchObject({ state: 'missing', ready: false })
  })
  it('YouTube with a key is ready but read-only (no uploads without Google sign-in)', () => {
    expect(socialsWith(['YOUTUBE_API_KEY']).find((s) => s.id === 'youtube')).toMatchObject({ ready: true, canPost: false })
  })
  it('an enabled, signed-in MCP connection that names the network counts, scoped to the company', () => {
    const conn = (p: Partial<GatewayConnection>): GatewayConnection => ({ id: 'li', name: 'LinkedIn MCP', transport: 'http', url: 'https://mcp.example/linkedin', enabled: true, roots: [], authentication: 'oauth', authStatus: 'connected', hasCredentials: false, ...p })
    expect(socialsWith([], [conn({})]).find((s) => s.id === 'linkedin')).toMatchObject({ state: 'mcp', ready: true, connection: 'LinkedIn MCP' })
    expect(socialsWith([], [conn({ authStatus: 'disconnected' })]).find((s) => s.id === 'linkedin')!.ready).toBe(false)
    expect(socialsWith([], [conn({ enabled: false })]).find((s) => s.id === 'linkedin')!.ready).toBe(false)
    expect(socialsWith([], [conn({ companyIds: ['co_b'] })]).find((s) => s.id === 'linkedin')!.ready).toBe(false)
    expect(socialsWith([], [conn({ companyIds: ['co_a'] })]).find((s) => s.id === 'linkedin')!.ready).toBe(true)
  })
  it('every channel links to its official developer setup over https', () => {
    for (const c of SOCIAL_CHANNELS) {
      expect(c.docs).toMatch(/^https:\/\//)
      expect(c.keys.every((k) => /^[A-Z_][A-Z0-9_]*$/.test(k.name))).toBe(true)
    }
  })
})

describe('planning', () => {
  it('everything connected: every step of both autopilots is ready', () => {
    for (const id of ['marketing', 'company'] as const) {
      const plans = planAutopilot(id, ctx())
      expect(plans.map((p) => [p.def.id, p.ready])).toEqual(plans.map((p) => [p.def.id, true]))
      expect(missingFor(plans)).toEqual([])
    }
  })
  it('departments off: task steps are blocked once by "Turn on departments"; the workflow step still runs', () => {
    const plans = planAutopilot('marketing', ctx({ departmentsOn: false }))
    expect(plans.find((p) => p.def.id === 'seo_report')!.missing.map((m) => m.fix)).toEqual(['departments'])
    expect(plans.find((p) => p.def.id === 'competitors')).toMatchObject({ ready: true, departmentId: null, profileId: 'prof_claude' })
    expect(missingFor(plans).map((m) => m.label)).toEqual(['Turn on departments'])
  })
  it('the SEO report needs a Marketing agent and a Marketing dashboard', () => {
    const noDash = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'seo_report')!, ctx({ dashboards: [{ kind: 'stripe', departmentId: 'dep_f' }] }))
    expect(noDash.ready).toBe(false)
    expect(noDash.missing).toEqual([expect.objectContaining({ fix: 'marketingDashboards', departmentId: 'dep_m', label: 'Add a Search Console, AI visibility, Plausible or PostHog dashboard in Marketing' })])
    const noAgent = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'seo_report')!, ctx({ agents: [agent('agt_f', 'dep_f')] }))
    expect(noAgent.missing).toEqual([expect.objectContaining({ fix: 'agents', label: 'Add an agent to Marketing', departmentId: 'dep_m' })])
  })
  it('a paused, archived or workflow-backed seat is not an agent for a step', () => {
    const plans = (agents: CompanyAgent[]) => planStep(AUTOPILOT_STEPS.find((s) => s.id === 'finance')!, ctx({ agents }))
    expect(plans([agent('agt_f', 'dep_f', { pausedAt: 'x' })]).ready).toBe(false)
    expect(plans([agent('agt_f', 'dep_f', { archivedAt: 'x' })]).ready).toBe(false)
    expect(plans([agent('agt_f', 'dep_f', { kind: 'workflow' })]).ready).toBe(false)
    expect(plans([agent('agt_f', 'dep_f')]).ready).toBe(true)
  })
  it('no Finance department: the finance digest asks for one', () => {
    const p = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'finance')!, ctx({ departments: [dep('dep_m', 'marketing')] }))
    expect(p.missing.map((m) => m.label)).toEqual(['Add a Finance department with an agent'])
  })
  it('a custom department matches by name (Growth behaves like Marketing)', () => {
    const c = ctx({ departments: [dep('dep_g', 'growth', 'Growth')], agents: [agent('agt_g', 'dep_g')], dashboards: [{ kind: 'geo', departmentId: 'dep_g' }] })
    expect(departmentFor(c, 'marketing')?.id).toBe('dep_g')
    expect(planStep(AUTOPILOT_STEPS.find((s) => s.id === 'seo_report')!, c)).toMatchObject({ ready: true, departmentId: 'dep_g' })
  })
  it('content needs a ready social channel', () => {
    const p = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'content')!, ctx({ socials: socialsWith([]) }))
    expect(p.missing.map((m) => m.fix)).toEqual(['socials'])
  })
  it('the lead agent: Ops first, then a company-level agent, then anyone', () => {
    expect(agentFor(ctx(), 'lead')?.id).toBe('agt_o')
    expect(agentFor(ctx({ agents: [agent('agt_m', 'dep_m'), agent('agt_c', null)] }), 'lead')?.id).toBe('agt_c')
    expect(agentFor(ctx({ agents: [agent('agt_m', 'dep_m')] }), 'lead')?.id).toBe('agt_m')
    expect(agentFor(ctx({ agents: [] }), 'lead')).toBeNull()
  })
  it('the workflow step needs a non-shell profile', () => {
    const p = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'competitors')!, ctx({ profiles: [{ id: 'prof_sh', adapter: 'shell', name: 'Shell' }] }))
    expect(p.missing.map((m) => m.fix)).toEqual(['profile'])
  })
})

describe('building', () => {
  it('a task step is a task-mode schedule for its agent and department, in the user tz', () => {
    const c = ctx()
    const plan = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'seo_report')!, c)
    const b = buildStep(plan, c)
    expect(b.workflow).toBeNull()
    const s = b.schedule(null)
    expect(s).toMatchObject({ name: 'Weekly SEO and AI-visibility report', departmentId: 'dep_m', enabled: true, companyId: 'co_a', when: { kind: 'cron', cron: '0 9 * * 1', tz: 'Europe/Madrid' } })
    expect(s.target).toMatchObject({ kind: 'prompt', profileId: 'prof_claude', repoId: null, mode: 'task', agentId: 'agt_m' })
    if (s.target.kind === 'prompt') {
      expect(s.target.prompt).toContain('SEO · Search Console')
      expect(s.target.prompt).toContain('Mission: Bread for the neighbourhood')
      expect(s.target.prompt).toMatch(/Do not send emails/)
    }
  })
  it('a blocked step refuses to build', () => {
    const c = ctx({ dashboards: [] })
    expect(() => buildStep(planStep(AUTOPILOT_STEPS.find((s) => s.id === 'seo_report')!, c), c)).toThrow(/not ready/)
  })
  it('content drafts only, unless a channel that can post is allowed explicitly', () => {
    const c = ctx({ socials: socialsWith([...LINKEDIN, 'YOUTUBE_API_KEY']) })
    const def = AUTOPILOT_STEPS.find((s) => s.id === 'content')!
    const drafts = stepPrompt(def, c)
    expect(drafts).toContain('- LinkedIn: drafts only. Do not publish.')
    expect(drafts).toContain('- YouTube: drafts only. Do not publish.')
    const allowed = stepPrompt(def, c, ['linkedin', 'youtube'])
    expect(allowed).toMatch(/- LinkedIn: publishing is on\. Publish a draft only after the human approves it/)
    // YouTube's key cannot upload: allowing it changes nothing
    expect(allowed).toContain('- YouTube: drafts only. Do not publish.')
    expect(contentChannels(c.socials, ['linkedin', 'youtube', 'x']).publish.map((s) => s.id)).toEqual(['linkedin'])
  })
  it('the competitor watch is a workflow (agent + notify) the schedule targets; it needs a competitor list', () => {
    const c = ctx({ dashboards: [{ kind: 'geo', departmentId: 'dep_m', competitors: ['Globex', ' Initech ', 'Globex'] }] })
    const plan = planStep(AUTOPILOT_STEPS.find((s) => s.id === 'competitors')!, c)
    const b = buildStep(plan, c)
    expect(b.workflow).toMatchObject({ name: 'Competitor watch · Sunday Bakery', companyId: 'co_a', inputs: [{ name: 'competitors', default: 'Globex\nInitech' }] })
    expect(b.workflow!.nodes.map((n) => [n.id, n.type, n.after])).toEqual([['research', 'agent', []], ['tell', 'notify', ['research']]])
    expect(b.schedule('wf_1')).toMatchObject({ target: { kind: 'workflow', workflowId: 'wf_1', inputs: { competitors: 'Globex\nInitech' } }, departmentId: 'dep_m', when: { cron: '0 9 * * 4' } })
    expect(() => buildStep(plan, ctx({ dashboards: [] }))).toThrow(/at least one competitor/)
    expect(buildStep(plan, ctx({ dashboards: [] }), { competitors: 'Acme\n\n' }).schedule('wf_1').target).toMatchObject({ inputs: { competitors: 'Acme' } })
  })
  it('enabled: false builds a paused schedule', () => {
    const c = ctx()
    expect(buildStep(planStep(AUTOPILOT_STEPS.find((s) => s.id === 'triage')!, c), c, { enabled: false }).schedule(null).enabled).toBe(false)
  })
})

describe('records', () => {
  it('withStep keeps the first enable time and adds steps', () => {
    const a = withStep(undefined, 'seo_report', { scheduleId: 'sch_1' }, 'T1', [])
    const b = withStep(a, 'content', { scheduleId: 'sch_2' }, 'T2', ['linkedin'])
    expect(b).toEqual({ enabledAt: 'T1', paused: false, publish: ['linkedin'], steps: { seo_report: { scheduleId: 'sch_1' }, content: { scheduleId: 'sch_2' } } })
  })
  it('setAutopilot replaces one record and drops an emptied company', () => {
    const rec = withStep(undefined, 'triage', { scheduleId: 'sch_1' }, 'T', [])
    const one = setAutopilot(undefined, 'co_a', 'company', rec)
    expect(one).toEqual({ co_a: { company: rec } })
    const two = setAutopilot(one, 'co_a', 'marketing', rec)
    expect(Object.keys(two.co_a!)).toEqual(['company', 'marketing'])
    expect(setAutopilot(setAutopilot(two, 'co_a', 'company', undefined), 'co_a', 'marketing', undefined)).toEqual({})
    expect(one).toEqual({ co_a: { company: rec } }) // never mutated
  })
})
