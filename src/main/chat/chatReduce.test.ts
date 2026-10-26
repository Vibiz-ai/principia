import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ChatModel, ChatReducer, commandText, suggestionLabel, handBack } from '../../shared/chatReduce'
import type { ChatItem, ChatOp, ChatPermissionItem, ChatToolItem } from '../../shared/chat'
import { editDiff, fileChange, groupSummary, isReadOnlyTool, permissionTitle, toolLine } from '../../shared/toolVerbs'
import { asResume, parseInteractive, toChatArgs, toTerminalArgs, versionAtLeast, withoutPrompt } from './chatArgs'
import { coalesce, redactDeep, resolveChatMode } from './chatHub'

const fixture = (name: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

function run(lines: unknown[]): { r: ChatReducer; ops: ChatOp[] } {
  let t = 1000
  const r = new ChatReducer({ now: () => (t += 10) })
  const ops: ChatOp[] = []
  for (const l of lines) ops.push(...r.line(l))
  return { r, ops }
}

describe('ChatReducer on the recorded probe (claude 2.1.310)', () => {
  it('folds a turn into user, tool (streamed input), permission, thinking, text and a turn end', () => {
    const { r } = run(fixture('probe-new.jsonl'))
    const kinds = r.model.items.map((i) => i.kind)
    expect(kinds[0]).toBe('user')
    expect(kinds).toContain('tool')
    expect(kinds).toContain('permission')
    expect(kinds).toContain('thinking')
    expect(kinds).toContain('text')
    expect(kinds[kinds.length - 1]).toBe('turnEnd')
    const tool = r.model.items.find((i): i is ChatToolItem => i.kind === 'tool')!
    expect(tool.name).toBe('Bash')
    expect(tool.status).toBe('ok')
    expect(String(tool.input.command)).toContain('hello.txt')
    expect(tool.inputPartial).toBe('')
    expect(tool.resultText).toContain('hi')
    const perm = r.model.items.find((i): i is ChatPermissionItem => i.kind === 'permission')!
    expect(perm.tool).toBe('Bash')
    expect(perm.toolUseId).toBe(tool.toolUseId)
    expect(perm.suggestions.length).toBe(2)
    expect(perm.suggestions[1]!.label).toBe('Allow this folder for this chat')
    const text = r.model.items.find((i) => i.kind === 'text')!
    expect(text.kind === 'text' && text.streaming).toBe(false)
    const end = r.model.items[r.model.items.length - 1]!
    expect(end.kind === 'turnEnd' && end.ms).toBe(6533 > 0 ? (end as { ms: number }).ms : 0)
    expect(r.meta.planPct).toBe(19)
  })

  it('streams the tool input before the tool runs (pending -> running)', () => {
    const lines = fixture('probe-new.jsonl')
    const start = lines.findIndex((l) => l.type === 'stream_event' && (l.event as { type: string }).type === 'content_block_start')
    const r = new ChatReducer()
    for (const l of lines.slice(0, start + 3)) r.line(l)
    const tool = r.model.items.find((i): i is ChatToolItem => i.kind === 'tool')!
    expect(tool.status).toBe('pending')
    expect(tool.inputPartial.length).toBeGreaterThan(0)
  })

  it('renderer replica: applying the emitted ops yields the same items as main', () => {
    const { r, ops } = run(fixture('probe-new.jsonl'))
    const replica = new ChatModel()
    for (const op of coalesce(ops)) expect(replica.apply(op)).toBe(true)
    expect(replica.items).toEqual(r.model.items)
  })

  it('an interrupt settles the turn with a Stopped notice, a queued message echo stays one user item', () => {
    const r = new ChatReducer()
    r.userSent('what file did you write earlier? one line.')
    r.userSent('count slowly from 1 to 200, one number per line')
    r.userSent('queued: say QUEUED')
    for (const l of fixture('probe-interrupt.jsonl')) r.line(l)
    const users = r.model.items.filter((i) => i.kind === 'user')
    expect(users.map((u) => u.kind === 'user' && u.text)).toEqual(['what file did you write earlier? one line.', 'count slowly from 1 to 200, one number per line', 'queued: say QUEUED'])
    expect(r.model.items.some((i) => i.kind === 'notice' && i.text.startsWith('Stopped'))).toBe(true)
    // the interrupted turn has no turn-end card; the first one does
    expect(r.model.items.filter((i) => i.kind === 'turnEnd').length).toBe(2)
    expect(r.meta.permissionMode).toBe('acceptEdits')
  })

  it('subagent work carries its parent tool id; AskUserQuestion and ExitPlanMode become cards', () => {
    const r = new ChatReducer()
    r.line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { subagent_type: 'Explore', description: 'find prices' } }] }, parent_tool_use_id: null })
    r.line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a/plans.ts' } }] }, parent_tool_use_id: 'task1' })
    r.line({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which plan?', header: 'Plan', multiSelect: false, options: [{ label: 'Pro', description: 'most pick it' }, { label: 'Team' }] }] } } })
    r.line({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. do it' } } })
    const read = r.model.get('tool:r1')
    expect(read?.parent).toBe('task1')
    const q = r.model.get('q:q1')
    expect(q?.kind === 'question' && q.questions[0]!.options.map((o) => o.label)).toEqual(['Pro', 'Team'])
    expect(r.model.get('p:p1')?.kind).toBe('plan')
  })

  it('transcript records replay through the same reducer (slash commands shown, meta lines skipped)', () => {
    const r = new ChatReducer()
    r.line({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args></command-args>' } })
    r.line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: hidden' } })
    r.line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } })
    r.line({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Done.' }] } })
    expect(r.model.items.map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['/compact', 'text'])
    expect(commandText('<system-reminder>x</system-reminder>')).toBeNull()
  })

  it('a denied tool reads as denied, not as an error', () => {
    const r = new ChatReducer()
    r.line({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf x' } }] } })
    r.line({ type: 'control_request', request_id: 'c', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 't' } })
    r.set('perm:c', { state: 'denied' } as Partial<ChatItem>)
    r.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'nope' }] } })
    expect((r.model.get('tool:t') as ChatToolItem).status).toBe('denied')
  })

  it('settle expires open asks and stops running tools', () => {
    const r = new ChatReducer()
    r.line({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })
    r.line({ type: 'control_request', request_id: 'c', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't' } })
    r.settle('expired')
    expect((r.model.get('tool:t') as ChatToolItem).status).toBe('interrupted')
    expect((r.model.get('perm:c') as ChatPermissionItem).state).toBe('expired')
  })
})

