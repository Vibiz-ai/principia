import { describe, expect, it } from 'vitest'
import { createEngineWith } from '../index'
import { addWorkflow, fakeAdapter, fakeCtx, fakeProviders, makeEngine, profile, waitRun, type FakeCall } from './fakes'
import type { RunWorktree } from '../../../shared/types'
import type { CompanyBridge, StepOutputEvent } from '../../../shared/engine'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

describe('company Passport in interactive sessions', () => {
  for (const adapter of ['claude', 'codex'] as const) {
    it(`${adapter}: adds only scoped context without initiating a task`, async () => {
      const ctx = fakeCtx()
      ctx.passportContext = cwd => cwd === '/company-a' ? 'Company Passport: A\nBrand voice: clear' : null
      const engine = createEngineWith(ctx, { detect: fakeProviders() })
      await engine.init()
      const spawn = engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', cwd: '/company-a' })
      expect(spawn.args.join(' ')).toContain('Company Passport: A')
      if (adapter === 'codex') {
        const config = spawn.args.find(arg => arg.startsWith('developer_instructions='))!
        expect(JSON.parse(config.slice(config.indexOf('=') + 1))).toContain('Brand voice: clear')
        expect(spawn.args.at(-1)).toBe(config)
      } else {
        expect(spawn.args[spawn.args.indexOf('--append-system-prompt') + 1]).toContain('Brand voice: clear')
      }
      for (const cwd of [undefined, '/company-b']) {
        expect(engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', cwd }).args.join(' ')).not.toContain('Company Passport')
      }
      expect(engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', cwd: '/company-a', resumeAgentSessionId: 'existing' }).args.join(' ')).not.toContain('Company Passport')
    })
  }
})

describe('department chats (DEPARTMENTS.md §9)', () => {
  for (const adapter of ['claude', 'codex'] as const) {
    it(`${adapter}: the department slot is asked for, the chat brief follows the Passport block, the folders are added`, async () => {
      const ctx = fakeCtx()
      const asked: (string | null | undefined)[] = []
      ctx.passportContext = (_cwd, companyId, departmentId) => {
        asked.push(departmentId)
        return companyId === 'co_a' ? `Company Passport: A${departmentId ? '\n## [[Marketing]] (department)' : ''}` : null
      }
      const engine = createEngineWith(ctx, { detect: fakeProviders() })
      await engine.init()
      const spawn = engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', cwd: '/w', companyId: 'co_a', departmentId: 'dep_m', chatBrief: '## This chat: the Marketing department of Acme', addDirs: ['/r/web'] })
      expect(asked.at(-1)).toBe('dep_m')
      const text = adapter === 'codex' ? spawn.args.find((a) => a.startsWith('developer_instructions='))! : spawn.args[spawn.args.indexOf('--append-system-prompt') + 1]!
      expect(text.indexOf('(department)')).toBeGreaterThan(text.indexOf('Company Passport: A'))
      expect(text.indexOf('## This chat')).toBeGreaterThan(text.indexOf('(department)'))
      expect(spawn.args).toContain('--add-dir')
      expect(spawn.args[spawn.args.indexOf('--add-dir') + 1]).toBe('/r/web')
    })
  }
})

describe('company Passport in workflow execution', () => {
  it.each([false, true])('preserves scope and redacts context through fallback (worktree=%s)', async (isolated) => {
    const ctx = fakeCtx()
    const repo = { id: 'repo_aaaaaaaaaa', name: 'A', path: ctx.root, addedAt: '', exists: true, isGit: true, liveSessions: 0 }
    ctx.repos.set(repo.id, repo)
    ctx.profiles.set('p', profile('p', 'claude'))
    ctx.secretValues.PASSPORT_SECRET = 'never-print-this'
    ctx.passportContext = cwd => cwd === repo.path ? 'Company Passport: A\nContext never-print-this' : null
    let wt: RunWorktree | null = null
    ctx.worktrees = { async ensure(req) {
      const path = join(ctx.root, 'isolated'); mkdirSync(path, { recursive: true })
      return wt = { id: 'wt_test', runId: req.runId, repoId: repo.id, repoPath: repo.path, path, branch: 'test', base: 'main', status: 'active', keptReason: null, error: null, createdAt: '', removedAt: null }
    }, async finish() { return wt } }
    const calls: FakeCall[] = []
    const workflow = addWorkflow(ctx, { name: 'Scoped context', description: '', inputs: [], ...(isolated ? { worktree: { repo: repo.id } } : {}), nodes: [
      { id: 'agent', type: 'agent', label: 'Agent', after: [], cwd: isolated ? null : repo.id, ...(isolated ? { isolate: 'worktree' as const } : {}), timeoutMin: 1, profileId: 'p', prompt: 'Fix the issue', memory: 'off' },
      { id: 'shell', type: 'shell', label: 'Shell', after: ['agent'], cwd: repo.id, timeoutMin: 1, command: 'echo shell-intact' }
    ] })
    const engine = await makeEngine(ctx, { available: ['claude', 'codex', 'shell'], adapters: {
      claude: fakeAdapter('claude', calls, () => ({ output: 'Usage limit reached', exitCode: 1, isError: true })),
      codex: fakeAdapter('codex', calls, () => ({ output: 'Done' }))
    } })
    try {
      const done = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: workflow.id, inputs: {} }, { trigger: 'manual' }).id)
      expect(done.status).toBe('passed')
      expect(calls.map(c => c.adapter)).toEqual(['claude', 'codex'])
      for (const call of calls) { expect(call.prompt).toContain('Company Passport: A'); expect(call.prompt).not.toContain('never-print-this'); expect(call.prompt).toContain('Fix the issue') }
      expect(ctx.store.stepsOf(done.id).find(s => s.nodeId === 'shell')?.output).toBe('shell-intact')
    } finally { await engine.shutdown() }
  })
})

