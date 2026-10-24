import { describe, expect, it } from 'vitest'
import { buildTaskPrompt } from './taskPrompt'
import { transitionError } from './taskState'
import { trackedBy } from '../../shared/company'
import { codexAdapter } from '../engine/adapters'
import type { AgentProfile } from '../../shared/types'

describe('PROACTIVE.md §5: a task turn knows what else runs', () => {
  const base = { task: { identifier: 'PRN-1', title: 'Post', description: '', source: 'manual' as const, sourceUrl: null }, companyId: 'co', department: null, agent: null, deps: [], activity: [], wake: [] }
  it('lists the other in-flight tasks, capped', () => {
    const running = Array.from({ length: 8 }, (_, i) => ({ identifier: `PRN-${i + 2}`, title: `Job ${i}`, agent: i ? 'Ada' : 'a chat', department: 'Marketing' }))
    const p = buildTaskPrompt({ ...base, running })
    expect(p).toContain('Running right now in this company (do not redo these):')
    expect(p).toContain('- PRN-2 Job 0 · a chat (Marketing)')
    expect(p).toContain('- and 2 more (team_board)')
    expect(buildTaskPrompt(base)).not.toContain('Running right now')
  })
})

describe('PROACTIVE.md §3: tracked tasks in the state machine', () => {
  it('the tracking chat (agent actor) moves todo → in_progress → in_review / blocked(agent), never to done', () => {
    expect(transitionError({ status: 'todo' }, { status: 'in_progress' }, 'agent', { tracked: true })).toBeNull()
    expect(transitionError({ status: 'in_progress' }, { status: 'in_review' }, 'agent', { tracked: true })).toBeNull()
    expect(transitionError({ status: 'in_progress' }, { status: 'blocked', blockReason: 'agent' }, 'agent', { tracked: true })).toBeNull()
    expect(transitionError({ status: 'in_review' }, { status: 'done' }, 'agent', { tracked: true, doneNote: 'x' })).toBe('Only a human can mark a task done')
    // without the tracked flag an agent still moves nothing
    expect(transitionError({ status: 'todo' }, { status: 'in_progress' }, 'agent', {})).not.toBeNull()
  })
  it('trackedBy reads the chat from the source key', () => {
    expect(trackedBy({ source: 'agent', externalId: 'track:session_1:toolu_9' })).toBe('session_1')
    expect(trackedBy({ source: 'agent', externalId: 'session_1:toolu_9' })).toBeNull()
    expect(trackedBy({ source: 'manual', externalId: 'track:session_1:x' })).toBeNull()
  })
})

describe('PROACTIVE.md §4: codex panes always get their instructions', () => {
  it('developer_instructions on a "resumed" pane too (codex never resumes a pane)', () => {
    const profile = { id: 'p', name: 'p', adapter: 'codex', model: null, extraArgs: [], permissionMode: 'default', secretNames: [], useApiKeyAuth: false } as unknown as AgentProfile
    const inv = codexAdapter.interactive({ profile, artifactsDir: '/a/', resumeId: 'r1', memoryBrief: 'RULES' })
    expect(inv.args.join(' ')).toContain('developer_instructions="RULES"')
  })
})
