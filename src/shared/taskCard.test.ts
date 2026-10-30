import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { chatTaskCard, chatTaskCards, clockLabel, matchesOption, notAnAnswer, saysGoAhead, taskAskAck, taskStatusLine, taskAskKey, taskAskSay, waitsForAnswer, elapsedLabel, queuedReason, isFinishedCard, isOpenCard, sameRequest, taskCardResult, taskCardState, taskResultLine, TASK_CARD_LABEL, workingStrip, type StripTask } from './taskCard'
import { buildBlocks } from './chatView'

describe('taskCardState (CHAT-UI.md §8)', () => {
  it('maps every board status to one of six card states', () => {
    expect(taskCardState({ status: 'todo' })).toBe('queued')
    expect(taskCardState({ status: 'backlog' })).toBe('queued')
    expect(taskCardState({ status: 'triage' })).toBe('queued')
    expect(taskCardState({ status: 'in_progress', runId: 'r1' })).toBe('working')
    expect(taskCardState({ status: 'in_review' })).toBe('in_review')
    expect(taskCardState({ status: 'done' })).toBe('done')
    expect(taskCardState({ status: 'canceled' })).toBe('failed')
  })
  it('needs you: an unanswered board ask, a live ask on the run, or a block that waits on a person', () => {
    expect(taskCardState({ status: 'in_progress', ask: { answer: undefined } })).toBe('needs_you')
    expect(taskCardState({ status: 'in_progress', ask: { answer: 'yes' } })).toBe('working')
    expect(taskCardState({ status: 'in_progress' }, { openAsk: true })).toBe('needs_you')
    expect(taskCardState({ status: 'blocked', blockReason: 'needs_input' })).toBe('needs_you')
    expect(taskCardState({ status: 'blocked', blockReason: 'manual' })).toBe('needs_you')
    expect(taskCardState({ status: 'todo', ask: {} })).toBe('needs_you')
  })
  it('a block on other tasks is still queued; a run that went wrong is failed', () => {
    expect(taskCardState({ status: 'blocked', blockReason: 'deps' })).toBe('queued')
    for (const r of ['run_failed', 'interrupted', 'no_report', 'limit']) expect(taskCardState({ status: 'blocked', blockReason: r })).toBe('failed')
  })
  it('labels, open and finished', () => {
    expect(Object.values(TASK_CARD_LABEL)).toEqual(['Queued', 'Working', 'Needs you', 'In review', 'Done', 'Failed'])
    expect(['queued', 'working', 'needs_you'].every((s) => isOpenCard(s as never))).toBe(true)
    expect(['in_review', 'done', 'failed'].every((s) => isFinishedCard(s as never) && !isOpenCard(s as never))).toBe(true)
  })
})

describe('the card result and clock', () => {
  it('one line from the report, else the done note', () => {
    expect(taskCardResult({ report: { summary: '\n  Lifted the hero  \nmore' } })).toBe('Lifted the hero')
    expect(taskCardResult({ report: null, doneNote: 'Shipped' })).toBe('Shipped')
    expect(taskCardResult({})).toBeNull()
    expect(taskCardResult({ doneNote: 'x'.repeat(300) })!.length).toBe(200)
  })
  it('elapsed reads like a person would say it', () => {
    const t0 = '2026-10-27T10:00:00.000Z'
    const at = (s: number) => Date.parse(t0) + s * 1000
    expect(elapsedLabel(t0, null, at(40))).toBe('40s')
    expect(elapsedLabel(t0, null, at(125))).toBe('2m')
    expect(elapsedLabel(t0, null, at(3900))).toBe('1h 5m')
    expect(elapsedLabel(t0, null, at(7200))).toBe('2h')
    expect(elapsedLabel(t0, null, at(3 * 86400))).toBe('3d')
    expect(elapsedLabel(t0, '2026-10-27T10:03:00.000Z', at(9999))).toBe('3m')
  })
  it('the working clock counts seconds: "Working · 1m 12s"', () => {
    const t0 = '2026-10-27T10:00:00.000Z'
    const at = (s: number) => Date.parse(t0) + s * 1000
    expect(clockLabel(t0, null, at(0))).toBe('0s')
    expect(clockLabel(t0, null, at(59.9))).toBe('59s')
    expect(clockLabel(t0, null, at(72))).toBe('1m 12s')
    expect(clockLabel(t0, null, at(3900))).toBe('1h 5m')
    expect(clockLabel(t0, null, at(7200))).toBe('2h')
    expect(clockLabel(t0, '2026-10-27T10:00:30.000Z', at(9999))).toBe('30s')
    expect(clockLabel('nope', null, at(1))).toBe('')
  })
})

