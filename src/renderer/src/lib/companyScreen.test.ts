import { describe, expect, it } from 'vitest'
import { keptScreen, screenStillThere, screenToKeep } from './companyScreen'

describe('companyScreen', () => {
  it('keeps the screen and drops its one-shot asks', () => {
    expect(screenToKeep({ name: 'chats', filter: 'live', chat: 'agent:a1' })).toEqual({ name: 'chats', filter: 'live', chat: 'agent:a1' })
    expect(screenToKeep({ name: 'settings', section: 'connections' as never, connect: 'stripe' })).toEqual({ name: 'settings', section: 'connections' })
    expect(screenToKeep({ name: 'agentSeat', id: 'a1', focus: true })).toEqual({ name: 'agentSeat', id: 'a1' })
    expect(screenToKeep({ name: 'company', companyId: 'co', create: true })).toEqual({ name: 'company', companyId: 'co' })
  })

  it('reads back only something shaped like a screen', () => {
    expect(keptScreen({ name: 'home' })).toEqual({ name: 'home' })
    expect(keptScreen(null)).toBeNull()
    expect(keptScreen('home')).toBeNull()
    expect(keptScreen({ view: 'home' })).toBeNull()
  })

  it('an archived or removed agent or department is not there any more', () => {
    const have = { agents: [{ id: 'a1', archivedAt: null }, { id: 'a2', archivedAt: '2026-01-01' }], departments: [{ id: 'd1', archivedAt: null }] }
    expect(screenStillThere({ name: 'agentSeat', id: 'a1' }, have)).toBe(true)
    expect(screenStillThere({ name: 'agentSeat', id: 'a2' }, have)).toBe(false)
    expect(screenStillThere({ name: 'agentSeat', id: 'a3' }, have)).toBe(false)
    expect(screenStillThere({ name: 'department', id: 'd1' }, have)).toBe(true)
    expect(screenStillThere({ name: 'department', id: 'dx' }, have)).toBe(false)
    expect(screenStillThere({ name: 'forum', channelId: 'c' }, have)).toBe(true)
  })
})
