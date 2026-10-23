import { describe, expect, it } from 'vitest'
import type { LaunchStepState, OnboardingPlan, PlanSchedule, ProgressEvent } from '@shared/onboarding'
import {
  agentLogin,
  autonomyLine,
  ceremonyLines,
  firstTaskFor,
  passportMeta,
  renamePersona,
  shortGoal,
  teamOf,
  wantsCeremony,
  blocksAppChord,
  cadenceSentence,
  dependencyHint,
  digitKey,
  failureLine,
  flowKey,
  gridMove,
  groupPlan,
  instagramHandle,
  launchFacts,
  launchRows,
  middleTruncate,
  nextSteps,
  planCostLine,
  planRows,
  readySchedules,
  removeRow,
  renameRow,
  rowName,
  siteFetchUrl,
  summaryParts,
  toggleInclude,
  weeklyCostLine
} from './model'

const D = 'Deliverable: a file. When done, move this task to review. Do not publish, send, spend, deploy or sign up for anything.'
const plan = (): OnboardingPlan => ({
  version: 1,
  summary: 'A first week for Sunday Bakery.',
  departments: [
    { key: 'marketing', name: 'Marketing', include: true },
    { key: 'sales', name: 'Sales', include: true }
  ],
  agents: [
    { ref: 'site-builder', departmentKey: 'marketing', name: 'Site builder', role: 'builder', adapter: 'claude', instructions: 'Draft pages.', capabilities: 'html', auto: true, include: true },
    { ref: 'lead-researcher', departmentKey: 'sales', name: 'Lead researcher', role: 'researcher', adapter: 'claude', instructions: 'Research.', capabilities: 'research', auto: false, include: true }
  ],
  tasks: [
    { ref: 'landing', title: 'Draft a one-page landing page', description: D, departmentKey: 'marketing', agentRef: 'site-builder', priority: 2, dependsOn: [], where: 'workspace', include: true },
    { ref: 'calendar', title: 'Write a 2-week content calendar', description: D, departmentKey: 'marketing', agentRef: 'site-builder', priority: 2, dependsOn: ['landing'], where: 'workspace', include: true },
    { ref: 'outreach', title: 'Draft 3 outreach messages (not sent)', description: D, departmentKey: 'sales', agentRef: 'lead-researcher', priority: 3, dependsOn: [], where: 'workspace', include: true }
  ],
  schedules: [
    { ref: 'carousel', name: 'Instagram carousel', departmentKey: 'marketing', cadence: 'mwf1030', target: { kind: 'workflow', workflow: 'social-post-carousel', inputs: { topic: 'x' } }, include: true },
    { ref: 'weekly-review', name: 'Weekly company review', departmentKey: null, cadence: 'fri16', target: { kind: 'workflow', workflow: 'weekly-company-review' }, include: true }
  ]
})

describe('schedules copy', () => {
  it('turns cadences into sentences and names whose credits a paid schedule spends', () => {
    const p = plan()
    expect(cadenceSentence('mwf10')).toBe('Mon, Wed, Fri at 10:00')
    expect(planCostLine(p.schedules[0]!)).toBe('≈ 5 images per run · uses your fal credits')
    expect(weeklyCostLine(p.schedules[0]!)).toBe('≈ 15 images a week on your fal credits')
    expect(planCostLine(p.schedules[1]!)).toBeNull()
    const openai: PlanSchedule = { ...p.schedules[0]!, cadence: 'mon9', target: { kind: 'workflow', workflow: 'generate-image-openai' } }
    expect(weeklyCostLine(openai)).toBe('≈ 5 images a week on your OpenAI credits')
  })

  it('lists created schedules for Ready with paid ones flagged and free ones not', () => {
    const rows = readySchedules(plan(), [
      { ref: 'carousel', id: 'sch_1', costly: true },
      { ref: 'weekly-review', id: 'sch_2', costly: false },
      { ref: 'gone', id: 'sch_3', costly: false }
    ])
    expect(rows.map((r) => [r.label, r.costly])).toEqual([
      ['Instagram carousel · Mon/Wed/Fri', true],
      ['Weekly company review · Fri 16:00', false]
    ])
    expect(rows[0]!.cost).toContain('fal credits')
  })
})

