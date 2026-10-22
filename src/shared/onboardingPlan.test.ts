import { describe, expect, it } from 'vitest'
import {
  EMPTY_ANSWERS,
  GOALS,
  OnboardingPlan,
  PLAN_CAPS,
  WORKFLOW_KEYS,
  workflowsForKeys,
  type GoalKey,
  type OnboardingAvailable,
  type OnboardingPlan as Plan,
  type PlanAdapter,
  type PlanInput
} from './onboarding'
import {
  AUTO_ROLES,
  CONTENT_AGENT_RULE,
  TASK_REVIEW_SUFFIX,
  applyAgentPlan,
  defaultGoals,
  effectiveGoals,
  finalizePlan,
  inputsHash,
  isPlanStale,
  needsContentStep,
  planCounts,
  scheduleCostly,
  siteHost,
  templatePlan,
  validatePlan,
  type ScreenFn
} from './onboardingPlan'

const screen: ScreenFn = (t) => (/\bsk-[A-Za-z0-9_-]{20,}/.test(t) ? 'sk- API key' : null)

function input(o: { goals?: GoalKey[]; hasCode?: boolean; fal?: boolean; openai?: boolean; departmentsOn?: boolean; answers?: Partial<PlanInput['answers']> } = {}): PlanInput {
  return {
    hasCode: o.hasCode ?? false,
    answers: {
      ...EMPTY_ANSWERS,
      name: 'Sunday Bakery',
      oneLiner: 'Sourdough delivered to offices in Lisbon',
      products: 'Sourdough loaves and pastries',
      audience: 'Office managers in Lisbon',
      siteUrl: 'sundaybakery.com',
      goals: o.goals ?? ['website', 'social'],
      goalOther: 'Find a second oven supplier',
      ...o.answers
    },
    keys: { fal: o.fal ?? false, openai: o.openai ?? false },
    departmentsOn: o.departmentsOn ?? true,
    tz: 'Europe/Lisbon'
  }
}

function avail(o: { hasCode?: boolean; fal?: boolean; openai?: boolean; departmentsOn?: boolean; adapters?: PlanAdapter[] } = {}): OnboardingAvailable {
  return {
    workflows: workflowsForKeys({ FAL_KEY: !!o.fal, OPENAI_API_KEY: !!o.openai }),
    profileAdapters: o.adapters ?? ['claude', 'codex'],
    hasCode: o.hasCode ?? false,
    departmentsOn: o.departmentsOn ?? true
  }
}

function subsets<T>(items: readonly T[], max: number): T[][] {
  const out: T[][] = [[]]
  const walk = (start: number, cur: T[]): void => {
    for (let i = start; i < items.length; i++) {
      const next = [...cur, items[i]]
      out.push(next)
      if (next.length < max) walk(i + 1, next)
    }
  }
  walk(0, [])
  return out
}

const allText = (p: Plan): string[] => [
  p.summary,
  ...p.departments.flatMap((d) => [d.name, d.charter?.does ?? '', d.charter?.doesNot ?? '']),
  ...p.agents.flatMap((a) => [a.name, a.instructions, a.capabilities]),
  ...p.tasks.flatMap((t) => [t.title, t.description]),
  ...p.schedules.flatMap((s) => [s.name, ...(s.target.kind === 'task' ? [s.target.title, s.target.description] : Object.values(s.target.inputs ?? {}))])
]

/** Template refs per goal, used to check "every goal has a task". */
const GOAL_REFS: Record<GoalKey, string[]> = {
  customers: ['customer-profile', 'outreach-drafts'],
  website: ['site-review', 'landing-page', 'hero-images'],
  social: ['content-calendar', 'brand-kit'],
  ads: ['ad-angles'],
  seo: ['seo-keywords', 'seo-technical'],
  ship: ['fix-top-issue'],
  support: ['support-faq'],
  other: ['other-plan']
}

