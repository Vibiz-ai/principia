/**
 * COMPANY.md §11 C7 step 2: upgrading a pre-company hive.db. Every pre-existing row lists under All and under exactly
 * one company (its owner, or Personal), nothing is lost or hidden, and the schedules fire at the same times.
 *
 * Sources: a live-shaped snapshot built here (the shape and counts of the founder's hive.db at the time of writing:
 * nested repos, repo-less chats, seeded `{{inputs.repo}}` workflows, cron schedules in a time zone, runs of every
 * trigger), plus a scrubbed copy of a real hive.db when one is present: `HIVE_UPGRADE_DB=<file>` or
 * `fixtures/upgrade/hive-scrubbed.db` (made by `fixtures/upgrade/scrub-hive-db.mjs`, never from the live file).
 * The snapshot also goes through the scrub script, so the script that makes the real fixture is proven to keep what
 * the backfill reads. Each source is opened twice: as is (no company tables: everything is Personal; a real db keeps the
 * Passports it had), and with the old runtime company module's tables assigning some more repos to two companies
 * (rows follow their repo).
 */
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import {
  AUTHORING_ADDED_COLUMNS, DDL_AUTHORING, DDL_SLACK, DDL_V1, DDL_V2_SCHEDULE_EVENTS, DDL_V2_TABLES, SCHEMA_VERSION, SLACK_ADDED_COLUMNS, V2_ADDED_COLUMNS
} from '../db/schema'
import { Store } from '../db/store'
import { LiveStore } from '../db/liveStore'
import { createEngineStore } from '../db/engineStore'
import { CompanyStore } from '../company'
import { Vault } from '../vault'
import { createScheduler, describeWhen, nextFire } from '../engine/scheduler'
import { PERSONAL_COMPANY_ID as P } from '../../shared/company'
import type { Id, Run, RunTarget, ScheduleWhen } from '../../shared/types'
import type { StartRunOptions } from '../../shared/engine'

