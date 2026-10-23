// PASSPORT.md §9: memory.db v1 and the Passport profiles into the company vaults. A v1 fixture db covers pinned,
// invalid, superseded, pending (contested and quarantined) and global facts, relations, aliases, events and an entity
// name with `/`; the profiles cover hub observations, product ghosts and repo notes. memory.db stays byte-identical,
// a dry run writes nothing, a re-run writes nothing, and v1 lines added later are appended with their ids.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompanyPassport } from '../../../../../shared/company'
import type { Repo } from '../../../../../shared/types'
import { openMemoryDb } from '../../../db'
import { MemoryService, type MemoryCompanies, type PassportRuntime } from '../../../service'
import { nativeOk } from '../../__tests__/vaultTestKit'
import { readLog } from '../../log'
import { createMigrator, productNames, runMigration, type MigrationDeps, type MigrationFile } from '../index'

const d = nativeOk ? describe : describe.skip
const A = 'co_acme'
const P = 'co_personal'
const REPO_A: Repo = { id: 'repo_a000000001', name: 'acme-web', path: '/work/acme-web' } as Repo
const REPO_B: Repo = { id: 'repo_b000000002', name: 'side-project', path: '/work/side-project' } as Repo

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

function fakeCompanies(dir: string, vault: { on: boolean }): MemoryCompanies {
  const list = [
    passport(A, 'Acme', {
      mission: 'Make billing boring',
      brandVoice: 'Plain and calm',
      audience: 'Finance teams at startups',
      products: 'Ledger, Invoicer - the invoicing app\n- Payouts: instant payouts',
      goals: '',
      constraints: 'No dark patterns',
      repoIds: [REPO_A.id]
    }),
    passport(P, 'Personal', { system: 'personal', repoIds: [REPO_B.id] })
  ]
  const get = (id: string) => {
    const c = list.find((x) => x.id === id)
    if (!c) throw new Error('Company not found')
    return c
  }
  return {
    store: { getSettings: () => ({ experimental: { vault: vault.on } }) },
    listPassports: () => list,
    passport: get,
    resolveCompany: () => ({ company: get(P), repo: null }),
    companyForRepo: (repoId: string) => (repoId === REPO_A.id ? get(A) : get(P)),
    vaultPathFor: (id: string) => path.join(dir, 'companies', get(id).slug, 'Passport'),
    setPassportRenderer: () => {},
    setMemoryCounter: () => {},
    update: (id: string) => get(id)
  } as unknown as MemoryCompanies
}

// ---------- the v1 fixture ----------

const T = (day: number, h = 10) => `2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`

