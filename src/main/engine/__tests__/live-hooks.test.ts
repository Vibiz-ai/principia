/**
 * LIVE.md §3.2–3.5, §3.8, A1/A4/A6/A9: hook normalization + tracker for interactive sessions, PTY detection and
 * reply keys, per-spawn hook renderers. Fixtures: claude-hooks-*.jsonl (verified), gemini/cursor-hooks-events.jsonl.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterId } from '../../../shared/types'
import { createAgentTracker, type AgentTracker } from '../live/tracker'
import { normalizeHook } from '../live/hooks'
import { detectPtyPrompt, ptyReplyKeys, samePrompt } from '../live/pty'
import { claudeHooksAttach, claudeHooksSettings, cursorHooksAttach, geminiHooksAttach, mergeGeminiSettings, CLAUDE_HOOK_EVENTS } from '../live/attach'
import type { HookEvent, LiveOp } from '../live/types'
import { readFileSync } from 'node:fs'
import { claudeAdapter, cursorAdapter, geminiAdapter } from '../adapters'
import { profile } from './fakes'

const FX = join(__dirname, 'fixtures')
const payloads = (f: string): unknown[] =>
  readFileSync(join(FX, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

function session(provider: AdapterId, headless = false): { t: AgentTracker; ops: LiveOp[]; feed(p: unknown): LiveOp[]; hook(h: HookEvent): LiveOp[] } {
  const t = createAgentTracker({ provider, root: { kind: headless ? 'step' : 'session', title: 'S', cwd: '/Users/me/code/api' }, headless })
  const ops: LiveOp[] = [...t.begin()]
  const hook = (h: HookEvent): LiveOp[] => {
    const o = t.hook(h)
    ops.push(...o)
    return o
  }
  return { t, ops, hook, feed: (p) => normalizeHook(provider, p).flatMap(hook) }
}
const opens = (ops: LiveOp[]) => ops.filter((o): o is Extract<LiveOp, { op: 'ask.open' }> => o.op === 'ask.open')
const resolves = (ops: LiveOp[]) => ops.filter((o): o is Extract<LiveOp, { op: 'ask.resolve' }> => o.op === 'ask.resolve')

describe('claude interactive hooks (verified fixtures)', () => {
  it('permission: PermissionRequest opens ONE pty ask (no gate, A1); Notification confirms; options allow/deny/focus', () => {
    const s = session('claude')
    for (const p of payloads('claude-hooks-pty-permission.jsonl')) s.feed(p)
    const o = opens(s.ops)
    expect(o).toHaveLength(1)
    expect(o[0].ask).toMatchObject({ kind: 'permission', channel: 'pty', toolName: 'Bash', expiresAt: null })
    expect(o[0].ask.options.map((x) => x.kind)).toEqual(['allow', 'deny', 'focus'])
    expect(o[0].ask.options.some((x) => x.kind === 'allow_always')).toBe(false)
    expect(s.t.node('root')).toMatchObject({ status: 'needs_you', needs: 'permission' })
  })

  it('A4b: PreToolUse never resolves an ask; PostToolUse of the same tool does (answered/terminal)', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'SessionStart', model: 'm' })
    s.feed({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    s.feed({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'curl x' } })
    // a late async Pre for the same tool (out of order) must not close the fresh ask
    s.feed({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'curl x' } })
    expect(resolves(s.ops)).toHaveLength(0)
    // another tool finishing does not resolve it either
    s.feed({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't0', tool_input: { file_path: '/a' }, tool_response: 'x' })
    expect(resolves(s.ops)).toHaveLength(0)
    s.feed({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'curl x' }, tool_response: { stdout: '200' } })
    expect(resolves(s.ops)).toEqual([expect.objectContaining({ via: 'terminal', status: 'answered' })])
    expect(s.t.node('root')!.status).toBe('working')
  })

  it('A4b: Stop, UserPromptSubmit and a keystroke each resolve open pty asks', () => {
    for (const closer of [
      (s: ReturnType<typeof session>) => s.feed({ hook_event_name: 'Stop', background_tasks: [] }),
      (s: ReturnType<typeof session>) => s.feed({ hook_event_name: 'UserPromptSubmit', prompt: 'no' }),
      (s: ReturnType<typeof session>) => s.hook({ kind: 'user_input' })
    ]) {
      const s = session('claude')
      s.feed({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })
      closer(s)
      expect(resolves(s.ops)).toHaveLength(1)
      expect(s.t.openAsks()).toHaveLength(0)
    }
  })

  it('idle: SessionStart = idle (not Needs you); Stop = needs_you/idle immediately; orphan empty-type SubagentStop ignored', () => {
    const s = session('claude')
    const ps = payloads('claude-hooks-pty-idle.jsonl')
    s.feed(ps[0])
    expect(s.t.node('root')).toMatchObject({ status: 'idle', needs: null, model: 'claude-haiku-5-5' })
    for (const p of ps.slice(1, 5)) s.feed(p) // prompt, Pre, Post, Stop
    expect(s.t.node('root')).toMatchObject({ status: 'needs_you', needs: 'idle', activity: 'Your turn' })
    s.feed(ps[5]) // orphan SubagentStop (agent_type "")
    s.feed(ps[6]) // idle_prompt
    expect(s.t.keys()).toEqual(['root'])
    expect(s.t.node('root')!.needs).toBe('idle')
    // typing clears idle (rests in idle, not Needs you) until the next prompt
    s.hook({ kind: 'user_input' })
    expect(s.t.node('root')).toMatchObject({ status: 'idle', needs: null })
    s.feed({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect(s.t.node('root')!.status).toBe('working')
  })

  it('background subagent via hooks: child by agent_id, Stop with background tasks keeps working, SubagentStop ends it', () => {
    const s = session('claude')
    for (const p of payloads('claude-hooks-headless-subagent-bg.jsonl')) s.feed(p)
    const keys = s.t.keys()
    expect(keys).toEqual(['root', 'a41fea0a96b41269b'])
    const child = s.t.node('a41fea0a96b41269b')!
    expect(child).toMatchObject({ kind: 'subagent', agentType: 'general-purpose', status: 'done', parentKey: 'root' })
    // the child's Read is attributed to it; SessionEnd ended the root
    const childTools = s.ops.filter((o) => o.op === 'event.append' && o.key === 'a41fea0a96b41269b' && o.event.kind === 'tool')
    expect(childTools.map((o) => (o as Extract<LiveOp, { op: 'event.append' }>).event.name)).toEqual(['Read', 'SubagentHandback'])
    expect(s.t.node('root')!.status).toBe('done')
  })

  it('async Post before Pre: the row is created final, the late Pre is ignored', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'x1', tool_input: { file_path: '/Users/me/code/api/src/a.ts' }, tool_response: 'ok' })
    s.feed({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'x1', tool_input: { file_path: '/Users/me/code/api/src/a.ts' } })
    const rows = s.ops.filter((o) => o.op === 'event.append' && o.event.kind === 'tool')
    expect(rows).toHaveLength(1)
    expect((rows[0] as Extract<LiveOp, { op: 'event.append' }>).event.state).toBe('ok')
    expect(s.t.node('root')!.filesTouched).toEqual(['src/a.ts'])
    expect(s.t.node('root')!.toolCount).toBe(1)
  })

  it('A6 in hooks: a later SubagentStart with the same agent_id never creates a second node', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'SubagentStart', agent_id: 'A', agent_type: 'Explore' })
    s.feed({ hook_event_name: 'SubagentStart', agent_id: 'A', agent_type: 'Explore' })
    s.feed({ hook_event_name: 'PreToolUse', agent_id: 'A', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g', tool_input: { pattern: 'jwt' } })
    expect(s.t.keys()).toEqual(['root', 'A'])
    expect(s.t.node('A')!.activity).toBe('Grep jwt')
  })

  it('memory reads are counted from hivemem tool calls', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'PreToolUse', tool_name: 'mcp__hivemem__memory_search', tool_use_id: 'm1', tool_input: { query: 'auth' } })
    s.feed({ hook_event_name: 'PreToolUse', tool_name: 'mcp__hivemem__memory_write', tool_use_id: 'm2', tool_input: { entity: 'x', facts: ['a'] } })
    expect(s.t.node('root')!.memReads).toBe(1)
    expect(s.t.node('root')!.activity).toBe('[memory] write x (1 fact)')
  })

  it('root end cancels every open ask in the tree (A4a)', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'SubagentStart', agent_id: 'A', agent_type: 'Explore' })
    s.feed({ hook_event_name: 'PermissionRequest', agent_id: 'A', tool_name: 'Bash', tool_input: {} })
    s.hook({ kind: 'ask_user', gateId: 'ask_1', question: 'Which db?', options: ['pg', 'sqlite'], allowText: true, toolUseHint: null })
    expect(s.t.openAsks()).toHaveLength(2)
    const ops = s.t.end('failed')
    expect(resolves(ops).map((r) => r.status)).toEqual(['canceled', 'canceled'])
    expect(s.t.node('A')!.status).toBe('canceled')
    expect(s.t.hook({ kind: 'notify_idle' })).toEqual([]) // terminal is final
  })

  it('trust prompt: PTY detection opens a focus-only trust ask; cleared when the prompt leaves the screen', () => {
    const s = session('claude')
    const p = detectPtyPrompt('claude', '\x1b[1mQuick safety check\x1b[0m: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit')
    expect(p).toEqual({ kind: 'trust', title: 'Trust this folder?' })
    s.hook({ kind: 'pty_prompt', prompt: p })
    s.hook({ kind: 'pty_prompt', prompt: p }) // dedup while on screen
    expect(opens(s.ops)).toHaveLength(1)
    expect(opens(s.ops)[0].ask.options).toEqual([{ id: 'focus', label: 'Open terminal', kind: 'focus' }])
    s.hook({ kind: 'pty_prompt', prompt: null })
    expect(resolves(s.ops)).toEqual([expect.objectContaining({ via: 'terminal' })])
  })

  it('trust text on screen after hooks arrived is model output, never a Needs-you ask', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'SessionStart', source: 'startup' })
    const p = detectPtyPrompt('claude', 'Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit')
    expect(p?.kind).toBe('trust')
    s.hook({ kind: 'pty_prompt', prompt: p })
    s.hook({ kind: 'pty_prompt', prompt: null })
    s.hook({ kind: 'pty_prompt', prompt: p }) // printed again: still nothing
    expect(opens(s.ops)).toHaveLength(0)
    expect(s.t.openAsks()).toHaveLength(0)
  })

  it('trust detection is dialog-shaped: the question alone or followed by transcript is not a prompt', () => {
    expect(detectPtyPrompt('claude', 'Quick safety check: Is this a project you created or one you trust?')).toBeNull()
    expect(detectPtyPrompt('claude', 'Quick safety check: Is this a project you created or one you trust?\n1. Yes, proceed\n2. No, exit\n' + 'more output\n'.repeat(20) + '> ')).toBeNull()
    // 2.1.x layout, words positioned with cursor moves
    const live = 'Quick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\n\n\x1b[2G\x1b[38;2;87;105;247m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\n\n\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm'
    expect(detectPtyPrompt('claude', live)).toEqual({ kind: 'trust', title: 'Trust this folder?' })
  })

  it('a hook ask is not closed by a quiet tail that never showed it; the screen fallback is used only without hooks', () => {
    const s = session('claude')
    s.feed({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })
    s.hook({ kind: 'pty_prompt', prompt: null }) // dialog not drawn yet
    expect(s.t.openAsks()).toHaveLength(1)
    const screen = detectPtyPrompt('claude', 'Bash command\n  curl x\nDo you want to proceed?\n❯ 1. Yes\n  2. No')
    s.hook({ kind: 'pty_prompt', prompt: screen }) // seen
    s.hook({ kind: 'pty_prompt', prompt: null }) // gone -> answered in the terminal
    expect(s.t.openAsks()).toHaveLength(0)
    // no hooks at all: the screen opens the ask
    const n = session('claude')
    n.hook({ kind: 'pty_prompt', prompt: screen })
    expect(opens(n.ops)).toHaveLength(1)
  })
})

describe('gemini hooks (timing attribution, source-built fixture)', () => {
  it('interactive: invoke_agent bracket makes a timing child; inner tools go to it; Notification = pty ask; AfterAgent = idle', () => {
    const s = session('gemini')
    const ps = payloads('gemini-hooks-events.jsonl')
    for (const p of ps.slice(0, 8)) s.feed(p)
    const [, child] = s.t.keys()
    const c = s.t.node(child)!
    expect(c).toMatchObject({ agentType: 'codebase_investigator', attribution: 'timing', status: 'done' })
    expect(c.report).toMatch(/^verifyBearer\(\) ->/)
    const childTools = s.ops.filter((o) => o.op === 'event.append' && o.key === child && o.event.kind === 'tool').map((o) => (o as Extract<LiveOp, { op: 'event.append' }>).event.name)
    expect(childTools).toEqual(['grep_search', 'read_file'])
    s.feed(ps[8]) // Notification ToolPermission exec
    const o = opens(s.ops)
    expect(o).toHaveLength(1)
    expect(o[0].ask).toMatchObject({ channel: 'pty', kind: 'permission', title: 'Shell npm test -- auth' })
    s.feed(ps[10]) // AfterAgent: turn over -> resolves the pty ask, idle
    expect(s.t.openAsks()).toHaveLength(0)
    expect(s.t.node('root')).toMatchObject({ status: 'needs_you', needs: 'idle' })
  })

  it('headless: hook tool lines outside a bracket are dropped (the stream has them); overlapping brackets go to the root (A8)', () => {
    const s = session('gemini', true)
    s.feed({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: 'a' } })
    expect(s.ops.filter((o) => o.op === 'event.append' && o.event.kind === 'tool')).toHaveLength(0)
    s.feed({ hook_event_name: 'BeforeTool', tool_name: 'invoke_agent', tool_input: { agent_name: 'a1' } })
    s.feed({ hook_event_name: 'BeforeTool', tool_name: 'invoke_agent', tool_input: { agent_name: 'a2' } })
    s.feed({ hook_event_name: 'BeforeTool', tool_name: 'grep_search', tool_input: { pattern: 'x' } })
    const rows = s.ops.filter((o): o is Extract<LiveOp, { op: 'event.append' }> => o.op === 'event.append' && o.event.kind === 'tool')
    expect(rows.map((r) => r.key)).toEqual(['root'])
    // no synthetic "subagents (n)" group child
    expect(s.t.keys().filter((k) => s.t.node(k)!.kind === 'subagent')).toHaveLength(2)
  })

  it('headless: stream subagent + hook bracket are one node (whichever arrives first)', () => {
    const s = session('gemini', true)
    s.feed({ hook_event_name: 'BeforeTool', tool_name: 'invoke_agent', tool_input: { agent_name: 'codebase_investigator' } })
    s.t.stream({ kind: 'subagent_start', toolUseId: 'inv-1', agentId: null, type: 'codebase_investigator', description: 'x', background: false, depth: 1, parentAgent: null, attribution: 'timing' })
    expect(s.t.keys().filter((k) => k !== 'root')).toHaveLength(1)
    expect(s.t.keyOf('inv-1')).not.toBeNull()
  })

  it('gated BeforeTool (envelope with gate_id) opens a hook_gate ask', () => {
    const s = session('gemini', true)
    s.feed({ v: 1, provider: 'gemini', received_at: 'x', gate_id: 'g1', payload: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf dist' } } })
    expect(opens(s.ops)[0]).toMatchObject({ gateId: 'g1', ask: { channel: 'hook_gate', kind: 'permission' } })
    expect(opens(s.ops)[0].ask.options.map((o) => o.kind)).toEqual(['allow', 'allow_step', 'deny'])
    s.feed({ hive: 'gate_closed', gate_id: 'g1' })
    expect(s.t.openAsks()).toHaveLength(0)
  })
})

describe('cursor hooks (docs fixture)', () => {
  it('headless: subagentStart binds to the stream Task node by tool_call_id (exact), inner conversation hooks dropped (A8), subagentStop ends it', () => {
    const s = session('cursor', true)
    s.t.stream({ kind: 'subagent_start', toolUseId: 'toolu_vrtx_01TaskA1', agentId: null, type: 'explore', description: 'Find token validation', background: false, depth: 1, parentAgent: null, attribution: 'completion', prompt: 'Find where bearer tokens are validated in this repo. Report file paths and the function chain.' })
    for (const p of payloads('cursor-hooks-events.jsonl')) s.feed(p)
    expect(s.t.keys()).toEqual(['root', 'toolu_vrtx_01TaskA1'])
    const c = s.t.node('toolu_vrtx_01TaskA1')!
    expect(c).toMatchObject({ attribution: 'exact', status: 'done', externalId: 'a7c1e2d4-5b6f-4a3c-9d8e-0f1a2b3c4d5e' })
    expect(c.report).toContain('verifyBearer()')
    // no hook tool rows at all in headless (stream is the source; inner conversation dropped)
    expect(s.ops.filter((o) => o.op === 'event.append' && o.event.kind === 'tool')).toHaveLength(0)
  })

  it('interactive: root tools from hooks, subagent lifecycle from hooks, stop = idle', () => {
    const s = session('cursor')
    for (const p of payloads('cursor-hooks-events.jsonl')) s.feed(p)
    const child = s.t.keys()[1]
    expect(child).toBe('a7c1e2d4-5b6f-4a3c-9d8e-0f1a2b3c4d5e')
    expect(s.t.node(child)!.status).toBe('done')
    const rootTools = s.ops.filter((o) => o.op === 'event.append' && o.key === 'root' && o.event.kind === 'tool')
    expect(rootTools.length).toBeGreaterThan(0)
    expect(s.ops.filter((o) => o.op === 'event.append' && o.key === child && o.event.kind === 'tool')).toHaveLength(0)
    expect(s.t.node('root')).toMatchObject({ status: 'needs_you', needs: 'idle' })
  })
})

describe('ask_user lines (hivemem, LIVE.md §4.2)', () => {
  it('opens a question ask on the agent that made the tool call; cancelled -> canceled (A4c)', () => {
    const s = session('claude', true)
    s.t.stream({ kind: 'subagent_start', toolUseId: 'T', agentId: 'A', type: 'x', description: 'd', background: false, depth: 1, parentAgent: null, attribution: 'exact' })
    s.t.stream({ kind: 'tool_use', name: 'mcp__hivemem__ask_user', id: 'tu9', input: { question: 'Which db?' }, agent: 'T' })
    s.feed({ hive: 'ask_user', gate_id: 'ask_x', question: 'Which db?', options: ['pg', 'sqlite'], agent_hint: 'tu9' })
    const o = opens(s.ops)[0]
    expect(o).toMatchObject({ key: 'T', gateId: 'ask_x', ask: { kind: 'question', channel: 'mcp', question: 'Which db?' } })
    expect(o.ask.options).toEqual([
      { id: 'choice:0', label: 'pg', kind: 'choice' },
      { id: 'choice:1', label: 'sqlite', kind: 'choice' }
    ])
    s.feed({ hive: 'ask_user_cancelled', gate_id: 'ask_x' })
    expect(resolves(s.ops)).toEqual([expect.objectContaining({ gateId: 'ask_x', status: 'canceled' })])
  })
})

describe('PTY prompts and reply keys (A9)', () => {
  it('gemini/cursor: model text quoting a dialog is not a prompt (one line, composer below, or far above the end)', () => {
    // the dialog text printed inline by the model
    expect(detectPtyPrompt('gemini', "Gemini asks: Allow execution of: 'npm'?  ● 1. Allow once\n")).toBeNull()
    // quoted dialog followed by the idle composer
    expect(detectPtyPrompt('gemini', "Allow execution of: 'npm'?\n● 1. Allow once\n  2. No\n╭──╮\n│ > Type your message or @path/to/file │\n╰──╯")).toBeNull()
    // pushed up by later transcript lines
    const later = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(detectPtyPrompt('gemini', `Allow execution of: 'npm'?\n● 1. Allow once\n${later}`)).toBeNull()
    expect(detectPtyPrompt('cursor', 'Sure. Before I start: Run this command? I will run npm test.\n')).toBeNull()
    expect(detectPtyPrompt('cursor', 'Run this command?\n  Run (once) (y)\n  Skip (esc or n)\n→ Add a follow-up')).toBeNull()
    // a live dialog with a footer still matches
    expect(detectPtyPrompt('gemini', "Shell npm test\nAllow execution of: 'npm'?\n● 1. Allow once\n  2. Allow for this session\n  3. No, suggest changes (esc)\n~/code/api   gemini-2.5-pro (99% context left)")).toMatchObject({ kind: 'permission' })
    expect(detectPtyPrompt('cursor', '$ npm test\nRun this command?\n → Run (once) (y)\n   Skip & tell the agent what to do instead (esc or n)')).toMatchObject({ title: 'Run this command?' })
  })
  it('detects per provider and returns guarded keys; never "always", trust = none', () => {
    const c = detectPtyPrompt('claude', 'Bash command\n\n  curl -s https://example.com\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No')
    expect(c).toMatchObject({ kind: 'permission', title: 'Do you want to proceed?' })
    expect(detectPtyPrompt('claude', 'Do you want to proceed?\n  (menu gone)')).toBeNull()
    expect(detectPtyPrompt('gemini', 'Allow execution of [Shell]?\n● 1. Allow once\n  2. Allow for this session')).toMatchObject({ kind: 'permission', title: 'Allow execution of [Shell]?' })
    expect(detectPtyPrompt('cursor', '$ npm test\nRun this command?\n  Run (once) (y)')).toMatchObject({ kind: 'permission', title: 'Run this command?' })
    expect(detectPtyPrompt('cursor', 'Waiting for approval...')).toMatchObject({ title: 'Waiting for approval' })
    expect(ptyReplyKeys('claude', 'permission', 'allow')).toBe('1')
    expect(ptyReplyKeys('claude', 'permission', 'deny')).toBe('\x1b')
    expect(ptyReplyKeys('gemini', 'permission', 'allow')).toBe('\r')
    expect(ptyReplyKeys('cursor', 'permission', 'deny')).toBe('n')
    expect(ptyReplyKeys('claude', 'trust', 'allow')).toBeNull()
    // A9: the guard compares the current prompt with the ask's
    expect(samePrompt(c, detectPtyPrompt('claude', 'Do you want to proceed?\n❯ 1. Yes'))).toBe(true)
    expect(samePrompt(c, detectPtyPrompt('claude', 'Do you want to make this edit to a.ts?\n❯ 1. Yes'))).toBe(false)
    expect(samePrompt(c, null)).toBe(false)
  })
})

describe('per-spawn hook renderers (LIVE.md §3.5)', () => {
  const live = { dir: '/tmp/live/s_1', hookCommand: "ELECTRON_RUN_AS_NODE=1 '/App/Hive' '/App/hive-hook.js' --events '/tmp/live/s_1/events.jsonl' --dir '/tmp/live/s_1'" }
  it('claude: --settings file with every hook async and observational (A1: no PermissionRequest gate)', () => {
    const a = claudeHooksAttach(live, { headless: false, gate: false })
    expect(a.args).toEqual(['--settings', '/tmp/live/s_1/claude-settings.json'])
    const cfg = JSON.parse(a.files[0].content)
    expect(Object.keys(cfg.hooks)).toEqual([...CLAUDE_HOOK_EVENTS])
    for (const ev of CLAUDE_HOOK_EVENTS) {
      for (const m of cfg.hooks[ev]) for (const h of m.hooks) {
        expect(h.async).toBe(true)
        expect(h.command).toBe(`${live.hookCommand} --provider claude`)
        expect(h.command).not.toContain('--gate')
      }
    }
    expect(claudeHooksAttach(live, { headless: true, gate: false }).args).toEqual([])
    expect(claudeHooksSettings(live).hooks).toHaveProperty('SubagentStart')
    // interactive argv puts --settings first
    const inv = claudeAdapter.interactive({ profile: profile('p', 'claude'), artifactsDir: '/a/', resumeId: null, hookArgs: a.args })
    expect(inv.args.slice(0, 2)).toEqual(a.args)
  })

  it('gemini: one system settings file (hooks + hivemem), admin merge (admin wins; hooks concatenated); unreadable admin skips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-gem-'))
    const admin = join(dir, 'admin.json')
    writeFileSync(admin, JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'audit' }] }] }, security: { auth: 'oauth' }, mcpServers: { corp: { command: 'c' } } }))
    const mcp = { server: { name: 'hivemem' as const, command: '/App/Hive', args: ['/App/mcp-memory.js'], env: { HIVE_MEM_GRANT: 'g' } }, toolNames: ['memory_search'] }
    const a = geminiHooksAttach({ ...live, dir }, { headless: true, gate: false, mcp, geminiAdminPath: admin })
    expect(a.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(join(dir, 'gemini-system.json'))
    const cfg = JSON.parse(a.files[0].content)
    expect(cfg.hooksConfig).toEqual({ enabled: true })
    expect(cfg.hooks.BeforeTool[0].hooks[0].command).toBe('audit')
    expect(cfg.hooks.BeforeTool[1].hooks[0].command).toContain('--provider gemini')
    expect(cfg.hooks.BeforeTool).toHaveLength(2) // no gate: HOOKS_VERIFIED.gemini is false
    expect(cfg.security).toEqual({ auth: 'oauth' })
    expect(Object.keys(cfg.mcpServers)).toEqual(['hivemem', 'corp'])
    writeFileSync(admin, '{ nope')
    const bad = geminiHooksAttach({ ...live, dir }, { headless: true, gate: true, mcp: null, geminiAdminPath: admin })
    expect(bad.files).toEqual([])
    expect(bad.warning).toMatch(/unreadable/)
    expect(mergeGeminiSettings({ hooks: { A: [1] } }, { hooks: { A: [2], B: [3] } })).toEqual({ hooks: { A: [1, 2], B: [3] } })
  })

  it('cursor: temp plugin dir, hooks.json v1 without gates while unverified; never --force for default profiles', () => {
    const a = cursorHooksAttach(live, { headless: true, gate: true })
    expect(a.args).toEqual(['--plugin-dir', '/tmp/live/s_1/cursor-plugin'])
    const hooks = JSON.parse(a.files.find((f) => f.path.endsWith('hooks.json'))!.content)
    expect(hooks.version).toBe(1)
    expect(hooks.hooks.beforeShellExecution).toBeUndefined()
    expect(JSON.parse(a.files[0].content)).toEqual({ name: 'hive' })
    const def = profile('c', 'cursor', { permissionMode: 'default' })
    const inv = cursorAdapter.headless({ profile: def, prompt: 'x', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh', hookArgs: a.args })
    expect(inv.args).not.toContain('--force')
    expect(inv.args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json'])
    expect(inv.args).toContain('--plugin-dir')
    const g = geminiAdapter.headless({ profile: profile('g', 'gemini', { permissionMode: 'default' }), prompt: 'x', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh' })
    expect(g.args.slice(0, 2)).toEqual(['-o', 'stream-json'])
    expect(g.args).toContain('default')
    expect(g.args).not.toContain('--yolo')
  })
})

describe('detectPtyPrompt on real claude output (cursor-positioned words)', () => {
  it('recognizes the permission dialog rendered with CSI column moves (claude 2.1.301)', () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'claude-pty-permission-dialog.raw.txt'), 'utf8')
    const p = detectPtyPrompt('claude', raw)
    expect(p?.kind).toBe('permission')
    expect(p?.title).toBe('Do you want to proceed?')
  })
})

describe('turn-end text for the idle row', () => {
  it('gemini AfterAgent carries prompt_response as the stop report; claude Stop carries last_assistant_message', () => {
    expect(normalizeHook('gemini', { hook_event_name: 'AfterAgent', prompt: 'q', prompt_response: 'Which file?' })).toEqual([{ kind: 'stop', background: 0, report: 'Which file?' }])
    expect(normalizeHook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Done.', background_tasks: [] })).toEqual([{ kind: 'stop', background: 0, report: 'Done.' }])
  })
})
