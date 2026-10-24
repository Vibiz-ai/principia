import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryBridge, MemoryGrant, MemoryGrantRequest } from '../../../shared/engine'
import type { CheckNode, WorkflowDraft, WorkflowNode } from '../../../shared/types'
import { claudeAdapter, codexAdapter, readableLog } from '../adapters'
import { createEngineWith } from '../index'
import {
  LEGACY_MEMORY_WRITE_RULES,
  MCP_VERIFIED,
  MEMORY_WRITE_RULES,
  agentBrief,
  claudeMcpAttach,
  codexMcpAttach,
  geminiMcpAttach,
  memoryToolLine,
  memoryTransport,
  nodeMemoryMode,
  withBrief
} from '../memory'
import { createCodexParser, eventToChunk } from '../parse'
import { validateWorkflow } from '../validate'
import { addWorkflow, fakeAdapter, fakeCtx, fakeProviders, makeEngine, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'

// ---------- fakes ----------

const READ = ['memory_search', 'memory_get']
const WRITE = ['memory_write', 'memory_invalidate']

interface FakeBridge extends MemoryBridge {
  requests: MemoryGrantRequest[]
  released: string[]
  open: Set<string>
}
function fakeBridge(ctx: FakeCtx, opts: { brief?: string; fail?: 'null' | 'throw' } = {}): FakeBridge {
  let n = 0
  const b: FakeBridge = {
    requests: [],
    released: [],
    open: new Set(),
    grant(req) {
      b.requests.push(req)
      if (opts.fail === 'null') return null
      if (opts.fail === 'throw') throw new Error('db locked')
      const grantId = `mgr_${String(++n).padStart(10, '0')}`
      b.open.add(grantId)
      const g: MemoryGrant = {
        grantId,
        server: {
          name: 'hivemem',
          command: '/Applications/Hive.app/Contents/MacOS/Hive',
          args: ['/x/out/main/mcp-memory.js'],
          env: { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_DB: '/x/memory.db', HIVE_MEM_GRANT: grantId, HIVE_MEM_FP: '/x/fp.json' }
        },
        toolNames: req.mode === 'read-write' && req.transport === 'mcp' ? [...READ, ...WRITE] : req.transport === 'mcp' ? READ : [],
        spawnDir: join(ctx.root, 'memory', 'spawn'),
        brief: opts.brief ?? `<hive-memory scope="test">\n- [gotcha] db: rebuild for Electron [${grantId}]\n</hive-memory>`
      }
      return g
    },
    release(id) {
      b.released.push(id)
      b.open.delete(id)
    }
  }
  return b
}

const agent = (id: string, prompt: string, x: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'agent', label: id, after: [], cwd: null, timeoutMin: 1, profileId: 'p_claude', prompt, ...x }) as WorkflowNode
const check = (id: string, target: string, x: Partial<CheckNode> = {}): CheckNode => ({
  id,
  type: 'check',
  label: id,
  after: [target],
  cwd: null,
  timeoutMin: 1,
  profileId: 'p_claude',
  command: null,
  target,
  criteria: 'be good',
  maxRetries: 2,
  ...x
})

function setup(bridgeOpts?: Parameters<typeof fakeBridge>[1]) {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  ctx.profiles.set('p_cursor', profile('p_cursor', 'cursor'))
  const bridge = fakeBridge(ctx, bridgeOpts)
  ctx.memory = bridge
  return { ctx, bridge }
}

const grantOf = (i: number): MemoryGrant => ({
  grantId: `mgr_000000000${i}`,
  server: { name: 'hivemem', command: '/bin/hive', args: ['/x/mcp-memory.js'], env: { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_GRANT: `mgr_000000000${i}` } },
  toolNames: [...READ, ...WRITE],
  spawnDir: '/tmp/hive-spawn',
  brief: '<hive-memory>\n- x\n</hive-memory>'
})

