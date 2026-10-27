import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARM_DELAY_MS, COALESCE_MS, Chimes, DEFAULT_VOLUME, GLOBAL_GAP_MS, KIND_GAP_MS, chimeSettings, planChimeKeys, taskChimeKey, type ChimeKind, type ChimeSettings } from '../chime'
import type { Milestone, Plan } from '../../shared/plans'
import { DEFAULT_SETTINGS } from '../db/store'

// SOUNDS.md: the decision rules, without Electron
const mk = (over: { settings?: Partial<ChimeSettings>; canPlay?: boolean; armed?: boolean } = {}) => {
  vi.useFakeTimers()
  let t = 1_000_000
  let canPlay = over.canPlay ?? true
  const played: { kind: ChimeKind; volume: number }[] = []
  const c = new Chimes({
    settings: () => ({ enabled: true, kinds: { done: true, needs: true, problem: true }, volume: 0.5, ...over.settings }),
    canPlay: () => canPlay,
    play: (kind, volume) => played.push({ kind, volume }),
    now: () => t
  })
  const advance = (ms: number) => {
    t += ms
    vi.advanceTimersByTime(ms)
  }
  if (over.armed !== false) {
    c.arm()
    advance(ARM_DELAY_MS)
  }
  return { c, played, advance, setCanPlay: (v: boolean) => (canPlay = v) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Chimes (SOUNDS.md)', () => {
  it('plays once the coalescing window closes, at the set volume', () => {
    const { c, played, advance } = mk()
    expect(c.request({ kind: 'done', key: 'review:t1:1' })).toBe('chime')
    expect(played).toEqual([])
    advance(COALESCE_MS)
    expect(played).toEqual([{ kind: 'done', volume: 0.5 }])
  })

  it('never before the renderer is ready, nor during the boot grace (recovery, catch-up, replayed history)', () => {
    const { c, played, advance } = mk({ armed: false })
    expect(c.request({ kind: 'problem', key: 'fail:r1' })).toBe('quiet')
    c.arm()
    advance(ARM_DELAY_MS - 1)
    expect(c.request({ kind: 'problem', key: 'fail:r2' })).toBe('quiet')
    c.arm() // a renderer reload never pushes the start back
    advance(1)
    expect(c.request({ kind: 'problem', key: 'fail:r3' })).toBe('chime')
    advance(COALESCE_MS)
    expect(played.map((p) => p.kind)).toEqual(['problem'])
  })

  it('a burst is one sound and the most urgent kind wins', () => {
    const { c, played, advance } = mk()
    expect(c.request({ kind: 'done', key: 'review:t1:1' })).toBe('chime')
    expect(c.request({ kind: 'done', key: 'milestone:m1' })).toBe('chime')
    expect(c.request({ kind: 'needs', key: 'ask:a1' })).toBe('chime')
    expect(c.request({ kind: 'problem', key: 'fail:r1' })).toBe('chime')
    advance(COALESCE_MS)
    expect(played).toEqual([{ kind: 'needs', volume: 0.5 }])
  })

  it('at most one sound per global gap, and each kind keeps its own longer gap', () => {
    const { c, played, advance } = mk()
    c.request({ kind: 'done', key: 'a' })
    advance(COALESCE_MS)
    expect(c.request({ kind: 'needs', key: 'b' })).toBe('quiet') // global gap
    advance(GLOBAL_GAP_MS)
    expect(c.request({ kind: 'done', key: 'c' })).toBe('quiet') // done's own gap
    expect(c.request({ kind: 'needs', key: 'd' })).toBe('chime')
    advance(COALESCE_MS)
    advance(KIND_GAP_MS.done)
    expect(c.request({ kind: 'done', key: 'e' })).toBe('chime')
    advance(COALESCE_MS)
    expect(played.map((p) => p.kind)).toEqual(['done', 'needs', 'done'])
  })

  it('the same event key never plays twice', () => {
    const { c, played, advance } = mk()
    c.request({ kind: 'problem', key: 'stall:ag1|t0' })
    advance(COALESCE_MS + KIND_GAP_MS.problem)
    expect(c.request({ kind: 'problem', key: 'stall:ag1|t0' })).toBe('quiet')
    advance(COALESCE_MS)
    expect(played.length).toBe(1)
  })

  it('never while the user looks right at the thing that changed (and that event stays heard-as-seen)', () => {
    const { c, played, advance } = mk()
    expect(c.request({ kind: 'done', key: 'review:t1:1', visible: true })).toBe('quiet')
    advance(COALESCE_MS)
    expect(played).toEqual([])
    expect(c.request({ kind: 'done', key: 'review:t1:1' })).toBe('quiet')
  })

  it('respects Sounds and the per-kind switches', () => {
    expect(mk({ settings: { enabled: false } }).c.request({ kind: 'needs', key: 'x' })).toBe('quiet')
    const { c, played, advance } = mk({ settings: { kinds: { done: false, needs: true, problem: true } } })
    expect(c.request({ kind: 'done', key: 'x' })).toBe('quiet')
    expect(c.request({ kind: 'needs', key: 'y' })).toBe('chime')
    advance(COALESCE_MS)
    expect(played.map((p) => p.kind)).toEqual(['needs'])
  })

  it('notification silencing: a playing chime silences the notification; with no window the notification keeps its sound', () => {
    const { c, played, advance, setCanPlay } = mk()
    expect(c.notificationSound({ kind: 'needs', key: 'ask:a1' })).toBe(false)
    advance(COALESCE_MS)
    expect(played.length).toBe(1)
    advance(KIND_GAP_MS.needs)
    setCanPlay(false)
    expect(c.notificationSound({ kind: 'needs', key: 'ask:a2' })).toBe(true) // fallback: the Mac ding stands in
    advance(COALESCE_MS)
    expect(played.length).toBe(1)
    // the fallback counts as the sound for the gaps: no second ding right after
    expect(c.notificationSound({ kind: 'problem', key: 'fail:r1' })).toBe(false)
    // quiet outcomes (cooldown, off, boot, visible) also leave the notification silent
    expect(mk({ armed: false }).c.notificationSound({ kind: 'problem', key: 'z' })).toBe(false)
  })

  it('the window going away inside the coalescing window drops the sound', () => {
    const { c, played, advance, setCanPlay } = mk()
    c.request({ kind: 'done', key: 'a' })
    setCanPlay(false)
    advance(COALESCE_MS)
    expect(played).toEqual([])
  })

  it('settings: "Sounds" is notificationSound; absent per-kind switches are on; the volume is clamped', () => {
    expect(chimeSettings(DEFAULT_SETTINGS)).toEqual({ enabled: true, kinds: { done: true, needs: true, problem: true }, volume: DEFAULT_VOLUME })
    // an old settings file: only notificationSound
    expect(chimeSettings({ notificationSound: false })).toEqual({ enabled: false, kinds: { done: true, needs: true, problem: true }, volume: DEFAULT_VOLUME })
    expect(chimeSettings({ notificationSound: true, soundProblem: false, soundVolume: 4 })).toMatchObject({ kinds: { problem: false }, volume: 1 })
    expect(chimeSettings({ notificationSound: true, soundVolume: Number.NaN }).volume).toBe(DEFAULT_VOLUME)
  })
})

