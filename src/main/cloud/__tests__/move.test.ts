// docs/CLOUD.md §3 step 5, §7.1, §8: "Run in the cloud…" sends exactly what was ticked and the selected workflows use.
// Asserts the request bodies: passport bundle + PassportSync grant, rewritten workflows, 409 "changed in the cloud"
// with opt-in overwrite, schedules placed in the cloud, repos with the typed token, and secrets never sent unticked
// or unreferenced.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayConnection } from '../../../shared/gateway'
import type { CloudMoveChoices, Schedule, Workflow, WorkflowNode } from '../../../shared/types'
import { CloudLink, type PassportSyncPort } from '../link'
import { bringBack, buildMovePlan, moveCompany, runOnce, type MoveDeps } from '../move'
import { PAIR_CODE, fakeCipher, startFakeCloud, type FakeCloud } from './fakeCloud'

const SECRETS: Record<string, string> = { FAL_KEY: 'fal-SECRET-111', FIRECRAWL_API_KEY: 'fc-SECRET-222', UNUSED_KEY: 'unused-SECRET-333' }
const CONN_CREDS: Record<string, Record<string, string>> = { linear: { Authorization: 'Bearer lin-SECRET-444' }, notion: {} }
const CO = 'co_vibiz'

const node = (p: Partial<WorkflowNode> & { id: string }): WorkflowNode => ({ type: 'shell', label: p.id, after: [], cwd: null, timeoutMin: 5, command: 'ls', ...p }) as WorkflowNode
const wf = (id: string, name: string, nodes: WorkflowNode[], extra: Partial<Workflow> = {}): Workflow => ({ id, name, description: '', inputs: [], nodes, createdAt: '', updatedAt: '', companyId: CO, ...extra })
const sched = (id: string, workflowId: string, p: Partial<Schedule> = {}): Schedule =>
  ({ id, name: id, target: { kind: 'workflow', workflowId, inputs: { day: 'mon' } }, when: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' }, preset: null, enabled: true, sentence: 'Weekdays at 9:00', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: null, createdAt: '', updatedAt: '', companyId: CO, ...p }) as Schedule

const WORKFLOWS = [
  wf('wf_brief', 'Morning brief', [node({ id: 'a', type: 'agent', profileId: 'p_codex', prompt: 'Use FAL_KEY for images', cwd: '/Users/l/code/quest/app' } as Partial<WorkflowNode> & { id: string })]),
  wf('wf_crawl', 'Crawl', [node({ id: 's', command: 'crawl --key $FIRECRAWL_API_KEY', cwd: 'repo_quest' } as Partial<WorkflowNode> & { id: string })]),
  wf('wf_sweep', 'Bug sweep', [node({ id: 'a', type: 'agent', profileId: 'p_claude', prompt: 'fix', isolate: 'worktree' } as Partial<WorkflowNode> & { id: string })], { worktree: { repo: 'repo_quest' } })
]
const CONNECTIONS: GatewayConnection[] = [
  { id: 'linear', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app', enabled: true, roots: [], companyIds: [CO], hasCredentials: true },
  { id: 'notion', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com', enabled: true, roots: [], companyIds: [CO], authentication: 'oauth', hasCredentials: false },
  { id: 'other', name: 'Other co', transport: 'http', url: 'https://x', enabled: true, roots: [], companyIds: ['co_other'], hasCredentials: true }
]

let cloud: FakeCloud
let dir: string
let link: CloudLink
let deps: MoveDeps
let passport: PassportSyncPort & { configure: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn> }
let keyReads: string[][]
let credReads: string[]

beforeEach(async () => {
  cloud = await startFakeCloud()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-move-'))
  link = new CloudLink({ userData: dir, cipher: fakeCipher(), emit: () => {}, sse: false })
  await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
  await link.pollNow()
  keyReads = []
  credReads = []
  passport = { configure: vi.fn(), sync: vi.fn(async () => ({ sync: { revision: 2 } })), configured: () => true, clear: vi.fn() } as never
  deps = {
    link,
    company: () => ({ id: CO, name: 'Vibiz Quest', slug: 'vibiz-quest', color: '#6e8cff' }),
    repos: () => [{ id: 'repo_quest', name: 'quest', path: '/Users/l/code/quest' }, { id: 'repo_local', name: 'notes', path: '/Users/l/notes' }],
    workflows: () => WORKFLOWS,
    schedules: () => [sched('s_brief', 'wf_brief'), sched('s_sweep', 'wf_sweep'), sched('s_prompt', 'x', { target: { kind: 'prompt', prompt: 'hi', profileId: 'p', repoId: null } as never })],
    profiles: () => [{ id: 'p_codex', adapter: 'codex', secretNames: ['*'] }, { id: 'p_claude', adapter: 'claude', secretNames: ['*'] }],
    keyNames: () => Object.keys(SECRETS),
    keyValues: (_c, names) => {
      keyReads.push(names)
      return Object.fromEntries(names.map((n) => [n, SECRETS[n]]))
    },
    connections: () => CONNECTIONS,
    connectionCredentials: (id) => {
      credReads.push(id)
      return CONN_CREDS[id]
    },
    passportBundle: () => new Uint8Array([0x50, 0x4b, 3, 4]),
    passport,
    gitRemote: async (p) => (p.endsWith('quest') ? 'git@github.com:vibiz-ai/quest.git' : null)
  }
})
afterEach(async () => {
  link.stop()
  await cloud.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const choices = (p: Partial<CloudMoveChoices> = {}): CloudMoveChoices => ({
  companyId: CO,
  workflows: ['wf_brief', 'wf_crawl'],
  schedules: ['s_brief'],
  repos: [{ id: 'repo_quest', token: 'github_pat_SECRET_555' }],
  keys: ['FAL_KEY', 'FIRECRAWL_API_KEY'],
  connections: ['linear'],
  ...p
})
const sent = () => cloud.requests.filter((r) => r.method !== 'GET')

describe('buildMovePlan', () => {
  it('lists what can move with plain reasons, and needs only what the workflows use', async () => {
    const plan = await buildMovePlan(deps, CO)
    expect(plan.workflows.map((w) => [w.id, w.ok])).toEqual([['wf_brief', true], ['wf_crawl', true], ['wf_sweep', false]])
    expect(plan.workflows[2].reason).toBe('Bug sweep runs in a worktree on this Mac. Worktrees are not in the cloud yet, so it stays local.')
    expect(plan.schedules.find((s) => s.id === 's_sweep')).toMatchObject({ ok: false, reason: 'It runs Bug sweep, which stays on this Mac.' })
    expect(plan.schedules.find((s) => s.id === 's_prompt')?.ok).toBe(false)
    expect(plan.repos).toEqual([
      expect.objectContaining({ id: 'repo_quest', ok: true, ownerRepo: 'vibiz-ai/quest', url: 'https://github.com/vibiz-ai/quest', tokenUrl: 'https://github.com/settings/personal-access-tokens/new' }),
      expect.objectContaining({ id: 'repo_local', ok: false, reason: 'notes has no origin remote, so the cloud cannot clone it.' })
    ])
    expect(plan.needs.keys).toEqual([{ name: 'FAL_KEY', usedBy: ['wf_brief'] }, { name: 'FIRECRAWL_API_KEY', usedBy: ['wf_crawl'] }])
    expect(plan.needs.keys.map((k) => k.name)).not.toContain('UNUSED_KEY')
    expect(plan.needs.connections.map((c) => c.id)).toEqual(['linear'])
    expect(plan.oauth.map((c) => c.id)).toEqual(['notion'])
    expect(JSON.stringify(plan)).not.toMatch(/SECRET/)
    expect(keyReads).toEqual([])
    expect(credReads).toEqual([])
  })
})

describe('the Passport vault on a fresh profile (CLOUD.md §7.1)', () => {
  it('the plan says the vault is off before Run in the cloud, and the move sends nothing', async () => {
    deps.passportReady = () => false
    const plan = await buildMovePlan(deps, CO)
    expect(plan.passport).toEqual({ ready: false, reason: "Your cloud agents read this company's Passport, and the Passport vault is off on this Mac. Turn it on first." })
    const bundle = vi.fn(() => new Uint8Array([1]))
    deps.passportBundle = bundle
    const before = sent().length
    const r = await moveCompany(deps, choices())
    expect(r).toEqual({ items: [{ kind: 'passport', id: CO, name: 'Passport', status: 'failed', message: plan.passport!.reason }], company: null })
    expect(sent().slice(before)).toEqual([])
    expect(bundle).not.toHaveBeenCalled()
    expect(keyReads).toEqual([])
  })

  it('with the vault on (one click in the checklist) the same move goes through; a company already in the cloud never needs it', async () => {
    let on = false
    deps.passportReady = () => on
    expect((await buildMovePlan(deps, CO)).passport?.ready).toBe(false)
    on = true
    expect((await buildMovePlan(deps, CO)).passport).toEqual({ ready: true, reason: null })
    const r = await moveCompany(deps, choices())
    expect(r.items.filter((i) => i.status !== 'done')).toEqual([])
    on = false
    expect((await buildMovePlan(deps, CO)).passport).toEqual({ ready: true, reason: null })
  })
})

describe('moveCompany', () => {
  it('declares every key a workflow uses, ticked or not, so readiness can flag the ones left behind', async () => {
    await moveCompany(deps, choices({ keys: [] }))
    const body = (wid: string) => sent().find((q) => q.path === `/v1/companies/${CO}/workflows/${wid}`)!.body as { keys?: string[] }
    expect(body('wf_brief').keys).toEqual(['FAL_KEY'])
    expect(body('wf_crawl').keys).toEqual(['FIRECRAWL_API_KEY'])
    expect([...cloud.secrets.keys()]).toEqual([])
    // names only: no value is read or sent for an unticked key
    expect(keyReads).toEqual([])
    expect(cloud.requests.map((r) => r.raw).join('\n')).not.toMatch(/SECRET-111|SECRET-222/)
  })

  it('sends the passport bundle, configures PassportSync with the grant, and sends exactly the ticked items', async () => {
    const r = await moveCompany(deps, choices())
    expect(r.items.filter((i) => i.status !== 'done')).toEqual([])
    const put = sent().find((q) => q.method === 'PUT' && q.path === `/v1/companies/${CO}`)!
    expect(put.body).toEqual({ name: 'Vibiz Quest', slug: 'vibiz-quest', color: '#6e8cff', passportBundle: Buffer.from([0x50, 0x4b, 3, 4]).toString('base64') })
    expect(passport.configure).toHaveBeenCalledWith(CO, { url: 'http://127.0.0.1:8788', passportId: `pp_${CO}`, token: 'opk_desktop_grant_secret' })
    expect(passport.sync).toHaveBeenCalledWith(CO)
    expect(link.isCloudCompany(CO)).toBe(true)

    // workflows rewritten for the cloud
    const brief = cloud.workflows.get('wf_brief')!.file as { workflow: { nodes: { cwd: string; profileId: string }[] } }
    expect(brief.workflow.nodes[0]).toMatchObject({ cwd: 'quest/app', profileId: 'prof_codex' })
    expect(cloud.workflows.has('wf_sweep')).toBe(false)
    expect(link.workflowRev('wf_brief')).toBe(1)

    // schedule placed in the cloud: the desktop stops firing it
    const sp = sent().find((q) => q.path === `/v1/companies/${CO}/schedules/s_brief`)!
    expect(sp.body).toMatchObject({ placement: 'cloud', baseRev: null, schedule: { name: 's_brief', target: { kind: 'workflow', workflowId: 'wf_brief', inputs: { day: 'mon' } }, enabled: true } })
    expect(link.ownsSchedule('s_brief')).toBe(true)

    // repo with the token typed in the checklist
    expect(cloud.repos.get('repo_quest')).toEqual({ name: 'quest', url: 'https://github.com/vibiz-ai/quest', branch: null, credential: { kind: 'github_pat', value: 'github_pat_SECRET_555' } })

    // ticked keys and connections only
    expect([...cloud.secrets.keys()].sort()).toEqual(['FAL_KEY', 'FIRECRAWL_API_KEY'])
    expect(cloud.connections.get('linear')).toMatchObject({ authentication: 'headers', credentials: { Authorization: 'Bearer lin-SECRET-444' } })
    // OAuth: created without credentials, authorized in the cloud later
    expect(cloud.connections.get('notion')).toMatchObject({ authentication: 'oauth' })
    expect(cloud.connections.get('notion')).not.toHaveProperty('credentials')
    expect(cloud.connections.has('other')).toBe(false)
    expect(r.company?.readiness).toEqual({ ready: true, fixes: [] })
  })

  it('never reads or sends an unticked secret', async () => {
    await moveCompany(deps, choices({ keys: ['FAL_KEY'], connections: [] }))
    expect(keyReads).toEqual([['FAL_KEY']])
    expect(credReads).toEqual([])
    const all = cloud.requests.map((r) => r.raw).join('\n')
    expect(all).toContain('fal-SECRET-111')
    expect(all).not.toContain('fc-SECRET-222')
    expect(all).not.toContain('lin-SECRET-444')
    expect(all).not.toContain('unused-SECRET-333')
  })

  it('never sends a secret the selected workflows do not reference, even when the renderer ticks it', async () => {
    await moveCompany(deps, choices({ workflows: ['wf_brief'], keys: ['FAL_KEY', 'FIRECRAWL_API_KEY', 'UNUSED_KEY'], connections: ['linear', 'other'] }))
    expect([...cloud.secrets.keys()]).toEqual(['FAL_KEY'])
    expect(keyReads).toEqual([['FAL_KEY']])
    expect(cloud.connections.has('other')).toBe(false)
    const all = cloud.requests.map((r) => r.raw).join('\n')
    expect(all).not.toContain('unused-SECRET-333')
    expect(all).not.toContain('fc-SECRET-222')
  })

  it('a refused workflow or schedule is never sent, even when ticked', async () => {
    await moveCompany(deps, choices({ workflows: ['wf_brief', 'wf_sweep'], schedules: ['s_brief', 's_sweep', 's_prompt'] }))
    expect(cloud.workflows.has('wf_sweep')).toBe(false)
    expect(cloud.schedules.has('s_sweep')).toBe(false)
    expect(cloud.schedules.has('s_prompt')).toBe(false)
  })

  it('a workflow changed in the cloud is a conflict, then overwritten only when the user says so', async () => {
    await moveCompany(deps, choices({ workflows: ['wf_brief'], schedules: [], keys: [], connections: [], repos: [] }))
    // someone else moved the cloud rev on
    cloud.workflows.get('wf_brief')!.rev = 5
    const r1 = await moveCompany(deps, choices({ workflows: ['wf_brief'], schedules: [], keys: [], connections: [], repos: [] }))
    expect(r1.items.find((i) => i.kind === 'workflow')).toMatchObject({ status: 'conflict', message: 'Changed in the cloud since this Mac sent it.' })
    expect(cloud.workflows.get('wf_brief')!.rev).toBe(5)
    const r2 = await moveCompany(deps, choices({ workflows: ['wf_brief'], schedules: [], keys: [], connections: [], repos: [], overwrite: ['wf_brief'] }))
    expect(r2.items.find((i) => i.kind === 'workflow')?.status).toBe('done')
    expect(cloud.workflows.get('wf_brief')!.rev).toBe(6)
    expect(link.workflowRev('wf_brief')).toBe(6)
    // the second PUT of the overwrite carried the server's rev
    const puts = sent().filter((q) => q.path === `/v1/companies/${CO}/workflows/wf_brief`)
    expect((puts.at(-1)!.body as { baseRev: number }).baseRev).toBe(5)
  })

  it('a second move does not resend the bundle; unticking a cloud schedule brings it back to this Mac', async () => {
    await moveCompany(deps, choices())
    await moveCompany(deps, choices({ schedules: [] }))
    const puts = sent().filter((q) => q.method === 'PUT' && q.path === `/v1/companies/${CO}`)
    expect((puts[1].body as Record<string, unknown>).passportBundle).toBeUndefined()
    expect(cloud.schedules.get('s_brief')?.placement).toBe('local')
    expect(link.ownsSchedule('s_brief')).toBe(false)
  })

  it('stops at the company when the create fails, and sends nothing else', async () => {
    deps.passportBundle = () => new Uint8Array()
    const r = await moveCompany(deps, choices())
    expect(r.company).toBeNull()
    expect(r.items).toEqual([expect.objectContaining({ kind: 'company', status: 'failed' })])
    expect(cloud.secrets.size + cloud.workflows.size + cloud.repos.size).toBe(0)
  })
})

describe('moveCompany: hostile ticks, offline, logs (QA)', () => {
  it('a repo token for a repo that is not GitHub, or not this company, is never sent', async () => {
    await moveCompany(deps, choices({ repos: [{ id: 'repo_local', token: 'github_pat_LOCAL_SECRET' }, { id: 'repo_foreign', token: 'github_pat_FOREIGN_SECRET' }] }))
    expect(cloud.repos.size).toBe(0)
    const all = cloud.requests.map((r) => r.raw).join('\n')
    expect(all).not.toContain('LOCAL_SECRET')
    expect(all).not.toContain('FOREIGN_SECRET')
  })

  it('an offline cloud fails at the company, reads no secret, and the link goes offline', async () => {
    await cloud.close()
    const r = await moveCompany(deps, choices())
    expect(r.items).toEqual([expect.objectContaining({ kind: 'company', status: 'failed', message: expect.stringMatching(/Can't reach your cloud/) })])
    expect(keyReads).toEqual([])
    expect(credReads).toEqual([])
    expect(link.state()).toMatchObject({ online: false, offlineSince: expect.any(String) })
    cloud = await startFakeCloud() // afterEach closes it
  })

  it('nothing it logs or returns carries a key, a connection credential or a repo token', async () => {
    const lines: string[] = []
    const log = { info: (m: string, meta?: Record<string, unknown>) => void lines.push(m, JSON.stringify(meta ?? {})), warn: (m: string, meta?: Record<string, unknown>) => void lines.push(m, JSON.stringify(meta ?? {})) }
    const r = await moveCompany({ ...deps, log }, choices())
    expect(cloud.secrets.size).toBeGreaterThan(0)
    const out = `${lines.join('\n')}\n${JSON.stringify(r)}`
    for (const secret of ['SECRET-111', 'SECRET-222', 'lin-SECRET-444', 'github_pat_SECRET_555']) expect(out).not.toContain(secret)
  })

  it('moving twice is idempotent: same cloud state, no duplicate schedules, the bundle sent once', async () => {
    await moveCompany(deps, choices())
    const before = { wf: [...cloud.workflows.keys()].sort(), s: [...cloud.schedules.keys()].sort(), k: [...cloud.secrets.keys()].sort() }
    const second = await moveCompany(deps, choices())
    expect(second.items.filter((i) => i.status === 'failed' || i.status === 'conflict')).toEqual([])
    expect({ wf: [...cloud.workflows.keys()].sort(), s: [...cloud.schedules.keys()].sort(), k: [...cloud.secrets.keys()].sort() }).toEqual(before)
    expect(cloud.requests.filter((r) => r.raw.includes('passportBundle')).length).toBe(1)
    expect(link.state().cloudScheduleIds).toEqual(['s_brief'])
  })
})

describe('runOnce and bringBack', () => {
  it('Run once now starts the first runnable cloud workflow with the desktop trigger', async () => {
    await moveCompany(deps, choices())
    const run = await runOnce(deps, CO)
    expect(run.status).toBe('queued')
    expect(sent().at(-1)).toMatchObject({ path: `/v1/companies/${CO}/runs`, body: { kind: 'workflow', workflowId: 'wf_brief' } })
  })
  it('Bring back: schedules placed local, company deleted, link and PassportSync forget it', async () => {
    await moveCompany(deps, choices())
    await bringBack(deps, CO)
    expect(cloud.schedules.get('s_brief')?.placement).toBe('local')
    expect(cloud.companies.has(CO)).toBe(false)
    expect(link.isCloudCompany(CO)).toBe(false)
    expect(link.ownsSchedule('s_brief')).toBe(false)
    expect(passport.clear).toHaveBeenCalledWith(CO, `pp_${CO}`)
  })
})