/** Variadic claude options must be followed by another flag, never by the positional prompt. */
function assertVariadicSafe(args: string[]): void {
  for (const opt of ['--mcp-config', '--allowedTools']) {
    const i = args.indexOf(opt)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 2]?.startsWith('--')).toBe(true)
  }
}

// ---------- adapters ----------

describe('memory: adapter rendering', () => {
  it('claude headless: mcp args right after --verbose, followed by a flag; prompt on stdin (LIVE.md §3.1)', () => {
    const att = claudeMcpAttach(grantOf(1))
    for (const resumeId of [null, 'sess-1']) {
      const inv = claudeAdapter.headless({ profile: null, prompt: 'do it', artifactsDir: '/a/', resumeId, shell: '/bin/sh', mcpArgs: att.args })
      const v = inv.args.indexOf('--verbose')
      expect(inv.args.slice(v + 1, v + 5)).toEqual(att.args)
      assertVariadicSafe(inv.args)
      expect(inv.args).not.toContain('do it')
      expect(inv.stdin?.lines[1]).toContain('"content":"do it"')
      expect(inv.args).not.toContain('--strict-mcp-config')
    }
  })

  it('claude headless without memory is unchanged', () => {
    const inv = claudeAdapter.headless({ profile: null, prompt: 'p', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh' })
    expect(inv.args).not.toContain('--mcp-config')
    expect(inv.args[inv.args.indexOf('--verbose') + 1]).toBe('--session-id')
  })

  it('claude interactive: mcp args first, brief appended to the system prompt', () => {
    const att = claudeMcpAttach(grantOf(1))
    const inv = claudeAdapter.interactive({ profile: profile('p', 'claude'), artifactsDir: '/a/', resumeId: null, mcpArgs: att.args, memoryBrief: 'BRIEF' })
    expect(inv.args.slice(0, 4)).toEqual(att.args)
    assertVariadicSafe(inv.args)
    const sp = inv.args[inv.args.indexOf('--append-system-prompt') + 1]
    expect(sp).toContain('$ARTIFACTS_DIR')
    expect(sp.endsWith('BRIEF')).toBe(true)
    // Restart / Open as session resumes (PROACTIVE.md §4): the brief is passed again (claude's system prompt snapshot
    // wins until a compaction, which then renders it from this text instead of losing it), everything else stays
    const re = claudeAdapter.interactive({ profile: profile('p', 'claude'), artifactsDir: '/a/', resumeId: 'u9', mcpArgs: att.args, memoryBrief: 'BRIEF' })
    expect(re.args[re.args.indexOf('--append-system-prompt') + 1]!.endsWith('BRIEF')).toBe(true)
    expect(re.args.slice(0, 4)).toEqual(att.args)
    expect(re.args[re.args.indexOf('--resume') + 1]).toBe('u9')
  })

  it('claude config: stdio hivemem with the server env, prefixed tool allowlist', () => {
    const g = grantOf(3)
    const att = claudeMcpAttach({ ...g, toolNames: READ })
    expect(att.files).toHaveLength(1)
    expect(att.files[0].path).toBe('/tmp/hive-spawn/mgr_0000000003.mcp.json')
    const cfg = JSON.parse(att.files[0].content)
    expect(cfg.mcpServers.hivemem).toEqual({ type: 'stdio', command: '/bin/hive', args: ['/x/mcp-memory.js'], env: g.server.env })
    expect(att.args[3]).toBe('mcp__hivemem__memory_search,mcp__hivemem__memory_get')
    expect(att.env).toEqual({}) // ELECTRON_RUN_AS_NODE only inside the server config, never the agent env
  })

  it('codex: per-invocation -c overrides placed before the positional prompt', () => {
    const att = codexMcpAttach(grantOf(1))
    expect(att.args).toContain('mcp_servers.hivemem.command="/bin/hive"')
    expect(att.args).toContain('mcp_servers.hivemem.args=["/x/mcp-memory.js"]')
    expect(att.args).toContain('mcp_servers.hivemem.default_tools_approval_mode="approve"')
    expect(att.env).toEqual({}) // Electron Node mode belongs only to the MCP child, never the Codex CLI
    expect(att.files).toEqual([])
    expect(att.args).toContain('mcp_servers.hivemem.env.HIVE_MEM_GRANT="mgr_0000000001"')
    expect(att.args).toContain('mcp_servers.hivemem.enabled_tools=["memory_search","memory_get","memory_write","memory_invalidate"]')
    const inv = codexAdapter.headless({ profile: null, prompt: 'go', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh', mcpArgs: att.args })
    expect(inv.args[0]).toBe('exec')
    expect(inv.args[inv.args.length - 1]).toContain('go')
    expect(inv.args.indexOf('-c')).toBeLessThan(inv.args.length - 1)
  })

  it('gemini: system settings file via env, no argv', () => {
    const att = geminiMcpAttach(grantOf(2))
    expect(att.args).toEqual([])
    expect(att.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe('/tmp/hive-spawn/mgr_0000000002.gemini.json')
    const s = JSON.parse(att.files[0].content)
    expect(s.mcpServers.hivemem.trust).toBe(true)
    expect(s.mcpServers.hivemem.includeTools).toEqual([...READ, ...WRITE])
  })

  // PASSPORT.md §7.2: Claude stays on MCP; Codex, Gemini and Cursor stay inject-only and get the harvest path (§7.6)
  it('transports: Claude MCP; Codex/Gemini/Cursor inject; shell none', () => {
    expect(MCP_VERIFIED.claude).toBe(true)
    expect(memoryTransport('claude')).toBe('mcp')
    expect(MCP_VERIFIED.codex).toBe(false)
    expect(memoryTransport('codex')).toBe('inject')
    expect(memoryTransport('gemini')).toBe('inject')
    expect(memoryTransport('cursor')).toBe('inject')
    expect(memoryTransport('shell')).toBeNull()
  })

  it('mode clamps: shell + command checks off, reviewer max read, absent off', () => {
    expect(nodeMemoryMode(agent('a', 'x'))).toBe('off')
    expect(nodeMemoryMode(agent('a', 'x', { memory: 'read-write' }))).toBe('read-write')
    expect(nodeMemoryMode({ id: 's', type: 'shell', label: '', after: [], cwd: null, timeoutMin: 1, command: 'ls', memory: 'read' })).toBe('off')
    expect(nodeMemoryMode(check('c', 'a', { memory: 'read-write' }))).toBe('read')
    expect(nodeMemoryMode(check('c', 'a', { profileId: null, command: 'npm test', memory: 'read' }))).toBe('off')
    expect(withBrief('', 'p')).toBe('p')
    expect(withBrief('B', 'p')).toBe('B\n\np')
  })

  it('write rules: only when the spawn can write (MCP attached + memory_write granted)', () => {
    const g = (toolNames: string[], brief = 'B'): MemoryGrant => ({
      grantId: 'mgr_1',
      server: { name: 'hivemem', command: 'x', args: [], env: {} },
      toolNames,
      spawnDir: '/tmp',
      brief
    })
    expect(agentBrief(g([...READ, ...WRITE]), true)).toBe(`B\n\n${MEMORY_WRITE_RULES}`)
    expect(agentBrief(g([...READ, ...WRITE], ''), true)).toBe(MEMORY_WRITE_RULES)
    expect(agentBrief(g([...READ, ...WRITE]), false)).toBe('B') // inject fallback: no write tools reachable
    expect(agentBrief(g(READ), true)).toBe('B')
    expect(agentBrief(g(READ, ''), true)).toBe('')
    expect(MEMORY_WRITE_RULES).toContain('memory_search')
    expect(MEMORY_WRITE_RULES).toMatch(/states outright/)
    expect(MEMORY_WRITE_RULES).toMatch(/Never write and then invalidate your own/)
  })
})

// ---------- readable tool calls ----------

describe('memory: readable tool-call lines', () => {
  it('renders hivemem calls and leaves other tools alone', () => {
    expect(memoryToolLine('mcp__hivemem__memory_write', { entity: 'auth-service', facts: [{}, {}] })).toBe('[memory] write auth-service (2 facts)')
    expect(memoryToolLine('mcp__hivemem__memory_write', { entity: 'db', facts: [{}], relations: [{}] })).toBe('[memory] write db (1 fact, 1 relation)')
    expect(memoryToolLine('mcp__hivemem__memory_search', { query: 'sqlite rebuild' })).toBe('[memory] search "sqlite rebuild"')
    expect(memoryToolLine('mcp__hivemem__memory_get', { names: ['a', 'b'] })).toBe('[memory] get a, b')
    expect(memoryToolLine('hivemem.memory_invalidate', { ids: ['mfa_1'], reason: 'stale' })).toBe('[memory] invalidate 1 item: stale')
    expect(memoryToolLine('mcp__other__memory_write', {})).toBeNull()
    expect(memoryToolLine('Read', {})).toBeNull()
    expect(eventToChunk({ kind: 'tool_use', name: 'mcp__hivemem__memory_search', input: { query: 'x' } })).toBe('[memory] search "x"\n')
    expect(eventToChunk({ kind: 'tool_use', name: 'Bash' })).toBe('→ Bash\n')
  })

  it('codex mcp_tool_call on hivemem is recognized', () => {
    const p = createCodexParser()
    const evs = p.line(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'hivemem', tool: 'memory_search', arguments: { query: 'auth' } } }))
    expect(evs.map(eventToChunk)).toEqual(['[memory] search "auth"\n'])
  })

  it('readableLog renders claude memory calls', () => {
    const raw = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__hivemem__memory_write', input: { entity: 'x', facts: [{ text: 'y' }] } }] } })
    expect(readableLog('claude', raw)).toBe('[memory] write x (1 fact)\n')
  })
})

// ---------- validation ----------

describe('memory: validation', () => {
  const deps = { getProfile: (id: string) => (id === 'p_claude' ? profile('p_claude', 'claude') : null), getRepo: () => null }
  const draft = (nodes: WorkflowNode[]): WorkflowDraft => ({ name: 'w', description: '', inputs: [], nodes })
  it('accepts every mode on agents and off/read on reviewers', () => {
    expect(validateWorkflow(draft([agent('a', 'x', { memory: 'read-write' }), check('c', 'a', { memory: 'read' })]), deps)).toEqual([])
    expect(validateWorkflow(draft([agent('a', 'x', { memory: 'off' })]), deps)).toEqual([])
  })
  it('rejects bad modes, shell memory, command-check memory, read-write reviewers', () => {
    const errs = validateWorkflow(
      draft([
        agent('a', 'x', { memory: 'write' as never }),
        { id: 's', type: 'shell', label: 's', after: [], cwd: null, timeoutMin: 1, command: 'ls', memory: 'read' },
        check('c', 'a', { memory: 'read-write' }),
        check('d', 'a', { profileId: null, command: 'npm test', criteria: '', memory: 'read' })
      ]),
      deps
    )
    expect(errs).toEqual([
      { path: 'a', message: 'Node "a": memory must be off, read or read-write' },
      { path: 's', message: 'Node "s": shell steps cannot use memory' },
      { path: 'c', message: 'Node "c": a reviewer can only read memory' },
      { path: 'd', message: 'Node "d": shell steps cannot use memory' }
    ])
  })
})

// ---------- executor ----------

describe('memory: executor wiring', () => {
  it('explicit off -> no grant, argv unchanged', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok' })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'hi', memory: 'off' }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(bridge.requests).toEqual([])
    expect(calls[0].mcpArgs).toBeUndefined()
    expect(calls[0].prompt).toBe('hi')
  })

  it('F4: a prompt run without memory set defaults to read-write and steers saves to hivemem', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok' })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'save a short fact' }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(bridge.requests).toHaveLength(1)
    expect(bridge.requests[0]).toMatchObject({ mode: 'read-write', nodeId: 'prompt' })
    // the fake grant is a legacy one (HIVE_MEM_DB): it keeps the v1 rules text (PASSPORT.md §7.4)
    expect(calls[0].prompt).toContain(LEGACY_MEMORY_WRITE_RULES)
    expect(LEGACY_MEMORY_WRITE_RULES).toMatch(/memory_write/)
    expect(LEGACY_MEMORY_WRITE_RULES).toMatch(/~\/\.claude\/projects/)
  })

  it('read-write claude agent: grant with provenance, brief prefixed once, config file live only during the step', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    let fileDuringStep: { exists: boolean; mode: number; cfg: unknown } | null = null
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, (req) => {
          const path = req.mcpArgs![1]
          fileDuringStep = { exists: existsSync(path), mode: statSync(path).mode & 0o777, cfg: JSON.parse(readFileSync(path, 'utf8')) }
          return { output: 'done' }
        })
      }
    })
    const wf = addWorkflow(ctx, { name: 'Mem flow', description: '', inputs: [], nodes: [agent('build', 'Fix the build', { label: 'Build', memory: 'read-write' })] })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')

    expect(bridge.requests).toHaveLength(1)
    const req = bridge.requests[0]
    const step = ctx.store.stepsOf(run.id)[0]
    expect(req).toMatchObject({
      mode: 'read-write',
      adapter: 'claude',
      transport: 'mcp',
      cwd: ctx.paths.scratchDir,
      runId: run.id,
      runTitle: 'Mem flow',
      workflowId: wf.id,
      stepId: step.id,
      nodeId: 'build',
      nodeLabel: 'Build',
      sessionId: null,
      briefQuery: 'Fix the build'
    })
    expect(req.profile?.id).toBe('p_claude')

    const [call] = calls
    expect(call.prompt.startsWith('<hive-memory')).toBe(true)
    expect(call.prompt.endsWith('\n\nFix the build')).toBe(true)
    expect(call.prompt.match(/<hive-memory/g)).toHaveLength(1)
    expect(step.prompt).toContain('<hive-memory') // user sees exactly what the agent got
    expect(call.prompt).toContain(LEGACY_MEMORY_WRITE_RULES)
    expect(call.prompt.indexOf(LEGACY_MEMORY_WRITE_RULES)).toBeLessThan(call.prompt.indexOf('Fix the build'))
    expect(call.mcpArgs![0]).toBe('--mcp-config')
    expect(call.mcpArgs![3]).toBe('mcp__hivemem__memory_search,mcp__hivemem__memory_get,mcp__hivemem__memory_write,mcp__hivemem__memory_invalidate')
    expect(fileDuringStep).toMatchObject({ exists: true, mode: 0o600 })
    expect((fileDuringStep!.cfg as { mcpServers: { hivemem: { env: Record<string, string> } } }).mcpServers.hivemem.env.HIVE_MEM_GRANT).toBe('mgr_0000000001')
    expect(existsSync(call.mcpArgs![1])).toBe(false) // removed after the step
    expect(bridge.released).toEqual(['mgr_0000000001'])
    expect(bridge.open.size).toBe(0)
  })

  it('read mode lists only read tools', async () => {
    const { ctx } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok' })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'look', memory: 'read' }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(calls[0].mcpArgs![3]).toBe('mcp__hivemem__memory_search,mcp__hivemem__memory_get')
    expect(calls[0].mcpArgs!.join(' ')).not.toContain('memory_write')
    expect(calls[0].prompt).not.toContain('<memory-write-rules>')
  })

  // PASSPORT.md §7.2/§7.6: Codex is inject-only; the asked mode reaches main (a read-write vault grant carries the harvest rules)
  it.each(['read', 'read-write'] as const)('Codex keeps %s memory mode over inject, brief only, and releases its grant', async (mode) => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { codex: fakeAdapter('codex', calls, () => ({ output: 'ok' })) } })
    try {
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'go', memory: mode }, { trigger: 'manual' })
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
      expect(bridge.requests[0]).toMatchObject({ mode, transport: 'inject', adapter: 'codex', nodeLabel: 'Prompt' })
      expect((calls[0].mcpArgs ?? []).join(' ')).not.toContain('mcp_servers.hivemem')
      expect(calls[0].prompt.startsWith('<hive-memory')).toBe(true)
      expect(calls[0].prompt).not.toContain('<memory-write-rules>')
      expect(bridge.released).toEqual(['mgr_0000000001'])
      expect(bridge.open.size).toBe(0)
    } finally { await engine.shutdown() }
  })

  it('a read-write vault grant over inject carries the harvest rules, never the MCP write rules', () => {
    const g = { ...grantOf(3), server: { ...grantOf(3).server, env: { HIVE_MEM_INDEX: '/x/passport-index.db' } }, toolNames: [...READ, 'memory_write'] }
    const brief = agentBrief(g, false)
    expect(brief).toContain('<passport-notes>')
    expect(brief).not.toContain(MEMORY_WRITE_RULES)
    expect(agentBrief(g, false, { harvest: false })).not.toContain('<passport-notes>')
  })

  it('Codex memory off never attaches a grant or advertises writes', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { codex: fakeAdapter('codex', calls, () => ({ output: 'ok' })) } })
    try {
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'go', memory: 'off' }, { trigger: 'manual' })
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
      expect(bridge.requests).toEqual([])
      expect(calls[0].mcpArgs).toBeUndefined()
      expect(calls[0].prompt).not.toContain('<memory-write-rules>')
    } finally { await engine.shutdown() }
  })

  it('Claude quota fallback obtains a new Codex MCP grant with the original scope and keeps the company gateway', async () => {
    const { ctx, bridge } = setup()
    ctx.gateway = { attachment: () => ({ name: 'principia', command: '/fake/gateway', args: [], env: { PRINCIPIA_GATEWAY_DIR: ctx.root } }) }
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { available: ['claude', 'codex', 'shell'], adapters: {
      claude: fakeAdapter('claude', calls, () => ({ output: 'Usage limit reached', isError: true, exitCode: 1 })),
      codex: fakeAdapter('codex', calls, () => ({ output: 'ok' }))
    } })
    try {
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'Remember the verified project decision', memory: 'read-write' }, { trigger: 'manual' })
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
      expect(bridge.requests.map(r => [r.adapter, r.transport, r.mode])).toEqual([
        ['claude', 'mcp', 'read-write'], ['codex', 'inject', 'read-write']
      ])
      expect(bridge.requests[1].cwd).toBe(bridge.requests[0].cwd)
      expect(bridge.requests[1].runId).toBe(run.id)
      expect(bridge.requests[1].stepId).not.toBe(bridge.requests[0].stepId)
      // Codex is inject-only (PASSPORT.md §7.2): the new grant's brief, no hivemem server, the gateway kept
      expect(calls[1].mcpArgs!.join(' ')).not.toContain('HIVE_MEM_GRANT')
      expect(calls[1].mcpArgs!.join(' ')).toContain('mcp_servers.principia.command=')
      expect(calls[1].prompt).toContain('mgr_0000000002')
      expect(calls[1].prompt).not.toContain('mgr_0000000001')
      expect(bridge.open.size).toBe(0)
      expect(bridge.released).toEqual(['mgr_0000000001', 'mgr_0000000002'])
    } finally { await engine.shutdown() }
  })

  it('Codex attachment failure falls back to brief only without advertising writable memory', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const codex = { ...fakeAdapter('codex', calls, () => ({ output: 'ok' })), mcpAttach: () => { throw new Error('attachment unavailable') } }
    const engine = await makeEngine(ctx, { adapters: { codex } })
    try {
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'go', memory: 'read-write' }, { trigger: 'manual' })
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
      expect(calls[0].mcpArgs).toBeUndefined()
      expect(calls[0].prompt).toContain('<hive-memory')
      expect(calls[0].prompt).not.toContain('<memory-write-rules>')
      expect(bridge.open.size).toBe(0)
    } finally { await engine.shutdown() }
  })

  it('check retry that resumes gets no second brief but still a grant', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    let reviews = 0
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, (req) =>
          req.prompt.includes('You are reviewing') ? { output: ++reviews === 1 ? 'bad\nVERDICT: FAIL' : 'VERDICT: PASS' } : { output: 'work' }
        )
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'w',
      description: '',
      inputs: [],
      nodes: [agent('a', 'Write code', { memory: 'read-write' }), check('c', 'a', { memory: 'read' })]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const agentCalls = calls.filter((c) => !c.prompt.includes('You are reviewing'))
    expect(agentCalls).toHaveLength(2)
    expect(agentCalls[0].prompt.startsWith('<hive-memory')).toBe(true)
    expect(agentCalls[1].resumeId).toBeTruthy()
    expect(agentCalls[1].prompt).not.toContain('<hive-memory')
    expect(agentCalls[1].mcpArgs?.[0]).toBe('--mcp-config')
    // reviewer reads (read-write is rejected at save time and clamped at run time, see nodeMemoryMode)
    const reviewerReqs = bridge.requests.filter((r) => r.nodeId === 'c')
    expect(reviewerReqs.length).toBe(2)
    expect(reviewerReqs.every((r) => r.mode === 'read' && r.briefQuery === 'be good')).toBe(true)
    expect(bridge.released).toHaveLength(bridge.requests.length)
  }, 20000)

  it('room: every turn gets its own grant, same mode and the topic as brief query', async () => {
    const { ctx, bridge } = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, (_r, n) => ({ output: `turn ${n}` })) } })
    const wf = addWorkflow(ctx, {
      name: 'w',
      description: '',
      inputs: [],
      nodes: [
        {
          id: 'talk',
          type: 'room',
          label: 'Talk',
          after: [],
          cwd: null,
          timeoutMin: 1,
          memory: 'read-write',
          participants: [
            { profileId: 'p_claude', label: 'Builder' },
            { profileId: 'p_claude', label: 'Skeptic' }
          ],
          topic: 'Pick a cache',
          rounds: 1,
          final: 'last'
        }
      ]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(bridge.requests.map((r) => [r.mode, r.briefQuery, r.nodeLabel])).toEqual([
      ['read-write', 'Pick a cache', 'Talk · Builder'],
      ['read-write', 'Pick a cache', 'Talk · Skeptic']
    ])
    expect(calls.every((c) => c.prompt.startsWith('<hive-memory') && c.mcpArgs?.length === 4)).toBe(true)
    expect(bridge.released).toHaveLength(2)
  })

  it('shell nodes and command checks never get a grant', async () => {
    const { ctx, bridge } = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', [], () => ({ output: 'ok' })) } })
    const wf = addWorkflow(ctx, {
      name: 'w',
      description: '',
      inputs: [],
      nodes: [agent('a', 'x'), check('c', 'a', { profileId: null, command: 'true', criteria: '' }), { id: 's', type: 'shell', label: 's', after: ['c'], cwd: null, timeoutMin: 1, command: 'echo hi' }]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(bridge.requests).toEqual([])
  })

  it('releases on failure and on cancel', async () => {
    const { ctx, bridge } = setup()
    const engine = await makeEngine(ctx, {
      adapters: { claude: fakeAdapter('claude', [], (req) => (req.prompt.includes('slow') ? { output: 'x', delayMs: 5000 } : { exitCode: 1, output: 'boom' })) }
    })
    const r1 = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'fail', memory: 'read-write' }, { trigger: 'manual' })
    expect((await waitRun(ctx, r1.id)).status).toBe('failed')
    expect(bridge.released).toEqual(['mgr_0000000001'])

    const r2 = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'slow', memory: 'read' }, { trigger: 'manual' })
    for (let i = 0; i < 100 && bridge.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 150))
    await engine.runs.cancel(r2.id)
    expect((await waitRun(ctx, r2.id)).status).toBe('canceled')
    expect(bridge.released).toEqual(['mgr_0000000001', 'mgr_0000000002'])
    expect(existsSync(join(ctx.root, 'memory', 'spawn', 'mgr_0000000002.mcp.json'))).toBe(false)
  }, 20000)

  it('bridge returning null or throwing: the step runs exactly as without memory', async () => {
    for (const fail of ['null', 'throw'] as const) {
      const { ctx, bridge } = setup({ fail })
      const calls: FakeCall[] = []
      const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok' })) } })
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'p', memory: 'read-write' }, { trigger: 'manual' })
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
      expect(bridge.requests).toHaveLength(1)
      expect(calls[0].prompt).toBe('p')
      expect(calls[0].mcpArgs).toBeUndefined()
      expect(bridge.released).toEqual([])
    }
  })

  it('no ctx.memory (tests / older main): memory silently off', async () => {
    const { ctx } = setup()
    delete ctx.memory
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok' })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'p', memory: 'read-write' }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(calls[0].prompt).toBe('p')
  })
})

