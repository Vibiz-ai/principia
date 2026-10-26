/**
 * AGENT CHAT: Codex in the Claude chat. The reducer and the session are tested against real `codex app-server`
 * output (codex-cli 0.163.0) recorded into __fixtures__/codex-*.jsonl, paths scrubbed to /work.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { CodexReducer, commandTool, diffSides, helperLabel, unwrapShell } from '../../shared/codexReduce'
import type { ChatOp, ChatPermissionItem, ChatToolItem, ChatTurnEndItem } from '../../shared/chat'
import { CodexChatSession, codexPolicy, codexServerSpec, type CodexChatDeps } from './codexSession'
import type { ChildLike } from './streamProc'
import { codexAdapter } from '../engine/adapters'

type Line = { dir: 'in' | 'out'; id?: number | string; method?: string; params?: unknown; result?: Record<string, unknown> }
const fixture = (name: string): Line[] =>
  fs
    .readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
/** What the server said during the turn: notifications and approval requests, in order (no responses). */
const turnScript = (lines: Line[]): Line[] => {
  const start = lines.findIndex((l) => l.dir === 'out' && l.method === 'turn/start')
  return lines.slice(start + 1).filter((l) => l.dir === 'in' && !!l.method)
}
const threadOf = (lines: Line[]): Record<string, unknown> => (lines.find((l) => l.dir === 'in' && l.result && 'thread' in l.result)!.result!.thread ?? {}) as Record<string, unknown>

/** Feeds a recorded turn through the reducer, allowing every approval. */
function replayTurn(r: CodexReducer, lines: Line[]): ChatOp[] {
  const ops: ChatOp[] = []
  for (const l of turnScript(lines)) {
    if (l.id !== undefined) ops.push(...(r.approval(String(l.id), l.method!, l.params) ?? []))
    else ops.push(...r.notification(l.method!, l.params))
  }
  return ops
}

