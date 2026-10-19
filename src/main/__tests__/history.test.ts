/**
 * Claude history (AUTHORING.md §8; PO9) against fixture dirs only (HIVE_CLAUDE_DIRS-style roots, never ~/.claude):
 * titles (custom > ai > prompt), turns, subagents, in-Hive filter, read-only (mtime + content unchanged), symlinks
 * ignored, incremental by (size, mtime), fast on hundreds of files.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { ClaudeHistory, historyRoots } from '../history'
import { readTranscript } from '../history/transcript'

let root: string
let db: DB
let changed: number[]
let inHive: Set<string>

const line = (o: unknown) => `${JSON.stringify(o)}\n`
function writeSession(dir: string, id: string, opts: { prompt: string; ai?: string; custom?: string; turns?: number; when?: string; subagents?: number }): string {
  const when = opts.when ?? new Date().toISOString()
  fs.mkdirSync(dir, { recursive: true })
  let s = line({ type: 'permission-mode', sessionId: id })
  s += line({ type: 'user', cwd: '/tmp/proj', gitBranch: 'main', version: '2.1.289', entrypoint: 'cli', timestamp: when, promptSource: 'typed', message: { role: 'user', content: '<command-name>/clear</command-name>' } })
  s += line({ type: 'user', cwd: '/tmp/proj', timestamp: when, promptSource: 'typed', message: { role: 'user', content: [{ type: 'text', text: opts.prompt }] } })
  s += line({ type: 'assistant', timestamp: when, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } })
  s += line({ type: 'user', timestamp: when, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } })
  for (let i = 1; i < (opts.turns ?? 1); i++) s += line({ type: 'user', timestamp: when, promptSource: 'typed', message: { content: `more ${i}` } })
  if (opts.ai) s += line({ type: 'ai-title', aiTitle: opts.ai, sessionId: id })
  if (opts.custom) s += line({ type: 'custom-title', customTitle: opts.custom, sessionId: id })
  const f = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(f, s)
  for (let i = 0; i < (opts.subagents ?? 0); i++) {
    const sd = path.join(dir, id, 'subagents')
    fs.mkdirSync(sd, { recursive: true })
    fs.writeFileSync(path.join(sd, `agent-${i}.jsonl`), line({ type: 'user', message: { content: 'x' } }) + line({ type: 'assistant', message: { content: [] } }))
    fs.writeFileSync(path.join(sd, `agent-${i}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'look around' }))
  }
  return f
}

const history = () =>
  new ClaudeHistory({
    db,
    roots: () => historyRoots({ HIVE_CLAUDE_DIRS: root }),
    enabled: () => true,
    inHiveIds: () => inHive,
    repoIdForCwd: (c) => (c === '/tmp/proj' ? 'repo_0000000001' : null),
    redact: (s) => s.replace('sk-live-123', '••••KEY'),
    emitChanged: (n) => changed.push(n),
    schedule: (fn) => fn()
  })

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-hist-')))
  db = openDatabase(':memory:')
  changed = []
  inHive = new Set()
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Claude history index', () => {
  it('indexes titles, turns, subagents; filters in-Hive; never writes the files', () => {
    const p = path.join(root, '-tmp-proj')
    const a = writeSession(p, '11111111-aaaa-bbbb-cccc-000000000001', { prompt: 'fix the login bug with sk-live-123', turns: 3, subagents: 2 })
    writeSession(p, '11111111-aaaa-bbbb-cccc-000000000002', { prompt: 'p2', ai: 'AI title' })
    writeSession(p, '11111111-aaaa-bbbb-cccc-000000000003', { prompt: 'p3', ai: 'AI', custom: 'My title' })
    writeSession(p, '11111111-aaaa-bbbb-cccc-000000000004', { prompt: 'old', when: '2020-01-01T00:00:00.000Z' })
    const before = fs.statSync(a).mtimeMs
    const hash = crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex')
    // a symlink pointing outside the root is ignored
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-out-'))
    writeSession(outside, '22222222-aaaa-bbbb-cccc-000000000001', { prompt: 'outside' })
    fs.symlinkSync(outside, path.join(root, 'linked'))
    const h = history()
    const res = h.list({})
    expect(res.total).toBe(3) // the 2020 one is older than 7 days
    const one = res.items.find((s) => s.id.endsWith('01'))!
    expect(one).toMatchObject({ title: 'fix the login bug with ••••KEY', titleSource: 'prompt', turns: 3, subagents: 2, cwd: '/tmp/proj', repoId: 'repo_0000000001', gitBranch: 'main', model: 'claude-opus-5-5', inHive: false })
    expect(res.items.find((s) => s.id.endsWith('02'))).toMatchObject({ title: 'AI title', titleSource: 'ai' })
    expect(res.items.find((s) => s.id.endsWith('03'))).toMatchObject({ title: 'My title', titleSource: 'custom' })
    expect(h.list({ since: '2019-01-01T00:00:00.000Z' }).total).toBe(4)
    inHive = new Set(['11111111-aaaa-bbbb-cccc-000000000002'])
    expect(h.list({}).items.map((s) => s.id)).not.toContain('11111111-aaaa-bbbb-cccc-000000000002')
    expect(h.list({ includeInHive: true }).total).toBe(3)
    expect(fs.statSync(a).mtimeMs).toBe(before)
    expect(crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex')).toBe(hash)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('transcript preview: typed prompts, assistant text, tool lines, tool errors, subagents', () => {
    const f = writeSession(path.join(root, 'p'), '33333333-aaaa-bbbb-cccc-000000000001', { prompt: 'hello there', subagents: 1 })
    const h = history()
    h.refresh()
    const s = h.byId('33333333-aaaa-bbbb-cccc-000000000001')!
    expect(h.isInsideRoot(s.path)).toBe(true)
    expect(h.isInsideRoot('/etc/passwd')).toBe(false)
    const t = readTranscript(s, (x) => x)
    expect(t.entries.map((e) => e.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(t.entries[0].text).toBe('hello there')
    expect(t.entries[3].text).toMatch(/Tool error: boom/)
    expect(t.subagents).toEqual([{ file: 'agent-0.jsonl', agentType: 'Explore', description: 'look around', messages: 2 }])
    expect(fs.existsSync(f)).toBe(true)
  })

  it('is incremental by (size, mtime) and drops vanished files', () => {
    const p = path.join(root, 'p')
    const f = writeSession(p, '44444444-aaaa-bbbb-cccc-000000000001', { prompt: 'x' })
    const h = history()
    expect(h.refresh().queued).toBe(1)
    expect(h.refresh().queued).toBe(0)
    fs.appendFileSync(f, line({ type: 'ai-title', aiTitle: 'Renamed' }))
    expect(h.refresh().queued).toBe(1)
    expect(h.byId('44444444-aaaa-bbbb-cccc-000000000001')?.title).toBe('Renamed')
    fs.rmSync(f)
    h.refresh()
    expect(h.byId('44444444-aaaa-bbbb-cccc-000000000001')).toBeNull()
  })

  it('is fast on hundreds of files (warm list well under 300 ms)', () => {
    for (let d = 0; d < 10; d++) for (let i = 0; i < 50; i++) writeSession(path.join(root, `proj-${d}`), `55555555-aaaa-bbbb-${String(d).padStart(4, '0')}-${String(i).padStart(12, '0')}`, { prompt: `p ${i}` })
    const h = history()
    h.list({ limit: 500 })
    const t0 = performance.now()
    const r = h.list({ limit: 500 })
    expect(performance.now() - t0).toBeLessThan(300)
    expect(r.total).toBe(500)
  })
})
