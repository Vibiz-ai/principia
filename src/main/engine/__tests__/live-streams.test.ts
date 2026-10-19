/**
 * LIVE.md §3: headless stream parsers -> tracker -> agent tree, against the recorded / source-built fixtures.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterId } from '../../../shared/types'
import { eventToChunk, createClaudeParser, createCursorParser, createGeminiParser, type NormalizedEvent, type StreamParser } from '../parse'
import { createAgentTracker, type AgentTracker } from '../live/tracker'
import type { LiveOp } from '../live/types'
import { readableLog } from '../adapters'

const FX = join(__dirname, 'fixtures')
const lines = (f: string): string[] => readFileSync(join(FX, f), 'utf8').split('\n').filter((l) => l.trim())

interface Replay {
  parser: StreamParser
  tracker: AgentTracker
  events: NormalizedEvent[]
  ops: LiveOp[]
  chunks: string
}
function replay(provider: AdapterId, file: string, parser: StreamParser): Replay {
  let t = 0
  const tracker = createAgentTracker({
    provider,
    root: { kind: 'step', title: 'Step', cwd: '/Users/me/code/api' },
    headless: true,
    now: () => new Date(Date.UTC(2026, 9, 16, 9, 0, 0, t++))
  })
  const ops: LiveOp[] = [...tracker.begin()]
  const events: NormalizedEvent[] = []
  let chunks = ''
  for (const l of lines(file)) {
    for (const ev of parser.line(l)) {
      events.push(ev)
      ops.push(...tracker.stream(ev))
      chunks += eventToChunk(ev) ?? ''
    }
  }
  return { parser, tracker, events, ops, chunks }
}
const subagents = (r: Replay) =>
  r.tracker
    .keys()
    .map((k) => ({ key: k, ...r.tracker.node(k)! }))
    .filter((n) => n.kind === 'subagent')
const eventsOf = (r: Replay, key: string) => r.ops.filter((o): o is Extract<LiveOp, { op: 'event.append' }> => o.op === 'event.append' && o.key === key).map((o) => o.event)

describe('claude headless stream (verified fixtures)', () => {
  it('background Bash tasks (task_type local_bash) are not subagents', () => {
    const parser = createClaudeParser()
    const tracker = createAgentTracker({ provider: 'claude', root: { kind: 'step', title: 'Step', cwd: '/x' }, headless: true })
    tracker.begin()
    const feed = (o: unknown) => parser.line(JSON.stringify(o)).forEach((e) => tracker.stream(e))
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'Wait', subagent_type: 'general-purpose', prompt: 'p' } }] } })
    feed({ type: 'system', subtype: 'task_started', task_id: 'ag1', tool_use_id: 'tu_agent', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Wait' })
    feed({ type: 'assistant', parent_tool_use_id: 'tu_agent', message: { content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'sleep 120; echo marker', run_in_background: true } }] } })
    const evs = parser.line(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu_bash', task_type: 'local_bash', is_backgrounded: true, parent_task_id: 'ag1', description: 'Sleep 120 seconds then echo marker' }))
    expect(evs).toEqual([])
    expect(parser.line(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'tu_bash', status: 'killed', summary: 'x' }))).toEqual([])
    expect(parser.line(JSON.stringify({ type: 'system', subtype: 'task_progress', task_id: 'b1', task_type: 'local_bash', description: 'x' }))).toEqual([])
    const subs = tracker.keys().map((k) => tracker.node(k)!).filter((n) => n.kind === 'subagent')
    expect(subs).toHaveLength(1)
    expect(subs[0].agentType).toBe('general-purpose')
  })

  it('foreground subagent: one node keyed by the Agent tool_use id, task_id is an alias (A6), report from handback', () => {
    const r = replay('claude', 'claude-subagent-fg.stream.jsonl', createClaudeParser())
    const subs = subagents(r)
    expect(subs).toHaveLength(1)
    const s = subs[0]
    // task_started arrives AFTER the Agent tool_use in this fixture: still one node
    expect(s.key).toBe('toolu_01UUPRzKp5J6N4qnZbR63DtG')
    expect(s.externalId).toBe('a6474ac33091f1e2b')
    expect(r.tracker.keyOf('a6474ac33091f1e2b')).toBe(s.key)
    expect(s.parentKey).toBe('root')
    expect(s.depth).toBe(1)
    expect(s.background).toBe(false)
    expect(s.agentType).toBe('general-purpose')
    expect(s.title).toBe('Read note.txt contents')
    expect(s.status).toBe('done')
    expect(s.report).toContain('hello hive')
    expect(s.toolCount).toBeGreaterThanOrEqual(1)
    // the subagent's Read is on the subagent; SubagentHandback is not a tool row
    const subTools = eventsOf(r, s.key).filter((e) => e.kind === 'tool')
    expect(subTools.map((e) => e.name)).toEqual(['Read'])
    expect(subTools[0].summary).toMatch(/^Read /)
    // the parent's own Read after the handback stays on the root
    expect(eventsOf(r, 'root').filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['Read'])
    // the root's tool count includes the Agent spawn call (Agent + its own Read), not 0/1
    expect(r.tracker.node('root')!.toolCount).toBe(2)
    // tokens from the parent's tool_result for the Agent call
    expect(s.tokensOut).toBeGreaterThan(0)
  })

  it('subagent text never reaches the step output; final = result; cost and per-model usage on the root', () => {
    const r = replay('claude', 'claude-subagent-fg.stream.jsonl', createClaudeParser())
    expect(r.parser.finalOutput('')).toContain('The subagent returned "hello hive"')
    const root = r.tracker.node('root')!
    expect(root.costUsd).toBeCloseTo(0.007934475, 8)
    expect(root.modelUsage?.['claude-haiku-5-5']?.costUsd).toBeCloseTo(0.007934475, 8)
    expect(root.model).toBe('claude-haiku-5-5')
    // live chunks: main agent only, one line for the spawn
    expect(r.chunks).toContain('→ subagent general-purpose: Read note.txt contents')
    expect(r.chunks.match(/→ Read/g)?.length).toBe(1)
    // closes stdin after the result (no background tasks)
    expect(r.ops.filter((o) => o.op === 'control.closeStdin')).toHaveLength(1)
  })

  it('background subagent: 3 results + 2 extra inits; output = last non-empty result; stdin closes only when no bg task runs', () => {
    const r = replay('claude', 'claude-subagent-bg.stream.jsonl', createClaudeParser())
    expect(r.events.filter((e) => e.kind === 'session')).toHaveLength(1) // repeated init is idempotent
    expect(r.events.filter((e) => e.kind === 'result')).toHaveLength(3)
    expect(r.parser.finalOutput('')).toContain('The subagent reported that note.txt contains')
    expect(r.parser.result()?.costUsd).toBeCloseTo(0.00726748, 8)
    const [s] = subagents(r)
    expect(s.background).toBe(true)
    expect(s.status).toBe('done')
    expect(s.report).toContain('hello hive')
    expect(subagents(r)).toHaveLength(1)
    expect(r.ops.filter((o) => o.op === 'control.closeStdin')).toHaveLength(1)
  })

  it('close-stdin waits for background tasks after a result', () => {
    const t = createAgentTracker({ provider: 'claude', root: { kind: 'step', title: 's', cwd: '/' }, headless: true })
    const p = createClaudeParser()
    const feed = (o: unknown): LiveOp[] => p.line(JSON.stringify(o)).flatMap((e) => t.stream(e))
    feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] })
    expect(feed({ type: 'result', subtype: 'success', result: 'launched', is_error: false }).some((o) => o.op === 'control.closeStdin')).toBe(false)
    expect(feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }).some((o) => o.op === 'control.closeStdin')).toBe(true)
  })

  it('partial messages: stream_event deltas are ignored; same tree as without', () => {
    const r = replay('claude', 'claude-subagent-partial.stream.jsonl', createClaudeParser())
    expect(subagents(r)).toHaveLength(1)
    expect(subagents(r)[0].status).toBe('done')
    expect(r.parser.finalOutput('').length).toBeGreaterThan(0)
  })

  it('can_use_tool on the main agent -> stdio permission ask on the root', () => {
    const r = replay('claude', 'claude-sdk-can-use-tool.stream.jsonl', createClaudeParser())
    const opens = r.ops.filter((o): o is Extract<LiveOp, { op: 'ask.open' }> => o.op === 'ask.open')
    expect(opens).toHaveLength(1)
    expect(opens[0].key).toBe('root')
    expect(opens[0].gateId).toBe('babb3ac2-a9a1-4303-9815-788efaa21353')
    expect(opens[0].ask).toMatchObject({ kind: 'permission', channel: 'stdio', toolName: 'Bash' })
    expect(opens[0].ask.title).toMatch(/^Bash curl -s/)
    expect(opens[0].ask.options.map((o) => o.kind)).toEqual(['allow', 'allow_step', 'deny'])
    expect(opens[0].ask.expiresAt).not.toBeNull()
    expect(r.tracker.node('root')!.status).toBe('needs_you')
    expect(r.tracker.node('root')!.needs).toBe('permission')
  })

  it('can_use_tool from inside a subagent -> ask pinned on that child (agent_id alias)', () => {
    const r = replay('claude', 'claude-sdk-subagent-can-use-tool.stream.jsonl', createClaudeParser())
    const [s] = subagents(r)
    const open = r.ops.find((o): o is Extract<LiveOp, { op: 'ask.open' }> => o.op === 'ask.open')!
    expect(open.key).toBe(s.key)
    // replayed without an answer: the subagent's end cancels its open ask (no stuck asks, A4)
    expect(r.ops.find((o) => o.op === 'ask.resolve')).toMatchObject({ gateId: open.gateId, status: 'canceled' })
    // live: answer right after the request -> back to working
    const t = createAgentTracker({ provider: 'claude', root: { kind: 'step', title: 's', cwd: '/' }, headless: true })
    const p = createClaudeParser()
    for (const l of lines('claude-sdk-subagent-can-use-tool.stream.jsonl')) {
      const evs = p.line(l)
      for (const e of evs) t.stream(e)
      if (evs.some((e) => e.kind === 'permission_request')) break
    }
    expect(t.node(s.key)!.status).toBe('needs_you')
    expect(t.node('root')!.status).not.toBe('needs_you') // parents are not marked (rollup is UI)
    const ops = t.answered(open.gateId, 'Allowed in Hive')
    expect(ops.find((o) => o.op === 'ask.resolve')).toMatchObject({ via: 'hive', status: 'answered', key: s.key })
    expect(t.node(s.key)!.status).toBe('working')
  })

  it('readableLog drops subagent text (main agent only)', () => {
    const raw = lines('claude-subagent-fg.stream.jsonl').join('\n')
    const out = readableLog('claude', raw)
    expect(out).toContain('→ subagent general-purpose')
    expect(out).not.toContain('hello hive\n→') // the subagent's prompt / text are not in the main transcript
  })
})

describe('gemini headless stream (source-built fixtures)', () => {
  it('invoke_agent -> timing subagent; deltas concatenated; tokens by model, no cost', () => {
    const r = replay('gemini', 'gemini-stream-subagent.jsonl', createGeminiParser())
    const [s] = subagents(r)
    expect(subagents(r)).toHaveLength(1)
    expect(s).toMatchObject({ key: 'invoke_agent-1760605922415-a1b2c3', agentType: 'codebase_investigator', attribution: 'timing', status: 'done' })
    expect(r.parser.finalOutput('')).toBe('Tokens are verified in `verifyBearer()` (src/server/auth.ts), which checks the JWKS by `kid` and caches results for 60s.')
    const root = r.tracker.node('root')!
    expect(root.costUsd).toBeNull()
    expect(root.tokensIn).toBe(45102)
    expect(root.modelUsage?.['gemini-2.5-flash']).toEqual({ tokensIn: 16702, tokensOut: 1399, costUsd: null })
    expect(root.model).toBe('gemini-2.5-pro')
    expect(eventsOf(r, 'root').filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['read_file', 'mcp_hivemem_memory_save'])
    expect(r.parser.incomplete?.()).toBeNull()
  })

  it('policy denials are denied tool rows + one status notice; EOF without result is incomplete', () => {
    const r = replay('gemini', 'gemini-stream-denied.jsonl', createGeminiParser())
    const states = r.ops.filter((o): o is Extract<LiveOp, { op: 'event.update' }> => o.op === 'event.update').map((o) => o.patch.state)
    expect(states).toEqual(['denied', 'denied', 'denied'])
    expect(eventsOf(r, 'root').filter((e) => e.kind === 'status').map((e) => e.summary)).toEqual(["Gemini can't ask in headless mode yet; denied"])
    expect(eventsOf(r, 'root').some((e) => e.kind === 'error' && /Loop detected/.test(e.summary))).toBe(true)
    const p = createGeminiParser()
    p.line('{"type":"init","session_id":"x","model":"m"}')
    expect(p.incomplete?.()).toBe('Gemini ended without a result')
  })

  it('custom agent names (.gemini/agents) count as subagents', () => {
    const p = createGeminiParser({ agentNames: ['reviewer'] })
    const ev = p.line('{"type":"tool_use","tool_name":"reviewer","tool_id":"r1","parameters":{"prompt":"check"}}')
    expect(ev[0]).toMatchObject({ kind: 'subagent_start', type: 'reviewer', toolUseId: 'r1', attribution: 'timing' })
  })
})

describe('cursor headless stream (bundled-code fixture)', () => {
  it('Task -> subagent with the transcript at completion; tools, todos, questions, usage', () => {
    const r = replay('cursor', 'cursor-stream-subagent.jsonl', createCursorParser())
    const [s] = subagents(r)
    expect(subagents(r)).toHaveLength(1)
    expect(s).toMatchObject({ key: 'toolu_vrtx_01TaskA1', agentType: 'explore', attribution: 'completion', status: 'done', model: 'composer-2' })
    expect(s.externalId).toBe('a7c1e2d4-5b6f-4a3c-9d8e-0f1a2b3c4d5e')
    expect(s.report).toBe('verifyBearer() in src/server/auth.ts -> getKey(kid) -> JWKS cache (60s).')
    expect(eventsOf(r, s.key).filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['grep', 'read'])
    expect(eventsOf(r, s.key).filter((e) => e.kind === 'text')).toHaveLength(2)
    // root: shell failure + hivemem MCP call; question skipped notice
    expect(eventsOf(r, 'root').filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['shell', 'mcp:hivemem.memory_save'])
    const shellUpd = r.ops.find((o): o is Extract<LiveOp, { op: 'event.update' }> => o.op === 'event.update' && o.toolUseId === 'toolu_vrtx_01Shell1')!
    expect(shellUpd.patch.state).toBe('error')
    expect(shellUpd.patch.detail).toContain('2 failed')
    expect(eventsOf(r, 'root').some((e) => e.kind === 'status' && e.summary === 'Question skipped in headless mode')).toBe(true)
    expect(r.tracker.node('root')!).toMatchObject({ tokensIn: 12034, tokensOut: 1877, costUsd: null, model: 'Claude 4.5 Sonnet' })
    expect(r.parser.finalOutput('')).toBe('Two auth tests fail because the JWKS mock expires; details above.')
  })
})
