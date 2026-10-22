import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_WORKFLOW_IDS,
  CADENCES,
  CADENCE_KEYS,
  DraftSchema,
  GITHUB_FULL_NAME,
  EMPTY_ANSWERS,
  LaunchInputSchema,
  OnboardingPlan,
  PlanAgent,
  PlanDepartment,
  PlanInputSchema,
  PlanSchedule,
  PlanTask,
  VIBES,
  VIBE_INFO,
  WORKFLOW_KEYS,
  WORKFLOW_KEY_NAMES,
  vibeSample,
  workflowsForKeys,
  type OnboardingDraft,
  type OnboardingPlan as Plan
} from './onboarding'
import { REQUEST_SCHEMAS, zodErrors } from '../main/ipcSchemas'
import { INVOKE_CHANNELS, EVENT_NAMES } from './ipc'

const plan = (): Plan => ({
  version: 1,
  summary: 'A focused first week for Sunday Bakery.',
  departments: [{ key: 'marketing', name: 'Marketing', include: true, charter: { does: 'Posts and pages.', doesNot: 'Code.' } }],
  agents: [
    {
      ref: 'content-writer',
      departmentKey: 'marketing',
      name: 'Content writer',
      role: 'content',
      adapter: 'claude',
      instructions: 'Never publish or send anything. Save drafts under content/.',
      capabilities: 'Writing posts',
      auto: true,
      include: true
    }
  ],
  tasks: [
    {
      ref: 'calendar',
      title: 'Write a 2-week content calendar',
      description: 'Deliverable: content/calendar.md. When done, move this task to review.',
      departmentKey: 'marketing',
      agentRef: 'content-writer',
      priority: 2,
      dependsOn: [],
      where: 'workspace',
      include: true
    }
  ],
  schedules: [
    {
      ref: 'carousel',
      name: 'Carousel',
      departmentKey: 'marketing',
      cadence: 'mwf1030',
      target: { kind: 'workflow', workflow: 'social-post-carousel', inputs: { topic: 'The next topic', voice: 'friendly' } },
      include: true
    },
    {
      ref: 'weekly-posts',
      name: 'Weekly posts',
      departmentKey: 'marketing',
      cadence: 'mon9',
      target: { kind: 'task', agentRef: 'content-writer', title: "Draft this week's 3 posts", description: 'Three drafts.' },
      include: false
    }
  ]
})

const draft = (): OnboardingDraft => ({
  v: 1,
  id: 'd_abc123',
  mode: 'new',
  step: 'voice',
  history: ['start', 'name', 'about'],
  hasCode: false,
  repos: [],
  answers: { ...EMPTY_ANSWERS, name: 'Sunday Bakery', goals: ['website', 'social'] },
  content: { wants: true, provider: 'fal', keySource: 'stash', stashId: 'ks_123456', last4: '4f2a', vibizInterest: false },
  plan: { value: plan(), source: 'template', edited: false, inputsHash: 'abc' },
  enableFlags: true,
  updatedAt: new Date().toISOString()
})