describe('codex reducer (recorded app-server output)', () => {
  it('a command turn: text, Bash cards with their output, the approval card, the turn end', () => {
    const lines = fixture('codex-command-approval.jsonl')
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = String(threadOf(lines).id)
    r.userSent("Run the shell command 'touch made-by-codex.txt' in this folder, then list the folder with ls, then say done in three words.")
    replayTurn(r, lines)
    const items = r.model.items
    // the echo of our own message is not drawn twice
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(items.find((i) => i.kind === 'text')).toMatchObject({ md: 'I’ll create the file and list the folder.', streaming: false })
    const tools = items.filter((i): i is ChatToolItem => i.kind === 'tool')
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ['Bash', 'ok'],
      ['LS', 'ok']
    ])
    expect(tools[0]!.input.command).toBe('touch made-by-codex.txt')
    expect(tools[1]!.resultText).toContain('made-by-codex.txt')
    const perms = items.filter((i): i is ChatPermissionItem => i.kind === 'permission')
    expect(perms).toHaveLength(2)
    expect(perms[0]).toMatchObject({ tool: 'Bash', requestId: '0', input: { command: 'touch made-by-codex.txt' } })
    // "always allow" comes from the decisions Codex offers (its exec-policy amendment)
    expect(perms[0]!.suggestions.map((s) => s.label)).toEqual(['Always allow `touch made-by-codex.txt`'])
    // serverRequest/resolved came after our answer: an unanswered card in a replay reads expired, never stuck open
    expect(perms.every((p) => p.state !== 'open')).toBe(true)
    const end = items.find((i): i is ChatTurnEndItem => i.kind === 'turnEnd')
    expect(end).toMatchObject({ error: null })
    expect(end!.ms).toBeGreaterThan(0)
  })

  it('file changes: a Write card for a new file, an Edit card with old and new text, files changed at the end', () => {
    const lines = fixture('codex-file-edit.jsonl')
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = String(threadOf(lines).id)
    replayTurn(r, lines)
    const tools = r.model.items.filter((i): i is ChatToolItem => i.kind === 'tool')
    const write = tools.find((t) => t.name === 'Write')!
    expect(write).toMatchObject({ status: 'ok', input: { file_path: '/work/note.md', content: 'hello\n' } })
    const edit = tools.find((t) => t.name === 'Edit')!
    expect(edit.input).toMatchObject({ file_path: '/work/note.md', old_string: 'hello', new_string: 'hi' })
    const perm = r.model.items.find((i): i is ChatPermissionItem => i.kind === 'permission')!
    expect(perm.tool).toBe('Write')
    expect(perm.suggestions[0]).toEqual({ label: 'Allow all edits for this chat', raw: 'acceptForSession' })
    const end = r.model.items.find((i): i is ChatTurnEndItem => i.kind === 'turnEnd')!
    expect(end.files).toEqual([{ path: '/work/note.md', add: 2, del: 1 }])
  })

  it('a resumed thread comes back as finished cards, without turn-end lines', () => {
    const lines = fixture('codex-resume.jsonl')
    const thread = threadOf(lines)
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = String(thread.id)
    r.replay(thread.turns as unknown[])
    expect(r.model.items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'tool', 'text'])
    expect(r.model.items.some((i) => i.kind === 'turnEnd')).toBe(false)
    expect(r.model.items.every((i) => i.kind !== 'tool' || i.status === 'ok')).toBe(true)
  })

  it('a spawned helper agent is a subagent card; its thread nests under it, a stranger thread is ignored', () => {
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = 'main'
    r.notification('item/started', { threadId: 'main', turnId: 't', item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'main', receiverThreadIds: ['kid'], prompt: 'Count the files\nin /work', model: null, reasoningEffort: null, agentsStates: {} } })
    r.notification('item/completed', { threadId: 'kid', turnId: 'k', item: { type: 'commandExecution', id: 'x9', command: 'ls', commandActions: [{ type: 'listFiles', command: 'ls', path: null }], status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 0, durationMs: 3 } })
    r.notification('item/completed', { threadId: 'stranger', turnId: 's', item: { type: 'agentMessage', id: 'm', text: 'not ours' } })
    r.notification('turn/completed', { threadId: 'kid', turn: { id: 'k', status: 'completed' } })
    const card = r.model.items.find((i): i is ChatToolItem => i.kind === 'tool' && i.name === 'Task')!
    expect(card.input).toMatchObject({ description: 'Count the files', subagent_type: 'helper' })
    expect(r.model.items.find((i) => i.kind === 'tool' && i.name === 'LS')?.parent).toBe('c1')
    expect(r.model.items.some((i) => i.kind === 'text')).toBe(false)
    // a helper's turn ending is not the conversation's
    expect(r.model.items.some((i) => i.kind === 'turnEnd')).toBe(false)
  })

  it('a helper announced as subAgentActivity (codex-cli 0.163): its card, its nested command and ask, its report', () => {
    const lines = fixture('codex-subagent.jsonl')
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = String(threadOf(lines).id)
    r.userSent('Spawn one helper agent and have that helper list the files in this folder by running ls. Then tell me in one sentence what the helper found.')
    replayTurn(r, lines)
    const items = r.model.items
    const card = items.find((i): i is ChatToolItem => i.kind === 'tool' && i.name === 'Task')!
    // named from its path (/root/list_files) in plain words
    expect(card).toMatchObject({ toolUseId: 'call_dd08a9a6d2f249cd89f09ecbf5b61c3c', parent: null, input: { description: 'List files', subagent_type: 'helper' } })
    expect(items.filter((i) => i.kind === 'tool' && i.name === 'Task')).toHaveLength(1)
    // the helper's command runs inside the card, not dropped as another conversation's
    const ls = items.find((i): i is ChatToolItem => i.kind === 'tool' && i.name === 'LS')!
    expect(ls).toMatchObject({ parent: card.toolUseId, status: 'ok' })
    expect(ls.resultText).toContain('README.md')
    // its approval is a normal Allow / Deny card, nested and labelled with the helper
    const perm = items.find((i): i is ChatPermissionItem => i.kind === 'permission')!
    expect(perm).toMatchObject({ requestId: '0', tool: 'Bash', parent: card.toolUseId, input: { command: 'ls' }, description: 'From the helper “List files”' })
    expect(r.helperName(perm.parent)).toBe('List files')
    // completed: the card is done and its report is the helper's last message
    expect(card.status).toBe('ok')
    expect(card.resultText).toBe('The folder contains README.md and notes.txt.')
    expect(items.find((i) => i.kind === 'text' && i.md.startsWith('The folder'))?.parent).toBe(card.toolUseId)
    // the conversation's own answer and one turn end stay at the top
    const top = items.filter((i) => i.kind === 'text' && !i.parent).map((i) => (i.kind === 'text' ? i.md : ''))
    expect(top).toEqual(['I’ll ask one helper to run `ls` in this folder and report what it finds.', 'The helper ran `ls` and found `README.md` and `notes.txt` in this folder.'])
    expect(items.filter((i) => i.kind === 'turnEnd')).toHaveLength(1)
  })

  it('a helper whose own turn fails marks its card; a completed one without a message still finishes', () => {
    const r = new CodexReducer({ now: () => 1000 })
    r.threadId = 'main'
    const sa = (kind: string, id: string): Record<string, unknown> => ({ threadId: 'main', turnId: 't', item: { type: 'subAgentActivity', id, kind, agentThreadId: 'kid', agentPath: '/root/checkTests', model: null } })
    r.notification('item/started', sa('started', 's1'))
    r.notification('item/completed', sa('started', 's1'))
    r.notification('turn/completed', { threadId: 'kid', turn: { id: 'k', status: 'failed', error: { message: 'boom' } } })
    r.notification('item/completed', sa('completed', 'done-1'))
    const card = r.model.items.find((i): i is ChatToolItem => i.kind === 'tool')!
    expect(card).toMatchObject({ toolUseId: 's1', status: 'error', resultText: 'boom', input: { description: 'Check tests' } })
    expect(r.model.items.some((i) => i.kind === 'turnEnd')).toBe(false)
    const r2 = new CodexReducer({ now: () => 1000 })
    r2.threadId = 'main'
    r2.notification('item/completed', sa('completed', 'done-2'))
    expect(r2.model.items.find((i) => i.kind === 'tool')).toMatchObject({ name: 'Task', status: 'ok', input: { description: 'Check tests' } })
  })

  it('small pieces', () => {
    expect(helperLabel('/root/list_files')).toBe('List files')
    expect(helperLabel('/root')).toBe('Helper')
    expect(helperLabel(null)).toBe('Helper')
    expect(unwrapShell("/bin/zsh -lc 'touch a b'")).toBe('touch a b')
    expect(unwrapShell('/bin/zsh -lc ls')).toBe('ls')
    expect(unwrapShell("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(commandTool({ command: '/bin/zsh -lc "cat a.md"', commandActions: [{ type: 'read', command: 'cat a.md', name: 'a.md', path: '/work/a.md' }] })).toEqual({ name: 'Read', input: { file_path: '/work/a.md', command: 'cat a.md' } })
    expect(diffSides('update', '@@ -1,2 +1,2 @@\n a\n-b\n+c\n')).toEqual({ old: 'a\nb', next: 'a\nc', add: 1, del: 1 })
    expect(codexPolicy('default', false)).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    expect(codexPolicy('acceptEdits', true)).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
})

describe('codexServerSpec: the pane argv becomes app-server config and thread settings', () => {
  it('keeps -c overrides, lifts developer instructions, model, folders, bypass and the first message', () => {
    const inv = codexAdapter.interactive({
      profile: { id: 'p', name: 'Codex', adapter: 'codex', model: 'gpt-x', extraArgs: [], secretNames: [], useApiKeyAuth: false } as never,
      artifactsDir: '/a/',
      memoryBrief: 'You are Vitruvius.',
      mcpArgs: ['-c', 'mcp_servers.hive.command="node"'],
      addDirs: ['/work/other'],
      initialPrompt: '-do it',
      bypass: false
    } as never)
    const spec = codexServerSpec(inv.args)
    expect(spec.args).toEqual(['app-server', '-c', 'mcp_servers.hive.command="node"'])
    expect(spec.developerInstructions).toBe('You are Vitruvius.')
    expect(spec.model).toBe('gpt-x')
    expect(spec.addDirs).toEqual(['/work/other'])
    expect(spec.prompt).toBe('-do it')
    expect(spec.bypass).toBe(false)
    expect(codexServerSpec(['--dangerously-bypass-approvals-and-sandbox']).bypass).toBe(true)
  })
})

// ---------- the session, against a scripted app-server ----------

/** A fake `codex app-server`: answers the handshake, then plays a recorded turn, pausing at each approval. */
class FakeCodex extends EventEmitter implements ChildLike {
  pid = 7100
  got: Record<string, unknown>[] = []
  private out = new EventEmitter()
  stdout = { on: (ev: 'data', cb: (d: string) => void) => this.out.on(ev, cb) }
  stderr = { on: () => undefined }
  private script: Line[] = []
  private waiting: number | string | null = null
  constructor(
    private thread: Record<string, unknown>,
    private recorded: Line[]
  ) {
    super()
  }
  stdin = {
    write: (d: string): boolean => {
      for (const l of d.split('\n').filter(Boolean)) this.client(JSON.parse(l) as Record<string, unknown>)
      return true
    },
    end: (): void => queueMicrotask(() => this.emit('exit', 0, null))
  }
  private say(o: unknown): void {
    this.out.emit('data', `${JSON.stringify(o)}\n`)
  }
  private client(o: Record<string, unknown>): void {
    this.got.push(o)
    const id = o.id as number | undefined
    switch (o.method) {
      case 'initialize':
        return this.say({ id, result: { userAgent: 'x' } })
      case 'thread/start':
      case 'thread/resume':
        return this.say({ id, result: { thread: this.thread, model: 'gpt-x' } })
      case 'model/list':
        return this.say({ id, result: { data: [{ model: 'gpt-x', displayName: 'GPT X', description: 'fast', hidden: false }] } })
      case 'turn/start':
        this.say({ id, result: { turn: { id: 'turn1', status: 'inProgress' } } })
        this.script = turnScript(this.recorded)
        return this.play()
    }
    if (!o.method && o.id !== undefined && o.id === this.waiting) {
      this.waiting = null
      this.play()
    }
  }
  private play(): void {
    while (this.script.length && this.waiting === null) {
      const l = this.script.shift()!
      this.say({ ...(l.id !== undefined ? { id: l.id } : {}), method: l.method, params: l.params })
      if (l.id !== undefined) this.waiting = l.id
    }
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

function session(lines: Line[], extra: Partial<CodexChatDeps> = {}) {
  const thread = threadOf(lines)
  const child = new FakeCodex(thread, lines)
  const ops: ChatOp[] = []
  const asks: { open: unknown[]; closed: string[] } = { open: [], closed: [] }
  const convs: string[] = []
  const s = new CodexChatSession({
    sessionId: 'session_1',
    file: 'codex',
    interactiveArgs: ['--no-alt-screen', '-c', 'developer_instructions="You are Vitruvius."'],
    cwd: '/work',
    env: {},
    resumeId: null,
    spawnChild: () => child,
    killGroup: () => false,
    emit: (o) => ops.push(...o),
    asks: { open: (e) => asks.open.push(e), close: (rid) => asks.closed.push(rid) },
    onConversation: (c) => convs.push(c),
    setTimer: () => 0,
    clearTimer: () => undefined,
    ...extra
  })
  return { s, child, ops, asks, convs, thread }
}

describe('CodexChatSession', () => {
  it('starts a thread with the agent instructions, streams a turn, asks before commands, ends the turn', async () => {
    const lines = fixture('codex-command-approval.jsonl')
    const { s, child, asks, convs, thread } = session(lines)
    await flush()
    const start = child.got.find((o) => o.method === 'thread/start')!
    expect(start.params).toMatchObject({ cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: 'You are Vitruvius.' })
    expect(convs).toEqual([thread.id])
    expect(s.turn).toBe('idle')
    expect(s.meta).toMatchObject({ harness: 'codex', models: [{ value: 'gpt-x', label: 'GPT X', description: 'fast' }] })

    const said = "Run the shell command 'touch made-by-codex.txt' in this folder, then list the folder with ls, then say done in three words."
    await s.send(said)
    await flush()
    expect(child.got.find((o) => o.method === 'turn/start')?.params).toMatchObject({ threadId: thread.id, input: [{ type: 'text', text: said }] })
    // waiting on the first approval
    expect(s.turn).toBe('needs')
    expect(asks.open).toHaveLength(1)
    expect(asks.open[0]).toMatchObject({ title: 'Codex wants to run a command' })
    s.answer('0', { kind: 'allow' })
    await flush()
    expect(child.got.find((o) => o.id === 0 && !o.method)).toEqual({ id: 0, result: { decision: 'accept' } })
    // the second one, answered with its "always allow" amendment
    const perm = s.items.find((i): i is ChatPermissionItem => i.kind === 'permission' && i.requestId === '1')!
    expect(perm.state).toBe('open')
    s.answer('1', { kind: 'allowAlways', suggestion: 0 })
    await flush()
    expect(child.got.find((o) => o.id === 1 && !o.method)).toEqual({ id: 1, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } } } })
    expect(s.turn).toBe('idle')
    expect(s.items.some((i) => i.kind === 'turnEnd')).toBe(true)
    expect(s.items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  it('Deny with words: declines, and the words join the running turn (turn/steer)', async () => {
    const lines = fixture('codex-command-approval.jsonl')
    const { s, child } = session(lines)
    await flush()
    await s.send('touch it')
    await flush()
    // typing under an open card answers it
    await s.send('use the notes folder instead')
    await flush()
    expect(child.got.find((o) => o.id === 0 && !o.method)).toEqual({ id: 0, result: { decision: 'decline' } })
    expect(child.got.find((o) => o.method === 'turn/steer')?.params).toMatchObject({ expectedTurnId: '01a177ed-dc2f-7f01-9279-ad8da41b9cad', input: [{ type: 'text', text: 'use the notes folder instead' }] })
    const perm = s.items.find((i): i is ChatPermissionItem => i.kind === 'permission' && i.requestId === '0')!
    expect(perm).toMatchObject({ state: 'denied', outcome: 'Denied: use the notes folder instead' })
  })

  it('resumes its thread (history back as cards) and the mode picks the approval policy of the next turn', async () => {
    const lines = fixture('codex-resume.jsonl')
    const { s, child, thread, ops } = session(lines, { resumeId: 'th_old' })
    await flush()
    expect(child.got.find((o) => o.method === 'thread/resume')?.params).toMatchObject({ threadId: 'th_old', developerInstructions: 'You are Vitruvius.' })
    expect(ops.some((o) => o.op === 'reset')).toBe(true)
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'tool', 'text', 'notice'])
    expect(s.conversationId).toBe(thread.id)
    await s.setPermissionMode('default')
    await s.send('what did you make?')
    await flush()
    expect(child.got.find((o) => o.method === 'turn/start')?.params).toMatchObject({ approvalPolicy: 'untrusted' })
    await expect(s.setPermissionMode('plan')).rejects.toThrow(/no such mode/)
    await expect(s.toTerminal()).rejects.toThrow(/no terminal/)
  })

  it('a helper agent’s ask reaches Needs you in the helper’s name and is answered, never refused', async () => {
    const lines = fixture('codex-subagent.jsonl')
    const { s, child, asks } = session(lines)
    await flush()
    await s.send('Spawn one helper agent and have that helper list the files in this folder by running ls. Then tell me in one sentence what the helper found.')
    await flush()
    expect(s.turn).toBe('needs')
    expect(asks.open).toHaveLength(1)
    expect(asks.open[0]).toMatchObject({ requestId: '0', title: 'Codex’s helper “List files” wants to run a command' })
    expect(child.got.some((o) => o.id === 0 && 'error' in o)).toBe(false)
    s.answer('0', { kind: 'allow' })
    await flush()
    expect(child.got.find((o) => o.id === 0 && !o.method)).toEqual({ id: 0, result: { decision: 'accept' } })
    expect(s.turn).toBe('idle')
    expect(s.items.find((i) => i.kind === 'tool' && i.name === 'Task')).toMatchObject({ status: 'ok', resultText: 'The folder contains README.md and notes.txt.' })
  })

  it('Stop while an approval waits closes its Needs you ask too, and an agent chat asks in the agent’s name', async () => {
    const lines = fixture('codex-command-approval.jsonl')
    const closedAt: string[] = []
    const ref: { s: CodexChatSession | null } = { s: null }
    const stateOf = (rid: string): string => (ref.s?.items.find((i): i is ChatPermissionItem => i.kind === 'permission' && i.requestId === rid)?.state ?? 'gone')
    const titles: string[] = []
    const { s, child } = session(lines, { speaker: () => 'Julia', asks: { open: (e) => titles.push(String(e.title)), close: (rid) => closedAt.push(`${rid}:${stateOf(rid)}`) } })
    ref.s = s
    await flush()
    await s.send('touch it')
    await flush()
    expect(titles).toEqual(['Julia wants to run a command'])
    // the real server sends nothing more for a canceled request: the Stop alone must close the ask
    ;(child as unknown as { script: unknown[] }).script = []
    void s.interrupt()
    // the ask leaves Needs you with the Stop itself, read while its card is still open (never skipped)
    expect(closedAt[0]).toBe('0:open')
    await flush()
    const perm = s.items.find((i): i is ChatPermissionItem => i.kind === 'permission' && i.requestId === '0')!
    expect(perm).toMatchObject({ state: 'denied', outcome: 'Stopped' })
  })

  it('Kill ends it once; a crash is a notice and the next message starts it again', async () => {
    const lines = fixture('codex-command-approval.jsonl')
    const { s, child } = session(lines)
    await flush()
    child.emit('exit', 1, null)
    await flush()
    expect(s.turn).toBe('sleeping')
    expect(s.items.some((i) => i.kind === 'notice' && i.tone === 'error')).toBe(true)
    let exits = 0
    s.onExit(() => exits++)
    s.kill()
    s.kill()
    expect(exits).toBe(1)
  })
})
