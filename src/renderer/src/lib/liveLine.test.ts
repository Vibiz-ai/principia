import { describe, expect, it } from 'vitest'
import { liveLine, START_SPIN_MS, START_STUCK_MS, type LiveLineInput } from './liveLine'

const now = Date.parse('2026-11-05T12:00:00Z')
const ago = (ms: number): string => new Date(now - ms).toISOString()
const base: LiveLineInput = { working: true, since: ago(0), stallMinutes: 10, now }
const root = (o: Partial<NonNullable<LiveLineInput['root']>> = {}): NonNullable<LiveLineInput['root']> => ({ status: 'working', activity: null, stalledSince: null, stopReason: null, resetAt: null, ...o })

describe('liveLine', () => {
  it('says nothing when the task is not working', () => {
    expect(liveLine({ ...base, working: false })).toBeNull()
  })

  it('shows the agent activity while it works', () => {
    expect(liveLine({ ...base, root: root(), doing: 'Run the tests' })).toEqual({ kind: 'working', label: 'Working', text: 'Run the tests', spin: true })
    expect(liveLine({ ...base, root: root() })?.text).toBe('Working…')
  })

  it('names the wait for a free slot, without a spinner', () => {
    const l = liveLine({ ...base, slotWaitSince: ago(60_000), root: root() })
    expect(l).toMatchObject({ kind: 'waiting', text: 'Waiting for a free slot', spin: false })
  })

  it('spins only for the first moments of a start, then says how long and finally that it did not start', () => {
    expect(liveLine({ ...base, since: ago(5_000) })).toMatchObject({ kind: 'waiting', text: 'Starting…', spin: true })
    expect(liveLine({ ...base, since: ago(START_SPIN_MS + 60_000) })).toMatchObject({ kind: 'waiting', spin: false, text: 'Still starting · 2m' })
    expect(liveLine({ ...base, since: ago(START_STUCK_MS + 1) })).toMatchObject({ kind: 'stuck', spin: false })
    expect(liveLine({ ...base, since: ago(START_STUCK_MS + 1) })?.text).toMatch(/^Didn't start/)
  })

  it('never spins on a bad start time', () => {
    expect(liveLine({ ...base, since: 'nope' })?.spin).toBe(false)
  })

  it('a chat-tracked task points at its chat, unless the chat root is live', () => {
    expect(liveLine({ ...base, inChat: true, since: ago(START_STUCK_MS * 2) })).toMatchObject({ kind: 'in_chat', spin: false })
    expect(liveLine({ ...base, inChat: true, root: root(), doing: 'Edit 3 files' })).toMatchObject({ kind: 'working', text: 'Edit 3 files' })
  })

  it('a silent agent reads as slow, then as not responding', () => {
    // stalledSince is set once it has been quiet for stallMinutes: quiet = since stalled + stallMinutes
    expect(liveLine({ ...base, root: root({ stalledSince: ago(2 * 60_000) }) })).toMatchObject({ kind: 'slow', text: 'Taking longer than usual · quiet for 12m', spin: false })
    expect(liveLine({ ...base, root: root({ stalledSince: ago(20 * 60_000) }) })).toMatchObject({ kind: 'stuck', text: 'Not responding · quiet for 30m', spin: false })
  })

  it('a usage limit is a wait with its reset time, not work', () => {
    const l = liveLine({ ...base, root: root({ stopReason: 'rate_limited', resetAt: '2026-11-05T15:00:00Z' }) })
    expect(l?.kind).toBe('waiting')
    expect(l?.spin).toBe(false)
    expect(l?.text).toMatch(/^Hit the usage limit · resumes at /)
  })

  it('an ended root does not count as live', () => {
    expect(liveLine({ ...base, root: root({ status: 'done' }), since: ago(START_STUCK_MS + 1) })?.kind).toBe('stuck')
  })
})