describe('OnboardingPlan schema', () => {
  it('accepts a valid plan and defaults the adapter', () => {
    expect(OnboardingPlan.parse(plan())).toEqual(plan())
    const { adapter: _drop, ...noAdapter } = plan().agents[0]
    void _drop
    expect(PlanAgent.parse(noAdapter).adapter).toBe('claude')
  })

  it('rejects extra keys at every level', () => {
    expect(OnboardingPlan.safeParse({ ...plan(), extra: 1 }).success).toBe(false)
    expect(PlanDepartment.safeParse({ ...plan().departments[0], color: 'red' }).success).toBe(false)
    expect(PlanDepartment.safeParse({ ...plan().departments[0], charter: { does: 'a', doesNot: 'b', more: 'c' } }).success).toBe(false)
    expect(PlanAgent.safeParse({ ...plan().agents[0], workflowId: 'generate-image-fal' }).success).toBe(false)
    expect(PlanTask.safeParse({ ...plan().tasks[0], repoId: 'r_1' }).success).toBe(false)
    const s = plan().schedules[1]
    expect(PlanSchedule.safeParse({ ...s, target: { ...s.target, mode: 'run' } }).success).toBe(false)
    expect(PlanSchedule.safeParse({ ...s, enabled: true }).success).toBe(false)
  })

  it('rejects oversize and empty strings', () => {
    const p = plan()
    expect(OnboardingPlan.safeParse({ ...p, summary: 'x'.repeat(281) }).success).toBe(false)
    expect(OnboardingPlan.safeParse({ ...p, summary: '   ' }).success).toBe(false)
    expect(PlanAgent.safeParse({ ...p.agents[0], name: 'x'.repeat(41) }).success).toBe(false)
    expect(PlanAgent.safeParse({ ...p.agents[0], instructions: 'x'.repeat(2001) }).success).toBe(false)
    expect(PlanTask.safeParse({ ...p.tasks[0], title: 'x'.repeat(121) }).success).toBe(false)
    expect(PlanTask.safeParse({ ...p.tasks[0], description: 'x'.repeat(2001) }).success).toBe(false)
    const w = p.schedules[0]
    expect(PlanSchedule.safeParse({ ...w, target: { kind: 'workflow', workflow: 'social-post-carousel', inputs: { topic: 'x'.repeat(1501) } } }).success).toBe(false)
    expect(PlanSchedule.safeParse({ ...w, target: { kind: 'workflow', workflow: 'social-post-carousel', inputs: { ['k'.repeat(41)]: 'v' } } }).success).toBe(false)
  })

  it('rejects unknown workflows, cadences, departments, roles and adapters', () => {
    const p = plan()
    const w = p.schedules[0]
    expect(PlanSchedule.safeParse({ ...w, target: { kind: 'workflow', workflow: 'post-to-instagram' } }).success).toBe(false)
    expect(PlanSchedule.safeParse({ ...w, cadence: 'hourly' }).success).toBe(false)
    expect(PlanDepartment.safeParse({ ...p.departments[0], key: 'legal' }).success).toBe(false)
    expect(PlanAgent.safeParse({ ...p.agents[0], role: 'poster' }).success).toBe(false)
    expect(PlanAgent.safeParse({ ...p.agents[0], adapter: 'shell' }).success).toBe(false)
  })

  it('enforces refs, priorities and caps', () => {
    const p = plan()
    expect(PlanTask.safeParse({ ...p.tasks[0], ref: 'Bad Ref' }).success).toBe(false)
    expect(PlanTask.safeParse({ ...p.tasks[0], ref: 'a' }).success).toBe(false)
    expect(PlanTask.safeParse({ ...p.tasks[0], priority: 5 }).success).toBe(false)
    expect(PlanTask.safeParse({ ...p.tasks[0], dependsOn: ['a1', 'b1', 'c1', 'd1'] }).success).toBe(false)
    const tasks = Array.from({ length: 9 }, (_, i) => ({ ...p.tasks[0], ref: `task-${i}` }))
    expect(OnboardingPlan.safeParse({ ...p, tasks }).success).toBe(false)
    expect(OnboardingPlan.safeParse({ ...p, tasks: tasks.slice(0, 8) }).success).toBe(true)
    const agents = Array.from({ length: 7 }, (_, i) => ({ ...p.agents[0], ref: `agent-${i}` }))
    expect(OnboardingPlan.safeParse({ ...p, agents }).success).toBe(false)
    const schedules = Array.from({ length: 5 }, (_, i) => ({ ...p.schedules[1], ref: `sched-${i}` }))
    expect(OnboardingPlan.safeParse({ ...p, schedules }).success).toBe(false)
    expect(OnboardingPlan.safeParse({ ...p, version: 2 }).success).toBe(false)
  })

  it('converts to JSON schema (for the gated --json-schema flag)', async () => {
    const { z } = await import('zod')
    expect(() => z.toJSONSchema(OnboardingPlan, { io: 'input' })).not.toThrow()
  })
})

