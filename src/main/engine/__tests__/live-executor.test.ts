/**
 * LIVE.md §3.1, §4.2–4.4, A4/A5: headless steps pause on a question and resume with the user's answer. A fake claude
 * (a real `node` child) speaks the stream-json stdin control protocol and the hivemem ask_user file protocol; a fake
 * LiveBridge tails events.jsonl and writes answer files like main's bridge.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeBridge } from './liveFakes'
import type { AgentNode, Ask } from '../../../shared/live'
import type { EngineEvent, Workflow } from '../../../shared/types'
import { claudeAdapter, type Adapter } from '../adapters'
import { startProcess } from '../process'
import { fakeCtx, makeEngine, profile, waitRun, type FakeCtx } from './fakes'
import { createEngineWith } from '../index'
import { fakeProviders } from './fakes'

const FX = join(__dirname, 'fixtures')

/**
 * Fake claude. argv: [scenario, ...the real claude argv]. Reads stdin JSONL like `--input-format stream-json`.
 * Simulated time: 1 real ms = SCALE simulated ms, so a "5 minute" ask_user wait takes 300 real ms; the MCP client
 * timeout is MCP_TOOL_TIMEOUT (simulated ms; claude's default is emulated as 60 s when unset).
 */
const FAKE_CLAUDE = String.raw`
const fs = require('fs'), path = require('path')
const [scenario, ...argv] = process.argv.slice(1)
const SCALE = 1000
const w = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sid = argv[argv.indexOf('--session-id') + 1] || 'sid'
let buf = '', queue = [], waiters = []
const deliver = () => { for (const w of [...waiters]) { const i = queue.findIndex(w.pred); if (i >= 0) { const [m] = queue.splice(i, 1); waiters = waiters.filter((x) => x !== w); w.res(m) } } }
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) queue.push(JSON.parse(l)) } deliver() })
process.stdin.on('end', () => process.exit(0))
const next = (pred) => new Promise((res) => { waiters.push({ pred, res }); deliver() })
const result = (text) => w({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.002, num_turns: 2, usage: { input_tokens: 3, output_tokens: 4 } })
const ask = async (rid, cmd, agent) => {
  w({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: cmd }, description: 'Run ' + cmd, permission_suggestions: [], tool_use_id: 't-' + rid, ...(agent ? { agent_id: agent } : {}) } })
  const r = await next((m) => m.type === 'control_response' && m.response && m.response.request_id === rid)
  return r.response.response
}
;(async () => {
  const init = await next((m) => m.type === 'control_request')
  w({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: {} } })
  const user = await next((m) => m.type === 'user')
  w({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' })
  if (scenario === 'permission' || scenario === 'twice') {
    w({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't-r1', name: 'Bash', input: { command: 'curl x' } }] }, parent_tool_use_id: null })
    const d = await ask('r1', 'curl x')
    let d2 = null
    if (scenario === 'twice') d2 = await ask('r2', 'curl y')
    w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-r1', is_error: d.behavior !== 'allow', content: d.behavior === 'allow' ? '200' : d.message }] }, parent_tool_use_id: null })
    result('decision=' + d.behavior + (d.message ? ' msg=' + d.message : '') + (d.updatedInput ? ' input=' + JSON.stringify(d.updatedInput) : '') + (d2 ? ' second=' + d2.behavior : '') + ' prompt=' + user.message.content)
  } else if (scenario === 'expire' || scenario === 'cancel') {
    const d = await ask('r1', 'curl x')
    result('decision=' + d.behavior + ' msg=' + d.message)
  } else if (scenario === 'exit-while-asking') {
    w({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' } } })
    setTimeout(() => process.exit(3), 50)
  } else if (scenario === 'ask_user' || scenario === 'ask_user_noenv') {
    if (scenario === 'ask_user_noenv') delete process.env.MCP_TOOL_TIMEOUT
    const cfgPath = argv[argv.indexOf('--mcp-config') + 1]
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const env = cfg.mcpServers.hivemem.env
    const allowed = argv[argv.indexOf('--allowedTools') + 1]
    const live = env.HIVE_LIVE_DIR
    w({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-ask', name: 'mcp__hivemem__ask_user', input: { question: 'Which database?' } }] }, parent_tool_use_id: null })
    // what hivemem does: append the ask line, wait for the answer file
    fs.appendFileSync(path.join(live, 'events.jsonl'), JSON.stringify({ hive: 'ask_user', gate_id: 'ask_g1', question: 'Which database?', options: ['postgres', 'sqlite'], agent_hint: 'tu-ask' }) + '\n')
    const timeoutSim = Number(process.env.MCP_TOOL_TIMEOUT || 60000)
    const t0 = Date.now()
    const file = path.join(live, 'answers', 'ask_g1.json')
    const iv = setInterval(() => {
      const simElapsed = (Date.now() - t0) * SCALE
      if (fs.existsSync(file)) {
        clearInterval(iv)
        const a = JSON.parse(fs.readFileSync(file, 'utf8'))
        w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-ask', is_error: false, content: JSON.stringify(a) }] }, parent_tool_use_id: null })
        result('answer=' + a.answer + ' waitedSim=' + Math.round(simElapsed / 60000) + 'min allowed=' + allowed + ' timeout=' + process.env.MCP_TOOL_TIMEOUT)
      } else if (simElapsed > timeoutSim) {
        clearInterval(iv)
        w({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-ask', is_error: true, content: 'MCP error -32001: Request timed out' }] }, parent_tool_use_id: null })
        w({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'MCP tool ask_user timed out' })
        process.exit(1)
      }
    }, 10)
  } else if (scenario === 'fixture') {
    for (const l of fs.readFileSync(argv[0] === '--fixture' ? argv[1] : '', 'utf8').split('\n')) if (l.trim()) process.stdout.write(l + '\n')
  }
})()
`

