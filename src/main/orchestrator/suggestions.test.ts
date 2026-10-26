/** ORCHESTRATOR.md §3 "pushing features": suggestions in Needs you, with cooldowns per fingerprint and a daily cap. */
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { routineTemplateFor, safeCron, Suggestions, type AcceptDeps } from './suggestions'
import { parseDeepLink } from '../../shared/deepLink'

let db: DB
let now = new Date('2026-10-20T09:00:00.000Z')
let s: Suggestions
const changed: string[] = []
const act = (log: string[]): AcceptDeps => ({
  createRoutine: (x) => (log.push(`routine:${x.cron}`), 'Check the reviews'),
  startTask: (id) => (log.push(`start:${id}`), 'Started NC-8.'),
  fileTask: (x) => (log.push(`file:${x.title}`), 'NC-9')
})

beforeEach(() => {
  db = openDatabase(':memory:')
  now = new Date('2026-10-20T09:00:00.000Z')
  changed.length = 0
  s = new Suggestions({ db, now: () => now, redact: (t) => t.replace(/sk-test-\w+/g, '••••'), onChange: (id) => changed.push(id) })
})

describe('suggestions', () => {
  it('never opens the same one twice, and waits 14 days after a dismissal', () => {
    expect(s.suggest({ companyId: 'co', kind: 'routine', title: 'Check the reviews every Monday', cron: '0 9 * * 1' }).status).toBe('created')
    expect(s.suggest({ companyId: 'co', kind: 'routine', title: 'check the reviews, every monday' })).toMatchObject({ status: 'skipped', detail: 'already suggested, waiting for you' })
    const [open] = s.list('co')
    s.decide(open.id, 'dismiss', act([]))
    now = new Date('2026-10-30T09:00:00.000Z')
    expect(s.suggest({ companyId: 'co', kind: 'routine', title: 'Check the reviews every Monday' }).detail).toMatch(/dismissed this less than 14 days ago/)
    now = new Date('2026-11-04T10:00:00.000Z')
    expect(s.suggest({ companyId: 'co', kind: 'routine', title: 'Check the reviews every Monday' }).status).toBe('created')
    expect(changed.length).toBeGreaterThan(0)
  })

  it('at most 3 new suggestions per company per day; other companies keep their own', () => {
    for (const t of ['A', 'B', 'C']) expect(s.suggest({ companyId: 'co', kind: 'task', title: `Idea ${t}` }).status).toBe('created')
    expect(s.suggest({ companyId: 'co', kind: 'task', title: 'Idea D' }).detail).toMatch(/already suggested 3 things today/)
    expect(s.suggest({ companyId: 'other', kind: 'task', title: 'Idea D' }).status).toBe('created')
    now = new Date('2026-10-21T09:30:00.000Z')
    expect(s.suggest({ companyId: 'co', kind: 'task', title: 'Idea D' }).status).toBe('created')
  })

  it('a connection carries its connect link; a task to start is keyed by the task; text is redacted', () => {
    s.suggest({ companyId: 'co', kind: 'connection', title: 'Connect the inbox sk-test-abc', connectionId: 'notion' })
    s.suggest({ companyId: 'co', kind: 'task', title: 'Start NC-8', taskId: 'task_1', taskIdentifier: 'NC-8' })
    expect(s.suggest({ companyId: 'co', kind: 'task', title: 'Start NC-8 now!', taskId: 'task_1' }).status).toBe('skipped')
    const [c, t] = s.list('co')
    expect(c).toMatchObject({ kind: 'connection', link: 'principia://connect/notion?company=co', title: 'Connect the inbox ••••' })
    expect(t).toMatchObject({ kind: 'task', taskId: 'task_1', taskIdentifier: 'NC-8' })
  })

  it('accepting runs its one action (the founder\'s yes); a failed action leaves it open', () => {
    const log: string[] = []
    s.suggest({ companyId: 'co', kind: 'routine', title: 'Weekly numbers', cron: '0 9 * * 1' })
    s.suggest({ companyId: 'co', kind: 'task', title: 'Start NC-8', taskId: 'task_1' })
    s.suggest({ companyId: 'co', kind: 'task', title: 'Write a FAQ page' })
    const [r, t, f] = s.list('co')
    expect(s.decide(r.id, 'accept', act(log)).detail).toBe('Made the routine "Check the reviews".')
    expect(s.decide(t.id, 'accept', act(log)).detail).toBe('Started NC-8.')
    expect(s.decide(f.id, 'accept', act(log)).detail).toBe('Filed NC-9 in To do.')
    expect(log).toEqual(['routine:0 9 * * 1', 'start:task_1', 'file:Write a FAQ page'])
    expect(s.list('co')).toEqual([])
    s.suggest({ companyId: 'co2', kind: 'routine', title: 'Daily' })
    const [d] = s.list('co2')
    expect(() => s.decide(d.id, 'accept', { ...act([]), createRoutine: () => { throw new Error('Add an agent first') } })).toThrow('Add an agent first')
    expect(s.get(d.id)?.status).toBe('open')
  })

  it('a cron must look like one (the scheduler checks it again on accept)', () => {
    expect(safeCron('0 9 * * 1-5')).toBe('0 9 * * 1-5')
    expect(safeCron('0 9 * *')).toBeNull()
    expect(safeCron('$(rm -rf /) * * * *')).toBeNull()
    s.suggest({ companyId: 'co', kind: 'routine', title: 'Bad cron', cron: 'every day' })
    expect(s.list('co')[0].cron).toBeUndefined()
  })

  it('a ready-made routine links to Routines (turned on there, never made twice); one already on is not suggested', () => {
    expect(routineTemplateFor('A morning brief every weekday')).toBe('morning-brief')
    expect(routineTemplateFor('Digest of open pull requests')).toBe('repo-health')
    expect(routineTemplateFor('Check the reviews every Monday')).toBeNull()
    const on = new Set<string>()
    s = new Suggestions({ db, now: () => now, routineOn: (co, id) => on.has(`${co}:${id}`) })
    s.suggest({ companyId: 'co_a', kind: 'routine', title: 'Make it a routine: a daily summary of what got done', cron: '30 7 * * 1-5' })
    const [r] = s.list('co_a')
    expect(r.routineId).toBe('morning-brief')
    expect(parseDeepLink(r.link)).toEqual({ kind: 'automations', tab: 'routines', add: 'morning-brief', at: '07:30', days: 'mon,tue,wed,thu,fri', companyId: 'co_a' })
    const log: string[] = []
    expect(s.decide(r.id, 'accept', act(log)).detail).toContain('press Turn on')
    expect(log).toEqual([])
    on.add('co_b:morning-brief')
    expect(s.suggest({ companyId: 'co_b', kind: 'routine', title: 'A morning brief' })).toMatchObject({ status: 'skipped', detail: 'the Morning brief routine is already on' })
  })
})

