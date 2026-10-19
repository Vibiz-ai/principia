import { describe, expect, it } from 'vitest'
import type { WorkflowDraft, WorkflowNode } from '../../../shared/types'
import { claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter, readableLog, shellAdapter, unroutedAsksNotice } from '../adapters'
import { createAgentTracker } from '../live/tracker'
import { effectiveDeps, loopBody } from '../graph'
import { createClaudeParser, createCodexParser, parseVerdict } from '../parse'
import { seedWorkflows } from '../seeds'
import { parseRefs, render } from '../templates'
import { validateWorkflow } from '../validate'
import { profile } from './fakes'

const deps = {
  getProfile: (id: string) =>
    id === 'p_claude' ? profile('p_claude', 'claude') : id === 'p_shell' ? profile('p_shell', 'shell') : null,
  getRepo: () => null
}
const node = (x: Partial<WorkflowNode> & { id: string }): WorkflowNode =>
  ({ type: 'agent', label: x.id, after: [], cwd: null, timeoutMin: 30, profileId: 'p_claude', prompt: 'p', ...x }) as WorkflowNode
const draft = (nodes: WorkflowNode[], inputs: WorkflowDraft['inputs'] = []): WorkflowDraft => ({ name: 'w', description: '', inputs, nodes })

describe('validateWorkflow', () => {
  it('accepts the seeded workflows', () => {
    for (const s of seedWorkflows({ claude: 'p_claude', codex: null })) expect(validateWorkflow(s.draft, deps)).toEqual([])
  })
  it('W2: unknown template ref names the node', () => {
    const e = validateWorkflow(draft([node({ id: 'a', prompt: 'x {{nope.output}}' })]), deps)
    expect(e).toEqual([{ path: 'a', message: 'Node "a": {{nope.output}} references unknown node "nope"' }])
  })
  it('W2: cycles via after or template refs', () => {
    const e = validateWorkflow(draft([node({ id: 'a', after: ['b'] }), node({ id: 'b', prompt: '{{a.output}}' })]), deps)
    expect(e.some((x) => /cycle/.test(x.message))).toBe(true)
  })
  it('rooms need 2 non-shell participants with unique labels; checks need an agent target and one reviewer', () => {
    const room = node({
      id: 'r',
      type: 'room',
      participants: [
        { profileId: 'p_shell', label: 'A' },
        { profileId: 'p_claude', label: 'A' }
      ],
      topic: 't',
      rounds: 11,
      final: 'last'
    } as Partial<WorkflowNode> & { id: string })
    const chk = node({
      id: 'c',
      type: 'check',
      target: 'r',
      profileId: 'p_claude',
      command: 'npm test',
      criteria: '',
      maxRetries: 9
    } as Partial<WorkflowNode> & { id: string })
    const msgs = validateWorkflow(draft([room, chk]), deps).map((e) => e.message)
    expect(msgs).toContain('Node "r": participant 1 cannot be a shell profile')
    expect(msgs).toContain('Node "r": participant label "A" is used twice')
    expect(msgs).toContain('Node "r": rounds must be 1-10')
    expect(msgs).toContain('Node "c": reviewer must be either an agent or a command')
    expect(msgs).toContain('Node "c": target "r" must be an agent node')
    expect(msgs).toContain('Node "c": retries must be 0-5')
  })
  it('unknown input, bad ids, duplicate ids, missing profile', () => {
    const msgs = validateWorkflow(
      draft([node({ id: 'Bad' }), node({ id: 'a', prompt: '{{inputs.x}}' }), node({ id: 'a' }), node({ id: 'b', profileId: 'gone' })]),
      deps
    ).map((e) => e.message)
    expect(msgs.some((m) => m.includes('lowercase slug'))).toBe(true)
    expect(msgs).toContain('Node id "a" is used twice')
    expect(msgs).toContain('Node "a": {{inputs.x}} references unknown input "x"')
    expect(msgs).toContain('Node "b": agent profile for the agent no longer exists')
  })
})

describe('graph', () => {
  it('loop body = target + nodes on a path target -> check', () => {
    const nodes = [
      node({ id: 'build' }),
      node({ id: 'fmt', after: ['build'] }),
      node({ id: 'other', after: ['build'] }),
      node({ id: 'c', type: 'check', target: 'build', after: ['build'], criteria: '{{fmt.output}}' } as Partial<WorkflowNode> & { id: string })
    ]
    const d = effectiveDeps(nodes)
    expect([...loopBody(d, nodes[3] as never)].sort()).toEqual(['build', 'fmt'])
  })
})

