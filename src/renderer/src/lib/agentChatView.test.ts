/** AGENT CHAT part 2: the view models behind the Grok-style conversation and the agent's right panel. */
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/chat'
import { buildBlocks } from '@shared/chatView'
import type { CompanyTask } from '@shared/company'
import type { Artifact, Schedule } from '@shared/types'
import { agentRoutines, computerView, countMessages, libraryOf, newPillLabel, routineLine, sessionUnread, stampLabel, stampsFor } from './agentChatView'

const T0 = new Date(2026, 9, 26, 9, 0).getTime()
const user = (id: string, at?: number): ChatItem => ({ id, kind: 'user', parent: null, text: id, images: 0, state: 'sent', ...(at !== undefined ? { at } : {}) }) as ChatItem
const text = (id: string, md = 'Done.', streaming = false, parent: string | null = null): ChatItem => ({ id, kind: 'text', parent, md, streaming }) as ChatItem
const tool = (id: string, name: string, input: Record<string, unknown>, status = 'ok', parent: string | null = null): ChatItem =>
  ({ id, kind: 'tool', parent, toolUseId: `tu_${id}`, name, input, inputPartial: '', status, resultText: '', resultTruncated: false, startedAt: T0, ms: 10 }) as ChatItem

describe('time stamps between groups', () => {
  it('stamps the first message, then only after a quiet stretch or on a new day', () => {
    const items = [user('a', T0), text('r1'), user('b', T0 + 5 * 60_000), text('r2'), user('c', T0 + 40 * 60_000), user('d', T0 + 24 * 3600_000), user('e')]
    const s = stampsFor(buildBlocks(items))
    expect([...s.keys()]).toEqual(['a', 'c', 'd'])
    expect(s.get('a')).toBe(T0)
  })
  it('says the time in plain words', () => {
    const now = T0 + 3600_000
    expect(stampLabel(T0, now)).toMatch(/^Today /)
    expect(stampLabel(T0 - 24 * 3600_000, now)).toMatch(/^Yesterday /)
    expect(stampLabel(T0 - 5 * 24 * 3600_000, now)).not.toMatch(/Today|Yesterday/)
  })
})

describe('the new-messages pill', () => {
  it('counts your messages and finished answers, not tool lines, streaming text or a helper’s own words', () => {
    const items = [user('a'), tool('t', 'Read', { file_path: '/w/a.md' }), text('r', 'Here it is'), text('s', 'Typing', true), text('h', 'helper note', false, 'tu_x'), text('e', '  ')]
    expect(countMessages(items)).toBe(2)
    expect(newPillLabel(0)).toBe('New activity')
    expect(newPillLabel(1)).toBe('1 new message')
    expect(newPillLabel(3)).toBe('3 new messages')
  })
})

describe('the Computer tab', () => {
  it('lists helper agents (running first, with their step count) and the latest tool lines in the chat’s words', () => {
    const items = [
      tool('h1', 'Task', { description: 'Look around the repo', subagent_type: 'Explore' }, 'ok'),
      tool('r1', 'Bash', { command: 'ls' }, 'ok', 'tu_h1'),
      tool('h2', 'Task', { description: 'Draft the post', subagent_type: 'general-purpose' }, 'running'),
      tool('e1', 'Edit', { file_path: '/w/a.md', old_string: 'a', new_string: 'b' }, 'ok'),
      tool('todo', 'TodoWrite', { todos: [] }, 'ok')
    ]
    const v = computerView(items)
    expect(v.helpers.map((h) => [h.id, h.running, h.steps])).toEqual([
      ['h2', true, 0],
      ['h1', false, 1]
    ])
    expect(v.recent.map((r) => r.id)).toEqual(['e1', 'r1'])
    expect(v.recent[1]!.inHelper).toBe(true)
    expect(v.recent[0]!.verb).toBeTruthy()
  })
})

describe('routines', () => {
  const sched = (id: string, p: Partial<Schedule>): Schedule => ({ id, name: id, target: { kind: 'prompt' } as never, when: { kind: 'cron', cron: '0 9 * * 1', tz: 'Europe/Madrid' }, preset: null, enabled: true, sentence: 'Every Monday at 9:00 (Europe/Madrid)', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: null, createdAt: '', updatedAt: '', companyId: 'co_a', ...p }) as Schedule
  it('keeps the schedules aimed at this agent in its company, on ones first', () => {
    const list = [sched('b', { target: { agentId: 'agt_1' } as never, enabled: false }), sched('a', { target: { agentId: 'agt_1' } as never }), sched('x', { target: { agentId: 'agt_2' } as never }), sched('y', { target: { agentId: 'agt_1' } as never, companyId: 'co_b' })]
    expect(agentRoutines(list, { id: 'agt_1', companyId: 'co_a' }).map((s) => s.id)).toEqual(['a', 'b'])
  })
  it('says when in plain words, without the time zone, and says off', () => {
    expect(routineLine({ sentence: 'Every Monday at 9:00 (Europe/Madrid)', enabled: true, nextFireAt: null })).toBe('Every Monday at 9:00')
    expect(routineLine({ sentence: 'Weekdays at 9:00', enabled: false, nextFireAt: null })).toBe('Weekdays at 9:00 · off')
  })
})

describe('the Library tab', () => {
  it('collects drafts first, then its files, notes and finished tasks from its runs and its chat, newest first', () => {
    const task = (id: string, p: Partial<CompanyTask>): CompanyTask => ({ id, title: id, agentId: 'agt_1', status: 'done', runId: null, updatedAt: '2026-10-20T10:00:00Z', ...p }) as CompanyTask
    const art = (id: string, p: Partial<Artifact>): Artifact => ({ id, name: `${id}.md`, kind: 'markdown', runId: null, sessionId: null, createdAt: '2026-10-21T10:00:00Z', mtime: '2026-10-21T10:00:00Z', ...p }) as Artifact
    const items = libraryOf({
      agentId: 'agt_1',
      tasks: [task('t_done', { runId: 'run_1' }), task('t_review', { status: 'in_review' }), task('t_other', { agentId: 'agt_2' })],
      artifacts: [art('f_run', { runId: 'run_1' }), art('f_chat', { sessionId: 'sess_1', mtime: '2026-10-22T10:00:00Z' }), art('f_other', { runId: 'run_9' })],
      notes: [{ id: 'n1', text: 'The client prefers Fridays', entityName: 'Client', createdAt: '2026-10-23T10:00:00Z', provenance: { runId: null, sessionId: 'sess_1' } }, { id: 'n2', text: 'x', entityName: 'y', createdAt: '2026-10-23T10:00:00Z', provenance: null }],
      sessionIds: ['sess_1']
    })
    expect(items.map((i) => i.key)).toEqual(['draft:t_review', 'note:n1', 'file:f_chat', 'file:f_run', 'task:t_done'])
  })
})

describe('the list dot', () => {
  it('is on when the chat finished a turn you have not looked at', () => {
    expect(sessionUnread({ status: 'needs_you', needs: 'idle' }, false)).toBe(true)
    expect(sessionUnread({ status: 'needs_you', needs: 'idle' }, true)).toBe(false)
    expect(sessionUnread({ status: 'needs_you', needs: 'permission' }, false)).toBe(false)
    expect(sessionUnread({ status: 'working', needs: null }, false)).toBe(false)
    expect(sessionUnread(undefined, false)).toBe(false)
  })
})
