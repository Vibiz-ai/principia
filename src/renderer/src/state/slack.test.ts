/**
 * Lazy user resolution: main fills the user directory after the socket is 'connected' with no event for it, so ids
 * the renderer shows before that must resolve on their own (no reconnect, no restart).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackUser } from '@shared/slack'

let directory: SlackUser[] = []
const usersCall = vi.fn(async () => directory)
const listeners = new Map<string, (p: unknown) => void>()
const fakeHive = {
  slack: { users: usersCall },
  on: (e: string, cb: (p: unknown) => void) => {
    listeners.set(e, cb)
    return () => listeners.delete(e)
  }
}

type Mod = typeof import('./slack')
let m: Mod

const user = (id: string, name: string): SlackUser => ({ id, name, realName: name, displayName: name }) as unknown as SlackUser

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { hive: fakeHive }
  m = await import('./slack')
})
beforeEach(() => {
  vi.useFakeTimers()
  directory = []
  usersCall.mockClear()
  m.resetSlackUserResolution()
  m.setSlack({ users: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('lazy Slack user resolution', () => {
  it('re-reads the directory until a noted unknown id resolves', async () => {
    m.noteSlackUsers(['UDANA', 'UDANA', null, undefined])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(usersCall).toHaveBeenCalledTimes(1)
    expect(m.nameOfUser('UDANA')).toBe('UDANA')

    // main finishes users.list (slow / Retry-After) a bit later
    directory = [user('UDANA', 'Dana Lee')]
    await vi.advanceTimersByTimeAsync(2_000)
    expect(usersCall).toHaveBeenCalledTimes(2)
    expect(m.getSlack().users.UDANA).toBeDefined()

    // resolved: no further polling
    await vi.advanceTimersByTimeAsync(120_000)
    expect(usersCall).toHaveBeenCalledTimes(2)
  })

  it('does nothing for ids the directory already knows', async () => {
    m.setSlack({ users: { USAM: user('USAM', 'Sam') } })
    m.noteSlackUsers(['USAM'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(usersCall).not.toHaveBeenCalled()
  })

  it('gives up on ids that never resolve (bounded retries)', async () => {
    m.noteSlackUsers(['UGONE'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const n = usersCall.mock.calls.length
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThanOrEqual(8)
    m.noteSlackUsers(['UGONE'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(usersCall.mock.calls.length).toBe(n)
  })

  it('a slack:messages event notes its authors', async () => {
    m.wireSlackEvents()
    listeners.get('slack:messages')?.({ channelId: 'C1', messages: [{ userId: 'UNEW', fromHive: false }, { userId: 'UBOT', fromHive: true }] })
    directory = [user('UNEW', 'New Person')]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(usersCall).toHaveBeenCalledTimes(1)
    expect(m.getSlack().users.UNEW).toBeDefined()
  })
})