function buildV1(file: string): void {
  const db = openMemoryDb(file, { migrate: true })
  const grant = db.prepare(
    `INSERT INTO mem_grant (id, mode, adapter, transport, repo_id, repo_name, run_id, session_id, created_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  grant.run('mgr_claude0001', 'read-write', 'claude', 'mcp', REPO_A.id, REPO_A.name, 'run_42', null, T(1), T(1, 11))
  grant.run('mgr_codex00002', 'read-write', 'codex', 'inject', REPO_A.id, REPO_A.name, null, 'ses_7', T(2), T(2, 11))
  const entity = db.prepare(`INSERT INTO mem_entity (id, repo_id, name, norm_name, type, summary, actor, grant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  entity.run('ment_e1aaaaaaaa', REPO_A.id, 'scripts/sync-migration.sh', 'scripts/sync-migration.sh', 'file', 'Syncs the schema to prod', 'agent', 'mgr_claude0001', T(1), T(3))
  entity.run('ment_e2bbbbbbbb', REPO_A.id, 'Billing', 'billing', 'concept', '', 'user', null, T(1), T(2))
  entity.run('ment_e3cccccccc', REPO_B.id, 'Notes app', 'notes app', 'component', '', 'user', null, T(2), T(2))
  entity.run('ment_e4dddddddd', null, 'Writing style', 'writing style', 'concept', '', 'user', null, T(2), T(2))
  db.prepare('INSERT INTO mem_alias (entity_id, alias, norm_alias) VALUES (?,?,?)').run('ment_e2bbbbbbbb', 'billing service', 'billing service')
  const fact = db.prepare(
    `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, reviewed, pinned, invalidated_at, invalid_reason, superseded_by,
       actor, grant_id, created_at, updated_at) VALUES (@id,@e,@text,@id,@kind,@scope,@repo,@status,0,@pinned,@inv_at,@reason,@by,@actor,@grant,@at,@at)`
  )
  const f = (o: Record<string, unknown>) =>
    fact.run({ kind: 'fact', scope: 'project', repo: REPO_A.id, status: 'active', pinned: 0, inv_at: null, reason: null, by: null, actor: 'agent', grant: 'mgr_claude0001', at: T(1), ...o })
  f({ id: 'mfa_f1aaaaaaaa', e: 'ment_e1aaaaaaaa', text: 'Run it with --dry-run first', kind: 'gotcha', pinned: 1, at: T(3) })
  f({ id: 'mfa_f2aaaaaaaa', e: 'ment_e1aaaaaaaa', text: 'Owned by the platform team', actor: 'user', grant: null, at: T(1) })
  f({ id: 'mfa_f3aaaaaaaa', e: 'ment_e1aaaaaaaa', text: 'Run it without flags', status: 'invalid', reason: 'superseded', by: 'mfa_f1aaaaaaaa', inv_at: T(3), at: T(1, 9) })
  f({ id: 'mfa_f4aaaaaaaa', e: 'ment_e1aaaaaaaa', text: 'Lives in tools/', status: 'invalid', reason: 'moved to scripts/', inv_at: T(2), grant: 'mgr_codex00002', at: T(1, 8) })
  f({ id: 'mfa_f5aaaaaaaa', e: 'ment_e1aaaaaaaa', text: 'Owned by the data team', status: 'pending', reason: 'contested: supersedes mfa_f2aaaaaaaa', at: T(4) })
  f({ id: 'mfa_f6bbbbbbbb', e: 'ment_e2bbbbbbbb', text: 'Invoices are immutable once sent', kind: 'decision', grant: 'mgr_codex00002', at: T(2) })
  f({ id: 'mfa_f7bbbbbbbb', e: 'ment_e2bbbbbbbb', text: 'Always email the CFO', status: 'pending', reason: 'quarantined: imperative', at: T(4) })
  f({ id: 'mfa_f8cccccccc', e: 'ment_e3cccccccc', text: 'Uses SQLite', repo: REPO_B.id, actor: 'user', grant: null, at: T(2) })
  f({ id: 'mfa_f9dddddddd', e: 'ment_e4dddddddd', text: 'Prefers short sentences', scope: 'global', repo: null, actor: 'user', grant: null, at: T(2) })
  f({ id: 'mfa_f0bbbbbbbb', e: 'ment_e2bbbbbbbb', text: 'Stripe is the processor everywhere', scope: 'global', repo: null, at: T(3) })
  const rel = db.prepare(
    `INSERT INTO mem_relation (id, from_id, to_id, type, norm_type, scope, repo_id, status, invalidated_at, invalid_reason, actor, grant_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  rel.run('mrel_r1aaaaaaaa', 'ment_e1aaaaaaaa', 'ment_e2bbbbbbbb', 'depends_on', 'depends_on', 'project', REPO_A.id, 'active', null, null, 'agent', 'mgr_claude0001', T(3), T(3))
  rel.run('mrel_r2bbbbbbbb', 'ment_e2bbbbbbbb', 'ment_e1aaaaaaaa', 'mentions', 'mentions', 'project', REPO_A.id, 'invalid', T(3), 'not true', 'user', null, T(2), T(3))
  const ev = db.prepare(`INSERT INTO mem_event (ts, op, target_kind, target_id, entity_id, actor, grant_id, run_id, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  ev.run(T(1), 'create', 'entity', 'ment_e1aaaaaaaa', 'ment_e1aaaaaaaa', 'agent', 'mgr_claude0001', 'run_42', null, '{"name":"scripts/sync-migration.sh"}')
  ev.run(T(3), 'create', 'fact', 'mfa_f1aaaaaaaa', 'ment_e1aaaaaaaa', 'agent', 'mgr_claude0001', 'run_42', null, '{"text":"Run it with --dry-run first"}')
  ev.run(T(3), 'invalidate', 'fact', 'mfa_f3aaaaaaaa', 'ment_e1aaaaaaaa', 'agent', 'mgr_claude0001', 'run_42', '{"status":"active"}', '{"status":"invalid"}')
  ev.run(T(2), 'invalidate', 'fact', 'mfa_f4aaaaaaaa', 'ment_e1aaaaaaaa', 'user', null, null, null, null)
  ev.run(T(2), 'create', 'fact', 'mfa_f8cccccccc', 'ment_e3cccccccc', 'user', null, null, null, null)
  ev.run(T(4), 'pause', 'memory', 'memory', null, 'user', null, null, null, '{"paused":true}')
  db.close()
}

// ---------- harness ----------

let dir: string
let dbFile: string
let svc: MemoryService
let rt: PassportRuntime
let companies: MemoryCompanies
const vault = { on: false }
const NOW = new Date('2026-10-20T12:00:00.000Z')

function deps(extra: Partial<MigrationDeps> = {}): MigrationDeps {
  return { userData: dir, memoryDbPath: dbFile, companies, listRepos: () => [REPO_A, REPO_B], runtime: () => svc.passport(), now: () => NOW, ...extra }
}
const root = (id: string) => companies.vaultPathFor(id)
const read = (id: string, rel: string) => fs.readFileSync(path.join(root(id), ...rel.split('/')), 'utf8')
const exists = (id: string, rel: string) => fs.existsSync(path.join(root(id), ...rel.split('/')))
const hashFile = (f: string) => (fs.existsSync(f) ? createHash('sha1').update(fs.readFileSync(f)).digest('hex') : null)

/** Every file under the company folders with its hash (vault content, .principia included). */
function snapshotTree(base = path.join(dir, 'companies')): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name !== 'writer.lock') out[path.relative(base, abs)] = hashFile(abs)!
    }
  }
  walk(base)
  return out
}