// ---------- COMPANY.md §4-§6: execution isolation (fake company module; the real one is covered in executionIsolation.test.ts) ----------

const A = 'co_acme'
const B = 'co_beta'
const PERSONAL = 'co_personal'
const NAMES: Record<string, string> = { [A]: 'Acme', [B]: 'Beta', [PERSONAL]: 'Personal' }

/** Repos owned per company, workflows per company, and the company keys of a two-company install. */
function companyWorld(opts: { enforced?: boolean } = {}) {
  const ctx = fakeCtx()
  const repoAt = (id: string, name: string) => {
    const path = join(ctx.root, name); mkdirSync(path, { recursive: true })
    const r = { id, name, path, addedAt: '', exists: true, isGit: true, liveSessions: 0 }
    ctx.repos.set(id, r)
    return r
  }
  const repoA = repoAt('repo_acmeaaaaaa', 'acme-web')
  const repoB = repoAt('repo_betabbbbbb', 'beta-api')
  const owner = new Map<string, string>([[repoA.id, A], [repoB.id, B]])
  const wfCompany = new Map<string, string>()
  const state = { enforced: !!opts.enforced }
  ctx.listRepos = () => [...ctx.repos.values()]
  const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
  // realpath match, like scope.ts locate
  const repoOfCwd = (cwd: string) => [...ctx.repos.values()].find(r => real(cwd) === real(r.path) || real(cwd).startsWith(real(r.path) + '/'))
  const company: CompanyBridge = {
    resolve: q => q.companyId ?? (q.workflowId ? wfCompany.get(q.workflowId) ?? PERSONAL
      : q.scheduleId ? ctx.store.getSchedule(q.scheduleId)?.companyId ?? PERSONAL
      : q.repoId ? owner.get(q.repoId) ?? PERSONAL
      : q.cwd ? owner.get(repoOfCwd(q.cwd)?.id ?? '') ?? PERSONAL : PERSONAL),
    crossCompany: (id, refs) => {
      const other = refs.repoId ? owner.get(refs.repoId) ?? PERSONAL
        : refs.workflowId ? wfCompany.get(refs.workflowId) ?? PERSONAL
        : refs.cwd && repoOfCwd(refs.cwd) ? owner.get(repoOfCwd(refs.cwd)!.id) ?? PERSONAL : null
      return other && other !== id ? `That repository belongs to ${NAMES[other]}; open it from ${NAMES[other]}` : null
    },
    enforced: () => state.enforced,
    workspaceDir: id => { const dir = join(ctx.root, 'companies', id, 'workspace'); mkdirSync(dir, { recursive: true }); return dir },
    repoIds: id => [...owner].filter(([, c]) => c === id).map(([r]) => r)
  }
  ctx.company = company
  // company keys overlay shared ones; '*' = shared + this company's (vault.ts semantics)
  const keys: Record<string, Record<string, string>> = { shared: { SHARED_KEY: 'shared-value-1', OVERRIDE_KEY: 'shared-override' }, [A]: { ACME_KEY: 'acme-value-1', OVERRIDE_KEY: 'acme-override' }, [B]: { BETA_KEY: 'beta-value-1' } }
  const resolvedFor: (string | null)[] = []
  ctx.secrets.resolve = (names, companyId) => {
    resolvedFor.push(companyId ?? null)
    const pool = { ...keys.shared, ...(companyId ? keys[companyId] ?? {} : {}) }
    return Object.fromEntries(Object.entries(pool).filter(([n]) => names.includes('*') || names.includes(n)))
  }
  ctx.secrets.names = (names, companyId) => Object.keys({ ...keys.shared, ...(companyId ? keys[companyId] ?? {} : {}) }).filter(n => names.includes('*') || names.includes(n))
  const passports: { cwd: string; companyId: string | null }[] = []
  ctx.passportContext = (cwd, companyId) => {
    passports.push({ cwd, companyId: companyId ?? null })
    return companyId ? `Company Passport: ${NAMES[companyId]}` : null
  }
  const addCompanyWorkflow = (companyId: string, draft: Parameters<typeof addWorkflow>[1]) => {
    const wf = addWorkflow(ctx, draft)
    wfCompany.set(wf.id, companyId)
    ctx.workflows.set(wf.id, { ...wf, companyId })
    return wf
  }
  return { ctx, repoA, repoB, state, passports, resolvedFor, addCompanyWorkflow }
}
const AGENTS = ['claude', 'codex', 'gemini', 'cursor'] as const

