import { describe, expect, it } from 'vitest'
import { baseChildEnv, isInheritedMarker, mergePath, parseEnvDump } from '../loginEnv'
import { slotLabel } from '../engine/scheduler'
import { buildChildEnv } from '../childEnv'
import { maskSecret, parseEnvText } from '../envParse'
import { classify, isIgnoredRel } from '../artifactKinds'
import { isInside } from '../pathGuard'
import { TailBuffer } from '../tailBuffer'
import { nextFireLabel, shortDuration, trayMenuModel, trayTitle } from '../trayModel'
import type { Session, StatusSnapshot } from '../../shared/types'
import type { AgentNode, Ask } from '../../shared/live'
import type { HiveApi } from '../../shared/ipc'
import type { VaultGraph, VaultNoteText, VaultStatus } from '../../shared/passport'
import type { MemoryGraph } from '../../shared/memory'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { LiveStore } from '../db/liveStore'
import { CompanySecrets, KeyNamespaces } from '../db/companySecrets'
import { CompanyStore } from '../company'
import { Vault, type Cipher } from '../vault'
import { REQUEST_SCHEMAS } from '../ipcSchemas'
import { guardWorkflowTargets, requireCompany } from '../handlers/companyScope'
import { scheduleCompany } from '../handlers/schedules'

describe('loginEnv (SPEC A14)', () => {
  it('parses env -0 output between markers and drops shell noise', () => {
    const out =
      'motd junk\n__HIVE_ENV_START__PATH=/a:/b\0HOME=/Users/x\0PWD=/tmp\0SHLVL=2\0_=/usr/bin/env\0OLDPWD=/\0TERM_PROGRAM=iTerm\0CLAUDE_CONFIG_DIR=/c\0MULTI=line1\nline2\0__HIVE_ENV_END__trailing'
    const env = parseEnvDump(out)!
    expect(env).toEqual({ PATH: '/a:/b', HOME: '/Users/x', CLAUDE_CONFIG_DIR: '/c', MULTI: 'line1\nline2' })
  })
  it('returns null without markers', () => {
    expect(parseEnvDump('nothing here')).toBeNull()
  })
  it('merges PATH in order without duplicates', () => {
    expect(mergePath('/a:/b', '/b:/c', null, '/a:/d')).toBe('/a:/b:/c:/d')
  })
  it('base child env strips Electron internals and sets terminal vars', () => {
    const env = baseChildEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', VITE_DEV: '1', HOME: '/h' })
    expect(env).toEqual({ PATH: '/x', HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor', HIVE: '1' })
  })
  it('strips a parent Claude Code session markers but keeps user Claude config', () => {
    const env = baseChildEnv({
      PATH: '/x',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      npm_lifecycle_event: 'dev',
      HIVE_RESOLVING_ENV: '1'
    })
    expect(env).toEqual({
      PATH: '/x',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_USE_BEDROCK: '1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HIVE: '1'
    })
    expect(isInheritedMarker('CLAUDE_CODE_MESSAGING_TOKEN')).toBe(true)
    expect(isInheritedMarker('ANTHROPIC_API_KEY')).toBe(false)
    // a Hive started from a Codex tool shell
    expect(isInheritedMarker('NO_COLOR')).toBe(true)
    expect(isInheritedMarker('CODEX_THREAD_ID')).toBe(true)
    expect(isInheritedMarker('CODEX_HOME')).toBe(false)
  })
})

describe('catch-up slot label (SPEC 8.2)', () => {
  const when = { kind: 'cron' as const, cron: '0 9 * * *', tz: 'Europe/Madrid' }
  it('formats the slot in the schedule tz as HH:mm on the same day', () => {
    expect(slotLabel(new Date('2026-10-15T07:00:00.000Z'), when, new Date('2026-10-15T12:00:00.000Z'))).toBe('09:00')
  })
  it('adds the weekday when the slot is not today', () => {
    expect(slotLabel(new Date('2026-10-14T07:00:00.000Z'), when, new Date('2026-10-15T08:00:00.000Z'))).toBe('Wed 09:00')
  })
})

describe('child env (CONTRACT §2.2, SPEC A6)', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'from-shell' }
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant-1', OPENAI_API_KEY: 'sk-oai', FAL_KEY: 'fal' }
  const hive = { ARTIFACTS_DIR: '/a/', HIVE_SESSION_ID: 's_1' }
  it('claude never receives Anthropic auth vars unless useApiKeyAuth', () => {
    const env = buildChildEnv({ base, secrets, profile: { adapter: 'claude', useApiKeyAuth: false }, hive })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe('sk-oai')
    expect(env.FAL_KEY).toBe('fal')
    expect(env.ARTIFACTS_DIR).toBe('/a/')
  })
  it('useApiKeyAuth keeps them', () => {
    const env = buildChildEnv({ base, secrets, profile: { adapter: 'claude', useApiKeyAuth: true }, hive })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-1')
  })
  it('codex loses OPENAI_API_KEY, shell keeps everything', () => {
    expect(buildChildEnv({ base, secrets, profile: { adapter: 'codex', useApiKeyAuth: false }, hive }).OPENAI_API_KEY).toBeUndefined()
    const sh = buildChildEnv({ base, secrets, profile: { adapter: 'shell', useApiKeyAuth: false }, hive })
    expect(sh.OPENAI_API_KEY).toBe('sk-oai')
    expect(sh.ANTHROPIC_API_KEY).toBe('sk-ant-1')
  })
  it('honours SpawnSpec.stripEnv and lets Hive vars win', () => {
    const env = buildChildEnv({
      base,
      specEnv: { ARTIFACTS_DIR: '/wrong', X: '1' },
      secrets,
      stripEnv: ['FAL_KEY'],
      profile: { adapter: 'gemini', useApiKeyAuth: false },
      hive
    })
    expect(env.FAL_KEY).toBeUndefined()
    expect(env.X).toBe('1')
    expect(env.ARTIFACTS_DIR).toBe('/a/')
  })
})

