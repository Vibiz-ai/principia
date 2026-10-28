import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const { hireCardModel } = await import('./HireCard')

const base = {
  text: 'No one on the team handles social media scheduling yet. Create “Social scheduler” in Marketing?',
  via: 'principia' as const,
  proposal: {
    kind: 'agent' as const,
    status: 'open' as const,
    reason: 'Nobody schedules posts',
    agent: { departmentKey: 'marketing', role: 'Social scheduler', instructions: 'You own the posting calendar.', capabilities: 'Schedules posts', adapter: 'claude' as const },
    forMessageId: 'fmsg_1',
    insteadAgentId: 'agt_marcus',
    need: 'social media scheduling'
  }
}
const ctx = {
  author: null,
  departmentName: (k: string) => (k === 'marketing' ? 'Marketing' : null),
  profileName: 'Claude (default)',
  agentName: (id: string) => (id === 'agt_marcus' ? 'Marcus, Content writer' : id === 'agt_new' ? 'Livia' : null),
  decidedBy: null
}

describe('the new-specialist card (CHAT-UI.md §7.2)', () => {
  it('says what Principia proposes: role, department, AI tool, instructions, and who to use instead', () => {
    const m = hireCardModel(base, ctx)!
    expect(m.kicker).toBe('Principia · new specialist')
    expect(m.question).toMatch(/Create “Social scheduler” in Marketing\?$/)
    expect(m.rows).toEqual([
      ['Role', 'Social scheduler'],
      ['Department', 'Marketing'],
      ['AI tool', 'Claude (default)'],
      ['Instructions', 'You own the posting calendar.']
    ])
    expect(m.instead).toBe('Marcus, Content writer')
    expect(m.outcome).toBeNull()
  })
  it('an agent’s proposal names the agent; decided cards say what happened', () => {
    expect(hireCardModel({ ...base, via: undefined }, { ...ctx, author: 'Marcus' })!.kicker).toBe('Marcus suggests a new specialist')
    expect(hireCardModel({ ...base, proposal: { ...base.proposal, status: 'approved', result: { agentId: 'agt_new' } } }, { ...ctx, decidedBy: 'You' })!.outcome).toBe('You created Social scheduler (Livia); they joined to answer.')
    expect(hireCardModel({ ...base, proposal: { ...base.proposal, status: 'rejected', usedAgentId: 'agt_marcus' } }, { ...ctx, decidedBy: 'You' })!.outcome).toBe('You brought in Marcus, Content writer instead.')
    expect(hireCardModel({ ...base, proposal: { ...base.proposal, kind: 'department' as never } }, ctx)).toBeNull()
  })
})