describe('company isolation: Passport context by company id', () => {
  it.each(AGENTS)('%s interactive session: the session company decides, never the cwd', async (adapter) => {
    const { ctx, repoB, passports } = companyWorld()
    const engine = createEngineWith(ctx, { detect: fakeProviders() })
    await engine.init()
    // a chat of Acme opened in a Beta folder still gets Acme's Passport (the guard lives in sessions.ts)
    const spawn = engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', cwd: repoB.path, companyId: A })
    expect(passports.at(-1)).toEqual({ cwd: repoB.path, companyId: A })
    const args = spawn.args.join(' ')
    if (adapter === 'claude' || adapter === 'codex') expect(args).toContain('Company Passport: Acme')
    expect(args).not.toContain('Beta')
    // a repo-less chat (no cwd) still gets its company's Passport
    engine.providers.interactiveSpawn(profile('p', adapter), { artifactsDir: '/a', companyId: B })
    expect(passports.at(-1)).toEqual({ cwd: '', companyId: B })
  })

  it.each(AGENTS)('%s prompt run: stamped with the repo company; Passport, keys and HIVE_REPOS from that company only', async (adapter) => {
    const { ctx, repoA, repoB, passports, resolvedFor } = companyWorld({ enforced: true })
    ctx.profiles.set('p', profile('p', adapter))
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { available: [adapter, 'shell'], adapters: {
      [adapter]: fakeAdapter(adapter, calls, () => ({ output: 'done', echoEnv: ['ACME_KEY', 'BETA_KEY', 'SHARED_KEY', 'OVERRIDE_KEY', 'HIVE_REPOS'] }))
    } })
    try {
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: repoA.id, prompt: 'Ship it', memory: 'off' }, { trigger: 'manual' })
      expect(run.companyId).toBe(A)
      const done = await waitRun(ctx, run.id)
      expect(done.status).toBe('passed')
      expect(calls[0].prompt).toContain('Company Passport: Acme')
      expect(passports.every(p => p.companyId === A)).toBe(true)
      expect(resolvedFor.every(c => c === A)).toBe(true)
      const out = ctx.store.stepsOf(done.id)[0].output!
      expect(out).toContain('ACME_KEY=acme-value-1')
      expect(out).toContain('BETA_KEY=<unset>')
      expect(out).toContain('SHARED_KEY=shared-value-1')
      expect(out).toContain('OVERRIDE_KEY=acme-override')
      expect(out).toContain(`HIVE_REPOS=${repoA.path}`)
      expect(out).not.toContain(repoB.path)
      expect(calls[0].keyNames).toEqual(expect.arrayContaining(['ACME_KEY', 'SHARED_KEY']))
      expect(calls[0].keyNames).not.toContain('BETA_KEY')
    } finally { await engine.shutdown() }
  })
})