describe('which board moves are a Done sound', () => {
  const task = (status: 'in_review' | 'done' | 'todo' | 'blocked') => ({ id: 'task_1', status, updatedAt: '2026-10-27T10:00:00.000Z' })
  it('an agent finishing its work (in progress → in review) is; human moves and run failures are not', () => {
    expect(taskChimeKey(task('in_review'), { status: 'in_progress' })).toBe('review:task_1:2026-10-27T10:00:00.000Z')
    expect(taskChimeKey(task('done'), { status: 'in_review' })).toBeNull() // the founder approved it
    expect(taskChimeKey(task('todo'), { status: 'in_review' })).toBeNull() // sent back
    expect(taskChimeKey(task('blocked'), { status: 'in_progress' })).toBeNull() // a failed run is the run's Problem sound
    expect(taskChimeKey(task('in_review'), null)).toBeNull() // created (imported) straight into review
    expect(taskChimeKey(task('in_review'), { status: 'in_review' })).toBeNull() // an edit on a reviewed task
  })

  const ms = (id: string, pass: boolean, passedAt: string | null = null): Milestone =>
    ({ id, gate: { result: pass ? 'pass' : null, notes: '', at: null, evidence: [], fails: 0 }, passedAt }) as unknown as Milestone
  const plan = (status: Plan['status'], autonomy: Plan['autonomy'], milestones: Milestone[]): Plan => ({ id: 'plan_1', status, autonomy, milestones }) as unknown as Plan
  it('a milestone newly complete and the plan finishing are; a draft or an unchanged plan are not', () => {
    expect(planChimeKeys(null, plan('draft', 'autopilot', []))).toEqual([])
    const before = plan('running', 'autopilot', [ms('m1', true), ms('m2', false)])
    expect(planChimeKeys(before, before)).toEqual([])
    expect(planChimeKeys(before, plan('done', 'autopilot', [ms('m1', true), ms('m2', true)]))).toEqual(['plan:plan_1', 'milestone:m2'])
    // outside Autopilot a passed gate waits for you: complete only once you pass it
    const step = plan('running', 'step', [ms('m1', false)])
    expect(planChimeKeys(step, plan('running', 'step', [ms('m1', true)]))).toEqual([])
    expect(planChimeKeys(plan('running', 'step', [ms('m1', true)]), plan('running', 'step', [ms('m1', true, '2026-10-27T10:00:00.000Z')]))).toEqual(['milestone:m1'])
  })
})