describe('templatePlan × validatePlan (every goal subset ≤ 3 × code × fal × departments)', () => {
  const combos = subsets(GOALS, 3)
  it('enumerates 93 goal subsets', () => expect(combos.length).toBe(93))

  for (const hasCode of [false, true])
    for (const fal of [false, true])
      for (const departmentsOn of [false, true]) {
        it(`code=${hasCode} fal=${fal} departments=${departmentsOn}`, () => {
          const a = avail({ hasCode, fal, departmentsOn })
          for (const goals of combos) {
            const inp = input({ goals, hasCode, fal, departmentsOn })
            const plan = templatePlan(inp, a, { screen })
            const label = `${goals.join(',') || '(none)'}`

            // schema
            const parsed = OnboardingPlan.safeParse(plan)
            expect(parsed.success, `${label}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true)

            // validates with no drops and no changes
            const v = validatePlan(plan, { available: a, screen, input: inp })
            expect(v.dropped, label).toEqual([])
            expect(v.ok).toBe(true)
            expect(v.plan).toEqual(plan)

            // caps
            expect(plan.departments.length).toBeLessThanOrEqual(PLAN_CAPS.departments)
            expect(plan.agents.length).toBeLessThanOrEqual(PLAN_CAPS.agents)
            expect(plan.tasks.length).toBeLessThanOrEqual(PLAN_CAPS.tasks)
            expect(plan.schedules.length).toBeLessThanOrEqual(PLAN_CAPS.schedules)

            // every effective goal has a task
            const eff = effectiveGoals(goals, hasCode, true)
            for (const g of eff) expect(plan.tasks.some((t) => GOAL_REFS[g].includes(t.ref)), `${label}: goal ${g} has no task`).toBe(true)

            // no workflow without its key
            for (const s of plan.schedules) if (s.target.kind === 'workflow') expect(a.workflows).toContain(s.target.workflow)
            if (!fal) {
              expect(plan.schedules.some(scheduleCostly)).toBe(false)
              expect(plan.tasks.some((t) => /landing-hero-images|brand-kit-starter|ad-creative-variants/.test(t.description))).toBe(false)
            }

            // schedules carry no enabled flag (created disabled at launch); weekly review always there
            for (const s of plan.schedules) expect(s).not.toHaveProperty('enabled')
            expect(plan.schedules.some((s) => s.target.kind === 'workflow' && s.target.workflow === 'weekly-company-review')).toBe(true)

            // no Development or repo work without code
            if (!hasCode) {
              expect(plan.departments.some((d) => d.key === 'development')).toBe(false)
              expect(plan.tasks.some((t) => t.where === 'repo' || t.departmentKey === 'development')).toBe(false)
            } else {
              expect(plan.tasks.some((t) => t.ref === 'audit-repo')).toBe(true)
            }

            // departments consent
            if (!departmentsOn) {
              expect(plan.departments).toEqual([])
              expect(plan.agents).toEqual([])
              expect(plan.tasks.every((t) => t.departmentKey === null && t.agentRef === null)).toBe(true)
              expect(plan.schedules.every((s) => s.target.kind === 'workflow' && s.departmentKey === null)).toBe(true)
            }

            // copy rules
            for (const t of plan.tasks) {
              expect(t.description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
              expect(t.description).toContain('Deliverable: ')
            }
            for (const s of plan.schedules) if (s.target.kind === 'task') expect(s.target.description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
            for (const ag of plan.agents) {
              if (ag.role === 'content') expect(ag.instructions).toContain(CONTENT_AGENT_RULE)
              expect(ag.auto).toBe(AUTO_ROLES.includes(ag.role))
            }
            // refs unique
            for (const list of [plan.agents, plan.tasks, plan.schedules]) expect(new Set(list.map((x) => x.ref)).size).toBe(list.length)
          }
        })
      }

  it('interpolates name, one-liner, products, audience and voice', () => {
    const inp = input({ goals: ['social', 'customers'], answers: { voiceVibe: 'bold', voiceText: 'short sentences', avoid: 'cheap' } })
    const plan = templatePlan(inp, avail())
    const text = allText(plan).join('\n')
    for (const s of ['Sunday Bakery', 'Sourdough delivered to offices in Lisbon', 'Sourdough loaves and pastries', 'Office managers in Lisbon', 'bold and punchy', 'short sentences', 'avoid: cheap'])
      expect(text).toContain(s)
  })

  it('adds the carousel schedule with templated inputs only with fal', () => {
    const withFal = templatePlan(input({ goals: ['social'] }), avail({ fal: true }))
    const car = withFal.schedules.find((s) => s.ref === 'carousel')!
    expect(car.target).toMatchObject({ kind: 'workflow', workflow: 'social-post-carousel', inputs: { voice: 'friendly and warm' } })
    expect(car.cadence).toBe('mwf1030')
    expect(car.target.kind === 'workflow' && car.target.inputs?.topic).toContain('Office managers in Lisbon')
    expect(withFal.tasks.map((t) => t.ref)).toContain('brand-kit')
    expect(templatePlan(input({ goals: ['social'] }), avail()).schedules.some((s) => s.ref === 'carousel')).toBe(false)
  })

  it('second-opinion review only with Codex installed', () => {
    const inp = input({ goals: ['ship'], hasCode: true })
    expect(templatePlan(inp, avail({ hasCode: true })).schedules.some((s) => s.ref === 'second-opinion')).toBe(true)
    expect(templatePlan(inp, avail({ hasCode: true, adapters: ['claude'] })).schedules.some((s) => s.ref === 'second-opinion')).toBe(false)
  })

  it('caps schedules but keeps the weekly review, and caps tasks for many goals', () => {
    const inp = input({ goals: ['ship', 'social', 'seo', 'website', 'customers', 'ads', 'support', 'other'], hasCode: true, fal: true })
    const a = avail({ hasCode: true, fal: true })
    const plan = templatePlan(inp, a)
    expect(plan.schedules.length).toBe(PLAN_CAPS.schedules)
    expect(plan.schedules.some((s) => s.ref === 'weekly-review')).toBe(true)
    expect(plan.tasks.length).toBeLessThanOrEqual(PLAN_CAPS.tasks)
    expect(plan.departments.length).toBeLessThanOrEqual(PLAN_CAPS.departments)
    expect(OnboardingPlan.safeParse(plan).success).toBe(true)
    expect(validatePlan(plan, { available: a, input: inp }).dropped).toEqual([])
  })

  it('uses the S4 defaults when no goal is picked, and drops ship without code', () => {
    expect(defaultGoals(true, false)).toEqual(['ship', 'website'])
    expect(defaultGoals(true, true)).toEqual(['ship', 'social'])
    expect(defaultGoals(false, true)).toEqual(['website', 'social'])
    expect(effectiveGoals(['ship'], false, false)).toEqual(['website', 'social'])
    expect(effectiveGoals(['ads', 'ads', 'seo'], false, false)).toEqual(['ads', 'seo'])
    expect(needsContentStep(['customers', 'support'])).toBe(false)
    expect(needsContentStep(['customers', 'seo'])).toBe(true)
  })

  it('picks an installed adapter', () => {
    const plan = templatePlan(input(), avail({ adapters: ['gemini'] }))
    expect(plan.agents.every((a) => a.adapter === 'gemini')).toBe(true)
  })

  it('cleans foreign links, paths and secrets out of answers', () => {
    const inp = input({
      goals: ['social', 'other'],
      answers: {
        oneLiner: 'Bread, see https://evil.example/x and /Users/me/secret.txt or ~/notes',
        products: 'Loaves sk-abcdefghijklmnopqrstuvwxyz123456',
        audience: 'Offices (more at https://www.sundaybakery.com/about)',
        goalOther: 'Read C:\\stuff\\plan.doc'
      }
    })
    const a = avail()
    const plan = templatePlan(inp, a, { screen })
    const text = allText(plan).join('\n')
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain('/Users/me')
    expect(text).not.toContain('~/notes')
    expect(text).not.toContain('sk-abc')
    expect(text).not.toContain('C:\\')
    expect(text).toContain('https://www.sundaybakery.com/about')
    expect(validatePlan(plan, { available: a, screen, input: inp }).dropped).toEqual([])
  })

  it('runs in under 10 ms for the largest input', () => {
    const big = 'x'.repeat(480)
    const inp = input({
      goals: [...GOALS],
      hasCode: true,
      fal: true,
      answers: { name: 'N'.repeat(80), oneLiner: big.slice(0, 200), products: big, audience: big, voiceText: big.slice(0, 600), avoid: big.slice(0, 300), goalOther: big.slice(0, 120) }
    })
    const a = avail({ hasCode: true, fal: true, openai: true })
    templatePlan(inp, a, { screen })
    const runs = 20
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) templatePlan(inp, a, { screen })
    expect((performance.now() - t0) / runs).toBeLessThan(10)
    expect(OnboardingPlan.safeParse(templatePlan(inp, a, { screen })).success).toBe(true)
    // Long answers never clip the safety lines off agent instructions or task descriptions.
    const words = 'word '.repeat(120).trim()
    const long = templatePlan(input({ goals: ['social', 'customers', 'support', 'other'], hasCode: true, answers: { oneLiner: words.slice(0, 200), products: words, audience: words, voiceText: words, avoid: words.slice(0, 300) } }), a)
    expect(long.agents.find((x) => x.role === 'content')!.instructions.endsWith(CONTENT_AGENT_RULE)).toBe(true)
    const short = templatePlan(input({ goals: ['social', 'customers', 'support', 'other'], hasCode: true }), a)
    for (const ag of long.agents) expect(ag.instructions.endsWith(short.agents.find((x) => x.ref === ag.ref)!.instructions.slice(-100)), ag.ref).toBe(true)
    for (const t of long.tasks) expect(t.description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
  })
})

describe('validatePlan repair', () => {
  const inp = input({ goals: ['social', 'customers'], hasCode: true })
  const a = avail({ hasCode: true })
  const base = (): Plan => structuredClone(templatePlan(inp, a))

  it('drops a duplicate ref', () => {
    const p = base()
    p.tasks.push({ ...p.tasks[0] })
    const v = validatePlan(p, { available: a })
    expect(v.dropped).toEqual([{ kind: 'task', ref: p.tasks[0].ref, reason: 'duplicate ref' }])
    expect(v.plan.tasks.length).toBe(p.tasks.length - 1)
  })

  it('drops tasks with unresolved agent, department or dependency, and their dependents', () => {
    const p = base()
    p.tasks.find((t) => t.ref === 'customer-profile')!.agentRef = 'ghost-agent'
    const v = validatePlan(p, { available: a })
    expect(v.dropped.map((d) => d.ref)).toEqual(['customer-profile', 'outreach-drafts'])
    expect(v.plan.tasks.some((t) => t.ref === 'outreach-drafts')).toBe(false)
  })

  it('drops an agent whose department is missing, then its tasks and schedules', () => {
    const p = base()
    p.departments = p.departments.filter((d) => d.key !== 'marketing')
    const v = validatePlan(p, { available: a })
    const refs = v.dropped.map((d) => d.ref)
    expect(refs).toEqual(expect.arrayContaining(['content-writer', 'content-calendar', 'weekly-posts']))
    expect(v.plan.agents.some((x) => x.departmentKey === 'marketing')).toBe(false)
  })

  it('breaks cycles by dropping the tasks in them and their dependents', () => {
    const p = base()
    const ids = p.tasks.map((t) => t.ref)
    const audit = p.tasks.find((t) => t.ref === 'audit-repo')!
    const cal = p.tasks.find((t) => t.ref === 'content-calendar')!
    audit.dependsOn = ['content-calendar']
    cal.dependsOn = ['audit-repo']
    const v = validatePlan(p, { available: a })
    expect(v.dropped.filter((d) => d.reason === 'dependency cycle').map((d) => d.ref).sort()).toEqual(['audit-repo', 'content-calendar'])
    expect(v.plan.tasks.map((t) => t.ref)).toEqual(ids.filter((r) => r !== 'audit-repo' && r !== 'content-calendar'))
  })

  it('drops self-dependencies', () => {
    const p = base()
    p.tasks[0].dependsOn = [p.tasks[0].ref]
    expect(validatePlan(p, { available: a }).dropped[0]).toMatchObject({ ref: p.tasks[0].ref, reason: 'depends on itself' })
  })

  it('drops workflows that are not available and undeclared inputs', () => {
    const p = base()
    p.schedules.push({ ref: 'carousel', name: 'Carousel', departmentKey: 'marketing', cadence: 'mwf10', target: { kind: 'workflow', workflow: 'social-post-carousel' }, include: true })
    p.schedules[0] = { ...p.schedules[0] }
    const review = p.schedules.find((s) => s.ref === 'weekly-review')!
    if (review.target.kind === 'workflow') review.target.inputs = { context: 'ok', secretSauce: 'x' }
    const v = validatePlan(p, { available: a })
    expect(v.dropped).toEqual(
      expect.arrayContaining([
        { kind: 'schedule', ref: 'carousel', reason: 'workflow social-post-carousel is not available' },
        { kind: 'schedule', ref: 'weekly-review', reason: 'input secretSauce is not declared by weekly-company-review' }
      ])
    )
  })

  it('drops tasks that tell you to run an unavailable workflow', () => {
    const p = base()
    p.tasks[1].description = 'Click Run on landing-hero-images. ' + p.tasks[1].description
    expect(validatePlan(p, { available: a }).dropped[0]).toMatchObject({ ref: p.tasks[1].ref, reason: 'workflow landing-hero-images is not available' })
    expect(validatePlan(p, { available: avail({ hasCode: true, fal: true }) }).dropped).toEqual([])
  })

  it('rewrites an adapter that is not installed', () => {
    const p = base()
    p.agents[0].adapter = 'cursor'
    const v = validatePlan(p, { available: avail({ hasCode: true, adapters: ['codex'] }) })
    expect(v.dropped).toEqual([])
    expect(v.plan.agents.every((x) => x.adapter === 'codex')).toBe(true)
  })

  it('drops Development and repo work without code', () => {
    const p = base()
    const noCode = avail({ hasCode: false })
    const v = validatePlan(p, { available: noCode })
    expect(v.dropped.find((d) => d.kind === 'department')).toEqual({ kind: 'department', ref: 'development', reason: 'Development needs code' })
    expect(v.plan.departments.some((d) => d.key === 'development')).toBe(false)
    expect(v.plan.tasks.some((t) => t.where === 'repo')).toBe(false)
    expect(v.plan.agents.some((x) => x.ref === 'repo-auditor')).toBe(false)

    const q = base()
    const t = q.tasks.find((x) => x.ref === 'content-calendar')!
    t.where = 'repo'
    expect(validatePlan(q, { available: noCode }).dropped).toEqual(expect.arrayContaining([{ kind: 'task', ref: 'content-calendar', reason: 'repo work needs code' }]))
  })

  it('drops secrets, foreign links and paths; keeps the business site', () => {
    const p = base()
    const by = (r: string) => p.tasks.find((t) => t.ref === r)!
    const [t0, t1, t2, t3] = [by('audit-repo'), by('content-calendar'), by('outreach-drafts'), by('customer-profile')]
    t0.description = `Use key sk-${'a'.repeat(30)} ` + t0.description
    t1.title = 'Read https://competitor.example/pricing'
    t2.description = 'Look in /Users/me/Desktop/plan.md ' + t2.description
    t3.description = 'Check https://www.sundaybakery.com/menu and https://shop.sundaybakery.com ' + t3.description
    const v = validatePlan(p, { available: a, screen, siteUrl: 'https://sundaybakery.com' })
    const why = Object.fromEntries(v.dropped.filter((d) => d.kind === 'task').map((d) => [d.ref, d.reason]))
    expect(why[t0.ref]).toBe('secret: sk- API key')
    expect(why[t1.ref]).toBe('link to another site')
    expect(why[t2.ref]).toBe('file path')
    expect(why[t3.ref]).toBeUndefined()
    // home paths, Windows paths, file URLs
    for (const bad of ['~/notes.md', 'C:\\Users\\x', 'file:///etc/passwd', 'see $HOME']) {
      const q = base()
      q.agents[0].instructions = `${bad} ${q.agents[0].instructions}`
      expect(validatePlan(q, { available: a }).dropped[0], bad).toMatchObject({ kind: 'agent', reason: 'file path' })
    }
    // relative paths are fine
    const r = base()
    r.agents[0].instructions = 'Write to content/calendar.md and src/app/page.tsx. ' + r.agents[0].instructions
    expect(validatePlan(r, { available: a }).dropped).toEqual([])
  })

  it('rejects own-site links that carry credentials or spoof the host', () => {
    for (const url of ['https://evil.com\\@sundaybakery.com', 'https://evil.com\\.sundaybakery.com/x', 'https://u:pw@sundaybakery.com/x', 'https://sundaybakery.com@evil.com']) {
      const p = base()
      p.tasks[0].description = `See ${url} ` + p.tasks[0].description
      expect(validatePlan(p, { available: a, siteUrl: 'sundaybakery.com' }).dropped[0], url).toMatchObject({ kind: 'task', reason: 'link to another site' })
    }
    const t = templatePlan(input({ answers: { products: 'Bread, see https://u:pw@sundaybakery.com/menu' } }), avail())
    expect(allText(t).join('\n')).not.toContain('u:pw')
  })

  it('without a known site, any link is foreign', () => {
    const p = base()
    p.tasks[0].description = 'See https://sundaybakery.com. ' + p.tasks[0].description
    expect(validatePlan(p, { available: a }).dropped[0]).toMatchObject({ reason: 'link to another site' })
    expect(validatePlan(p, { available: a, input: inp }).dropped).toEqual([])
  })

  it('replaces a bad summary instead of dropping the plan', () => {
    const p = base()
    p.summary = 'Visit https://spam.example now'
    const v = validatePlan(p, { available: a, input: inp })
    expect(v.dropped).toEqual([{ kind: 'summary', ref: 'summary', reason: 'link to another site' }])
    expect(v.plan.summary).toBe('A focused first week for Sunday Bakery.')
  })

  it('refills a goal emptied by repair from the template', () => {
    const agentPlan: Plan = {
      version: 1,
      summary: 'Plan',
      departments: [{ key: 'sales', name: 'Sales', include: true }],
      agents: [{ ref: 'hunter', departmentKey: 'sales', name: 'Hunter', role: 'researcher', adapter: 'claude', instructions: 'Find leads.', capabilities: 'Leads', auto: false, include: true }],
      tasks: [
        { ref: 'leads', title: 'Find leads at https://evil.example', description: 'Find leads.', departmentKey: 'sales', agentRef: 'hunter', priority: 2, dependsOn: [], where: 'workspace', include: true }
      ],
      schedules: []
    }
    const i2 = input({ goals: ['customers'] })
    const v = validatePlan(agentPlan, { available: avail(), input: i2 })
    expect(v.dropped.map((d) => d.ref)).toEqual(['leads'])
    expect(v.plan.tasks.map((t) => t.ref)).toEqual(['customer-profile', 'outreach-drafts'])
    expect(v.plan.agents.map((x) => x.ref)).toEqual(['hunter', 'lead-researcher'])
    expect(v.plan.departments.map((d) => d.key)).toEqual(['sales'])
    expect(v.ok).toBe(true)
    expect(OnboardingPlan.safeParse(v.plan).success).toBe(true)
    // the repaired plan is stable
    expect(validatePlan(v.plan, { available: avail(), input: i2 }).dropped).toEqual([])
  })

  it('does not refill without input, and reports not ok when nothing is left', () => {
    const p: Plan = {
      version: 1,
      summary: 'Plan',
      departments: [],
      agents: [],
      tasks: [{ ref: 'x1', title: 'Go to https://evil.example', description: 'd', departmentKey: null, agentRef: null, priority: 1, dependsOn: [], where: 'workspace', include: true }],
      schedules: []
    }
    const v = validatePlan(p, { available: avail() })
    expect(v.plan.tasks).toEqual([])
    expect(v.ok).toBe(false)
  })

  it('does not mutate its input', () => {
    const p = base()
    const snap = structuredClone(p)
    p.tasks[0].dependsOn = [p.tasks[0].ref]
    snap.tasks[0].dependsOn = [snap.tasks[0].ref]
    validatePlan(p, { available: avail({ adapters: ['codex'] }), input: inp })
    expect(p).toEqual(snap)
  })
})

describe('finalizePlan', () => {
  it('sets auto by role', () => {
    const a = avail()
    const p = structuredClone(templatePlan(input({ goals: ['social', 'customers', 'support'] }), a))
    for (const ag of p.agents) ag.auto = !AUTO_ROLES.includes(ag.role)
    const f = finalizePlan(p, { available: a })
    for (const ag of f.agents) expect(ag.auto).toBe(AUTO_ROLES.includes(ag.role))
    expect(f.agents.find((x) => x.role === 'researcher')!.auto).toBe(false)
    expect(f.agents.find((x) => x.role === 'content')!.auto).toBe(true)
  })

  it('degrades without image keys: image schedules and tasks go, the content agent stays', () => {
    const inp = input({ goals: ['social', 'website', 'ads'], fal: true })
    const p = templatePlan(inp, avail({ fal: true }))
    expect(p.schedules.some((s) => s.ref === 'carousel')).toBe(true)
    const f = finalizePlan(p, { available: avail() })
    expect(f.schedules.some(scheduleCostly)).toBe(false)
    expect(f.tasks.some((t) => ['brand-kit', 'hero-images', 'ad-angles'].includes(t.ref))).toBe(false)
    expect(f.agents.some((x) => x.ref === 'content-writer')).toBe(true)
    expect(f.tasks.some((t) => t.ref === 'content-calendar')).toBe(true)
  })

  it('enforces the never-publish rule and the review suffix on any plan source', () => {
    const a = avail()
    const p = structuredClone(templatePlan(input({ goals: ['social'] }), a))
    const w = p.agents.find((x) => x.role === 'content')!
    w.instructions = 'Write and post to Instagram daily.'
    p.tasks[0].description = 'Post the calendar.'
    const s = p.schedules.find((x) => x.target.kind === 'task')!
    if (s.target.kind === 'task') s.target.description = 'Post three things.'
    const f = finalizePlan(p, { available: a })
    expect(f.agents.find((x) => x.role === 'content')!.instructions).toContain(CONTENT_AGENT_RULE)
    expect(f.tasks[0].description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
    const fs = f.schedules.find((x) => x.ref === s.ref)!
    expect(fs.target.kind === 'task' && fs.target.description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
    expect(finalizePlan(f, { available: a })).toEqual(f)
    // Fits the caps even at the maximum length.
    p.agents.find((x) => x.role === 'content')!.instructions = 'x'.repeat(2000)
    p.tasks[0].description = 'y'.repeat(2000)
    const g = finalizePlan(p, { available: a })
    expect(OnboardingPlan.safeParse(g).success).toBe(true)
    expect(g.tasks[0].description.endsWith(TASK_REVIEW_SUFFIX)).toBe(true)
  })

  it('degrades without departments consent', () => {
    const inp = input({ goals: ['social', 'customers'], fal: true })
    const p = templatePlan(inp, avail({ fal: true }))
    const f = finalizePlan(p, { available: avail({ fal: true, departmentsOn: false }) })
    expect(f.departments).toEqual([])
    expect(f.agents).toEqual([])
    expect(f.tasks.length).toBe(p.tasks.length)
    expect(f.tasks.every((t) => t.departmentKey === null && t.agentRef === null)).toBe(true)
    expect(f.schedules.map((s) => s.ref).sort()).toEqual(['carousel', 'weekly-review'])
    expect(f.schedules.every((s) => s.departmentKey === null)).toBe(true)
  })

  it('clamps the inputs that decide how many paid images a schedule makes, whatever the plan asked for', () => {
    const a = avail({ fal: true })
    const p = structuredClone(templatePlan(input({ goals: ['social'], fal: true }), a))
    const base = p.schedules.find((x) => x.target.kind === 'workflow')!
    const sched = (ref: string, workflow: keyof typeof WORKFLOW_KEYS, inputs: Record<string, string>) => ({ ...base, ref, target: { kind: 'workflow' as const, workflow, inputs } })
    p.schedules = [
      sched('hero', 'landing-hero-images', { source: 'the site', heroCount: '50' }),
      sched('shots', 'local-business-photos', { business: 'Bakery', perShot: '10' }),
      sched('upscale', 'image-edit-upscale', { image_url: 'x', instruction: 'y', scale: '16' }),
      sched('studio', 'product-photo-studio', { product: 'bread', scenes: 'a, b, c, d, e, f, g' })
    ]
    const f = finalizePlan(p, { available: a })
    const inputs = (ref: string) => {
      const t = f.schedules.find((x) => x.ref === ref)!.target
      return t.kind === 'workflow' ? t.inputs ?? {} : {}
    }
    expect(inputs('hero').heroCount).toBe('3')
    expect(inputs('shots').perShot).toBe('1')
    expect(inputs('upscale').scale).toBe('2')
    expect(inputs('studio').scenes).toBe('a, b, c, d')
    expect(finalizePlan(f, { available: a })).toEqual(f)
  })

  it('re-applies the caps (dependents follow dropped tasks)', () => {
    const p = structuredClone(templatePlan(input({ goals: ['customers'] }), avail()))
    const extra = Array.from({ length: 10 }, (_, i) => ({ ...p.tasks[0], ref: `extra-${i}`, dependsOn: [] as string[] }))
    p.tasks = [...extra, ...p.tasks]
    const f = finalizePlan(p as Plan, { available: avail() })
    expect(f.tasks.length).toBeLessThanOrEqual(PLAN_CAPS.tasks)
    const refs = new Set(f.tasks.map((t) => t.ref))
    for (const t of f.tasks) for (const d of t.dependsOn) expect(refs.has(d)).toBe(true)
  })
})

describe('finalizePlan personas (VOICE.md §4)', () => {
  const names = (p: Plan) => p.agents.map((a) => a.persona!.name.toLowerCase())

  it('gives every template agent a valid, unique persona; Marcus goes to the content role', () => {
    for (const goals of [['social', 'customers', 'support'], ['website', 'seo'], ['ship', 'support', 'customers']] as GoalKey[][]) {
      const p = templatePlan(input({ goals, hasCode: true }), avail({ hasCode: true }))
      expect(p.agents.length).toBeGreaterThan(0)
      for (const a of p.agents) expect(OnboardingPlan.shape.agents.element.shape.persona.safeParse(a.persona).success).toBe(true)
      expect(new Set(names(p)).size).toBe(p.agents.length)
      const content = p.agents.find((a) => a.role === 'content')
      if (content) expect(content.persona).toMatchObject({ key: 'marcus', name: 'Marcus' })
      // agent.name stays the role label
      for (const a of p.agents) expect(a.name).not.toBe(a.persona!.name)
    }
  })

  it('is deterministic and idempotent', () => {
    const a = avail()
    const p = templatePlan(input({ goals: ['social', 'customers'] }), a)
    expect(templatePlan(input({ goals: ['social', 'customers'] }), a)).toEqual(p)
    expect(finalizePlan(p, { available: a })).toEqual(p)
  })

  it('keeps a rename made in the draft, and other agents avoid the renamed name', () => {
    const a = avail()
    const p = structuredClone(templatePlan(input({ goals: ['social', 'customers', 'support'] }), a))
    const content = p.agents.find((x) => x.role === 'content')!
    content.persona = { ...content.persona!, name: 'Maximus' }
    const f = finalizePlan(p, { available: a })
    expect(f.agents.find((x) => x.ref === content.ref)!.persona!.name).toBe('Maximus')
    expect(f.agents.find((x) => x.ref === content.ref)!.persona!.look).toEqual(content.persona.look)
    // a fresh agent planned later takes the freed curated name
    const extra = { ...structuredClone(content), ref: 'content-2', persona: undefined }
    p.agents.push(extra)
    const g = finalizePlan(p, { available: a })
    expect(g.agents.find((x) => x.ref === 'content-2')!.persona!.name).toBe('Marcus')
    expect(new Set(names(g)).size).toBe(g.agents.length)
  })

  it('re-picks a later duplicate and a persona with a secret in it', () => {
    const a = avail()
    const p = structuredClone(templatePlan(input({ goals: ['social', 'customers', 'support'] }), a))
    expect(p.agents.length).toBeGreaterThanOrEqual(2)
    p.agents[1].persona = { ...p.agents[1].persona!, name: p.agents[0].persona!.name.toUpperCase() }
    const f = finalizePlan(p, { available: a })
    expect(new Set(names(f)).size).toBe(f.agents.length)
    expect(f.agents[0].persona).toEqual(p.agents[0].persona)
    p.agents[1].persona = { ...p.agents[1].persona!, bio: `key sk-${'a'.repeat(30)}` }
    const v = validatePlan(p, { available: a, screen })
    expect(v.plan.agents.find((x) => x.ref === p.agents[1].ref)?.persona).toBeUndefined()
    const g = finalizePlan(v.plan, { available: a })
    expect(g.agents.find((x) => x.ref === p.agents[1].ref)!.persona!.bio).not.toContain('sk-')
  })

  it('assigns personas to an agent plan with none (the model never names agents)', () => {
    const a = avail()
    const p = structuredClone(templatePlan(input({ goals: ['social', 'customers'] }), a))
    for (const ag of p.agents) delete ag.persona
    const f = finalizePlan(p, { available: a })
    expect(f.agents.map((x) => x.persona)).toEqual(templatePlan(input({ goals: ['social', 'customers'] }), a).agents.map((x) => x.persona))
  })

  it('rejects a malformed persona at the schema', () => {
    const p = structuredClone(templatePlan(input({ goals: ['social'] }), avail()))
    const bad = (persona: unknown) => OnboardingPlan.safeParse({ ...p, agents: [{ ...p.agents[0], persona }] }).success
    expect(bad(p.agents[0].persona)).toBe(true)
    expect(bad({ ...p.agents[0].persona, name: '  ' })).toBe(false)
    expect(bad({ ...p.agents[0].persona, name: 'x'.repeat(25) })).toBe(false)
    expect(bad({ ...p.agents[0].persona, extra: 1 })).toBe(false)
    expect(bad({ ...p.agents[0].persona, look: { ...p.agents[0].persona!.look, hair: 'mohawk' } })).toBe(false)
  })
})

describe('applyAgentPlan, inputsHash', () => {
  const a = avail()
  const tpl = templatePlan(input(), a)
  const agent = { ...structuredClone(tpl), summary: 'Tailored for Sunday Bakery.' }

  it('swaps when unedited, offers when edited, ignores identical', () => {
    expect(applyAgentPlan(tpl, agent, false)).toEqual({ action: 'swap', plan: agent })
    expect(applyAgentPlan(null, agent, true)).toEqual({ action: 'swap', plan: agent })
    const r = applyAgentPlan(tpl, agent, true)
    expect(r.action).toBe('offer')
    expect(r.plan).toBe(tpl)
    expect(applyAgentPlan(tpl, structuredClone(tpl), true).action).toBe('same')
  })

  it('hash is stable across key order and changes with answers', () => {
    const i1 = input()
    const reordered = JSON.parse(JSON.stringify({ tz: i1.tz, keys: i1.keys, departmentsOn: i1.departmentsOn, answers: i1.answers, hasCode: i1.hasCode }))
    expect(inputsHash(reordered)).toBe(inputsHash(i1))
    expect(inputsHash(input({ answers: { name: 'Monday Bakery' } }))).not.toBe(inputsHash(i1))
    expect(inputsHash(input({ goals: ['ads'] }))).not.toBe(inputsHash(i1))
    expect(inputsHash(i1).length).toBeLessThanOrEqual(128)
    expect(isPlanStale({ inputsHash: inputsHash(i1) }, i1)).toBe(false)
    expect(isPlanStale({ inputsHash: inputsHash(i1) }, input({ fal: true }))).toBe(true)
    expect(isPlanStale(undefined, i1)).toBe(true)
  })

  it('counts included items and marks costly schedules', () => {
    const p = structuredClone(templatePlan(input({ goals: ['social'] }), avail({ fal: true })))
    p.tasks[0].include = false
    const c = planCounts(p)
    expect(c.tasks).toBe(p.tasks.length - 1)
    expect(p.schedules.filter(scheduleCostly).map((s) => s.ref)).toEqual(['carousel'])
    expect(WORKFLOW_KEYS['weekly-company-review'].costly).toBe(false)
  })

  it('siteHost normalizes free text', () => {
    expect(siteHost('https://www.Acme.com/x?y')).toBe('acme.com')
    expect(siteHost('acme.com')).toBe('acme.com')
    expect(siteHost('@acme')).toBeNull()
    expect(siteHost('not a site')).toBeNull()
  })
})

describe('purity and the real screen', () => {
  it('imports nothing from node or electron', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const f of ['onboardingPlan.ts', 'onboardingPrefill.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      const froms = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      expect(froms.every((m) => m.startsWith('./')), `${f}: ${froms.join(', ')}`).toBe(true)
    }
  })

  it('template output passes the main-process credential screen', async () => {
    const { screenText, redactCredentials } = await import('../main/memory/screen')
    const real: ScreenFn = (t) => screenText(null, t)?.label ?? (redactCredentials(t) !== t ? 'credential' : null)
    for (const hasCode of [false, true])
      for (const fal of [false, true]) {
        const a = avail({ hasCode, fal })
        const inp = input({ goals: ['social', 'customers', 'ship'], hasCode, fal, answers: { products: 'Loaves ghp_abcdefghijklmnopqrstuvwxyz0123456789' } })
        const plan = templatePlan(inp, a, { screen: real })
        expect(JSON.stringify(plan)).not.toContain('ghp_')
        expect(validatePlan(plan, { available: a, screen: real, input: inp }).dropped).toEqual([])
      }
  })
})
