import { describe, expect, it } from 'vitest'
import { chatTaskCard, chatTaskCards, elapsedLabel, isFinishedCard, isOpenCard, sameRequest, taskCardResult, taskCardState, taskResultLine, TASK_CARD_LABEL, workingStrip, type StripTask } from './taskCard'
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