describe('queuedReason: why a queued card waits, and whether Run now can start it', () => {
  const task = { status: 'todo', agentId: 'ag_julia', blockReason: null, ask: null }
  const agent = { name: 'Julia', archivedAt: null, pausedAt: null, data: { autonomy: 'auto', mode: 'headless' } }
  const company = { name: 'Vibiz', autopilot: true, pausedAt: null, maxInFlight: 3 }
  const base = { task, agent, company, depsOpen: [], inFlight: 0, agentRunning: 0 }
  it('nobody on it, a paused company or seat, dependencies and an open question cannot be run from the card', () => {
    expect(queuedReason({ ...base, task: { ...task, agentId: null } })).toEqual({ text: 'Nobody is on it yet: assign an agent', canRun: false })
    expect(queuedReason({ ...base, task: { ...task, status: 'triage', agentId: null } }).text).toBe('Waiting to be routed to an agent')
    expect(queuedReason({ ...base, task: { ...task, agentId: null, assigneeProfileId: 'pr_1' } }).canRun).toBe(true)
    expect(queuedReason({ ...base, company: { ...company, pausedAt: 'x' } })).toEqual({ text: 'Vibiz is paused: nothing starts until you resume it', canRun: false })
    expect(queuedReason({ ...base, agent: { ...agent, pausedAt: 'x' } })).toEqual({ text: 'Julia is paused', canRun: false })
    expect(queuedReason({ ...base, agent: { ...agent, archivedAt: 'x' } }).text).toBe('Julia is archived')
    expect(queuedReason({ ...base, depsOpen: ['VO-3'] })).toEqual({ text: 'Waiting for VO-3 to finish', canRun: false })
    expect(queuedReason({ ...base, depsOpen: ['VO-3', 'VO-4', 'VO-5', 'VO-6'] }).text).toBe('Waiting for VO-3, VO-4 and 2 more to finish')
    expect(queuedReason({ ...base, task: { ...task, status: 'blocked', blockReason: 'deps' } }).text).toBe('Waiting for its dependencies to finish')
    expect(queuedReason({ ...base, task: { ...task, ask: { answer: null } } })).toEqual({ text: 'Waiting for your answer', canRun: false })
  })
  it('autopilot off, a manual or session seat: it waits for Run now (Start without code)', () => {
    expect(queuedReason({ ...base, company: { ...company, autopilot: false } })).toEqual({ text: 'Autopilot is off in Vibiz: it waits for you to press Run now', canRun: true })
    expect(queuedReason({ ...base, company: { ...company, autopilot: false }, runLabel: 'Start' }).text).toBe('Autopilot is off in Vibiz: it waits for you to press Start')
    // work the founder already said go to starts with autopilot off too
    expect(queuedReason({ ...base, company: { ...company, autopilot: false }, startsAnyway: true }).text).toBe('Starting in a moment')
    expect(queuedReason({ ...base, agent: { ...agent, data: { autonomy: 'manual', mode: 'headless' } } }).text).toBe('Julia starts only when you say so: press Run now')
    expect(queuedReason({ ...base, agent: { ...agent, data: { autonomy: 'auto', mode: 'session' } } }).text).toBe('Julia works in a session: it starts when you press Run now')
    expect(queuedReason({ ...base, task: { ...task, status: 'backlog' } })).toEqual({ text: 'In the backlog: it starts when it moves to To do, or with Run now', canRun: true })
  })
  it('the company is at a limit it set; else it starts in a moment', () => {
    expect(queuedReason({ ...base, inFlight: 3 })).toEqual({ text: '3 tasks are already running in Vibiz (at most 3 at once)', canRun: true })
    // PR-69: no limit set, nothing holds it, however much runs
    expect(queuedReason({ ...base, company: { ...company, maxInFlight: undefined }, inFlight: 30 })).toEqual({ text: 'Starting in a moment', canRun: true })
    expect(queuedReason(base)).toEqual({ text: 'Starting in a moment', canRun: true })
  })
})

