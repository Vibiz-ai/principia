import { describe, expect, it } from 'vitest'
import { assertEditable, assertReassignable, assertTransition, runEndState, transitionError, type TaskState } from './taskState'

const S = (status: TaskState['status'], blockReason: TaskState['blockReason'] = null): TaskState => ({ status, blockReason })
const ok = (from: TaskState, to: TaskState, actor: 'human' | 'agent' | 'system', ctx = {}) => expect(transitionError(from, to, actor, ctx)).toBeNull()
const no = (from: TaskState, to: TaskState, actor: 'human' | 'agent' | 'system', ctx = {}, msg?: string | RegExp) => expect(() => assertTransition(from, to, actor, ctx)).toThrow(msg ?? /./)

describe('DEPARTMENTS.md §1.4 state machine, row by row', () => {
  it('triage → todo / backlog: human or a routing rule, once a department (or agent) is set', () => {
    ok(S('triage'), S('todo'), 'human', { routed: true }); ok(S('triage'), S('backlog'), 'system', { routed: true })
    no(S('triage'), S('todo'), 'human', { routed: false }, 'Choose a department'); no(S('triage'), S('todo'), 'agent', { routed: true })
  })
  it('todo (deps unmet) → blocked(deps): the system on save, never when the deps are done', () => {
    ok(S('todo'), S('blocked', 'deps'), 'system', { depsDone: false })
    no(S('todo'), S('blocked', 'deps'), 'system', { depsDone: true }, 'nothing blocks'); no(S('todo'), S('blocked', 'deps'), 'human', { depsDone: false })
  })
  it('blocked(deps) → todo: only the heal, only once every dependency is done', () => {
    ok(S('blocked', 'deps'), S('todo'), 'system', { depsDone: true })
    no(S('blocked', 'deps'), S('todo'), 'system', { depsDone: false }, 'not done'); no(S('blocked', 'deps'), S('todo'), 'human', { depsDone: true })
  })
  it('blocked(deps) → blocked(manual): only the system, only when a dependency was canceled', () => {
    ok(S('blocked', 'deps'), S('blocked', 'manual'), 'system', { depCanceled: true })
    no(S('blocked', 'deps'), S('blocked', 'manual'), 'system', {}, 'canceled dependency'); no(S('blocked', 'deps'), S('blocked', 'manual'), 'human', { depCanceled: true })
  })
  it('todo → in_progress: dispatcher claim or a human Run now, only as a start, never with unmet deps', () => {
    ok(S('todo'), S('in_progress'), 'system', { start: true, depsDone: true }); ok(S('todo'), S('in_progress'), 'human', { start: true })
    no(S('todo'), S('in_progress'), 'human', {}, 'Run now'); no(S('todo'), S('in_progress'), 'system', { start: true, depsDone: false }, 'dependencies')
    no(S('todo'), S('in_progress'), 'agent', { start: true })
    // carried over: an explicit human retry of a parked or reviewed task; the dispatcher never restarts those
    ok(S('blocked', 'interrupted'), S('in_progress'), 'human', { start: true }); no(S('blocked', 'interrupted'), S('in_progress'), 'system', { start: true })
    no(S('blocked', 'deps'), S('in_progress'), 'human', { start: true })
  })
  it('in_progress → in_review at run end (system only)', () => {
    ok(S('in_progress'), S('in_review'), 'system'); no(S('in_progress'), S('in_review'), 'human'); no(S('in_progress'), S('in_review'), 'agent')
  })
  it('in_progress → blocked(needs_input) and blocked(agent) at run end', () => {
    ok(S('in_progress'), S('blocked', 'needs_input'), 'system'); ok(S('in_progress'), S('blocked', 'agent'), 'system')
    no(S('in_progress'), S('blocked', 'agent'), 'agent')
  })
  it('in_progress → blocked(run_failed / no_report / interrupted / limit) at run end, reconcile or caps', () => {
    for (const r of ['run_failed', 'no_report', 'interrupted', 'limit', 'handoff_cap', 'deps'] as const) ok(S('in_progress'), S('blocked', r), 'system')
    no(S('in_progress'), S('blocked', 'manual'), 'system'); no(S('in_progress'), S('blocked'), 'system', {}, 'needs a reason')
  })
  it('blocked(needs_input) → todo: the human answers', () => {
    ok(S('blocked', 'needs_input'), S('todo'), 'human', { answer: 'Use the blue logo' })
    no(S('blocked', 'needs_input'), S('todo'), 'human', { answer: '  ' }, 'Write an answer'); no(S('blocked', 'needs_input'), S('todo'), 'agent', { answer: 'x' })
  })
  it('blocked(other than deps) → todo: human Unpark', () => {
    for (const r of ['run_failed', 'no_report', 'interrupted', 'limit', 'agent', 'handoff_cap', 'manual', null] as const) ok(S('blocked', r), S('todo'), 'human')
    no(S('blocked', 'run_failed'), S('todo'), 'system'); no(S('blocked', 'run_failed'), S('todo'), 'agent')
  })
  it('in_review → done: human only, with a done note', () => {
    ok(S('in_review'), S('done'), 'human', { doneNote: 'Shipped in v2' })
    no(S('in_review'), S('done'), 'human', {}, 'done note'); no(S('in_review'), S('done'), 'human', { doneNote: '   ' }, 'done note')
    no(S('in_review'), S('done'), 'agent', { doneNote: 'x' }, 'Only a human'); no(S('in_review'), S('done'), 'system', { doneNote: 'x' }, 'Only a human')
    // agents can never set done, from anywhere
    for (const from of ['todo', 'in_progress', 'blocked', 'triage'] as const) no(S(from, from === 'blocked' ? 'agent' : null), S('done'), 'agent', { doneNote: 'x' }, 'Only a human')
  })
  it('in_review → todo: human Send back with a note', () => {
    ok(S('in_review'), S('todo'), 'human', { note: 'Shorter headline' })
    no(S('in_review'), S('todo'), 'human', { note: '' }, 'Say what to change'); no(S('in_review'), S('todo'), 'system')
  })
  it('any not in flight → canceled: human', () => {
    for (const from of [S('triage'), S('backlog'), S('todo'), S('in_review'), S('blocked', 'deps'), S('blocked', 'needs_input'), S('done')]) ok(from, S('canceled'), 'human')
    no(S('in_progress'), S('canceled'), 'human', {}, 'cannot move'); no(S('todo'), S('canceled'), 'agent')
  })
  it('illegal moves throw', () => {
    no(S('todo'), S('in_review'), 'human', {}, 'cannot move from To do to In review')
    ok(S('backlog'), S('done'), 'human', { doneNote: 'x' }); no(S('backlog'), S('done'), 'human'); no(S('in_progress'), S('done'), 'human', { doneNote: 'x' }); no(S('triage'), S('in_review'), 'system')
    no(S('done'), S('in_progress'), 'human', { start: true }); no(S('canceled'), S('in_review'), 'human')
    no(S('blocked', 'deps'), S('blocked', 'manual'), 'human'); no(S('todo'), S('blocked', 'needs_input'), 'human')
    no(S('in_review'), S('blocked', 'agent'), 'system')
  })
  it('carried over: planning moves, reopening and parking by hand are human only', () => {
    ok(S('todo'), S('backlog'), 'human'); ok(S('backlog'), S('todo'), 'human'); ok(S('done'), S('todo'), 'human'); ok(S('canceled'), S('backlog'), 'human')
    ok(S('todo'), S('blocked', 'manual'), 'human'); no(S('todo'), S('backlog'), 'agent'); no(S('done'), S('todo'), 'system')
    // staying put is not a move
    ok(S('in_progress'), S('in_progress'), 'agent')
  })
  it('carried over: no edits in flight, the company never changes, reassigning needs the task not in flight', () => {
    expect(() => assertEditable({ companyId: 'co_a', status: 'in_progress' }, { companyId: 'co_a' })).toThrow('running')
    expect(() => assertEditable({ companyId: 'co_a', status: 'todo' }, { companyId: 'co_b' })).toThrow('Company cannot change')
    expect(() => assertEditable({ companyId: 'co_a', status: 'todo' }, { companyId: 'co_a' })).not.toThrow()
    expect(() => assertReassignable({ companyId: 'co_a', status: 'in_progress', agentId: 'agt_1' }, { agentId: 'agt_2' })).toThrow('Stop it')
    expect(() => assertReassignable({ companyId: 'co_a', status: 'in_progress', departmentId: 'dep_1' }, { departmentId: 'dep_1' })).not.toThrow()
    expect(() => assertReassignable({ companyId: 'co_a', status: 'blocked', agentId: 'agt_1' }, { agentId: null })).not.toThrow()
  })
})