describe('plan structure and edits', () => {
  it('groups by department and adds a Company card for department-less items', () => {
    const g = groupPlan(plan())
    expect(g.map((x) => x.key)).toEqual(['marketing', 'sales', null])
    expect(g[2]!.schedules.map((s) => s.ref)).toEqual(['weekly-review'])
    expect(planRows(plan()).map((r) => `${r.kind}:${r.ref}`)).toEqual([
      'department:marketing',
      'agent:site-builder',
      'task:landing',
      'task:calendar',
      'schedule:carousel',
      'department:sales',
      'agent:lead-researcher',
      'task:outreach',
      'schedule:weekly-review'
    ])
  })

  it('shows "after #n" from included tasks only', () => {
    const p = plan()
    expect(dependencyHint(p, p.tasks[1]!)).toBe('after #1')
    const off = toggleInclude(p, { kind: 'task', ref: 'landing' })
    expect(dependencyHint(off, off.tasks[1]!)).toBeNull()
  })

  it('removes tasks (and their dependency edges) and schedules; switches departments and agents off', () => {
    const p = plan()
    const noLanding = removeRow(p, { kind: 'task', ref: 'landing' })
    expect(noLanding.tasks.map((t) => t.ref)).toEqual(['calendar', 'outreach'])
    expect(noLanding.tasks[0]!.dependsOn).toEqual([])
    expect(removeRow(p, { kind: 'schedule', ref: 'carousel' }).schedules).toHaveLength(1)
    const agentOff = removeRow(p, { kind: 'agent', ref: 'site-builder' })
    expect(agentOff.agents.find((a) => a.ref === 'site-builder')!.include).toBe(false)
    expect(removeRow(p, { kind: 'task', ref: 'nope' })).toBe(p)
    // never mutates the input
    expect(p.tasks).toHaveLength(3)
  })

  it('renames within the schema limits and ignores blank names', () => {
    const p = plan()
    const r = renameRow(p, { kind: 'department', ref: 'marketing' }, '  Growth   team ')
    expect(r.departments[0]!.name).toBe('Growth team')
    expect(renameRow(p, { kind: 'agent', ref: 'site-builder' }, '   ')).toBe(p)
    expect(renameRow(p, { kind: 'task', ref: 'landing' }, 'x'.repeat(300)).tasks[0]!.title).toHaveLength(120)
    expect(rowName(p, { kind: 'schedule', ref: 'carousel' })).toBe('Instagram carousel')
  })
})

describe('Ready step: only what was made', () => {
  const step = (name: LaunchStepState['name'], status: LaunchStepState['status'], created: LaunchStepState['created'] = []): LaunchStepState => ({ name, status, created })

  it('counts the journal, not the plan (beta switch off, schedules skipped)', () => {
    const facts = launchFacts([
      step('company', 'done', [{ kind: 'company', id: 'co_1' }]),
      step('passport', 'skipped'),
      step('departments', 'skipped'),
      step('agents', 'skipped'),
      step('tasks', 'done', [
        { kind: 'task', id: 't1' },
        { kind: 'task', id: 't2' }
      ]),
      step('schedules', 'skipped')
    ])!
    expect(facts).toMatchObject({ departments: 0, agents: 0, tasks: 2, schedules: 0, passport: false })
    // the plan says 2 departments, 2 agents, 3 tasks, 2 schedules: none of that is promised
    expect(summaryParts(plan(), 2, facts).join(' · ')).toBe('2 tasks')
    expect(autonomyLine(plan(), facts.agents > 0)).toBeNull()
    const b = nextSteps({ plan: plan(), name: 'Sunday Bakery', repoNames: [], passport: facts.passport, agentsCreated: false })
    expect(b[0]).toContain('is waiting on the board')
    expect(b[0]).not.toContain('Site builder')
    expect(b[2]).toContain('Company Settings')
    expect(b.join(' ')).not.toContain('passport has')
    expect(launchFacts([])).toBeNull()
  })

  it('uses the real passport note count', () => {
    const facts = launchFacts([step('passport', 'done', [1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'note' as const, id: `n${i}` })))])!
    expect(facts.passport).toBe(true)
    const b = nextSteps({ plan: plan(), name: 'Acme', repoNames: [], passport: true, notes: facts.notes })
    expect(b[2]).toBe('Your passport has 6 notes about Acme. Agents read them before every task. Edit them under Passport.')
  })

  it('never says an ask-first agent starts on its own', () => {
    const p = plan()
    const askOnly = { ...p, agents: p.agents.map((a) => ({ ...a, auto: false })) }
    const b = nextSteps({ plan: askOnly, name: 'Acme', repoNames: [], passport: false })
    expect(b[0]).toBe('“Draft a one-page landing page” is assigned to the Site builder, who asks you before starting.')
    // an auto agent's task is preferred over an earlier ask-first one
    const mixed = { ...p, tasks: [p.tasks[2]!, ...p.tasks.slice(0, 2)] }
    expect(nextSteps({ plan: mixed, name: 'Acme', repoNames: [], passport: false })[0]).toContain('Once you start, the Site builder')
  })
})

