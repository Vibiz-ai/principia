/**
 * ONBOARDING.md §7, §10: the launch transaction end to end over the real modules (hive.db, Store, CompanyStore with
 * its DepartmentStore, vault + company_secrets behind KeyNamespaces, the bundled marketplace catalog, and the exported
 * create paths of handlers/company.ts, repos.ts, marketplace.ts and schedules.ts, wired by onboardingLaunchDeps exactly
 * as the IPC handler wires them). Only the engine (scheduler upsert, workflow validation), the passport writer and git
 * are fakes.
 *
 * 1. Happy path: counts match the plan, everything is stamped with the new company and nothing lands in Personal, the
 *    key exists only in the company namespace (and nowhere in the journal, events or logs), schedules are disabled,
 *    agents are manual.
 * 2. A failure injected at each step, then Retry: no duplicates. A crash mid-step (journal left running), boot, Retry.
 * 3. Discard: archived company, created rows removed or canceled, repos back in Personal, flags restored.
 * 4. A folder owned by another company is refused before any write.
 * 5. Flags off: tasks (and the free workflow schedule) only, no departments or agents.
 * 6. Start enables only the listed schedules and raises only the auto agents.
 * 7. Every onboarding:* channel has a handler.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcReply = { ok: boolean; data?: unknown; error?: { code: string; message: string } }
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcReply>>() }))
// the handlers import IPC, dialogs and safeStorage: no Electron in unit tests; ipcMain records the handlers
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, on: vi.fn(), getLoginItemSettings: () => ({ openAtLogin: false }) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  net: { fetch: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<IpcReply>) => void ipc.handlers.set(channel, fn),
    removeHandler: (channel: string) => void ipc.handlers.delete(channel),
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  Notification: { isSupported: () => false }
}))
import { openDatabase, type DB } from '../../db'
import { Store } from '../../db/store'
import { CompanySecrets, KeyNamespaces } from '../../db/companySecrets'
import { ensureDefaultProfile } from '../../db/seed'
import { CompanyStore } from '../../company'
import { Vault, type Cipher } from '../../vault'
import { previewWhen } from '../../engine/scheduler'
import { hasUserData, onboardingLaunchDeps, registerOnboardingHandlers } from '../../handlers/onboarding'
import type { Hive } from '../../hive'
import { INVOKE_CHANNELS } from '../../../shared/ipc'
import { PERSONAL_COMPANY_ID as P } from '../../../shared/company'
import { HiveError } from '../../../shared/errors'
import {
  EMPTY_ANSWERS,
  LAUNCH_STEPS,
  workflowsForKeys,
  type LaunchInput,
  type LaunchStepName,
  type OnboardingAvailable,
  type ProgressEvent
} from '../../../shared/onboarding'
import { templatePlan } from '../../../shared/onboardingPlan'
import { pickPersona } from '../../../shared/personas'
import type { ProviderInfo } from '../../../shared/types'
import type { VaultApplyResult, VaultOp } from '../../../shared/passport'
import { JOURNAL_PREFIX, JournalStore, LAUNCH_INPUT_PREFIX } from '../journal'
import { KeyStash } from '../keys'
import { LaunchService, type LaunchDeps } from '../launch'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk && !process.versions.electron ? describe : describe.skip

const KEY = 'fal-onboarding-0123456789abcdef:SeCrEt-value-9f3a'
const TZ = 'Europe/Lisbon'

const fakeCipher = (): Cipher => ({
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
})

const provider = (id: ProviderInfo['id'], available: boolean): ProviderInfo => ({ id, label: id, available, version: '1', binPath: available ? `/usr/bin/${id}` : null, installHint: '', checkedAt: new Date().toISOString() })

/** A fake passport writer: records every applyOps call; `refuseExcerpts` refuses ops that carry the site excerpt. */
class FakePassport {
  calls: { companyId: string; ops: VaultOp[] }[] = []
  ensured: string[] = []
  refuseExcerpts = false
  ensure(companyId: string) {
    this.ensured.push(companyId)
    return '/vault'
  }
  async applyOps(companyId: string, ops: VaultOp[]): Promise<VaultApplyResult> {
    this.calls.push({ companyId, ops })
    if (this.refuseExcerpts && ops.some((o) => o.op === 'observe' && o.text.startsWith('Website says:'))) throw new Error('Refused: text looks like a credential (token). Do not store credentials in memory.')
    return { results: ops.map((o, index) => ({ index, status: 'ok', path: o.op === 'createNote' ? `${o.title}.md` : null, noteId: null, blockId: null, hash: null, reason: null })), conflicts: [] }
  }
}

interface World {
  dir: string
  db: DB
  store: Store
  company: CompanyStore
  vault: Vault
  secrets: CompanySecrets
  h: Hive
  journal: JournalStore
  stash: KeyStash
  passport: FakePassport
  providers: ProviderInfo[]
  events: ProgressEvent[]
  warnings: { message: string; meta?: Record<string, unknown> }[]
  /** A git folder on disk, not yet in Principia. */
  repoDir: string
  /** A folder already in Principia, owned by Personal. */
  personalRepo: { id: string; path: string }
  deps: LaunchDeps
  svc: LaunchService
}
let w: World

function makeWorld(): World {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'principia-launch-')))
  const db = openDatabase(path.join(dir, 'hive.db'))
  const store = new Store(db)
  const company = new CompanyStore(store, { companiesRoot: path.join(dir, 'companies') })
  const vault = new Vault(db, fakeCipher())
  const secrets = new CompanySecrets(db, fakeCipher())
  ensureDefaultProfile(store, 'claude')
  const repoDir = path.join(dir, 'code', 'sunday-web')
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
  const personalDir = path.join(dir, 'code', 'old-site')
  fs.mkdirSync(personalDir, { recursive: true })
  const [pr] = store.addRepo(personalDir)
  const providers = [provider('claude', true), provider('codex', false), provider('shell', true)]
  const h = {
    db,
    store,
    vault,
    company,
    paths: { userData: dir },
    settings: () => store.getSettings(),
    updateSettings: (patch: Parameters<Store['updateSettings']>[0]) => store.updateSettings(patch),
    safe: <T,>(fn: () => T, fb: T): T => {
      try {
        return fn()
      } catch {
        return fb
      }
    },
    statusChanged: () => {},
    engine: {
      scheduler: { preview: (when: Parameters<typeof previewWhen>[0]) => previewWhen(when, new Date()), upsert: (id: string) => store.getSchedule(id), remove: () => {} },
      workflows: { validate: () => [] },
      providers: { list: async () => providers }
    },
    sessions: { liveCountForRepo: () => 0 },
    tray: null,
    memory: null,
    dispatcher: null,
    author: null,
    slack: null
  } as unknown as Hive
  const journal = new JournalStore(store)
  const stash = new KeyStash()
  const passport = new FakePassport()
  const events: ProgressEvent[] = []
  const warnings: World['warnings'] = []
  const keys = new KeyNamespaces(vault, new CompanySecrets(db, fakeCipher()))
  const deps: LaunchDeps = {
    ...onboardingLaunchDeps(h, { journal, keys, providers: () => providers, stash }),
    memory: () => (store.getSettings().experimental?.vault ? passport : null),
    clone: () => ({ promise: Promise.reject(new Error('no git in tests')), kill: async () => {} }),
    emitProgress: (e) => void events.push(e),
    emitClone: () => {},
    log: { warn: (message, meta) => void warnings.push({ message, meta }) }
  }
  return { dir, db, store, company, vault, secrets, h, journal, stash, passport, providers, events, warnings, repoDir, personalRepo: { id: pr.id, path: pr.path }, deps, svc: new LaunchService(deps) }
}

