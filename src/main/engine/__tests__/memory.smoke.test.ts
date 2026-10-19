/**
 * Real-CLI smoke for the engine's memory wiring (MEMORY.md 13.2 acceptance, engine half).
 * Opt-in: HIVE_REAL_CLAUDE=1 npx vitest run src/main/engine/__tests__/memory.smoke.test.ts
 * Uses the installed `claude` (subscription login; costs a few cents) and the stub hivemem server fixture
 * (same protocol/tools as src/main/memory/server). Run A (read-write, bypass) writes a fact through
 * mcp__hivemem__memory_write; run B (read, permissionMode 'default' so only --allowedTools can approve the call)
 * finds it with memory_search. Both with --max-turns 3.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryBridge, MemoryGrant, MemoryGrantRequest } from '../../../shared/engine'
import { createEngineWith } from '../index'
import { fakeCtx, profile, waitRun } from './fakes'

const STUB = join(__dirname, 'fixtures', 'stub-hivemem.cjs')

describe.skipIf(!process.env.HIVE_REAL_CLAUDE)('memory smoke: real claude -p against hivemem', () => {
  it('step A writes, step B (separate run, read) finds it via memory_search', async () => {
    const ctx = fakeCtx()
    const store = join(ctx.root, 'stub-memory.json')
    const reqs: MemoryGrantRequest[] = []
    const released: string[] = []
    let n = 0
    const bridge: MemoryBridge = {
      grant(req) {
        reqs.push(req)
        const grantId = `mgr_smoke${String(++n).padStart(5, '0')}`
        const g: MemoryGrant = {
          grantId,
          server: {
            name: 'hivemem',
            command: process.execPath,
            args: [STUB],
            env: { HIVE_MEM_GRANT: grantId, HIVE_STUB_STORE: store, HIVE_STUB_MODE: req.mode }
          },
          toolNames: req.mode === 'read-write' ? ['memory_search', 'memory_get', 'memory_write', 'memory_invalidate'] : ['memory_search', 'memory_get'],
          spawnDir: join(ctx.root, 'memory', 'spawn'),
          brief: ''
        }
        return g
      },
      release: (id) => void released.push(id)
    }
    ctx.memory = bridge
    // Like main's login-shell env: drop the parent Claude Code session's own vars.
    ctx.baseEnv = () =>
      Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(CLAUDE|CLAUDECODE)/.test(k))) as Record<string, string>
    const extraArgs = ['--max-turns', '3']
    ctx.profiles.set('p_w', profile('p_w', 'claude', { model: 'haiku', extraArgs }))
    ctx.profiles.set('p_r', profile('p_r', 'claude', { model: 'haiku', extraArgs, permissionMode: 'default' }))
    const engine = createEngineWith(ctx)
    await engine.init()

    const a = engine.runs.start(
      {
        kind: 'prompt',
        profileId: 'p_w',
        repoId: null,
        memory: 'read-write',
        prompt:
          'Call the mcp__hivemem__memory_write tool exactly once with entity "hive-smoke" and one fact of kind "convention": "The build cache lives in .hive-cache-7731". Then reply DONE.'
      },
      { trigger: 'manual' }
    )
    const ra = await waitRun(ctx, a.id, 180_000)
    const stepA = ctx.store.stepsOf(a.id)[0]
    expect(ra.status, `${ra.reason}\n${stepA.output}`).toBe('passed')
    const dbA = JSON.parse(readFileSync(store, 'utf8'))
    expect(dbA.facts).toHaveLength(1)
    expect(dbA.facts[0]).toMatchObject({ entity: 'hive-smoke', grant: 'mgr_smoke00001' })
    expect(dbA.facts[0].text).toContain('.hive-cache-7731')
    expect(readFileSync(stepA.logPath, 'utf8')).toContain('--mcp-config')

    const b = engine.runs.start(
      {
        kind: 'prompt',
        profileId: 'p_r',
        repoId: null,
        memory: 'read',
        prompt: 'Use the mcp__hivemem__memory_search tool with query "hive-smoke build cache" and reply with only the directory name it mentions.'
      },
      { trigger: 'manual' }
    )
    const rb = await waitRun(ctx, b.id, 180_000)
    const stepB = ctx.store.stepsOf(b.id)[0]
    expect(rb.status, `${rb.reason}\n${stepB.output}`).toBe('passed')
    expect(stepB.output).toContain('.hive-cache-7731')
    const dbB = JSON.parse(readFileSync(store, 'utf8'))
    expect(dbB.calls.some((c: { name: string; grant: string }) => c.name === 'memory_search' && c.grant === 'mgr_smoke00002')).toBe(true)
    expect(dbB.facts).toHaveLength(1) // read grant: no write tools
    expect(reqs.map((r) => [r.mode, r.transport])).toEqual([
      ['read-write', 'mcp'],
      ['read', 'mcp']
    ])
    expect(released).toEqual(['mgr_smoke00001', 'mgr_smoke00002'])
    // readable step log shows the memory call
    const chunks = ctx.events.filter((e) => e.type === 'step.output').map((e) => (e as { chunk: string }).chunk).join('')
    expect(chunks).toContain('[memory] write hive-smoke (1 fact)')
    expect(chunks).toContain('[memory] search')
  }, 400_000)
})
