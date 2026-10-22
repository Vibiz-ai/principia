/**
 * COMPANY.md §10, §11 C7 step 1: the isolation matrix. One two-company install over the real modules (hive.db,
 * CompanyStore and scope.ts through companyBridge.ts, vault + company_secrets, the engine with its db-backed store and
 * scheduler, SessionManager, the MCP gateway, the Slack service and the authoring wiring), and for each spawn path
 * (session, run, schedule, Slack trigger, gateway, keys, authoring tools): company A's spawn can neither see nor affect
 * company B, and shared keys are inherited. Agents are fake `node` children (engine/__tests__/fakes.ts), so the real
 * runner, env and redaction paths run. Guards are enforced (`experimental.companies`) unless a row says otherwise.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the handlers and the authoring wiring import IPC, dialogs and notifications: no Electron in unit tests
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: { isSupported: () => false }
}))
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { CompanySecrets } from '../db/companySecrets'
import { ensureDefaultProfile } from '../db/seed'
import { CompanyStore } from '../company'
import { createCompanyBridge } from '../companyBridge'
import { Vault, type Cipher } from '../vault'
import { SessionManager, type PtyLike } from '../sessions'
import { GatewayService } from '../gateway/service'
import { wireAuthoring } from '../author/wire'
import { scheduleCompany } from '../handlers/schedules'
import { guardWorkflowTargets } from '../handlers/companyScope'
import { SlackService } from '../connectors/slack/service'
import { normalizeTrigger } from '../connectors/slack/triggerConfig'
import { makeHarness, type Harness } from '../connectors/slack/__tests__/harness'
import { createEngineWith } from '../engine'
import { describeWhen } from '../engine/scheduler'
import { fakeAdapter, fakeProviders, type FakeCall } from '../engine/__tests__/fakes'
import type { Hive } from '../hive'
import type { Engine, InteractiveSpawnOptions } from '../../shared/engine'
import type { AgentProfile, Run, Workflow, WorkflowDraft } from '../../shared/types'
import type { SlackInboundMessage, SlackTriggerInput } from '../../shared/slack'
import { PERSONAL_COMPANY_ID as P } from '../../shared/company'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk && !process.versions.electron ? describe : describe.skip

const fakeCipher = (): Cipher => ({
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

class FakePty implements PtyLike {
  static last: FakePty
  pid = 4242
  constructor(
    public file: string,
    public args: string[],
    public opts: { cwd: string; env: Record<string, string> }
  ) {
    FakePty.last = this
  }
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

/** Every key a fake agent prints back (`NAME=value` or `NAME=<unset>`). */
const ECHO = ['SHARED_KEY', 'OVERRIDE_KEY', 'ACME_TOKEN', 'BETA_TOKEN', 'HIVE_REPOS']

interface World {
  tmp: string
  db: DB
  store: Store
  company: CompanyStore
  vault: Vault
  engine: Engine
  gateway: GatewayService
  sessions: SessionManager
  spawns: InteractiveSpawnOptions[]
  calls: FakeCall[]
  resolved: { companyId: string | null; env: Record<string, string> }[]
  warnings: string[]
  profile: AgentProfile
  repoA: { id: string; path: string }
  repoB: { id: string; path: string }
  repoP: { id: string; path: string }
  acme: { id: string; slug: string }
  beta: { id: string; slug: string }
  wfA: Workflow
  wfB: Workflow
}
let w: World

const enforce = (on: boolean) => w.store.updateSettings({ experimental: { companies: on } })
const agentNode = (cwd: string | null, id = 'a', profileId = w.profile.id): WorkflowDraft['nodes'][number] => ({ id, type: 'agent', label: id, after: [], cwd, timeoutMin: 1, profileId, prompt: 'Do the work', memory: 'off' })
const draft = (name: string, nodes: WorkflowDraft['nodes']): WorkflowDraft => ({ name, description: '', inputs: [], nodes })