describe('templates', () => {
  it('parses and renders', () => {
    expect(parseRefs('{{inputs.a}} {{ n1.output }} {{n2.transcript}} {{ARTIFACTS_DIR}} {{x}}').map((r) => r.kind)).toEqual([
      'input',
      'node',
      'node',
      'artifacts',
      'invalid'
    ])
    const out = render('{{inputs.a}}|{{ n1.output }}|{{n1.transcript}}|{{ARTIFACTS_DIR}}', {
      inputs: { a: 'A' },
      nodeOutput: () => 'O',
      nodeTranscript: () => 'T',
      artifactsDir: '/d/'
    })
    expect(out).toBe('A|O|T|/d/')
  })
})

describe('parsers', () => {
  it('claude stream-json -> normalized events, final = result', () => {
    const p = createClaudeParser()
    const ev = [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"},{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.02,"num_turns":2,"usage":{"input_tokens":10,"output_tokens":2},"permission_denials":[{"tool_name":"Write"}]}'
    ].flatMap((l) => p.line(l))
    expect(ev.map((e) => e.kind)).toEqual(['session', 'usage', 'text', 'tool_use', 'result', 'usage'])
    expect(p.finalOutput('')).toBe('ok')
    expect(p.result()).toMatchObject({ costUsd: 0.02, inputTokens: 10, numTurns: 2, permissionDenials: ['Write'], isError: false })
  })
  it('codex --json (new and legacy shapes)', () => {
    const p = createCodexParser()
    p.line('{"type":"thread.started","thread_id":"t1"}')
    p.line('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}')
    p.line('{"type":"item.completed","item":{"type":"agent_message","text":"done!"}}')
    p.line('{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}')
    expect(p.finalOutput('')).toBe('done!')
    const q = createCodexParser()
    q.line('{"id":"0","msg":{"type":"agent_message","message":"legacy"}}')
    expect(q.finalOutput('')).toBe('legacy')
  })
  it('verdict = last VERDICT line, missing = FAIL', () => {
    expect(parseVerdict('VERDICT: FAIL\n...\nVERDICT: pass')).toBe('PASS')
    expect(parseVerdict('**VERDICT:** FAIL')).toBe('FAIL')
    expect(parseVerdict('looks fine')).toBe('FAIL')
  })
})

describe('readableLog', () => {
  it('claude stream-json log -> transcript text, tools, result; header dropped', () => {
    const raw = [
      '$ /bin/claude -p --output-format stream-json',
      '# cwd: /x',
      '',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at it' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7 } }),
      ''
    ].join('\n')
    const out = readableLog('claude', raw)
    expect(out).not.toContain('{')
    expect(out).not.toContain('cwd')
    expect(out).toContain('Looking at it\n→ Bash\n')
    expect(out).toContain('— done · 2 turns')
  })
  it('shell log stays as is (minus the header)', () => {
    expect(readableLog('shell', '$ /bin/zsh -lc echo hi\n# cwd: /x\n\nhi\n')).toBe('hi\n')
  })
})