describe('Ready step copy', () => {
  it('summarises the plan and who starts on their own', () => {
    expect(summaryParts(plan()).join(' · ')).toBe('2 departments · 2 agents · 3 tasks · 2 schedules (off)')
    expect(autonomyLine(plan())).toBe('Will start on their own: Site builder. Ask first: Lead researcher.')
  })

  it('builds three "What happens next" bullets from the plan', () => {
    const b = nextSteps({ plan: plan(), name: 'Sunday Bakery', repoNames: [], passport: true })
    expect(b).toHaveLength(3)
    expect(b[0]).toBe('Once you start, the Site builder works on “Draft a one-page landing page”. You\'ll see the result in Needs you.')
    expect(b[1]).toBe('Everything agents make lands in review. Nothing is posted, sent or paid without you.')
    expect(b[2]).toBe('Your passport has 5 notes about Sunday Bakery. Agents read them before every task. Edit them under Passport.')
    const noFlags = nextSteps({ plan: { ...plan(), agents: [] }, name: 'Acme', repoNames: ['acme-web'], passport: false })
    expect(noFlags[0]).toContain('is waiting on the board')
    expect(noFlags[2]).toContain('Company Settings')
  })
})

describe('launch list', () => {
  const ev = (step: ProgressEvent['step'], status: ProgressEvent['status'], extra: Partial<ProgressEvent> = {}): ProgressEvent => ({ journalId: 'j1', step, status, label: step, ...extra })
  it('shows the §2 S7 rows, merges departments + agents into Team and hides rows that do not apply', () => {
    const rows = launchRows({ company: ev('company', 'done'), departments: ev('departments', 'done'), agents: ev('agents', 'running') }, { hasCode: false, hasKey: false, departments: true })
    expect(rows.map((r) => `${r.label}:${r.status}`)).toEqual(['Company:done', 'Passport:pending', 'Workflows:pending', 'Team:running', 'Tasks:pending', 'Schedules:pending'])
  })

  it('reports the failed step with the soft step to skip and the "Couldn\'t…" line', () => {
    const rows = launchRows({ company: ev('company', 'done'), schedules: ev('schedules', 'failed', { error: 'the scheduler is paused' }) }, { hasCode: true, hasKey: true, departments: false })
    const failed = rows.find((r) => r.status === 'failed')!
    expect(failed.step).toBe('schedules')
    expect(failureLine(failed)).toBe("Couldn't create the schedules: the scheduler is paused")
    expect(rows.map((r) => r.label)).toEqual(['Company', 'Code', 'Keys', 'Workflows', 'Tasks', 'Schedules'])
  })
})

describe('Name step input', () => {
  it('tells an Instagram handle from a website', () => {
    expect(instagramHandle('@sundaybakery')).toBe('@sundaybakery')
    expect(instagramHandle('https://www.instagram.com/sunday.bakery/')).toBe('@sunday.bakery')
    expect(instagramHandle('sundaybakery.com')).toBeNull()
    expect(siteFetchUrl('sundaybakery.com')).toBe('https://sundaybakery.com')
    expect(siteFetchUrl('http://acme.com/x')).toBe('http://acme.com/x')
    expect(siteFetchUrl('@sundaybakery')).toBeNull()
    expect(siteFetchUrl('file:///etc/passwd')).toBeNull()
    expect(siteFetchUrl('not a site')).toBeNull()
  })

  it('middle-truncates long paths', () => {
    expect(middleTruncate('short')).toBe('short')
    const t = middleTruncate('/Users/me/Projects/clients/very/deep/folder/structure/acme-web', 30)
    expect(t).toHaveLength(30)
    expect(t).toContain('…')
    expect(t.endsWith('acme-web')).toBe(true)
  })
})

