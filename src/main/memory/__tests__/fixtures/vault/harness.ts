// A real main for vault-mode tests: MemoryService with `experimental.vault` on, three companies (Northwind seeded from
// the fixture vault, Globex, Personal), the spool bridge, and hivemem handlers built in-process from a grant's env.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CompanyPassport } from '../../../../../shared/company'
import type { MemoryGrant, MemoryGrantRequest } from '../../../../../shared/engine'
import type { Repo } from '../../../../../shared/types'
import { buildHandlers, type BuiltHandlers } from '../../../server/build'
import type { ToolResult } from '../../../server/tools'
import { MemoryService, type MemoryCompanies, type PassportRuntime } from '../../../service'
import { copyFixtureVault, LABELS } from './fixture'

export const NW = LABELS.company.id
export const GX = 'co_globex'
export const PERSONAL = 'co_personal'
export const NW_WEB: Repo = { id: 'repo_nwweb00001', name: 'northwind-web', path: '/work/northwind-web' } as Repo
export const NW_BILLING: Repo = { id: 'repo_nwbill0001', name: 'billing-worker', path: '/work/billing-worker' } as Repo
export const GX_APP: Repo = { id: 'repo_gxapp00001', name: 'globex-app', path: '/work/globex-app' } as Repo
const REPOS = [NW_WEB, NW_BILLING, GX_APP]

function passport(id: string, name: string, extra: Partial<CompanyPassport> = {}): CompanyPassport {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    color: '#888',
    sortOrder: 0,
    mission: '',
    brandVoice: '',
    audience: '',
    products: '',
    goals: '',
    context: '',
    constraints: '',
    repoIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    system: null,
    vaultPath: null,
    ...extra
  }
}

export interface FakeCompanies extends MemoryCompanies {
  vaultPathFor(id: string): string
  renderer: ((c: CompanyPassport) => string | null) | null
}

function fakeCompanies(dir: string): FakeCompanies {
  const list = [
    passport(NW, 'Northwind', { repoIds: [NW_WEB.id, NW_BILLING.id] }),
    passport(GX, 'Globex', { repoIds: [GX_APP.id] }),
    passport(PERSONAL, 'Personal', { system: 'personal' })
  ]
  const get = (id: string) => {
    const c = list.find((x) => x.id === id)
    if (!c) throw new Error('Company not found')
    return c
  }
  const owner = (repoId: string) => get(list.find((c) => c.repoIds.includes(repoId))?.id ?? PERSONAL)
  const fake = {
    renderer: null as FakeCompanies['renderer'],
    store: { getSettings: () => ({ experimental: { vault: true } }) },
    listPassports: () => list,
    passport: get,
    resolveCompany: (q: { cwd?: string | null }) => {
      const repo = REPOS.find((r) => q.cwd?.startsWith(r.path))
      return { company: repo ? owner(repo.id) : get(PERSONAL), repo: null }
    },
    companyForRepo: owner,
    vaultPathFor: (id: string) => path.join(dir, 'companies', get(id).slug, 'Passport'),
    setPassportRenderer: (fn: FakeCompanies['renderer']) => {
      fake.renderer = fn
    },
    setMemoryCounter: () => {},
    update: (id: string) => get(id)
  }
  return fake as unknown as FakeCompanies
}

export interface Harness {
  dir: string
  svc: MemoryService
  rt: PassportRuntime
  companies: FakeCompanies
  events: unknown[]
  root(companyId: string): string
  read(companyId: string, rel: string): string
  /** every note path under a vault (vault-relative, `.principia` excluded) */
  files(companyId: string): string[]
  grant(companyId: string, over?: Partial<MemoryGrantRequest>): MemoryGrant
  server(g: MemoryGrant, env?: Record<string, string>): BuiltHandlers
  call(b: BuiltHandlers, name: string, args: unknown): Promise<ToolResult>
  close(): void
}

let callSeq = 0

export function makeHarness(opts: { secrets?: { name: string; value: string }[]; now?: () => Date } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-p8-'))
  const companies = fakeCompanies(dir)
  // Northwind's vault is the fixture; it exists before the runtime first opens it, like an adopted Obsidian vault
  copyFixtureVault((fs.mkdirSync(companies.vaultPathFor(NW), { recursive: true }), companies.vaultPathFor(NW)))
  const secrets = opts.secrets ?? []
  const events: unknown[] = []
  const svc = new MemoryService({
    userData: dir,
    serverScript: '/app/out/main/mcp-memory.js',
    execPath: '/app/Principia',
    listRepos: () => REPOS,
    redact: (s) => secrets.reduce((t, x) => t.split(x.value).join(`••••${x.name}`), s),
    secretValues: () => secrets,
    emit: (e) => events.push(e),
    log: { info: () => {}, warn: () => {} },
    watchVaults: false,
    ...(opts.now ? { now: opts.now } : {})
  })
  svc.start({ poll: false })
  svc.setCompanies(companies)
  const rt = svc.passport()
  rt.ensure(NW)
  rt.reindex(NW)
  const built: BuiltHandlers[] = []
  const root = (companyId: string) => rt.index.root(companyId)
  const files = (companyId: string): string[] => {
    const out: string[] = []
    const visit = (abs: string, rel: string) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) visit(path.join(abs, e.name), r)
        else if (e.name.endsWith('.md')) out.push(r)
      }
    }
    visit(root(companyId), '')
    return out.sort()
  }
  return {
    dir,
    svc,
    rt,
    companies,
    events,
    root,
    read: (companyId, rel) => fs.readFileSync(path.join(root(companyId), ...rel.split('/')), 'utf8'),
    files,
    grant: (companyId, over = {}) =>
      svc.grant({
        mode: 'read-write',
        adapter: 'claude',
        transport: 'mcp',
        profile: null,
        cwd: companyId === NW ? `${NW_WEB.path}/src` : companyId === GX ? GX_APP.path : '/tmp/scratch',
        companyId,
        runId: 'run_p8test0001',
        briefQuery: '',
        ...over
      })!,
    server: (g, env = {}) => {
      const b = buildHandlers({ ...g.server.env, ...env }, { spool: { timeoutMs: 5000 } })
      built.push(b)
      return b
    },
    call: async (b, name, args) => {
      const id = ++callSeq
      return b.handlers.callTool(name, args, { requestId: id, meta: { 'claudecode/toolUseId': `toolu_p8_${id}` }, signal: new AbortController().signal })
    },
    close: () => {
      for (const b of built) b.close()
      svc.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const toolText = (r: ToolResult): string => r.content[0].text
export const toolJson = <T = Record<string, unknown>>(r: ToolResult): T => JSON.parse(toolText(r)) as T