describe('run end outcome (§1.4, §4.5)', () => {
  const passed = { status: 'passed' as const }, failed = { status: 'failed' as const, reason: 'exit 1' }, canceled = { status: 'canceled' as const }
  const report = (outcome: 'review' | 'blocked') => ({ report: { outcome, summary: 'Did it' } })
  it('maps ask, reports, no report, failure and cancel', () => {
    expect(runEndState({ ask: { prompt: 'Which logo?' } }, passed, true)).toMatchObject({ to: { status: 'blocked', blockReason: 'needs_input' }, kind: 'asked', by: 'agent' })
    expect(runEndState(report('blocked'), passed, true)).toMatchObject({ to: { status: 'blocked', blockReason: 'agent' }, kind: 'report' })
    expect(runEndState(report('review'), passed, true)).toMatchObject({ to: { status: 'in_review' }, kind: 'report' })
    expect(runEndState(report('review'), canceled, true).to.status).toBe('in_review')
    expect(runEndState({}, passed, true)).toMatchObject({ to: { status: 'in_review' }, noReport: true })
    expect(runEndState({}, passed, true).message).toContain('no report')
    expect(runEndState({}, failed, true)).toMatchObject({ to: { status: 'blocked', blockReason: 'run_failed' } })
    expect(runEndState({}, canceled, true)).toMatchObject({ to: { status: 'blocked', blockReason: 'no_report' } })
    expect(runEndState({}, canceled, true, 'limit')).toMatchObject({ to: { status: 'blocked', blockReason: 'limit' } })
    // an answered ask from an earlier turn is not a new ask; a dependency created during the run blocks on deps
    expect(runEndState({ ask: { prompt: 'x', answer: 'y' } }, passed, true).to.status).toBe('in_review')
    expect(runEndState(report('review'), passed, false)).toMatchObject({ to: { status: 'blocked', blockReason: 'deps' } })
    expect(runEndState({}, failed, false).to.blockReason).toBe('run_failed')
  })
  it('every outcome is a legal §1.4 move from in_progress', () => {
    for (const end of [runEndState({ ask: { prompt: 'q' } }, passed, true), runEndState(report('blocked'), passed, true), runEndState({}, passed, true), runEndState({}, failed, true),
      runEndState({}, canceled, true), runEndState({}, canceled, true, 'limit'), runEndState(report('review'), passed, false)]) ok(S('in_progress'), end.to, 'system')
  })
})