beforeEach(() => {
  if (!nativeOk) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-migrate-'))
  fs.mkdirSync(path.join(dir, 'v1'))
  dbFile = path.join(dir, 'v1', 'memory.db')
  buildV1(dbFile)
  vault.on = false
  svc = new MemoryService({
    userData: dir,
    serverScript: '/app/out/main/mcp-memory.js',
    execPath: '/app/Hive',
    listRepos: () => [REPO_A, REPO_B],
    redact: (s) => s,
    secretValues: () => [],
    emit: () => {},
    log: { info: () => {}, warn: () => {} },
    watchVaults: false
  })
  svc.start({ poll: false })
  companies = fakeCompanies(dir, vault)
  svc.setCompanies(companies)
  rt = svc.passport()
})
afterEach(() => {
  if (!nativeOk) return
  svc.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- tests ----------

describe('productNames', () => {
  it('splits lines, bullets and comma lists and drops descriptions and prose', () => {
    expect(productNames('Ledger, Invoicer - the invoicing app\n- Payouts: instant payouts')).toEqual(['Ledger', 'Invoicer', 'Payouts'])
    expect(productNames('1. [[Pro Plan|Pro]] (monthly)\n* Starter; Teams')).toEqual(['Pro Plan', 'Starter', 'Teams'])
    expect(productNames('We sell a desktop app for agents that run your company')).toEqual([])
    expect(productNames('Ledger\nledger')).toEqual(['Ledger'])
    expect(productNames('')).toEqual([])
  })
})

d('dry run (§9)', () => {
  it('reports what would be written and writes nothing: no vault, no backup, memory.db untouched', async () => {
    const before = hashFile(dbFile)
    const r = await runMigration(deps(), { dryRun: true })
    expect(r).toMatchObject({ dryRun: true, alreadyMigrated: false, backupPath: null })
    expect(r.totals).toEqual({ entityNotes: 5, observations: 6, historyLines: 3, proposals: 4, events: 6 })
    expect(r.companies.find((c) => c.companyId === A)).toMatchObject({ hubNote: true, repoNotes: 1, entityNotes: 2, observations: 3, historyLines: 3, proposals: 2 })
    expect(r.companies.find((c) => c.companyId === P)).toMatchObject({ hubNote: true, repoNotes: 1, entityNotes: 3, observations: 3, historyLines: 0, proposals: 2 })
    expect(fs.existsSync(path.join(dir, 'companies'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'v1', 'Hive-backups'))).toBe(false)
    expect((rt.db.prepare('SELECT count(*) AS n FROM mem_event').get() as { n: number }).n).toBe(0)
    expect(hashFile(dbFile)).toBe(before)
  })
})

d('migration (§9)', () => {
  it('runs behind memory:vault migrate with the flag off and leaves memory.db byte-identical with a backup', async () => {
    svc.setMigrator(createMigrator(deps()))
    const before = hashFile(dbFile)
    const r = (await svc.migrate({ dryRun: false }))!
    expect(r.warnings).toEqual([])
    expect(r.totals).toEqual({ entityNotes: 5, observations: 6, historyLines: 3, proposals: 4, events: 6 })
    expect(hashFile(dbFile)).toBe(before)
    expect(r.backupPath).toMatch(/Hive-backups\/memory\.v1\.2026-10-20T12-00-00-000Z\.db$/)
    const copy = new Database(r.backupPath!, { readonly: true })
    expect((copy.prepare('SELECT count(*) AS n FROM mem_fact').get() as { n: number }).n).toBe(10)
    copy.close()
  })

  it('writes entity notes with v1 ids, History lines, #pin, aliases and repo links', async () => {
    await runMigration(deps(), { dryRun: false })
    const sync = read(A, 'Files/scripts-sync-migration.sh.md')
    expect(sync).toContain('id: n-e1aaaaaaaa')
    expect(sync).toContain('title: scripts/sync-migration.sh')
    expect(sync).toContain('type: file')
    expect(sync).toContain('repos: ["[[acme-web]]"]')
    expect(sync).toContain('created: 2026-09-01')
    expect(sync).toContain('source: migration')
    expect(sync).toContain('Syncs the schema to prod')
    expect(sync).toContain('- [gotcha] Run it with --dry-run first #pin (claude run#run_42, 2026-09-03) ^f-f1aaaaaaaa')
    expect(sync).toContain('- [fact] Owned by the platform team (user, 2026-09-01) ^f-f2aaaaaaaa')
    expect(sync).toContain('- depends_on [[Billing]] (claude run#run_42, 2026-09-03) ^r-r1aaaaaaaa')
    expect(sync).toContain('- [superseded] Run it without flags (by ^f-f1aaaaaaaa; claude run#run_42, 2026-09-03) ^f-f3aaaaaaaa')
    expect(sync).toContain('- [invalidated] Lives in tools/ (reason: moved to scripts/; user, 2026-09-02) ^f-f4aaaaaaaa')
    expect(sync).not.toContain('data team') // pending: a proposal, not a line
    const billing = read(A, 'Concepts/Billing.md')
    expect(billing).toContain('id: n-e2bbbbbbbb')
    expect(billing).toContain('aliases: [billing service]')
    expect(billing).toContain('- [decision] Invoices are immutable once sent (codex session#ses_7, 2026-09-02) ^f-f6bbbbbbbb')
    expect(billing).toContain('- [invalidated] mentions [[scripts-sync-migration.sh.md]] (reason: not true; user, 2026-09-03) ^r-r2bbbbbbbb')
    expect(billing).not.toContain('Stripe') // global: Personal
    // the unowned repo's entity and the global ones live in Personal
    expect(read(P, 'Components/Notes app.md')).toContain('^f-f8cccccccc')
    expect(read(P, 'Concepts/Writing style.md')).toContain('- [fact] Prefers short sentences (user, 2026-09-02) ^f-f9dddddddd')
    const split = read(P, 'Concepts/Billing.md')
    expect(split).toContain('^f-f0bbbbbbbb')
    expect(split).not.toContain('id: n-e2bbbbbbbb')
    expect(exists(A, 'Concepts/Writing style.md')).toBe(false)
  })

  it('indexes 5 entity notes, 6 active observations and 3 History lines with the v1 ids', async () => {
    await runMigration(deps(), { dryRun: false })
    const q = (sql: string, ...a: unknown[]) => rt.db.prepare(sql).all(...a) as Record<string, unknown>[]
    const notes = q(`SELECT id, company_id FROM mem_note WHERE json_extract(frontmatter_json, '$.source') = 'migration' AND type != 'repo' ORDER BY id`)
    expect(notes.map((n) => n.company_id)).toEqual(expect.arrayContaining([A, A, P, P, P]))
    expect(notes.length).toBe(5)
    expect(notes.map((n) => n.id)).toEqual(expect.arrayContaining(['n-e1aaaaaaaa', 'n-e2bbbbbbbb', 'n-e3cccccccc', 'n-e4dddddddd']))
    const active = q(`SELECT id FROM mem_fact WHERE status = 'active' AND id LIKE 'mfa_%' AND note_id IN (${notes.map(() => '?').join(',')})`, ...notes.map((n) => n.id))
    expect(active.map((r) => r.id).sort()).toEqual(['mfa_f0bbbbbbbb', 'mfa_f1aaaaaaaa', 'mfa_f2aaaaaaaa', 'mfa_f6bbbbbbbb', 'mfa_f8cccccccc', 'mfa_f9dddddddd'])
    expect(q(`SELECT id, status FROM mem_fact WHERE section = 'history' ORDER BY id`)).toEqual([
      { id: 'mfa_f3aaaaaaaa', status: 'superseded' },
      { id: 'mfa_f4aaaaaaaa', status: 'invalid' }
    ])
    expect(q(`SELECT status FROM mem_link WHERE block_id = 'r-r2bbbbbbbb'`)).toEqual([{ status: 'invalid' }])
    expect(q(`SELECT pinned FROM mem_fact WHERE id = 'mfa_f1aaaaaaaa'`)).toEqual([{ pinned: 1 }])
    // the relation resolves to the migrated note, not a ghost
    expect(q(`SELECT to_note FROM mem_link WHERE block_id = 'r-r1aaaaaaaa'`)).toEqual([{ to_note: 'n-e2bbbbbbbb' }])
  })

  it('turns pending facts into proposals and global facts into "assign to company" proposals', async () => {
    await runMigration(deps(), { dryRun: false })
    const rows = rt.db.prepare('SELECT company_id, kind, payload_json, source, fingerprint FROM mem_proposal ORDER BY fingerprint').all() as Record<string, string>[]
    expect(rows.map((r) => [r.company_id, r.kind, r.fingerprint])).toEqual([
      [P, 'assign_company', 'migration:assign:mfa_f0bbbbbbbb'],
      [P, 'assign_company', 'migration:assign:mfa_f9dddddddd'],
      [A, 'fact_supersede', 'migration:mfa_f5aaaaaaaa'],
      [A, 'harvest', 'migration:mfa_f7bbbbbbbb']
    ])
    expect(rows.every((r) => r.source === 'migration')).toBe(true)
    expect(JSON.parse(rows[2].payload_json)).toEqual([{ op: 'supersede', blockId: 'f-f2aaaaaaaa', text: 'Owned by the data team' }])
    expect(JSON.parse(rows[3].payload_json)).toEqual([{ op: 'observe', note: 'n-e2bbbbbbbb', category: 'fact', text: 'Always email the CFO' }])
    // accepting the contested supersede goes through the writer and moves the user's line to History
    const id = (rt.db.prepare("SELECT id FROM mem_proposal WHERE fingerprint = 'migration:mfa_f5aaaaaaaa'").get() as { id: string }).id
    const res = await rt.acceptProposals(A, [id])
    expect(res.accepted).toBe(1)
    expect(read(A, 'Files/scripts-sync-migration.sh.md')).toMatch(/- \[superseded\] Owned by the platform team \(by \^f-[0-9a-z]{10};[^)]*\) \^f-f2aaaaaaaa/)
  })

  it('builds the hub note from the profile with product ghosts, and a repo note per owned repo', async () => {
    await runMigration(deps(), { dryRun: false })
    const hub = read(A, 'Acme.md')
    expect(hub).toContain('Make billing boring')
    expect(hub).toMatch(/- \[mission\] Make billing boring \(migration, 2026-10-20\) \^f-/)
    expect(hub).toMatch(/- \[brand\] Plain and calm/)
    expect(hub).toMatch(/- \[audience\] Finance teams at startups/)
    expect(hub).toMatch(/- \[product\] Ledger, Invoicer - the invoicing app; Payouts: instant payouts \(/)
    expect(hub).toMatch(/- \[constraint\] No dark patterns/)
    expect(hub).not.toContain('[goal]')
    for (const p of ['Ledger', 'Invoicer', 'Payouts']) expect(hub).toMatch(new RegExp(`- sells \\[\\[${p}\\]\\] \\(migration, 2026-10-20\\) \\^r-`))
    const ghosts = rt.db.prepare("SELECT to_text FROM mem_link WHERE company_id = ? AND rel = 'sells' AND to_note IS NULL ORDER BY to_text").all(A) as { to_text: string }[]
    expect(ghosts.map((g) => g.to_text)).toEqual(['Invoicer', 'Ledger', 'Payouts'])
    const repo = read(A, 'Repos/acme-web.md')
    expect(repo).toContain('type: repo')
    expect(repo).toContain(`repo_id: ${REPO_A.id}`)
    expect(repo).toContain('company: "[[Acme]]"')
    expect(repo).toMatch(/- part_of \[\[Acme\]\] \(migration, 2026-10-20\) \^r-/)
    expect(read(P, 'Repos/side-project.md')).toContain('- part_of [[Personal]]')
    expect(rt.index.noteById(A, 'n-e1aaaaaaaa')!.repo_ids_json).toContain(REPO_A.id)
  })

  it('copies mem_event rows into the index and log.jsonl and writes migration.json', async () => {
    await runMigration(deps(), { dryRun: false })
    const evs = rt.db.prepare("SELECT company_id, op, target_kind, target_id, path, block_id, actor, run_id FROM mem_event WHERE op_id LIKE 'v1:%' ORDER BY op_id").all()
    expect(evs).toEqual([
      { company_id: A, op: 'create', target_kind: 'note', target_id: 'n-e1aaaaaaaa', path: 'Files/scripts-sync-migration.sh.md', block_id: null, actor: 'claude', run_id: 'run_42' },
      { company_id: A, op: 'create', target_kind: 'fact', target_id: 'mfa_f1aaaaaaaa', path: 'Files/scripts-sync-migration.sh.md', block_id: 'f-f1aaaaaaaa', actor: 'claude', run_id: 'run_42' },
      { company_id: A, op: 'invalidate', target_kind: 'fact', target_id: 'mfa_f3aaaaaaaa', path: 'Files/scripts-sync-migration.sh.md', block_id: 'f-f3aaaaaaaa', actor: 'claude', run_id: 'run_42' },
      { company_id: A, op: 'invalidate', target_kind: 'fact', target_id: 'mfa_f4aaaaaaaa', path: 'Files/scripts-sync-migration.sh.md', block_id: 'f-f4aaaaaaaa', actor: 'user', run_id: null },
      { company_id: P, op: 'create', target_kind: 'fact', target_id: 'mfa_f8cccccccc', path: 'Components/Notes app.md', block_id: 'f-f8cccccccc', actor: 'user', run_id: null },
      { company_id: P, op: 'pause', target_kind: 'memory', target_id: 'memory', path: null, block_id: null, actor: 'user', run_id: null }
    ])
    const log = readLog(root(A))
    expect(log.filter((l) => l.opId?.startsWith('v1:')).map((l) => l.blockId ?? null)).toEqual([null, 'f-f1aaaaaaaa', 'f-f3aaaaaaaa', 'f-f4aaaaaaaa'])
    expect(log.filter((l) => l.actor === 'migration' && l.op === 'create' && l.targetKind === 'note').length).toBe(3) // 2 entities + the repo note
    const mj = JSON.parse(fs.readFileSync(path.join(root(A), '.principia', 'migration.json'), 'utf8')) as MigrationFile
    expect(mj).toMatchObject({ formatVersion: 1, companyId: A, events: [1, 2, 3, 4] })
    expect(mj.map['ment_e1aaaaaaaa']).toEqual({ ref: 'n-e1aaaaaaaa', noteId: 'n-e1aaaaaaaa', path: 'Files/scripts-sync-migration.sh.md', status: 'note' })
    expect(mj.map['mfa_f1aaaaaaaa']).toMatchObject({ ref: '[[scripts-sync-migration.sh.md#^f-f1aaaaaaaa]]', status: 'active' })
    expect(mj.map['mfa_f3aaaaaaaa']).toMatchObject({ status: 'superseded' })
    expect(mj.map['mfa_f5aaaaaaaa']).toMatchObject({ status: 'proposal' })
    const mp = JSON.parse(fs.readFileSync(path.join(root(P), '.principia', 'migration.json'), 'utf8')) as MigrationFile
    expect(mp.map['mfa_f0bbbbbbbb']).toMatchObject({ ref: '[[Billing#^f-f0bbbbbbbb]]', path: 'Concepts/Billing.md' })
    expect(mp.events).toEqual([5, 6])
  })

  it('is idempotent: a re-run (and its dry run) writes nothing', async () => {
    await runMigration(deps(), { dryRun: false })
    const tree = snapshotTree()
    const events = (rt.db.prepare('SELECT count(*) AS n FROM mem_event').get() as { n: number }).n
    const proposals = (rt.db.prepare('SELECT count(*) AS n FROM mem_proposal').get() as { n: number }).n
    const backups = fs.readdirSync(path.join(dir, 'v1', 'Hive-backups'))
    const dry = await runMigration(deps({ now: () => new Date('2026-10-21T08:00:00.000Z') }), { dryRun: true })
    expect(dry).toMatchObject({ alreadyMigrated: true, companies: expect.any(Array) })
    expect(dry.totals).toEqual({ entityNotes: 0, observations: 0, historyLines: 0, proposals: 0, events: 0 })
    const again = await runMigration(deps({ now: () => new Date('2026-10-21T08:00:00.000Z') }), { dryRun: false })
    expect(again).toMatchObject({ dryRun: false, alreadyMigrated: true, backupPath: null })
    expect(again.totals).toEqual({ entityNotes: 0, observations: 0, historyLines: 0, proposals: 0, events: 0 })
    expect(snapshotTree()).toEqual(tree)
    expect((rt.db.prepare('SELECT count(*) AS n FROM mem_event').get() as { n: number }).n).toBe(events)
    expect((rt.db.prepare('SELECT count(*) AS n FROM mem_proposal').get() as { n: number }).n).toBe(proposals)
    expect(fs.readdirSync(path.join(dir, 'v1', 'Hive-backups'))).toEqual(backups)
  })

  it('adds v1 lines written after the first run to the existing notes with their ids, through the writer', async () => {
    await runMigration(deps(), { dryRun: false })
    // the user edits the note in Obsidian meanwhile; the edit is kept
    const rel = 'Files/scripts-sync-migration.sh.md'
    fs.appendFileSync(path.join(root(A), ...rel.split('/')), 'A line the user wrote.\n')
    rt.index.indexNote(A, rel)
    const db = new Database(dbFile)
    db.prepare(
      `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, actor, grant_id, created_at, updated_at)
       VALUES ('mfa_fnewaaaaaa', 'ment_e1aaaaaaaa', 'Needs DATABASE_URL set', 'h', 'convention', 'project', ?, 'active', 'agent', 'mgr_claude0001', ?, ?)`
    ).run(REPO_A.id, T(10), T(10))
    db.close()
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.totals).toMatchObject({ entityNotes: 0, observations: 1, historyLines: 0 })
    const text = read(A, rel)
    expect(text).toContain('- [convention] Needs DATABASE_URL set (claude run#run_42, 2026-09-10) ^f-fnewaaaaaa')
    expect(text).toContain('A line the user wrote.')
    expect(text.match(/\^f-f1aaaaaaaa$/gm)!.length).toBe(1)
    expect(rt.index.findBlock(A, 'f-fnewaaaaaa')).toMatchObject({ noteId: 'n-e1aaaaaaaa', status: 'active' })
    expect(readLog(root(A)).some((l) => l.actor === 'migration' && l.op === 'update' && l.path === rel)).toBe(true)
  })

  it('never adds back a migrated line or note a human removed in Obsidian', async () => {
    await runMigration(deps(), { dryRun: false })
    // the human deletes one migrated fact line and the whole Billing note (Finder / Obsidian, not Principia)
    const rel = 'Files/scripts-sync-migration.sh.md'
    const abs = path.join(root(A), ...rel.split('/'))
    fs.writeFileSync(abs, read(A, rel).replace(/^.*\^f-f2aaaaaaaa\n/m, ''))
    fs.rmSync(path.join(root(A), 'Concepts', 'Billing.md'))
    rt.reindex(A)
    const tree = snapshotTree()
    const dry = await runMigration(deps(), { dryRun: true })
    expect(dry.alreadyMigrated).toBe(true)
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.alreadyMigrated).toBe(true)
    expect(r.totals).toMatchObject({ entityNotes: 0, observations: 0, historyLines: 0 })
    expect(r.warnings.some((w) => w.includes('removed from the vault'))).toBe(true)
    expect(read(A, rel)).not.toContain('^f-f2aaaaaaaa')
    expect(exists(A, 'Concepts/Billing.md')).toBe(false)
    expect(snapshotTree()).toEqual(tree)

    // a v1 line written later on the removed entity brings the note back with only that line
    const db = new Database(dbFile)
    db.prepare(
      `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, actor, grant_id, created_at, updated_at)
       VALUES ('mfa_fnewbbbbbb', 'ment_e2bbbbbbbb', 'Refunds go through support', 'h', 'fact', 'project', ?, 'active', 'user', NULL, ?, ?)`
    ).run(REPO_A.id, T(10), T(10))
    db.close()
    const later = await runMigration(deps(), { dryRun: false })
    expect(later.totals).toMatchObject({ entityNotes: 1, observations: 1, historyLines: 0 })
    const billing = read(A, 'Concepts/Billing.md')
    expect(billing).toContain('^f-fnewbbbbbb')
    expect(billing).not.toContain('^f-f6bbbbbbbb')
  })

  it('retries lines whose note could not be written instead of reading them as removed', async () => {
    await runMigration(deps(), { dryRun: false })
    const db = new Database(dbFile)
    db.prepare(
      `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, actor, grant_id, created_at, updated_at)
       VALUES ('mfa_fnewaaaaaa', 'ment_e1aaaaaaaa', 'Needs DATABASE_URL set', 'h', 'convention', 'project', ?, 'active', 'user', NULL, ?, ?)`
    ).run(REPO_A.id, T(10), T(10))
    db.close()
    // the append's CAS save fails once (a human saved mid-migration)
    const save = rt.writer.save.bind(rt.writer)
    let fail = true
    rt.writer.save = async (...args: Parameters<typeof save>) => {
      if (!fail) return save(...args)
      fail = false
      return { status: 'error', reason: 'changed while migrating' }
    }
    const first = await runMigration(deps(), { dryRun: false })
    expect(first.warnings.some((w) => w.includes('new v1 lines not added'))).toBe(true)
    const file = JSON.parse(fs.readFileSync(path.join(root(A), '.principia', 'migration.json'), 'utf8')) as MigrationFile
    expect(file.map.mfa_fnewaaaaaa).toBeUndefined()
    const again = await runMigration(deps(), { dryRun: false })
    expect(again.totals).toMatchObject({ observations: 1 })
    expect(read(A, 'Files/scripts-sync-migration.sh.md')).toContain('^f-fnewaaaaaa')
  })

  it('without memory.db it still seeds hubs and repo notes', async () => {
    const r = await runMigration(deps({ memoryDbPath: path.join(dir, 'nope', 'memory.db') }), { dryRun: false })
    expect(r.totals).toEqual({ entityNotes: 0, observations: 0, historyLines: 0, proposals: 0, events: 0 })
    expect(r.backupPath).toBeNull()
    expect(exists(A, 'Repos/acme-web.md')).toBe(true)
    expect(read(A, 'Acme.md')).toContain('- sells [[Ledger]]')
    expect(fs.existsSync(path.join(root(A), '.principia', 'migration.json'))).toBe(false)
  })

  it('never overwrites a hand-made note that already uses the target filename', async () => {
    fs.mkdirSync(path.join(root(A), 'Concepts'), { recursive: true })
    fs.writeFileSync(path.join(root(A), 'Concepts', 'Billing.md'), '# Billing\nMy own notes.\n')
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.warnings).toEqual([])
    expect(read(A, 'Concepts/Billing.md')).toBe('# Billing\nMy own notes.\n')
    expect(read(A, 'Concepts/Billing (Concept).md')).toContain('id: n-e2bbbbbbbb')
  })
})

