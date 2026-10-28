import { describe, expect, it } from 'vitest'
import { dedupeSessions, sessionThreadKey } from './sessionRows'

const s = (id: string, x: Partial<{ status: 'running' | 'exited'; startedAt: string; agentSessionId: string | null; taskId: string | null }> = {}) => ({ id, status: 'exited' as 'running' | 'exited', startedAt: '2026-10-28T10:00:00Z', agentSessionId: null as string | null, ...x })

describe('Chats › Claude: one row per chat, not per process', () => {
  it('a restart (same agent conversation) is not listed twice: the newest stays', () => {
    const rows = dedupeSessions([s('a', { agentSessionId: 'conv-1' }), s('b', { agentSessionId: 'conv-1', startedAt: '2026-10-28T11:00:00Z' }), s('c')])
    expect(rows.map((r) => r.id)).toEqual(['b', 'c'])
  })
  it('the running one wins over a newer exited one; a board task’s sessions are one row', () => {
    expect(dedupeSessions([s('a', { agentSessionId: 'x', status: 'running' }), s('b', { agentSessionId: 'x', startedAt: '2026-10-29T00:00:00Z' })]).map((r) => r.id)).toEqual(['a'])
    expect(dedupeSessions([s('a', { taskId: 'vo-15', agentSessionId: 'x' }), s('b', { taskId: 'vo-15', agentSessionId: 'y', startedAt: '2026-10-29T00:00:00Z' })]).map((r) => r.id)).toEqual(['b'])
  })
  it('keys: the task, else the agent-side conversation, else the session itself', () => {
    expect(sessionThreadKey(s('a', { taskId: 't', agentSessionId: 'c' }))).toBe('task:t')
    expect(sessionThreadKey(s('a', { agentSessionId: 'c' }))).toBe('agent:c')
    expect(sessionThreadKey(s('a'))).toBe('id:a')
  })
})