describe('DraftSchema', () => {
  it('round-trips a valid draft', () => {
    const d = draft()
    expect(DraftSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d)
  })
  it('rejects a wrong version', () => {
    expect(DraftSchema.safeParse({ ...draft(), v: 2 }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...draft(), v: undefined }).success).toBe(false)
  })
  it('rejects a key value smuggled into the draft', () => {
    const d = draft()
    expect(DraftSchema.safeParse({ ...d, content: { ...d.content, value: 'fal-secret' } }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, key: 'fal-secret' }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, content: { ...d.content, last4: '12345' } }).success).toBe(false)
  })
  it('rejects bad shapes', () => {
    const d = draft()
    expect(DraftSchema.safeParse({ ...d, step: 'nowhere' }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, repos: [{ kind: 'local', path: 'relative/path' }] }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, repos: Array.from({ length: 9 }, (_, i) => ({ kind: 'local', path: `/r/${i}` })) }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, answers: { ...d.answers, goals: ['world-domination'] } }).success).toBe(false)
    expect(DraftSchema.safeParse({ ...d, plan: { ...d.plan, value: { ...plan(), extra: true } } }).success).toBe(false)
  })
})

describe('plan and launch inputs', () => {
  const input = { hasCode: false, answers: { ...EMPTY_ANSWERS, name: 'Sunday Bakery' }, keys: { fal: true, openai: false }, departmentsOn: true, tz: 'Europe/Lisbon' }
  it('PlanInput is strict', () => {
    expect(PlanInputSchema.safeParse(input).success).toBe(true)
    expect(PlanInputSchema.safeParse({ ...input, available: { workflows: ['generate-image-fal'] } }).success).toBe(false)
  })
  it('LaunchInput needs a name and allowlists the key name', () => {
    const launch = { mode: 'first', hasCode: false, answers: input.answers, repos: [], key: { name: 'FAL_KEY', stashId: 'ks_1234' }, plan: plan(), enableFlags: true, tz: 'UTC' }
    expect(LaunchInputSchema.safeParse(launch).success).toBe(true)
    expect(LaunchInputSchema.safeParse({ ...launch, answers: { ...input.answers, name: '  ' } }).success).toBe(false)
    expect(LaunchInputSchema.safeParse({ ...launch, key: { name: 'AWS_SECRET_ACCESS_KEY', stashId: 'ks_1234' } }).success).toBe(false)
    expect(LaunchInputSchema.safeParse({ ...launch, key: { name: 'FAL_KEY', stashId: 'ks_1234', value: 'secret' } }).success).toBe(false)
  })
})