describe('keyboard', () => {
  const k = (key: string, mods: Partial<{ metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods })
  it('maps ↵ / ⌘↵ to primary, but not in textareas or on buttons', () => {
    expect(flowKey(k('Enter'), { tag: 'INPUT', type: 'text' })).toBe('primary')
    expect(flowKey(k('Enter'), { tag: 'INPUT', type: 'password' })).toBe('primary')
    expect(flowKey(k('Enter'), { tag: 'TEXTAREA' })).toBeNull()
    expect(flowKey(k('Enter', { metaKey: true }), { tag: 'TEXTAREA' })).toBe('primary')
    expect(flowKey(k('Enter'), { tag: 'BUTTON' })).toBeNull()
    expect(flowKey(k('Enter'), { tag: 'BUTTON', enterPrimary: true })).toBe('primary')
    expect(flowKey(k('Enter'), { tag: 'INPUT', type: 'checkbox' })).toBeNull()
    expect(flowKey(k('Enter'), { tag: 'BODY' })).toBe('primary')
    expect(flowKey(k('Enter', { shiftKey: true }), { tag: 'INPUT' })).toBeNull()
  })

  it('maps ⌘[ and ⌥← (outside text fields) to back, and Esc to close', () => {
    expect(flowKey(k('[', { metaKey: true }), { tag: 'INPUT', type: 'text' })).toBe('back')
    expect(flowKey(k('ArrowLeft', { altKey: true }), { tag: 'BUTTON' })).toBe('back')
    expect(flowKey(k('ArrowLeft', { altKey: true }), { tag: 'INPUT', type: 'text' })).toBeNull()
    expect(flowKey(k('Escape'), { tag: 'INPUT', type: 'text' })).toBe('close')
    expect(flowKey(k('a'), { tag: 'BODY' })).toBeNull()
  })

  it('holds back app navigation chords but keeps editing chords native', () => {
    const c = (code: string, mods: Partial<{ metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({ code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods })
    expect(blocksAppChord(c('Digit1', { metaKey: true }))).toBe(true)
    expect(blocksAppChord(c('KeyK', { metaKey: true }))).toBe(true)
    expect(blocksAppChord(c('Digit2', { ctrlKey: true }))).toBe(true)
    expect(blocksAppChord(c('KeyA', { metaKey: true }))).toBe(false)
    expect(blocksAppChord(c('KeyA', { metaKey: true, shiftKey: true }))).toBe(true)
    expect(blocksAppChord(c('KeyC', { metaKey: true }))).toBe(false)
    expect(blocksAppChord(c('KeyV', { metaKey: true }))).toBe(false)
    expect(blocksAppChord(c('KeyZ', { metaKey: true }))).toBe(false)
  })

  it('reads digit hotkeys and moves in a 3-wide grid', () => {
    expect(digitKey(k('3'))).toBe(3)
    expect(digitKey(k('3', { metaKey: true }))).toBeNull()
    expect(digitKey(k('0'))).toBeNull()
    expect(gridMove(0, 'ArrowDown', 6, 3)).toBe(3)
    expect(gridMove(4, 'ArrowDown', 6, 3)).toBe(4)
    expect(gridMove(4, 'ArrowUp', 6, 3)).toBe(1)
    expect(gridMove(5, 'ArrowRight', 6, 3)).toBe(5)
    expect(gridMove(0, 'ArrowLeft', 6, 3)).toBe(0)
    expect(gridMove(2, 'x', 6, 3)).toBeNull()
  })
})

describe('agentLogin', () => {
  it('names the agent whose login the plan runs on', () => {
    expect(agentLogin(['codex', 'claude'])).toBe('Claude Code')
    expect(agentLogin(['codex'])).toBe('Codex')
    expect(agentLogin(['gemini', 'cursor'])).toBe('Gemini')
    expect(agentLogin([])).toBe('Claude Code')
  })
})

// ---------- the team (VOICE.md §4.4, §5.7, §8) ----------

const look = { material: 'marble', hair: 'crop', beard: 'none', laurel: true, drape: 'purple' } as const
const withPersonas = (): OnboardingPlan => {
  const p = plan()
  p.agents[0]!.persona = { key: 'vitruvius', name: 'Vitruvius', personality: 'Firmness, usefulness, delight.', bio: 'Builds sites.', look: { ...look } }
  p.agents[1]!.persona = { key: 'aurelia', name: 'Aurelia', personality: 'Remembers every name and every no.', bio: 'Researches leads.', look: { ...look, material: 'bronze' } }
  return p
}

describe('renamePersona', () => {
  it('renames the persona only, never the role label, and leaves the input untouched', () => {
    const p = withPersonas()
    const next = renamePersona(p, 'site-builder', '  Vitruvia   Pollio ')
    expect(next).not.toBe(p)
    expect(next.agents[0]!.persona!.name).toBe('Vitruvia Pollio')
    expect(next.agents[0]!.name).toBe('Site builder')
    expect(next.agents[0]!.persona!.look).toEqual(p.agents[0]!.persona!.look)
    expect(p.agents[0]!.persona!.name).toBe('Vitruvius')
  })

  it('refuses blank, unchanged, duplicate (any case) and persona-less renames; caps at 24', () => {
    const p = withPersonas()
    expect(renamePersona(p, 'site-builder', '   ')).toBe(p)
    expect(renamePersona(p, 'site-builder', 'Vitruvius')).toBe(p)
    expect(renamePersona(p, 'site-builder', 'aurelia')).toBe(p)
    expect(renamePersona(p, 'nobody', 'Cato')).toBe(p)
    expect(renamePersona(plan(), 'site-builder', 'Cato')).toEqual(plan())
    expect(renamePersona(p, 'site-builder', 'A'.repeat(40)).agents[0]!.persona!.name).toHaveLength(24)
  })
})

describe('teamOf and the first task', () => {
  it('finds the first included task per agent', () => {
    const p = plan()
    expect(firstTaskFor(p, 'site-builder')?.ref).toBe('landing')
    p.tasks[0]!.include = false
    expect(firstTaskFor(p, 'site-builder')?.ref).toBe('calendar')
    expect(firstTaskFor(p, 'nobody')).toBeNull()
  })

  it('shows persona names with the role and department; personas off falls back to the role label', () => {
    const on = teamOf(withPersonas(), true)
    expect(on.map((m) => m.name)).toEqual(['Vitruvius', 'Aurelia'])
    expect(on[0]).toMatchObject({ role: 'Site builder', roleLine: 'Site builder · Marketing', department: 'Marketing', firstTask: 'Draft a one-page landing page', personality: 'Firmness, usefulness, delight.' })
    const off = teamOf(withPersonas(), false)
    expect(off.map((m) => m.name)).toEqual(['Site builder', 'Lead researcher'])
    expect(off.every((m) => m.persona === null && m.personality === null)).toBe(true)
    // the ceremony shows only who was created
    const p = withPersonas()
    p.agents[1]!.include = false
    expect(teamOf(p, true, true).map((m) => m.ref)).toEqual(['site-builder'])
    expect(teamOf(p, true).map((m) => m.ref)).toEqual(['site-builder', 'lead-researcher'])
  })

  it('autonomy line uses persona names with roles, and only role labels with personas off', () => {
    expect(autonomyLine(withPersonas())).toBe('Will start on their own: Vitruvius (Site builder). Ask first: Aurelia (Lead researcher).')
    expect(autonomyLine(withPersonas(), true, false)).toBe('Will start on their own: Site builder. Ask first: Lead researcher.')
  })
})

describe('ceremony', () => {
  it('reads plain lines: the title, then each agent with the first task or "No task yet"', () => {
    const p = withPersonas()
    p.tasks = p.tasks.filter((t) => t.agentRef !== 'lead-researcher')
    const lines = ceremonyLines(teamOf(p, true, true))
    expect(lines).toEqual(['Your team is set up.', 'Vitruvius, Site builder. First task: Draft a one-page landing page.', 'Aurelia, Lead researcher. No task yet.'])
    for (const l of lines) expect(l).not.toMatch(/alea|iacta|·/i)
  })

  it('plays only for Start now in playful', () => {
    expect(wantsCeremony(true, 'playful')).toBe(true)
    expect(wantsCeremony(true, 'plain')).toBe(false)
    expect(wantsCeremony(false, 'playful')).toBe(false)
    expect(wantsCeremony(false, 'plain')).toBe(false)
  })
})

describe('passport tablet meta', () => {
  it('shortens goal labels', () => {
    expect(shortGoal('Launch a website')).toBe('Website')
    expect(shortGoal('Post on social')).toBe('Social')
    expect(shortGoal('Get first customers')).toBe('Customers')
  })

  it('adds Site, then Voice and Goals once past the Voice step', () => {
    const base = {
      hasCode: false,
      scan: undefined,
      answers: { siteUrl: 'https://sundaybakery.com/menu', instagram: '', voiceVibe: 'friendly' }
    }
    const early = passportMeta({ ...base, step: 'voice' } as never, ['website'])
    expect(early).toEqual([{ label: 'Site', value: 'sundaybakery.com' }])
    const late = passportMeta({ ...base, step: 'plan' } as never, ['website', 'social'])
    expect(late.map((m) => m.label)).toEqual(['Site', 'Voice', 'Goals'])
    expect(late[2]!.value).toBe('Website · Social')
    const insta = passportMeta({ ...base, step: 'name', answers: { ...base.answers, siteUrl: '', instagram: '@sundaybakery' } } as never, [])
    expect(insta).toEqual([{ label: 'Instagram', value: '@sundaybakery' }])
  })
})