d('migration edge cases (§9)', () => {
  const addFact = (o: { id: string; e: string; text: string; scope?: string; repo?: string | null; status?: string; reason?: string | null; actor?: string }) => {
    const db = new Database(dbFile)
    db.prepare(
      `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, invalid_reason, actor, grant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(o.id, o.e, o.text, o.id, o.scope ?? 'project', o.repo === undefined ? REPO_A.id : o.repo, o.status ?? 'active', o.reason ?? null, o.actor ?? 'user', T(5), T(5))
    db.close()
  }

  it('puts project facts an agent wrote onto a global entity in the company of their repo, not in Personal', async () => {
    const db = new Database(dbFile)
    db.prepare(`INSERT INTO mem_entity (id, repo_id, name, norm_name, type, summary, actor, grant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'ment_e5eeeeeeee', null, 'Pricing', 'pricing', 'concept', '', 'user', null, T(5), T(5))
    db.prepare(`INSERT INTO mem_event (ts, op, target_kind, target_id, entity_id, actor) VALUES (?,?,?,?,?,?)`).run(T(5), 'create', 'fact', 'mfa_fpaaaaaaaa', 'ment_e5eeeeeeee', 'user')
    db.close()
    addFact({ id: 'mfa_fpaaaaaaaa', e: 'ment_e5eeeeeeee', text: 'Pro is $49 a month' })
    // a global entity with lines from two companies keeps its v1 note in Personal and gets a derived note in Acme
    addFact({ id: 'mfa_fwaaaaaaaa', e: 'ment_e4dddddddd', text: 'Acme docs use the active voice' })
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.warnings).toEqual([])
    const pricing = read(A, 'Concepts/Pricing.md')
    expect(pricing).toContain('id: n-e5eeeeeeee')
    expect(pricing).toContain('repos: ["[[acme-web]]"]')
    expect(pricing).toContain('^f-fpaaaaaaaa')
    expect(exists(P, 'Concepts/Pricing.md')).toBe(false)
    expect(read(P, 'Concepts/Writing style.md')).not.toContain('active voice')
    expect(read(A, 'Concepts/Writing style.md')).toContain('- [fact] Acme docs use the active voice (user, 2026-09-05) ^f-fwaaaaaaaa')
    expect(rt.db.prepare("SELECT company_id, path FROM mem_event WHERE op_id = 'v1:7'").get()).toEqual({ company_id: A, path: 'Concepts/Pricing.md' })
    const again = await runMigration(deps(), { dryRun: true })
    expect(again.alreadyMigrated).toBe(true)
  })

  it('gives facts with non-standard v1 ids a derived block id once, never a duplicate line on re-run', async () => {
    addFact({ id: 'mfa_legacy1', e: 'ment_e2bbbbbbbb', text: 'An old-format fact' })
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.warnings.some((w) => w.includes('mfa_legacy1'))).toBe(true)
    const line = read(A, 'Concepts/Billing.md').match(/^- \[fact\] An old-format fact .* \^(f-[0-9a-z]{10})$/m)
    expect(line).not.toBeNull()
    const again = await runMigration(deps(), { dryRun: false })
    expect(again.totals).toMatchObject({ observations: 0 })
    expect(read(A, 'Concepts/Billing.md').match(/An old-format fact/g)!.length).toBe(1)
    const mj = JSON.parse(fs.readFileSync(path.join(root(A), '.principia', 'migration.json'), 'utf8')) as MigrationFile
    expect(mj.map['mfa_legacy1'].ref).toContain(`#^${line![1]}]]`)
  })

  it('files a contested supersede of a fact in another vault as a review item in its own vault', async () => {
    addFact({ id: 'mfa_fcaaaaaaaa', e: 'ment_e2bbbbbbbb', text: 'Adyen is the processor', status: 'pending', reason: 'contested: supersedes mfa_f0bbbbbbbb', actor: 'agent' })
    await runMigration(deps(), { dryRun: false })
    const row = rt.db.prepare("SELECT company_id, kind, payload_json FROM mem_proposal WHERE fingerprint = 'migration:mfa_fcaaaaaaaa'").get() as Record<string, string>
    expect(row.company_id).toBe(A)
    expect(row.kind).toBe('harvest')
    expect(JSON.parse(row.payload_json)).toEqual([{ op: 'observe', note: 'n-e2bbbbbbbb', category: 'fact', text: 'Adyen is the processor' }])
  })

  it('does not file a proposal again after the index lost it (rejected, then the index db was rebuilt)', async () => {
    await runMigration(deps(), { dryRun: false })
    const mj = JSON.parse(fs.readFileSync(path.join(root(A), '.principia', 'migration.json'), 'utf8')) as MigrationFile
    expect(mj.proposals).toEqual(['migration:mfa_f5aaaaaaaa', 'migration:mfa_f7bbbbbbbb'])
    rt.db.prepare('DELETE FROM mem_proposal').run()
    const r = await runMigration(deps(), { dryRun: false })
    expect(r.totals.proposals).toBe(0)
    expect((rt.db.prepare('SELECT count(*) AS n FROM mem_proposal').get() as { n: number }).n).toBe(0)
  })
})