describe('autopilot offers (AUTOPILOT.md §6)', () => {
  const offer = (companyId: string, playbookId: string, level?: number) => s.suggest({ companyId, kind: 'autopilot', title: 'Put your ads on autopilot?', playbookId, ...(level ? { level } : {}) })
  const turned: string[] = []
  const acts = (): AcceptDeps => ({ ...act([]), turnOnPlaybook: (x, level) => (turned.push(`${x.companyId}:${x.playbookId}:${level}`), 'on'), resumePlaybook: (x) => (turned.push(`resume:${x.playbookId}`), 'resumed') })
  beforeEach(() => {
    turned.length = 0
  })

  it('accepting turns the playbook on at the level the founder picked; a money playbook only up to Level 2 here', () => {
    expect(offer('co', 'ads-watch').status).toBe('created')
    const [o] = s.list('co')
    expect(o).toMatchObject({ kind: 'autopilot', playbookId: 'ads-watch', level: 1 })
    expect(() => s.decide(o.id, 'accept', acts(), { level: 3 })).toThrow(/Level 1 or 2 here/)
    expect(s.get(o.id)!.status).toBe('open')
    s.decide(o.id, 'accept', acts(), { level: 2 })
    expect(turned).toEqual(['co:ads-watch:2'])
    expect(s.get(o.id)!.status).toBe('accepted')
  })
  it('an offer never preselects above what the playbook allows without a raise', () => {
    offer('co', 'ads-watch', 3)
    expect(s.list('co')[0].level).toBe(2)
  })
  it('at most one autopilot offer per company per day, never one already on, unknown ones refused', () => {
    const on = new Set(['co_b:site-watch'])
    s = new Suggestions({ db, now: () => now, playbookOn: (co, id) => on.has(`${co}:${id}`) })
    expect(offer('co_a', 'ads-watch').status).toBe('created')
    expect(offer('co_a', 'site-watch').detail).toMatch(/already offered an autopilot today/)
    // another company keeps its own day
    expect(offer('co_b', 'ads-watch').status).toBe('created')
    expect(offer('co_b', 'social-rhythm').detail).toMatch(/already offered an autopilot today/)
    now = new Date('2026-10-21T10:00:00.000Z')
    expect(offer('co_b', 'site-watch').detail).toMatch(/already on/)
    expect(offer('co_a', 'make-money').detail).toMatch(/not an autopilot Principia knows/)
  })
  it('Not now waits 14 days; Never for this never comes back', () => {
    offer('co', 'ads-watch')
    s.decide(s.list('co')[0].id, 'dismiss', acts())
    now = new Date('2026-10-25T09:00:00.000Z')
    expect(offer('co', 'ads-watch').detail).toMatch(/less than 14 days ago/)
    now = new Date('2026-11-05T09:00:00.000Z')
    expect(offer('co', 'ads-watch').status).toBe('created')
    const again = s.list('co')[0]
    expect(s.decide(again.id, 'never', acts()).detail).toMatch(/will not offer this autopilot again/)
    now = new Date('2027-06-01T09:00:00.000Z')
    expect(offer('co', 'ads-watch').detail).toBe('you said never for this')
    // "never" is only for autopilot offers
    s.suggest({ companyId: 'co', kind: 'task', title: 'Write the FAQ' })
    expect(() => s.decide(s.list('co').find((x) => x.kind === 'task')!.id, 'never', acts())).toThrow(/Only an autopilot offer/)
  })
  it('an offer over the day’s limit is kept for the next day, not lost, and opens by itself', () => {
    expect(offer('co', 'ads-watch').status).toBe('created')
    const kept = offer('co', 'site-watch')
    expect(kept.detail).toMatch(/kept for tomorrow/)
    expect(s.list('co').map((x) => x.playbookId)).toEqual(['ads-watch'])
    expect(offer('co', 'site-watch').detail).toMatch(/kept for a later day/)
    expect(s.offerable('co', 'site-watch')).toBe(false)
    now = new Date('2026-10-21T09:30:00.000Z')
    expect(s.list('co').map((x) => x.playbookId)).toEqual(['ads-watch', 'site-watch'])
    expect(s.get(kept.id!)!.status).toBe('open')
  })
  it('offerable: the chief of staff skips answered playbooks, so the next best one is offered', () => {
    expect(s.offerable('co', 'ads-watch')).toBe(true)
    offer('co', 'ads-watch')
    expect(s.offerable('co', 'ads-watch')).toBe(false)
    s.decide(s.list('co')[0].id, 'dismiss', acts())
    expect(s.offerable('co', 'ads-watch')).toBe(false)
    expect(s.offerable('co', 'site-watch')).toBe(true)
    now = new Date('2026-11-05T09:00:00.000Z')
    expect(s.offerable('co', 'ads-watch')).toBe(true)
  })
  it('the offer carries the founder’s own daily budget and the missing connection, and never preselects Level 3', () => {
    s.suggest({ companyId: 'co', kind: 'autopilot', title: 'Put your ads on autopilot?', playbookId: 'ads-watch', budgetUsd: 10, needs: { label: 'your ads account', connectId: 'meta-ads' } })
    expect(s.list('co')[0]).toMatchObject({ budgetUsd: 10, needs: { connectId: 'meta-ads' }, link: expect.stringContaining('connect/meta-ads') })
    s.suggest({ companyId: 'co2', kind: 'autopilot', title: 'Keep your site watched?', playbookId: 'site-watch', level: 3 })
    expect(s.list('co2')[0].level).toBe(2)
    const o = s.list('co2')[0]
    expect(() => s.decide(o.id, 'accept', acts(), { level: 3 })).toThrow(/Level 1 or 2 here/)
  })
  it('a paused autopilot card skips the daily caps and Resume resumes it', () => {
    offer('co', 'ads-watch')
    expect(s.suggest({ companyId: 'co', kind: 'autopilot', breach: true, playbookId: 'ads-watch', title: 'Ads watch is paused' }).status).toBe('created')
    const card = s.list('co').find((x) => x.breach)!
    expect(s.decide(card.id, 'accept', acts()).detail).toBe('resumed')
    expect(turned).toEqual(['resume:ads-watch'])
  })
})
