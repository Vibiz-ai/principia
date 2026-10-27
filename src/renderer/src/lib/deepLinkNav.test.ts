import { describe, expect, it } from 'vitest'
import { parseDeepLink, type DeepLink } from '@shared/deepLink'
import { deepLinkLabel, deepLinkView, resolveTaskRef, suggestedTime } from './deepLinkNav'
import { cardLink } from './connections'

const view = (url: string, taskId: string | null = null): unknown => deepLinkView(parseDeepLink(url) as DeepLink, { nonce: 7, taskId })

describe('principia:// links open a page, never an action', () => {
  it('maps every link to the view it names', () => {
    expect(view('principia://connect/instagram')).toEqual({ name: 'settings', section: 'connections', connect: 'instagram', nonce: 7 })
    expect(view('principia://connect/mcp')).toEqual({ name: 'settings', section: 'connections', connect: 'mcp', nonce: 7 })
    expect(view('principia://settings/keys')).toEqual({ name: 'settings', section: 'keys', nonce: 7 })
    expect(view('principia://settings/phone')).toEqual({ name: 'settings', section: 'phone', nonce: 7 })
    expect(deepLinkLabel('principia://settings/phone')).toBe('Open Settings › Phone')
    expect(view('principia://board?task=NC-1', 'task_1')).toEqual({ name: 'tasks', taskId: 'task_1' })
    expect(view('principia://board?task=NC-404')).toEqual({ name: 'tasks' })
    // a prefilled quick create: the founder still presses Create
    expect(view('principia://board?new=Reorder%20beans')).toEqual({ name: 'tasks', quick: { title: 'Reorder beans', nonce: 7 } })
    expect(view('principia://chats/agent/agt_1')).toEqual({ name: 'chats', chat: 'agent:agt_1' })
    expect(view('principia://agent/agt_1')).toEqual({ name: 'agentSeat', id: 'agt_1', nonce: 7 })
    expect(view('principia://automations/routines?add=morning-brief')).toEqual({ name: 'schedules', tab: 'routines', addRoutine: 'morning-brief', nonce: 7 })
    expect(view('principia://automations/routines?add=morning-brief&at=6:30&days=tue-sun')).toEqual({ name: 'schedules', tab: 'routines', addRoutine: 'morning-brief', routineTime: { at: '6:30', days: 'tue-sun' }, nonce: 7 })
    expect(deepLinkLabel('principia://automations/routines?add=morning-brief&at=6:30&days=tue-sun')).toBe('Change the Morning brief to Tue to Sun at 6:30')
    expect(suggestedTime('morning-brief', null, 'weekends')).toEqual({ time: '09:00', days: [0, 6] })
    expect(view('principia://knowledge?note=Prices')).toEqual({ name: 'passport', search: 'Prices', nonce: 7 })
    expect(view('principia://forum/join/abcd1234')).toEqual({ name: 'forum', nonce: 7 })
  })

  it('resolves NC-12 identifiers on the right company only', () => {
    const tasks = [
      { id: 'task_a', identifier: 'NC-12', companyId: 'co_a' },
      { id: 'task_b', identifier: 'NC-12', companyId: 'co_b' }
    ]
    expect(resolveTaskRef('nc-12', tasks, 'co_b')).toBe('task_b')
    expect(resolveTaskRef('task_a', tasks, 'co_a')).toBe('task_a')
    expect(resolveTaskRef('task_a', tasks, 'co_b')).toBeNull()
  })

  it('Copy link on a Connections card is the card’s own principia://connect link', () => {
    expect(cardLink({ id: 'stripe' })).toBe('principia://connect/stripe')
    expect(cardLink({ id: 'instagram' })).toBe('principia://connect/instagram')
    expect(cardLink({ id: 'stripe' }, 'co_abc')).toBe('principia://connect/stripe?company=co_abc')
    expect(cardLink({ id: 'shopify', state: 'soon' }, 'co_abc')).toBeNull()
    expect(cardLink({ id: 'custom' })).toBe('principia://connect/mcp')
    expect(cardLink({ id: 'conn:connection-1' })).toBeNull()
  })
})