beforeEach(() => {
  if (!nativeOk || process.versions.electron) return
  w = makeWorld()
})
afterEach(() => {
  if (!w) return
  w.db.close()
  fs.rmSync(w.dir, { recursive: true, force: true })
  w = undefined as unknown as World
})

/** What the renderer would send: a template plan for the answers, a stashed fal key, the consent switch. */
function launchInput(o: { enableFlags?: boolean; key?: boolean; repos?: string[]; goals?: LaunchInput['answers']['goals'] } = {}): LaunchInput {
  const enableFlags = o.enableFlags ?? true
  const withKey = o.key ?? true
  const repos = o.repos ?? [w.repoDir, w.personalRepo.path]
  const answers = {
    ...EMPTY_ANSWERS,
    name: 'Sunday Bakery',
    oneLiner: 'Sourdough delivered to offices in Lisbon',
    products: 'Sourdough loaves and pastries',
    audience: 'Office managers in Lisbon',
    siteUrl: 'https://sundaybakery.com',
    goals: o.goals ?? (['social', 'customers', 'ship'] as LaunchInput['answers']['goals'])
  }
  const available: OnboardingAvailable = { workflows: workflowsForKeys({ FAL_KEY: withKey }), profileAdapters: ['claude'], hasCode: repos.length > 0, departmentsOn: enableFlags }
  const planInput = { hasCode: repos.length > 0, answers, keys: { fal: withKey, openai: false }, departmentsOn: enableFlags, tz: TZ, site: { url: 'https://sundaybakery.com/', title: 'Sunday Bakery', description: 'Fresh sourdough', fetchedAt: new Date().toISOString() } }
  const plan = templatePlan(planInput, available, { siteUrl: answers.siteUrl })
  const key = withKey ? { name: 'FAL_KEY' as const, stashId: w.stash.stash('FAL_KEY', KEY).stashId } : null
  return {
    mode: 'new',
    hasCode: repos.length > 0,
    answers,
    repos: repos.map((p) => ({ kind: 'local' as const, path: p })),
    site: planInput.site,
    key,
    plan,
    enableFlags,
    tz: TZ
  }
}

/** Everything that exists for a company, for counting and stamp checks. */
function inventory(companyId: string) {
  return {
    departments: w.company.departments.list(companyId, { includeArchived: true }),
    agents: w.company.departments.listAgents({ companyId, includeArchived: true }),
    tasks: w.company.listTasks(companyId),
    schedules: w.store.listSchedules(companyId),
    workflows: w.store.listWorkflows(companyId),
    repos: w.company.passport(companyId).repoIds,
    keys: w.secrets.list(companyId).map((k) => k.name)
  }
}
const counts = (inv: ReturnType<typeof inventory>) => Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v.length]))
/** Personal's rows (must not change during a launch). */
const personalState = () =>
  JSON.stringify({
    tasks: w.company.listTasks(P).length,
    schedules: w.store.listSchedules(P).length,
    workflows: w.store.listWorkflows(P).length,
    departments: w.company.departments.list(P, { includeArchived: true }).length,
    agents: w.company.departments.listAgents({ companyId: P, includeArchived: true }).length,
    sharedKeys: w.vault.list().map((k) => k.name),
    personalKeys: w.secrets.list(P).length
  })
