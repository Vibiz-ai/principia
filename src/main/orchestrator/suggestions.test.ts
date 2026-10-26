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
