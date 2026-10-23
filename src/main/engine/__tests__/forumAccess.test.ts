/** FORUM.md §3: steps of a run with an agent seat get the Forum (env, `forum` on PATH, MCP for claude, the brief). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompanyBridge, ForumBridge } from '../../../shared/engine'
import { createEngineWith } from '../index'
import { fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall } from './fakes'

function setup() {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  const company: CompanyBridge = { resolve: (q) => q.companyId ?? 'co_personal', crossCompany: () => null, enforced: () => true, workspaceDir: () => null, repoIds: () => [], tasks: { companyOf: () => 'co_acme' } }
  ctx.company = company
  const bin = mkdtempSync(join(tmpdir(), 'forum-bin-'))
  const opened: Parameters<ForumBridge['open']>[0][] = []
  const closed: string[] = []
  ctx.forum = {
    open: (req) => {
      opened.push(req)
      if (!req.agentId) return null
      return {
        env: { PRINCIPIA_FORUM_URL: 'http://127.0.0.1:9', PRINCIPIA_FORUM_TOKEN: `tok-${req.stepId}`, PRINCIPIA_FORUM_ME: '@marcus' },
        binDir: bin,
        server: req.adapter === 'claude' ? { name: 'principia-forum', command: '/bin/echo', args: ['forum-cli.js', 'mcp'], env: { PRINCIPIA_FORUM_TOKEN: `tok-${req.stepId}` } } : null,
        toolNames: req.adapter === 'claude' ? ['forum_read', 'forum_post'] : [],
        prompt: '<principia-forum you="@marcus" v="1">\nNo unread mentions.\n</principia-forum>'
      }
    },
    close: (stepId) => void closed.push(stepId)
  }
  return { ctx, opened, closed, bin }
}

describe('engine: Forum access (FORUM.md §3)', () => {
  it('a seat step gets the brief, the env, the CLI on PATH and the MCP server; the token closes at step end', async () => {
    const { ctx, opened, closed, bin } = setup()
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'done', echoEnv: ['PRINCIPIA_FORUM_TOKEN', 'PATH'] })) }, detect: fakeProviders() })
    await engine.init()
    const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'Work on PRN-1' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_marcus' }).id)
    expect(run.status).toBe('passed')
    expect(opened[0]).toMatchObject({ taskId: 'task_1', agentId: 'agt_marcus', adapter: 'claude', companyId: 'co_acme' })
    expect(calls[0].prompt.startsWith('<principia-forum you="@marcus" v="1">')).toBe(true)
    const args = calls[0].mcpArgs ?? []
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__principia-forum__forum_read,mcp__principia-forum__forum_post')
    const step = ctx.store.getRunDetail(run.id)!.steps[0]
    expect(step.output).toContain(`PRINCIPIA_FORUM_TOKEN=tok-${step.id}`)
    expect(step.output).toContain(`PATH=${bin}:`)
    expect(closed).toEqual([opened[0].stepId])
  })

  it('a run without a seat gets no Forum, and codex gets env + CLI but no MCP server', async () => {
    const { ctx, opened } = setup()
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'done' })), codex: fakeAdapter('codex', calls, () => ({ output: 'done' })) }, detect: fakeProviders() })
    await engine.init()
    await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'hi' }, { trigger: 'manual', companyId: 'co_acme' }).id)
    expect(opened).toHaveLength(0)
    expect(calls[0].prompt).not.toContain('principia-forum')
    await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'Work' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_marcus' }).id)
    expect(opened[0].adapter).toBe('codex')
    expect(calls[1].prompt).toContain('<principia-forum')
    expect((calls[1].mcpArgs ?? []).join(' ')).not.toContain('principia-forum')
  })

  it('a seat run with no board task (a Forum reply) still gets that seat\'s Forum', async () => {
    const { ctx, opened } = setup()
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'Ciao!' })) }, detect: fakeProviders() })
    await engine.init()
    const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'Forum reply in #marketing' }, { trigger: 'manual', companyId: 'co_acme', agentId: 'agt_marcus' }).id)
    expect(run.status).toBe('passed')
    expect(opened[0]).toMatchObject({ taskId: null, agentId: 'agt_marcus', adapter: 'claude' })
    expect(calls[0].prompt.startsWith('<principia-forum you="@marcus" v="1">')).toBe(true)
    const args = calls[0].mcpArgs ?? []
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('mcp__principia-forum__forum_post')
  })
})