// ---------- interactive sessions ----------

describe('memory: interactiveSpawn', () => {
  it('claude session: writes the grant config, mcp args first, brief in the system prompt', async () => {
    const { ctx } = setup()
    const engine = createEngineWith(ctx, { detect: fakeProviders() })
    await engine.init()
    const g = { ...grantOf(7), spawnDir: join(ctx.root, 'memory', 'spawn') }
    const spec = engine.providers.interactiveSpawn(profile('p_claude', 'claude'), { artifactsDir: '/a/', memory: g })
    expect(spec.args[0]).toBe('--mcp-config')
    const path = spec.args[1]
    expect(path).toBe(join(g.spawnDir, `${g.grantId}.mcp.json`))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(spec.args[spec.args.indexOf('--append-system-prompt') + 1]).toContain('<hive-memory>')
    assertVariadicSafe(spec.args)
    expect(spec.env).toBeUndefined()
  })

  it.each([[READ], [[...READ, ...WRITE]]])('Codex interactive grants stay brief-only (inject) whatever their tools', async (toolNames) => {
    const { ctx } = setup()
    const engine = createEngineWith(ctx, { detect: fakeProviders() })
    await engine.init()
    try {
      const grant = { ...grantOf(1), toolNames }
      const spawn = engine.providers.interactiveSpawn(profile('p', 'codex'), { artifactsDir: '/a/', memory: grant })
      expect(spawn.args.join(' ')).not.toContain('mcp_servers.hivemem')
      expect(spawn.args.join(' ')).not.toContain('<memory-write-rules>')
      expect(spawn.args.join(' ')).not.toContain('<passport-notes>')
      expect(spawn.env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    } finally { await engine.shutdown() }
  })

  it('no grant or non-mcp adapter: argv unchanged', async () => {
    const { ctx } = setup()
    const engine = createEngineWith(ctx, { detect: fakeProviders() })
    await engine.init()
    expect(engine.providers.interactiveSpawn(profile('p', 'claude'), { artifactsDir: '/a/' }).args).not.toContain('--mcp-config')
    const cursor = engine.providers.interactiveSpawn(profile('p', 'cursor'), { artifactsDir: '/a/', memory: grantOf(1) })
    expect(cursor.args.join(' ')).not.toContain('mcp_servers')
  })
})