function fakeClaude(scenario: string, extraArgs: string[] = []): Adapter {
  return {
    ...claudeAdapter,
    headless(req) {
      const real = claudeAdapter.headless(req)
      return { ...real, args: ['-e', FAKE_CLAUDE, scenario, ...extraArgs, ...real.args] }
    }
  }
}

function setup(permissionMode: 'default' | 'bypass' = 'default'): FakeCtx & { bridge: ReturnType<typeof fakeBridge> } {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude', { permissionMode }))
  const bridge = fakeBridge(ctx.root)
  ctx.live = bridge
  ctx.memory = {
    grant: () => null,
    release: () => {},
    askOnlyServer: () => ({ name: 'hivemem', command: process.execPath, args: ['/dev/null'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  }
  return Object.assign(ctx, { bridge })
}

const asksOf = (ctx: FakeCtx): Ask[] => ctx.events.filter((e): e is Extract<EngineEvent, { type: 'ask.updated' }> => e.type === 'ask.updated').map((e) => e.ask)
const agentsOf = (ctx: FakeCtx): Map<string, AgentNode> => {
  const m = new Map<string, AgentNode>()
  for (const e of ctx.events) if (e.type === 'agent.updated') m.set(e.agent.id, e.agent)
  return m
}
async function waitFor<T>(f: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 15))
  }
}
const openAsk = (ctx: FakeCtx): Promise<Ask> => waitFor(() => asksOf(ctx).find((a) => a.status === 'open'))

