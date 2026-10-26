import { describe, expect, it } from 'vitest'
import { connectAsks, dismissNudge, pickNudge, type NudgeInput } from './nudges'

const NOW = new Date('2026-10-28T12:00:00') // a Wednesday
const task = (p: Partial<NudgeInput['tasks'][number]> = {}): NudgeInput['tasks'][number] => ({ id: 't', status: 'todo', updatedAt: '2026-10-28T10:00:00', description: '', ...p })
const input = (p: Partial<NudgeInput> = {}): NudgeInput => ({
  now: NOW,
  companyId: 'co_a',
  companyCreatedAt: '2026-10-25T09:00:00',
  dismissed: {},
  tasks: [],
  schedulesOn: 0,
  routinesOn: new Set(),
  morningBriefReady: true,
  connected: new Set(),
  agentName: (id) => (id === 'agt_m' ? 'Marcus' : null),
  toolName: (t) => (t === 'instagram' ? 'Instagram' : t),
  trackTasks: 'auto',
  chatCount: 0,
  ...p
})

describe('Home suggestions', () => {
  it('an agent that needed a tool comes first, with its connect link and its name', () => {
    const tasks = [task({ agentId: 'agt_m', report: { summary: 'Drafted 3 posts. To post them, connect Instagram: principia://connect/instagram?company=co_a.' } })]
    const n = pickNudge(input({ tasks }))
    expect(n).toMatchObject({ id: 'connect:instagram', title: 'Marcus needed Instagram', agentId: 'agt_m', action: { kind: 'link', href: 'principia://connect/instagram?company=co_a', label: 'Connect Instagram' } })
    expect(n!.body).toContain('nobody asks for your password')
  })
  it('no connection nudge once it is connected, for another company’s link, or for an old ask', () => {
    const t = (summary: string, updatedAt = '2026-10-28T10:00:00') => [task({ agentId: 'agt_m', updatedAt, report: { summary } })]
    expect(pickNudge(input({ tasks: t('principia://connect/instagram'), connected: new Set(['instagram']) }))?.id).not.toBe('connect:instagram')
    expect(pickNudge(input({ tasks: t('principia://connect/instagram?company=co_b') }))?.id).not.toBe('connect:instagram')
    expect(pickNudge(input({ tasks: t('principia://connect/instagram', '2026-09-01T10:00:00') }))?.id).not.toBe('connect:instagram')
    expect(connectAsks(t('principia://connect/mcp'), 'co_a', 0)).toEqual([])
  })
  it('after day one with nothing scheduled: the morning brief, with Turn on (never on by itself)', () => {
    const n = pickNudge(input())
    expect(n).toMatchObject({ id: 'morning-brief', title: 'Get a morning brief every weekday?', action: { kind: 'routine', routine: 'morning-brief', label: 'Turn on' } })
    expect(pickNudge(input({ companyCreatedAt: '2026-10-28T08:00:00' }))).toBeNull() // still day one
    expect(pickNudge(input({ schedulesOn: 1 }))).toBeNull()
    expect(pickNudge(input({ schedulesOn: null }))).toBeNull() // not loaded yet
    expect(pickNudge(input({ morningBriefReady: false }))).toBeNull()
  })
  it('three tasks done this week: see what the team did, and the weekly review when it is off', () => {
    const done = [1, 2, 3].map((i) => task({ id: `t${i}`, status: 'done', updatedAt: '2026-10-27T10:00:00' }))
    const n = pickNudge(input({ schedulesOn: 2, tasks: done }))
    expect(n).toMatchObject({ id: 'week-done', title: 'Your team finished 3 tasks this week', action: { kind: 'activity' }, secondary: { kind: 'routine', routine: 'weekly-review' } })
    expect(pickNudge(input({ schedulesOn: 2, tasks: done, routinesOn: new Set(['weekly-review']) }))!.secondary).toBeUndefined()
    // last week's tasks don't count
    expect(pickNudge(input({ schedulesOn: 2, tasks: done.map((t) => ({ ...t, updatedAt: '2026-10-20T10:00:00' })) }))).toBeNull()
  })
  it('track tasks off, chats and no tasks: offer to turn it back on', () => {
    expect(pickNudge(input({ schedulesOn: 1, trackTasks: 'off', chatCount: 2 }))).toMatchObject({ id: 'track-tasks', action: { kind: 'trackTasks' } })
    expect(pickNudge(input({ schedulesOn: 1, trackTasks: 'auto', chatCount: 2 }))).toBeNull()
  })
  it('at most one at a time, and a dismissed one never comes back (the next one may)', () => {
    const tasks = [task({ agentId: 'agt_m', report: { summary: 'principia://connect/instagram' } })]
    expect(pickNudge(input({ tasks }))!.id).toBe('connect:instagram')
    const dismissed = dismissNudge(undefined, 'co_a', 'connect:instagram', NOW)
    expect(dismissed).toEqual({ co_a: { 'connect:instagram': NOW.toISOString() } })
    expect(pickNudge(input({ tasks, dismissed: dismissed.co_a }))!.id).toBe('morning-brief')
    expect(pickNudge(input({ tasks, dismissed: { 'connect:instagram': 'x', 'morning-brief': 'x' } }))).toBeNull()
  })
})