describe('WORKTREE.md: the task follows its PR', () => {
  it('a ready PR moves a parked or queued task to review, by the system only', () => {
    for (const from of [S('todo'), S('backlog'), S('blocked', 'no_report'), S('blocked', 'run_failed')]) ok(from, S('in_review'), 'system', { work: 'pr_ready' })
    no(S('todo'), S('in_review'), 'human', { work: 'pr_ready' })
    // without the PR the old refusal stands
    no(S('todo'), S('in_review'), 'human', {}, 'cannot move from To do to In review')
  })
  it('changes requested restart a task in review (a start), merged completes it with a note', () => {
    ok(S('in_review'), S('in_progress'), 'system', { work: 'changes_requested', start: true, depsDone: true })
    no(S('in_review'), S('in_progress'), 'system', { start: true }); no(S('in_review'), S('in_progress'), 'system', { work: 'changes_requested' })
    ok(S('in_review'), S('done'), 'system', { work: 'merged', doneNote: 'Merged #42' }); ok(S('blocked', 'agent'), S('done'), 'system', { work: 'merged', doneNote: 'Merged #42' })
    no(S('in_review'), S('done'), 'system', { work: 'merged', doneNote: ' ' }); no(S('in_progress'), S('done'), 'system', { work: 'merged', doneNote: 'x' })
    ok(S('in_review'), S('done'), 'system', { work: 'approved', doneNote: 'Approved #42' }); no(S('blocked', 'agent'), S('done'), 'system', { work: 'approved', doneNote: 'Approved #42' })
    no(S('in_review'), S('done'), 'agent', { work: 'approved', doneNote: 'x' }, 'Only a human')
    no(S('in_review'), S('done'), 'system', { doneNote: 'x' }, 'Only a human can mark a task done'); no(S('in_review'), S('done'), 'agent', { work: 'merged', doneNote: 'x' }, 'Only a human')
  })
  it('Back to Backlog after the worktree went away: human, any open task not in flight', () => {
    for (const from of [S('in_review'), S('blocked', 'interrupted'), S('todo')]) ok(from, S('backlog'), 'human', { worktreeGone: true })
    no(S('in_review'), S('backlog'), 'human'); no(S('in_review'), S('backlog'), 'system', { worktreeGone: true })
  })
})