describe('headless claude: stdio permission asks (LIVE.md §3.1, §4.3)', () => {
  it('pauses on can_use_tool, Allow writes control_response with the original input, step passes', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('permission') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'check the site' }, { trigger: 'manual' })
    const ask = await openAsk(ctx)
    expect(ask).toMatchObject({ kind: 'permission', channel: 'stdio', toolName: 'Bash', runId: run.id, title: 'Bash curl x' })
    const root = await waitFor(() => [...agentsOf(ctx).values()].find((a) => a.kind === 'step' && a.status === 'needs_you'))
    expect(root.needs).toBe('permission')
    expect(ask.agentId).toBe(root.id)
    const answered = engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'allow' })
    expect(answered).toMatchObject({ status: 'answered', answeredVia: 'hive' })
    expect(() => engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'allow' })).toThrow(/Already answered/)
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('passed')
    const step = ctx.store.stepsOf(run.id)[0]
    expect(step.output).toContain('decision=allow')
    expect(step.output).toContain('input={"command":"curl x"}')
    expect(step.output).toContain('prompt=') // the prompt went over stdin
    expect(step.output).toContain('check the site')
    const final = agentsOf(ctx).get(root.id)!
    expect(final).toMatchObject({ status: 'done', costUsd: 0.002, runId: run.id, stepId: step.id, kind: 'step' })
  })

  it('Deny with a message reaches the agent; a denied tool does not fail the step (no "set bypass" error)', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('permission') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const ask = await openAsk(ctx)
    expect(() => engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'nope' })).toThrow(/not offered/)
    engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'deny', message: 'use wget' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('passed')
    expect(ctx.store.stepsOf(run.id)[0].output).toContain('decision=deny msg=use wget')
  })

  it('Allow for this step: the same tool is allowed again without a second ask', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('twice') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const ask = await openAsk(ctx)
    engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'allow_step' })
    await waitRun(ctx, run.id)
    expect(ctx.store.stepsOf(run.id)[0].output).toContain('second=allow')
    expect(new Set(asksOf(ctx).map((a) => a.id)).size).toBe(1)
  })

  it('expiry: no answer -> deny on stdin, ask expired/timeout', async () => {
    const ctx = setup()
    const engine = createEngineWith(ctx, { adapters: { claude: fakeClaude('expire') }, detect: fakeProviders(), askTimeoutMs: 150 })
    await engine.init()
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    await waitRun(ctx, run.id)
    expect(ctx.store.stepsOf(run.id)[0].output).toContain('No answer from the user within 60 min')
    expect(asksOf(ctx).at(-1)).toMatchObject({ status: 'expired', answeredVia: 'timeout' })
  })

  it('cancel: open asks are canceled first (deny "Run canceled"), then the tree is killed', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('cancel') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    await openAsk(ctx)
    await engine.runs.cancel(run.id)
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('canceled')
    expect(asksOf(ctx).at(-1)!.status).toBe('canceled')
    const root = [...agentsOf(ctx).values()].find((a) => a.kind === 'step')!
    expect(root.status).toBe('canceled')
  })

  it('A4a: the process exits while asking -> the ask is canceled at once, no stuck Needs you', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('exit-while-asking') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    const asks = asksOf(ctx)
    expect(asks[0].status).toBe('open')
    expect(asks.at(-1)).toMatchObject({ id: asks[0].id, status: 'canceled' })
    expect([...agentsOf(ctx).values()].find((a) => a.kind === 'step')!.status).toBe('failed')
  })

  it('the step timeout clock pauses while an ask is open (process level)', async () => {
    const h = startProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 400)'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 150,
      onStdout: () => {},
      onStderr: () => {}
    })
    h.pauseTimeout()
    await new Promise((r) => setTimeout(r, 250))
    h.resumeTimeout() // ~150 ms left, the child exits at 400 ms total -> times out at ~400 only if paused worked
    const r = await h.done
    expect(r.timedOut).toBe(true)
    const h2 = startProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 300)'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200,
      onStdout: () => {},
      onStderr: () => {}
    })
    h2.pauseTimeout()
    const r2 = await h2.done // never resumed: no timeout
    expect(r2.timedOut).toBe(false)
    expect(r2.exitCode).toBe(0)
  })
})