describe('workingStrip: "Working on it" under the header', () => {
  const t0 = '2026-10-27T10:00:00.000Z'
  const now = Date.parse(t0) + 2 * 60_000
  const task = (over: Partial<StripTask>): StripTask => ({ taskId: 't9', identifier: 'VO-9', who: 'Julia', state: 'working', startedAt: t0, ...over })
  it('is gone when nothing started here is open', () => {
    expect(workingStrip([], now)).toBeNull()
    expect(workingStrip([task({ state: 'done' }), task({ taskId: 't8', state: 'in_review' }), task({ taskId: 't7', state: 'failed' })], now)).toBeNull()
  })
  it('one task: who, what and how long, collapsed to one line', () => {
    expect(workingStrip([task({})], now)!.line).toBe('Julia is working on VO-9 · 2m')
    expect(workingStrip([task({ state: 'queued' })], now)!.line).toBe('VO-9 is queued for Julia · 2m')
    expect(workingStrip([task({ state: 'needs_you' })], now)!.line).toBe('VO-9 needs you · Julia is waiting · 2m')
    expect(workingStrip([task({ state: 'working', who: null })], now)!.line).toBe('Nobody yet is working on VO-9 · 2m')
  })
  it('more tasks: "2 tasks running", needs-you first, finished ones left out', () => {
    const s = workingStrip([task({}), task({ taskId: 't8', identifier: 'VO-8', who: 'Junia', state: 'needs_you', startedAt: '2026-10-27T10:01:00.000Z' }), task({ taskId: 't7', state: 'done' })], now)!
    expect(s.line).toBe('2 tasks running · 1 needs you')
    expect(s.tasks.map((t) => t.identifier)).toEqual(['VO-8', 'VO-9'])
    expect(s.focus.identifier).toBe('VO-8')
    expect(workingStrip([task({}), task({ taskId: 't8', identifier: 'VO-8' })], now)!.line).toBe('2 tasks running')
  })
  it('a queued task is not "running"; a working task counts from its run start, like its card', () => {
    expect(workingStrip([task({}), task({ taskId: 't8', identifier: 'VO-8', state: 'queued' })], now)!.line).toBe('2 tasks · 1 working · 1 queued')
    expect(workingStrip([task({ state: 'queued' }), task({ taskId: 't8', identifier: 'VO-8', state: 'queued' }), task({ taskId: 't7', state: 'needs_you' })], now)!.line).toBe('3 tasks · 2 queued · 1 needs you')
    expect(workingStrip([task({ since: '2026-10-27T10:01:00.000Z' })], now)!.line).toBe('Julia is working on VO-9 · 1m')
    // a queued task keeps the time since it was filed
    expect(workingStrip([task({ state: 'queued', since: '2026-10-27T10:01:00.000Z' })], now)!.line).toBe('VO-9 is queued for Julia · 2m')
  })
})

