import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGuardedExit, EXIT_AFTER_KILL_MS, EXIT_SESSIONS_GRACE_MS, HARD_EXIT_MS, type ExitSessions } from './exitGuard'

function setup(sessions: ExitSessions | null) {
  const order: string[] = []
  const realExit = vi.fn((code: number) => void order.push(`exit:${code}`))
  const hardKill = vi.fn((code: number) => void order.push(`kill:${code}`))
  const reap = vi.fn(() => void order.push('reap'))
  const exit = createGuardedExit({ sessions: () => sessions, reap, realExit, hardKill })
  return { exit, realExit, hardKill, reap, order }
}

const live = (o: Partial<ExitSessions> = {}): ExitSessions => ({
  runningCount: () => 1,
  shutdown: () => Promise.resolve(),
  killAllNow: () => 1,
  ...o
})

describe('guarded exit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('with nothing running: reaps, exits, and hard-kills if the process is still here', () => {
    const { exit, order } = setup(null)
    exit(0)
    expect(order).toEqual(['reap', 'exit:0'])
    vi.advanceTimersByTime(HARD_EXIT_MS)
    expect(order).toEqual(['reap', 'exit:0', 'kill:0'])
  })

  it('waits for sessions to shut down before exiting', async () => {
    let done!: () => void
    const order: string[] = []
    const s = live({ shutdown: () => new Promise<void>((r) => (done = () => (order.push('ptys'), r()))) })
    const t = setup(s)
    t.exit(0)
    expect(t.realExit).not.toHaveBeenCalled()
    done()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['ptys'])
    expect(t.order).toEqual(['reap', 'exit:0'])
  })

  it('sessions that never shut down are SIGKILLed, then the process exits', async () => {
    const killAllNow = vi.fn(() => 1)
    const t = setup(live({ shutdown: () => new Promise<void>(() => undefined), killAllNow }))
    t.exit(0)
    await vi.advanceTimersByTimeAsync(EXIT_SESSIONS_GRACE_MS)
    expect(killAllNow).toHaveBeenCalled()
    expect(t.realExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(EXIT_AFTER_KILL_MS)
    expect(t.order).toEqual(['reap', 'exit:0'])
  })

  it('a throwing killAllNow or shutdown still ends in an exit', async () => {
    const t = setup(
      live({
        shutdown: () => {
          throw new Error('sync boom')
        },
        killAllNow: () => {
          throw new Error('kill boom')
        }
      })
    )
    t.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.realExit).toHaveBeenCalledWith(0)
    const u = setup(
      live({
        shutdown: () => new Promise<void>(() => undefined),
        killAllNow: () => {
          throw new Error('kill boom')
        }
      })
    )
    u.exit(0)
    await vi.advanceTimersByTimeAsync(EXIT_SESSIONS_GRACE_MS + EXIT_AFTER_KILL_MS)
    expect(u.realExit).toHaveBeenCalledWith(0)
  })

  it('a hanging app.exit is followed by a hard kill (the SIGTERM forced-exit path)', async () => {
    const t = setup(live({ shutdown: () => new Promise<void>(() => undefined) }))
    t.exit(0)
    await vi.advanceTimersByTimeAsync(EXIT_SESSIONS_GRACE_MS + EXIT_AFTER_KILL_MS)
    expect(t.realExit).toHaveBeenCalledTimes(1)
    expect(t.hardKill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HARD_EXIT_MS)
    expect(t.hardKill).toHaveBeenCalledWith(0)
  })

  it('a throwing app.exit hard-kills right away', () => {
    const t = setup(null)
    t.realExit.mockImplementation(() => {
      throw new Error('exit boom')
    })
    t.exit(3)
    expect(t.hardKill).toHaveBeenCalledWith(3)
  })

  it('a second exit while the first waits on ptys exits now', async () => {
    const t = setup(live({ shutdown: () => new Promise<void>(() => undefined) }))
    t.exit(0)
    expect(t.realExit).not.toHaveBeenCalled()
    t.exit(1)
    expect(t.realExit).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(EXIT_SESSIONS_GRACE_MS + EXIT_AFTER_KILL_MS + HARD_EXIT_MS)
    expect(t.realExit).toHaveBeenCalledTimes(1)
    expect(t.hardKill).toHaveBeenCalledTimes(1)
  })
})
