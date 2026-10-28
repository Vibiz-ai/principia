/**
 * Backend tests for live agents (docs/LIVE.md, PO amendments A1-A10): schema v2 migration, memory default (A10),
 * LiveStore, tailer/bridge/hook script, hivemem ask_user (A4c/A5), SessionLive with recorded claude hook fixtures
 * (A1/A3/A4/A9), notification policy (A7), dashboard queries, tray model.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The engine exports these pure helpers from its index (CONTRACT §12.3); map them explicitly so this suite does not
// depend on the order the parallel builds land in.
vi.mock('../engine', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  const tracker = await import('../engine/live/tracker')
  const hooks = await import('../engine/live/hooks')
  const pty = await import('../engine/live/pty')
  return {
    ...real,
    createAgentTracker: real.createAgentTracker ?? tracker.createAgentTracker,
    normalizeHook: real.normalizeHook ?? hooks.normalizeHook,
    detectPtyPrompt: real.detectPtyPrompt ?? pty.detectPtyPrompt,
    ptyReplyKeys: real.ptyReplyKeys ?? pty.ptyReplyKeys
  }
})

import type { AgentNode, Ask } from '../../shared/live'
import type { Run } from '../../shared/types'
import { openDatabase, currentVersion, type DB } from '../db'
import { DDL_V1, SCHEMA_VERSION } from '../db/schema'
import { Store, DEFAULT_SETTINGS } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { EVENTS_PER_AGENT, LiveStore, filesInside } from '../db/liveStore'
import { JsonlTailer } from '../live/tailer'
import { createLiveBridge, hookCommandFor, shQuote, sweepLiveDirs } from '../live/bridge'
import { buildLine, runHook, shrinkPayload, FIELD_CAP } from '../live/hook'
import { buildHandlers } from '../memory/server/build'
import { dispatch, type Inflight } from '../memory/server/jsonrpc'
import { SessionLive, SessionLiveHub, isTerminalReport, screenMessage, type SessionLiveDeps } from '../live/sessionLive'
import { NeedsYouNotifier, type NotifyRequest } from '../live/asks'
import type { ChimeEvent } from '../chime'
import { activity, dashboard, localDay, markSeen, resolveSince } from '../live/dashboard'
import { trayMenuModel, trayTitle } from '../trayModel'
import type { LiveEmit } from '../live/apply'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d = nativeOk ? describe : describe.skip

const FIX = path.join(__dirname, '../engine/__tests__/fixtures')
const fixture = (name: string): unknown[] =>
  fs
    .readFileSync(path.join(FIX, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
const wrap = (payload: unknown) => ({ v: 1, provider: 'claude', received_at: new Date().toISOString(), payload })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-live-'))
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function agent(over: Partial<AgentNode> = {}): AgentNode {
  const ts = new Date().toISOString()
  const id = over.id ?? `ag_${Math.random().toString(36).slice(2, 12)}`
  return {
    id,
    kind: 'session',
    parentId: null,
    rootId: id,
    sessionId: null,
    runId: null,
    stepId: null,
    provider: 'claude',
    repoId: null,
    cwd: '/tmp',
    title: 'root',
    agentType: null,
    externalId: null,
    toolUseId: null,
    model: null,
    depth: 0,
    background: false,
    attribution: 'exact',
    status: 'working',
    needs: null,
    seen: false,
    activity: null,
    lastTool: null,
    toolCount: 0,
    memReads: 0,
    filesTouched: [],
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    modelUsage: null,
    report: null,
    startedAt: ts,
    updatedAt: ts,
    endedAt: null,
    ...over
  }
}
function ask(over: Partial<Ask> & Pick<Ask, 'agentId' | 'rootId'>): Ask & { gateId: string } {
  return {
    id: `ask_${Math.random().toString(36).slice(2, 12)}`,
    sessionId: null,
    runId: null,
    stepId: null,
    provider: 'claude',
    kind: 'permission',
    channel: 'stdio',
    title: 'Bash npm test',
    detail: null,
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    question: null,
    options: [
      { id: 'allow', label: 'Allow once', kind: 'allow' },
      { id: 'deny', label: 'Deny', kind: 'deny' }
    ],
    status: 'open',
    answer: null,
    answeredVia: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    expiresAt: null,
    gateId: 'g1',
    ...over
  }
}

// ---------------------------------------------------------------------------------------------------------------
d('schema v2 migration', () => {
  it('migrates a v1 db: live tables, skip_slot_at, schedule_events accepts skipped and keeps rows', () => {
    const file = path.join(tmp, 'hive.db')
    const raw = new Database(file)
    raw.exec(DDL_V1)
    raw.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run()
    raw.prepare("INSERT INTO schedules(id, name, target_json, when_json, created_at, updated_at) VALUES ('sch_a', 'n', '{}', '{}', 'x', 'x')").run()
    raw.prepare("INSERT INTO schedule_events(id, schedule_id, kind, slot_at, created_at) VALUES ('sev_a', 'sch_a', 'fired', 's', 'c')").run()
    raw.close()
    const db = openDatabase(file)
    expect(currentVersion(db)).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(2)
    for (const t of ['agents', 'agent_events', 'asks'])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy()
    const cols = (db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('skip_slot_at')
    expect(db.prepare("SELECT kind FROM schedule_events WHERE id='sev_a'").get()).toEqual({ kind: 'fired' })
    db.prepare("INSERT INTO schedule_events(id, schedule_id, kind, slot_at, created_at) VALUES ('sev_b', 'sch_a', 'skipped', 's', 'c')").run()
    db.close()
    const again = openDatabase(file) // idempotent
    expect(currentVersion(again)).toBe(2)
    again.close()
  })

  it('A10: fresh DB defaults sessionMemory to read-write; an explicit off survives other saves', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    expect(DEFAULT_SETTINGS.sessionMemory).toBe('read-write')
    expect(store.getSettings().sessionMemory).toBe('read-write')
    store.updateSettings({ sessionMemory: 'off' })
    store.updateSettings({ terminalFontSize: 15 }) // patch-only: does not rewrite sessionMemory
    expect(store.getSettings().sessionMemory).toBe('off')
    const keys = (db.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key).sort()
    expect(keys).toEqual(['sessionMemory', 'terminalFontSize'])
    db.close()
  })

  it('schedule skip_slot_at is mapped and settable through the EngineStore', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    const id = store.insertSchedule({ name: 'x', target: { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'hi' }, when: { kind: 'at', at: '2030-01-01T00:00:00Z' } })
    const es = createEngineStore(db, { describe: () => () => '' })
    expect(es.setScheduleFireState(id, { skipSlotAt: '2030-01-01T00:00:00.000Z' }).skipSlotAt).toBe('2030-01-01T00:00:00.000Z')
    expect(store.getSchedule(id)!.skipSlotAt).toBe('2030-01-01T00:00:00.000Z')
    db.close()
  })
})

// ---------------------------------------------------------------------------------------------------------------
d('LiveStore', () => {
  let db: DB
  let live: LiveStore
  beforeEach(() => {
    db = openDatabase(':memory:')
    live = new LiveStore(db, (s) => s.replaceAll('sk-secret-1234', '••••KEY'))
  })
  afterEach(() => db.close())

  it('redacts on write, keeps terminal statuses final, lists trees', () => {
    const r = live.insertAgent(agent({ title: 'uses sk-secret-1234', activity: 'x'.repeat(300) }))
    expect(r.title).toBe('uses ••••KEY')
    expect(r.activity!.length).toBe(120)
    const c = live.insertAgent(agent({ id: 'ag_child00001', kind: 'subagent', parentId: r.id, rootId: r.id, depth: 1 }))
    expect(live.tree(r.id).map((a) => a.id)).toEqual([r.id, c.id])
    expect(live.descendants(r.id).map((a) => a.id)).toEqual([c.id])
    live.updateAgent(c.id, { status: 'done' })
    expect(live.updateAgent(c.id, { status: 'working', activity: 'late' }).status).toBe('done') // late hook never reopens
    expect(live.liveTrees().length).toBe(2)
  })

  it('caps events at 500 per agent but never drops ask/answer rows; updates tool rows by toolUseId', () => {
    const r = live.insertAgent(agent())
    live.appendAgentEvents(r.id, [{ ts: '', kind: 'ask', toolUseId: null, name: null, summary: 'ask', detail: null, state: null }])
    const many = Array.from({ length: EVENTS_PER_AGENT + 20 }, (_, i) => ({ ts: '', kind: 'tool' as const, toolUseId: `t${i}`, name: 'Bash', summary: `Bash ${i}`, detail: null, state: 'running' as const }))
    live.appendAgentEvents(r.id, many)
    const all = live.listEvents(r.id, { limit: 1000 })
    expect(all.length).toBe(EVENTS_PER_AGENT)
    expect(all.some((e) => e.kind === 'ask')).toBe(true)
    const up = live.updateAgentEvent(r.id, `t${EVENTS_PER_AGENT + 19}`, { state: 'ok', detail: 'done sk-secret-1234' })
    expect(up?.state).toBe('ok')
    expect(up?.detail).toBe('done ••••KEY')
  })

  it('CHAT-UI.md §8.4: a tool event keeps its description (redacted) through its result', () => {
    const r = live.insertAgent(agent())
    live.appendAgentEvents(r.id, [{ ts: '', kind: 'tool', toolUseId: 'tu_d', name: 'Bash', summary: 'Bash npm test', detail: '{"command":"npm test"}', state: 'running', description: 'Run the tests with sk-secret-1234' }])
    const up = live.updateAgentEvent(r.id, 'tu_d', { state: 'ok', detail: '42 passed' })
    expect(up).toMatchObject({ detail: '42 passed', description: 'Run the tests with ••••KEY' })
    expect(live.listEvents(r.id)[0]!.description).toBe('Run the tests with ••••KEY')
  })

  it('asks: open list, cancel a root tree (A4a), boot recovery, needs-you count (A3)', () => {
    const r = live.insertAgent(agent({ sessionId: 's_aaaaaaaaaa' }))
    live.insertAsk(ask({ agentId: r.id, rootId: r.id, sessionId: 's_aaaaaaaaaa' }))
    expect(live.openAskCount()).toBe(1)
    live.updateAgent(r.id, { status: 'needs_you', needs: 'idle', seen: false })
    expect(live.needsYouCount()).toBe(2)
    live.updateAgent(r.id, { seen: true })
    expect(live.needsYouCount()).toBe(1) // seen idle stays needs_you for Reply but is not counted
    const canceled = live.cancelOpenAsksForRoot(r.id)
    expect(canceled[0].status).toBe('canceled')
    live.insertAsk(ask({ id: 'ask_zzzzzzzzzz', agentId: r.id, rootId: r.id }))
    expect(live.bootRecover()).toEqual({ agents: 1, asks: 1 })
    expect(live.getAgent(r.id)!.status).toBe('failed')
    expect(live.getAgent(r.id)!.activity).toBe('Hive quit')
  })

  it('memReads sums the tree of a step', () => {
    const r = live.insertAgent(agent({ kind: 'step', stepId: 'st_aaaaaaaaaa', memReads: 2 }))
    live.insertAgent(agent({ kind: 'subagent', parentId: r.id, rootId: r.id, stepId: 'st_aaaaaaaaaa', memReads: 3 }))
    expect(live.memReads({ stepId: 'st_aaaaaaaaaa' })).toBe(5)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('tailer, bridge, hook script', () => {
  it('tails JSONL with partial lines and drops bad lines once', () => {
    const f = path.join(tmp, 'e.jsonl')
    fs.writeFileSync(f, '')
    const lines: unknown[] = []
    const bad: string[] = []
    const t = new JsonlTailer(f, { onLine: (l) => lines.push(l), onBadLine: (b) => bad.push(b), pollMs: 10_000 })
    t.start()
    fs.appendFileSync(f, '{"a":1}\n\n{"b":')
    t.read()
    expect(lines).toEqual([{ a: 1 }])
    fs.appendFileSync(f, '2}\nnot json\nnope\n{"é":"ü"}\n')
    t.read()
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { é: 'ü' }])
    expect(bad.length).toBe(1)
    t.close()
  })

  it('bridge: 0700 dir, quoted hook command, queued lines, atomic answers, close removes the dir', async () => {
    const userData = path.join(tmp, 'User Data')
    const bridge = createLiveBridge({ userData, execPath: '/Applications/Hive.app/Contents/MacOS/Hive', hookScript: "/x/it's/hive-hook.js", pollMs: 20 })
    const ch = bridge.open({ sessionId: 's_abcdefghij' })
    expect(fs.statSync(ch.dir).mode & 0o777).toBe(0o700)
    expect(ch.hookCommand).toBe(hookCommandFor('/Applications/Hive.app/Contents/MacOS/Hive', "/x/it's/hive-hook.js", ch.dir))
    expect(ch.hookCommand).toContain(shQuote(path.join(ch.dir, 'events.jsonl')))
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(ch.mcpEnv).toEqual({ HIVE_LIVE_DIR: ch.dir })
    fs.appendFileSync(path.join(ch.dir, 'events.jsonl'), '{"x":1}\n')
    await sleep(60)
    const got: unknown[] = []
    ch.onLine((l) => got.push(l)) // lines that arrived before the consumer attached are replayed
    expect(got).toEqual([{ x: 1 }])
    ch.writeAnswer('ask_1234567890', { answer: 'yes' })
    expect(JSON.parse(fs.readFileSync(path.join(ch.dir, 'answers', 'ask_1234567890.json'), 'utf8'))).toEqual({ answer: 'yes' })
    expect(() => ch.writeAnswer('../evil', {})).toThrow()
    ch.close()
    expect(fs.existsSync(ch.dir)).toBe(false)
    bridge.open({ stepId: 'st_abcdefghij', runId: 'r_abcdefghij' })
    expect(sweepLiveDirs(userData)).toBe(1)
  })

  it('hook script: one envelope line with truncated big fields; gate waits for the answer file', async () => {
    const events = path.join(tmp, 'events.jsonl')
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: 'x'.repeat(5000) }, prompt: 'p' }
    const stdin = new PassThrough()
    const out: string[] = []
    const p = runHook(['--events', events, '--dir', tmp, '--provider', 'claude'], { stdin, stdout: { write: (s) => out.push(s) } })
    stdin.end(JSON.stringify(payload))
    expect(await p).toBe(0)
    const line = JSON.parse(fs.readFileSync(events, 'utf8').trim())
    expect(line).toMatchObject({ v: 1, provider: 'claude', payload: { hook_event_name: 'PostToolUse', tool_name: 'Read' } })
    expect(line.payload.tool_response.content.length).toBe(FIELD_CAP + 1)
    expect(out).toEqual([]) // observational: prints nothing
    expect(shrinkPayload('str')).toEqual({ raw: 'str' })
    expect(buildLine({ events, dir: null, provider: 'gemini', gate: false }, {}, null)).toMatch(/"provider":"gemini"/)

    // gate (headless gemini/cursor behind HOOKS_VERIFIED): blocks until answers/<gate_id>.json
    fs.writeFileSync(events, '')
    const stdin2 = new PassThrough()
    const out2: string[] = []
    const p2 = runHook(['--events', events, '--dir', tmp, '--provider', 'gemini', '--gate'], { stdin: stdin2, stdout: { write: (s) => out2.push(s) } })
    stdin2.end('{"hook_event_name":"BeforeTool","tool_name":"run_shell_command"}')
    await sleep(100)
    const gateId = JSON.parse(fs.readFileSync(events, 'utf8').trim()).gate_id
    expect(gateId).toMatch(/^gate_/)
    fs.writeFileSync(path.join(tmp, 'answers', `${gateId}.json`), '{"decision":"deny","reason":"no"}')
    await p2
    expect(JSON.parse(out2.join(''))).toEqual({ decision: 'deny', reason: 'no' })
    expect(fs.readFileSync(events, 'utf8')).toContain('"gate_closed"')
  })

  it('hook script never fails: bad stdin and missing args exit 0', async () => {
    const s = new PassThrough()
    const p = runHook(['--events', path.join(tmp, 'no', 'such', 'dir', 'e.jsonl')], { stdin: s, stdout: { write: () => 0 } })
    s.end('{oops')
    expect(await p).toBe(0)
    expect(await runHook([], { stdin: new PassThrough(), stdout: { write: () => 0 } })).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('hivemem ask_user (LIVE.md §4.2, A2/A4c/A5)', () => {
  const call = (h: ReturnType<typeof buildHandlers>['handlers'], msg: object, inflight: Inflight = new Map()) => dispatch(h, { jsonrpc: '2.0', ...msg }, inflight)

  it('memory off: lists only ask_user, never opens memory.db, answers server/discover and ping', async () => {
    const built = buildHandlers({ HIVE_MEM_DB: path.join(tmp, 'nope', 'memory.db'), HIVE_MEM_GRANT: '', HIVE_LIVE_DIR: tmp })
    const list = (await call(built.handlers, { id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['ask_user'])
    expect(built.db).toBeNull()
    expect(await call(built.handlers, { id: 2, method: 'server/discover' })).toMatchObject({ result: {} })
    const noLive = buildHandlers({ HIVE_MEM_GRANT: '' })
    expect(((await call(noLive.handlers, { id: 3, method: 'tools/list' })) as { result: { tools: unknown[] } }).result.tools).toEqual([])
  })

  it('blocks on the answer file (ping still answered), returns { answer }', async () => {
    fs.writeFileSync(path.join(tmp, 'events.jsonl'), '')
    const { handlers } = buildHandlers({ HIVE_MEM_GRANT: '', HIVE_LIVE_DIR: tmp })
    const p = call(handlers, {
      id: 7,
      method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: 'Which DB?', options: ['sqlite', 'pg'] }, _meta: { 'claudecode/toolUseId': 'toolu_1' } }
    }) as Promise<{ result: { structuredContent: { answer: string } } }>
    expect(p).toBeInstanceOf(Promise)
    expect(await call(handlers, { id: 8, method: 'ping' })).toMatchObject({ id: 8, result: {} })
    await sleep(30)
    const line = JSON.parse(fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8').trim())
    expect(line).toMatchObject({ hive: 'ask_user', question: 'Which DB?', options: ['sqlite', 'pg'], allow_text: true, agent_hint: 'toolu_1' })
    expect(line.gate_id).toMatch(/^ask_[0-9a-z]{10}$/)
    fs.writeFileSync(path.join(tmp, 'answers', `${line.gate_id}.json`), JSON.stringify({ answer: 'sqlite' }))
    expect((await p).result.structuredContent).toEqual({ answer: 'sqlite' })
  })

  it('A4c: notifications/cancelled appends ask_user_cancelled and sends no response', async () => {
    fs.writeFileSync(path.join(tmp, 'events.jsonl'), '')
    const { handlers } = buildHandlers({ HIVE_MEM_GRANT: '', HIVE_LIVE_DIR: tmp })
    const inflight: Inflight = new Map()
    const p = call(handlers, { id: 'req-1', method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Go?' } } }, inflight)
    await sleep(20)
    expect(await call(handlers, { method: 'notifications/cancelled', params: { requestId: 'req-1' } }, inflight)).toBeNull()
    expect(await p).toBeNull()
    const lines = fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[1]).toEqual({ hive: 'ask_user_cancelled', gate_id: lines[0].gate_id })
    expect(inflight.size).toBe(0)
  })

  it('A5: a 5-minute wait does not error (server side waits up to 3600 s)', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(path.join(tmp, 'events.jsonl'), '')
    const { handlers } = buildHandlers({ HIVE_MEM_GRANT: '', HIVE_LIVE_DIR: tmp })
    let settled = false
    const p = (call(handlers, { id: 1, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Wait?' } } }) as Promise<unknown>).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(settled).toBe(false)
    const gate = JSON.parse(fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8').trim()).gate_id
    fs.writeFileSync(path.join(tmp, 'answers', `${gate}.json`), '{"answer":"later"}')
    await vi.advanceTimersByTimeAsync(300)
    expect(await p).toMatchObject({ result: { structuredContent: { answer: 'later' } } })
  })
})

// ---------------------------------------------------------------------------------------------------------------
d('SessionLive with recorded claude hooks (A1, A3, A4, A9)', () => {
  let db: DB
  let live: LiveStore
  let emitted: LiveEmit[]
  let writes: string[]
  let visible: boolean
  let idles: number[]
  const PROMPT_SCREEN = '\x1b[1mBash command\x1b[0m\r\n  curl -s https://example.com\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n'

  const deps = (): SessionLiveDeps => ({
    store: live,
    emit: (e) => emitted.push(e),
    writePty: (_id, data) => writes.push(data),
    isVisible: () => visible,
    onIdle: (_r, turnMs) => idles.push(turnMs)
  })
  const session = { id: 's_aaaaaaaaaa', adapter: 'claude' as const, repoId: null, cwd: '/tmp/hive-fx/pty', title: 'pty · Claude' }

  beforeEach(() => {
    db = openDatabase(':memory:')
    live = new LiveStore(db)
    emitted = []
    writes = []
    visible = false
    idles = []
  })
  afterEach(() => db.close())

  it('permission fixture opens one pty ask (Allow/Deny/Open terminal, no allow_always); A9 guarded reply writes "1"', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    s.applier.flush()
    const asks = live.listOpenAsks({ sessionId: session.id })
    expect(asks.length).toBe(1)
    expect(asks[0].channel).toBe('pty')
    expect(asks[0].options.map((o) => o.kind)).toEqual(['allow', 'deny', 'focus'])
    expect(asks[0].options.some((o) => o.kind === 'allow_always')).toBe(false)
    expect(live.getAgent(s.root.id)!.status).toBe('needs_you')
    // A9: prompt not on screen -> conflict, resolved answered/terminal, no keys
    expect(() => s.answer(asks[0], { askId: asks[0].id, optionId: 'allow' })).toThrow(/prompt changed/)
    expect(writes).toEqual([])
    expect(live.getAsk(asks[0].id)).toMatchObject({ status: 'answered', answeredVia: 'terminal' })
  })

  it('a chat turn that ended with no Stop hook settles the root idle with its last words; never twice', () => {
    const s = new SessionLive(deps(), session, null)
    s.chatWorking()
    expect(live.getAgent(s.root.id)!.status).toBe('working')
    expect(s.chatTurnEnded('Pushed. The menu is live.')).toBe(true)
    expect(live.getAgent(s.root.id)).toMatchObject({ status: 'needs_you', needs: 'idle', report: 'Pushed. The menu is live.' })
    // the hook got there first: nothing changes, its report stays
    expect(s.chatTurnEnded(null)).toBe(false)
    expect(live.getAgent(s.root.id)!.report).toBe('Pushed. The menu is live.')
  })

  it('A9: with the dialog on screen, Allow writes "1" and the ask is answered via hive', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    s.onPtyData(PROMPT_SCREEN)
    const a = live.listOpenAsks({ sessionId: session.id })[0]
    const r = s.answer(a, { askId: a.id, optionId: 'allow' })
    expect(writes).toEqual(['1'])
    expect(r).toMatchObject({ status: 'answered', answeredVia: 'hive', answer: { optionId: 'allow' } })
    expect(() => s.answer(r, { askId: a.id, optionId: 'deny' })).toThrow(/Already answered/)
  })

  it('A4b: a user keystroke resolves the pty ask as answered in the terminal; focus reports do not', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    s.onUserInput('\x1b[I')
    expect(live.openAskCount()).toBe(1)
    s.onUserInput('1')
    expect(live.openAskCount()).toBe(0)
    expect(live.listAsks({ status: 'all' })[0]).toMatchObject({ status: 'answered', answeredVia: 'terminal' })
  })

  // xterm emits these by itself: focus reports, replies to the agent's terminal queries (re-run when the pane mounts,
  // resizes or replays its scrollback), and empty bracketed-paste markers. None is the user answering.
  const XTERM_GENERATED = [
    '\x1b[I',
    '\x1b[O',
    '\x1b[?1;2c', // DA1
    '\x1b[>0;276;0c', // DA2
    '\x1b[12;40R', // cursor position
    '\x1b[?12;40;1R', // DECXCPR
    '\x1b[0n', // DSR ok
    '\x1b[?2004;1$y', // DECRPM
    '\x1b[?0u', // kitty keyboard flags
    '\x1b[8;32;120t', // window size
    '\x1b]11;rgb:1717/1818/1b1b\x1b\\', // OSC 11 background color
    '\x1b]10;rgb:e6e6/e6e6/e9e9\x07', // OSC 10, BEL-terminated
    '\x1bP>|xterm.js(6.0.0)\x1b\\', // XTVERSION
    '\x1bP1$r0m\x1b\\', // DECRQSS
    '\x1b[200~\x1b[201~', // empty paste markers
    '\x1b[I\x1b[?1;2c\x1b[12;40R', // several in one chunk (mount + replay)
    '\x1b[<0;10;5M\x1b[<0;10;5m' // a click (mouse report)
  ]

  it('isTerminalReport: terminal-generated chunks only; keys and pastes are input', () => {
    for (const r of XTERM_GENERATED) expect(isTerminalReport(r)).toBe(true)
    for (const k of ['1', 'y', '\r', '\x1b', '\x1b[A', '\x1bOA', '\x03', 'hello\r', '\x1b[200~ls -la\x1b[201~', '\x1b[I1']) expect(isTerminalReport(k)).toBe(false)
  })

  it('A4b: opening, focusing, resizing or replaying the pane never answers a pty ask; a real keystroke does', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    s.onPtyData(PROMPT_SCREEN)
    for (const r of XTERM_GENERATED) s.onUserInput(r, true)
    // anything the renderer marks as not typed (no key/paste/IME just before) never counts either
    s.onUserInput('1', false)
    s.applier.flush()
    expect(live.openAskCount()).toBe(1)
    expect(live.getAgent(s.root.id)).toMatchObject({ status: 'needs_you', needs: 'permission' })
    // the dialog is still on screen, so a hub reply still passes the A9 guard
    const a = live.listOpenAsks({ sessionId: session.id })[0]
    expect(s.answer(a, { askId: a.id, optionId: 'allow' })).toMatchObject({ status: 'answered', answeredVia: 'hive' })
    expect(writes).toEqual(['1'])
  })

  it('A4b: a typed key or a real paste resolves the pty ask as answered in the terminal', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    s.onUserInput('\x1b[200~go\x1b[201~', true)
    expect(live.openAskCount()).toBe(0)
    expect(live.listAsks({ status: 'all' })[0]).toMatchObject({ status: 'answered', answeredVia: 'terminal' })
  })

  it('idle: focus/replay replies keep "Your turn"; the root carries the last assistant message; a new prompt clears it', async () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-idle.jsonl')) s.onLine(wrap(l))
    await sleep(0)
    for (const r of XTERM_GENERATED) s.onUserInput(r)
    s.applier.flush()
    expect(live.getAgent(s.root.id)).toMatchObject({ status: 'needs_you', needs: 'idle', report: 'Done.' })
    expect(live.needsYouCount()).toBe(1)
    // the hook says the agent resumed: the old message no longer describes what it waits for
    s.onLine(wrap({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }))
    s.applier.flush()
    expect(live.getAgent(s.root.id)).toMatchObject({ status: 'working', report: null })
  })

  it('idle: with no hook text, the cleaned screen tail is what the agent said', async () => {
    const s = new SessionLive(deps(), session, null)
    s.onLine(wrap({ hook_event_name: 'SessionStart', source: 'startup' }))
    s.onLine(wrap({ hook_event_name: 'UserPromptSubmit', prompt: 'pick one' }))
    s.onPtyData('\x1b[2K\x1b[1G⏺ \x1b[1mWhich database\x1b[0m should I use: Postgres or SQLite?\r\n\r\n╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n  ? for shortcuts\r\n')
    s.onLine(wrap({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] }))
    await sleep(0)
    s.applier.flush()
    expect(live.getAgent(s.root.id)).toMatchObject({ needs: 'idle', report: 'Which database should I use: Postgres or SQLite?' })
    // later root updates while it still waits keep the message
    s.onLine(wrap({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
    s.applier.flush()
    expect(live.getAgent(s.root.id)!.report).toBe('Which database should I use: Postgres or SQLite?')
  })

  it('screenMessage drops TUI chrome and keeps the last lines', () => {
    expect(screenMessage('')).toBeNull()
    expect(screenMessage('│ > │\r\n? for shortcuts\r\n')).toBeNull()
    expect(screenMessage('a line\r\n' + Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\r\n'), 3)).toBe('line 9\nline 10\nline 11')
  })

  it('A3: idle while unseen counts and notifies; becoming visible marks it seen; Reply types text then submits', async () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-idle.jsonl')) s.onLine(wrap(l))
    await sleep(0)
    const r = live.getAgent(s.root.id)!
    expect(r).toMatchObject({ needs: 'idle', status: 'needs_you', seen: false })
    expect(live.needsYouCount()).toBe(1)
    expect(idles.length).toBe(1)
    visible = true
    s.visibilityChanged()
    expect(live.getAgent(s.root.id)!.seen).toBe(true)
    expect(live.needsYouCount()).toBe(0)
    s.reply('next please')
    await sleep(60)
    expect(writes).toEqual(['next please', '\r'])
    expect(live.getAgent(s.root.id)!.needs).toBeNull()
    expect(() => s.reply('again')).toThrow(/not waiting/)
  })

  it('REMOTE: a phone message while it works goes in as one paste, then Enter; the hook names its transcript', async () => {
    const s = new SessionLive(deps(), session, null)
    const [start, prompt] = fixture('claude-hooks-pty-idle.jsonl')
    s.onLine(wrap(start))
    s.onLine(wrap(prompt))
    expect(live.getAgent(s.root.id)!.status).toBe('working')
    expect(s.transcriptPath).toMatch(/\/\.claude\/projects\/-tmp-hive-fx-pty\/cf55e463-2d7f-40b6-8914-7a293e693b05\.jsonl$/)
    s.type('also check the footer\nthanks')
    await sleep(60)
    expect(writes).toEqual(['\x1b[200~also check the footer\nthanks\x1b[201~', '\r'])
  })

  it('REMOTE: a choice that opens between the paste and its Enter keeps the Enter back, and says so', async () => {
    const warned: string[] = []
    const timers: (() => void)[] = []
    const d = { ...deps(), setTimer: (fn: () => void) => (timers.push(fn), timers.length), clearTimer: () => {}, log: { warn: (m: string) => warned.push(m) } }
    const c = new SessionLive(d, { ...session, adapter: 'codex' }, null)
    c.onPtyData('\x1b[5;1H› Ask Codex to do anything')
    c.type('carry on')
    // a Codex approval (no hook) draws its menu before the Enter goes
    c.onPtyData('\x1b[1;3HAllow command?\x1b[3;1H› 1. Yes\x1b[4;3H2. No')
    for (const t of timers) t()
    expect(writes).toEqual(['\x1b[200~carry on\x1b[201~'])
    expect(warned.join('\n')).toMatch(/not sent/)
    // the session ended in that window: no Enter either
    const e = new SessionLive(d, { ...session, id: 's_eeeeeeeeee' }, null)
    timers.length = 0
    e.type('one more')
    e.exit(0, false)
    for (const t of timers) t()
    expect(writes).toEqual(['\x1b[200~carry on\x1b[201~', '\x1b[200~one more\x1b[201~'])
  })

  it('REMOTE: a phone message never goes into a dialog: an open ask or a prompt on screen refuses it', async () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    expect(live.listOpenAsks({ sessionId: session.id }).length).toBe(1)
    expect(() => s.type('carry on')).toThrow(/asking you something/)
    const t = new SessionLive(deps(), { ...session, id: 's_bbbbbbbbbb' }, null)
    t.onPtyData(PROMPT_SCREEN)
    expect(() => t.type('carry on')).toThrow(/asking you something in the terminal/)
    // any CLI's numbered menu (Codex's trust question has no card): Enter would pick its first option
    const c = new SessionLive(deps(), { ...session, id: 's_cccccccccc', adapter: 'codex' }, null)
    c.onPtyData('\x1b[1;3HTrust this folder?\x1b[3;1H› 1. Trust and continue\x1b[4;3H2. Quit')
    expect(c.typeHeld()).toMatch(/showing a choice/)
    expect(() => c.type('carry on')).toThrow(/showing a choice/)
    // its composer is not a menu
    const ok = new SessionLive(deps(), { ...session, id: 's_dddddddddd', adapter: 'codex' }, null)
    ok.onPtyData('\x1b[5;1H› Ask Codex to do anything')
    expect(ok.typeHeld()).toBeNull()
    await sleep(60)
    expect(writes).toEqual([])
  })

  it('A3: a turn that ends while the pane is visible is never counted', async () => {
    visible = true
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-pty-idle.jsonl')) s.onLine(wrap(l))
    await sleep(0)
    expect(live.getAgent(s.root.id)).toMatchObject({ needs: 'idle', seen: true })
    expect(live.needsYouCount()).toBe(0)
    expect(idles).toEqual([])
  })

  it('subagent fixture: one node per subagent, tools attributed to it; root ends done on SessionEnd', () => {
    const s = new SessionLive(deps(), session, null)
    for (const l of fixture('claude-hooks-headless-subagent-bg.jsonl')) s.onLine(wrap(l))
    s.applier.flush()
    const tree = live.tree(s.root.id)
    const subs = tree.filter((a) => a.kind === 'subagent')
    expect(subs.length).toBe(1)
    expect(subs[0]).toMatchObject({ externalId: 'a41fea0a96b41269b', agentType: 'general-purpose', parentId: s.root.id, depth: 1 })
    expect(live.listEvents(subs[0].id).some((e) => e.name === 'Read')).toBe(true)
    expect(['done', 'canceled']).toContain(live.getAgent(s.root.id)!.status)
    expect(emitted.some((e) => e.type === 'agent.updated')).toBe(true)
  })

  it('A4a: PTY exit cancels every open ask of the tree and ends the root (failed on non-zero exit)', () => {
    const hub = new SessionLiveHub(deps())
    const s = hub.open(session, null)!
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) s.onLine(wrap(l))
    expect(live.openAskCount()).toBe(1)
    hub.exited(session.id, 1, false)
    expect(live.openAskCount()).toBe(0)
    expect(live.listAsks({ status: 'all' })[0].status).toBe('canceled')
    expect(live.getAgent(s.root.id)!.status).toBe('failed')
    expect(hub.get(session.id)).toBeNull()
    // a killed-by-Hive session ends done
    const s2 = hub.open({ ...session, id: 's_bbbbbbbbbb' }, null)!
    hub.exited('s_bbbbbbbbbb', null, true)
    expect(live.getAgent(s2.root.id)!.status).toBe('done')
  })

  it('gemini: answering from Hive does not reopen a phantom ask from the stale tail; turn end stays Reply', () => {
    const timers: Array<() => void> = []
    const g = { ...session, id: 's_gggggggggg', adapter: 'gemini' as const }
    const s = new SessionLive({ ...deps(), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} }, g, null)
    const quiet = () => timers.splice(0).forEach((f) => f())
    const gl = (p: unknown) => ({ v: 1, provider: 'gemini', received_at: new Date().toISOString(), payload: p })
    const notif = fixture('gemini-hooks-events.jsonl').find((l) => (l as { notification_type?: string }).notification_type === 'ToolPermission')
    s.onLine(gl(notif))
    const DIALOG = "Shell npm test -- auth\r\nAllow execution of: 'npm'?\r\n● 1. Allow once\r\n  2. Allow for this session\r\n  3. No, suggest changes (esc)\r\n"
    s.onPtyData(DIALOG)
    quiet()
    expect(live.openAskCount()).toBe(1)
    const a = live.listOpenAsks({ sessionId: g.id })[0]
    s.answer(a, { askId: a.id, optionId: 'allow' })
    expect(writes).toEqual(['\r'])
    // the TUI redraws a little (spinner text) but the old dialog bytes would still be in a raw tail
    s.onPtyData('Running npm test...\r\n')
    quiet()
    expect(live.openAskCount()).toBe(0)
    // without hooks having been seen, the screen still re-detects a *new* dialog drawn after the reply
    s.onLine(gl({ hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'done' }))
    s.onPtyData(DIALOG)
    quiet()
    expect(live.openAskCount()).toBe(0) // gemini hooks work: permission asks come only from Notification
    expect(live.getAgent(s.root.id)).toMatchObject({ needs: 'idle' })
  })

  it('cursor: model text quoting "Run this command?" opens no ask; a real dialog does, and Deny re-checks the screen', () => {
    const timers: Array<() => void> = []
    const c = { ...session, id: 's_cccccccccc', adapter: 'cursor' as const }
    const s = new SessionLive({ ...deps(), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} }, c, null)
    const quiet = () => timers.splice(0).forEach((f) => f())
    s.onPtyData('I will first check: Run this command? npm test\r\n\r\n→ Add a follow-up\r\n')
    quiet()
    expect(live.openAskCount()).toBe(0)
    s.onPtyData('$ npm test\r\nRun this command?\r\n → Run (once) (y)\r\n   Skip & tell the agent what to do instead (esc or n)\r\n')
    quiet()
    const a = live.listOpenAsks({ sessionId: c.id })[0]
    expect(a).toBeTruthy()
    s.answer(a, { askId: a.id, optionId: 'deny' })
    expect(writes).toEqual(['n'])
    quiet()
    s.onPtyData('Skipped.\r\n')
    quiet()
    expect(live.openAskCount()).toBe(0)
    // the user typing resolves a screen ask and the old dialog never comes back from the tail
    s.onPtyData('$ rm -rf build\r\nRun this command?\r\n → Run (once) (y)\r\n   Skip (esc or n)\r\n')
    quiet()
    expect(live.openAskCount()).toBe(1)
    s.onUserInput('y')
    s.onPtyData('ok\r\n')
    quiet()
    expect(live.openAskCount()).toBe(0)
  })

  it('reads hook lines through a real LiveChannel', async () => {
    const bridge = createLiveBridge({ userData: tmp, execPath: '/x', hookScript: '/y', pollMs: 20 })
    const ch = bridge.open({ sessionId: session.id })
    const s = new SessionLive(deps(), session, ch)
    for (const l of fixture('claude-hooks-pty-permission.jsonl')) fs.appendFileSync(path.join(ch.dir, 'events.jsonl'), JSON.stringify(wrap(l)) + '\n')
    await sleep(80)
    expect(live.openAskCount()).toBe(1)
    s.exit(0, false)
    expect(fs.existsSync(ch.dir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('NeedsYouNotifier (A7)', () => {
  const mk = (over: { focused?: boolean; visible?: { sessionId: string | null; runId: string | null } } = {}) => {
    vi.useFakeTimers()
    const sent: NotifyRequest[] = []
    const chimes: ChimeEvent[] = []
    const open = new Set<string>()
    let t = 0
    const n = new NeedsYouNotifier({
      notify: (r) => sent.push(r),
      chime: (e) => chimes.push(e),
      focused: () => over.focused ?? false,
      visible: () => over.visible ?? { sessionId: null, runId: null },
      rootTitle: () => 'repo · Claude',
      isOpen: (id) => open.has(id),
      now: () => t
    })
    const advance = (ms: number) => {
      t += ms
      vi.advanceTimersByTime(ms)
    }
    const a = (id: string, root = 'ag_root') => {
      open.add(id)
      return ask({ id, agentId: root, rootId: root, sessionId: 's_aaaaaaaaaa', title: `t-${id}` })
    }
    return { n, sent, chimes, open, advance, a }
  }

  it('no notification for an ask resolved within 3 s', () => {
    const { n, sent, open, advance, a } = mk()
    n.askOpened(a('ask_1'))
    advance(1000)
    open.delete('ask_1')
    advance(3000)
    expect(sent).toEqual([])
  })

  it('bursts coalesce into "n things need you"; at most one per root per 30 s', () => {
    const { n, sent, advance, a } = mk()
    n.askOpened(a('ask_1'))
    n.askOpened(a('ask_2'))
    advance(3000)
    expect(sent).toEqual([{ title: 'repo · Claude needs you', body: '2 things need you', agentId: 'ag_root', chime: { kind: 'needs', key: 'ask:ask_1' } }])
    n.askOpened(a('ask_3'))
    advance(5000)
    expect(sent.length).toBe(1)
    advance(25_000)
    expect(sent.length).toBe(2)
    expect(sent[1].body).toBe('t-ask_3')
  })

  it('suppressed when the window is focused on the owner', () => {
    const { n, sent, advance, a } = mk({ focused: true, visible: { sessionId: 's_aaaaaaaaaa', runId: null } })
    n.askOpened(a('ask_1'))
    advance(4000)
    expect(sent).toEqual([])
  })

  it('expired asks are grouped per run; idle rules', () => {
    const { n, sent, advance } = mk()
    for (const id of ['ask_1', 'ask_2', 'ask_3'])
      n.askResolved(ask({ id, agentId: 'ag_x', rootId: 'ag_x', runId: 'r_aaaaaaaaaa', status: 'expired', answeredVia: 'timeout' }))
    advance(2500)
    expect(sent.length).toBe(1)
    expect(sent[0].body).toBe('Hive denied 3 requests after 60 min')
    n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 5000)
    expect(sent.length).toBe(1) // turn < 20 s
    n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 25_000)
    n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 25_000)
    expect(sent.length).toBe(2) // <= 1 per session per 60 s
    expect(sent[1].chime).toMatchObject({ kind: 'done' })
  })

  it('SOUNDS.md: a long turn ending while the window is focused elsewhere is a sound alone; never while its chat is on screen', () => {
    const elsewhere = mk({ focused: true, visible: { sessionId: 's_other', runId: null } })
    elsewhere.n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 5000)
    expect(elsewhere.chimes).toEqual([]) // short turn
    elsewhere.n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 25_000)
    expect(elsewhere.sent).toEqual([]) // focused: no notification (A7)
    expect(elsewhere.chimes).toMatchObject([{ kind: 'done' }])
    elsewhere.n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 25_000)
    expect(elsewhere.chimes.length).toBe(1) // the idle cooldown holds for the sound too
    const looking = mk({ focused: true, visible: { sessionId: 's_1', runId: null } })
    looking.n.idle({ id: 'ag_s', sessionId: 's_1', title: 'x' }, 25_000)
    expect(looking.chimes).toEqual([])
    expect(looking.sent).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
d('dashboard (F5)', () => {
  it('run cards sum reported cost/tokens and files; activity per day; morning brief; since clamp', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    const live = new LiveStore(db)
    const es = createEngineStore(db, { describe: () => () => '' })
    const now = new Date()
    const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()
    const run = (id: string, status: Run['status']): Run => ({
      id,
      kind: 'prompt',
      title: id,
      target: { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' },
      workflowId: null,
      scheduleId: null,
      parentRunId: null,
      trigger: 'manual',
      status,
      reason: null,
      createdAt: iso(3600_000),
      startedAt: iso(3600_000),
      endedAt: iso(1800_000),
      artifactsDir: `/a/${id}/`,
      artifactCount: 0
    })
    es.insertRun(run('r_aaaaaaaaaa', 'passed'), null)
    es.insertRun(run('r_bbbbbbbbbb', 'failed'), null)
    es.insertStep({
      id: 'st_bbbbbbbbbb', runId: 'r_bbbbbbbbbb', seq: 1, nodeId: 'build', nodeType: 'agent', attempt: 1, round: null, profileId: null,
      participantLabel: null, adapter: 'claude', cwd: '/', prompt: '', output: null, verdict: null, exitCode: 1, pid: null,
      status: 'failed', error: 'boom\nmore', sourceStepIds: [], agentSessionId: null, logPath: '/l', startedAt: null, endedAt: null
    })
    live.insertAgent(agent({ kind: 'step', runId: 'r_aaaaaaaaaa', status: 'done', costUsd: 0.5, tokensIn: 100, tokensOut: 50, filesTouched: ['a.ts', 'b.ts'], modelUsage: { 'claude-opus': { tokensIn: 100, tokensOut: 50, costUsd: 0.5 } }, startedAt: iso(3600_000) }))
    live.insertAgent(agent({ kind: 'step', runId: 'r_aaaaaaaaaa', status: 'done', provider: 'gemini', model: 'gemini-pro', tokensIn: 10, tokensOut: 5, filesTouched: ['b.ts', 'c.ts', '/tmp/c.ts', '/Users/me/.claude/projects/-tmp/memory/fact.md', '/a/r_aaaaaaaaaa/morning-brief-2026.md', '../up.ts', '~/x.md'], startedAt: iso(3600_000) }))
    store.upsertArtifact({ runId: 'r_aaaaaaaaaa', sessionId: null, path: '/a/r_aaaaaaaaaa/morning-brief-2026.md', relPath: 'r/morning-brief-2026.md', name: 'morning-brief-2026.md', kind: 'markdown', mime: 'text/markdown', bytes: 10, mtime: iso(0) })
    const dsh = dashboard({ store, live, status: () => ({ runningSessions: 0, runningRuns: 0, queuedRuns: 0, schedulesPaused: false, nextFire: null, last24h: { passed: 1, failed: 1 }, unseenFailures: 0, needsYou: 0 }), nextRuns: () => [] })
    const card = dsh.done.find((c) => c.run.id === 'r_aaaaaaaaaa')!
    expect(card.costUsd).toBe(0.5) // gemini reported no cost: not estimated
    expect(card.tokens).toEqual({ in: 110, out: 55 })
    expect(card.filesChanged).toBe(4) // a, b, c, /tmp/c.ts; ~/.claude memory, ARTIFACTS_DIR, ../ dropped
    expect(card.files).not.toContain('/a/r_aaaaaaaaaa/morning-brief-2026.md')
    expect(filesInside('/repo', ['x.ts', '/repo/y.ts', '/repo', '/repox/z.ts', '/Users/me/.claude/a.md', '../w.ts', 'a/../../v.ts'])).toEqual(['x.ts', '/repo/y.ts'])
    expect(card.durationMs).toBe(1800_000)
    expect(dsh.done.find((c) => c.run.id === 'r_bbbbbbbbbb')!.failedStep).toEqual({ stepId: 'st_bbbbbbbbbb', nodeId: 'build', error: 'boom' })
    expect(dsh.morningBrief?.name).toBe('morning-brief-2026.md')
    const today = dsh.activity.days.find((x) => x.date === localDay(iso(3600_000)))!
    expect(dsh.activity.days.length).toBe(14)
    expect(today).toMatchObject({ runs: 2, passed: 1, failed: 1, costUsd: 0.5 })
    expect(today.byModel.map((m) => m.model).sort()).toEqual(['claude-opus', 'gemini-pro'])
    expect(dsh.activity.successRate).toBe(0.5)
    expect(activity({ store, live, status: () => dsh.status, nextRuns: () => [] }, now).days.length).toBe(14)
    // since: last seen, clamped to 7 days
    expect(resolveSince(undefined, null, now)).toBe(new Date(now.getTime() - 86400_000).toISOString())
    expect(resolveSince('2000-01-01T00:00:00Z', null, now)).toBe(new Date(now.getTime() - 7 * 86400_000).toISOString())
    markSeen(store, now)
    expect(dashboard({ store, live, status: () => dsh.status, nextRuns: () => [] }).lastSeenAt).toBe(now.toISOString())
    db.close()
  })
})

describe('tray model (LIVE.md §4.5)', () => {
  it('title shows ⚑ k and the menu lists Needs you rows', () => {
    const base = { runningSessions: 1, runningRuns: 0, queuedRuns: 0, schedulesPaused: false, nextFire: null, last24h: { passed: 0, failed: 0 }, unseenFailures: 0, needsYou: 2 }
    expect(trayTitle(base)).toBe('● 1 ⚑ 2')
    const items = trayMenuModel({ status: base, running: [], lastFailure: null, recentRepos: [], now: new Date(), needsYou: [{ agentId: 'ag_1', label: 'repo: Bash' }] })
    expect(items[2]).toMatchObject({ label: 'Needs you' })
    expect(items[3]).toMatchObject({ action: { kind: 'focusAgent', agentId: 'ag_1' } })
  })
})
