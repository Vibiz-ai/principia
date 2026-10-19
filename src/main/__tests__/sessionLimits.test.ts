/**
 * CONTRACT §13 on interactive sessions: usage-limit classification from claude's StopFailure hook and from the PTY
 * screen (strict, never while working, never a redraw of a cleared banner), clearing on the user's next keystroke or
 * turn, the resume ("continue"), and Stalled? timing for working roots only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentNode } from '../../shared/live'
import { openDatabase, type DB } from '../db'
import { LiveStore } from '../db/liveStore'
import { SessionLive, type SessionLiveDeps } from '../live/sessionLive'
import { StallMonitor } from '../engine'
import type { LimitHit } from '../engine'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d = nativeOk ? describe : describe.skip

const FIX = path.join(__dirname, '../engine/__tests__/fixtures/limits')
const wrap = (payload: unknown) => ({ v: 1, provider: 'claude', received_at: new Date().toISOString(), payload })
const hook = (name: string, extra: Record<string, unknown> = {}) => wrap({ session_id: 'c1', cwd: '/tmp/x', hook_event_name: name, ...extra })
const SCREEN = fs.readFileSync(path.join(FIX, 'claude-pty-limit.raw.txt'), 'utf8')

d('session usage limits + Stalled?', () => {
  let db: DB
  let live: LiveStore
  let writes: string[]
  let limits: { root: AgentNode; hit: LimitHit }[]
  let cleared: string[]
  let stalls: (string | null)[]
  let timers: (() => void)[]
  let clock: number
  let stall: StallMonitor
  const session = { id: 's_limitsaaa', adapter: 'claude' as const, repoId: null, cwd: '/tmp/x', title: 'x · Claude' }
  const deps = (): SessionLiveDeps => ({
    store: live,
    emit: () => {},
    writePty: (_id, data) => writes.push(data),
    isVisible: () => false,
    stall,
    onLimit: (root, hit) => limits.push({ root, hit }),
    onLimitCleared: (sid) => cleared.push(sid),
    onStalled: (_r, since) => stalls.push(since),
    // quiet-tail timers and the resume's submit run when the test says so
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {}
  })
  const runTimers = (): void => {
    const t = timers.splice(0)
    for (const f of t) f()
  }

  beforeEach(() => {
    db = openDatabase(':memory:')
    live = new LiveStore(db)
    writes = []
    limits = []
    cleared = []
    stalls = []
    timers = []
    clock = Date.parse('2026-10-16T09:00:00.000Z')
    stall = new StallMonitor({ thresholdMs: () => 10 * 60_000, now: () => clock })
  })

  it("claude's StopFailure rate_limit hook marks the root once per episode; a keystroke ends the episode", () => {
    const s = new SessionLive(deps(), session, null)
    s.onLine(hook('SessionStart', { model: 'claude-x' }))
    s.onLine(hook('UserPromptSubmit', { prompt: 'go' }))
    const stop = JSON.parse(fs.readFileSync(path.join(FIX, 'claude-stopfailure.hook.json'), 'utf8'))
    s.onLine(wrap(stop))
    s.onLine(wrap(stop))
    const r = live.getAgent(s.root.id)!
    expect(r.stopReason).toBe('rate_limited')
    expect(r.resetAt).toBe('2026-10-20T07:00:00.000Z')
    expect(limits).toHaveLength(1)
    // the turn ended (StopFailure = stop): waiting for the user, not working
    expect(r.status).not.toBe('working')
    s.onUserInput('c')
    expect(live.getAgent(s.root.id)!.stopReason ?? null).toBeNull()
    expect(cleared).toEqual([session.id])
  })

  it('the PTY banner counts only once the turn ended, and a redraw of a cleared banner never re-flags', () => {
    const s = new SessionLive(deps(), session, null)
    s.onLine(hook('SessionStart', {}))
    s.onLine(hook('UserPromptSubmit', { prompt: 'go' }))
    // still working: the banner on screen is ignored
    s.onPtyData(SCREEN)
    runTimers()
    expect(live.getAgent(s.root.id)!.stopReason ?? null).toBeNull()
    s.onLine(hook('Stop', { last_assistant_message: '' }))
    s.onPtyData(SCREEN)
    runTimers()
    const r = live.getAgent(s.root.id)!
    expect(r.stopReason).toBe('rate_limited')
    expect(r.resetAt).toBeTruthy()
    expect(limits).toHaveLength(1)
    s.onUserInput('x')
    expect(live.getAgent(s.root.id)!.stopReason ?? null).toBeNull()
    // the TUI redraws the old transcript (resize): same banner, same reset -> not a new episode
    s.onLine(hook('Stop', {}))
    s.onPtyData(SCREEN)
    runTimers()
    expect(live.getAgent(s.root.id)!.stopReason ?? null).toBeNull()
    expect(limits).toHaveLength(1)
  })

  it('Retry at reset / Retry now: the root carries retryAt, resume types "continue" then Return and clears it', () => {
    const s = new SessionLive(deps(), session, null)
    s.onLine(hook('SessionStart', {}))
    s.onLine(wrap(JSON.parse(fs.readFileSync(path.join(FIX, 'claude-stopfailure.hook.json'), 'utf8'))))
    expect(s.isLimited()).toBe(true)
    s.setRetryAt('2026-10-20T07:01:00.000Z')
    expect(live.getAgent(s.root.id)!.retryAt).toBe('2026-10-20T07:01:00.000Z')
    s.resume()
    runTimers()
    expect(writes).toEqual(['continue', '\r'])
    const r = live.getAgent(s.root.id)!
    expect(r.stopReason ?? null).toBeNull()
    expect(r.retryAt ?? null).toBeNull()
    expect(cleared).toContain(session.id)
  })

  it('Stalled? only for a working root, after N silent minutes; output or a hook line clears it', () => {
    const s = new SessionLive(deps(), session, null)
    s.onLine(hook('SessionStart', {}))
    // idle at the prompt for an hour: waiting for the user, never stalled
    clock += 60 * 60_000
    expect(stall.sweep()).toEqual([])
    s.onLine(hook('UserPromptSubmit', { prompt: 'go' }))
    clock += 9 * 60_000
    expect(stall.sweep()).toEqual([])
    clock += 60_000
    expect(stall.sweep()).toEqual([session.id])
    expect(live.getAgent(s.root.id)!.stalledSince).toBe(new Date(clock - 10 * 60_000).toISOString())
    expect(stalls).toHaveLength(1)
    s.onPtyData('still here')
    expect(live.getAgent(s.root.id)!.stalledSince ?? null).toBeNull()
    expect(stalls.at(-1)).toBeNull()
    // exiting stops the watch
    s.exit(0, true)
    expect(stall.size()).toBe(0)
  })
})