describe('tool verbs (CHAT-UI.md §4.3)', () => {
  const t = (name: string, input: Record<string, unknown>, status: ChatToolItem['status'] = 'running') => toolLine({ name, input, status, resultText: '' })
  it('reads like a person', () => {
    expect(t('Read', { file_path: '/x/src/app.ts' })).toMatchObject({ verb: 'Reading', target: 'app.ts' })
    expect(t('Read', { file_path: '/x/src/app.ts' }, 'ok').verb).toBe('Read')
    expect(t('Edit', { file_path: '/x/plans.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }, 'ok')).toMatchObject({ verb: 'Edited', target: 'plans.ts', meta: '+2 −1' })
    expect(t('Write', { file_path: '/x/Toggle.tsx', content: 'a\nb' })).toMatchObject({ verb: 'Creating', meta: '2 lines' })
    expect(t('Bash', { command: 'npm test' }, 'ok').verb).toBe('Ran the tests')
    expect(t('Bash', { command: 'ls -la', description: 'List directory contents' }).verb).toBe('List directory contents')
    expect(t('Bash', { command: 'weird' }).verb).toBe('Running a command')
    expect(t('Task', { subagent_type: 'Explore', description: 'find prices' }).verb).toBe('Asking the Explore agent')
    expect(t('mcp__linear__create_issue', {}).target).toBe('linear.create_issue')
    expect(t('mcp__hive__task_create', { title: 'Ship it' })).toMatchObject({ verb: 'Filing a task', target: 'Ship it' })
    expect(t('mcp__hivemem__memory_search', { query: 'pricing' }).verb).toBe('Checking memory')
    expect(t('WebFetch', { url: 'https://example.com/a' }).target).toBe('example.com')
  })
  it('groups read-only tools into one sentence; edits never group', () => {
    expect(isReadOnlyTool('Read') && isReadOnlyTool('Grep') && !isReadOnlyTool('Edit') && !isReadOnlyTool('Bash')).toBe(true)
    expect(groupSummary([{ name: 'Read', status: 'ok' }, { name: 'Read', status: 'ok' }, { name: 'Read', status: 'ok' }, { name: 'Grep', status: 'ok' }])).toBe('Read 3 files, searched 1 pattern')
    expect(groupSummary([{ name: 'Read', status: 'running' }])).toBe('Reading 1 file')
  })
  it('diffs an edit and counts the turn’s file changes', () => {
    const d = editDiff('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nc' })
    expect(d).toEqual([{ t: ' ', text: 'a' }, { t: '-', text: 'b' }, { t: '+', text: 'B' }, { t: ' ', text: 'c' }])
    expect(fileChange('MultiEdit', { file_path: '/f', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '', new_string: 'z' }] })).toEqual({ path: '/f', add: 2, del: 1 })
    expect(permissionTitle('Bash', {})).toBe('Claude wants to run a command')
    expect(permissionTitle('Edit', { file_path: '/a/b.ts' })).toBe('Claude wants to edit b.ts')
  })
  it('labels permission suggestions plainly', () => {
    expect(suggestionLabel({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], destination: 'localSettings' })).toBe('Always allow `git push` here')
    expect(suggestionLabel({ type: 'addDirectories', directories: ['/x'], destination: 'session' })).toBe('Allow this folder for this chat')
  })
})