describe('IPC schemas', () => {
  const channels = INVOKE_CHANNELS.filter((c) => c.startsWith('onboarding:'))
  it('registers all 14 onboarding channels and both events', () => {
    expect(channels).toHaveLength(14)
    for (const c of channels) expect(REQUEST_SCHEMAS[c], c).toBeDefined()
    expect(EVENT_NAMES).toContain('onboarding:progress')
    expect(EVENT_NAMES).toContain('onboarding:cloneProgress')
  })
  it('allowlists key names and caps the key request', () => {
    const key = REQUEST_SCHEMAS['onboarding:key']
    expect(key.safeParse({ op: 'check', name: 'FAL_KEY', value: 'abc:def' }).success).toBe(true)
    expect(key.safeParse({ op: 'check', name: 'OPENAI_API_KEY', value: 'sk-x' }).success).toBe(true)
    expect(key.safeParse({ op: 'check', name: 'FIRECRAWL_API_KEY', value: 'x' }).success).toBe(false)
    expect(key.safeParse({ op: 'check', name: 'PATH', value: 'x' }).success).toBe(false)
    expect(key.safeParse({ op: 'check', name: 'FAL_KEY', value: '' }).success).toBe(false)
    expect(key.safeParse({ op: 'forget', stashIds: ['ks_1'] }).success).toBe(true)
  })
  it('caps paths and urls', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `/Users/me/p${i}`)
    expect(REQUEST_SCHEMAS['onboarding:inspectFolders'].safeParse({ paths: paths(8) }).success).toBe(true)
    expect(REQUEST_SCHEMAS['onboarding:inspectFolders'].safeParse({ paths: paths(9) }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:inspectFolders'].safeParse({ paths: ['relative'] }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:scan'].safeParse({ paths: paths(9) }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:scan'].safeParse({ github: { fullName: 'acme/web' } }).success).toBe(true)
    expect(REQUEST_SCHEMAS['onboarding:scan'].safeParse({ github: { fullName: 'acme/web; rm -rf' } }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:scan'].safeParse({}).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:fetchSite'].safeParse({ url: 'https://sundaybakery.com' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['onboarding:fetchSite'].safeParse({ url: 'https://a.com/' + 'x'.repeat(2048) }).success).toBe(false)
  })
  it('parses the launch plan with OnboardingPlan', () => {
    const launch = REQUEST_SCHEMAS['onboarding:launch']
    const input = { mode: 'new', hasCode: false, answers: { ...EMPTY_ANSWERS, name: 'Sunday Bakery' }, repos: [], key: null, plan: plan(), enableFlags: false, tz: 'UTC' }
    expect(launch.safeParse({ draftId: 'd_1', input }).success).toBe(true)
    const bad = { ...plan(), schedules: [{ ...plan().schedules[0], target: { kind: 'workflow', workflow: 'post-to-x' } }] }
    expect(launch.safeParse({ draftId: 'd_1', input: { ...input, plan: bad } }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:skipStep'].safeParse({ journalId: 'j_1', step: 'schedules' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['onboarding:skipStep'].safeParse({ journalId: 'j_1', step: 'company' }).success).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:start'].safeParse({ journalId: 'j_1', autopilot: true, scheduleRefs: ['carousel'], companyId: 'co_x' }).success).toBe(false)
  })
})

describe('review hardening', () => {
  it('GitHub names cannot escape the clone folder or look like CLI options', () => {
    for (const ok of ['acme/web', 'a/b', 'Acme-Co/site.v2', 'acme/.github', 'acme/web_app']) expect(GITHUB_FULL_NAME.test(ok), ok).toBe(true)
    for (const bad of ['acme/..', 'acme/.', '-acme/web', '--upload-pack=x/web', 'acme/web/x', '../web', 'acme/ web', 'a'.repeat(40) + '/web'])
      expect(GITHUB_FULL_NAME.test(bad), bad).toBe(false)
    expect(REQUEST_SCHEMAS['onboarding:scan'].safeParse({ github: { fullName: 'acme/..' } }).success).toBe(false)
  })
  it('launch only accepts real clone sources', () => {
    const launch = { mode: 'first', hasCode: true, answers: { ...EMPTY_ANSWERS, name: 'Acme' }, repos: [], key: null, plan: plan(), enableFlags: true, tz: 'UTC' }
    const gh = (github: unknown) => LaunchInputSchema.safeParse({ ...launch, github }).success
    expect(gh({ fullName: 'acme/web', parentDir: '/Users/me/Projects' })).toBe(true)
    expect(gh({ url: 'https://github.com/acme/web.git', parentDir: '/Users/me/Projects' })).toBe(true)
    expect(gh({ url: 'git@github.com:acme/web.git', parentDir: '/Users/me/Projects' })).toBe(true)
    expect(gh({ url: 'ssh://git@github.com/acme/web.git', parentDir: '/Users/me/Projects' })).toBe(true)
    for (const url of ['ext::sh -c touch% /tmp/pwned', 'file:///etc', '--upload-pack=touch /tmp/x', 'http://github.com/acme/web', 'https://github.com/a b'])
      expect(gh({ url, parentDir: '/Users/me/Projects' }), url).toBe(false)
    expect(gh({ parentDir: '/Users/me/Projects' })).toBe(false)
    expect(gh({ fullName: 'acme/web', parentDir: 'Projects' })).toBe(false)
    // The draft stays lenient so a half-typed link never breaks resume.
    expect(DraftSchema.shape.github.safeParse({ url: 'github.com/acme', parentDir: '/Users/me/Projects' }).success).toBe(true)
  })
  it('a rejected key request never echoes the key value in its errors', () => {
    const secret = 'sk-proj-SECRETSECRETSECRET1234'
    const key = REQUEST_SCHEMAS['onboarding:key']
    const attempts = [
      { op: 'check', name: 'FIRECRAWL_API_KEY', value: secret },
      { op: 'check', name: secret, value: secret },
      { op: 'check', name: 'OPENAI_API_KEY', value: secret, extra: secret },
      { op: 'check', name: 'OPENAI_API_KEY', value: secret + 'x'.repeat(5000) },
      { op: secret, value: secret },
      { op: 'forget', stashIds: [secret + '!'] }
    ]
    for (const a of attempts) {
      const r = key.safeParse(a)
      expect(r.success).toBe(false)
      if (!r.success) expect(JSON.stringify(zodErrors(r.error))).not.toContain('SECRETSECRET')
    }
  })
})

describe('constants', () => {
  it('CADENCE_KEYS lists every cadence', () => {
    expect([...CADENCE_KEYS].sort()).toEqual(Object.keys(CADENCES).sort())
  })
  it('vibe samples fill the name', () => {
    for (const v of VIBES) expect(VIBE_INFO[v].label.length).toBeGreaterThan(0)
    expect(vibeSample('bold', 'Sunday Bakery')).toContain('Sunday Bakery')
    expect(vibeSample('bold', '  ')).not.toContain('{name}')
  })
  it('workflowsForKeys gates by key', () => {
    const none = workflowsForKeys({})
    expect(none).toContain('weekly-company-review')
    expect(none).not.toContain('social-post-carousel')
    expect(workflowsForKeys({ FAL_KEY: true })).toContain('social-post-carousel')
    expect(workflowsForKeys({ FAL_KEY: true })).not.toContain('generate-image-openai')
  })
})

describe('WORKFLOW_KEYS matches resources/marketplace/workflows', () => {
  const dir = join(__dirname, '../../resources/marketplace/workflows')
  const files = readdirSync(dir).filter((f) => f.endsWith('.hive.json'))
  const keyRe = /\b[A-Z][A-Z0-9_]*_KEY\b/g

  it('lists exactly the bundled files', () => {
    expect([...BUNDLED_WORKFLOW_IDS].sort()).toEqual(files.map((f) => f.replace(/\.hive\.json$/, '')).sort())
  })

  it.each(files)('%s: required key and declared inputs', (file) => {
    const id = file.replace(/\.hive\.json$/, '') as (typeof BUNDLED_WORKFLOW_IDS)[number]
    const raw = readFileSync(join(dir, file), 'utf8')
    const json = JSON.parse(raw) as { workflow: { inputs?: { name: string }[] } }
    const keys = [...new Set(raw.match(keyRe) ?? [])]
    for (const k of keys) expect(WORKFLOW_KEY_NAMES as readonly string[], `${id} uses ${k}`).toContain(k)
    expect(keys.length, `${id} needs at most one key`).toBeLessThanOrEqual(1)
    const info = WORKFLOW_KEYS[id]
    expect(info.key).toBe(keys[0] ?? null)
    expect(info.costly).toBe(info.key !== null)
    expect([...info.inputs]).toEqual((json.workflow.inputs ?? []).map((i) => i.name))
  })

  it('matches the counts in ONBOARDING.md §0 (9 fal, 1 OpenAI, 2 Firecrawl, 5 free)', () => {
    const count = (k: string | null) => BUNDLED_WORKFLOW_IDS.filter((id) => WORKFLOW_KEYS[id].key === k).length
    expect([count('FAL_KEY'), count('OPENAI_API_KEY'), count('FIRECRAWL_API_KEY'), count(null)]).toEqual([9, 1, 2, 5])
  })
})