describe('.env parsing (SPEC K4)', () => {
  it('parses 5 lines with one comment into 4 entries', () => {
    const text = `# my keys\nexport OPENAI_API_KEY="sk-abc123456789"\nFAL_KEY='fal-xyz'\nSTRIPE_SECRET_KEY=sk_live_1234 # prod\nREPLICATE_API_TOKEN=r8_token\n`
    const e = parseEnvText(text)
    expect(e.map((x) => x.name)).toEqual(['OPENAI_API_KEY', 'FAL_KEY', 'STRIPE_SECRET_KEY', 'REPLICATE_API_TOKEN'])
    expect(e.find((x) => x.name === 'STRIPE_SECRET_KEY')!.value).toBe('sk_live_1234')
    expect(e.find((x) => x.name === 'OPENAI_API_KEY')!.value).toBe('sk-abc123456789')
    expect(e.every((x) => x.valid)).toBe(true)
  })
  it('flags invalid names and empty values', () => {
    const e = parseEnvText('lower_case=1\nEMPTY=\n')
    expect(e.map((x) => x.valid)).toEqual([false, false])
  })
  it('handles multi-line double-quoted values', () => {
    const e = parseEnvText('PEM="-----BEGIN\nabc\n-----END"\nNEXT=1')
    expect(e[0].value).toBe('-----BEGIN\nabc\n-----END')
    expect(e[1].name).toBe('NEXT')
  })
  it('masks without revealing more than the last 4 chars', () => {
    expect(maskSecret('sk-abcdefghijklmnop1a2b')).toBe('sk-…1a2b')
    expect(maskSecret('short')).toBe('••••')
    expect(maskSecret('abcdefghijklmnop')).toBe('…mnop')
  })
})

