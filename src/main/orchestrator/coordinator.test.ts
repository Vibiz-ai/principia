/**
 * ORCHESTRATOR.md §3: the chief of staff. The rules table; the closed set of verbs, refused in code; the pause and
 * monthly cap gates; the daily budget (rules only when it is used up); no self-retrigger; a manual agent's work is
 * only ever suggested; the digest; shadow mode.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { OrchDecision, RunReport } from '../../shared/orchestrator'
import { OrchWorld, report } from './__tests__/world'
import { refusal } from './coordinator'
import { coordinatorRules, digestText, type RulesInput, type RulesTask } from './coordinatorRules'

const worlds: OrchWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose()
})

function setup(over: Parameters<OrchWorld['attachCoordinator']>[0] = {}) {
  const w = new OrchWorld()
  worlds.push(w)
  w.settings = { mode: 'on', coordinator: 'rules', extractFallback: false }
  const co = w.company()
  const dev = w.department(co.id, 'Development', 'development')
  const sup = w.department(co.id, 'Support', 'support')
  const dev1 = w.seat(co.id, dev, 'Bug fixer', 'codex', 'auto')
  const support = w.seat(co.id, sup, 'Support', 'claude', 'manual')
  const coord = w.attachCoordinator(over)
  return { w, co, dev, sup, dev1, support, coord }
}

const task = (o: Partial<RulesTask> & Pick<RulesTask, 'id'>): RulesTask => ({ identifier: o.id.toUpperCase(), title: o.id, status: 'todo', blockReason: null, agentId: null, dependencyIds: [], source: 'manual', externalId: null, asks: false, updatedAt: '2026-10-20T17:00:00.000Z', ...o })
const rep = (r: Partial<RunReport>): RunReport => ({ v: 1, outcome: 'review', summary: 's', evidence: [], followUps: [], questions: [], facts: [], blockers: [], suggestions: [], answers: [], ...r })
const base = (o: Partial<RulesInput>): RulesInput => ({ companyId: 'co', now: '2026-10-20T18:00:00.000Z', events: [], tasks: [], agents: [], autopilot: true, reports: [], routineHistory: [], lastDigestAt: null, ...o })
const ev = (kind: RulesInput['events'][number]['kind'], o: Partial<RulesInput['events'][number]> = {}) => ({ id: `e${Math.random()}`, kind, companyId: 'co', at: '2026-10-20T18:00:00.000Z', ...o })

describe('coordinator rules (pure)', () => {
  it('a done task others waited for: pump', () => {
    const out = coordinatorRules(base({ events: [ev('task_done', { taskId: 'a' })], tasks: [task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'todo', dependencyIds: ['a'] }), task({ id: 'c', dependencyIds: ['a', 'x'] }), task({ id: 'x' })] }))
    expect(out.decisions).toEqual([expect.objectContaining({ verb: 'pump', why: 'A is done; B waited for it' })])
  })

  it('a follow-up filed for an agent who waits to be started: suggest starting it; an automatic one with Autopilot on: nothing', () => {
    const agents = [{ id: 'm', name: 'Support', handle: 'support', auto: false, paused: false }, { id: 'a', name: 'Dev', handle: 'dev', auto: true, paused: false }]
    const tasks = [task({ id: 'f1', status: 'backlog', source: 'agent', externalId: 'run:r1:0', agentId: 'm', title: 'Reply to the lead' }), task({ id: 'f2', status: 'backlog', source: 'agent', externalId: 'run:r1:1', agentId: 'a' })]
    const out = coordinatorRules(base({ agents, tasks, events: [ev('task_created', { taskId: 'f1' }), ev('task_created', { taskId: 'f2' })] }))
    expect(out.decisions).toEqual([expect.objectContaining({ verb: 'suggest', kind: 'task', task: 'f1', title: 'Start F1 for Support: Reply to the lead' })])
    // Autopilot off: the automatic one is suggested too
    expect(coordinatorRules(base({ agents, tasks, autopilot: false, events: [ev('task_created', { taskId: 'f2' })] })).decisions).toHaveLength(1)
  })

  it('the same routine suggested 3 times in 14 days: suggest the routine; twice: nothing yet', () => {
    const r = rep({ suggestions: [{ kind: 'routine', text: 'Check the reviews every Monday', cron: '0 9 * * 1' }] })
    const h = (n: number) => Array.from({ length: n }, (_, i) => ({ text: 'check the reviews every monday!', at: `2026-10-${String(10 + i).padStart(2, '0')}T09:00:00.000Z` }))
    const three = coordinatorRules(base({ reports: [{ runId: 'r', taskId: null, agentId: null, report: r, at: '' }], routineHistory: h(3) }))
    expect(three.decisions).toEqual([expect.objectContaining({ verb: 'suggest', kind: 'routine', cron: '0 9 * * 1', title: 'Make it a routine: Check the reviews every Monday' })])
    expect(coordinatorRules(base({ reports: [{ runId: 'r', taskId: null, agentId: null, report: r, at: '' }], routineHistory: h(2) })).decisions).toEqual([])
    // older than 14 days does not count
    expect(coordinatorRules(base({ reports: [{ runId: 'r', taskId: null, agentId: null, report: r, at: '' }], routineHistory: h(3).map((x) => ({ ...x, at: '2026-09-01T00:00:00.000Z' })) })).decisions).toEqual([])
  })

  it('a run that needs a connection: suggest it with its connect link; a task idea: suggest the task', () => {
    const r = rep({ blockers: [{ text: 'No access to the inbox', needs: 'connection', connectionId: 'gmail' }], suggestions: [{ kind: 'task', text: 'Write a FAQ page' }] })
    const out = coordinatorRules(base({ reports: [{ runId: 'r', taskId: null, agentId: null, report: r, at: '' }] }))
    expect(out.decisions.map((d) => [d.verb, d.kind, d.connectionId ?? d.title])).toEqual([['suggest', 'connection', 'gmail'], ['suggest', 'task', 'Write a FAQ page']])
  })

  it('the daily tick posts a digest when something happened, at most once in 20 hours', () => {
    const tasks = [task({ id: 'd', status: 'done' }), task({ id: 'r', status: 'in_review' }), task({ id: 'q', status: 'blocked', asks: true }), task({ id: 'w', status: 'in_progress' })]
    const out = coordinatorRules(base({ tasks, events: [ev('tick')] }))
    expect(out.decisions).toEqual([{ verb: 'digest_post', text: '1 done since yesterday (D). 2 wait for you: Q (a question), R (to review). 1 working now (W).', why: 'the daily digest' }])
    expect(coordinatorRules(base({ tasks, events: [ev('tick')], lastDigestAt: '2026-10-20T08:00:00.000Z' })).decisions).toEqual([])
    expect(digestText({ tasks: [task({ id: 'x', status: 'todo' })], now: '2026-10-20T18:00:00.000Z' })).toBeNull()
  })

  it('what rules cannot decide is ambiguous (a person posted, progress with no next step, an agent with nothing to do)', () => {
    const agents = [{ id: 'a', name: 'Dev', handle: 'dev', auto: true, paused: false }]
    const out = coordinatorRules(
      base({
        agents,
        tasks: [task({ id: 'p', status: 'in_review' }), task({ id: 'd', status: 'done', agentId: 'a' })],
        events: [ev('forum_human_post', { text: 'What should we do about the holiday menu?' }), ev('run_ended', { runId: 'r', taskId: 'p' }), ev('task_done', { taskId: 'd' })],
        reports: [{ runId: 'r', taskId: 'p', agentId: null, report: rep({ outcome: 'progress' }), at: '' }]
      })
    )
    expect(out.ambiguous).toEqual(['You posted in the Forum: "What should we do about the holiday menu?"', 'P made progress but named no next step', 'D is done and Dev has nothing else to do'])
  })
})

describe('the closed set of verbs, refused in code', () => {
  it('names why each forbidden verb is refused', () => {
    expect(refusal('pump')).toBeNull()
    expect(refusal('spend_money')).toMatch(/never spends money/)
    expect(refusal('publish_post')).toMatch(/never publishes/)
    expect(refusal('send_email')).toMatch(/outside the company/)
    expect(refusal('delete_task')).toMatch(/never deletes/)
    expect(refusal('approve_task')).toMatch(/Only you approve/)
    expect(refusal('close_task')).toMatch(/Only you approve or close/)
    expect(refusal('create_company')).toMatch(/Only you create companies/)
    expect(refusal('create_department')).toMatch(/Only you create companies or departments/)
    expect(refusal('dance')).toBe('Not something Principia does on its own')
  })

  it('a model that proposes forbidden things changes nothing; its allowed decisions go through', async () => {
    const decisions: OrchDecision[] = [
      { verb: 'spend_money', text: 'Buy ads for $500' },
      { verb: 'approve_task', task: 'X' },
      { verb: 'delete_task', task: 'X' },
      { verb: 'create_company', title: 'Spinoff' },
      { verb: 'send_email', to: 'press@example.com', text: 'hi' },
      { verb: 'file_task', title: 'Plan the holiday menu', to: 'development', why: 'you asked' }
    ]
    const { w, co, coord } = setup({ model: async () => ({ decisions, usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.001, model: 'haiku' }, cli: 'claude' }) })
    w.settings = { ...w.settings, coordinator: 'model' }
    const t = w.task({ companyId: co.id, title: 'Approve me', status: 'backlog' })
    const before = w.c.listTasks(co.id).length
    coord.event({ kind: 'forum_human_post', companyId: co.id, text: 'Holiday menu?' })
    const rec = (await coord.flush(co.id))!
    expect(rec.mode).toBe('model')
    expect(rec.costTokens).toBe(120)
    expect(rec.results.filter((r) => r.status === 'refused').map((r) => r.verb)).toEqual(['spend_money', 'approve_task', 'delete_task', 'create_company', 'send_email'])
    expect(rec.results.at(-1)).toMatchObject({ verb: 'file_task', status: 'done' })
    expect(w.c.listTasks(co.id)).toHaveLength(before + 1)
    expect(w.c.task(t.id).status).toBe('backlog')
    expect(w.c.listPassports().filter((c) => c.name === 'Spinoff')).toHaveLength(0)
  })
})

describe('gates, budget and self-retrigger', () => {
  it('a paused company, or one at its monthly cap, gets no decisions, only one line saying why; the setting off drops events', async () => {
    let cap = false
    const { w, co, coord } = setup({ overCap: () => cap })
    const a = w.task({ companyId: co.id, title: 'A', status: 'done' })
    w.task({ companyId: co.id, title: 'B', status: 'todo', dependencyIds: [a.id] })
    w.c.pauseCompany(co.id)
    coord.event({ kind: 'task_done', companyId: co.id, taskId: a.id })
    const paused = await coord.flush(co.id)
    expect(paused).toMatchObject({ results: [] })
    expect(paused!.note).toContain('paused')
    // the same reason again within hours: no second line
    coord.event({ kind: 'task_done', companyId: co.id, taskId: a.id })
    expect(await coord.flush(co.id)).toBeNull()
    w.c.resumeCompany(co.id)
    cap = true
    coord.event({ kind: 'task_done', companyId: co.id, taskId: a.id })
    expect((await coord.flush(co.id))!.note).toContain('monthly spending cap')
    cap = false
    coord.event({ kind: 'task_done', companyId: co.id, taskId: a.id })
    expect((await coord.flush(co.id))?.results.map((r) => r.verb)).toEqual(['pump'])
    // this company's own switch off: events are dropped at once
    w.settings = { ...w.settings, companies: { [co.id]: { mode: 'off' } } }
    expect(coord.event({ kind: 'task_done', companyId: co.id, taskId: a.id })).toBe(false)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM orch_decisions').get()).toEqual({ n: 3 })
  })

  it('model mode with the daily budget used up falls back to rules and says so; a failing call too', async () => {
    let calls = 0
    let fail = false
    const { w, co, coord } = setup({
      model: async () => {
        calls++
        return fail ? null : { decisions: [], usage: { tokensIn: 1, tokensOut: 1, costUsd: null, model: null }, cli: 'claude' }
      }
    })
    w.settings = { ...w.settings, coordinator: 'model', callsPerDay: 1 }
    coord.event({ kind: 'forum_human_post', companyId: co.id, text: 'What next?' })
    expect((await coord.flush(co.id))).toBeNull() // the model answered nothing to do: no row
    expect(calls).toBe(1)
    coord.event({ kind: 'forum_human_post', companyId: co.id, text: 'And now?' })
    const rec = (await coord.flush(co.id))!
    expect(calls).toBe(1)
    expect(rec.mode).toBe('rules')
    expect(rec.note).toMatch(/AI calls for this company are used up/)
    w.settings = { ...w.settings, callsPerDay: 5 }
    fail = true
    coord.event({ kind: 'forum_human_post', companyId: co.id, text: 'Hello?' })
    expect((await coord.flush(co.id))!.note).toMatch(/did not answer in time/)
  })

  it('events the coordinator causes itself never start another batch', async () => {
    const { w, co, coord } = setup({ model: async () => ({ decisions: [{ verb: 'file_task', title: 'Draft the holiday menu', to: 'development' }], usage: { tokensIn: 1, tokensOut: 1, costUsd: null, model: null }, cli: 'codex' }) })
    w.settings = { ...w.settings, coordinator: 'model' }
    coord.event({ kind: 'forum_human_post', companyId: co.id, text: 'Holiday menu?' })
    const rec = (await coord.flush(co.id))!
    expect(rec.results[0]).toMatchObject({ verb: 'file_task', status: 'done' })
    // the new task fired task_created through the board hooks while the coordinator acted: dropped
    expect(coord.pendingFor(co.id)).toEqual([])
    // and a later event about that task (its own doing) is dropped as well
    const filed = w.c.listTasks(co.id).find((t) => t.title === 'Draft the holiday menu')!
    expect(filed.externalId).toMatch(/^orch:/)
    expect(coord.event({ kind: 'task_created', companyId: co.id, taskId: filed.id })).toBe(false)
  })

  it('events are debounced into one batch per company (2 minutes, at most 10 after the first)', () => {
    const { w, co, coord } = setup()
    coord.event({ kind: 'tick', companyId: co.id })
    w.clock = new Date(w.clock.getTime() + 9.5 * 60_000)
    coord.event({ kind: 'tick', companyId: co.id })
    expect(coord.pendingFor(co.id)).toHaveLength(2)
    expect(w.timers.map((t) => t.ms)).toEqual([120_000, 30_000])
  })
})

describe('decisions on the real board', () => {
  it('a manual agent\'s follow-up from a run report becomes a suggestion in Needs you; accepting starts it', async () => {
    const { w, co, dev, dev1, support, coord } = setup()
    w.scripts.set(dev1.id, () => ({ output: report({ outcome: 'review', summary: 'Fixed the cart', followUps: [{ title: 'Tell the customer it is fixed', goal: 'reply to the ticket', departmentKey: 'support' }] }) }))
    const t = w.task({ companyId: co.id, title: 'Fix the cart', departmentId: dev.id, agentId: dev1.id })
    await w.runNow(t.id)
    await w.play(w.turns[0])
    const follow = w.c.listTasks(co.id).find((x) => x.title === 'Tell the customer it is fixed')!
    expect(follow).toMatchObject({ status: 'backlog', agentId: support.id })
    // the task itself, its follow-up, the run's end
    expect(coord.pendingFor(co.id).map((e) => e.kind).sort()).toEqual(['run_ended', 'task_created', 'task_created'])
    const rec = (await coord.flush(co.id))!
    expect(rec.results).toEqual([expect.objectContaining({ verb: 'suggest', status: 'done', ref: follow.identifier })])
    const open = w.suggestions!.list(co.id)
    expect(open).toEqual([expect.objectContaining({ kind: 'task', taskId: follow.id, title: expect.stringMatching(new RegExp(`^Start ${follow.identifier} for \\w+: Tell the customer it is fixed$`)) })])
    // the task's own Activity says who suggested it
    expect(w.c.detail(follow.id).activity.some((a) => a.message.startsWith('Principia (chief of staff): suggested you start'))).toBe(true)
    // the founder's yes starts it (a human start)
    const res = w.suggestions!.decide(open[0].id, 'accept', { createRoutine: () => 'x', startTask: (id) => (w.d.runNow(id), `Started ${follow.identifier}.`), fileTask: () => 'x' })
    expect(res.detail).toBe(`Started ${follow.identifier}.`)
    expect(w.c.task(follow.id).status).toBe('in_progress')
    expect(w.suggestions!.list(co.id)).toEqual([])
  })

  it('wake_task on a manual agent\'s task is only suggested; on an automatic one it wakes it', async () => {
    const { w, co, dev, sup, dev1, support, coord } = setup()
    const m = w.task({ companyId: co.id, title: 'Answer the reviews', status: 'backlog', departmentId: sup.id, agentId: support.id })
    const a = w.task({ companyId: co.id, title: 'Speed up the menu page', status: 'backlog', departmentId: dev.id, agentId: dev1.id })
    const r1 = coord.apply(co.id, 'odc_t', 0, { verb: 'wake_task', task: m.identifier, text: 'Three new reviews came in' }, { shadow: false, by: 'model', autopilot: true, runId: null })
    expect(r1).toMatchObject({ verb: 'wake_task', status: 'done' })
    expect(r1.detail).toMatch(/^Suggested to you in Needs you/)
    expect(w.c.task(m.id).pendingWake).toBeNull()
    const r2 = coord.apply(co.id, 'odc_t', 1, { verb: 'wake_task', task: a.identifier, text: 'The menu page is slow on phones' }, { shadow: false, by: 'model', autopilot: true, runId: null })
    expect(r2).toMatchObject({ status: 'done', ref: a.identifier })
    expect(w.c.task(a.id).pendingWake?.reasons.at(-1)).toBe('Principia (chief of staff): The menu page is slow on phones')
  })

  it('file_task: To do for an automatic agent with Autopilot on, Backlog plus a suggestion for a manual one; deduplicated', () => {
    const { w, co, coord } = setup()
    const o = { shadow: false, by: 'model' as const, autopilot: true, runId: null }
    expect(coord.apply(co.id, 'odc_f', 0, { verb: 'file_task', title: 'Fix the slow menu page', to: 'development' }, o)).toMatchObject({ status: 'done' })
    expect(coord.apply(co.id, 'odc_f', 1, { verb: 'file_task', title: 'Reply to the wholesale lead', to: '@support' }, o).detail).toMatch(/Support waits for you, so it is in Backlog/)
    expect(coord.apply(co.id, 'odc_f', 2, { verb: 'file_task', title: 'fix the SLOW menu page!', to: 'development' }, o)).toMatchObject({ status: 'skipped' })
    const tasks = w.c.listTasks(co.id)
    expect(['todo', 'in_progress']).toContain(tasks.find((t) => t.title === 'Fix the slow menu page')!.status)
    expect(tasks.find((t) => t.title === 'Reply to the wholesale lead')!.status).toBe('backlog')
    expect(w.suggestions!.list(co.id)).toHaveLength(1)
  })

  it('the digest is Principia\'s own line in the Team room, once a day', async () => {
    const { w, co, coord } = setup()
    w.task({ companyId: co.id, title: 'Done thing', status: 'in_review' })
    coord.tick([co.id])
    coord.tick([co.id]) // the same day: one tick
    expect(coord.pendingFor(co.id).filter((e) => e.kind === 'tick')).toHaveLength(1)
    const rec = (await coord.flush(co.id))!
    expect(rec.results).toEqual([expect.objectContaining({ verb: 'digest_post', status: 'done' })])
    const line = w.db.prepare("SELECT text, origin, kind FROM forum_messages WHERE origin='principia:coordinator'").all() as { text: string; origin: string; kind: string }[]
    expect(line).toHaveLength(1)
    expect(line[0]).toMatchObject({ kind: 'system' })
    expect(line[0].text).toMatch(/1 waits for you/)
    expect(w.forum.store.message(parseInt(rec.results[0].ref!.slice(1), 36)).via).toBe('principia')
    // a post the model decides later that day is its own line, not the day's digest again
    const o = { shadow: false, by: 'model' as const, autopilot: true, runId: null }
    const r2 = coord.apply(co.id, 'odc_m', 0, { verb: 'digest_post', text: 'For the holiday menu we need the brand guide first.' }, o)
    expect(r2.status).toBe('done')
    expect(r2.ref).not.toBe(rec.results[0].ref)
  })

  it('shadow mode writes down what it would do and changes nothing', async () => {
    const { w, co, coord } = setup()
    w.settings = { ...w.settings, mode: 'shadow' }
    const before = w.c.listTasks(co.id).length
    const r = coord.apply(co.id, 'odc_s', 0, { verb: 'file_task', title: 'Something new' }, { shadow: true, by: 'rules', autopilot: true, runId: null })
    expect(r.status).toBe('shadow')
    expect(coord.apply(co.id, 'odc_s', 1, { verb: 'suggest', kind: 'routine', title: 'Weekly report' }, { shadow: true, by: 'rules', autopilot: true, runId: null }).status).toBe('shadow')
    expect(w.c.listTasks(co.id)).toHaveLength(before)
    expect(w.suggestions!.list(co.id)).toEqual([])
    coord.tick([co.id])
    w.task({ companyId: co.id, title: 'Waiting', status: 'in_review' })
    const rec = (await coord.flush(co.id))!
    expect(rec.results[0].status).toBe('shadow')
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM forum_messages WHERE origin='principia:coordinator'").get()).toEqual({ n: 0 })
  })
})