describe('company isolation: runs', () => {
  it('stamps by inheritance: workflow, then schedule, then repo, then the explicit id; Personal otherwise', async () => {
    const { ctx, repoA, addCompanyWorkflow } = companyWorld()
    ctx.profiles.set('p', profile('p', 'shell'))
    const engine = await makeEngine(ctx, { available: ['shell'] })
    try {
      const wf = addCompanyWorkflow(B, { name: 'Beta flow', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'S', after: [], cwd: null, timeoutMin: 1, command: 'true' }] })
      expect(engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).companyId).toBe(B)
      expect(engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: repoA.id, prompt: 'x' }, { trigger: 'manual' }).companyId).toBe(A)
      expect(engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'manual', companyId: B }).companyId).toBe(B)
      expect(engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'manual' }).companyId).toBe(PERSONAL)
      ctx.store.schedules.set('sch_1', { id: 'sch_1', companyId: A } as never)
      expect(engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'schedule', scheduleId: 'sch_1' }).companyId).toBe(A)
      // a rerun of a prompt run stays in its company
      const first = engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'manual', companyId: B })
      await waitRun(ctx, first.id)
      expect(engine.runs.rerun(first.id).companyId).toBe(B)
    } finally { await engine.shutdown() }
  })

  it('enforced: a launch from another company is refused; off: it warns and still stamps', async () => {
    const { ctx, repoB, state, addCompanyWorkflow } = companyWorld({ enforced: true })
    const warnings: string[] = []
    ctx.log = { ...ctx.log, warn: (m) => void warnings.push(m) }
    ctx.profiles.set('p', profile('p', 'shell'))
    const engine = await makeEngine(ctx, { available: ['shell'] })
    try {
      const wf = addCompanyWorkflow(B, { name: 'Beta flow', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'S', after: [], cwd: null, timeoutMin: 1, command: 'true' }] })
      expect(() => engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'agent', companyId: A })).toThrow(/belongs to Beta/)
      expect(() => engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: repoB.id, prompt: 'x' }, { trigger: 'manual', companyId: A })).toThrow(/belongs to Beta/)
      state.enforced = false
      const run = engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: repoB.id, prompt: 'x' }, { trigger: 'manual', companyId: A })
      expect(run.companyId).toBe(B)
      expect(warnings.some(w => /company guard/.test(w))).toBe(true)
    } finally { await engine.shutdown() }
  })

  it.each([true, false])('a step folder of another company fails the step when enforced (enforced=%s)', async (enforced) => {
    const { ctx, repoA, repoB, addCompanyWorkflow } = companyWorld({ enforced })
    const engine = await makeEngine(ctx, { available: ['shell'] })
    try {
      // the folder comes from an input at run time, so only the executor can catch it (a symlink too)
      const link = join(ctx.root, 'innocent-link'); symlinkSync(repoB.path, link)
      const wf = addCompanyWorkflow(A, { name: 'Acme flow', description: '', inputs: [{ name: 'dir', label: 'Dir' }], nodes: [
        { id: 'own', type: 'shell', label: 'Own', after: [], cwd: repoA.id, timeoutMin: 1, command: 'echo own' },
        { id: 'other', type: 'shell', label: 'Other', after: ['own'], cwd: '{{inputs.dir}}', timeoutMin: 1, command: 'echo leaked' }
      ] })
      const done = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { dir: link } }, { trigger: 'manual' }).id)
      const steps = ctx.store.stepsOf(done.id)
      expect(steps.find(s => s.nodeId === 'own')?.output).toBe('own')
      if (enforced) {
        expect(done.status).toBe('failed')
        expect(done.reason ?? '').toMatch(/belongs to Beta/)
        expect(steps.find(s => s.nodeId === 'other')?.output ?? '').not.toContain('leaked')
      } else {
        expect(done.status).toBe('passed')
        expect(steps.find(s => s.nodeId === 'other')?.output).toBe('leaked')
      }
    } finally { await engine.shutdown() }
  })

  it('repo-less nodes run in the company workspace, never the shared scratch dir', async () => {
    const { ctx, addCompanyWorkflow } = companyWorld()
    const engine = await makeEngine(ctx, { available: ['shell'] })
    try {
      const wf = addCompanyWorkflow(A, { name: 'Acme chat', description: '', inputs: [], nodes: [{ id: 's', type: 'shell', label: 'S', after: [], cwd: null, timeoutMin: 1, command: 'pwd' }] })
      const done = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
      expect(realpathSync(ctx.store.stepsOf(done.id)[0].output!)).toBe(realpathSync(join(ctx.root, 'companies', A, 'workspace')))
    } finally { await engine.shutdown() }
  })
})

describe('company isolation: onStepOutput (harvester hook)', () => {
  it('fires once per agent step with company, memory mode, transport and the redacted output; never for shell; a throwing hook never breaks the run', async () => {
    const { ctx, repoA } = companyWorld()
    ctx.secretValues.SECRET_X = 'very-secret-x'
    ctx.secrets.redact = (t) => t.split('very-secret-x').join('••••SECRET_X')
    ctx.profiles.set('p', profile('p', 'codex'))
    const seen: StepOutputEvent[] = []
    ctx.onStepOutput = (e) => { seen.push(e); throw new Error('harvester bug') }
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { available: ['codex', 'shell'], adapters: { codex: fakeAdapter('codex', calls, () => ({ output: 'notes very-secret-x <passport-notes>### [[Acme]]</passport-notes>' })) } })
    try {
      const done = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: repoA.id, prompt: 'x', memory: 'read-write' }, { trigger: 'manual' }).id)
      expect(done.status).toBe('passed')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ runId: done.id, nodeId: 'prompt', adapter: 'codex', companyId: A, memory: 'read-write', transport: null, status: 'passed' })
      expect(seen[0].output).toContain('<passport-notes>')
      expect(seen[0].output).not.toContain('very-secret-x')
    } finally { await engine.shutdown() }
  })
})