describe('chat-filed tasks (company_file_task, task_create)', () => {
  const summary = { id: 'task_1', identifier: 'PC-9', title: 'Lift UGC conversion', status: 'todo', agent: { id: 'agt_m', name: 'Copywriter' } }
  const item = (name: string, resultText: string, status = 'ok') => ({ kind: 'tool', id: `i_${name}`, parent: null, toolUseId: 'tu', name, input: {}, inputPartial: '', status, resultText, resultTruncated: false, startedAt: Date.parse('2026-10-27T10:00:00.000Z'), ms: 1 })
  it('reads the card from the tool result, bare or MCP-wrapped, from either tool', () => {
    for (const name of ['company_file_task', 'mcp__hive__company_file_task', 'mcp__hive__task_create']) {
      const c = chatTaskCard(item(name, JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: true, task: summary }) }])))
      expect(c).toMatchObject({ taskId: 'task_1', identifier: 'PC-9', title: 'Lift UGC conversion', agentId: 'agt_m', state: 'queued', startedAt: '2026-10-27T10:00:00.000Z' })
    }
    expect(chatTaskCard(item('task_create', `Result: ${JSON.stringify({ ok: true, task: { ...summary, status: 'in_progress' } })}`))!.state).toBe('working')
  })
  it('no card for another tool, a failed call, a repeat or a replay', () => {
    const ok = JSON.stringify({ ok: true, task: summary })
    expect(chatTaskCard(item('task_list', ok))).toBeNull()
    expect(chatTaskCard(item('task_create', ok, 'error'))).toBeNull()
    expect(chatTaskCard(item('task_create', JSON.stringify({ ok: true, task: summary, already: true })))).toBeNull()
    expect(chatTaskCard(item('task_create', JSON.stringify({ ok: true, task: summary, replayed: true })))).toBeNull()
    expect(chatTaskCard(item('task_create', 'not json'))).toBeNull()
    expect(chatTaskCards([item('task_create', ok), { kind: 'text' }, item('company_file_task', ok)])).toHaveLength(1)
  })
  it('stays a tool block of its own (never folded into a group of reads), so the chat draws the card', () => {
    const blocks = buildBlocks([item('mcp__hive__company_file_task', JSON.stringify({ ok: true, task: summary })) as never])
    expect(blocks.map((b) => b.t)).toEqual(['tool'])
  })
  it('the result line and the same-request test', () => {
    expect(taskResultLine({ identifier: 'PC-9', state: 'in_review', result: 'Rewrote the hero' })).toBe('PC-9 is ready for your review: Rewrote the hero')
    expect(taskResultLine({ identifier: 'PC-9', state: 'done', prUrl: 'https://x/pull/1' })).toBe('PC-9 is done.\nPull request: https://x/pull/1')
    expect(taskResultLine({ identifier: 'PC-9', state: 'failed' }, true)).toBe('PC-9 was canceled.')
    expect(sameRequest('Lift UGC conversion', 'lift ugc conversion!')).toBe(true)
    expect(sameRequest('Lift UGC conversion', 'Lift UGC conversion from PostHog')).toBe(true)
    expect(sameRequest('Fix', 'Fix the checkout')).toBe(false)
    expect(sameRequest('Write the newsletter', 'Lift UGC conversion')).toBe(false)
  })
})

describe("a task's question, said by its agent (CHAT-UI.md §8)", () => {
  it('waits for an answer only while the board ask is open and the task is not back', () => {
    expect(waitsForAnswer({ status: 'blocked', ask: { prompt: 'Which one?' } })).toBe(true)
    expect(waitsForAnswer({ status: 'in_progress', ask: { prompt: 'Which one?' } })).toBe(true)
    expect(waitsForAnswer({ status: 'blocked', ask: { prompt: 'Which one?', answer: 'Blue' } })).toBe(false)
    expect(waitsForAnswer({ status: 'in_review', ask: { prompt: 'Which one?' } })).toBe(false)
    expect(waitsForAnswer({ status: 'blocked', ask: null })).toBe(false)
  })
  it('keys one ask of one run', () => {
    const k = taskAskKey('t1', 'r1', 'Which one?')
    expect(k).toMatch(/^[0-9a-f]{8}$/)
    expect(taskAskKey('t1', 'r1', ' Which one? ')).toBe(k)
    expect(taskAskKey('t1', 'r2', 'Which one?')).not.toBe(k)
    expect(taskAskKey('t1', 'r1', 'Which other one?')).not.toBe(k)
  })
  it('says the whole question in the first person, with what it found, the options and where to answer', () => {
    expect(taskAskSay({ identifier: 'VO-15', prompt: "Needs access: Can't read production rows (social_post)", summary: 'The autopilot made them' })).toBe(
      "VO-15 is stuck and needs you.\nSo far: The autopilot made them\nI need access: Can't read production rows (social_post)\nReply here and I'll pass it on to VO-15."
    )
    const many = taskAskSay({ identifier: 'VO-15', prompt: 'Which workspace?\nNeeds a connection: PostHog is not connected. Set it up: principia://connect/posthog', options: ['Acme', 'Vibiz', 'Both'] })
    expect(many).toContain('- Which workspace?\n- I need a connection: PostHog is not connected. Set it up: principia://connect/posthog')
    expect(many).toContain('Options: Acme, Vibiz or Both.')
    // a summary the question already says is not said twice
    expect(taskAskSay({ identifier: 'X-1', prompt: 'Which one?', summary: 'Which one?' })).not.toContain('So far')
    expect(taskAskAck('VO-15')).toBe('Got it, back on VO-15.')
  })
  it('says "back on" only when the task resumed, else the true state', () => {
    expect(taskAskAck('VO-15', false, { state: 'started', line: 'VO-15 is starting.' })).toBe('Got it, back on VO-15.')
    expect(taskAskAck('VO-15', false, { state: 'running', line: 'VO-15 is already running.' })).toBe('Got it, back on VO-15.')
    expect(taskAskAck('VO-15', false, { state: 'queued', line: 'Julia is running 3 tasks; VO-15 starts when one finishes.' })).toBe('Got it. Julia is running 3 tasks; VO-15 starts when one finishes.')
    expect(taskAskAck('VO-15', true, { state: 'refused', line: 'Vibiz is paused; VO-15 starts when you resume it.' })).toBe('Got your answer. Vibiz is paused; VO-15 starts when you resume it.')
  })
  it('an option said back; never a status question or something new', () => {
    expect(matchesOption('both.', ['Acme', 'Both'])).toBe(true)
    expect(matchesOption('Use the PostHog events instead', ['Acme', 'Both'])).toBe(false)
    expect(matchesOption('Both', null)).toBe(false)
    expect(notAnAnswer('Use the PostHog events instead')).toBe(false)
    expect(notAnAnswer('main app bro and lets make it a new one')).toBe(false)
    expect(notAnAnswer('also, check the signup funnel')).toBe(true)
    expect(notAnAnswer('btw what about the ads?')).toBe(true)
    expect(notAnAnswer('  ')).toBe(true)
    for (const q of ['are u working on it? or what?', 'Are you working on it?', 'any update?', "what's the status?", 'status?', 'is it done?', "how's it going"]) expect(notAnAnswer(q), q).toBe(true)
  })
  it('a task in a conversation, as the agent asked about it sees it', () => {
    const now = Date.parse('2026-10-28T12:00:00Z')
    expect(taskStatusLine({ identifier: 'VO-16', title: 'New landing page', status: 'in_progress', who: 'Julia', since: '2026-10-28T11:48:00Z', latest: { at: '2026-10-28T11:58:00Z', text: 'Julia started run r_1' } }, now)).toBe(
      'VO-16 “New landing page”: working now (Julia), for 12m; latest: Julia started run r_1 (2m ago)'
    )
    expect(taskStatusLine({ identifier: 'VO-16', status: 'todo', waiting: 'Autopilot is off in Vibiz: it waits for you to press Start' }, now)).toBe('VO-16: not started yet: Autopilot is off in Vibiz: it waits for you to press Start')
    expect(taskStatusLine({ identifier: 'VO-16', status: 'blocked', blockReason: 'needs_input', ask: { prompt: 'Which app?' } }, now)).toBe("VO-16: waiting for the person's answer: “Which app?”")
    expect(taskStatusLine({ identifier: 'VO-16', status: 'in_review' }, now)).toBe('VO-16: finished, waiting for the person to review it')
  })
})

