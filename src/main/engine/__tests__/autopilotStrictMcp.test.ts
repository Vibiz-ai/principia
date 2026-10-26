/**
 * AUTOPILOT.md §6: a money autopilot's claude step loads only Principia's own MCP servers, so an ads server from the
 * agent's own setup is never reachable and every ads call goes through the gateway's check before it is made.
 */
import { describe, expect, it } from 'vitest'
import { claudeAdapter, MONEY_DENIED_TOOLS, stripMcpArgs } from '../adapters'
import type { AgentProfile } from '../../../shared/types'
import { addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile as fakeProfile, waitRun, type FakeCall } from './fakes'

const profile = (extraArgs: string[]): AgentProfile => ({ id: 'p', name: 'Claude', adapter: 'claude', permissionMode: 'bypass', secretNames: [], useApiKeyAuth: false, extraArgs }) as unknown as AgentProfile

describe('strict MCP for money autopilots', () => {
  it('adds --strict-mcp-config and drops the profile’s own MCP servers', () => {
    const inv = claudeAdapter.headless({ profile: profile(['--mcp-config', '/x/ads.json', '/y/more.json', '--model', 'opus']), prompt: 'watch ads', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh', mcpArgs: ['--mcp-config', '/principia/gateway.json'], strictMcp: true })
    expect(inv.args).toContain('--strict-mcp-config')
    expect(inv.args).toContain('/principia/gateway.json')
    expect(inv.args).not.toContain('/x/ads.json')
    expect(inv.args).not.toContain('/y/more.json')
    expect(inv.args).toContain('--dangerously-skip-permissions')
    expect(inv.args.filter((a) => a === '--mcp-config')).toHaveLength(1)
    // no terminal, no file writing, no web requests, no subagents: an ads API is never reached around the gateway
    const i = inv.args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThan(-1)
    const denied = inv.args[i + 1]!.split(',')
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'Agent']) expect(denied).toContain(t)
    expect(MONEY_DENIED_TOOLS).not.toContain('WebSearch')
    // before the variadic flag's end: --session-id follows
    expect(inv.args.indexOf('--session-id')).toBeGreaterThan(i)
  })
  it('leaves other steps as they were', () => {
    const inv = claudeAdapter.headless({ profile: profile(['--mcp-config', '/x/ads.json']), prompt: 'x', artifactsDir: '/a/', resumeId: null, shell: '/bin/sh' })
    expect(inv.args).not.toContain('--strict-mcp-config')
    expect(inv.args).not.toContain('--disallowedTools')
    expect(inv.args).toContain('/x/ads.json')
  })
  it('strips both spellings', () => {
    expect(stripMcpArgs(['--mcp-config=/a.json', '--strict-mcp-config', '--model', 'x', '--mcp-config', '/b.json', '-v'])).toEqual(['--model', 'x', '-v'])
  })
})

describe('a money autopilot’s run in the engine', () => {
  const agentNode = (profileId: string) => ({ id: 'a', type: 'agent' as const, label: 'a', after: [], cwd: null, timeoutMin: 1, profileId, prompt: 'watch the ads' })
  const setup = async (adapter: 'claude' | 'codex') => {
    const ctx = fakeCtx()
    ctx.autopilot = { strictMcp: () => true }
    ctx.profiles.set('p', fakeProfile('p', adapter))
    ctx.secretValues = { META_ACCESS_TOKEN: 'meta-secret-1234', OPENAI_NOTE: 'keep-1234' }
    const calls: FakeCall[] = []
    const fake = fakeAdapter(adapter, calls, () => ({ output: 'ok', echoEnv: ['META_ACCESS_TOKEN', 'OPENAI_NOTE'] }))
    const wf = addWorkflow(ctx, { name: 'Ads watch', description: '', inputs: [], nodes: [agentNode('p')] })
    const engine = await makeEngine(ctx, { adapters: { [adapter]: fake }, available: [adapter, 'shell'] })
    const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
    return { ctx, calls, run }
  }
  it('a claude step runs strict, and never holds the ads account’s keys', async () => {
    const { ctx, calls, run } = await setup('claude')
    expect(run.status).toBe('passed')
    expect(calls[0]!.strictMcp).toBe(true)
    const out = ctx.store.stepsOf(run.id)[0]!.output ?? ''
    expect(out).toContain('META_ACCESS_TOKEN=<unset>')
    expect(out).not.toContain('OPENAI_NOTE=<unset>')
  })
  it('another agent (no such strict mode) is refused, in plain words', async () => {
    const { ctx, calls, run } = await setup('codex')
    expect(run.status).toBe('failed')
    expect(calls).toHaveLength(0)
    expect(ctx.store.stepsOf(run.id)[0]!.error).toMatch(/only Claude Code can be kept to Principia's checked connections/)
  })
})
