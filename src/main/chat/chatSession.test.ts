import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { ChatSession, type ChatSessionDeps } from './chatSession'
import type { ChildLike } from './streamProc'
import type { PtyLike } from '../sessions'
import type { ChatOp, ChatPermissionItem } from '../../shared/chat'

/** A fake `claude -p` child: records stdin lines, lets the test write stdout lines. */
class FakeChild extends EventEmitter implements ChildLike {
  static next = 5000
  pid = FakeChild.next++
  lines: Record<string, unknown>[] = []
  ended = false
  exitOnEnd = true
  killed: string | null = null
  args: string[] = []
  private out = new EventEmitter()
  private err = new EventEmitter()
  stdout = { on: (ev: 'data', cb: (d: string) => void) => this.out.on(ev, cb) }
  stderr = { on: (ev: 'data', cb: (d: string) => void) => this.err.on(ev, cb) }
  warn(t: string): void {
    this.err.emit('data', t)
  }
  stdin = {
    write: (d: string): boolean => {
      for (const l of d.split('\n').filter(Boolean)) this.lines.push(JSON.parse(l) as Record<string, unknown>)
      return true
    },
    end: (): void => {
      this.ended = true
      // claude -p finishes and exits when stdin closes
      if (this.exitOnEnd) queueMicrotask(() => this.exit(0))
    }
  }
  say(o: unknown): void {
    this.out.emit('data', `${JSON.stringify(o)}\n`)
  }
  /** answer our pending control request of this subtype */
  reply(subtype: string, response: Record<string, unknown> = {}): void {
    const req = [...this.lines].reverse().find((l) => l.type === 'control_request' && (l.request as { subtype: string }).subtype === subtype)
    if (!req) throw new Error(`no ${subtype} request`)
    this.say({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } })
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }
  kill(signal?: string): boolean {
    this.killed = signal ?? 'SIGTERM'
    queueMicrotask(() => this.exit(null, this.killed))
    return true
  }
  users(): string[] {
    return this.lines.filter((l) => l.type === 'user').map((l) => {
      const c = (l.message as { content: unknown }).content
      return typeof c === 'string' ? c : JSON.stringify(c)
    })
  }
}