describe('ask_user over hivemem (LIVE.md §4.2, A5)', () => {
  it('attaches hivemem (ask-only) to a headless claude step with memory off; a 5-minute wait does not error; the answer comes back', async () => {
    const ctx = setup('bypass')
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('ask_user') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'pick a db' }, { trigger: 'manual' })
    const ask = await openAsk(ctx)
    expect(ask).toMatchObject({ kind: 'question', channel: 'mcp', question: 'Which database?' })
    expect(ask.options.map((o) => o.label)).toEqual(['postgres', 'sqlite'])
    // wait "5 minutes" (simulated: 300 ms real) before answering
    await new Promise((r) => setTimeout(r, 300))
    expect(() => engine.asks!.answer(ask.id, { askId: ask.id })).toThrow(/empty/)
    engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'choice:1' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('passed')
    const out = ctx.store.stepsOf(run.id)[0].output!
    expect(out).toContain('answer=sqlite')
    expect(out).toMatch(/waitedSim=[5-9]min/)
    expect(out).toContain('allowed=mcp__hivemem__ask_user')
    expect(out).toContain('timeout=3700000')
    expect(asksOf(ctx).at(-1)).toMatchObject({ status: 'answered', answeredVia: 'hive', answer: { optionId: 'choice:1' } })
    // the ask's agent is the root (the tool call was the main agent's)
    const root = [...agentsOf(ctx).values()].find((a) => a.kind === 'step')!
    expect(ask.agentId).toBe(root.id)
    // the live dir was closed
    expect(existsSync(ctx.bridge.channels[0].dir)).toBe(false)
  })

  it('control: without MCP_TOOL_TIMEOUT the same slow answer errors (the fake emulates the 60 s client default)', async () => {
    const ctx = setup('bypass')
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('ask_user_noenv') } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    await openAsk(ctx)
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    expect(ctx.store.stepsOf(run.id)[0].error).toContain('timed out')
    // the CLI gave up and exited: the ask is closed (A4/A5), nobody is left waiting
    expect(asksOf(ctx).at(-1)!.status).toBe('canceled')
  })
})

describe('live subagent tree from a step (F1)', () => {
  it('replays the recorded fg stream through the executor: root + child, child parented, step output = main agent only', async () => {
    const ctx = setup('bypass')
    const engine = await makeEngine(ctx, { adapters: { claude: fakeClaude('fixture', ['--fixture', join(FX, 'claude-subagent-fg.stream.jsonl')]) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('passed')
    const agents = [...agentsOf(ctx).values()]
    const root = agents.find((a) => a.kind === 'step')!
    const child = agents.find((a) => a.kind === 'subagent')!
    expect(child).toMatchObject({ parentId: root.id, rootId: root.id, runId: run.id, status: 'done', agentType: 'general-purpose', externalId: 'a6474ac33091f1e2b' })
    expect(root.status).toBe('done')
    expect(ctx.store.stepsOf(run.id)[0].output).toBe('The subagent returned "hello hive", which matches note.txt when I read the file directly.')
    const evs = ctx.events.filter((e): e is Extract<EngineEvent, { type: 'agent.events' }> => e.type === 'agent.events' && e.agentId === child.id).flatMap((e) => e.events)
    expect(evs.some((e) => e.kind === 'tool' && e.name === 'Read' && e.state === 'ok')).toBe(true)
    const chunks = ctx.events.filter((e) => e.type === 'step.output').map((e) => (e as { chunk: string }).chunk).join('')
    expect(chunks).not.toContain('Read note.txt in the current directory')
  })

  it('shell steps get a root agent with the command as activity', async () => {
    const ctx = setup('bypass')
    ctx.workflows.clear()
    const engine = await makeEngine(ctx)
    const wf: Workflow = { id: 'wf_1', name: 'w', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'List', after: [], cwd: null, timeoutMin: 1, command: 'echo hi' }], createdAt: '', updatedAt: '' }
    ctx.workflows.set(wf.id, wf)
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    await waitRun(ctx, run.id)
    const root = [...agentsOf(ctx).values()].find((a) => a.kind === 'step')!
    expect(root).toMatchObject({ provider: 'shell', title: 'List', status: 'done' })
    // events are not flooded with shell lines
    expect(ctx.events.filter((e) => e.type === 'agent.events')).toHaveLength(0)
  })
})