// A copy of a real memory.db (HIVE_MIGRATE_LIVE_DB=/path/to/copy/memory.db): every v1 row lands in a vault.
const liveDb = process.env.HIVE_MIGRATE_LIVE_DB
const live = nativeOk && liveDb && fs.existsSync(liveDb) ? describe : describe.skip
live('live memory.db copy', () => {
  it('migrates every entity, active fact and invalid fact with v1 ids and leaves the db byte-identical', async () => {
    const files = [liveDb!, `${liveDb}-wal`]
    const before = files.map(hashFile)
    const src = new Database(liveDb!, { readonly: true })
    const n = (sql: string) => (src.prepare(sql).get() as { n: number }).n
    const expected = {
      entities: n('SELECT count(*) AS n FROM mem_entity'),
      active: n("SELECT count(*) AS n FROM mem_fact WHERE status = 'active'"),
      invalid: n("SELECT count(*) AS n FROM mem_fact WHERE status = 'invalid'")
    }
    src.close()
    const r = await runMigration(deps({ memoryDbPath: liveDb! }), { dryRun: false })
    expect(r.totals).toMatchObject({ entityNotes: expected.entities, observations: expected.active, historyLines: expected.invalid })
    expect(r.warnings.filter((w) => !w.includes('another company'))).toEqual([])
    const q = (sql: string) => (rt.db.prepare(sql).get() as { n: number }).n
    expect(q("SELECT count(*) AS n FROM mem_note WHERE json_extract(frontmatter_json, '$.source') = 'migration' AND type != 'repo'")).toBe(expected.entities)
    expect(q("SELECT count(*) AS n FROM mem_fact WHERE status = 'active' AND id LIKE 'mfa_%' AND block_id IS NOT NULL AND section = 'obs' AND actor != 'migration'")).toBe(expected.active)
    expect(q("SELECT count(*) AS n FROM mem_fact WHERE section = 'history' AND id LIKE 'mfa_%'")).toBe(expected.invalid)
    expect(files.map(hashFile)).toEqual(before)
    const again = await runMigration(deps({ memoryDbPath: liveDb! }), { dryRun: false })
    expect(again.alreadyMigrated).toBe(true)
  })
})
