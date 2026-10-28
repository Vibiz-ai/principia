import { describe, expect, it } from 'vitest'
import type { LiveItem } from './companyModel'
import { byWork, groupLive, isOrphanTask, orphanUnread, workingTarget, workLine, workOf, workRank, workersLine, type WorkTask } from './convWork'

const T = '2026-10-28T10:00:00.000Z'
const task = (id: string, x: Partial<WorkTask> = {}): WorkTask => ({ id, companyId: 'co', identifier: id.toUpperCase(), title: `Task ${id}`, status: 'in_progress', runId: `run_${id}`, agentId: 'julia', updatedAt: T, ...x })
const item = (key: string, x: Partial<LiveItem> = {}): LiveItem => ({ key, companyId: 'co', kind: 'working', agentId: `n_${key}`, askId: null, title: key, detail: null, sessionId: null, runId: null, at: T, ...x })

describe('CHAT-UI.md §8.6: a conversation carries the work it filed', () => {
  const tasks = [task('vo-31'), task('vo-32'), task('vo-33', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', prompt: 'Which logo?' } }), task('vo-34', { status: 'todo', runId: null }), task('vo-16', { status: 'in_review' }), task('vo-40')]
  const chans = { 'vo-31': 'ch_launch', 'vo-32': 'ch_launch', 'vo-33': 'ch_launch', 'vo-34': 'ch_launch', 'vo-16': 'ch_review', 'vo-40': 'ch_other' }

  it('sorts its tasks into working, needs you, queued, and the unread results', () => {
    const w = workOf('ch_launch', tasks, chans)
    expect(w.working.map((t) => t.id)).toEqual(['vo-31', 'vo-32'])
    expect(w.needs.map((t) => t.id)).toEqual(['vo-33'])
    expect(w.queued.map((t) => t.id)).toEqual(['vo-34'])
    expect(workOf('ch_review', tasks, chans, ['vo-16', 'gone']).unread.map((t) => t.id)).toEqual(['vo-16'])
    expect(workOf('ch_launch', tasks, null)).toEqual({ working: [], needs: [], queued: [], unread: [] })
  })
  it('says it on the row: needs you first, then tasks working, then what came back unread', () => {
    expect(workLine(workOf('ch_launch', tasks, chans))).toBe('1 needs you · 2 tasks working')
    expect(workLine(workOf('ch_other', tasks, chans))).toBe('1 task working')
    expect(workLine(workOf('ch_review', tasks, chans, ['vo-16']))).toBe('VO-16 finished · unread')
    expect(workLine(workOf('ch_review', tasks, chans, ['vo-16']), { code: false })).toBe('“Task vo-16” finished · unread')
    const failed = [task('vo-17', { status: 'blocked', blockReason: 'run_failed' }), task('vo-18', { status: 'done' })]
    const fc = { 'vo-17': 'ch_x', 'vo-18': 'ch_x' }
    expect(workLine(workOf('ch_x', failed, fc, ['vo-17']))).toBe('VO-17 stopped · unread')
    expect(workLine(workOf('ch_x', failed, fc, ['vo-17', 'vo-18']))).toBe('2 results to read')
    expect(workLine(workOf('ch_x', failed, fc))).toBeNull()
    expect(workLine({ working: [], needs: [], queued: [task('q', { status: 'todo' })], unread: [] })).toBe('1 task queued')
  })
  it('sorts the conversation with work first, so the eye goes there', () => {
    expect(workRank(workOf('ch_launch', tasks, chans))).toBe(3)
    expect(workRank(workOf('ch_other', tasks, chans))).toBe(2)
    expect(workRank(workOf('ch_review', tasks, chans, ['vo-16']))).toBe(1)
    expect(workRank(workOf('ch_none', tasks, chans), true)).toBe(2)
    expect(workRank(workOf('ch_none', tasks, chans))).toBe(0)
    const rows = [{ k: 'old-needs', rank: 3, at: '2026-10-01' }, { k: 'new', rank: 0, at: '2026-10-28' }, { k: 'working', rank: 2, at: '2026-10-20' }, { k: 'newer', rank: 0, at: '2026-10-29' }]
    expect(byWork(rows).map((r) => r.k)).toEqual(['old-needs', 'working', 'newer', 'new'])
  })
  it('a task nobody filed from a conversation is an orphan (autopilot, Run now, a routine)', () => {
    expect(isOrphanTask(task('vo-31'), chans)).toBe(false)
    expect(isOrphanTask(task('vo-99'), chans)).toBe(true)
    expect(isOrphanTask(task('vo-99'), undefined)).toBe(true)
  })
  it('"Julia" or "Julia and Marcus" or "Julia and 2 others"', () => {
    expect(workersLine(['Julia', 'Julia', ''])).toBe('Julia')
    expect(workersLine(['Julia', 'Marcus'])).toBe('Julia and Marcus')
    expect(workersLine(['Julia', 'Marcus', 'Cato'])).toBe('Julia and 2 others')
  })
})

describe('LIVE lists conversations with work, and orphan tasks on their own', () => {
  const tasks = [task('vo-31'), task('vo-32'), task('vo-50')]
  const chans = { 'vo-31': 'ch_launch', 'vo-32': 'ch_launch' }
  const items = [item('a', { runId: 'run_vo-31', taskId: 'vo-31' }), item('chat', { sessionId: 's1', chat: true }), item('b', { runId: 'run_vo-32' }), item('c', { runId: 'run_vo-50', taskId: 'vo-50' }), item('reply', { title: 'Marcus replying in “Spring launch”', runId: 'run_r' })]
  it('groups a conversation’s tasks (and an answer on its way) into one entry, in order of first appearance', () => {
    const g = groupLive(items, { tasks, taskChannels: chans, replyConv: (it) => (it.title.includes('replying in') ? 'ch_launch' : null) })
    expect(g.map((e) => e.key)).toEqual(['conv:ch_launch', 'chat', 'c'])
    const conv = g[0]!
    expect(conv.kind === 'conv' && conv.taskIds).toEqual(['vo-31', 'vo-32'])
    expect(conv.kind === 'conv' && conv.items.map((i) => i.key)).toEqual(['a', 'b', 'reply'])
    expect(conv.kind === 'conv' && conv.answering).toBe(true)
    // the orphan task keeps its row, and knows its task (its click opens the task chat)
    expect(g[2]).toMatchObject({ kind: 'item', taskId: 'vo-50' })
  })
  it('the status bar: one conversation opens it, one orphan task its chat, anything else Live only', () => {
    expect(workingTarget(items.slice(0, 1), { tasks, taskChannels: chans })).toEqual({ kind: 'conv', channelId: 'ch_launch' })
    expect(workingTarget([items[0]!, items[2]!], { tasks, taskChannels: chans })).toEqual({ kind: 'conv', channelId: 'ch_launch' })
    expect(workingTarget([items[3]!], { tasks, taskChannels: chans })).toEqual({ kind: 'task', taskId: 'vo-50' })
    expect(workingTarget([items[0]!, items[3]!], { tasks, taskChannels: chans })).toEqual({ kind: 'live' })
    expect(workingTarget([items[1]!], { tasks, taskChannels: chans })).toEqual({ kind: 'live' })
  })
})

describe('an orphan task’s news is unread until its chat is opened', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z')
  const since = '2026-10-20T00:00:00.000Z'
  const done = task('vo-60', { status: 'in_review', updatedAt: '2026-10-28T11:00:00.000Z' })
  it('a result after you last looked is unread; opening it reads it', () => {
    expect(orphanUnread(done, {}, since, now)).toBe(true)
    expect(orphanUnread(done, { 'vo-60': '2026-10-28T11:30:00.000Z' }, since, now)).toBe(false)
    expect(orphanUnread(task('q', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', prompt: '?' }, updatedAt: '2026-10-28T11:00:00.000Z' }), {}, since, now)).toBe(true)
  })
  it('working, never run, older than the feature or than a week: not unread', () => {
    expect(orphanUnread(task('w', { updatedAt: '2026-10-28T11:00:00.000Z' }), {}, since, now)).toBe(false)
    expect(orphanUnread({ ...done, runId: null }, {}, since, now)).toBe(false)
    expect(orphanUnread(done, {}, '2026-10-28T11:30:00.000Z', now)).toBe(false)
    expect(orphanUnread({ ...done, updatedAt: '2026-10-10T11:00:00.000Z' }, {}, '2026-10-01T00:00:00.000Z', now)).toBe(false)
  })
})