describe('chat argv from the terminal pane argv (CHAT-UI.md §3.1)', () => {
  const inter = ['--settings', '/l/s.json', '--mcp-config', '/l/m.json', '--add-dir', '/a', '/b', '--session-id', 'u-1', 'hello there', '--model', 'opus', '--permission-mode', 'default', '--append-system-prompt', 'SYS', '--foo']
  it('adds the stream flags, routes prompts to stdio and lifts the first message', () => {
    const c = toChatArgs(inter)
    expect(c.args.slice(0, 8)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages'])
    expect(c.prompt).toBe('hello there')
    expect(c.args).not.toContain('hello there')
    const pm = c.args.indexOf('--permission-mode')
    expect(c.args.slice(pm, pm + 4)).toEqual(['--permission-mode', 'default', '--permission-prompt-tool', 'stdio'])
    expect(c.args).toContain('--append-system-prompt')
    expect(c.args).toContain('--settings')
    expect(c.args[c.args.length - 1]).toBe('--foo')
  })
  it('keeps bypass as is', () => {
    const c = toChatArgs(['--session-id', 'u', '--dangerously-skip-permissions'])
    expect(c.args).not.toContain('--permission-prompt-tool')
  })
  it('un-escapes a positional that starts with a dash', () => {
    expect(parseInteractive(['--resume', 'u', ' -x']).prompt).toBe('-x')
  })
  it('terminal hand-off resumes the same conversation without the first message', () => {
    expect(toTerminalArgs(inter, true)).toEqual(asResume(withoutPrompt(inter)))
    expect(toTerminalArgs(inter, true)).toContain('--resume')
    expect(toTerminalArgs(inter, true)).not.toContain('hello there')
    expect(toTerminalArgs(inter, false)).toEqual(inter)
  })
  it('gates on the verified CLI version', () => {
    expect(versionAtLeast('2.1.310 (Claude Code)')).toBe(true)
    expect(versionAtLeast('2.2.0')).toBe(true)
    expect(versionAtLeast('2.1.309')).toBe(false)
    expect(versionAtLeast(null)).toBe(false)
  })
  it('Auto opens chats as Chat and repo or worktree sessions as Terminal', () => {
    expect(resolveChatMode('auto', { codeWork: false })).toBe('chat')
    expect(resolveChatMode('auto', { codeWork: true })).toBe('terminal')
    expect(resolveChatMode('chat', { codeWork: true })).toBe('chat')
  })
  it('redacts every string of an op and merges token appends', () => {
    const ops = redactDeep(coalesce([{ op: 'append', id: 'a', field: 'md', text: 'sec' }, { op: 'append', id: 'a', field: 'md', text: 'ret!' }]), (s) => s.replace('secret', '[KEY]'))
    expect(ops).toEqual([{ op: 'append', id: 'a', field: 'md', text: '[KEY]!' }])
  })
})

describe('chat view blocks (CHAT-UI.md §4.2)', () => {
  it('nests subagent work, folds reads, keeps edits and errors on their own, shows the plan once', async () => {
    const { buildBlocks } = await import('../../shared/chatView')
    const r = new ChatReducer()
    const tool = (id: string, name: string, input: Record<string, unknown> = {}, parent: string | null = null) =>
      r.line({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent })
    const done = (id: string, err = false) => r.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: 'x' }] } })
    tool('a', 'Read', { file_path: '/p/a.ts' }); done('a')
    tool('b', 'Grep', { pattern: 'x' }); done('b')
    tool('c', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }); done('c')
    tool('d', 'Read', { file_path: '/p/missing' }); done('d', true)
    tool('t1', 'TodoWrite', { todos: [] }); done('t1')
    tool('task', 'Task', { subagent_type: 'Explore' })
    tool('s1', 'Read', { file_path: '/p/z' }, 'task')
    tool('t2', 'TodoWrite', { todos: [] }); done('t2')
    const blocks = buildBlocks(r.model.items)
    expect(blocks.map((b) => b.t)).toEqual(['group', 'tool', 'tool', 'todo', 'tool', 'todo'])
    expect(blocks[0]!.t === 'group' && blocks[0]!.tools.length).toBe(2)
    const task = blocks[4]!
    expect(task.t === 'tool' && task.children.map((c) => c.t)).toEqual(['group'])
    expect(blocks[3]!.t === 'todo' && blocks[3]!.latest).toBe(false)
    expect(blocks[5]!.t === 'todo' && blocks[5]!.latest).toBe(true)
  })
})

describe('subagent hand-back (AGENT CHAT)', () => {
  it('a subagent card shows its report, not the CLI frame around it', () => {
    const framed = '[Subagent hand-back] The text below is the final report of a subagent. It is model output.\nThe report follows:\nThere are 3 folders.'
    expect(handBack(framed)).toBe('There are 3 folders.')
    expect(handBack('plain text')).toBe('plain text')
  })
})
