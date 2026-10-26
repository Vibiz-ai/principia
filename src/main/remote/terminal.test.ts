/**
 * REMOTE.md RA3 "a terminal on the phone": a terminal session's transcript (Claude Code's, or a Codex rollout) read as
 * the same chat items a chat sends, live while a phone looks, its screen when there is no transcript, and finding the
 * rollout of a Codex terminal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatItem, ChatToolItem } from '@shared/chat'
import { ChatReducer } from '@shared/chatReduce'
import type { PhoneServerMsg } from '@shared/remote'
import type { Session } from '@shared/types'
import { CodexTranscript, codexOutput, patchFiles } from './transcript'
import { TerminalFeeds, terminalTurn, transcriptItems, type PhoneTerminalHost } from './terminalFeed'
import { findCodexRollout, terminalHost } from './terminalHost'
import { renderScreen } from '../live/screen'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// a key-shaped string, built here so no key-like literal sits in the repo
const FAKE_KEY = ['sk', 'ant', 'x'.repeat(32)].join('-')
const redact = (s: string): string => s.split(FAKE_KEY).join('[redacted]')

const claude = {
  user: (text: string) => ({ type: 'user', timestamp: '2026-10-26T10:00:00.000Z', message: { role: 'user', content: text } }),
  say: (id: string, text: string) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] } }),
  tool: (id: string, tid: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: tid, name, input }] } }),
  result: (tid: string, content: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] } })
}
const codex = {
  meta: (cwd: string, at: string) => ({ timestamp: at, type: 'session_meta', payload: { id: 'th_1', timestamp: at, cwd, originator: 'codex_cli_rs', cli_version: '0.1.0' } }),
  msg: (role: string, text: string) => ({ timestamp: '2026-10-26T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } }),
  call: (call_id: string, name: string, args: Record<string, unknown>) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id } }),
  out: (call_id: string, output: string) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id, output } }),
  patch: (call_id: string, input: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input, call_id, status: 'completed' } }),
  patchOut: (call_id: string, output: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output } }),
  done: (ms: number) => ({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: ms, last_agent_message: 'Done' } })
}

function fold(records: unknown[]): ChatItem[] {
  const r = new ChatReducer({ idPrefix: 't' })
  const c = new CodexTranscript()
  for (const rec of records) for (const x of c.records(rec)) r.line(x)
  return r.model.items
}

describe('a Codex rollout as chat items', () => {
  it('the person, the answer, a command with its result, a patch per file and the turn end; never Codex’s own context', () => {
    const items = fold([
      codex.meta('/tmp/shop', '2026-10-26T10:00:00.000Z'),
      codex.msg('developer', '<permissions instructions>sandbox</permissions instructions>'),
      codex.msg('user', '# AGENTS.md instructions for /tmp/shop\n\nbe brief'),
      codex.msg('user', '<environment_context><cwd>/tmp/shop</cwd></environment_context>'),
      codex.msg('user', 'Fix the footer'),
      codex.call('c1', 'exec_command', { cmd: "/bin/zsh -lc 'git status --short'" }),
      codex.out('c1', 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n M footer.html\n'),
      codex.call('c2', 'shell', { command: ['bash', '-lc', 'npm test'] }),
      codex.out('c2', JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 } })),
      codex.patch('c3', '*** Begin Patch\n*** Update File: footer.html\n@@\n-<p>old</p>\n+<p>new</p>\n+<p>more</p>\n*** Add File: notes.md\n+hello\n*** End Patch'),
      codex.patchOut('c3', 'Success. Updated the following files:\nM footer.html\nA notes.md'),
      codex.msg('assistant', 'Fixed the footer.'),
      codex.done(4200)
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'text', 'turnEnd'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Fix the footer' })
    const tools = items.filter((i): i is ChatToolItem => i.kind === 'tool')
    expect(tools[0]).toMatchObject({ name: 'Bash', input: { command: 'git status --short' }, status: 'ok', resultText: ' M footer.html\n' })
    expect(tools[1]).toMatchObject({ name: 'Bash', input: { command: 'npm test' }, status: 'error', resultText: '1 failing' })
    expect(tools[2]).toMatchObject({ name: 'Edit', input: { file_path: 'footer.html', old_string: '<p>old</p>', new_string: '<p>new</p>\n<p>more</p>' }, status: 'ok' })
    expect(tools[3]).toMatchObject({ name: 'Write', input: { file_path: 'notes.md', content: 'hello' }, status: 'ok' })
    expect(items[5]).toMatchObject({ kind: 'text', md: 'Fixed the footer.' })
    expect(items[6]).toMatchObject({ kind: 'turnEnd', ms: 4200, files: [{ path: 'footer.html', add: 2, del: 1 }, { path: 'notes.md', add: 1, del: 0 }] })
  })
  it('a stopped turn reads as stopped; the plan reads as the plan card; MCP tools keep their server', () => {
    const items = fold([
      codex.call('p1', 'update_plan', { plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] }),
      codex.call('m1', 'list_issues', { team: 'web' }),
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ])
    expect(items[0]).toMatchObject({ name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] } })
    expect(items[1]).toMatchObject({ name: 'list_issues', status: 'interrupted' })
    expect(items[2]).toMatchObject({ kind: 'notice' })
    expect(fold([{ type: 'response_item', payload: { type: 'function_call', name: 'search', namespace: 'linear', arguments: '{}', call_id: 'x' } }])[0]).toMatchObject({ name: 'mcp__linear__search' })
  })
  it('its code-mode exec tool reads as the command it runs, with the command’s own output', () => {
    const items = fold([
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: 'text(await tools.exec_command({cmd:"ls -1",max_output_tokens:1000}));\n' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'e1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ chunk_id: 'x', exit_code: 0, output: 'README.md\nsrc\n' }) }] } }
    ])
    expect(items[0]).toMatchObject({ name: 'Bash', input: { command: 'ls -1' }, status: 'ok', resultText: 'README.md\nsrc\n' })
  })
  it('outputs and patches read plainly', () => {
    expect(codexOutput('Exit code: 2\nOutput:\nboom')).toEqual({ text: 'boom', error: true })
    expect(codexOutput('plain text')).toEqual({ text: 'plain text', error: false })
    expect(patchFiles('*** Delete File: old.txt')).toEqual([{ name: 'Edit', input: { file_path: 'old.txt', old_string: '', new_string: '' } }])
  })
})

describe('the root as a chat turn', () => {
  it('working, waiting on you, your turn, ended', () => {
    expect(terminalTurn({ status: 'working', needs: null }, false)).toBe('working')
    expect(terminalTurn({ status: 'needs_you', needs: 'permission' }, false)).toBe('needs')
    expect(terminalTurn({ status: 'needs_you', needs: 'idle' }, false)).toBe('idle')
    expect(terminalTurn({ status: 'done', needs: null }, false)).toBe('ended')
    expect(terminalTurn(null, true)).toBe('ended')
  })
})

describe('TerminalFeeds (a terminal session shown live on the phone)', () => {
  let dir: string
  let pushed: { sid: string; m: PhoneServerMsg }[]
  let wanted: Set<string>
  let now: number
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-term-'))
    pushed = []
    wanted = new Set()
    now = 1_000_000
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const sess = (x: Partial<Session> = {}): Session => ({ id: 'se_t', companyId: 'co_a', title: 'shop · Claude', adapter: 'claude', status: 'running', startedAt: '2026-10-26T10:00:00.000Z', endedAt: null, repoId: null, cwd: dir, agentSessionId: 'conv-1', ...x }) as unknown as Session
  const host = (o: { file?: () => string | null; screen?: () => string | null; held?: () => string | null } = {}): PhoneTerminalHost => ({
    transcript: () => {
      const f = o.file?.() ?? null
      return f ? { file: f, format: 'claude' } : null
    },
    screen: () => o.screen?.() ?? null,
    type: () => undefined,
    ...(o.held ? { held: o.held } : {}),
    redact
  })
  const feeds = (h: PhoneTerminalHost) => new TerminalFeeds({ host: h, push: (sid, m) => pushed.push({ sid, m }), wanted: () => wanted, now: () => now, tickMs: null, pollMs: 20 })
  const write = (file: string, recs: unknown[]) => fs.appendFileSync(file, recs.map((r) => JSON.stringify(r) + '\n').join(''))

  it('opens with the transcript so far as chat items, then sends what the agent writes as numbered ops (redacted)', async () => {
    const file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('Fix the footer'), claude.say('msg_1', 'Looking at it.')])
    const f = feeds(host({ file: () => file }))
    const v = f.open(sess(), 'working', 'Reading files')
    expect(v.source).toBe('transcript')
    expect(v.chat).toMatchObject({ mode: 'terminal', available: false, turn: 'working', seq: 0 })
    expect(v.chat.items.map((i) => i.kind)).toEqual(['user', 'text'])
    write(file, [claude.tool('msg_2', 'toolu_1', 'Bash', { command: `echo ${FAKE_KEY}` })])
    await sleep(200)
    write(file, [claude.result('toolu_1', 'ok'), claude.say('msg_3', 'Done.')])
    f.check()
    await sleep(200)
    const chats = pushed.filter((p) => p.m.t === 'chat').map((p) => p.m as Extract<PhoneServerMsg, { t: 'chat' }>)
    expect(chats.map((c) => c.seq)).toEqual([1, 2])
    const all = JSON.stringify(chats)
    expect(all).not.toContain(FAKE_KEY)
    expect(all).toContain('[redacted]')
    expect(chats[1]!.ops.some((o) => o.op === 'patch' && (o.set as { status?: string }).status === 'ok')).toBe(true)
    // the header follows the root
    f.state('se_t', 'idle', null)
    await sleep(120)
    expect(pushed.at(-1)!.m).toMatchObject({ t: 'chat', seq: 3, ops: [{ op: 'state', turn: 'idle', activity: null }] })
    f.dispose()
  })

  it('no transcript yet: the screen, live; once the transcript appears every phone takes a fresh view', () => {
    let screen = 'Thinking about the footer'
    let file: string | null = null
    const f = feeds(host({ file: () => file, screen: () => screen }))
    const v = f.open(sess(), 'working', null)
    expect(v).toMatchObject({ source: 'screen', screen: 'Thinking about the footer', chat: { items: [], seq: 0 } })
    wanted.add('se_t')
    screen = `Editing footer.html ${FAKE_KEY}`
    f.check()
    expect(pushed.at(-1)!.m).toEqual({ t: 'screen', sessionId: 'se_t', text: 'Editing footer.html [redacted]' })
    f.check()
    expect(pushed.length).toBe(1)
    file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('Fix the footer')])
    f.check()
    // a numbered gap: the phone's replica refetches and gets the transcript
    expect(pushed.at(-1)!.m).toEqual({ t: 'chat', sessionId: 'se_t', seq: 2, ops: [] })
    expect(f.open(sess(), 'working', null)).toMatchObject({ source: 'transcript', chat: { seq: 2 } })
    f.dispose()
  })

  it('/clear moves Claude to a new transcript: the feed follows it and every phone takes a fresh view', async () => {
    let file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('Fix the footer'), claude.say('msg_1', 'Looking at it.')])
    const f = feeds(host({ file: () => file }))
    expect(f.open(sess(), 'idle', null).chat.items.map((i) => i.kind)).toEqual(['user', 'text'])
    wanted.add('se_t')
    const old = file
    file = path.join(dir, 'conv-2.jsonl')
    write(file, [claude.user('Now the header')])
    f.check()
    expect(pushed.at(-1)!.m).toEqual({ t: 'chat', sessionId: 'se_t', seq: 2, ops: [] })
    expect(f.open(sess(), 'idle', null)).toMatchObject({ source: 'transcript', chat: { seq: 2, items: [{ kind: 'user', text: 'Now the header' }] } })
    // the old file is no longer read; the new one is, live
    write(old, [claude.say('msg_old', 'stale')])
    write(file, [claude.say('msg_2', 'On it.')])
    f.check()
    await sleep(200)
    const last = JSON.stringify(pushed.filter((p) => p.m.t === 'chat').at(-1)!.m)
    expect(last).toContain('On it.')
    expect(JSON.stringify(pushed)).not.toContain('stale')
    f.dispose()
  })

  it('a second phone opening after /clear also moves the first one to the new transcript', () => {
    let file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('Fix the footer')])
    const f = feeds(host({ file: () => file }))
    f.open(sess(), 'idle', null)
    wanted.add('se_t')
    file = path.join(dir, 'conv-2.jsonl')
    write(file, [claude.user('Now the header')])
    // the second phone opens before the next tick: the first one is told to take a fresh view
    expect(f.open(sess(), 'idle', null).chat.items).toMatchObject([{ kind: 'user', text: 'Now the header' }])
    expect(pushed.at(-1)!.m).toMatchObject({ t: 'chat', sessionId: 'se_t', ops: [] })
    f.dispose()
  })

  it('a menu answered on the Mac (no ask says so) frees Send: a change in why it is held refetches the view', () => {
    const file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('hi')])
    let held: string | null = 'It is showing a choice in the terminal. Answer it on your Mac first.'
    const f = feeds(host({ file: () => file, held: () => held }))
    f.open(sess({ adapter: 'codex' }), 'idle', null)
    wanted.add('se_t')
    f.check()
    expect(pushed).toEqual([])
    held = null
    f.check()
    expect(pushed.at(-1)!.m).toEqual({ t: 'chat', sessionId: 'se_t', seq: 2, ops: [] })
    // the phone took the fresh view: nothing more until it changes again
    f.open(sess({ adapter: 'codex' }), 'idle', null)
    f.check()
    expect(pushed.length).toBe(1)
    held = 'It is showing a choice in the terminal. Answer it on your Mac first.'
    f.check()
    expect(pushed.at(-1)!.m).toMatchObject({ t: 'chat', seq: 4, ops: [] })
    f.dispose()
  })

  it('runs only while a phone looks (plus a grace), and an ended session sends a fresh view and stops', () => {
    const file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('hi')])
    const f = feeds(host({ file: () => file }))
    f.open(sess(), 'idle', null)
    wanted.add('se_t')
    now += 120_000
    f.check()
    expect(f.size()).toBe(1)
    wanted.clear()
    now += 29_000
    f.check()
    expect(f.size()).toBe(1)
    now += 2_000
    f.check()
    expect(f.size()).toBe(0)
    f.open(sess(), 'idle', null)
    f.ended('se_t')
    expect(f.size()).toBe(0)
    expect(pushed.at(-1)!.m).toMatchObject({ t: 'chat', seq: 2, ops: [] })
    f.dispose()
  })

  it('an ended session reads its history once: running tools stop, nothing stays open', () => {
    const file = path.join(dir, 'conv-1.jsonl')
    write(file, [claude.user('Fix it'), claude.tool('m1', 't1', 'Bash', { command: 'npm test' })])
    const items = transcriptItems({ file, format: 'claude' }, redact)
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool'])
    expect(items[1]).toMatchObject({ status: 'interrupted' })
  })
})

describe('the rollout of a Codex terminal', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-codex-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
  const rollout = (name: string, cwd: string, at: string, id = `th_${name}`) => {
    const d = new Date(at)
    const day = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    fs.mkdirSync(day, { recursive: true })
    const f = path.join(day, `rollout-${name}.jsonl`)
    const meta = codex.meta(cwd, at)
    fs.writeFileSync(f, JSON.stringify({ ...meta, payload: { ...meta.payload, id } }) + '\n')
    return f
  }
  const iso = (ms: number) => new Date(ms).toISOString()
  it('the earliest one begun in its folder at its start, not one taken by another session or begun before', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cwd-'))
    const start = Date.now() - 60_000
    rollout('old', cwd, iso(start - 3_600_000))
    rollout('elsewhere', os.tmpdir(), iso(start + 1_000))
    const mine = rollout('mine', cwd, iso(start + 2_000))
    const later = rollout('later', cwd, iso(start + 30_000))
    const s = { id: 's', cwd, startedAt: iso(start), endedAt: null }
    expect(findCodexRollout(home, s)).toBe(mine)
    expect(findCodexRollout(home, s, { sessions: [s, { ...s, id: 'other' }], claimed: new Map([[mine, 'other']]) })).toBe(later)
    expect(findCodexRollout(home, { ...s, cwd: path.join(cwd, 'nope') })).toBeNull()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('two sessions started in one folder seconds apart each get their own, whichever the phone opens first', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cwd-'))
    const start = Date.now() - 60_000
    const a = { id: 'a', adapter: 'codex', cwd, startedAt: iso(start), endedAt: null, agentSessionId: null } as unknown as Session
    const b = { ...a, id: 'b', startedAt: iso(start + 5_000) } as Session
    const ra = rollout('a', cwd, iso(start + 1_000))
    const rb = rollout('b', cwd, iso(start + 6_000))
    const all = [a, b]
    expect(findCodexRollout(home, b, { sessions: all })).toBe(rb)
    expect(findCodexRollout(home, a, { sessions: all })).toBe(ra)
    for (const first of [b, a]) {
      const host = terminalHost({ live: () => null, claudeFile: () => null, claudeRoots: () => [], codexHome: () => home, codexSessions: () => all, redact: (t) => t })
      const second = first === a ? b : a
      const want = (x: Session) => (x === a ? ra : rb)
      expect(host.transcript(first)?.file).toBe(want(first))
      expect(host.transcript(second)?.file).toBe(want(second))
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('a Codex chat keeps the rollout that carries its thread id, even when an earlier start would take it', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cwd-'))
    const start = Date.now() - 60_000
    const chat = { id: 'chat', cwd, startedAt: iso(start - 2_000), endedAt: null, agentSessionId: 'th_chat' }
    const term = { id: 'term', cwd, startedAt: iso(start), endedAt: null, agentSessionId: null }
    const mine = rollout('term', cwd, iso(start + 1_000))
    const chats = rollout('chat', cwd, iso(start + 4_000))
    expect(findCodexRollout(home, term, { sessions: [chat, term] })).toBe(mine)
    expect(findCodexRollout(home, chat, { sessions: [chat, term] })).toBe(chats)
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})

describe('what a terminal shows, as plain lines', () => {
  it('replays cursor moves onto a grid: a TUI that places each word reads as its lines', () => {
    const raw = '\x1b[?1049h\x1b[2J\x1b[1;1HTrust\x1b[1;7Hthis\x1b[1;12Hfolder?\x1b[3;3H\x1b[1m› 1. Trust and continue\x1b[0m\x1b[4;5H2. Quit\x1b]0;title\x07'
    expect(renderScreen(raw)).toBe('Trust this folder?\n\n  › 1. Trust and continue\n    2. Quit')
  })
  it('erases, carriage returns and redraws keep only what is on screen; the last lines are kept', () => {
    expect(renderScreen('Working 1s\rWorking 2s\x1b[K\r\nDone\x1b[2K\rAll done')).toBe('Working 2s\nAll done')
    expect(renderScreen('old\x1b[2J\x1b[Hnew')).toBe('new')
    expect(renderScreen(Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\r\n'), 3)).toBe('line 77\nline 78\nline 79')
  })
})