async function waitRun(id: string, timeoutMs = 15000): Promise<Run> {
  const t0 = Date.now()
  for (;;) {
    const r = w.store.getRun(id)!
    if (r.status !== 'queued' && r.status !== 'running') return r
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${id} still ${r.status}`)
    await new Promise((res) => setTimeout(res, 20))
  }
}
/** `NAME=value` lines a fake agent printed. */
function echoed(run: Run): Record<string, string> {
  const out = w.store.getRunDetail(run.id)!.steps.map((s) => s.output ?? '').join('\n')
  return Object.fromEntries(out.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}
/** Everything company B owns, for "A's attempt changed nothing of B". */
const betaState = () =>
  JSON.stringify({
    runs: w.store.listRuns({ companyId: w.beta.id, limit: 1000 }).map((r) => [r.id, r.status]),
    workflows: w.store.listWorkflows(w.beta.id),
    schedules: w.store.listSchedules(w.beta.id).map((s) => [s.id, s.lastRunId, s.nextFireAt]),
    sessions: w.store.listSessions('all', undefined, w.beta.id).map((s) => s.id),
    keys: new CompanySecrets(w.db, fakeCipher()).list(w.beta.id)
  })

async function makeWorld(): Promise<World> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-c7-')))
  const db = openDatabase(':memory:')
  const store = new Store(db)
  store.setDescribe(describeWhen)
  const company = new CompanyStore(store, { companiesRoot: path.join(tmp, 'companies') })
  const vault = new Vault(db, fakeCipher())
  const secrets = new CompanySecrets(db, fakeCipher())
  const repo = (name: string) => {
    const p = path.join(tmp, name)
    fs.mkdirSync(p, { recursive: true })
    return store.addRepo(p)[0]
  }
  const repoA = repo('acme-web')
  const repoB = repo('beta-api')
  const repoP = repo('side-project')
  const acme = company.create({ name: 'Acme', repoIds: [repoA.id], mission: 'Acme sells anvils' })
  const beta = company.create({ name: 'Beta', repoIds: [repoB.id], mission: 'Beta brews tea' })
  vault.set('SHARED_KEY', 'shared-value-0001')
  vault.set('OVERRIDE_KEY', 'shared-override-01')
  secrets.set(acme.id, 'ACME_TOKEN', 'tok-acme-secret')
  secrets.set(acme.id, 'OVERRIDE_KEY', 'acme-override-0002')
  secrets.set(beta.id, 'BETA_TOKEN', 'tok-beta-secret')
  vault.refreshRedactions()
  const profile = ensureDefaultProfile(store, 'claude')
  const warnings: string[] = []
  const log = { info() {}, warn: (m: string) => void warnings.push(m), error() {} }
  const bridge = createCompanyBridge(company, store)
  const paths = { userData: tmp, artifactsRoot: path.join(tmp, 'artifacts'), runLogsDir: path.join(tmp, 'logs', 'runs'), sessionLogsDir: path.join(tmp, 'logs', 'sessions'), scratchDir: path.join(tmp, 'scratch') }
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true })
  const gateway = new GatewayService({
    userData: tmp,
    mainDir: tmp,
    cipher: fakeCipher(),
    vault: { addRedactions() {} },
    baseEnv: () => ({}),
    companies: { forCwd: (cwd) => company.companyForCwd(cwd).id, enforced: () => store.companyGuardsEnforced(), warn: (m) => void warnings.push(m) }
  })
  const calls: FakeCall[] = []
  // every env a spawn resolved (outputs only ever show masked values, so the override is checked here)
  const resolved: { companyId: string | null; env: Record<string, string> }[] = []
  const secretsPort = { resolve: (n: string[], c?: string | null) => { const env = vault.resolve(n, c); resolved.push({ companyId: c ?? null, env }); return env }, redact: (t: string) => vault.redact(t), names: (n: string[], c?: string | null) => vault.names(n, c) }
  const engine = createEngineWith(
    {
      paths: { userData: paths.userData, artifactsRoot: paths.artifactsRoot, runLogsDir: paths.runLogsDir, scratchDir: paths.scratchDir },
      store: createEngineStore(db, { describe: () => describeWhen }),
      baseEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(tmp, 'home'), SHELL: '/bin/sh' }),
      secrets: secretsPort,
      getSettings: () => store.getSettings(),
      getProfile: (id) => store.getProfile(id),
      getRepo: (id) => store.getRepo(id),
      listRepos: () => store.listRepos(),
      getWorkflow: (id) => store.getWorkflow(id),
      passportContext: (cwd, companyId) => (companyId ? company.passportContextFor(companyId) : company.contextForDirectory(cwd)),
      company: bridge,
      gateway,
      emit: () => {},
      log
    },
    { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'done', echoEnv: ECHO })) }, detect: fakeProviders(['claude', 'shell']) }
  )
  await engine.init()
  const spawns: InteractiveSpawnOptions[] = []
  const sessions = new SessionManager({
    store,
    paths,
    spawnPty: (file, args, opts) => new FakePty(file, args, opts),
    interactiveSpawn: (p, opts) => (spawns.push(opts), engine.providers.interactiveSpawn(p, opts)),
    baseEnv: () => ({ PATH: '/usr/bin', HOME: path.join(tmp, 'home') }),
    secrets: secretsPort,
    company: bridge,
    emitData: () => {},
    emitExit: () => {},
    emitUpdated: () => {},
    trustFolder: () => {}
  })
  const wfA = store.createWorkflow(draft('Acme flow', [agentNode(repoA.id, 'a', profile.id)]), null, null, acme.id)
  const wfB = store.createWorkflow(draft('Beta flow', [agentNode(repoB.id, 'a', profile.id)]), null, null, beta.id)
  return { tmp, db, store, company, vault, engine, gateway, sessions, spawns, calls, resolved, warnings, profile, repoA, repoB, repoP, acme, beta, wfA, wfB }
}

beforeEach(async () => {
  if (!nativeOk || process.versions.electron) return
  w = await makeWorld()
  enforce(true)
})
afterEach(async () => {
  if (!w) return
  await w.engine.shutdown()
  w.gateway.close()
  w.db.close()
  fs.rmSync(w.tmp, { recursive: true, force: true })
  w = undefined as unknown as World
})

// ---------- keys (§4) ----------

d('matrix: keys', () => {
  it.each([
    ['Acme', () => w.acme.id, { SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'acme-override-0002', ACME_TOKEN: 'tok-acme-secret' }],
    ['Beta', () => w.beta.id, { SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'shared-override-01', BETA_TOKEN: 'tok-beta-secret' }],
    ['Personal', () => P, { SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'shared-override-01' }]
  ])("%s: '*' is the shared keys plus its own (a company value overrides a shared one), never another company's", (_, companyId, expected) => {
    expect(w.vault.resolve(['*'], companyId())).toEqual(expected)
    // naming another company's key does not reach it either
    expect(w.vault.resolve(['ACME_TOKEN', 'BETA_TOKEN'], companyId())).toEqual(Object.fromEntries(Object.entries(expected).filter(([k]) => k.endsWith('_TOKEN'))))
  })

  it("redaction stays global: A's output never shows B's values, nor its own", () => {
    expect(w.vault.redact('tok-beta-secret tok-acme-secret acme-override-0002 shared-value-0001')).toBe('••••BETA_TOKEN ••••ACME_TOKEN ••••OVERRIDE_KEY ••••SHARED_KEY')
  })
})

// ---------- interactive sessions (§6) ----------

d('matrix: sessions', () => {
  it("an Acme chat gets Acme's workspace, keys and Passport and nothing of Beta; Beta's folders are refused", () => {
    const before = betaState()
    const s = w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    expect(s).toMatchObject({ companyId: w.acme.id, cwd: path.join(w.tmp, 'companies', w.acme.slug, 'workspace'), repoId: null })
    const env = FakePty.last.opts.env
    expect(env).toMatchObject({ SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'acme-override-0002', ACME_TOKEN: 'tok-acme-secret' })
    expect(env.BETA_TOKEN).toBeUndefined()
    // the real engine spawn: Acme's Passport is injected, Beta's never
    const args = FakePty.last.args.join(' ')
    expect(args).toContain('Company Passport: Acme')
    expect(args).toContain('Acme sells anvils')
    expect(args).not.toContain('Beta')
    expect(w.spawns[0]).toMatchObject({ companyId: w.acme.id })
    expect(w.spawns[0].keyNames).not.toContain('BETA_TOKEN')

    expect(() => w.sessions.create({ adapter: 'claude', companyId: w.acme.id, repoId: w.repoB.id, cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    expect(() => w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cwd: w.repoB.path, cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    expect(() => w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cwd: w.company.workspaceDir(w.beta.id), cols: 80, rows: 24 })).toThrow(/belongs to Beta/)
    expect(w.spawns).toHaveLength(1)
    expect(betaState()).toBe(before)
  })

  it("a Personal session (unowned repo) inherits the shared keys only and gets no company's Passport", () => {
    const s = w.sessions.create({ adapter: 'claude', repoId: w.repoP.id, cols: 80, rows: 24 })
    expect(s.companyId).toBe(P)
    expect(FakePty.last.opts.env).toMatchObject({ SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'shared-override-01' })
    expect(FakePty.last.opts.env.ACME_TOKEN).toBeUndefined()
    expect(FakePty.last.opts.env.BETA_TOKEN).toBeUndefined()
    expect(FakePty.last.args.join(' ')).not.toContain('Company Passport')
  })
})

// ---------- runs (§3, §6) ----------

d('matrix: runs', () => {
  it("an Acme run is stamped Acme and sees Acme's keys, repos and Passport only", async () => {
    const run = w.engine.runs.start({ kind: 'workflow', workflowId: w.wfA.id, inputs: {} }, { trigger: 'manual' })
    expect(run.companyId).toBe(w.acme.id)
    const done = await waitRun(run.id)
    expect(done.status).toBe('passed')
    // present (masked in the output, redaction is global) or unset
    expect(echoed(done)).toEqual({ SHARED_KEY: '••••SHARED_KEY', OVERRIDE_KEY: '••••OVERRIDE_KEY', ACME_TOKEN: '••••ACME_TOKEN', BETA_TOKEN: '<unset>', HIVE_REPOS: w.repoA.path })
    expect(w.resolved.map((r) => r.companyId)).toEqual([w.acme.id])
    expect(w.resolved[0].env).toEqual({ SHARED_KEY: 'shared-value-0001', OVERRIDE_KEY: 'acme-override-0002', ACME_TOKEN: 'tok-acme-secret' })
    expect(w.calls[0].prompt).toContain('Company Passport: Acme')
    expect(w.calls[0].prompt).not.toContain('Beta')
    expect(w.calls[0].keyNames).not.toContain('BETA_TOKEN')
    expect(w.store.listRuns({ companyId: w.acme.id }).map((r) => r.id)).toEqual([run.id])
    expect(w.store.listRuns({ companyId: w.beta.id })).toEqual([])
  })

  it("Acme cannot start Beta's workflow, a prompt in Beta's repo, or a step in Beta's folder", async () => {
    const before = betaState()
    expect(() => w.engine.runs.start({ kind: 'workflow', workflowId: w.wfB.id, inputs: {} }, { trigger: 'agent', companyId: w.acme.id })).toThrow(/belongs to Beta/)
    expect(() => w.engine.runs.start({ kind: 'prompt', profileId: w.profile.id, repoId: w.repoB.id, prompt: 'x' }, { trigger: 'manual', companyId: w.acme.id })).toThrow(/belongs to Beta/)
    // a folder only known at run time (input template, through a symlink) fails the step before anything spawns there
    const link = path.join(w.tmp, 'innocent-link')
    fs.symlinkSync(w.repoB.path, link)
    const wf = w.store.createWorkflow({ ...draft('Acme sneaky', [{ ...agentNode('{{inputs.dir}}') }]), inputs: [{ name: 'dir', label: 'Dir' }] }, null, null, w.acme.id)
    const done = await waitRun(w.engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { dir: link } }, { trigger: 'manual' }).id)
    expect(done).toMatchObject({ status: 'failed', companyId: w.acme.id })
    expect(done.reason ?? '').toMatch(/belongs to Beta/)
    expect(w.calls).toHaveLength(0)
    // saving an Acme workflow that targets Beta's repo is refused too (workflows:save guard)
    expect(() => guardWorkflowTargets(w as unknown as Hive, w.acme.id, draft('x', [agentNode(w.repoB.id)]))).toThrow(/belongs to Beta/)
    expect(betaState()).toBe(before)
  })

  it("a step can't reach Beta's code through a kept Beta worktree or a case-variant path", async () => {
    // a kept worktree of a Beta run: a checkout of Beta's repo outside the repo folder
    const wt = path.join(w.tmp, 'worktrees', 'run_beta-x')
    fs.mkdirSync(wt, { recursive: true })
    w.db.prepare(`INSERT INTO worktrees(id,run_id,repo_id,repo_path,path,branch,base,status,created_at) VALUES('wt_b','run_beta',?,?,?,'b','main','kept',?)`).run(w.repoB.id, w.repoB.path, wt, new Date().toISOString())
    const wf = w.store.createWorkflow({ ...draft('Acme sneaky', [{ ...agentNode('{{inputs.dir}}') }]), inputs: [{ name: 'dir', label: 'Dir' }] }, null, null, w.acme.id)
    const dirs = [wt]
    // on a case-insensitive disk (macOS default) the same folder under another spelling
    const variant = w.repoB.path.toUpperCase()
    if (variant !== w.repoB.path && fs.existsSync(variant)) dirs.push(variant)
    for (const dir of dirs) {
      const done = await waitRun(w.engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { dir } }, { trigger: 'manual' }).id)
      expect(done, dir).toMatchObject({ status: 'failed', companyId: w.acme.id })
      expect(done.reason ?? '').toMatch(/belongs to Beta/)
    }
    expect(w.calls).toHaveLength(0)
  })

  it('off: guards warn and still stamp, but keys never cross companies', async () => {
    enforce(false)
    const run = w.engine.runs.start({ kind: 'prompt', profileId: w.profile.id, repoId: w.repoB.id, prompt: 'x', memory: 'off' }, { trigger: 'manual', companyId: w.acme.id })
    expect(run.companyId).toBe(w.beta.id) // the repo wins over a conflicting explicit id
    expect(w.warnings.some((m) => /company guard/.test(m))).toBe(true)
    const env = echoed(await waitRun(run.id))
    expect(env.ACME_TOKEN).toBe('<unset>')
    expect(env.BETA_TOKEN).toBe('••••BETA_TOKEN')
  })
})

// ---------- schedules (§3, §6) ----------

d('matrix: schedules', () => {
  const when = { kind: 'cron' as const, cron: '0 9 * * *', tz: 'UTC' }
  it("a schedule lives in its workflow's company and fires as that company", async () => {
    const h = w as unknown as Hive
    const input = { name: 'Daily', target: { kind: 'workflow' as const, workflowId: w.wfA.id, inputs: {} }, when, enabled: true }
    expect(scheduleCompany(h, input)).toBe(w.acme.id)
    const id = w.store.insertSchedule(input, scheduleCompany(h, input))
    w.engine.scheduler.upsert(id)
    const run = w.engine.scheduler.runNow(id)
    expect(run.companyId).toBe(w.acme.id)
    const env = echoed(await waitRun(run.id))
    expect(env.ACME_TOKEN).toBe('••••ACME_TOKEN')
    expect(env.BETA_TOKEN).toBe('<unset>')
    expect(w.store.listSchedules(w.acme.id).map((s) => s.id)).toEqual([id])
    expect(w.store.listSchedules(w.beta.id)).toEqual([])
  })

  it("Acme cannot schedule Beta's workflow or repo, and a schedule whose workflow moved to Beta is caught when it fires", () => {
    const h = w as unknown as Hive
    const before = betaState()
    expect(() => scheduleCompany(h, { name: 'x', target: { kind: 'workflow', workflowId: w.wfB.id, inputs: {} }, when, enabled: true }, w.acme.id)).toThrow(/belongs to Beta/)
    expect(() => scheduleCompany(h, { name: 'x', target: { kind: 'prompt', profileId: w.profile.id, repoId: w.repoB.id, prompt: 'x' }, when, enabled: true }, w.acme.id)).toThrow(/belongs to Beta/)
    expect(betaState()).toBe(before)

    const wf = w.store.createWorkflow(draft('Moves later', [agentNode(null)]), null, null, w.acme.id)
    const id = w.store.insertSchedule({ name: 'Old', target: { kind: 'workflow', workflowId: wf.id, inputs: {} }, when, enabled: true }, w.acme.id)
    w.store.setWorkflowCompany(wf.id, w.beta.id)
    expect(() => w.engine.scheduler.runNow(id)).toThrow(/belongs to Beta/)
    expect(w.store.listRuns({ limit: 1000 })).toEqual([])
  })
})

// ---------- Slack triggers (§3, §6) ----------

d('matrix: Slack triggers', () => {
  let harness: Harness
  const trigger = (workflowId: string, name: string): SlackTriggerInput => ({
    name, workflowId, enabled: true,
    match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] },
    reply: { mode: 'draft', autoChannels: [] }
  })
  const message = (o: Partial<SlackInboundMessage> = {}): SlackInboundMessage => ({
    teamId: 'T1', channelId: 'C1', channelKind: 'channel', channelName: 'support', ts: '1760605200.000100', threadTs: null,
    userId: 'U1', userName: 'Dana', botId: null, subtype: null, plain: '@hive help', isMention: true, isDmToBot: false,
    isOwn: false, fromBot: false, eventTime: 1760605200, receivedAt: 1760605200000, source: 'event', catchup: false, author: 'member', ...o
  })
  function slack() {
    const wfA = w.store.createWorkflow({ ...draft('Acme support', [agentNode(null)]), inputs: [{ name: 'text', label: 'Text', default: 'x' }] }, null, null, w.acme.id)
    const wfB = w.store.createWorkflow({ ...draft('Beta support', [agentNode(null)]), inputs: [{ name: 'text', label: 'Text', default: 'x' }] }, null, null, w.beta.id)
    harness = makeHarness({ db: w.db })
    w.db.prepare("INSERT INTO slack_workspaces(team_id, team_name, bot_user_id, bot_id, connected_at, updated_at, company_id) VALUES ('T1', 'Acme Inc', 'UBOT', 'BBOT', 'x', 'x', ?)").run(w.acme.id)
    const hive = { db: w.db, store: w.store, company: w.company, vault: w.vault, live: null, settings: () => w.store.getSettings(), safe: <T,>(fn: () => T, fb: T): T => { try { return fn() } catch { return fb } }, windows: { command() {} } }
    const svc = new SlackService(hive as never, { cipher: fakeCipher(), mainDir: w.tmp, transport: { http: harness.fake.http, socket: harness.fake.socket, fake: true } })
    const c = svc.connector as unknown as { ws: unknown; state: string }
    c.ws = { teamId: 'T1', teamName: 'Acme Inc', botUserId: 'UBOT', botId: 'BBOT' }
    c.state = 'connected'
    const seen: string[][] = []
    svc.bridge().onMessage(() => void seen.push(svc.triggers.list().map((t) => t.id)))
    const dispatch = (m: SlackInboundMessage) => (svc as unknown as { dispatchInbound(m: SlackInboundMessage): void }).dispatchInbound(m)
    return { svc, wfA, wfB, seen, dispatch }
  }

  it("an Acme workspace starts Acme's triggers only; a Beta trigger can't be saved there and never sees its messages", () => {
    const { svc, wfA, wfB, seen, dispatch } = slack()
    const tA = svc.createTrigger(trigger(wfA.id, 'Acme mention'))
    expect(() => svc.createTrigger(trigger(wfB.id, 'Beta mention'))).toThrow(/belongs to Acme, but the workflow belongs to Beta/)
    // one saved while the guards were off still never fires for this workspace's messages
    const tB = svc.triggers.insert(normalizeTrigger(trigger(wfB.id, 'Beta legacy'), wfB).trigger)
    dispatch(message())
    expect(seen).toEqual([[tA.id]])
    expect(svc.triggers.events(tB.id)[0].message).toMatch(/^Dropped: This Slack workspace belongs to Acme/)
    // a Slack-triggered run of Acme's workflow is Acme's
    expect(w.engine.runs.start({ kind: 'workflow', workflowId: wfA.id, inputs: { text: 'x' } }, { trigger: 'slack' }).companyId).toBe(w.acme.id)
  })
})

// ---------- MCP gateway (§6) ----------

d('matrix: MCP gateway', () => {
  /** The connections a spawn's grant can reach: exactly what the gateway's poll answers `list` and `call` with. */
  const granted = () => {
    const gw = w.gateway as unknown as { grants: Map<string, { cwd: string; companyId: string | null }>; allowed(cwd: string, companyId: string | null): { config: { id: string } }[] }
    return [...gw.grants.values()].map((g) => gw.allowed(g.cwd, g.companyId).map((s) => s.config.id).sort())
  }
  beforeEach(() => {
    if (!nativeOk || process.versions.electron) return
    w.gateway.save({ id: 'acme-crm', name: 'Acme CRM', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global', companyIds: [w.acme.id] })
    w.gateway.save({ id: 'beta-crm', name: 'Beta CRM', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global', companyIds: [w.beta.id] })
    w.gateway.save({ id: 'everyone', name: 'Docs', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global' })
  })

  it("an Acme session's grant reaches Acme's and unscoped connections, never Beta's", () => {
    w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    expect(FakePty.last.args.join(' ')).toContain('--mcp-config')
    expect(granted()).toEqual([['acme-crm', 'everyone']])
  })

  it("an Acme run's grant reaches Acme's and unscoped connections, never Beta's", async () => {
    await waitRun(w.engine.runs.start({ kind: 'workflow', workflowId: w.wfA.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(w.calls[0].mcpArgs ?? []).toContain('--mcp-config')
    expect(granted()).toEqual([['acme-crm', 'everyone']])
  })

  it('a Personal spawn reaches only unscoped connections', () => {
    w.sessions.create({ adapter: 'claude', repoId: w.repoP.id, cols: 80, rows: 24 })
    expect(granted()).toEqual([['everyone']])
  })

  it('off: a limited connection still reaches other companies, with a warning (today\'s behaviour)', () => {
    enforce(false)
    w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    expect(granted()).toEqual([['acme-crm', 'beta-crm', 'everyone']])
    expect(w.warnings.some((m) => /gateway: company guard/.test(m))).toBe(true)
  })
})

// ---------- authoring tools (§6) ----------

d('matrix: authoring tools', () => {
  it("an Acme session lists, reads and runs Acme's workflows only; Beta's workflows, runs and repos are invisible", async () => {
    const betaRun = w.engine.runs.start({ kind: 'workflow', workflowId: w.wfB.id, inputs: {} }, { trigger: 'manual' })
    await waitRun(betaRun.id)
    const hive = {
      db: w.db, store: w.store, vault: w.vault, company: w.company, engine: w.engine, paths: { userData: w.tmp, scratchDir: path.join(w.tmp, 'scratch') },
      runHooks: [], live: null, slack: null, settings: () => w.store.getSettings(),
      safe: <T,>(fn: () => T, fb: T): T => { try { return fn() } catch { return fb } },
      statusChanged() {}, onLiveEvent() {}, windows: { command() {} }
    } as unknown as Hive
    wireAuthoring(hive, { mainDir: w.tmp, reaper: null })
    const s = w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    let n = 0
    const call = (tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
        hive.author!.handleCall({ kind: 'session', sessionId: s.id } as never, { call_id: `hac_${String(n++).padStart(10, '0')}`, tool, args, ...extra }, (_id, payload) => resolve(payload as never))
      })
    const before = betaState()
    expect(((await call('hive_workflow_list')).result!.workflows as { id: string }[]).map((x) => x.id)).toEqual([w.wfA.id])
    expect(await call('hive_workflow_get', { id: w.wfB.id })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await call('hive_run_get', { run_id: betaRun.id })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await call('hive_workflow_run', { workflow_id: w.wfB.id })).toMatchObject({ ok: true, result: { status: 'invalid' } })
    expect(((await call('hive_repos_list')).result!.repos as { id: string }[]).map((r) => r.id)).toEqual([w.repoA.id])
    // a call line naming another company is refused outright
    expect(await call('hive_workflow_list', {}, { company_id: w.beta.id })).toMatchObject({ ok: false, error: expect.stringMatching(/another company/) })
    expect(betaState()).toBe(before)
    expect(w.store.listRuns({ companyId: w.beta.id }).map((r) => r.id)).toEqual([betaRun.id])
  })
  it("an Acme session's proposals save into Acme, can't target Beta's repo, and can't touch Beta's workflows", async () => {
    const hive = {
      db: w.db, store: w.store, vault: w.vault, company: w.company, engine: w.engine, paths: { userData: w.tmp, scratchDir: path.join(w.tmp, 'scratch') },
      runHooks: [], live: null, slack: null, settings: () => w.store.getSettings(),
      safe: <T,>(fn: () => T, fb: T): T => { try { return fn() } catch { return fb } },
      statusChanged() {}, onLiveEvent() {}, windows: { command() {} }
    } as unknown as Hive
    wireAuthoring(hive, { mainDir: w.tmp, reaper: null })
    const s = w.sessions.create({ adapter: 'claude', companyId: w.acme.id, cols: 80, rows: 24 })
    let n = 0
    const call = (tool: string, args: Record<string, unknown>) =>
      new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
        hive.author!.handleCall({ kind: 'session', sessionId: s.id } as never, { call_id: `hac_${String(n++).padStart(10, '0')}`, tool, args }, (_id, payload) => resolve(payload as never))
      })
    const wf = (name: string, cwd: string | null) => ({ name, nodes: [{ id: 'a', type: 'agent', cwd, profileId: w.profile.id, prompt: 'Do the work' }] })
    const before = betaState()
    // a proposal is stamped with the caller's company, whoever approves it (here: main, outside any authoring call)
    const ok = await call('hive_workflow_create', { workflow: wf('Acme proposal', w.repoA.id), summary: 'Runs an agent in the Acme repo', wait_s: 0 })
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, result: { status: 'pending' } })
    const saved = hive.author!.decide({ id: ok.result!.draft_id as string, decision: 'approve' })
    expect(saved.status).toBe('approved')
    const created = w.store.listWorkflows().find((x) => x.name === 'Acme proposal')!
    expect(created.companyId).toBe(w.acme.id)
    expect(w.db.prepare('SELECT company_id FROM author_drafts WHERE id = ?').get(saved.id)).toEqual({ company_id: w.acme.id })
    // a proposal targeting Beta's repo never becomes a workflow
    const bad = await call('hive_workflow_create', { workflow: wf('Sneaky proposal', w.repoB.id), summary: 'Runs an agent in the Beta repo', wait_s: 0 })
    // (enforced: the proposal itself is invalid, so no approval card that can never be approved is shown)
    expect(bad).toMatchObject({ ok: true, result: { status: 'invalid', errors: [{ path: 'nodes', message: expect.stringMatching(/belongs to Beta/) }] } })
    expect(bad.result!.draft_id).toBeUndefined()
    expect(w.store.listWorkflows().some((x) => x.name === 'Sneaky proposal')).toBe(false)
    // Beta's workflow can't be updated (or scheduled through an update) from Acme
    expect(await call('hive_workflow_update', { id: w.wfB.id, workflow: wf('Beta flow', w.repoB.id), summary: 'Changes the Beta flow', wait_s: 0 })).toMatchObject({
      ok: true, result: { status: 'invalid', errors: [{ path: 'id', message: expect.stringMatching(/not found/) }] }
    })
    expect(betaState()).toBe(before)
  })
})
