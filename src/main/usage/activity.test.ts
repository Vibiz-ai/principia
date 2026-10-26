/**
 * USAGE.md §4: outside Claude sessions for the Activity canvas, against fixture roots only (HIVE_CLAUDE_DIRS-style,
 * never ~/.claude): the 15 min window, state and current tool, tokens once per message, Principia's own sessions
 * shown once, company by cwd, incremental tails, throttled updates, watcher gone on close, and nothing written.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { historyRoots } from '../history'
import type { ActivitySnapshot } from '../../shared/usage'
import { OutsideActivity, THROTTLE_MS, WINDOW_MIN, latestIso, nativeWatch } from './activity'

let root: string
let emitted: ActivitySnapshot[]
let inHive: Set<string>
let watchers: { closed: boolean; onChange: (f: string) => void }[]
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const ID3 = '33333333-3333-4333-8333-333333333333'

function session(project: string, id: string, cwd: string, recs: unknown[]): string {
  const dir = path.join(root, project)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(f, recs.map(line).join(''))
  return f
}
const prompt = (cwd: string, text: string, ts = new Date().toISOString()) => ({ type: 'user', cwd, timestamp: ts, promptSource: 'typed', message: { role: 'user', content: text } })
const toolUse = (msgId: string, name: string, input: unknown, usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 }) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: msgId, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t_${msgId}`, name, input }], usage } })
const done = (msgId: string) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: msgId, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All set.' }], usage: { input_tokens: 5, output_tokens: 5 } } })

function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
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

const make = (over: Partial<ConstructorParameters<typeof OutsideActivity>[0]> = {}) =>
  new OutsideActivity({
    roots: () => historyRoots({ HIVE_CLAUDE_DIRS: root }),
    enabled: () => true,
    inHiveIds: () => inHive,
    companyForCwd: (cwd) => (cwd.startsWith('/work/acme') ? 'co_acme' : null),
    redact: (s) => s.replace('sk-live-123', '••••KEY'),
    emit: (s) => emitted.push(s),
    watch: (_roots, onChange) => {
      const w = { closed: false, onChange, close: () => void (w.closed = true) }
      watchers.push(w)
      return w
    },
    ...over
  })

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-activity-')))
  emitted = []
  inHive = new Set()
  watchers = []
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('OutsideActivity', () => {
  it('lists sessions active in the window with their tool, state, tokens and company', () => {
    session('-work-acme', ID1, '/work/acme', [prompt('/work/acme', 'fix the login sk-live-123'), toolUse('m1', 'Bash', { command: 'npm test' }), toolUse('m1', 'Bash', { command: 'npm test' })])
    session('-tmp', ID2, '/tmp', [prompt('/tmp', 'hello'), done('m2')])
    const old = session('-old', ID3, '/old', [prompt('/old', 'yesterday')])
    const t = (Date.now() - (WINDOW_MIN + 5) * 60_000) / 1000
    fs.utimesSync(old, t, t)
    const a = make()
    const snap = a.open()
    expect(snap.sessions.map((s) => s.id).sort()).toEqual([ID1, ID2])
    const s1 = snap.sessions.find((s) => s.id === ID1)!
    expect(s1.companyId).toBe('co_acme')
    expect(s1.state).toBe('working')
    expect(s1.doing).toMatch(/npm test/)
    expect(s1.title).toBe('fix the login ••••KEY')
    // the repeated streaming line of message m1 counts once
    expect(s1.tokensIn).toBe(1100)
    expect(s1.tokensOut).toBe(20)
    const s2 = snap.sessions.find((s) => s.id === ID2)!
    expect(s2.companyId).toBeNull()
    expect(s2.state).toBe('idle')
    a.close()
  })

  it('idle time runs from the later of the last record and the file mtime', () => {
    const eightHours = new Date(Date.now() - 8 * 3600_000).toISOString()
    const f = session('-tmp', ID2, '/tmp', [prompt('/tmp', 'seo check', eightHours), { ...done('m9'), timestamp: eightHours }])
    const a = make()
    const s = a.open().sessions.find((x) => x.id === ID2)!
    expect(Date.now() - Date.parse(s.lastAt!)).toBeLessThan(60_000)
    expect(Date.parse(s.lastAt!)).toBeCloseTo(fs.statSync(f).mtimeMs, -3)
    a.close()
    expect(latestIso('2026-10-25T10:00:00.000Z', Date.parse('2026-10-25T09:00:00.000Z'))).toBe('2026-10-25T10:00:00.000Z')
    expect(latestIso(null, Date.parse('2026-10-25T09:00:00.000Z'))).toBe('2026-10-25T09:00:00.000Z')
  })

  it('shows a Principia-run session once (as a Principia agent), skips bad lines and symlinks', () => {
    session('-work-acme', ID1, '/work/acme', [prompt('/work/acme', 'mine')])
    const f = session('-tmp', ID2, '/tmp', [prompt('/tmp', 'outside')])
    fs.appendFileSync(f, '{not json\n')
    fs.symlinkSync(f, path.join(root, '-tmp', `${ID3}.jsonl`))
    inHive.add(ID1)
    const a = make()
    const snap = a.open()
    expect(snap.sessions.map((s) => s.id)).toEqual([ID2])
    a.close()
  })

  it('tails only what was appended, throttled to one update per 2 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const f = session('-work-acme', ID1, '/work/acme', [prompt('/work/acme', 'go')])
    const a = make()
    a.open()
    const read = vi.spyOn(fs, 'readSync')
    fs.appendFileSync(f, line(toolUse('m9', 'Edit', { file_path: '/work/acme/src/login.ts' })))
    watchers[0]!.onChange(f)
    watchers[0]!.onChange(f)
    expect(emitted).toHaveLength(0)
    vi.advanceTimersByTime(THROTTLE_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.sessions[0]!.doing).toMatch(/login\.ts/)
    // one read of the appended bytes, not of the whole file
    const bytes = (read.mock.calls as unknown[][]).reduce((n, c) => n + (typeof c[3] === "number" ? Number(c[3]) : 0), 0)
    expect(bytes).toBeLessThan(fs.statSync(f).size)
    read.mockRestore()
    a.close()
  })

  it('close stops the watcher and the timers; an expired lease does too', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    session('-work-acme', ID1, '/work/acme', [prompt('/work/acme', 'go')])
    const a = make()
    a.open()
    expect(a.watching).toBe(true)
    a.close()
    expect(watchers[0]!.closed).toBe(true)
    expect(a.watching).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    a.open()
    vi.advanceTimersByTime(120_000) // no renewal
    expect(watchers[1]!.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('history off: no sessions, no watcher', () => {
    session('-tmp', ID2, '/tmp', [prompt('/tmp', 'x')])
    const a = make({ enabled: () => false })
    const snap = a.open()
    expect(snap.disabled).toBe(true)
    expect(snap.sessions).toEqual([])
    expect(watchers).toHaveLength(0)
  })

  it('never writes under the roots (real native watcher, appends and a new session)', async () => {
    const f = session('-work-acme', ID1, '/work/acme', [prompt('/work/acme', 'go')])
    const a = make({ watch: undefined })
    // the watcher directly too, closed at the end
    const w = await nativeWatch([root], () => undefined)
    a.open()
    await new Promise((r) => setTimeout(r, 300))
    // what Claude Code would write; take the picture after, then use the canvas again
    fs.appendFileSync(f, line(toolUse('m1', 'Read', { file_path: '/work/acme/a.ts' })))
    session('-tmp', ID2, '/tmp', [prompt('/tmp', 'new')])
    const before = snapshotTree(root)
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 800))
    a.open()
    a.flushNow()
    a.close()
    await w.close()
    expect(snapshotTree(root)).toEqual(before)
    expect(emitted.at(-1)?.sessions.map((s) => s.id).sort()).toEqual([ID1, ID2].sort())
  })

  it('the native watcher brings a new session within about 3 s', async () => {
    const a = make({ watch: undefined })
    a.open()
    await new Promise((r) => setTimeout(r, 200))
    session('-work-acme', ID3, '/work/acme', [prompt('/work/acme', 'started in a terminal'), toolUse('m7', 'Grep', { pattern: 'login' })])
    const t0 = Date.now()
    while (!emitted.some((s) => s.sessions.some((x) => x.id === ID3)) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100))
    a.close()
    const hit = emitted.find((s) => s.sessions.some((x) => x.id === ID3))
    expect(hit?.sessions.find((x) => x.id === ID3)).toMatchObject({ companyId: 'co_acme', state: 'working' })
    expect(Date.now() - t0).toBeLessThan(3500)
  })
})
