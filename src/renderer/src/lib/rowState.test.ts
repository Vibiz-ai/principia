import { describe, expect, it } from 'vitest'
import { chatRowState, showsDot, taskRowState, waitedFor, type RowTask } from './rowState'

const now = Date.parse('2026-11-05T12:00:00Z')
const ago = (h: number): string => new Date(now - h * 3_600_000).toISOString()
const t = (x: Partial<RowTask>): RowTask => ({ status: 'todo', runId: null, updatedAt: ago(0), blockReason: null, ask: null, ...x })
const ask = { kind: 'question', prompt: 'Which one?', options: [], answer: null, askedAt: ago(72) } as unknown as RowTask['ask']

describe('taskRowState', () => {
  it('a question leads with what it is and how long it waited', () => {
    const s = taskRowState(t({ status: 'blocked', blockReason: 'needs_input', ask, updatedAt: ago(72) }), { now })
    expect(s).toMatchObject({ kind: 'question', label: 'Question for you · 3d', mark: '?', tone: 'needs', needsYou: true, spin: false })
  })

  it('a live permission or question in the run says so', () => {
    expect(taskRowState(t({ status: 'in_progress', runId: 'r' }), { openAsk: true, now })).toMatchObject({ kind: 'question', label: 'Asking you now', needsYou: true })
  })

  it('working shows what it does, waits and stalls say so without a shimmer', () => {
    expect(taskRowState(t({ status: 'in_progress', runId: 'r' }), { line: { kind: 'working', label: 'Working', text: 'Run the tests', spin: true }, now })).toMatchObject({ kind: 'working', label: 'Run the tests', spin: true })
    expect(taskRowState(t({ status: 'in_progress', runId: 'r' }), { line: { kind: 'waiting', label: 'Waiting for a slot', text: 'Waiting for a free slot', spin: false }, now })).toMatchObject({ kind: 'waiting', label: 'Waiting for a free slot', spin: false })
    expect(taskRowState(t({ status: 'in_progress', runId: 'r' }), { line: { kind: 'stuck', label: 'Not responding', text: 'x', spin: false }, now })).toMatchObject({ kind: 'stuck', label: 'Not responding', tone: 'bad', spin: false })
    expect(taskRowState(t({ status: 'in_progress', runId: 's_chat' }), { line: { kind: 'in_chat', label: 'Working', text: 'x', spin: false }, now })).toMatchObject({ kind: 'working', label: 'Working in its chat' })
  })

  it('names why a task stopped', () => {
    expect(taskRowState(t({ status: 'blocked', blockReason: 'interrupted', runId: 'r' }), { now })).toMatchObject({ kind: 'failed', label: 'Stopped when the app quit', tone: 'bad', needsYou: false })
    expect(taskRowState(t({ status: 'blocked', blockReason: 'run_failed', runId: 'r' }), { now }).label).toBe('Stopped with an error')
  })

  it('review, done, queued and dependencies', () => {
    expect(taskRowState(t({ status: 'in_review', runId: 'r' }), { now })).toMatchObject({ kind: 'review', label: 'Ready for review', needsYou: false })
    expect(taskRowState(t({ status: 'done' }), { now })).toMatchObject({ kind: 'done', label: 'Done' })
    expect(taskRowState(t({ status: 'todo' }), { now })).toMatchObject({ kind: 'queued', label: 'Queued' })
    expect(taskRowState(t({ status: 'blocked', blockReason: 'deps' }), { now })).toMatchObject({ kind: 'queued', label: 'Waiting on another task' })
  })

  it('a parked task that is not a question still says it needs you, unless parked by hand', () => {
    expect(taskRowState(t({ status: 'blocked', blockReason: 'agent' }), { now })).toMatchObject({ kind: 'blocked', needsYou: true })
    expect(taskRowState(t({ status: 'blocked', blockReason: 'manual' }), { now })).toMatchObject({ kind: 'blocked', label: 'Parked', needsYou: false })
  })
})

describe('chatRowState', () => {
  it('waiting for you beats working', () => {
    expect(chatRowState({ running: true, working: true, needs: true })).toMatchObject({ kind: 'question', label: 'Waiting for you', needsYou: true })
  })
  it('working, then quiet, then not responding', () => {
    expect(chatRowState({ running: true, working: true, needs: false })).toMatchObject({ kind: 'working', spin: true })
    expect(chatRowState({ running: true, working: true, needs: false, line: { kind: 'slow', label: 'Taking longer', text: '', spin: false } })).toMatchObject({ kind: 'slow', spin: false })
    expect(chatRowState({ running: true, working: true, needs: false, line: { kind: 'stuck', label: 'Not responding', text: '', spin: false } })).toMatchObject({ kind: 'stuck' })
  })
  it('an ended chat says how it ended; an open idle chat keeps its own line', () => {
    expect(chatRowState({ running: false, working: false, needs: false, ended: 'Ended' })).toMatchObject({ kind: 'done', label: 'Ended' })
    expect(chatRowState({ running: true, working: false, needs: false })).toBeNull()
  })
})

describe('showsDot', () => {
  it('only for unread news on a row that is not working and not already asking for you', () => {
    expect(showsDot(taskRowState(t({ status: 'in_review', runId: 'r' }), { now }), true)).toBe(true)
    expect(showsDot(taskRowState(t({ status: 'in_review', runId: 'r' }), { now }), false)).toBe(false)
    expect(showsDot(taskRowState(t({ status: 'in_progress', runId: 'r' }), { now }), true)).toBe(false)
    expect(showsDot(taskRowState(t({ status: 'blocked', blockReason: 'needs_input', ask }), { now }), true)).toBe(false)
    expect(showsDot(null, true)).toBe(true)
  })
})

describe('waitedFor', () => {
  it('hours under two days, then days; nothing under an hour', () => {
    expect(waitedFor(ago(0.5), now)).toBeNull()
    expect(waitedFor(ago(5), now)).toBe('5h')
    expect(waitedFor(ago(80), now)).toBe('3d')
    expect(waitedFor('x', now)).toBeNull()
  })
})
