/**
 * Real-CLI smoke for live agents (LIVE.md §3.1, §4.2). Opt-in:
 *   HIVE_REAL_CLAUDE=1 npx vitest run src/main/engine/__tests__/live.smoke.test.ts
 * Uses the installed `claude` (haiku, subscription login; a few cents) through the real engine + adapter:
 *  1. a subagent spawn -> one child node per Agent call (A6), parented to the step root, tool rows on the child;
 *  2. permissionMode 'default' -> can_use_tool -> stdio ask -> Allow from Hive -> the command runs;
 *  3. ask_user over a stub hivemem (fixtures/stub-askuser-mcp.cjs) attached with memory off -> answer comes back;
 *  4. interactive PTY claude with the adapter's real args (per-spawn --permission-mode default, hooks --settings):
 *     a non-allow-listed Bash command -> PermissionRequest hook -> Needs-you ask -> typed reply "1" -> command runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentNode, Ask } from '../../../shared/live'
import type { EngineEvent, ProviderInfo } from '../../../shared/types'
import { ADAPTER_IDS } from '../../../shared/types'
import { DEFAULT_ADAPTERS } from '../adapters'
import { createEngineWith } from '../index'
import { fakeCtx, profile, waitRun } from './fakes'
import { fakeBridge } from './liveFakes'
import { claudeHooksAttach } from '../live/attach'
import { normalizeHook } from '../live/hooks'
import { createAgentTracker } from '../live/tracker'
import { writeMcpFiles } from '../memory'
import { claudeAdapter } from '../adapters'
import { detectPtyPrompt, ptyReplyKeys } from '../live/pty'
import { trustFolderForClaude } from '../../claudeTrust'

const STUB = join(__dirname, 'fixtures', 'stub-askuser-mcp.cjs')
const REAL = !!process.env.HIVE_REAL_CLAUDE

function claudePath(): string {
  return execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()
}

async function setup(permissionMode: 'default' | 'bypass') {
  const ctx = fakeCtx()
  ctx.baseEnv = () => ({ ...process.env }) as Record<string, string>
  const repo = join(ctx.root, 'work')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'note.txt'), 'hello hive\n')
  ctx.repos.set('repo_w', { id: 'repo_w', name: 'work', path: repo, addedAt: '', exists: true, isGit: false, liveSessions: 0 })
  ctx.listRepos = () => [...ctx.repos.values()]
  ctx.profiles.set('p', profile('p', 'claude', { model: 'haiku', permissionMode, extraArgs: ['--max-turns', '8'] }))
  const bridge = fakeBridge(ctx.root)
  ctx.live = bridge
  ctx.memory = {
    grant: () => null,
    release: () => {},
    askOnlyServer: () => ({ name: 'hivemem', command: process.execPath, args: [STUB], env: {} })
  }
  const bin = claudePath()
  const detect = async (): Promise<ProviderInfo[]> =>
    ADAPTER_IDS.map((id) => ({
      id,
      label: DEFAULT_ADAPTERS[id].label,
      available: id === 'claude',
      version: null,
      binPath: id === 'claude' ? bin : null,
      installHint: '',
      checkedAt: new Date().toISOString()
    }))
  const engine = createEngineWith(ctx, { detect })
  await engine.init()
  return { ctx, engine }
}

const agents = (events: EngineEvent[]): Map<string, AgentNode> => {
  const m = new Map<string, AgentNode>()
  for (const e of events) if (e.type === 'agent.updated') m.set(e.agent.id, e.agent)
  return m
}
const agentEvents = (events: EngineEvent[], agentId: string): AgentEvent[] =>
  events.filter((e): e is Extract<EngineEvent, { type: 'agent.events' }> => e.type === 'agent.events' && e.agentId === agentId).flatMap((e) => e.events)
const asks = (events: EngineEvent[]): Ask[] => events.filter((e): e is Extract<EngineEvent, { type: 'ask.updated' }> => e.type === 'ask.updated').map((e) => e.ask)
async function waitFor<T>(f: () => T | null | undefined | false, ms = 120_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!REAL)('live smoke: real claude -p (haiku)', () => {
  it('subagent spawn -> one child node, parented, with its own tool rows; step output from the main agent', async () => {
    const { ctx, engine } = await setup('bypass')
    const run = engine.runs.start(
      {
        kind: 'prompt',
        profileId: 'p',
        repoId: 'repo_w',
        prompt:
          'Use the Agent tool (subagent_type "general-purpose", run in the foreground) to read note.txt in the current directory and report its contents. Do not read the file yourself. Then reply with one short sentence quoting what the subagent found.'
      },
      { trigger: 'manual' }
    )
    const done = await waitRun(ctx, run.id, 240_000)
    const step = ctx.store.stepsOf(run.id)[0]
    expect(done.status, step.error ?? '').toBe('passed')
    const all = [...agents(ctx.events).values()]
    const root = all.find((a) => a.kind === 'step')!
    const subs = all.filter((a) => a.kind === 'subagent')
    console.log('[smoke] root', JSON.stringify({ status: root.status, cost: root.costUsd, model: root.model, tools: root.toolCount }))
    console.log('[smoke] subagents', JSON.stringify(subs.map((s) => ({ id: s.id, type: s.agentType, ext: s.externalId, tu: s.toolUseId, status: s.status, tools: s.toolCount, report: s.report?.slice(0, 80) }))))
    expect(subs.length).toBeGreaterThanOrEqual(1)
    // A6: no duplicate node for the same subagent (tool_use id and task id)
    expect(new Set(subs.map((s) => s.externalId)).size).toBe(subs.length)
    const s = subs[0]
    expect(s).toMatchObject({ parentId: root.id, rootId: root.id, runId: run.id, status: 'done' })
    expect(s.externalId).toBeTruthy()
    expect(s.report ?? '').toMatch(/hello hive/i)
    const childTools = agentEvents(ctx.events, s.id).filter((e) => e.kind === 'tool')
    expect(childTools.some((e) => e.name === 'Read' && e.state === 'ok')).toBe(true)
    expect(root.status).toBe('done')
    expect(root.costUsd).toBeGreaterThan(0)
    expect(step.output).toMatch(/hello hive/i)
  }, 300_000)

  it('permissionMode default: can_use_tool -> stdio ask -> Allow in Hive -> the command runs', async () => {
    const { ctx, engine } = await setup('default')
    const run = engine.runs.start(
      {
        kind: 'prompt',
        profileId: 'p',
        repoId: 'repo_w',
        prompt: "Use the Bash tool to run exactly: echo hive-$((40+2)) > out.txt && cat out.txt . Then reply with the command's output only."
      },
      { trigger: 'manual' }
    )
    const ask = await waitFor(() => asks(ctx.events).find((a) => a.status === 'open'))
    console.log('[smoke] ask', JSON.stringify({ title: ask.title, channel: ask.channel, tool: ask.toolName }))
    expect(ask).toMatchObject({ kind: 'permission', channel: 'stdio', toolName: 'Bash' })
    const root = [...agents(ctx.events).values()].find((a) => a.kind === 'step')!
    expect(root.status).toBe('needs_you')
    engine.asks!.answer(ask.id, { askId: ask.id, optionId: 'allow_step' })
    const done = await waitRun(ctx, run.id, 240_000)
    const step = ctx.store.stepsOf(run.id)[0]
    expect(done.status, step.error ?? '').toBe('passed')
    expect(step.output).toContain('hive-42')
  }, 300_000)

  it('ask_user (memory off, ask-only hivemem): the question reaches Hive and the answer reaches the agent', async () => {
    const { ctx, engine } = await setup('bypass')
    const run = engine.runs.start(
      {
        kind: 'prompt',
        profileId: 'p',
        repoId: 'repo_w',
        prompt:
          'Ask the user which database to use by calling the ask_user tool with options ["postgres", "sqlite"]. Then reply with exactly: DB=<their answer>'
      },
      { trigger: 'manual' }
    )
    const ask = await waitFor(() => asks(ctx.events).find((a) => a.status === 'open'))
    console.log('[smoke] ask_user', JSON.stringify({ q: ask.question, channel: ask.channel, options: ask.options }))
    expect(ask).toMatchObject({ kind: 'question', channel: 'mcp' })
    await new Promise((r) => setTimeout(r, 1500))
    const choice = ask.options.find((o) => /sqlite/i.test(o.label))
    engine.asks!.answer(ask.id, choice ? { askId: ask.id, optionId: choice.id } : { askId: ask.id, text: 'sqlite' })
    const done = await waitRun(ctx, run.id, 240_000)
    const step = ctx.store.stepsOf(run.id)[0]
    expect(done.status, step.error ?? '').toBe('passed')
    expect(step.output).toMatch(/DB=sqlite/i)
  }, 300_000)

  it('interactive hooks: the rendered --settings file (all async) delivers SubagentStart/Pre/Post/Stop that build the tree', async () => {
    const ctx = fakeCtx()
    const repo = join(ctx.root, 'work')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'note.txt'), 'hello hive\n')
    const dir = join(ctx.root, 'live', 's_smoke')
    const events = join(dir, 'events.jsonl')
    const hookJs = join(ctx.root, 'hook.js')
    // minimal stand-in for main's hive-hook.js: wrap stdin in the envelope, one append
    writeFileSync(
      hookJs,
      `let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{try{require('fs').appendFileSync(process.argv[2],JSON.stringify({v:1,provider:'claude',received_at:new Date().toISOString(),payload:JSON.parse(b)})+'\\n')}catch{}})`
    )
    const a = claudeHooksAttach({ dir, hookCommand: `'${process.execPath}' '${hookJs}' '${events}'` }, { headless: false, gate: false })
    writeMcpFiles(a.files)
    writeFileSync(events, '')
    execFileSync(
      claudePath(),
      ['-p', ...a.args, '--model', 'haiku', '--max-turns', '8', '--dangerously-skip-permissions', 'Use the Agent tool (subagent_type "general-purpose", foreground) to read note.txt and report it. Do not read it yourself. Then answer in one sentence.'],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000, env: { ...process.env } as Record<string, string> }
    )
    await new Promise((r) => setTimeout(r, 2500)) // async hooks finish in the background
    const t = createAgentTracker({ provider: 'claude', root: { kind: 'session', title: 's', cwd: repo }, headless: false })
    const lines = readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const names = lines.map((l) => l.payload.hook_event_name)
    console.log('[smoke] hook events', JSON.stringify(names))
    for (const l of lines) for (const h of normalizeHook('claude', l)) t.hook(h)
    expect(names).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']))
    const subs = t.keys().filter((k) => t.node(k)!.kind === 'subagent')
    expect(subs).toHaveLength(1)
    expect(t.node(subs[0])).toMatchObject({ status: 'done', agentType: 'general-purpose' })
    expect(t.node(subs[0])!.toolCount).toBeGreaterThanOrEqual(1)
  }, 300_000)

  it('interactive PTY: a non-allow-listed Bash command opens a permission ask; the typed reply runs it', async () => {
    // node-pty is loaded lazily so the default (skipped) run never needs the native module
    const pty = (await import('node-pty')) as typeof import('node-pty')
    const ctx = fakeCtx()
    const dir = join(ctx.root, 'live', 's_pty')
    mkdirSync(dir, { recursive: true })
    const events = join(dir, 'events.jsonl')
    const hookJs = join(ctx.root, 'hook.js')
    const marker = join(ctx.root, 'marker.txt')
    writeFileSync(
      hookJs,
      `let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{try{require('fs').appendFileSync(process.argv[2],JSON.stringify({v:1,provider:'claude',received_at:new Date().toISOString(),payload:JSON.parse(b)})+'\\n')}catch{}})`
    )
    writeFileSync(events, '')
    const a = claudeHooksAttach({ dir, hookCommand: `'${process.execPath}' '${hookJs}' '${events}'` }, { headless: false, gate: false })
    writeMcpFiles(a.files)
    // the adapter's real interactive args, bypass off: must carry --permission-mode default (overrides a user defaultMode)
    const inv = claudeAdapter.interactive({ profile: profile('p', 'claude', { model: 'haiku' }), artifactsDir: join(ctx.root, 'a') + '/', resumeId: null, hookArgs: a.args })
    expect(inv.args.slice(inv.args.indexOf('--permission-mode'), inv.args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default'])
    // cwd: one fixed dev folder trusted the way Hive trusts a picked repo (idempotent; no per-run config entries)
    const cwd = join(process.cwd(), '.hive-dev-data', 'smoke-pty', 'work')
    mkdirSync(cwd, { recursive: true })
    expect(trustFolderForClaude(cwd, process.env)).toBe(true)
    const term = pty.spawn(claudePath(), inv.args, { name: 'xterm-256color', cols: 140, rows: 40, cwd, env: { ...process.env } as Record<string, string> })
    let screen = ''
    term.onData((d) => (screen = (screen + d).slice(-20_000)))
    const t = createAgentTracker({ provider: 'claude', root: { kind: 'session', title: 's', cwd }, headless: false })
    let fed = 0
    const pump = () => {
      const lines = readFileSync(events, 'utf8').split('\n').filter(Boolean)
      for (const l of lines.slice(fed)) for (const h of normalizeHook('claude', JSON.parse(l))) t.hook(h)
      fed = lines.length
    }
    const until = async (ok: () => boolean, ms: number, what: string) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        pump()
        if (ok()) return
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`timed out waiting for ${what}\n--- screen tail ---\n${screen.slice(-3000)}`)
    }
    try {
      await until(() => fed > 0, 60_000, 'SessionStart hook')
      expect(detectPtyPrompt('claude', screen)?.kind).not.toBe('trust')
      await new Promise((r) => setTimeout(r, 2000)) // composer ready
      const cmd = `node -e "require('fs').writeFileSync(process.argv[1],'ok')" ${marker}`
      term.write(`Run exactly this shell command with the Bash tool, then reply DONE: ${cmd}`)
      await new Promise((r) => setTimeout(r, 800))
      term.write('\r')
      await until(() => t.openAsks().some((x) => x.kind === 'permission'), 180_000, 'permission ask')
      const ask = t.openAsks().find((x) => x.kind === 'permission')!
      expect(ask.toolName).toBe('Bash')
      expect(existsSync(marker)).toBe(false) // nothing ran before the reply
      term.write(ptyReplyKeys('claude', 'permission', 'allow')!)
      await until(() => existsSync(marker), 120_000, 'command to run after the reply')
      await until(() => !t.openAsks().some((x) => x.kind === 'permission'), 30_000, 'ask to resolve')
    } finally {
      term.kill()
    }
  }, 420_000)
})
