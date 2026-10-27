/**
 * USAGE.md §5: Token activity against fixture roots only (never ~/.claude or ~/.codex): Claude messages once per id,
 * Codex running totals as deltas, Principia's own rows only when no transcript holds them, local-day buckets across
 * midnight and time zones, streaks and peak, longest task, the incremental cache, and nothing written under a root.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TokenActivity } from '../../shared/usage'
import { activityGrid, activityStats, compactTokens, dayTotal, taskDuration } from '../../shared/tokenActivity'
import { DEDUPE_DAYS, IDLE_GAP_MS, SYNC_BYTES, TokenActivityService, codexRoots, emptyCache, fold, loadCache, type PrincipiaRow } from './tokens'

let tmp: string
let claudeRoot: string
let codexRoot: string
let cachePath: string
let rows: PrincipiaRow[]
let claudeOn: boolean
const TZ0 = process.env.TZ

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const THREAD = '01a17865-af83-7de1-b7ab-f45aace07c0a'
const line = (o: unknown): string => `${JSON.stringify(o)}\n`
const usage = (i: number, o: number, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr })
const asst = (ts: string, id: string, u: ReturnType<typeof usage>, req = `req_${id}`, extra: Record<string, unknown> = {}) => ({ type: 'assistant', timestamp: ts, requestId: req, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: u }, ...extra })
const prompt = (ts: string) => ({ type: 'user', timestamp: ts, promptSource: 'typed', message: { role: 'user', content: 'do the thing' } })
const toolResult = (ts: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } })

function claudeFile(project: string, name: string, recs: unknown[]): string {
  const dir = path.join(claudeRoot, project)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  fs.writeFileSync(f, recs.map(line).join(''))
  return f
}
const tokenCount = (ts: string, total: { i: number; c: number; o: number }, last?: { i: number; c: number; o: number }) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total.i, cached_input_tokens: total.c, cache_write_input_tokens: 0, output_tokens: total.o, total_tokens: total.i + total.o },
      ...(last ? { last_token_usage: { input_tokens: last.i, cached_input_tokens: last.c, output_tokens: last.o } } : {})
    }
  }
})
function codexFile(day: string, name: string, recs: unknown[]): string {
  const dir = path.join(codexRoot, ...day.split('-'))
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `rollout-${name}.jsonl`)
  fs.writeFileSync(f, recs.map(line).join(''))
  return f
}
const make = (now?: () => number) =>
  new TokenActivityService({
    cachePath,
    claudeRoots: () => [claudeRoot],
    claudeEnabled: () => claudeOn,
    codexRoots: () => codexRoots({ HIVE_CODEX_DIRS: codexRoot }),
    principia: () => rows,
    ...(now ? { now } : {})
  })
async function run(svc = make()): Promise<TokenActivity> {
  await svc.get()
  await svc.idle()
  return svc.build('ready')
}
const day = (a: TokenActivity, date: string) => a.days.find((d) => d.date === date)

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.set(p, `${st.size}:${st.mtimeMs}:${st.mode}`)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}

beforeEach(() => {
  process.env.TZ = 'UTC'
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tokens-')))
  claudeRoot = path.join(tmp, 'claude')
  codexRoot = path.join(tmp, 'codex')
  fs.mkdirSync(claudeRoot)
  fs.mkdirSync(codexRoot)
  cachePath = path.join(tmp, 'data', 'token-activity.json')
  rows = []
  claudeOn = true
})
afterEach(() => {
  if (TZ0 === undefined) delete process.env.TZ
  else process.env.TZ = TZ0
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Claude transcripts', () => {
  it('counts a message once per id + request, keeping the largest of each part, across lines and files', async () => {
    // streamed: the same message on three lines, output growing; then a resumed session copies it
    claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-20T10:00:00Z', 'msg_1', usage(5, 3, 100, 1000)), asst('2026-10-20T10:00:01Z', 'msg_1', usage(5, 40, 100, 1000)), asst('2026-10-20T10:00:02Z', 'msg_1', usage(5, 12, 100, 1000)), asst('2026-10-20T10:01:00Z', 'msg_2', usage(1, 2, 0, 50))])
    claudeFile('-work-a', `${ID2}.jsonl`, [asst('2026-10-20T10:00:00Z', 'msg_1', usage(5, 40, 100, 1000))])
    // a subagent's own transcript counts too
    fs.mkdirSync(path.join(claudeRoot, '-work-a', ID1, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(claudeRoot, '-work-a', ID1, 'subagents', 'agent-a1.jsonl'), line(asst('2026-10-20T10:02:00Z', 'msg_3', usage(0, 10, 0, 0))))
    const a = await run()
    const c = day(a, '2026-10-20')!.byProvider.claude!
    expect(c).toEqual({ input: 6, output: 52, cacheWrite: 100, cacheRead: 1050 })
    expect(day(a, '2026-10-20')!.byModel).toEqual({ 'claude-opus-5-5': 1208 })
    expect(a.sources.find((s) => s.id === 'claude')).toMatchObject({ counted: true, tokens: 1208 })
  })

  it('times the longest turn from the typed prompt, leaving out waits over IDLE_GAP_MS', async () => {
    const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 9, 0) + min * 60_000).toISOString()
    claudeFile('-work-a', `${ID1}.jsonl`, [
      prompt(t(0)),
      asst(t(5), 'm1', usage(1, 1)),
      toolResult(t(12)),
      asst(t(12 + IDLE_GAP_MS / 60_000 + 30), 'm2', usage(1, 1)), // a long wait on the person: not work
      asst(t(12 + IDLE_GAP_MS / 60_000 + 33), 'm3', usage(1, 1)),
      prompt(t(200)),
      asst(t(204), 'm4', usage(1, 1))
    ])
    const a = await run()
    expect(a.longestTaskMs).toBe(15 * 60_000)
    expect(taskDuration(a.longestTaskMs)).toBe('15m')
  })

  it('reads nothing when Claude history is off, and says so', async () => {
    claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-20T10:00:00Z', 'msg_1', usage(5, 3))])
    claudeOn = false
    const a = await run()
    expect(a.days).toEqual([])
    expect(a.sources.find((s) => s.id === 'claude')).toMatchObject({ counted: false, note: 'Claude Code history is off in Settings' })
  })
})

describe('Codex rollouts', () => {
  it('counts the deltas of the running total, cached input split out, repeats and resets handled', async () => {
    codexFile('2026-10-21', `2026-10-21T10-00-00-${THREAD}`, [
      { timestamp: '2026-10-21T10:00:00Z', type: 'session_meta', payload: { id: THREAD, cwd: '/work/a' } },
      { timestamp: '2026-10-21T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      tokenCount('2026-10-21T10:00:01Z', { i: 1000, c: 600, o: 10 }),
      tokenCount('2026-10-21T10:00:02Z', { i: 1000, c: 600, o: 10 }), // the same total again: nothing new
      tokenCount('2026-10-21T10:00:03Z', { i: 2500, c: 2000, o: 30 }),
      { timestamp: '2026-10-21T10:00:04Z', type: 'event_msg', payload: { type: 'task_complete', duration_ms: 96 * 60_000 } },
      // a total that went down: only that event's own usage counts
      tokenCount('2026-10-21T10:00:05Z', { i: 100, c: 0, o: 5 }, { i: 100, c: 0, o: 5 })
    ])
    const a = await run()
    const c = day(a, '2026-10-21')!.byProvider.codex!
    // fresh input 400 + 100 + 100, output 10 + 20 + 5, cached 600 + 1400
    expect(c).toEqual({ input: 600, output: 35, cacheWrite: 0, cacheRead: 2000 })
    expect(day(a, '2026-10-21')!.byModel).toEqual({ 'gpt-6.1-sol': 2635 })
    expect(a.longestTaskMs).toBe(96 * 60_000)
    expect(taskDuration(a.longestTaskMs)).toBe('1h 36m')
  })
})

describe("Principia's own records", () => {
  it('counts only runs and calls no transcript holds', async () => {
    claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-22T10:00:00Z', 'msg_1', usage(5, 5))])
    codexFile('2026-10-22', `x-${THREAD}`, [{ timestamp: '2026-10-22T10:00:00Z', type: 'session_meta', payload: { id: THREAD } }, tokenCount('2026-10-22T10:00:01Z', { i: 10, c: 0, o: 0 })])
    rows = [
      { at: '2026-10-22T10:00:00Z', provider: 'claude', model: 'claude-opus-5-5', tokensIn: 999, tokensOut: 1, sessionId: ID1, orch: false }, // in ~/.claude
      { at: '2026-10-22T10:00:00Z', provider: 'codex', model: null, tokensIn: 999, tokensOut: 1, sessionId: THREAD, orch: false }, // in ~/.codex
      { at: '2026-10-22T11:00:00Z', provider: 'codex', model: null, tokensIn: 50, tokensOut: 5, sessionId: null, orch: true }, // codex exec keeps a rollout
      { at: '2026-10-22T12:00:00Z', provider: 'claude', model: 'claude-haiku-5-5', tokensIn: 70, tokensOut: 7, sessionId: null, orch: true }, // --no-session-persistence
      { at: '2026-10-22T13:00:00Z', provider: 'gemini', model: 'gemini-3', tokensIn: 20, tokensOut: 2, sessionId: 'gem-1', orch: false }
    ]
    const a = await run()
    const d = day(a, '2026-10-22')!
    expect(d.byProvider.principia).toEqual({ input: 90, output: 9, cacheWrite: 0, cacheRead: 0 })
    expect(dayTotal(d)).toBe(10 + 10 + 99)
    expect(a.sources.find((s) => s.id === 'principia')!.note).toMatch(/^3 runs and chats already counted/)
  })
})

describe('local days', () => {
  it('buckets by the local day, recomputed when the time zone changes', async () => {
    // 06:30Z and 07:30Z on Oct 26: one day in UTC, two days in Los Angeles (UTC-7 in October)
    claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-26T06:30:00Z', 'msg_1', usage(1, 0)), asst('2026-10-26T07:30:00Z', 'msg_2', usage(2, 0))])
    const svc = make()
    await run(svc)
    expect(svc.build('ready').days.map((d) => [d.date, dayTotal(d)])).toEqual([['2026-10-26', 3]])
    process.env.TZ = 'America/Los_Angeles'
    expect(svc.build('ready').days.map((d) => [d.date, dayTotal(d)])).toEqual([
      ['2026-10-25', 1],
      ['2026-10-26', 2]
    ])
    process.env.TZ = 'Asia/Kolkata' // UTC+5:30: both on the 26th, the 15-minute buckets keep the half hour
    expect(svc.build('ready').days.map((d) => [d.date, dayTotal(d)])).toEqual([['2026-10-26', 3]])
  })
})

describe('stats and grid', () => {
  const d = (date: string, n: number) => ({ date, byProvider: { claude: { input: n, output: 0, cacheWrite: 0, cacheRead: 0 } }, byModel: {} })
  it('finds lifetime, peak, the longest streak and the current one (alive until today ends)', () => {
    const days = [d('2026-10-01', 5), d('2026-10-02', 5), d('2026-10-03', 5), d('2026-10-05', 50), d('2026-10-25', 1), d('2026-10-26', 2)]
    const s = activityStats(days, new Date(2026, 9, 26, 15))
    expect(s).toMatchObject({ lifetime: 68, peak: { date: '2026-10-05', tokens: 50 }, longestStreak: 3, currentStreak: 2, activeDays: 6 })
    // today has nothing yet: yesterday's streak still counts; two quiet days break it
    expect(activityStats(days, new Date(2026, 9, 27, 9)).currentStreak).toBe(2)
    expect(activityStats(days, new Date(2026, 9, 28, 9)).currentStreak).toBe(0)
  })
  it('streaks across a DST change count calendar days', () => {
    process.env.TZ = 'Europe/Madrid' // clocks go back on Oct 25, 2026
    const s = activityStats([d('2026-10-24', 1), d('2026-10-25', 1), d('2026-10-26', 1)], new Date(2026, 9, 26, 12))
    expect(s.longestStreak).toBe(3)
    expect(s.currentStreak).toBe(3)
  })
  it('lays out 53 Monday-first weeks ending today; weekly shares a level per week, cumulative only grows', () => {
    const now = new Date(2026, 9, 27, 12) // a Tuesday
    const days = [d('2026-10-20', 10), d('2026-10-21', 1000), d('2026-10-27', 1), d('2025-01-01', 7)]
    const g = activityGrid(days, now, 'daily')
    expect(g.cells).toHaveLength(53 * 7)
    expect(g.cells.filter((c) => !c.future).at(-1)).toMatchObject({ date: '2026-10-27', row: 1, col: 52 })
    expect(g.cells.find((c) => c.date === '2026-10-21')!.level).toBe(4)
    expect(g.cells.find((c) => c.date === '2026-10-22')!.level).toBe(0)
    expect(g.months.at(-1)).toMatchObject({ label: 'Oct' })
    const w = activityGrid(days, now, 'weekly')
    const week = w.cells.filter((c) => c.col === 51)
    expect(new Set(week.map((c) => c.level)).size).toBe(1)
    expect(week[0].value).toBe(1010)
    const cum = activityGrid(days, now, 'cumulative').cells.filter((c) => !c.future)
    expect(cum[0].value).toBe(7) // tokens before the grid are in the running total
    expect(cum.every((c, i) => i === 0 || c.value >= cum[i - 1].value)).toBe(true)
    expect(cum.at(-1)!.level).toBe(4)
  })
  it('formats like the reference', () => {
    expect(compactTokens(2_712_000_000)).toBe('2.7B')
    expect(compactTokens(723_600_000)).toBe('723.6M')
    expect(compactTokens(512)).toBe('512')
    expect(taskDuration(0)).toBe('—')
  })
})

describe('the incremental cache', () => {
  it('reads only appended bytes on the next scan, resumes from the saved cache, and starts a rewritten file over', async () => {
    // the fixture days must stay inside DEDUPE_DAYS of "now", or they fold away and later lines are skipped
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'))
    onTestFinished(() => { vi.useRealTimers() })
    const f = claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-20T10:00:00Z', 'msg_1', usage(1, 1))])
    const first = await run()
    expect(dayTotal(day(first, '2026-10-20')!)).toBe(2)
    expect(fs.existsSync(cachePath)).toBe(true)

    // a half-written line is left for later; a new instance resumes from the file on disk
    const add = line(asst('2026-10-20T11:00:00Z', 'msg_2', usage(10, 10)))
    fs.appendFileSync(f, add + JSON.stringify(asst('2026-10-20T12:00:00Z', 'msg_3', usage(100, 0))).slice(0, 30))
    const svc = make()
    const answer = await svc.get()
    expect(answer.state).toBe('ready') // small: the answer waited for it
    expect(dayTotal(day(answer, '2026-10-20')!)).toBe(22)
    const cache = loadCache(cachePath)
    expect(cache.files[f].offset).toBe(fs.statSync(f).size - 30)

    // the rest of that line arrives
    fs.appendFileSync(f, `${JSON.stringify(asst('2026-10-20T12:00:00Z', 'msg_3', usage(100, 0))).slice(30)}\n`)
    const svc2 = make(() => Date.now() + 60_000)
    expect(dayTotal(day(await svc2.get(), '2026-10-20')!)).toBe(122)

    // rewritten shorter: read again from the start, messages already counted stay counted once
    fs.writeFileSync(f, line(asst('2026-10-20T10:00:00Z', 'msg_1', usage(1, 1))))
    const svc3 = make(() => Date.now() + 120_000)
    expect(dayTotal(day(await svc3.get(), '2026-10-20')!)).toBe(122)
  })

  it('answers "counting" with progress while a large first scan runs', async () => {
    const big = asst('2026-10-20T10:00:00Z', 'msg_x', usage(1, 1))
    const pad = 'x'.repeat(1024 * 1024)
    const rec = { ...big, message: { ...big.message, content: [{ type: 'text', text: pad }] } }
    const n = Math.ceil(SYNC_BYTES / (1024 * 1024)) + 2
    claudeFile('-big', `${ID1}.jsonl`, Array.from({ length: n }, (_, i) => ({ ...rec, message: { ...rec.message, id: `msg_${i}` } })))
    const svc = make()
    const a = await svc.get()
    expect(a.state).toBe('counting')
    expect(a.progress!.bytesTotal).toBeGreaterThan(SYNC_BYTES)
    await svc.idle()
    expect(dayTotal(svc.build('ready').days[0])).toBe(2 * n)
  })

  it('folds messages older than DEDUPE_DAYS and skips later copies of them', () => {
    const c = emptyCache()
    c.models = ['m']
    const now = Date.UTC(2026, 9, 27)
    c.msgs['old:r'] = [now - (DEDUPE_DAYS + 1) * 86_400_000, 0, 1, 2, 3, 4]
    c.msgs['new:r'] = [now - 86_400_000, 0, 1, 1, 1, 1]
    fold(c, now)
    expect(Object.keys(c.msgs)).toEqual(['new:r'])
    expect(Object.values(c.folded).flatMap((b) => Object.values(b))).toEqual([[1, 2, 3, 4]])
    expect(c.watermark).toBe(now - DEDUPE_DAYS * 86_400_000)
  })

  it('never writes under the transcript roots and never follows a symlink', async () => {
    claudeFile('-work-a', `${ID1}.jsonl`, [asst('2026-10-20T10:00:00Z', 'msg_1', usage(1, 1))])
    const outside = path.join(tmp, 'outside.jsonl')
    fs.writeFileSync(outside, line(asst('2026-10-20T10:00:00Z', 'msg_out', usage(1000, 0))))
    fs.symlinkSync(outside, path.join(claudeRoot, '-work-a', `${ID2}.jsonl`))
    const before = [tree(claudeRoot), tree(codexRoot)]
    const a = await run()
    expect(dayTotal(day(a, '2026-10-20')!)).toBe(2)
    expect([tree(claudeRoot), tree(codexRoot)]).toEqual(before)
  })
})