let nativeOk = true
try {
  new Database(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

const REAL = process.env.HIVE_UPGRADE_DB || path.join(__dirname, 'fixtures', 'upgrade', 'hive-scrubbed.db')
const SCRUB = path.join(__dirname, 'fixtures', 'upgrade', 'scrub-hive-db.mjs')
const SOURCES: { name: string; make: (file: string) => void }[] = [
  { name: 'live-shaped snapshot', make: (file) => liveShaped(file) },
  {
    name: 'live-shaped snapshot, scrubbed',
    make: (file) => {
      const raw = `${file}.raw`
      liveShaped(raw)
      execFileSync(process.execPath, [SCRUB, raw, file], { stdio: 'pipe' })
      fs.rmSync(raw)
    }
  },
  ...(fs.existsSync(REAL) ? [{ name: `scrubbed hive.db (${path.basename(REAL)})`, make: (file: string) => fs.copyFileSync(REAL, file) }] : [])
]

// ---------- the live-shaped snapshot ----------

const T0 = Date.parse('2026-10-20T12:30:00.000Z')
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString()
const pad = (n: number) => String(n).padStart(10, '0')
const id = (prefix: string, n: number) => `${prefix}_${pad(n)}`

/** schema v2 + authoring + Slack as the build before companies left it; the company module never ran (no company_* tables). */
function legacySchema(db: DB): void {
  db.pragma('foreign_keys = ON')
  db.exec(DDL_V1)
  db.exec(DDL_V2_TABLES)
  db.exec('ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT')
  db.exec(DDL_V2_SCHEDULE_EVENTS)
  db.exec(DDL_AUTHORING)
  db.exec(DDL_SLACK)
  for (const [t, c, ddl] of [...V2_ADDED_COLUMNS, ...AUTHORING_ADDED_COLUMNS, ...SLACK_ADDED_COLUMNS]) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`)
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?), ('slack_migrated', '1'), ('seeded', '1')").run(String(SCHEMA_VERSION))
}

/**
 * The founder's hive.db at the time of writing, in shape and counts (COMPANY.md §9 lists them): 18 repos (one nested in
 * another), 36 sessions (13 repo-less, in scratch), 22 workflows, 8 cron schedules, 285 runs, 971 artifacts, 790
 * agents, 17 asks, 31 authoring drafts, 5 shared keys, one Slack workspace and trigger.
 */
function liveShaped(file: string): void {
  const db = new Database(file)
  legacySchema(db)
  const root = '/Users/founder/code'
  const repoIds = Array.from({ length: 18 }, (_, i) => id('repo', i))
  const repoPath = (i: number) => (i === 1 ? `${root}/repo-0/app` : `${root}/repo-${i}`) // repo 1 lives inside repo 0
  const repo = db.prepare('INSERT INTO repos(id, name, path, added_at) VALUES (?, ?, ?, ?)')
  repoIds.forEach((r, i) => repo.run(r, `repo-${i}`, repoPath(i), at(9000 - i)))
  db.prepare("INSERT INTO meta(key, value) VALUES ('repo_order', ?)").run(JSON.stringify([...repoIds].reverse()))
  db.prepare("INSERT INTO profiles(id, name, adapter, extra_args_json, permission_mode, secret_names_json, created_at, updated_at) VALUES ('prof_claude00', 'Claude', 'claude', '[]', 'bypass', '[\"*\"]', ?, ?)").run(at(9000), at(9000))

  const session = db.prepare(
    "INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, ended_at, artifacts_dir, log_path) VALUES (?, 's', 'prof_claude00', 'claude', ?, ?, 'exited', 80, 24, ?, ?, '/a', '/l')"
  )
  for (let i = 0; i < 36; i++) {
    const r = i < 13 ? null : i % 18
    session.run(id('sess', i), r === null ? null : repoIds[r], r === null ? '/Users/founder/Library/Application Support/Hive/scratch' : repoPath(r), at(5000 - i * 60), at(4990 - i * 60))
  }

  const wf = db.prepare('INSERT INTO workflows(id, name, description, inputs_json, nodes_json, seed_key, worktree_json, created_at, updated_at) VALUES (?, ?, \'\', ?, ?, ?, ?, ?, ?)')
  const node = (cwd: string | null, n = 'a') => ({ id: n, type: 'agent', label: n, after: [], cwd, timeoutMin: 30, profileId: 'prof_claude00', prompt: 'x' })
  const repoInput = (def?: string) => [{ name: 'repo', label: 'Repository', type: 'repo', ...(def ? { default: def } : {}) }]
  const wfIds = Array.from({ length: 22 }, (_, i) => id('wf', i))
  wfIds.forEach((w, i) => {
    // seeds (template repo, no default), single-repo flows, a nested absolute path, a worktree flow, a two-repo flow, scratch flows
    const [inputs, nodes, seed, worktree] =
      i < 4 ? [repoInput(), [node('{{inputs.repo}}')], `seed-${i}`, null]
      : i < 14 ? [[], [node(repoIds[i - 4]), node(repoIds[i - 4], 'b')], null, null]
      : i === 14 ? [[], [node(`${repoPath(1)}/src`)], null, null]
      : i === 15 ? [[], [node(null)], null, { repo: repoIds[2] }]
      : i === 16 ? [[], [node(repoIds[2]), node(repoIds[3], 'b')], null, null]
      : i < 19 ? [repoInput(repoIds[3]), [node('{{inputs.repo}}')], null, null]
      : [[], [node(null)], null, null]
    wf.run(w, `Flow ${i}`, JSON.stringify(inputs), JSON.stringify(nodes), seed, worktree ? JSON.stringify(worktree) : null, at(8000 - i), at(100 + i))
  })

  // cron schedules in a time zone, next_fire_at in the future, a skipped slot and a paused one (COMPANY.md §9 step 4)
  const sched = db.prepare(
    'INSERT INTO schedules(id, name, target_json, when_json, preset_json, enabled, last_fire_at, last_run_id, next_fire_at, skip_slot_at, created_at, updated_at) VALUES (?, ?, ?, ?, \'{"kind":"cron"}\', ?, ?, NULL, ?, ?, ?, ?)'
  )
  const crons = ['0 9 * * *', '0 * * * *', '15 * * * *', '0 9 * * 1', '45 8 * * *', '0 9 * * 1', '45 * * * *', '8 * * * *']
  const schedIds = crons.map((_, i) => id('sch', i))
  crons.forEach((cron, i) => {
    const when: ScheduleWhen = { kind: 'cron', cron, tz: 'Europe/Rome' }
    const target = i % 2 ? { kind: 'workflow', workflowId: wfIds[i], inputs: { repo: repoIds[4], dry_run: 'false' } } : { kind: 'workflow', workflowId: wfIds[4 + i], inputs: {} }
    const next = nextFire(when, new Date(T0))!.toISOString()
    sched.run(schedIds[i], `Schedule ${i}`, JSON.stringify(target), JSON.stringify(when), i === 7 ? 0 : 1, at(60), next, i === 2 ? next : null, at(7000), at(7000))
  })

  // runs: workflow, schedule, prompt in a repo, repo-less prompt; a rerun chain
  const run = db.prepare(
    "INSERT INTO runs(id, kind, title, target_json, workflow_id, schedule_id, parent_run_id, trigger, status, created_at, started_at, ended_at, artifacts_dir) VALUES (?, ?, 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, '/a')"
  )
  const runIds = Array.from({ length: 285 }, (_, i) => id('run', i))
  runIds.forEach((r, i) => {
    const t = at(4000 - i * 10)
    const kind = i % 4
    if (kind === 0) run.run(r, 'workflow', JSON.stringify({ kind: 'workflow', workflowId: wfIds[i % 22], inputs: { repo: repoIds[i % 18] } }), wfIds[i % 22], null, null, 'manual', 'passed', t, t, t)
    else if (kind === 1) {
      const s = i % 8
      run.run(r, 'workflow', JSON.stringify({ kind: 'workflow', workflowId: s % 2 ? wfIds[s] : wfIds[4 + s], inputs: {} }), s % 2 ? wfIds[s] : wfIds[4 + s], schedIds[s], null, 'schedule', 'failed', t, t, t)
    } else if (kind === 2) run.run(r, 'prompt', JSON.stringify({ kind: 'prompt', profileId: 'prof_claude00', repoId: repoIds[i % 18], prompt: 'x' }), null, null, null, 'manual', 'passed', t, t, t)
    else run.run(r, 'prompt', JSON.stringify({ kind: 'prompt', profileId: 'prof_claude00', repoId: null, prompt: 'x' }), null, null, i > 3 ? runIds[i - 4] : null, i > 3 ? 'rerun' : 'manual', 'canceled', t, t, t)
  })

  // agents: a root per session and per run, subagents under some of them, one orphan
  const agent = db.prepare(
    "INSERT INTO agents(id, kind, parent_id, root_id, session_id, run_id, provider, repo_id, cwd, title, depth, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'claude', ?, '/x', 't', ?, 'done', ?, ?)"
  )
  const roots: string[] = []
  for (let i = 0; i < 36; i++) agent.run(id('agt', roots.push(id('agt', roots.length)) - 1), 'session', null, roots.at(-1), id('sess', i), null, i < 13 ? null : repoIds[i % 18], 0, at(300), at(300))
  for (let i = 0; i < 285; i++) agent.run(id('agt', roots.push(id('agt', roots.length)) - 1), 'step', null, roots.at(-1), null, runIds[i], null, 0, at(300), at(300))
  let n = roots.length
  while (n < 789) {
    const parent = roots[n % roots.length]
    agent.run(id('agt', n), 'subagent', parent, parent, null, null, null, 1, at(200), at(200))
    n++
  }
  agent.run(id('agt', n), 'subagent', null, 'agt_missing00', null, null, null, 1, at(200), at(200))

  const ask = db.prepare("INSERT INTO asks(id, agent_id, root_id, session_id, run_id, provider, kind, channel, title, status, created_at) VALUES (?, ?, ?, ?, ?, 'claude', 'permission', 'stdio', 't', ?, ?)")
  for (let i = 0; i < 17; i++) ask.run(id('ask', i), roots[i * 7], roots[i * 7], i * 7 < 36 ? id('sess', i * 7) : null, i * 7 >= 36 ? runIds[i * 7 - 36] : null, i < 3 ? 'open' : 'answered', at(100 - i))

  const art = db.prepare("INSERT INTO artifacts(id, run_id, session_id, path, rel_path, name, kind, mime, bytes, mtime, created_at) VALUES (?, ?, ?, ?, 'r', 'n', 'file', 'text/plain', 1, ?, ?)")
  for (let i = 0; i < 971; i++) art.run(id('art', i), i % 3 === 0 ? runIds[i % 285] : null, i % 3 === 1 ? id('sess', i % 36) : null, `/Users/founder/Library/Application Support/Hive/artifacts/${i}`, at(i), at(i))

  const draft = db.prepare(
    "INSERT INTO author_drafts(id, kind, status, owner_kind, session_id, run_id, workflow_id, owner_key, owner_label, adapter, payload_json, content_hash, created_at) VALUES (?, 'create', 'applied', ?, ?, ?, ?, 'k', 'l', 'claude', '{}', 'h', ?)"
  )
  for (let i = 0; i < 31; i++) draft.run(id('drft', i), i % 2 ? 'session' : 'run', i % 2 ? id('sess', i) : null, i % 2 ? null : runIds[i], i % 5 === 0 ? wfIds[i % 22] : null, at(50 + i))

  db.prepare("INSERT INTO slack_workspaces(team_id, team_name, bot_user_id, bot_id, connected_at, updated_at) VALUES ('T0FOUNDER', 'Workspace', 'UBOT', 'BBOT', ?, ?)").run(at(3000), at(3000))
  db.prepare(
    "INSERT INTO slack_triggers(id, name, workflow_id, enabled, match_json, reply_json, inputs_json, limits_json, created_at, updated_at) VALUES ('strg_000000001', 'Reply when tagged', ?, 1, '{}', '{}', '{}', '{}', ?, ?)"
  ).run(wfIds[20], at(3000), at(3000))
  const secret = db.prepare("INSERT INTO secrets(name, label, cipher, masked, created_at, updated_at) VALUES (?, '', x'00', '••••', ?, ?)")
  for (const s of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VERCEL_TOKEN']) secret.run(s, at(9000), at(9000))
  db.close()
}

// ---------- the old runtime company module (company/index.ts before COMPANY.md) ----------

const passportData = (cid: string, name: string, repoIds: string[]) =>
  JSON.stringify({ id: cid, name, mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds, createdAt: at(0), updatedAt: at(0) })

/** repo → company of the Passports a source already has (a real db whose founder used Passports before companies). */
function legacyOwners(file: string): Map<string, string> {
  const db = new Database(file, { readonly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'company_repos'").get()) return new Map()
    const rows = db.prepare('SELECT cr.repo_id AS r, cr.company_id AS c FROM company_repos cr JOIN company_passports cp ON cp.id = cr.company_id').all() as { r: string; c: string }[]
    return new Map(rows.map((x) => [x.r, x.c]))
  } finally {
    db.close()
  }
}
function legacyCompanies(file: string): string[] {
  const db = new Database(file, { readonly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'company_passports'").get()) return []
    return (db.prepare('SELECT id FROM company_passports ORDER BY rowid').all() as { id: string }[]).map((r) => r.id)
  } finally {
    db.close()
  }
}

/**
 * Acme owns the first unowned repo (and the unowned repos nested inside it), Beta the next unrelated unowned one.
 * Written with the old lazy CREATE, the way a founder who used Passports before companies left the db. Repos a source
 * already assigns keep their owner. Returns repo → company, both kinds.
 */
function addLegacyCompanies(file: string): Map<string, string> {
  const existing = legacyOwners(file)
  const db = new Database(file)
  db.exec(`CREATE TABLE IF NOT EXISTS company_passports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_repos (repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, company_id TEXT NOT NULL REFERENCES company_passports(id));
    CREATE TABLE IF NOT EXISTS company_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, company_id TEXT NOT NULL REFERENCES company_passports(id), source_key TEXT, run_id TEXT, data TEXT NOT NULL);`)
  const repos = (db.prepare('SELECT id, path FROM repos ORDER BY rowid').all() as { id: string; path: string }[]).filter((r) => !existing.has(r.id))
  const owners = new Map<string, string>()
  if (repos.length) {
    const first = repos[0]
    const nested = repos.filter((r) => r.path.startsWith(first.path + '/'))
    const beta = repos.find((r) => r !== first && !nested.includes(r))
    for (const r of [first, ...nested]) owners.set(r.id, 'co_acme')
    if (beta) owners.set(beta.id, 'co_beta')
  }
  const owned = (c: string) => [...owners].filter(([, o]) => o === c).map(([r]) => r)
  db.prepare('INSERT INTO company_passports(id, data) VALUES (?, ?), (?, ?)').run('co_acme', passportData('co_acme', 'Acme', owned('co_acme')), 'co_beta', passportData('co_beta', 'Beta', owned('co_beta')))
  const own = db.prepare('INSERT INTO company_repos(repo_id, company_id) VALUES (?, ?)')
  for (const [r, c] of owners) own.run(r, c)
  // a task the old module started: its run is the company's whatever it targets (COMPANY.md §9 step 5, first rule)
  const taskRun = db.prepare("SELECT id FROM runs WHERE target_json LIKE '%\"repoId\":null%' ORDER BY rowid LIMIT 1").get() as { id: string } | undefined
  if (taskRun) db.prepare("INSERT INTO company_tasks(id, company_id, source_key, run_id, data) VALUES ('ta_upgrade0001', 'co_beta', NULL, ?, '{}')").run(taskRun.id)
  db.close()
  return new Map([...existing, ...owners])
}
/** The run the old module's task tied to Beta (see addLegacyCompanies), if any. */
function taskRunOf(db: DB): string | null {
  return (db.prepare("SELECT run_id FROM company_tasks WHERE id = 'ta_upgrade0001'").get() as { run_id: string } | undefined)?.run_id ?? null
}

// ---------- what an upgrade must keep ----------

const DOMAINS = ['repos', 'sessions', 'workflows', 'schedules', 'runs', 'artifacts', 'agents', 'asks', 'author_drafts', 'slack_workspaces', 'secrets'] as const
type Domain = (typeof DOMAINS)[number]
const KEY: Partial<Record<Domain, string>> = { slack_workspaces: 'team_id', secrets: 'name' }

interface Before {
  ids: Record<Domain, string[]>
  rows: Record<string, number>
  schedules: { id: string; when_json: string; next_fire_at: string | null; last_fire_at: string | null; skip_slot_at: string | null; enabled: number }[]
}
/** Every id per domain and the row count of every table, read with a plain connection before the new build opens the file. */
function readBefore(file: string): Before {
  const db = new Database(file, { readonly: true })
  try {
    const ids = Object.fromEntries(
      DOMAINS.map((t) => [t, (db.prepare(`SELECT ${KEY[t] ?? 'id'} AS k FROM ${t} ORDER BY rowid`).all() as { k: string }[]).map((r) => r.k)])
    ) as Record<Domain, string[]>
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all() as { name: string }[]).map((r) => r.name)
    const rows = Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]))
    const schedules = db.prepare('SELECT id, when_json, next_fire_at, last_fire_at, skip_slot_at, enabled FROM schedules ORDER BY rowid').all() as Before['schedules']
    return { ids, rows, schedules }
  } finally {
    db.close()
  }
}

/** A domain's listing: All (no companyId, what every existing caller and IPC list without companyId gets) or one company. */
function lister(db: DB, store: Store, live: LiveStore, company: CompanyStore): Record<Domain, (companyId?: Id) => { id: string; companyId?: string | null }[]> {
  const big = (n: number, cap: number) => {
    expect(n, 'a source larger than the list cap needs paging here').toBeLessThanOrEqual(cap)
    return cap
  }
  const sqlList = (table: string, key: string) => (companyId?: Id) =>
    (db.prepare(`SELECT ${key} AS id, COALESCE(company_id, '${P}') AS companyId FROM ${table} ${companyId ? `WHERE COALESCE(company_id, '${P}') = ?` : ''}`).all(...(companyId ? [companyId] : [])) as { id: string; companyId: string }[])
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  return {
    repos: (c) => store.listRepos(undefined, c),
    sessions: (c) => store.listSessions('all', undefined, c),
    workflows: (c) => store.listWorkflows(c),
    schedules: (c) => store.listSchedules(c),
    runs: (c) => store.listRuns({ limit: big(count('runs'), 1000), companyId: c }),
    artifacts: (c) => store.listArtifacts({ limit: big(count('artifacts'), 5000), companyId: c }),
    agents: (c) => live.listAgents({ limit: big(count('agents'), 1000), companyId: c }),
    asks: (c) => live.listAsks({ status: 'all', limit: big(count('asks'), 1000), companyId: c }),
    // authoring drafts and Slack workspaces are listed through COALESCE in SQL (handlers read them the same way)
    author_drafts: sqlList('author_drafts', 'id'),
    slack_workspaces: (c) => sqlList('slack_workspaces', 'team_id')(c).map((w) => ({ ...w, companyId: company.companyOf({ teamId: w.id }).id })),
    // keys stay Shared (COMPANY.md §4): listed under All and inherited by every company
    secrets: () => (db.prepare('SELECT name AS id FROM secrets').all() as { id: string }[]).map((s) => ({ ...s, companyId: null }))
  }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-upgrade-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

for (const source of SOURCES) {
  // generous timeout: the scrubbed source runs the scrub script, slow under a full parallel suite
  d(`upgrade: ${source.name}`, { timeout: 60_000 }, () => {
    for (const withCompanies of [false, true]) {
      it(`${withCompanies ? 'with the old company module\'s Passports' : 'as is'}: every row lists under All and under exactly its company or Personal`, () => {
        const file = path.join(tmp, 'hive.db')
        source.make(file)
        const preexisting = legacyCompanies(file)
        const owners = withCompanies ? addLegacyCompanies(file) : legacyOwners(file)
        const before = readBefore(file)
        expect(before.ids.repos.length).toBeGreaterThan(0)

        const db = openDatabase(file)
        try {
          const store = new Store(db)
          const live = new LiveStore(db)
          const company = new CompanyStore(store, { companiesRoot: path.join(tmp, 'companies') })
          const companies = company.listPassports().map((c) => c.id)
          expect(companies.at(-1)).toBe(P) // Personal is always listed, always last
          expect([...companies].sort()).toEqual([...new Set([...preexisting, ...(withCompanies ? ['co_acme', 'co_beta'] : []), P])].sort())

          // nothing deleted anywhere (the backfill only adds columns, the company tables and the Personal row)
          const after = readBefore(file)
          // (meta gains the migration flag, report and per-company repo orders; company_passports gains Personal)
          for (const [t, n] of Object.entries(before.rows)) {
            if (t === 'meta' || t === 'company_passports') expect(after.rows[t], t).toBeGreaterThanOrEqual(n)
            else expect(after.rows[t], t).toBe(n)
          }
          expect(fs.readdirSync(path.join(tmp, 'Hive-backups')).some((f) => f.startsWith('hive.pre-company.'))).toBe(true)

          const lists = lister(db, store, live, company)
          const vault = new Vault(db, { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() })
          for (const domain of DOMAINS) {
            const all = lists[domain]()
            const allIds = all.map((r) => r.id).sort()
            expect(allIds, `${domain}: All lists exactly the pre-existing rows`).toEqual([...before.ids[domain]].sort())
            if (domain === 'secrets') {
              for (const c of companies) expect(vault.names(['*'], c), 'shared keys are inherited by every company').toEqual(expect.arrayContaining(before.ids.secrets))
              continue
            }
            const seen = new Map<string, string>()
            for (const c of companies) {
              for (const r of lists[domain](c)) {
                expect(r.companyId, `${domain} ${r.id} listed under ${c}`).toBe(c)
                expect(seen.has(r.id), `${domain} ${r.id} is listed under two companies`).toBe(false)
                seen.set(r.id, c)
              }
            }
            const hidden = allIds.filter((i) => !seen.has(i))
            expect(hidden, `${domain}: rows listed under no company`).toEqual([])
            // every stamp names a listed company: an unknown or archived id would hide the row in focused mode
            for (const r of all) expect(companies, `${domain} ${r.id}`).toContain(r.companyId ?? P)
          }

          // rows follow their repo; with no Passports at all everything is Personal
          const repoCompany = (repoId: string | null) => (repoId && owners.get(repoId)) || P
          for (const r of store.listRepos()) expect(r.companyId, r.id).toBe(repoCompany(r.id))
          for (const s of store.listSessions('all')) expect(s.companyId, s.id).toBe(repoCompany(s.repoId))
          if (!withCompanies && !owners.size) {
            for (const domain of DOMAINS) for (const r of lists[domain]()) if (domain !== 'secrets') expect(r.companyId ?? P, `${domain} ${r.id}`).toBe(P)
          } else if (withCompanies) {
            const taskRun = taskRunOf(db)
            if (taskRun) expect(store.getRun(taskRun)!.companyId, 'a task\'s run is its company\'s').toBe('co_beta')
            const wfCompany = new Map(store.listWorkflows().map((w) => [w.id, w.companyId ?? P]))
            for (const s of store.listSchedules()) if (s.target.kind === 'workflow' && wfCompany.has(s.target.workflowId)) expect(s.companyId, s.id).toBe(wfCompany.get(s.target.workflowId))
            for (const r of store.listRuns({ limit: 1000 })) {
              if (r.id === taskRun) continue
              if (r.target.kind === 'prompt' && r.target.repoId && store.getRepo(r.target.repoId)) expect(r.companyId, r.id).toBe(repoCompany(r.target.repoId))
              else if (r.workflowId && wfCompany.has(r.workflowId) && !r.scheduleId) expect(r.companyId, r.id).toBe(wfCompany.get(r.workflowId))
            }
            // the Passports really split the data (a source with sessions and runs in owned repos)
            if (source.name === SOURCES[0].name) {
              for (const domain of ['sessions', 'workflows', 'schedules', 'runs', 'artifacts', 'agents'] as const) {
                expect(lists[domain]('co_acme').length, `${domain} under Acme`).toBeGreaterThan(0)
                expect(lists[domain](P).length, `${domain} under Personal`).toBeGreaterThan(0)
              }
            }
            // subagents sit with their root
            const agents = new Map(live.listAgents({ limit: 1000 }).map((a) => [a.id, a]))
            for (const a of agents.values()) if (a.parentId && agents.has(a.rootId)) expect(a.companyId, a.id).toBe(agents.get(a.rootId)!.companyId)
            // per-company repo order: each company's repos, in the legacy order
            const legacy = store.listRepos().map((r) => r.id)
            for (const c of companies) expect(store.listRepos(undefined, c).map((r) => r.id)).toEqual(legacy.filter((r) => repoCompany(r) === c))
          }
        } finally {
          db.close()
        }
      })
    }

    it('schedules keep their rule and next fire time, and fire at that time stamped with their company', () => {
      const file = path.join(tmp, 'hive.db')
      source.make(file)
      addLegacyCompanies(file)
      const before = readBefore(file)
      const db = openDatabase(file)
      try {
        const store = new Store(db)
        expect(readBefore(file).schedules).toEqual(before.schedules)
        store.setDescribe(describeWhen)
        const listed = new Map(store.listSchedules().map((s) => [s.id, s]))
        for (const b of before.schedules) {
          const s = listed.get(b.id)!
          expect(s.nextFireAt).toBe(b.next_fire_at)
          expect(s.when).toEqual(JSON.parse(b.when_json))
          expect(s.enabled).toBe(!!b.enabled)
        }

        // the real scheduler over the upgraded db: nothing is due just before the earliest slot; at it, exactly the
        // schedules due then fire (a skipped slot is passed), and the run carries the schedule's company
        const due = before.schedules.filter((s) => s.enabled && s.next_fire_at).sort((a, b) => a.next_fire_at!.localeCompare(b.next_fire_at!))
        if (!due.length) return
        const first = new Date(due[0].next_fire_at!)
        const clock = { now: new Date(first.getTime() - 1000) }
        const engineStore = createEngineStore(db, { describe: () => describeWhen, now: () => clock.now })
        const started: { target: RunTarget; opts: StartRunOptions; companyId: string | null | undefined }[] = []
        const scheduler = createScheduler({
          store: engineStore,
          startRun: (target, opts) => {
            const s = store.getSchedule(opts.scheduleId!)
            started.push({ target, opts, companyId: s?.companyId })
            return { id: `run_up${String(started.length).padStart(8, '0')}` } as Run
          },
          isScheduleActive: () => false,
          emit: () => {},
          log: { info() {}, warn() {} },
          now: () => clock.now,
          paused: false
        })
        scheduler.tick()
        expect(started).toEqual([])
        expect(readBefore(file).schedules.map((s) => s.next_fire_at)).toEqual(before.schedules.map((s) => s.next_fire_at))
        clock.now = first
        scheduler.tick()
        const dueNow = due.filter((s) => s.next_fire_at === due[0].next_fire_at && s.skip_slot_at !== s.next_fire_at).map((s) => s.id)
        expect(dueNow.length).toBeGreaterThan(0)
        expect(started.map((s) => s.opts.scheduleId).sort()).toEqual(dueNow.sort())
        for (const s of started) expect(s.companyId).toBe(store.getSchedule(s.opts.scheduleId!)!.companyId)
        // fired schedules move to their next slot by the same rule as before the upgrade
        for (const sid of dueNow) {
          const b = before.schedules.find((s) => s.id === sid)!
          expect(store.getSchedule(sid)!.nextFireAt).toBe(nextFire(JSON.parse(b.when_json), first)!.toISOString())
        }
      } finally {
        db.close()
      }
    })

    it('a second open changes nothing, and rows an older build writes afterwards (no company_id) read as Personal', () => {
      const file = path.join(tmp, 'hive.db')
      source.make(file)
      addLegacyCompanies(file)
      openDatabase(file).close()
      const dump = () => {
        const db = new Database(file, { readonly: true })
        try {
          return Object.fromEntries(['repos', 'sessions', 'workflows', 'schedules', 'runs', 'agents', 'asks', 'artifacts', 'author_drafts', 'slack_workspaces', 'secrets', 'company_passports', 'company_repos', 'company_tasks', 'meta'].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
        } finally {
          db.close()
        }
      }
      const once = dump()
      openDatabase(file).close()
      expect(dump()).toEqual(once)

      // an older build (no company columns read or written) adds a chat and a run after the upgrade
      const old = new Database(file)
      old.prepare("INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, artifacts_dir, log_path) VALUES ('sess_olderbuild', 't', 'p', 'claude', NULL, '/x', 'exited', 80, 24, ?, '/a', '/l')").run(at(0))
      old.prepare("INSERT INTO runs(id, kind, title, target_json, trigger, status, created_at, artifacts_dir) VALUES ('run_olderbuild', 'prompt', 't', '{\"kind\":\"prompt\",\"profileId\":\"p\",\"repoId\":null,\"prompt\":\"x\"}', 'manual', 'passed', ?, '/a')").run(at(0))
      old.close()
      const db = openDatabase(file)
      try {
        const store = new Store(db)
        expect(store.getSession('sess_olderbuild')?.companyId).toBe(P)
        expect(store.listSessions('all', undefined, P).map((s) => s.id)).toContain('sess_olderbuild')
        expect(store.listRuns({ companyId: P, limit: 1000 }).map((r) => r.id)).toContain('run_olderbuild')
        expect(store.listSessions('all').map((s) => s.id)).toContain('sess_olderbuild')
      } finally {
        db.close()
      }
    })
  })
}