const newCompanies = () => w.company.listPassports({ includeArchived: true }).filter((c) => c.id !== P)
/** Every meta row the journal wrote, as text. */
const journalText = () => JSON.stringify((w.db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'onboarding.%'`).all() as { value: string }[]).map((r) => r.value))

// ---------- 1. happy path ----------

d('launch: happy path', () => {
  it('creates the plan in the new company only, key in its namespace, schedules off, agents manual', async () => {
    const before = personalState()
    const input = launchInput()
    const r = await w.svc.launch({ draftId: 'draft_1', input })
    expect(r.status).toBe('done')
    expect(r.steps.every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true)
    const companyId = r.companyId!
    expect(companyId).toBeTruthy()
    expect(companyId).not.toBe(P)
    expect(newCompanies().map((c) => c.id)).toEqual([companyId])

    const co = w.company.passport(companyId)
    expect(co).toMatchObject({ name: 'Sunday Bakery', mission: 'Sourdough delivered to offices in Lisbon', products: 'Sourdough loaves and pastries', audience: 'Office managers in Lisbon' })
    expect(co.constraints).toMatch(/Never post, send, spend/)
    expect(co.color).toMatch(/^var\(--/)

    // counts match the plan
    const plan = input.plan
    const inv = inventory(companyId)
    expect(inv.departments.length).toBe(plan.departments.filter((x) => x.include).length)
    expect(inv.agents.length).toBe(plan.agents.filter((x) => x.include).length)
    expect(inv.tasks.length).toBe(plan.tasks.filter((x) => x.include).length)
    expect(inv.schedules.length).toBe(plan.schedules.filter((x) => x.include).length)
    expect(r.scheduleRefs).toHaveLength(inv.schedules.length)
    expect(inv.departments.length).toBeGreaterThan(0)
    expect(inv.agents.length).toBeGreaterThan(0)
    expect(inv.workflows.length).toBeGreaterThan(0)

    // everything stamped with the new company, nothing in Personal
    for (const t of inv.tasks) expect(t.companyId).toBe(companyId)
    for (const a of inv.agents) expect(a.companyId).toBe(companyId)
    for (const s of inv.schedules) expect(s.companyId).toBe(companyId)
    for (const wf of inv.workflows) expect(wf.companyId).toBe(companyId)
    expect(personalState()).toBe(before)
    // both folders now belong to it: the new one added, the Personal one moved
    const added = w.store.getRepoByPath(w.repoDir)!
    expect(w.company.companyForRepo(added.id).id).toBe(companyId)
    expect(w.company.companyForRepo(w.personalRepo.id).id).toBe(companyId)
    // repo work runs in the first repo; the developer agent defaults to it
    expect(inv.tasks.filter((t) => t.repoId).every((t) => t.repoId === added.id)).toBe(true)
    expect(inv.tasks.some((t) => t.repoId === added.id)).toBe(true)

    // dependencies mapped to the created ids
    const byTitle = new Map(inv.tasks.map((t) => [t.title, t]))
    for (const pt of plan.tasks.filter((t) => t.include && t.dependsOn.length)) {
      const t = byTitle.get(pt.title)!
      const deps = pt.dependsOn.map((ref) => byTitle.get(plan.tasks.find((x) => x.ref === ref)!.title)!.id)
      expect(t.dependencyIds).toEqual(deps)
      expect(t.status).toBe('blocked')
    }

    // the key only in the company namespace; stash wiped
    expect(inv.keys).toEqual(['FAL_KEY'])
    expect(w.vault.list().map((k) => k.name)).not.toContain('FAL_KEY')
    for (const other of w.company.listPassports({ includeArchived: true })) if (other.id !== companyId) expect(w.secrets.list(other.id)).toEqual([])
    expect(w.stash.size).toBe(0)
    // never in the journal, the events or the logs
    expect(journalText()).not.toContain(KEY)
    expect(JSON.stringify(w.events)).not.toContain(KEY)
    expect(JSON.stringify(w.warnings)).not.toContain(KEY)
    expect(journalText()).not.toContain('SeCrEt')

    // schedules disabled, agents manual; AUTOPILOT.md §7: a new business starts with Autopilot on, and with every agent
    // manual nothing starts until Start now raises them
    expect(inv.schedules.every((s) => !s.enabled)).toBe(true)
    expect(inv.agents.every((a) => a.data.autonomy === 'manual')).toBe(true)
    expect(w.company.boardSettings(companyId).autopilot).toBe(false)  // AUTOPILOT.md §7: off until Start now / Start the first week
    const dev = inv.agents.find((a) => a.data.defaultRepoId)
    expect(dev?.data.defaultRepoId).toBe(added.id)

    // flags turned on (consent), and the previous ones kept for Discard
    expect(w.store.getSettings().experimental).toMatchObject({ companies: true, departments: true, vault: true })
    const j = w.journal.get(r.journalId)!
    expect(j.prevFlags).toMatchObject({ companies: false, departments: false, vault: false })
    expect(w.store.getMeta(`${LAUNCH_INPUT_PREFIX}${r.journalId}`)).toBeNull()

    // passport notes written to the new company only
    expect(w.passport.calls.map((c) => c.companyId)).toEqual([companyId])
    const titles = w.passport.calls[0].ops.filter((o) => o.op === 'createNote').map((o) => (o as { title: string }).title)
    expect(titles).toEqual(expect.arrayContaining(['Business', 'Products', 'Audience', 'Brand voice', 'Goals (first 30 days)', 'sunday-web', 'old-site']))

    // progress: every step reported, in order
    const finals = w.events.filter((e) => e.status !== 'running').map((e) => e.step)
    expect(finals).toEqual([...LAUNCH_STEPS])
  })

  it('stores each agent persona from the draft (renames included); agent.name stays the role label', async () => {
    const input = launchInput()
    const plan = input.plan
    const included = plan.agents.filter((x) => x.include)
    expect(included.length).toBeGreaterThan(1)
    expect(included.every((a) => a.persona)).toBe(true)
    included[0].persona = { ...included[0].persona!, name: 'Maximus' }
    const r = await w.svc.launch({ draftId: 'draft_p', input })
    expect(r.status).toBe('done')
    const agents = inventory(r.companyId!).agents
    expect(agents).toHaveLength(included.length)
    for (const pa of included) {
      const a = agents.find((x) => x.name === pa.name)!
      expect(a.data.persona).toEqual(pa.persona)
      expect(a.name).not.toBe(pa.persona!.name)
    }
    const names = agents.map((a) => a.data.persona!.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('maximus')
  })

  it('a draft agent without a persona gets one picked with the real seed (companyId:ref)', async () => {
    const input = launchInput()
    const included = input.plan.agents.filter((x) => x.include)
    const bare = included[included.length - 1]
    delete bare.persona
    const r = await w.svc.launch({ draftId: 'draft_q', input })
    expect(r.status).toBe('done')
    const agents = inventory(r.companyId!).agents
    const used = new Set(included.filter((x) => x.persona).map((x) => x.persona!.name.toLowerCase()))
    const expected = pickPersona({ departmentKey: bare.departmentKey, role: bare.role, used, seed: `${r.companyId}:${bare.ref}` })
    expect(agents.find((x) => x.name === bare.name)!.data.persona).toEqual(expected)
    const names = agents.map((a) => a.data.persona!.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it('a second launch for the same draft returns the finished journal instead of a second company', async () => {
    const input = launchInput()
    const a = await w.svc.launch({ draftId: 'draft_1', input })
    const b = await w.svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(b.journalId).toBe(a.journalId)
    expect(newCompanies()).toHaveLength(1)
  })

  it('a secret-screen hit drops the scan/site excerpts and retries the passport once', async () => {
    w.passport.refuseExcerpts = true
    const r = await w.svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r.status).toBe('done')
    expect(r.steps.find((s) => s.name === 'passport')!.status).toBe('done')
    expect(w.passport.calls).toHaveLength(2)
    expect(JSON.stringify(w.passport.calls[1].ops)).not.toContain('Website says')
  })

  it('one launch at a time per draft', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const svc = new LaunchService({ ...w.deps, beforeStep: async (s) => (s === 'company' ? gate : undefined) })
    const first = svc.launch({ draftId: 'draft_1', input: launchInput() })
    await expect(svc.launch({ draftId: 'draft_1', input: launchInput() })).rejects.toMatchObject({ code: 'conflict' })
    release()
    expect((await first).status).toBe('done')
    expect(newCompanies()).toHaveLength(1)
  })
})

// ---------- 2. failure, retry, crash ----------

d('launch: workflow schedules that need a repo', () => {
  /** The template plan as made when Codex is installed too (it adds the weekly second-opinion review). */
  function withCodex(repos?: string[]): LaunchInput {
    w.providers.find((p) => p.id === 'codex')!.available = true
    const input = launchInput({ repos })
    const available: OnboardingAvailable = { workflows: workflowsForKeys({ FAL_KEY: true }), profileAdapters: ['claude', 'codex'], hasCode: input.hasCode, departmentsOn: true }
    const plan = templatePlan({ hasCode: input.hasCode, answers: input.answers, keys: { fal: true, openai: false }, departmentsOn: true, tz: TZ, site: input.site }, available, { siteUrl: input.answers.siteUrl })
    return { ...input, plan }
  }

  it('fills the review schedule repo input with the first repo', async () => {
    const input = withCodex()
    expect(input.plan.schedules.some((s) => s.target.kind === 'workflow' && s.target.workflow === 'second-opinion-review')).toBe(true)
    const r = await w.svc.launch({ draftId: 'draft_repo', input })
    expect(r.status).toBe('done')
    const added = w.store.getRepoByPath(w.repoDir)!
    const review = w.store.listSchedules(r.companyId!).find((s) => s.target.kind === 'workflow' && s.name.includes('second-opinion'))
    expect(review?.target).toMatchObject({ kind: 'workflow', inputs: { repo: added.id } })
  })

  it('skipping Code drops the review schedule instead of creating one with no repo', async () => {
    const input = withCodex()
    const real = w.deps.addRepoPaths
    w.deps.addRepoPaths = () => {
      throw new Error('disk full')
    }
    const failed = await w.svc.launch({ draftId: 'draft_repo2', input })
    expect(failed.status).toBe('failed')
    w.deps.addRepoPaths = real
    const r = await w.svc.skipStep({ journalId: failed.journalId, step: 'code' })
    expect(r.status).toBe('done')
    const names = w.store.listSchedules(r.companyId!).map((s) => s.name)
    expect(names.some((n) => n.includes('second-opinion'))).toBe(false)
  })
})

d('launch: failure at each step, then Retry', () => {
  /** The counts a clean launch produces in a fresh world (same plan). */
  async function reference(): Promise<Record<string, number>> {
    const r = await w.svc.launch({ draftId: 'draft_ref', input: launchInput() })
    const c = counts(inventory(r.companyId!))
    // fresh world for the real test
    w.db.close()
    fs.rmSync(w.dir, { recursive: true, force: true })
    w = makeWorld()
    return c
  }

  it.each(LAUNCH_STEPS.map((s) => [s]))('fails at %s, Retry finishes with no duplicates', async (step) => {
    const want = await reference()
    let thrown = false
    const svc = new LaunchService({
      ...w.deps,
      beforeStep: (s) => {
        if (s === step && !thrown) {
          thrown = true
          throw new HiveError('internal', `boom at ${s}`)
        }
      }
    })
    const input = launchInput()
    const r1 = await svc.launch({ draftId: 'draft_1', input })
    expect(r1.status).toBe('failed')
    const failed = r1.steps.find((s) => s.status === 'failed')!
    expect(failed.name).toBe(step)
    expect(failed.error).toBe(`boom at ${step}`)
    expect(w.events.some((e) => e.step === step && e.status === 'failed')).toBe(true)

    const r2 = await svc.launch({ journalId: r1.journalId, draftId: 'draft_1', input })
    expect(r2.status).toBe('done')
    expect(r2.journalId).toBe(r1.journalId)
    expect(newCompanies()).toHaveLength(1)
    expect(counts(inventory(r2.companyId!))).toEqual(want)
    expect(w.passport.calls.every((c) => c.companyId === r2.companyId)).toBe(true)
  })

  it('a failure in the middle of the tasks step resumes after the tasks already made', async () => {
    let n = 0
    const create = w.deps.createTask
    const svc = new LaunchService({ ...w.deps, createTask: (t) => (++n === 3 ? (() => { throw new Error('disk full') })() : create(t)) })
    const input = launchInput()
    const r1 = await svc.launch({ draftId: 'draft_1', input })
    expect(r1.status).toBe('failed')
    expect(r1.steps.find((s) => s.name === 'tasks')!.created).toHaveLength(2)
    const r2 = await svc.launch({ journalId: r1.journalId, draftId: 'draft_1', input })
    expect(r2.status).toBe('done')
    const titles = inventory(r2.companyId!).tasks.map((t) => t.title)
    expect(new Set(titles).size).toBe(titles.length)
    expect(titles.length).toBe(input.plan.tasks.filter((t) => t.include).length)
  })

  it('with no agent profile yet (no CLI installed), workflows install onto a default profile instead of failing', async () => {
    for (const p of w.store.listProfiles()) w.store.removeProfile(p.id)
    const install = w.deps.installWorkflow
    const seen: number[] = []
    const svc = new LaunchService({
      ...w.deps,
      installWorkflow: async (id, companyId) => {
        seen.push(w.store.listProfiles().filter((p) => p.adapter !== 'shell').length)
        return install(id, companyId)
      }
    })
    const r = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r.status).toBe('done')
    expect(r.steps.find((s) => s.name === 'workflows')!.status).toBe('done')
    expect(seen.length).toBeGreaterThan(0)
    for (const n of seen) expect(n).toBeGreaterThan(0)
  })

  it('a workflow installed right before a failure is adopted on Retry, not installed twice', async () => {
    const install = w.deps.installWorkflow
    let first = true
    const svc = new LaunchService({
      ...w.deps,
      installWorkflow: async (id, companyId) => {
        const wfId = await install(id, companyId)
        if (first) {
          first = false
          throw new Error('crashed before the journal entry')
        }
        return wfId
      }
    })
    const input = launchInput()
    const r1 = await svc.launch({ draftId: 'draft_1', input })
    expect(r1.status).toBe('failed')
    const r2 = await svc.launch({ journalId: r1.journalId, draftId: 'draft_1', input })
    expect(r2.status).toBe('done')
    const names = inventory(r2.companyId!).workflows.map((x) => x.name)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names).size).toBe(names.length)
    expect(r2.steps.find((s) => s.name === 'workflows')!.created).toHaveLength(names.length)
  })

  it('a crash mid-launch (journal left running) is marked failed on boot and Retry finishes cleanly', async () => {
    let n = 0
    let snapshot: string | null = null
    let journalKey = ''
    const create = w.deps.createTask
    const crashing = new LaunchService({
      ...w.deps,
      createTask: (t) => {
        if (++n === 2) {
          // the process dies here: the journal as stored at this moment is what the next boot finds
          journalKey = (w.db.prepare(`SELECT key FROM meta WHERE key LIKE '${JOURNAL_PREFIX}%'`).get() as { key: string }).key
          snapshot = w.store.getMeta(journalKey)
          throw new Error('SIGKILL')
        }
        return create(t)
      }
    })
    const input = launchInput()
    await crashing.launch({ draftId: 'draft_1', input })
    w.store.setMeta(journalKey, snapshot)
    expect(JSON.parse(snapshot!).status).toBe('running')

    // next boot: a fresh journal store and service
    const journal = new JournalStore(w.store)
    const interrupted = journal.markInterrupted()
    expect(interrupted).toHaveLength(1)
    const j = journal.get(interrupted[0])!
    expect(j.status).toBe('failed')
    expect(j.steps.find((s) => s.name === 'tasks')).toMatchObject({ status: 'failed', error: 'Setup was interrupted' })

    const svc = new LaunchService({ ...w.deps, journal })
    const r = await svc.launch({ journalId: j.id, draftId: 'draft_1', input })
    expect(r.status).toBe('done')
    const tasks = inventory(r.companyId!).tasks
    expect(tasks).toHaveLength(input.plan.tasks.filter((t) => t.include).length)
    expect(new Set(tasks.map((t) => t.title)).size).toBe(tasks.length)
    expect(newCompanies()).toHaveLength(1)
  })

  it('Continue without this skips a failed soft step and finishes; hard steps cannot be skipped', async () => {
    const svc = new LaunchService({ ...w.deps, beforeStep: (s) => { if (s === 'schedules') throw new Error('scheduler down') } })
    const r1 = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r1.status).toBe('failed')
    const ok = new LaunchService(w.deps)
    const r2 = await ok.skipStep({ journalId: r1.journalId, step: 'schedules' })
    expect(r2.status).toBe('done')
    expect(r2.steps.find((s) => s.name === 'schedules')!.status).toBe('skipped')
    expect(w.store.listSchedules(r2.companyId!)).toHaveLength(0)
    await expect(ok.skipStep({ journalId: r1.journalId, step: 'tasks' as never })).rejects.toBeInstanceOf(HiveError)
  })

  it('skipping Code turns repo work into workspace work', async () => {
    const input = launchInput({ repos: [w.repoDir] })
    const svc = new LaunchService({ ...w.deps, beforeStep: (s) => { if (s === 'code') throw new Error('no access') } })
    const r1 = await svc.launch({ draftId: 'draft_1', input })
    const r2 = await new LaunchService(w.deps).skipStep({ journalId: r1.journalId, step: 'code' })
    expect(r2.status).toBe('done')
    const inv = inventory(r2.companyId!)
    expect(inv.repos).toEqual([])
    expect(inv.tasks.every((t) => t.repoId === null)).toBe(true)
    expect(inv.agents.every((a) => a.data.defaultRepoId === null)).toBe(true)
  })

  it('skipping a failed Keys step plans nothing that needs the key (no image workflows, tasks or schedules)', async () => {
    const svc = new LaunchService({ ...w.deps, keys: { ...w.deps.keys, set: () => { throw new Error('keychain locked') } } })
    const input = launchInput()
    const r1 = await svc.launch({ draftId: 'draft_1', input })
    expect(r1.steps.find((s) => s.name === 'keys')!.status).toBe('failed')
    const r2 = await new LaunchService(w.deps).skipStep({ journalId: r1.journalId, step: 'keys' })
    expect(r2.status).toBe('done')
    const inv = inventory(r2.companyId!)
    expect(inv.keys).toEqual([])
    const falOnly = new Set(workflowsForKeys({ FAL_KEY: true }).filter((id) => !workflowsForKeys({}).includes(id)))
    expect(falOnly.size).toBeGreaterThan(0)
    // the plan had image work; none of it was installed or scheduled without the key
    expect(input.plan.schedules.some((s) => s.include && s.target.kind === 'workflow' && falOnly.has(s.target.workflow))).toBe(true)
    const installed = new Set(Object.keys(w.journal.get(r2.journalId)!.refs.workflows))
    for (const id of falOnly) expect(installed.has(id)).toBe(false)
    for (const t of inv.tasks) for (const id of falOnly) expect(`${t.title}\n${t.description}`).not.toContain(id)
  })

  it('a write rolled back inside its step leaves no trace in the journal', async () => {
    const create = w.deps.createSchedule
    let n = 0
    // the second schedule comes back stamped with another company: the step refuses it and the row is rolled back
    const svc = new LaunchService({ ...w.deps, createSchedule: (input) => { const s = create(input); return ++n === 2 ? { ...s, companyId: 'co_other' } : s } })
    const r1 = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r1.status).toBe('failed')
    const j = w.journal.get(r1.journalId)!
    const step = j.steps.find((s) => s.name === 'schedules')!
    expect(step.status).toBe('failed')
    expect(step.created).toHaveLength(1)
    expect(j.scheduleRefs).toHaveLength(1)
    expect(w.store.listSchedules(r1.companyId!)).toHaveLength(1)
    for (const c of step.created) expect(w.store.getSchedule(c.id)).toBeTruthy()
  })

  it('a key step failure never carries the key value into the error, the journal or the logs', async () => {
    const svc = new LaunchService({ ...w.deps, keys: { ...w.deps.keys, set: (_c, _n, value) => { throw new Error(`cannot store ${value}`) } } })
    const r = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r.status).toBe('failed')
    const step = r.steps.find((s) => s.name === 'keys')!
    expect(step.status).toBe('failed')
    expect(step.error).not.toContain(KEY)
    expect(journalText()).not.toContain(KEY)
    expect(JSON.stringify(w.events)).not.toContain(KEY)
    expect(JSON.stringify(w.warnings)).not.toContain(KEY)
  })
})

// ---------- 3. discard ----------

d('launch: discard', () => {
  it('undoes what was set up and archives the company; folders stay on disk', async () => {
    const before = personalState()
    const svc = new LaunchService({ ...w.deps, beforeStep: (s: LaunchStepName) => { if (s === 'finish') throw new Error('late failure') } })
    const r = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    expect(r.status).toBe('failed')
    const companyId = r.companyId!
    const added = w.store.getRepoByPath(w.repoDir)!
    const made = inventory(companyId)
    expect(made.schedules.length).toBeGreaterThan(0)

    const { undone } = await svc.discard({ journalId: r.journalId })
    expect(undone).toEqual(expect.arrayContaining(['Schedules', 'Tasks', 'Team', 'Departments', 'Workflows', 'Keys', 'Code', 'Company', 'Beta features']))
    const co = w.company.passport(companyId)
    expect(co.archivedAt).toBeTruthy()
    expect(co.name).toBe('Sunday Bakery (discarded)')
    const inv = inventory(companyId)
    expect(inv.schedules).toHaveLength(0)
    expect(inv.workflows).toHaveLength(0)
    expect(inv.keys).toHaveLength(0)
    expect(inv.tasks.every((t) => t.status === 'canceled')).toBe(true)
    expect(inv.agents.every((a) => a.archivedAt)).toBe(true)
    expect(inv.departments.every((x) => x.archivedAt)).toBe(true)
    // the moved repo is Personal's again, the added row is gone, both folders are still there
    expect(w.company.companyForRepo(w.personalRepo.id).id).toBe(P)
    expect(w.store.getRepo(added.id)).toBeNull()
    expect(fs.existsSync(w.repoDir)).toBe(true)
    expect(fs.existsSync(w.personalRepo.path)).toBe(true)
    // flags restored, autopilot off, Personal untouched
    expect(w.store.getSettings().experimental).toMatchObject({ companies: false, departments: false, vault: false })
    expect(w.company.boardSettings(companyId).autopilot).toBe(false)
    expect(personalState()).toBe(before)
    expect(w.journal.get(r.journalId)!.status).toBe('discarded')
    // a discarded setup can't be resumed or started
    await expect(svc.launch({ journalId: r.journalId, draftId: 'draft_1', input: launchInput() })).rejects.toMatchObject({ code: 'conflict' })
    await expect(svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [] })).rejects.toBeInstanceOf(HiveError)
  })

  it('a finished launch is not discarded from here', async () => {
    const r = await w.svc.launch({ draftId: 'draft_1', input: launchInput() })
    await expect(w.svc.discard({ journalId: r.journalId })).rejects.toMatchObject({ code: 'conflict' })
  })
})

// ---------- 4. foreign repo ----------

d('launch: preflight', () => {
  it('a folder owned by another company is refused before any write', async () => {
    const acme = w.company.create({ name: 'Acme', repoIds: [w.personalRepo.id] })
    const settingsBefore = JSON.stringify(w.store.getSettings())
    const companiesBefore = w.company.listPassports({ includeArchived: true }).length
    const input = launchInput()
    await expect(w.svc.launch({ draftId: 'draft_1', input })).rejects.toThrow(/belongs? to another company: old-site \(Acme\)/)
    expect(w.company.listPassports({ includeArchived: true })).toHaveLength(companiesBefore)
    expect(w.store.getRepoByPath(w.repoDir)).toBeNull()
    expect(w.company.companyForRepo(w.personalRepo.id).id).toBe(acme.id)
    expect(JSON.stringify(w.store.getSettings())).toBe(settingsBefore)
    expect(journalText()).toBe('[]')
    // the key is still stashed for a corrected launch
    expect(w.stash.has(input.key!.stashId)).toBe(true)
  })

  it('an expired stash asks for the key again before any write', async () => {
    const input = launchInput()
    w.stash.forget([input.key!.stashId])
    await expect(w.svc.launch({ draftId: 'draft_1', input })).rejects.toThrow(/Paste your key again/)
    expect(newCompanies()).toHaveLength(0)
  })

  it('main ignores image workflows the renderer claims without a key', async () => {
    const input = launchInput({ key: false })
    // the renderer claims fal: a plan made as if the key were there
    const withFal = launchInput({ key: true })
    const r = await w.svc.launch({ draftId: 'draft_1', input: { ...input, plan: withFal.plan } })
    expect(r.status).toBe('done')
    const inv = inventory(r.companyId!)
    expect(inv.workflows.map((x) => x.name).join(' ')).not.toMatch(/carousel|brand kit|hero/i)
    expect(inv.keys).toEqual([])
  })
})

// ---------- 5. flags off ----------

d('launch: without the departments consent', () => {
  it('creates the company and tasks only: no departments, agents or passport notes; flags untouched', async () => {
    const before = JSON.stringify(w.store.getSettings().experimental)
    const input = launchInput({ enableFlags: false })
    const r = await w.svc.launch({ draftId: 'draft_1', input })
    expect(r.status).toBe('done')
    const inv = inventory(r.companyId!)
    expect(inv.departments).toHaveLength(0)
    expect(inv.agents).toHaveLength(0)
    expect(inv.tasks.length).toBeGreaterThan(0)
    expect(inv.tasks.every((t) => !t.departmentId && !t.agentId)).toBe(true)
    // only workflow schedules (no task mode without departments)
    expect(inv.schedules.every((s) => s.target.kind === 'workflow' && !s.target.mode)).toBe(true)
    expect(w.passport.calls).toHaveLength(0)
    expect(JSON.stringify(w.store.getSettings().experimental)).toBe(before)
    for (const n of ['flags', 'passport', 'departments', 'agents'] as const) expect(r.steps.find((s) => s.name === n)!.status).toBe('skipped')
  })
})

// ---------- 6. start ----------

d('launch: start', () => {
  it('enables only the listed schedules of this journal and raises only the auto agents', async () => {
    const input = launchInput()
    const r = await w.svc.launch({ draftId: 'draft_1', input })
    const companyId = r.companyId!
    const refs = r.scheduleRefs!
    expect(refs.length).toBeGreaterThan(1)
    const pick = refs.find((x) => !x.costly)!
    // a schedule of another company named by ref is never touched
    const other = w.store.insertSchedule({ name: 'Other', target: { kind: 'prompt', profileId: w.store.listProfiles()[0].id, repoId: null, prompt: 'x' }, when: { kind: 'cron', cron: '0 9 * * 1', tz: TZ }, enabled: false }, P)

    // AUTOPILOT.md §7: before it is pressed, Start the first week says what it turns on, and turns nothing on itself
    const preview = w.svc.startPreview({ journalId: r.journalId, scheduleRefs: [pick.ref, 'not-a-ref'] })
    const autoCount = input.plan.agents.filter((a) => a.include && a.auto).length
    expect(preview).toMatchObject({ autopilot: true, noAgentCli: false })
    expect(preview.agents).toHaveLength(autoCount)
    expect(preview.schedules).toEqual([{ name: w.store.getSchedule(pick.id)!.name, when: w.store.getSchedule(pick.id)!.sentence }])
    expect(w.store.listSchedules(companyId).some((s) => s.enabled)).toBe(false)

    const board = await w.svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [pick.ref, 'not-a-ref'] })
    expect(board).toEqual({ companyId, autopilot: true, maxInFlight: 0 })
    for (const s of w.store.listSchedules(companyId)) expect(s.enabled).toBe(s.id === pick.id)
    expect(w.store.getSchedule(other)!.enabled).toBe(false)

    const autoNames = new Set(input.plan.agents.filter((a) => a.include && a.auto).map((a) => a.name))
    const agents = inventory(companyId).agents
    expect(autoNames.size).toBeGreaterThan(0)
    expect(agents.some((a) => !autoNames.has(a.name))).toBe(true)
    for (const a of agents) expect(a.data.autonomy).toBe(autoNames.has(a.name) ? 'auto' : 'manual')
  })

  it('a task that tells you to Run a paid image workflow stays unassigned, even after routing and Start now', async () => {
    // the dispatcher's create hook (DEPARTMENTS.md §2 rule 2): a department with one agent gets that agent
    const routed: LaunchDeps = {
      ...w.deps,
      createTask: (task) => {
        const t = w.deps.createTask(task)
        if (t.departmentId && !t.agentId) {
          const pool = w.company.departments.listAgents({ companyId: t.companyId }).filter((a) => a.departmentId === t.departmentId)
          if (pool.length === 1) return w.company.assign(t.id, { agentId: pool[0].id }, 'system', { by: 'rule', reason: 'only agent' })
        }
        return t
      }
    }
    const svc = new LaunchService(routed)
    const input = launchInput({ goals: ['social'] })
    const brandKit = input.plan.tasks.find((t) => t.ref === 'brand-kit')
    expect(brandKit).toBeTruthy()
    expect(brandKit!.agentRef).toBeNull()
    const r = await svc.launch({ draftId: 'draft_paid', input })
    expect(r.status).toBe('done')
    const companyId = r.companyId!
    const find = () => w.company.listTasks(companyId).find((t) => t.title === brandKit!.title)!
    expect(find().agentId).toBeNull()
    expect(find().departmentId).toBeTruthy()
    // the text task of the same department is still routed to its agent
    const calendar = w.company.listTasks(companyId).find((t) => /content calendar/i.test(t.title))!
    expect(calendar.agentId).toBeTruthy()
    await svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [] })
    expect(w.company.departments.getAgent(calendar.agentId!)!.data.autonomy).toBe('auto')
    expect(find().agentId).toBeNull()
  })

  it('Start now with no agent CLI installed: auto agents raised, Autopilot stays off, nothing pumped', async () => {
    const pumped: string[] = []
    const svc = new LaunchService({ ...w.deps, profileAdapters: () => [], pump: (id) => void pumped.push(id) })
    const input = launchInput()
    const r = await svc.launch({ draftId: 'draft_1', input })
    expect(r.status).toBe('done')
    const board = await svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [] })
    expect(board?.autopilot).toBe(false)
    expect(pumped).toEqual([])
    const autoNames = new Set(input.plan.agents.filter((a) => a.include && a.auto).map((a) => a.name))
    for (const a of inventory(r.companyId!).agents) expect(a.data.autonomy).toBe(autoNames.has(a.name) ? 'auto' : 'manual')
  })

  it("I'll review first: Autopilot stays off and no agent is raised", async () => {
    const r = await w.svc.launch({ draftId: 'draft_1', input: launchInput() })
    const board = await w.svc.start({ journalId: r.journalId, autopilot: false, scheduleRefs: [] })
    expect(board?.autopilot).toBe(false)
    expect(inventory(r.companyId!).agents.every((a) => a.data.autonomy === 'manual')).toBe(true)
    expect(w.store.listSchedules(r.companyId!).every((s) => !s.enabled)).toBe(true)
  })

  it('refuses an unfinished journal and a journal pointing at Personal', async () => {
    const svc = new LaunchService({ ...w.deps, beforeStep: (s) => { if (s === 'tasks') throw new Error('x') } })
    const r = await svc.launch({ draftId: 'draft_1', input: launchInput() })
    await expect(svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [] })).rejects.toMatchObject({ code: 'forbidden' })
    const j = w.journal.get(r.journalId)!
    j.status = 'done'
    j.companyId = P
    w.journal.save(j)
    await expect(svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: [] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(w.company.boardSettings(P).autopilot).toBe(false)
  })
})

// ---------- 8. audit: both branches, closed mid-way, Start now ----------

d('launch: audit paths', () => {
  /** A plan made the way the renderer would for this input (code facts follow hasCode). */
  function replan(input: LaunchInput, hasCode: boolean): LaunchInput {
    const fal = !!input.key
    const available: OnboardingAvailable = { workflows: workflowsForKeys({ FAL_KEY: fal }), profileAdapters: ['claude'], hasCode, departmentsOn: input.enableFlags }
    const plan = templatePlan({ hasCode, answers: input.answers, keys: { fal, openai: false }, departmentsOn: input.enableFlags, tz: TZ, site: input.site }, available, { siteUrl: input.answers.siteUrl })
    return { ...input, hasCode, plan }
  }

  it('no code ("name your idea"): passport notes linked, departments, agents, workspace tasks, schedules; no Development, no repos', async () => {
    const input = launchInput({ repos: [], goals: ['website', 'social'] })
    expect(input.hasCode).toBe(false)
    const r = await w.svc.launch({ draftId: 'draft_idea', input })
    expect(r.status).toBe('done')
    const inv = inventory(r.companyId!)
    expect(inv.repos).toEqual([])
    expect(inv.departments.length).toBeGreaterThan(0)
    expect(inv.departments.some((x) => x.key === 'development')).toBe(false)
    expect(inv.agents.length).toBeGreaterThan(0)
    expect(inv.tasks.length).toBeGreaterThan(0)
    expect(inv.tasks.every((t) => t.repoId === null)).toBe(true)
    expect(inv.schedules.length).toBeGreaterThan(0)
    expect(inv.schedules.every((s) => !s.enabled)).toBe(true)
    // the passport notes are created and linked to each other and to the company hub
    const ops = w.passport.calls[0].ops
    const rels = ops.filter((o) => o.op === 'relate').map((o) => `${(o as { from: string }).from}->${(o as { to: string }).to}`)
    expect(rels).toEqual(expect.arrayContaining(['Business->Products', 'Business->Audience', 'Business->Brand voice', 'Business->Goals (first 30 days)', 'Sunday Bakery->Business']))
    expect(w.company.boardSettings(r.companyId!).autopilot).toBe(false)  // AUTOPILOT.md §7: off until Start now / Start the first week
  })

  it('GitHub: the clone is attached to the new company at launch and repo work runs in it', async () => {
    const parent = path.join(w.dir, 'Projects')
    let cloned = ''
    const svc = new LaunchService({
      ...w.deps,
      clone: (src, parentDir) => {
        cloned = path.join(parentDir, 'sunday-api')
        fs.mkdirSync(path.join(cloned, '.git'), { recursive: true })
        return { promise: Promise.resolve({ path: cloned, reused: false, label: src.fullName ?? '' }), kill: async () => {} }
      }
    })
    const input = replan({ ...launchInput({ repos: [] }), github: { fullName: 'sunday/sunday-api', parentDir: parent } }, true)
    const r = await svc.launch({ draftId: 'draft_gh', input })
    expect(r.status).toBe('done')
    const repo = w.store.getRepoByPath(fs.realpathSync(cloned))!
    expect(repo).toBeTruthy()
    expect(w.company.companyForRepo(repo.id).id).toBe(r.companyId)
    const inv = inventory(r.companyId!)
    expect(inv.departments.some((x) => x.key === 'development')).toBe(true)
    expect(inv.tasks.some((t) => t.repoId === repo.id)).toBe(true)
    expect(r.steps.find((s) => s.name === 'code')!.created).toEqual(expect.arrayContaining([{ kind: 'clone', id: cloned }]))
  })

  it('closing the window mid-launch wipes the stashed key: Retry still resumes, the Keys step fails softly and Continue without this finishes', async () => {
    const svc = new LaunchService({ ...w.deps, beforeStep: (s) => { if (s === 'code') throw new Error('Principia closed') } })
    const input = launchInput()
    const r1 = await svc.launch({ draftId: 'draft_close', input })
    expect(r1.status).toBe('failed')
    // window close / quit: the stash is wiped (the draft keeps only the stash id)
    w.stash.clear()
    const ok = new LaunchService(w.deps)
    const r2 = await ok.launch({ journalId: r1.journalId, draftId: 'draft_close', input })
    expect(r2.status).toBe('failed')
    const keys = r2.steps.find((s) => s.name === 'keys')!
    expect(keys.status).toBe('failed')
    expect(keys.error).toMatch(/Continue without it/)
    const r3 = await ok.skipStep({ journalId: r1.journalId, step: 'keys' })
    expect(r3.status).toBe('done')
    expect(newCompanies()).toHaveLength(1)
    const inv = inventory(r3.companyId!)
    expect(inv.keys).toEqual([])
    expect(inv.tasks.length).toBeGreaterThan(0)
    const falOnly = workflowsForKeys({ FAL_KEY: true }).filter((id) => !workflowsForKeys({}).includes(id))
    expect(Object.keys(w.journal.get(r3.journalId)!.refs.workflows).some((id) => (falOnly as string[]).includes(id))).toBe(false)
  })

  it('Start now: Autopilot on, auto agents raised, chosen schedules on', async () => {
    const r = await w.svc.launch({ draftId: 'draft_go', input: launchInput() })
    expect(w.company.boardSettings(r.companyId!).autopilot).toBe(false)  // AUTOPILOT.md §7: off until Start now / Start the first week
    const free = r.scheduleRefs!.filter((x) => !x.costly).map((x) => x.ref)
    const board = await w.svc.start({ journalId: r.journalId, autopilot: true, scheduleRefs: free })
    expect(board?.autopilot).toBe(true)
    expect(inventory(r.companyId!).agents.some((a) => a.data.autonomy === 'auto')).toBe(true)
    for (const s of w.store.listSchedules(r.companyId!)) expect(s.enabled).toBe(r.scheduleRefs!.some((x) => x.id === s.id && !x.costly))
  })
})

// ---------- 7. IPC surface ----------

d('onboarding handlers', () => {
  it('register every onboarding:* channel', () => {
    ipc.handlers.clear()
    registerOnboardingHandlers(w.h)
    const missing = INVOKE_CHANNELS.filter((c) => c.startsWith('onboarding:') && !ipc.handlers.has(c))
    expect(missing).toEqual([])
  })

  it('the launch key writer never falls back to Shared or Personal', () => {
    expect(() => w.deps.keys.set('', 'FAL_KEY', KEY)).toThrow(HiveError)
    expect(() => w.deps.keys.set(P, 'FAL_KEY', KEY)).toThrow(HiveError)
    expect(w.vault.list().map((k) => k.name)).not.toContain('FAL_KEY')
    expect(w.secrets.list(P)).toEqual([])
  })

  it('first-run detection: any data a person made means an existing user', () => {
    // the world has a Personal repo
    expect(hasUserData(w.db)).toBe(true)
    w.store.removeRepo(w.personalRepo.id)
    // a fresh install: seeded profile only
    expect(hasUserData(w.db)).toBe(false)
    // a seeded workflow is not user data, an own one is
    w.db.prepare("INSERT INTO workflows(id, name, created_at, updated_at, seed_key) VALUES ('wf_seed', 'Seed', '', '', 'seed:x')").run()
    expect(hasUserData(w.db)).toBe(false)
    w.db.prepare("UPDATE workflows SET seed_key = NULL WHERE id = 'wf_seed'").run()
    expect(hasUserData(w.db)).toBe(true)
    w.db.prepare("DELETE FROM workflows").run()
    // a shared key alone marks an existing user
    w.vault.set('SOME_KEY', 'value-1234567890')
    expect(hasUserData(w.db)).toBe(true)
    // a table that can't be read fails closed
    expect(hasUserData({ prepare: () => { throw new Error('no such table') } })).toBe(true)
  })

  it('onboarding:key never returns the value, and launch preflight sees its stash', async () => {
    ipc.handlers.clear()
    registerOnboardingHandlers(w.h)
    const reply = await ipc.handlers.get('onboarding:key')!({ sender: {} }, { op: 'check', name: 'FAL_KEY', value: KEY })
    expect(reply.ok).toBe(true)
    expect(JSON.stringify(reply)).not.toContain(KEY)
    expect(reply.data).toMatchObject({ status: 'unknown', last4: KEY.slice(-4) })
  })
})
