import { describe, expect, it } from 'vitest'
import type { CompanyTask, TaskActivity, TaskDetail } from '@shared/company'
import { deskTasks, deskThread, lastLine } from './deskThread'

const CO = '2026-10-25T01:30:00.000Z'
const task = (x: Partial<CompanyTask>): CompanyTask =>
  ({ id: 't', identifier: 'NW-1', title: 'Draft brand voice guide', description: '', companyId: 'co', repoId: null, status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, agentId: 'a', departmentId: null, blockReason: null, ask: null, report: null, createdAt: CO, updatedAt: CO, ...x }) as CompanyTask
let n = 0
const act = (taskId: string, kind: TaskActivity['kind'], message: string, by: TaskActivity['by'], at: string): TaskActivity => ({ id: `a${++n}`, taskId, kind, message, by, createdAt: at })

describe('deskThread: the conversation from the agent’s tasks', () => {
  it('a setup task is a task card; your desk request is your bubble; the reply and report are the agent’s', () => {
    const setup: TaskDetail = { task: task({ id: 's', createdAt: '2026-10-25T01:30:30.000Z' }), activity: [act('s', 'created', 'Created from manual', 'human', '2026-10-25T01:30:30.000Z'), act('s', 'routed', 'Routed', 'human', '2026-10-25T01:30:30.001Z')] }
    const mine: TaskDetail = {
      task: task({ id: 'd', title: 'Write a post about our new decaf', description: 'write a post about our new decaf', externalId: 'desk:a:1', status: 'in_review', report: { outcome: 'review', summary: 'Here is the decaf post, in full.', evidence: [], at: '2026-10-26T10:05:00.000Z' }, createdAt: '2026-10-26T10:00:00.000Z' }),
      activity: [
        act('d', 'created', 'Created from manual', 'human', '2026-10-26T10:00:00.000Z'),
        act('d', 'comment', "On it. I'll write a post about your new decaf.", 'agent', '2026-10-26T10:00:01.000Z'),
        act('d', 'started', 'Marcus started run r1', 'human', '2026-10-26T10:00:02.000Z'),
        act('d', 'report', 'Ready for review: Here is the decaf…', 'agent', '2026-10-26T10:05:00.000Z')
      ]
    }
    const items = deskThread([mine, setup], { companyCreatedAt: CO, agentName: 'Marcus' })
    expect(items.map((i) => i.kind)).toEqual(['task', 'me', 'agent', 'note', 'agent'])
    expect(items[0]).toMatchObject({ kind: 'task', origin: 'setup' })
    expect(items[1]).toMatchObject({ kind: 'me', text: 'write a post about our new decaf' })
    expect(items[4]).toMatchObject({ kind: 'agent', text: 'Here is the decaf post, in full.', card: 'review' })
    expect(lastLine(items, () => '')).toBe('Here is the decaf post, in full.')
  })
  it('a request you made here and the agent handed to a teammate stays in this conversation, with where it went', () => {
    const handed = task({ id: 'h', title: 'Set up a morning brief', externalId: 'desk:a:9', agentId: 'b', status: 'in_progress' })
    expect(deskTasks([handed, task({ id: 'x', agentId: 'b' })], 'a', 'co').map((t) => t.id)).toEqual(['h'])
    const d: TaskDetail = { task: handed, activity: [act('h', 'created', 'c', 'human', '2026-10-26T10:00:00.000Z'), act('h', 'handoff', 'Handed off to Seneca · Operations: recurring reports are Ops', 'agent', '2026-10-26T10:03:00.000Z')] }
    const items = deskThread([d], { agentName: 'Marcus' })
    expect(items.at(-1)).toMatchObject({ kind: 'note', text: 'Handed off to Seneca · Operations: recurring reports are Ops' })
  })
  it('a task back in review without a written report still gets its draft card, before later comments', () => {
    const d: TaskDetail = {
      task: task({ id: 'd', externalId: 'desk:a:1', description: 'x', status: 'in_review', createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T11:00:00.000Z' }),
      activity: [act('d', 'created', 'c', 'human', '2026-10-26T10:00:00.000Z'), act('d', 'run_finished', 'done', 'system', '2026-10-26T10:10:00.000Z'), act('d', 'comment', 'also this', 'human', '2026-10-26T11:00:00.000Z')]
    }
    const items = deskThread([d], { agentName: 'Marcus' })
    expect(items.map((i) => [i.kind, i.kind === 'agent' ? i.card : null])).toEqual([['me', null], ['agent', 'review'], ['me', null]])
  })
  it('an open question carries its answer box; answered ones read as your bubble', () => {
    const d: TaskDetail = {
      task: task({ id: 'q', status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', prompt: 'Refund $24 or send a new box?' } }),
      activity: [act('q', 'created', 'c', 'human', '2026-10-26T10:00:00.000Z'), act('q', 'asked', 'Agent asked: Refund $24 or…', 'agent', '2026-10-26T10:01:00.000Z')]
    }
    expect(deskThread([d], { agentName: 'Cato' }).at(-1)).toMatchObject({ kind: 'agent', text: 'Refund $24 or send a new box?', card: 'ask' })
  })
  it('deskTasks: only this agent’s tasks in this company, newest first', () => {
    const list = [task({ id: '1', updatedAt: '2026-10-01' }), task({ id: '2', updatedAt: '2026-10-03' }), task({ id: '3', agentId: 'b' }), task({ id: '4', companyId: 'other' })]
    expect(deskTasks(list, 'a', 'co').map((t) => t.id)).toEqual(['2', '1'])
  })
})