class FakePty implements PtyLike {
  static next = 9000
  pid = FakePty.next++
  written: string[] = []
  private dataCb: ((d: string) => void)[] = []
  private exitCb: ((e: { exitCode: number }) => void)[] = []
  constructor(readonly args: string[]) {}
  onData(cb: (d: string) => void): unknown {
    this.dataCb.push(cb)
    return {}
  }
  onExit(cb: (e: { exitCode: number }) => void): unknown {
    this.exitCb.push(cb)
    return {}
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {
    this.exit(0)
  }
  data(d: string): void {
    for (const c of this.dataCb) c(d)
  }
  exit(code: number): void {
    for (const c of this.exitCb.splice(0)) c({ exitCode: code })
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(over: Partial<ChatSessionDeps> = {}, args = ['--settings', 's.json', '--session-id', 'conv-1', '--permission-mode', 'default', '--append-system-prompt', 'SYS']) {
  const children: FakeChild[] = []
  const ptys: FakePty[] = []
  const ops: ChatOp[] = []
  const asks: { open: string[]; closed: [string, string | null][] } = { open: [], closed: [] }
  const killed: [number, string][] = []
  const timers: { fn: () => void; ms: number }[] = []
  const s = new ChatSession({
    sessionId: 'session_1',
    file: '/bin/claude',
    interactiveArgs: args,
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
    mode: 'chat',
    spawnPty: (_f, a) => {
      const p = new FakePty(a)
      ptys.push(p)
      return p
    },
    spawnChild: (_f, a) => {
      const c = new FakeChild()
      c.args = a
      children.push(c)
      return c
    },
    killGroup: (pid, sig) => {
      killed.push([pid, sig])
      const c = children.find((x) => x.pid === pid)
      if (c) c.kill(sig)
      const p = ptys.find((x) => x.pid === pid)
      if (p) queueMicrotask(() => p.exit(0))
      return !!(c || p)
    },
    emit: (o) => ops.push(...o),
    asks: { open: (e) => asks.open.push(e.requestId), close: (rid, sum) => asks.closed.push([rid, sum]) },
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as { fn: () => void; ms: number })
      if (i >= 0) timers.splice(i, 1)
    },
    ...over
  })
  return { s, children, ptys, ops, asks, killed, timers }
}

async function ready(c: FakeChild): Promise<void> {
  c.reply('initialize', { commands: [{ name: 'compact', description: 'Compact' }], models: [{ value: 'opus', displayName: 'Opus' }], current_permission_mode: 'default', account: { email: 'x@y.z', subscriptionType: 'Claude Max' } })
  await flush()
}

describe('ChatSession (CHAT-UI.md §3)', () => {
  it('spawns claude -p with stream flags, initializes, and never forwards the account email', async () => {
    const { s, children, ops } = setup()
    const c = children[0]!
    expect(c.lines[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    await ready(c)
    expect(s.turn).toBe('idle')
    expect(s.meta.plan).toBe('Claude Max')
    expect(JSON.stringify(ops)).not.toContain('x@y.z')
    expect(s.meta.commands[0]!.name).toBe('compact')
  })

  it('sends, holds follow-ups while working, then sends them together after the turn', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('first')
    expect(c.users()).toEqual(['first'])
    expect(s.turn).toBe('working')
    await s.send('second')
    await s.send('third')
    expect(s.queue.map((q) => q.text)).toEqual(['second', 'third'])
    s.editQueued(s.queue[1]!.id, 'third, edited')
    c.say({ type: 'result', subtype: 'success', duration_ms: 10 })
    await flush()
    expect(c.users()).toEqual(['first', 'second\n\nthird, edited'])
    expect(s.queue).toEqual([])
  })

  it('a permission request opens a Needs-you ask; Always allow sends the CLI suggestion back and closes it', async () => {
    const { s, children, asks } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('go')
    c.say({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'git push' } }] } })
    const sug = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'localSettings' }
    c.say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 'tu', permission_suggestions: [sug] } })
    await flush()
    expect(s.turn).toBe('needs')
    expect(asks.open).toEqual(['r1'])
    const perm = s.items.find((i): i is ChatPermissionItem => i.kind === 'permission')!
    expect(perm.suggestions[0]!.label).toBe('Always allow `git push` here')
    s.answer('r1', { kind: 'allowAlways', suggestion: 0 })
    const resp = c.lines.find((l) => l.type === 'control_response')!
    expect(resp).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'git push' }, updatedPermissions: [sug] } } })
    expect(asks.closed[0]![0]).toBe('r1')
    expect(asks.closed[0]![1]).toContain('Always allowed')
    expect(s.turn).toBe('working')
    expect(() => s.answer('r1', { kind: 'allow' })).toThrow(/Already answered/)
  })

  it('Deny with a note tells Claude what to do instead', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    c.say({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/a' } } })
    await flush()
    s.answer('r2', { kind: 'deny', message: 'use staging' })
    expect(c.lines.find((l) => l.type === 'control_response')).toMatchObject({ response: { response: { behavior: 'deny', message: 'use staging' } } })
  })

  it('a question card answers AskUserQuestion with the chosen labels', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    const input = { questions: [{ question: 'Which plan?', options: [{ label: 'Pro' }, { label: 'Team' }] }] }
    c.say({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } })
    await flush()
    s.answer('q', { kind: 'answer', answers: { 'Which plan?': 'Pro' } })
    expect(c.lines.find((l) => l.type === 'control_response')).toMatchObject({ response: { response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which plan?': 'Pro' } } } } })
  })

  it('Stop interrupts the turn; the process stays and open asks expire as denied', async () => {
    const { s, children, asks } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('long')
    c.say({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
    await flush()
    const p = s.interrupt()
    expect(c.lines.some((l) => l.type === 'control_response' && (l.response as { request_id: string }).request_id === 'r3')).toBe(true)
    c.reply('interrupt', { still_queued: [] })
    await p
    expect(asks.closed.map((x) => x[0])).toContain('r3')
    c.say({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    c.say({ type: 'result', subtype: 'error_during_execution' })
    await flush()
    expect(s.turn).toBe('idle')
    expect(children.length).toBe(1)
    expect(s.items.some((i) => i.kind === 'notice' && i.text.startsWith('Stopped'))).toBe(true)
  })

  it('sleeps after the idle time and resumes the same conversation on the next send', async () => {
    const { s, children, timers } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('hi')
    c.say({ type: 'user', isReplay: true, message: { role: 'user', content: 'hi' } })
    c.say({ type: 'result', subtype: 'success' })
    await flush()
    const idle = timers.find((t) => t.ms === 10 * 60_000)!
    idle.fn()
    expect(c.ended).toBe(true)
    await flush()
    expect(s.turn).toBe('sleeping')
    await s.send('again')
    const c2 = children[1]!
    expect(c2).toBeDefined()
    await ready(c2)
    expect(c2.users()).toEqual(['again'])
  })

  it('the first message from the pane argv (Slack "Ask an agent") is sent after initialize', async () => {
    const { children } = setup({}, ['--session-id', 'c', 'Look at this thread', '--permission-mode', 'default'])
    const c = children[0]!
    await ready(c)
    expect(c.users()).toEqual(['Look at this thread'])
  })

  it('hands the conversation to the terminal and back: one owner process at a time, same id', async () => {
    const transcript = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'typed in the terminal' }] } }
    ]
    const { s, children, ptys, ops } = setup({ transcript: () => transcript, terminalWorking: () => false })
    const c = children[0]!
    await ready(c)
    await s.send('hi')
    c.say({ type: 'user', isReplay: true, message: { role: 'user', content: 'hi' } })
    await flush()
    await expect(s.toTerminal()).rejects.toThrow(/working/)
    c.say({ type: 'result', subtype: 'success' })
    await flush()
    await s.toTerminal()
    expect(c.ended).toBe(true)
    expect(s.mode).toBe('terminal')
    expect(ptys[0]!.args).toContain('--resume')
    expect(ptys[0]!.args).toContain('conv-1')
    expect(ptys[0]!.args).not.toContain('-p')
    // terminal output reaches SessionManager through the PtyLike surface
    const seen: string[] = []
    s.onData((d) => seen.push(d))
    ptys[0]!.data('tui')
    expect(seen).toEqual(['tui'])
    await expect(s.send('nope')).rejects.toThrow(/terminal/)
    await s.toChat()
    expect(s.mode).toBe('chat')
    const c2 = children[1]!
    expect(c2).toBeDefined()
    // the chat resumes, never two processes for one conversation
    expect(ops.some((o) => o.op === 'reset' && o.items.some((i) => i.kind === 'text' && i.md === 'typed in the terminal'))).toBe(true)
  })

  it('Terminal -> Chat waits while the terminal is working', async () => {
    const { s, children } = setup({ mode: 'terminal', terminalWorking: () => true })
    expect(children.length).toBe(0)
    await expect(s.toChat()).rejects.toThrow(/working in the terminal/)
    await s.toChat(true)
    expect(s.mode).toBe('chat')
  })

  it('kill ends the session once (SessionManager sees one exit)', async () => {
    const { s, children } = setup()
    await ready(children[0]!)
    const exits: number[] = []
    s.onExit((e) => exits.push(e.exitCode))
    s.kill('SIGHUP')
    await flush()
    await flush()
    expect(exits.length).toBe(1)
    expect(s.turn).toBe('ended')
  })

  it('an unexpected exit is a notice, not the end of the session', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    const exits: number[] = []
    s.onExit((e) => exits.push(e.exitCode))
    c.exit(1)
    expect(exits).toEqual([])
    expect(s.turn).toBe('sleeping')
    expect(s.items.some((i) => i.kind === 'notice' && i.tone === 'error')).toBe(true)
  })

  it('agents:reply text typed into the "pty" becomes a chat message', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    s.write('continue')
    s.write('\r')
    expect(c.users()).toEqual(['continue'])
  })

  // ---------- QA round 1 ----------
  it('set_model after a turn: the replayed "Set model" line is not a turn, a send goes straight out', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('hi')
    c.say({ type: 'result', subtype: 'success' })
    await flush()
    const p = s.setModel('sonnet')
    c.reply('set_model')
    await p
    c.say({ type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Set model to `sonnet`</local-command-stdout>' } })
    await flush()
    expect(s.turn).toBe('idle')
    await s.send('next')
    expect(c.users()).toEqual(['hi', 'next'])
    expect(s.queue).toEqual([])
  })

  it('an interrupt the CLI acknowledges without a result still ends the turn', async () => {
    const { s, children, timers } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('long')
    c.say({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    const p = s.interrupt()
    c.reply('interrupt')
    await p
    expect(s.activity).toBe('Stopping')
    timers.find((t) => t.ms === 2500)!.fn()
    expect(s.turn).toBe('idle')
    await s.send('again')
    expect(c.users()).toEqual(['long', 'again'])
  })

  it('Esc while an approval is open closes the card (no dead Allow) and the tool reads as not done', async () => {
    const { s, children, asks } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('make notes')
    c.say({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: '/w/notes.txt', content: 'a' } }] } })
    c.say({ type: 'control_request', request_id: 'rw', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/w/notes.txt', content: 'a' }, tool_use_id: 'tw' } })
    await flush()
    const p = s.interrupt()
    c.reply('interrupt')
    await p
    const perm = s.items.find((i): i is ChatPermissionItem => i.kind === 'permission')!
    expect(perm.state).toBe('denied')
    expect(asks.closed.map((x) => x[0])).toContain('rw')
    c.say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', is_error: true, content: 'Interrupted by the user' }] } })
    await flush()
    expect(s.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'denied' })
  })

  it('a message typed under an open approval tells Claude what to do instead (not queued)', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('go')
    c.say({ type: 'control_request', request_id: 'r9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } } })
    await flush()
    await s.send('use the trash instead')
    expect(s.queue).toEqual([])
    expect(c.lines.find((l) => l.type === 'control_response')).toMatchObject({ response: { request_id: 'r9', response: { behavior: 'deny', message: 'use the trash instead' } } })
  })

  it('a canceled permission request (control_cancel_request) expires its card', async () => {
    const { s, children, asks } = setup()
    const c = children[0]!
    await ready(c)
    await s.send('go')
    c.say({ type: 'control_request', request_id: 'rc', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
    await flush()
    c.say({ type: 'control_cancel_request', request_id: 'rc' })
    await flush()
    expect(s.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'expired' })
    expect(asks.closed).toContainEqual(['rc', null])
    expect(s.turn).toBe('working')
  })

  it('Terminal -> Chat on a conversation the terminal never started uses --session-id, not --resume', async () => {
    const { s, children } = setup({ mode: 'terminal', terminalWorking: () => false, transcript: () => [] })
    await s.toChat()
    expect(children[0]!.args).toContain('--session-id')
    expect(children[0]!.args).not.toContain('--resume')
  })

  it('"No conversation found" on start retries once with --session-id', async () => {
    const { s, children } = setup({}, ['--resume', 'conv-2', '--permission-mode', 'default'])
    const c = children[0]!
    // the CLI prints the error on stderr, then exits 1
    c.warn('No conversation found with session ID: conv-2\n')
    c.exit(1)
    expect(children.length).toBe(2)
    expect(children[1]!.args).toContain('--session-id')
    expect(s.items.some((i) => i.kind === 'notice' && i.tone === 'error')).toBe(false)
  })

  it('the model and mode picked in the chat go with the conversation to the terminal and back', async () => {
    const { s, children, ptys } = setup({ terminalWorking: () => false, transcript: () => [{ type: 'user', message: { role: 'user', content: 'hi' } }] })
    const c = children[0]!
    await ready(c)
    const pm = s.setModel('haiku')
    c.reply('set_model')
    await pm
    const pp = s.setPermissionMode('acceptEdits')
    c.reply('set_permission_mode')
    await pp
    await s.send('hi')
    c.say({ type: 'result', subtype: 'success' })
    await flush()
    await s.toTerminal()
    const t = ptys[0]!.args
    expect(t[t.indexOf('--model') + 1]).toBe('haiku')
    expect(t[t.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    await s.toChat()
    const back = children[1]!.args
    expect(back[back.indexOf('--model') + 1]).toBe('haiku')
    expect(back[back.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(back).toContain('--resume')
  })

  it('a crash mid-turn (even kill -9) is a notice with Retry; the session goes on', async () => {
    const { s, children } = setup()
    const c = children[0]!
    await ready(c)
    const exits: number[] = []
    s.onExit((e) => exits.push(e.exitCode))
    await s.send('write a lot')
    c.exit(null, 'SIGKILL')
    expect(exits).toEqual([])
    expect(s.turn).toBe('sleeping')
    expect(s.items.find((i) => i.kind === 'notice' && i.tone === 'error')).toMatchObject({ action: 'retry' })
  })

  it('the first message titles the chat once', async () => {
    const titles: string[] = []
    const { s, children } = setup({ onTitle: (t) => titles.push(t) })
    const c = children[0]!
    await ready(c)
    await s.send('/compact')
    await s.send('Write 10 captions about our Ethiopia coffee')
    c.say({ type: 'result', subtype: 'success' })
    await flush()
    await s.send('more')
    expect(titles).toEqual(['Write 10 captions about our Ethiopia coffee'])
  })

  it('Needs you gets the chat card\'s title and buttons (Allow, the suggestion, Deny)', async () => {
    const opened: { title?: string; options?: { id: string; label: string }[] }[] = []
    const { children } = setup({ asks: { open: (e) => opened.push(e), close: () => undefined } })
    const c = children[0]!
    await ready(c)
    const sug = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'localSettings' }
    c.say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/private/tmp/x/hello.txt' }, permission_suggestions: [sug] } })
    await flush()
    expect(opened[0]!.title).toBe('Claude wants to create hello.txt')
    expect(opened[0]!.options!.map((o) => o.label)).toEqual(['Allow', 'Always allow “git push” here', 'Deny'])
  })
})