describe('saysGoAhead (PR-55)', () => {
  it('reads a plain yes, however it is typed', () => {
    for (const t of ['sounds good go ahead and use they keys we already have bro', 'do it, just hire it', 'ok', 'yes please', 'Approved', 'ship it', "let's do it"]) expect(saysGoAhead(t), t).toBe(true)
  })
  it('never reads a no, a wait or something else as one', () => {
    for (const t of ['no', 'not yet, wait for Monday', "don't hire anyone", 'hold on', 'what is the status?', 'use the PostHog events instead', '', 'I know']) expect(saysGoAhead(t), t).toBe(false)
  })
})

describe('a task waiting for the usage limit to reset', () => {
  const company = { name: 'Acme', autopilot: true, maxInFlight: 3 }
  const agent = { name: 'Julia', data: { autonomy: 'auto' } }
  const retryAt = new Date(2026, 9, 20, 15, 1).toISOString()
  const task = { status: 'todo', agentId: 'a1', limitWait: { resetAt: null, retryAt, restarted: false } }
  const now = new Date(2026, 9, 20, 14, 0).getTime()

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  it('says so and the time it restarts, and Run now can still start it', () => {
    vi.setSystemTime(now)
    expect(queuedReason({ task, agent, company })).toEqual({ text: 'Waiting for the usage limit to reset · restarts at 15:01', canRun: true })
  })
  it('a paused company says that first; past the restart time the usual reason shows', () => {
    vi.setSystemTime(now)
    expect(queuedReason({ task, agent, company: { ...company, pausedAt: 'x' } }).text).toContain('paused')
    vi.setSystemTime(new Date(2026, 9, 20, 15, 2))
    expect(queuedReason({ task, agent, company }).text).toBe('Starting in a moment')
  })
  it('reads as queued on the card', () => {
    expect(taskCardState(task)).toBe('queued')
  })
})