describe('adapters (A3, A7, A8)', () => {
  it('headless gemini/cursor with prompts on (hooks unverified) get an honest notice on the step root', () => {
    expect(unroutedAsksNotice('gemini', profile('g', 'gemini', { permissionMode: 'default' }))).toMatch(/Gemini steps aren't routed to Hive yet.*bypass.*interactively/)
    expect(unroutedAsksNotice('cursor', profile('c', 'cursor', { permissionMode: 'default' }))).toMatch(/Cursor/)
    expect(unroutedAsksNotice('gemini', profile('g', 'gemini', { permissionMode: 'bypass' }))).toBeNull()
    expect(unroutedAsksNotice('claude', profile('c', 'claude', { permissionMode: 'default' }))).toBeNull()
    const t = createAgentTracker({ provider: 'gemini', root: { kind: 'step', title: 's', cwd: '/r' }, headless: true })
    t.begin()
    const ops = t.hook({ kind: 'notice', text: unroutedAsksNotice('gemini', profile('g', 'gemini', { permissionMode: 'default' }))! })
    expect(ops.some((o) => o.op === 'event.append' && o.key === 'root' && /routed/.test(o.event.summary))).toBe(true)
  })
  const p = profile('x', 'claude')
  const req = { profile: p, prompt: 'do it', artifactsDir: '/A/r_1/', resumeId: null, shell: '/bin/zsh' }
  it('claude headless: stream-json in/out, --session-id, bypass, artifacts hint, prompt on stdin (CONTRACT §12.4)', () => {
    const inv = claudeAdapter.headless(req)
    expect(inv.args.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    expect(inv.args).toContain('--session-id')
    expect(inv.args).toContain(inv.agentSessionId)
    expect(inv.args).toContain('--dangerously-skip-permissions')
    expect(inv.args).not.toContain('--permission-prompt-tool')
    expect(inv.args[inv.args.indexOf('--append-system-prompt') + 1]).toContain('(/A/r_1/)')
    expect(inv.args).not.toContain('do it')
    expect(inv.stdin?.protocol).toBe('claude-control')
    expect(JSON.parse(inv.stdin!.lines[0])).toEqual({ type: 'control_request', request_id: 'init1', request: { subtype: 'initialize' } })
    expect(JSON.parse(inv.stdin!.lines[1])).toEqual({ type: 'user', message: { role: 'user', content: 'do it' }, parent_tool_use_id: null, session_id: '' })
    const r = claudeAdapter.headless({ ...req, resumeId: 'u1' })
    expect(r.args).toContain('--resume')
    expect(r.agentSessionId).toBe('u1')
    // a resumed turn already ran under the hints: never re-send --append-system-prompt (LANDSCAPE quick win)
    expect(r.args).not.toContain('--append-system-prompt')
    expect(claudeAdapter.headless({ ...req, resumeId: 'u1', askUser: true }).args).not.toContain('--append-system-prompt')
    expect(claudeAdapter.headless({ ...req, askUser: true }).args.join('\n')).toContain('ask_user')
    const safe = claudeAdapter.headless({ ...req, profile: { ...p, permissionMode: 'default', model: 'opus' } })
    expect(safe.args).not.toContain('--dangerously-skip-permissions')
    expect(safe.args.join(' ')).toContain('--permission-mode default --permission-prompt-tool stdio')
    expect(safe.args).toContain('opus')
  })
  it('other adapters: bypass flags + artifacts sentence prefixed', () => {
    const c = codexAdapter.headless(req).args
    expect(c.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'])
    expect(c[c.length - 1]).toMatch(/^Save files you create.*\(\/A\/r_1\/\)\.\n\ndo it$/s)
    expect(geminiAdapter.headless(req).args).toContain('--yolo')
    expect(cursorAdapter.headless(req).args).toContain('--force')
    expect(shellAdapter.headless({ ...req, prompt: 'npm test' }).args).toEqual(['-lc', 'npm test'])
    expect(codexAdapter.authEnv).toEqual(['OPENAI_API_KEY'])
  })
  it('Codex panes preserve terminal scrollback without changing headless execution', () => {
    const ireq = { profile: p, artifactsDir: '/A/s/', resumeId: null }
    expect(codexAdapter.interactive(ireq).args).toContain('--no-alt-screen')
    expect(codexAdapter.interactive({ ...ireq, bypass: true }).args).toContain('--no-alt-screen')
    expect(codexAdapter.headless(req).args).not.toContain('--no-alt-screen')
  })
  it('interactive panes ask by default even with a bypass profile; bypass only when requested', () => {
    const ireq = { profile: p, artifactsDir: '/A/s/', resumeId: null }
    const flags = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--force', '--yolo']
    for (const a of [claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter]) {
      expect(a.interactive(ireq).args.some((x) => flags.includes(x))).toBe(false)
      expect(a.interactive({ ...ireq, bypass: true }).args.some((x) => flags.includes(x))).toBe(true)
    }
  })
  it('interactive claude without bypass pins --permission-mode default per spawn (user defaultMode never skips asks)', () => {
    const ireq = { profile: p, artifactsDir: '/A/s/', resumeId: null }
    const args = claudeAdapter.interactive(ireq).args
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(claudeAdapter.interactive({ ...ireq, bypass: true }).args).not.toContain('--permission-mode')
    const own = claudeAdapter.interactive({ ...ireq, profile: { ...p, extraArgs: ['--permission-mode', 'plan'] } }).args
    expect(own.filter((x) => x === '--permission-mode')).toHaveLength(1)
    expect(own[own.indexOf('--permission-mode') + 1]).toBe('plan')
  })
  it('morning brief is seeded and defaults to every repository added to Hive', () => {
    const mb = seedWorkflows({ claude: 'p_claude', codex: null }).find((s) => s.seedKey === 'morning-brief')
    expect(mb?.draft.inputs[0].default).toBe('all')
    expect((mb?.draft.nodes[0] as { command: string }).command).toContain('$HIVE_REPOS')
  })
})

describe('memory defaults for new workflows (LIVE.md §7, D9)', () => {
  it('seeded agent/room nodes are read-write, agent reviewers read, shell/command checks none', () => {
    const seeds = seedWorkflows({ claude: 'p_claude', codex: 'p_codex' })
    const nodes = seeds.flatMap((s) => s.draft.nodes)
    for (const n of nodes) {
      if (n.type === 'agent' || n.type === 'room') expect(n.memory).toBe('read-write')
      else if (n.type === 'check' && !n.command) expect(n.memory).toBe('read')
      else expect(n.memory).toBeUndefined()
    }
  })
})