describe('artifacts', () => {
  it('classifies by extension', () => {
    expect(classify('/x/a.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
    expect(classify('b.mov').kind).toBe('video')
    expect(classify('c.md').kind).toBe('markdown')
    expect(classify('d.html').kind).toBe('html')
    expect(classify('e.ts').kind).toBe('code')
    expect(classify('f.pdf').kind).toBe('pdf')
    expect(classify('g.m4a').kind).toBe('audio')
    expect(classify('noext')).toEqual({ kind: 'other', mime: 'application/octet-stream' })
  })
  it('ignores dotfiles, node_modules', () => {
    expect(isIgnoredRel('r_1/.DS_Store')).toBe(true)
    expect(isIgnoredRel('r_1/node_modules/x.js')).toBe(true)
    expect(isIgnoredRel('r_1/.git/HEAD')).toBe(true)
    expect(isIgnoredRel('r_1/out/a.png')).toBe(false)
  })
  it('path confinement', () => {
    expect(isInside('/root/a/b', '/root')).toBe(true)
    expect(isInside('/root', '/root')).toBe(true)
    expect(isInside('/root2/a', '/root')).toBe(false)
    expect(isInside('/root/../etc', '/root')).toBe(false)
  })
})

describe('TailBuffer', () => {
  it('keeps at most max chars, cut at a line start', () => {
    const t = new TailBuffer(100)
    for (let i = 0; i < 100; i++) t.append(`line ${i}\n`)
    const s = t.toString()
    expect(s.length).toBeLessThanOrEqual(100)
    expect(s.endsWith('line 99\n')).toBe(true)
    expect(s.startsWith('line ')).toBe(true)
  })
})

describe('tray (SPEC A12)', () => {
  const base: StatusSnapshot = {
    runningSessions: 0,
    runningRuns: 0,
    queuedRuns: 0,
    schedulesPaused: false,
    nextFire: null,
    last24h: { passed: 0, failed: 0 },
    unseenFailures: 0
  }
  it('title: empty idle, ● N running, ✕ unseen, ⏸ paused', () => {
    expect(trayTitle(base)).toBe('')
    expect(trayTitle({ ...base, runningSessions: 2, runningRuns: 1 })).toBe('● 3')
    expect(trayTitle({ ...base, runningSessions: 1, unseenFailures: 2 })).toBe('● 1 ✕')
    expect(trayTitle({ ...base, schedulesPaused: true })).toBe('⏸')
  })
  it('menu has the exact A12 structure and no Run Workflow / Launch at Login', () => {
    const now = new Date('2026-10-15T09:00:00Z')
    const items = trayMenuModel({
      status: { ...base, runningSessions: 1, unseenFailures: 1, nextFire: { scheduleId: 'sch_1', name: 'Daily ads', at: '2026-10-15T09:41:00Z' } },
      running: [{ kind: 'session', id: 's_1', label: 'example-project · Claude', startedAt: '2026-10-15T08:46:00Z' }],
      lastFailure: { runId: 'r_1', title: 'Daily ads', endedAt: '2026-10-15T06:02:00Z' },
      recentRepos: [{ id: 'repo_1', name: 'example-project' }],
      now
    })
    const labels = items.map((i) => i.label ?? '---')
    expect(labels[0]).toBe('Open Hive')
    expect(labels).toContain('Running')
    expect(labels.some((l) => l.includes('example-project · Claude · 14m'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Last: ✕ Daily ads failed'))).toBe(true)
    expect(labels).toContain('Next: Daily ads in 41m')
    expect(labels).toContain('New Session')
    expect(labels).toContain('Pause All Schedules')
    expect(labels[labels.length - 1]).toBe('Quit Hive')
    expect(labels.join('|')).not.toMatch(/Run Workflow|Launch at Login/)
    const ns = items.find((i) => i.label === 'New Session')!
    expect(ns.submenu![0].action).toEqual({ kind: 'newSession', repoId: 'repo_1' })
  })
  it('no Last line when failures are seen', () => {
    const items = trayMenuModel({ status: base, running: [], lastFailure: null, recentRepos: [], now: new Date() })
    expect(items.some((i) => i.label?.startsWith('Last:'))).toBe(false)
    expect(items.some((i) => i.label === 'Nothing running')).toBe(true)
  })
  it('durations and next label', () => {
    expect(shortDuration(14 * 60_000)).toBe('14m')
    expect(shortDuration(125 * 60_000)).toBe('2h 5m')
    expect(shortDuration(3 * 86400_000)).toBe('3d')
    expect(nextFireLabel(null, true, new Date())).toBe('Schedules paused')
  })
})

// ---------- COMPANY.md C3: company filters, stamping, keys namespaces and the IPC contract ----------
let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const dbd = nativeOk ? describe : describe.skip
const P = PERSONAL_COMPANY_ID
const TS = '2026-10-20T10:00:00.000Z'
const fakeCipher = (): Cipher => ({
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

/** Two companies (Acme owns repoA; repoP is unowned, so Personal) over an in-memory hive.db. */
function world() {
  const db: DB = openDatabase(':memory:')
  const store = new Store(db)
  const company = new CompanyStore(store)
  const [repoA] = store.addRepo('/tmp/c3-acme-web')
  const [repoP] = store.addRepo('/tmp/c3-side')
  const [repoB] = store.addRepo('/tmp/c3-beta-api')
  const acme = company.create({ name: 'Acme', repoIds: [repoA.id] })
  const beta = company.create({ name: 'Beta', repoIds: [repoB.id] })
  return { db, store, company, host: { store, company }, repoA, repoP, repoB, acme, beta }
}
const session = (id: string, over: Partial<Session> = {}): Session & { logPath: string } => ({
  id, title: id, profileId: 'prof_x', adapter: 'claude', repoId: null, cwd: '/tmp', status: 'exited', pid: null, cols: 80, rows: 24,
  exitCode: 0, startedAt: TS, endedAt: TS, artifactsDir: `/tmp/a/${id}`, fromRunId: null, agentSessionId: null, logPath: `/tmp/l/${id}`, ...over
})
const insertRun = (db: DB, id: string, companyId: string | null) =>
  db.prepare(`INSERT INTO runs(id, kind, title, target_json, trigger, status, created_at, artifacts_dir, company_id)
    VALUES (?, 'prompt', ?, '{"kind":"prompt","profileId":"p","repoId":null,"prompt":"x"}', 'manual', 'passed', ?, '/tmp/r', ?)`).run(id, id, TS, companyId)
const agentNode = (id: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id, kind: 'session', parentId: null, rootId: id, sessionId: null, runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/tmp',
  title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact',
  status: 'working', needs: null, seen: false, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null,
  tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: TS, updatedAt: TS, endedAt: null, ...over
})
const askRow = (id: string, agentId: string): Ask => ({
  id, agentId, rootId: agentId, sessionId: null, runId: null, stepId: null, provider: 'claude', kind: 'permission', channel: 'stdio',
  title: 'Bash', detail: null, toolName: 'Bash', toolInput: null, question: null, options: [], status: 'open', answer: null,
  answeredVia: null, createdAt: TS, answeredAt: null, expiresAt: null
})
const draft = (cwd: string | null) => ({
  name: 'w', description: '', inputs: [],
  nodes: [{ id: 'a', type: 'agent' as const, label: 'a', after: [], cwd, timeoutMin: 5, profileId: 'prof_x', prompt: 'hi' }]
})

dbd('company list filters (COMPANY.md §3, §7)', () => {
  it('sessions: launcher id, else the repo company, else Personal; NULL rows read as Personal', () => {
    const w = world()
    w.store.insertSession(session('s_1', { companyId: w.beta.id }))
    w.store.insertSession(session('s_2', { repoId: w.repoA.id }))
    w.store.insertSession(session('s_3'))
    w.db.prepare('UPDATE sessions SET company_id = NULL WHERE id = ?').run('s_3')
    expect(w.store.listSessions().map((s) => s.id).sort()).toEqual(['s_1', 's_2', 's_3'])
    expect(w.store.getSession('s_1')!.companyId).toBe(w.beta.id)
    expect(w.store.getSession('s_2')!.companyId).toBe(w.acme.id)
    expect(w.store.getSession('s_3')!.companyId).toBe(P)
    expect(w.store.listSessions('all', undefined, w.acme.id).map((s) => s.id)).toEqual(['s_2'])
    expect(w.store.listSessions('all', undefined, P).map((s) => s.id)).toEqual(['s_3'])
  })
  it('runs, workflows, schedules and artifacts filter with COALESCE and stamp on create', () => {
    const w = world()
    insertRun(w.db, 'r_1', w.acme.id)
    insertRun(w.db, 'r_2', null)
    expect(w.store.listRuns().map((r) => r.id).sort()).toEqual(['r_1', 'r_2'])
    expect(w.store.listRuns({ companyId: w.acme.id }).map((r) => r.id)).toEqual(['r_1'])
    expect(w.store.listRuns({ companyId: P }).map((r) => r.id)).toEqual(['r_2'])
    expect(w.store.getRun('r_2')!.companyId).toBe(P)

    const seeded = w.store.createWorkflow(draft(null))
    const acmeWf = w.store.createWorkflow(draft(null), null, null, w.acme.id)
    expect(seeded.companyId).toBe(P) // first-run seeds and unscoped callers land in Personal
    expect(w.store.listWorkflows().length).toBe(2)
    expect(w.store.listWorkflows(w.acme.id).map((x) => x.id)).toEqual([acmeWf.id])
    w.store.setWorkflowCompany(seeded.id, w.beta.id)
    expect(w.store.listWorkflows(w.beta.id).map((x) => x.id)).toEqual([seeded.id])

    const when = { kind: 'cron' as const, cron: '0 9 * * *', tz: 'UTC' }
    const sch = w.store.insertSchedule({ name: 's', target: { kind: 'workflow', workflowId: acmeWf.id, inputs: {} }, when }, w.acme.id)
    const loose = w.store.insertSchedule({ name: 'p', target: { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, when })
    expect(w.store.listSchedules().length).toBe(2)
    expect(w.store.listSchedules(w.acme.id).map((x) => x.id)).toEqual([sch])
    expect(w.store.getSchedule(loose)!.companyId).toBe(P)

    // artifacts: from the run, else the session, else Personal
    w.store.insertSession(session('s_9', { companyId: w.beta.id }))
    const base = { relPath: 'x', name: 'x', kind: 'other' as const, mime: 'text/plain', bytes: 1, mtime: TS }
    const a1 = w.store.upsertArtifact({ ...base, path: '/tmp/a1', runId: 'r_1', sessionId: null }).artifact
    const a2 = w.store.upsertArtifact({ ...base, path: '/tmp/a2', runId: null, sessionId: 's_9' }).artifact
    const a3 = w.store.upsertArtifact({ ...base, path: '/tmp/a3', runId: 'r_2', sessionId: null }).artifact
    expect([a1.companyId, a2.companyId, a3.companyId]).toEqual([w.acme.id, w.beta.id, P])
    expect(w.store.listArtifacts().length).toBe(3)
    expect(w.store.listArtifacts({ companyId: w.beta.id }).map((a) => a.id)).toEqual([a2.id])
  })
  it('live agents and asks: subagents inherit the root, roots take the session, asks the agent', () => {
    const w = world()
    const live = new LiveStore(w.db)
    w.store.insertSession(session('s_1', { companyId: w.acme.id }))
    live.insertAgent(agentNode('ag_root', { sessionId: 's_1' }))
    live.insertAgent(agentNode('ag_sub', { kind: 'subagent', parentId: 'ag_root', rootId: 'ag_root', depth: 1 }))
    live.insertAgent(agentNode('ag_lone'))
    live.insertAgent(agentNode('ag_beta', { companyId: w.beta.id } as Partial<AgentNode>))
    live.insertAsk(askRow('ask_1', 'ag_sub'))
    expect(live.getAgent('ag_sub')!.companyId).toBe(w.acme.id)
    expect(live.getAgent('ag_lone')!.companyId).toBe(P)
    expect(live.getAgent('ag_beta')!.companyId).toBe(w.beta.id)
    expect(live.listAgents({}).length).toBe(4)
    expect(live.listAgents({ companyId: w.acme.id }).map((a) => a.id).sort()).toEqual(['ag_root', 'ag_sub'])
    expect(live.getAsk('ask_1')!.companyId).toBe(w.acme.id)
    expect(live.listAsks({ companyId: w.acme.id }).map((a) => a.id)).toEqual(['ask_1'])
    expect(live.listAsks({ companyId: w.beta.id })).toEqual([])
    expect(live.listAsks().map((a) => a.id)).toEqual(['ask_1'])
  })
  it('repos carry their company and order per company (repo_order:<companyId>), legacy order unchanged', () => {
    const w = world()
    const [repoQ] = w.store.addRepo('/tmp/c3-another')
    w.store.setMeta('repo_order', JSON.stringify([repoQ.id, w.repoB.id, w.repoP.id, w.repoA.id]))
    expect(w.store.listRepos().map((r) => r.id)).toEqual([repoQ.id, w.repoB.id, w.repoP.id, w.repoA.id])
    expect(w.store.listRepos().find((r) => r.id === w.repoA.id)!.companyId).toBe(w.acme.id)
    expect(w.store.listRepos(undefined, P).map((r) => r.id)).toEqual([repoQ.id, w.repoP.id])
    expect(w.store.listRepos(undefined, w.acme.id).map((r) => r.id)).toEqual([w.repoA.id])

    w.store.moveRepo(w.repoP.id, repoQ.id, 'before')
    expect(JSON.parse(w.store.getMeta(`repo_order:${P}`)!)).toEqual([w.repoP.id, repoQ.id])
    expect(w.store.listRepos(undefined, P).map((r) => r.id)).toEqual([w.repoP.id, repoQ.id])
    // the legacy key gets the same move (older builds and the unfiltered list follow)
    expect(w.store.listRepos().map((r) => r.id)).toEqual([w.repoP.id, repoQ.id, w.repoB.id, w.repoA.id])
    expect(() => w.store.moveRepo(w.repoA.id, repoQ.id, 'after')).toThrow(/another company/)
  })
})

dbd('company stamping guards (COMPANY.md §6, experimental.companies)', () => {
  it('schedules stamp from their workflow; a cross-company schedule warns with the flag off and throws with it on', () => {
    const w = world()
    const wf = w.store.createWorkflow(draft(null), null, null, w.acme.id)
    const input = { name: 's', target: { kind: 'workflow' as const, workflowId: wf.id, inputs: {} }, when: { kind: 'cron' as const, cron: '0 9 * * *', tz: 'UTC' } }
    expect(scheduleCompany(w.host, input)).toBe(w.acme.id)
    expect(scheduleCompany(w.host, input, P)).toBe(w.acme.id) // warned, stamped from the target
    const prompt = { ...input, target: { kind: 'prompt' as const, profileId: 'p', repoId: w.repoB.id, prompt: 'x' } }
    expect(scheduleCompany(w.host, prompt)).toBe(w.beta.id)
    expect(scheduleCompany(w.host, { ...prompt, target: { ...prompt.target, repoId: null } }, w.acme.id)).toBe(w.acme.id)
    w.store.updateSettings({ experimental: { companies: true } })
    expect(w.store.getSettings().experimental).toEqual({ companies: true, vault: false, vaultAI: false })
    expect(() => scheduleCompany(w.host, input, P)).toThrow(/belongs to Acme/)
  })
  it('workflow repo targets must belong to the workflow company', () => {
    const w = world()
    expect(guardWorkflowTargets(w.host, w.acme.id, draft(w.repoA.id))).toBeNull()
    expect(guardWorkflowTargets(w.host, w.acme.id, draft('{{inputs.repo}}'))).toBeNull()
    expect(guardWorkflowTargets(w.host, P, draft(w.repoA.id))).toMatch(/belongs to Acme/)
    w.store.updateSettings({ experimental: { companies: true } })
    expect(() => guardWorkflowTargets(w.host, P, draft(w.repoA.id))).toThrow(/belongs to Acme/)
    expect(() => requireCompany(w.host, 'co_nope')).toThrow(/Company not found/)
    expect(requireCompany(w.host, undefined)).toBe(P)
  })
  it('settings: activeCompanyId and expandedCompanies persist; experimental patches merge flag by flag', () => {
    const w = world()
    expect(w.store.getSettings()).toMatchObject({ activeCompanyId: 'all', expandedCompanies: {}, experimental: { companies: false, vault: false, vaultAI: false } })
    w.store.updateSettings({ activeCompanyId: w.acme.id, expandedCompanies: { [w.beta.id]: false }, experimental: { vault: true } })
    w.store.updateSettings({ experimental: { vaultAI: true } })
    expect(w.store.getSettings()).toMatchObject({ activeCompanyId: w.acme.id, expandedCompanies: { [w.beta.id]: false }, experimental: { companies: false, vault: true, vaultAI: true } })
    expect(w.store.companyGuardsEnforced()).toBe(false)
  })
  it('settings: autopilots default to {} and persist per company', () => {
    const w = world()
    expect(w.store.getSettings().autopilots).toEqual({})
    const rec = { enabledAt: '2026-10-24T09:00:00Z', paused: true, steps: { triage: { scheduleId: 'sch_1' } }, publish: [] }
    w.store.updateSettings({ autopilots: { [w.acme.id]: { company: rec } } })
    expect(w.store.getSettings().autopilots).toEqual({ [w.acme.id]: { company: rec } })
    // reads never share the stored object
    w.store.getSettings().autopilots![w.acme.id] = {}
    expect(w.store.getSettings().autopilots![w.acme.id]).toEqual({ company: rec })
  })
  it('settings reads never share the default expandedCompanies object', () => {
    const w = world()
    const first = w.store.getSettings()
    first.expandedCompanies![w.acme.id] = false
    expect(w.store.getSettings().expandedCompanies).toEqual({})
  })
})

dbd('keys: Shared and company namespaces (COMPANY.md §4)', () => {
  const setup = () => {
    const w = world()
    const vault = new Vault(w.db, fakeCipher())
    return { ...w, vault, keys: new KeyNamespaces(vault, new CompanySecrets(w.db, fakeCipher())) }
  }
  it('lists all (absent), Shared (null) or company + Shared (id); a company key may shadow a shared name', () => {
    const { keys, acme, beta } = setup()
    keys.set(null, 'OPENAI_API_KEY', 'sk-shared-0001')
    keys.set(acme.id, 'OPENAI_API_KEY', 'sk-acme-0002', 'Acme OpenAI')
    keys.set(beta.id, 'STRIPE_KEY', 'sk-beta-0003')
    const tag = (l: { name: string; companyId?: string | null }[]) => l.map((m) => `${m.companyId ?? 'shared'}:${m.name}`)
    expect(tag(keys.list())).toEqual(['shared:OPENAI_API_KEY', `${acme.id}:OPENAI_API_KEY`, `${beta.id}:STRIPE_KEY`])
    expect(tag(keys.list(null))).toEqual(['shared:OPENAI_API_KEY'])
    expect(tag(keys.list(acme.id))).toEqual([`${acme.id}:OPENAI_API_KEY`, 'shared:OPENAI_API_KEY'])
    expect(keys.reveal(acme.id, 'OPENAI_API_KEY')).toBe('sk-acme-0002')
    expect(keys.reveal(undefined, 'OPENAI_API_KEY')).toBe('sk-shared-0001')
    expect(() => keys.reveal(acme.id, 'STRIPE_KEY')).toThrow(/No key named STRIPE_KEY/)
    expect(() => keys.set('co_missing', 'X_KEY', 'value')).toThrow(/Company not found/)
    expect(keys.parseEnv(beta.id, 'STRIPE_KEY=a\nNEW_KEY=b').map((e) => e.exists)).toEqual([true, false])
  })
  it('redaction covers every company key in every output; removing a key stops masking it', () => {
    const { keys, vault, acme } = setup()
    keys.set(acme.id, 'ACME_TOKEN', 'tok-acme-secret')
    expect(vault.redact('x tok-acme-secret y')).not.toContain('tok-acme-secret')
    keys.remove(acme.id, 'ACME_TOKEN')
    expect(vault.redact('x tok-acme-secret y')).toContain('tok-acme-secret')
  })
  it('notifies on boot and on every company-key change (memory fingerprints), masking the trimmed value too', () => {
    const w = world()
    const vault = new Vault(w.db, fakeCipher())
    const company = new CompanySecrets(w.db, fakeCipher())
    company.set(w.acme.id, 'ACME_PEM', '\n-----BEGIN KEY-----abc\n')
    let calls = 0
    const keys = new KeyNamespaces(vault, company, () => calls++)
    expect(calls).toBe(1) // boot: values registered before the first fingerprint refresh
    // vault.ts reads company keys itself: masked under their own name (no NAME@companyId workaround)
    expect(vault.secretValues().map((v) => v.name)).toContain('ACME_PEM')
    expect(vault.redact('x -----BEGIN KEY-----abc')).toBe('x ••••ACME_PEM')
    expect(vault.redact('out: -----BEGIN KEY-----abc done')).not.toContain('BEGIN KEY')
    keys.set(w.beta.id, 'BETA_TOKEN', 'tok-beta-secret')
    keys.remove(w.beta.id, 'BETA_TOKEN')
    expect(calls).toBe(3)
    keys.set(null, 'SHARED_ONE', 'shared-value-1') // Shared changes notify through vault's own listener
    expect(calls).toBe(3)
  })
  it('moves keys between namespaces without plaintext leaving main, refusing a name clash', () => {
    const { keys, acme, beta } = setup()
    keys.set(null, 'GEMINI_API_KEY', 'g-shared-1234', 'Gemini')
    const moved = keys.move('GEMINI_API_KEY', null, acme.id)
    expect(moved).toMatchObject({ name: 'GEMINI_API_KEY', companyId: acme.id, label: 'Gemini' })
    expect(keys.list(null)).toEqual([])
    keys.set(beta.id, 'GEMINI_API_KEY', 'g-beta-9999')
    expect(() => keys.move('GEMINI_API_KEY', acme.id, beta.id)).toThrow(/already has a key/)
    expect(keys.move('GEMINI_API_KEY', acme.id, null).companyId).toBeNull()
    expect(keys.reveal(null, 'GEMINI_API_KEY')).toBe('g-shared-1234')
  })
})

describe('IPC schemas for the company and Passport channels (COMPANY.md §7, PASSPORT.md §11)', () => {
  const ok = (channel: keyof typeof REQUEST_SCHEMAS, req: unknown) => REQUEST_SCHEMAS[channel].safeParse(req).success
  it('list channels take an optional companyId and keep working without it', () => {
    for (const c of ['repos:list', 'workflows:list', 'schedules:list', 'runs:list', 'artifacts:list', 'agents:list', 'asks:list', 'sessions:list', 'slackTriggers:list'] as const) {
      expect(ok(c, undefined)).toBe(true)
      expect(ok(c, { companyId: 'co_abc123' })).toBe(true)
      expect(ok(c, { companyId: 'not an id' })).toBe(false)
    }
    expect(REQUEST_SCHEMAS['workflows:create'].parse({ ...draft(null), companyId: 'co_abc' })).toMatchObject({ companyId: 'co_abc' })
  })
  it('secrets: null is Shared, absent is Shared, an id is a company', () => {
    expect(ok('secrets:set', { name: 'A_KEY', value: 'v', companyId: null })).toBe(true)
    expect(ok('secrets:set', { name: 'A_KEY', value: 'v' })).toBe(true)
    expect(ok('secrets:list', { companyId: null })).toBe(true)
    expect(ok('secrets:move', { name: 'A_KEY', from: null, to: 'co_abc' })).toBe(true)
    expect(ok('secrets:move', { name: 'A_KEY', from: null, to: null })).toBe(false)
  })
  it('company channels', () => {
    expect(ok('company:create', { name: 'Acme', color: '#ff0000' })).toBe(true)
    expect(ok('company:create', { name: '' })).toBe(false)
    expect(ok('company:update', { id: 'co_abc', patch: { sortOrder: 2 } })).toBe(true)
    expect(ok('company:update', { id: 'co_abc', patch: { slug: 'x' } })).toBe(false) // the slug never changes
    expect(ok('company:archive', { id: 'co_abc', archived: false })).toBe(true)
    expect(ok('company:reorder', { ids: ['co_a', 'co_b'] })).toBe(true)
    expect(ok('company:assignRepo', { repoId: 'repo_x', companyId: 'co_a' })).toBe(true)
    expect(ok('company:overview', undefined)).toBe(true)
    expect(ok('company:list', { includeArchived: true })).toBe(true)
  })
  it('settings: activeCompanyId, expandedCompanies and partial experimental flags', () => {
    expect(ok('settings:update', { activeCompanyId: 'all' })).toBe(true)
    expect(ok('settings:update', { activeCompanyId: 'co_abc' })).toBe(true)
    expect(ok('settings:update', { activeCompanyId: 'everything' })).toBe(false)
    expect(ok('settings:update', { expandedCompanies: { co_abc: true } })).toBe(true)
    expect(ok('settings:update', { experimental: { vault: true } })).toBe(true)
    expect(ok('settings:update', { experimental: { warp: true } })).toBe(false)
  })
  it('settings: autopilots bookkeeping (AUTOPILOT.md §4)', () => {
    const rec = { enabledAt: '2026-10-24T09:00:00Z', paused: false, steps: { seo_report: { scheduleId: 'sch_abc123' }, competitors: { scheduleId: 'sch_def456', workflowId: 'wf_x1' } }, publish: ['linkedin'] }
    expect(ok('settings:update', { autopilots: { co_abc: { marketing: rec } } })).toBe(true)
    expect(ok('settings:update', { autopilots: {} })).toBe(true)
    expect(ok('settings:update', { autopilots: { co_abc: { sales: rec } } })).toBe(false) // unknown autopilot
    expect(ok('settings:update', { autopilots: { co_abc: { marketing: { ...rec, publish: ['myspace'] } } } })).toBe(false)
    expect(ok('settings:update', { autopilots: { co_abc: { marketing: { ...rec, steps: { seo_report: { scheduleId: '../x' } } } } } })).toBe(false)
    expect(ok('settings:update', { autopilots: { co_abc: { marketing: { ...rec, token: 'x' } } } })).toBe(false) // strict
  })
  it('memory:note: vault-relative paths only, note ids, op-specific fields', () => {
    expect(ok('memory:note', { op: 'get', companyId: 'co_a', path: 'People/Ana Ruiz.md' })).toBe(true)
    expect(ok('memory:note', { op: 'get', companyId: 'co_a', id: 'n-7k2a9q1c0b' })).toBe(true)
    expect(ok('memory:note', { op: 'get', companyId: 'co_a', id: 'h:People/Ana.md' })).toBe(true)
    expect(ok('memory:note', { op: 'get', companyId: 'co_a', path: '../secrets.md' })).toBe(false)
    expect(ok('memory:note', { op: 'get', companyId: 'co_a', path: '/etc/passwd.md' })).toBe(false)
    expect(ok('memory:note', { op: 'get', path: 'A.md' })).toBe(false) // every op names its company
    expect(ok('memory:note', { op: 'save', companyId: 'co_a', path: 'A.md', baseHash: 'a'.repeat(40), text: '# A\n' })).toBe(true)
    expect(ok('memory:note', { op: 'save', companyId: 'co_a', path: 'A.md', baseHash: 'nope', text: '' })).toBe(false)
    expect(ok('memory:note', { op: 'ops', companyId: 'co_a', ops: [{ op: 'observe', note: '[[Ana Ruiz]]', category: 'role', text: 'Head of growth' }, { op: 'invalidate', blockId: 'f-9q1c3m8d2e', reason: 'left' }] })).toBe(true)
    expect(ok('memory:note', { op: 'ops', companyId: 'co_a', ops: [{ op: 'delete', note: 'X' }] })).toBe(false) // never delete
    expect(ok('memory:note', { op: 'archive', companyId: 'co_a', path: 'A.md', archived: false })).toBe(true)
  })
  it('memory:graph keeps the v1 query and adds global / local / layout', () => {
    expect(ok('memory:graph', { scope: 'all', statuses: ['pending'] })).toBe(true)
    expect(ok('memory:graph', { op: 'global', companyId: 'co_a', filters: { existingOnly: true } })).toBe(true)
    expect(ok('memory:graph', { op: 'local', companyId: 'co_a', noteId: 'n-7k2a9q1c0b', depth: 2 })).toBe(true)
    expect(ok('memory:graph', { op: 'local', companyId: 'co_a', noteId: 'n-7k2a9q1c0b', depth: 4 })).toBe(false)
    expect(ok('memory:graph', { op: 'layout', companyId: 'co_a', positions: [{ noteId: 'n-7k2a9q1c0b', x: 1, y: 2 }] })).toBe(true)
  })
  it('memory:links, memory:proposals and memory:vault', () => {
    expect(ok('memory:links', { op: 'backlinks', companyId: 'co_a', noteId: 'n-7k2a9q1c0b' })).toBe(true)
    expect(ok('memory:links', { op: 'tree', companyId: 'co_a' })).toBe(true)
    expect(ok('memory:proposals', { op: 'accept', companyId: 'co_a', ids: ['sg-1a2b3c'] })).toBe(true)
    expect(ok('memory:proposals', { op: 'accept', companyId: 'co_a', ids: [] })).toBe(false)
    expect(ok('memory:proposals', { op: 'list', companyId: 'co_a', kinds: ['link', 'fact_supersede'] })).toBe(true)
    expect(ok('memory:vault', { op: 'migrate', dryRun: true })).toBe(true)
    expect(ok('memory:vault', { op: 'setPath', companyId: 'co_a', path: null })).toBe(true)
    expect(ok('memory:vault', { op: 'setPath', companyId: 'co_a', pick: true })).toBe(true)
    expect(ok('memory:vault', { op: 'setPath', companyId: 'co_a', path: 'relative/dir' })).toBe(false)
    expect(ok('memory:vault', { op: 'status' })).toBe(false)
  })
  it('the renderer API types each op channel by its op (compile-time)', () => {
    const typed = async (m: HiveApi['memory']) => {
      const status: VaultStatus = await m.vault({ op: 'status', companyId: 'co_a' })
      const note: VaultNoteText = await m.note({ op: 'get', companyId: 'co_a', path: 'A.md' })
      const v1: MemoryGraph = await m.graph({ scope: 'all' })
      const global: VaultGraph = await m.graph({ op: 'global', companyId: 'co_a' })
      return [status, note, v1, global]
    }
    expect(typeof typed).toBe('function')
  })
})
