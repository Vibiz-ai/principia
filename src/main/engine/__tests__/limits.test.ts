/** CONTRACT §13: usage / rate-limit classification of CLI output (stream-json, hooks, PTY screens, plain text). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyLimitText, classifyStopFailure, classifyStreamLine, laterReset, parseDuration, parseResetTime } from '../live/limits'
import { stripAnsi } from '../live/pty'

const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'limits', name), 'utf8')
const lines = (name: string): string[] => fx(name).split('\n').filter(Boolean)
// 11:00 in Madrid (09:00 UTC) on 2026-10-16
const NOW = new Date('2026-10-16T09:00:00.000Z')

describe('parseResetTime', () => {
  it('reads claude clock times in the named zone, as the next such time', () => {
    expect(parseResetTime('You’ve hit your session limit · resets 3pm (Europe/Madrid)', NOW)?.toISOString()).toBe('2026-10-16T13:00:00.000Z')
    expect(parseResetTime('resets at 3:30 PM (America/New_York)', NOW)?.toISOString()).toBe('2026-10-16T19:30:00.000Z')
    // 10am Madrid already passed at 11:00 Madrid: tomorrow
    expect(parseResetTime('resets 10am (Europe/Madrid)', NOW)?.toISOString()).toBe('2026-10-17T08:00:00.000Z')
    expect(parseResetTime('Your limit will reset at 12am (Europe/Madrid).', NOW)?.toISOString()).toBe('2026-10-16T22:00:00.000Z')
  })

  it('reads dates, weekdays, ISO stamps and 24 h clocks', () => {
    expect(parseResetTime('resets Oct 20, 9am (Europe/Madrid)', NOW)?.toISOString()).toBe('2026-10-20T07:00:00.000Z')
    expect(parseResetTime('resets Mon 9am (Europe/Madrid)', NOW)?.toISOString()).toBe('2026-10-19T07:00:00.000Z')
    expect(parseResetTime('spend limit reached (daily; resets 2026-10-17 00:00 UTC)', NOW)?.toISOString()).toBe('2026-10-17T00:00:00.000Z')
    expect(parseResetTime('reset at 15:00 (Europe/Madrid)', NOW)?.toISOString()).toBe('2026-10-16T13:00:00.000Z')
  })

  it('bare clock times are local', () => {
    const want = new Date(2026, 9, 16, 15, 0, 0, 0)
    const now = new Date(2026, 9, 16, 11, 0, 0, 0)
    expect(parseResetTime('5-hour limit reached ∙ resets 3pm', now)?.getTime()).toBe(want.getTime())
    expect(parseResetTime('try again at 3:05 PM', now)?.getTime()).toBe(new Date(2026, 9, 16, 15, 5).getTime())
  })

  it('reads relative waits and the old epoch suffix', () => {
    expect(parseResetTime('try again in 2 days 3 hours 5 minutes.', NOW)?.toISOString()).toBe('2026-10-18T12:05:00.000Z')
    expect(parseResetTime('Your quota will reset after 2h32m15s.', NOW)?.toISOString()).toBe('2026-10-16T11:32:15.000Z')
    expect(parseResetTime('Claude AI usage limit reached|1792155600', NOW)?.toISOString()).toBe('2026-10-16T13:00:00.000Z')
    expect(parseDuration('45 min')).toBe(45 * 60_000)
  })

  it('returns null when no time is said', () => {
    expect(parseResetTime('You have exhausted your daily quota on this model.', NOW)).toBeNull()
    expect(parseResetTime('resets 3', NOW)).toBeNull()
  })
})

describe('classifyStreamLine', () => {
  it('claude: rate_limit_event rejected carries the exact reset; the assistant error and result agree', () => {
    const hits = lines('claude-rate-limit.stream.jsonl').map((l) => classifyStreamLine('claude', l, NOW))
    expect(hits[0]).toBeNull() // system init
    expect(hits[1]).toEqual({ message: 'Usage limit reached (five hour)', resetAt: '2026-10-16T13:00:00.000Z' })
    expect(hits[2]?.resetAt).toBe('2026-10-16T13:00:00.000Z')
    expect(hits[2]?.message).toMatch(/hit your session limit/)
    expect(hits[3]?.resetAt).toBe('2026-10-16T13:00:00.000Z')
  })

  it('claude: an agent writing about rate limits is never a limit', () => {
    for (const l of lines('claude-prose-about-limits.stream.jsonl')) expect(classifyStreamLine('claude', l, NOW)).toBeNull()
  })

  it('codex: error / turn.failed usage limit with a relative wait', () => {
    const hits = lines('codex-usage-limit.jsonl').map((l) => classifyStreamLine('codex', l, NOW))
    expect(hits[0]).toBeNull()
    expect(hits[2]?.resetAt).toBe('2026-10-16T11:05:00.000Z')
    expect(hits[3]?.message).toMatch(/hit your usage limit/)
  })

  it('gemini: exhausted capacity with "reset after"', () => {
    const hits = lines('gemini-quota.jsonl').map((l) => classifyStreamLine('gemini', l, NOW))
    expect(hits[0]).toBeNull()
    expect(hits[1]?.resetAt).toBe('2026-10-16T11:32:15.000Z')
    expect(hits[2]?.resetAt).toBe('2026-10-16T11:32:15.000Z')
  })

  it('cursor / plain stderr text', () => {
    const now = new Date(2026, 9, 16, 11, 0)
    const hit = classifyStreamLine('cursor', fx('cursor-usage-limit.txt').trim(), now)
    expect(hit?.resetAt).toBe(new Date(2026, 9, 16, 15, 5).toISOString())
    expect(classifyStreamLine('cursor', 'compiling 12 files', now)).toBeNull()
  })
})

describe('hooks and PTY screens', () => {
  it('claude StopFailure rate_limit hook', () => {
    const hit = classifyStopFailure(JSON.parse(fx('claude-stopfailure.hook.json')), NOW)
    expect(hit?.resetAt).toBe('2026-10-20T07:00:00.000Z')
    expect(classifyStopFailure({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API unavailable' }, NOW)).toBeNull()
    expect(classifyStopFailure({ hook_event_name: 'Stop' }, NOW)).toBeNull()
  })

  it('a PTY screen with the limit banner at the bottom (strict)', () => {
    const now = new Date(2026, 9, 16, 11, 0)
    const hit = classifyLimitText(stripAnsi(fx('claude-pty-limit.raw.txt')), now, { tailLines: 12, strict: true })
    expect(hit?.message).toMatch(/5-hour limit reached/)
    expect(hit?.resetAt).toBe(new Date(2026, 9, 16, 15, 0).toISOString())
  })

  it('strict mode ignores quoted 429s and old banners scrolled away', () => {
    const now = new Date(2026, 9, 16, 11, 0)
    expect(classifyLimitText('The API returned 429 Too Many Requests and RESOURCE_EXHAUSTED', now, { strict: true })).toBeNull()
    const old = ['5-hour limit reached ∙ resets 3pm', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n')
    expect(classifyLimitText(old, now, { tailLines: 12, strict: true })).toBeNull()
    expect(classifyLimitText('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', now, { strict: true })?.resetAt).toBeNull()
  })

  it('laterReset keeps the later known reset', () => {
    expect(laterReset(null, '2026-10-16T13:00:00.000Z')).toBe('2026-10-16T13:00:00.000Z')
    expect(laterReset('2026-10-16T14:00:00.000Z', '2026-10-16T13:00:00.000Z')).toBe('2026-10-16T14:00:00.000Z')
    expect(laterReset(null, null)).toBeNull()
  })
})
