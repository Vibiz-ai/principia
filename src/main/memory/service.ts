/**
 * Main-process memory service (MEMORY.md §1, §3.4, §9, §10.7): owns memory.db migrations, implements the engine's
 * MemoryBridge (grants + brief), writes the secret fingerprint file, sweeps spawn files, and polls for changes made
 * by the MCP server processes. No Electron imports (handlers/memory.ts does dialogs), so it is unit-testable.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Id, Repo } from '../../shared/types'
import type { MemoryBridge, MemoryGrant, MemoryGrantRequest } from '../../shared/engine'
import { MEMORY_READ_TOOLS, MEMORY_SERVER_NAME, MEMORY_WRITE_TOOLS, type MemoryChangedEvent } from '../../shared/memory'
import { openMemoryDb, type MemDB } from './db'
import { MemoryStore, RowMapper, type FactRow, type GrantRow } from './store'
import type { LearnedFact } from '../../shared/live'
import { buildFingerprints, credentialHit, readFingerprintFile, redactCredentials, writeFingerprintFile, type FingerprintFile } from './screen'
import { buildBrief } from './search'

export interface MemoryServiceDeps {
  userData: string
  /** Absolute path to out/main/mcp-memory.js (unpacked when packaged). */
  serverScript: string
  /** The Hive binary (process.execPath); run with ELECTRON_RUN_AS_NODE=1. */
  execPath: string
  listRepos(): Repo[]
  /** AUTHORING.md §6.3: maps a cwd inside a Hive worktree to the same path in its source repo (null = unchanged). */
  mapCwd?(cwd: string): string | null
  redact(text: string): string
  /** Vault values for the fingerprint file (main only; never written in plaintext). */
  secretValues(): { name: string; value: string }[]
  emit(e: MemoryChangedEvent): void
  log: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
}

export function memoryPaths(userData: string) {
  const dir = path.join(userData, 'memory')
  return { dbPath: path.join(userData, 'memory.db'), dir, spawnDir: path.join(dir, 'spawn'), fpPath: path.join(dir, 'fp.json') }
}

/** Repo whose path is the longest prefix of cwd (PO2: none = read-only global). */
export function repoForCwd(repos: Repo[], cwd: string): Repo | null {
  const norm = (p: string) => p.replace(/\/+$/, '')
  const c = norm(cwd)
  let best: Repo | null = null
  for (const r of repos) {
    const rp = norm(r.path)
    if ((c === rp || c.startsWith(rp + '/')) && (!best || rp.length > norm(best.path).length)) best = r
  }
  return best
}

export class MemoryService implements MemoryBridge {
  readonly db: MemDB
  readonly store: MemoryStore
  readonly paths: ReturnType<typeof memoryPaths>
  private fpCache: FingerprintFile | null = null
  private timer: NodeJS.Timeout | null = null
  private dataVersion = -1
  private lastSeq = 0
  private lastPending = -1
  private lastChangeAt = Date.now()
  private checkpointed = true

  constructor(private deps: MemoryServiceDeps) {
    this.paths = memoryPaths(deps.userData)
    fs.mkdirSync(this.paths.spawnDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.paths.dir, 0o700)
      fs.chmodSync(this.paths.spawnDir, 0o700)
    } catch {
      /* best effort */
    }
    this.db = openMemoryDb(this.paths.dbPath, { migrate: true })
    this.store = new MemoryStore(this.db, { now: deps.now, fingerprints: () => this.fpCache })
  }

  /** Boot: close stale grants, sweep spawn files, write fingerprints, start the change poller. */
  start(opts: { poll?: boolean } = {}): void {
    const closed = this.store.closeAllOpenGrants()
    if (closed) this.deps.log.info('memory: closed grants left open by a previous run', { count: closed })
    this.sweepSpawnDir()
    this.refreshFingerprints()
    this.lastSeq = this.store.lastSeq()
    this.lastPending = this.pendingCount()
    if (opts.poll !== false) {
      this.timer = setInterval(() => this.poll(), 1000)
      this.timer.unref?.()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.store.checkpoint()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  // ---------- fingerprints (§9.1) ----------
  refreshFingerprints(): void {
    try {
      const prev = readFingerprintFile(this.paths.fpPath)
      const fp = buildFingerprints(this.deps.secretValues(), prev?.salt)
      writeFingerprintFile(this.paths.fpPath, fp)
      this.fpCache = fp
    } catch (e) {
      this.deps.log.warn('memory: could not write fingerprints', { e: String(e) })
    }
  }

  private sweepSpawnDir(): void {
    try {
      for (const f of fs.readdirSync(this.paths.spawnDir)) fs.rmSync(path.join(this.paths.spawnDir, f), { force: true })
    } catch {
      /* ignore */
    }
  }

  // ---------- MemoryBridge ----------
  grant(req: MemoryGrantRequest): MemoryGrant | null {
    try {
      const repo = repoForCwd(this.deps.listRepos(), this.deps.mapCwd?.(req.cwd) ?? req.cwd)
      const row = this.store.createGrant({
        mode: req.mode,
        adapter: req.adapter,
        transport: req.transport,
        profileId: req.profile?.id ?? null,
        profileName: req.profile?.name ?? null,
        model: req.profile?.model ?? null,
        repoId: repo?.id ?? null,
        repoName: repo?.name ?? null,
        runId: req.runId ?? null,
        runTitle: req.runTitle ?? null,
        workflowId: req.workflowId ?? null,
        stepId: req.stepId ?? null,
        nodeId: req.nodeId ?? null,
        nodeLabel: req.nodeLabel ?? null,
        sessionId: req.sessionId ?? null
      })
      const canWrite = req.mode === 'read-write' && !!repo
      const vis = repo ? ({ kind: 'repo', repoId: repo.id } as const) : ({ kind: 'global' } as const)
      const brief = buildBrief(
        this.store,
        { vis, scopeLabel: repo ? `${repo.name} project + global` : 'global', query: req.briefQuery, transport: req.transport },
        (s) => this.deps.redact(s)
      )
      return {
        grantId: row.id,
        server: this.serverSpec(row),
        toolNames: [...MEMORY_READ_TOOLS, ...(canWrite ? MEMORY_WRITE_TOOLS : [])],
        spawnDir: this.paths.spawnDir,
        brief
      }
    } catch (e) {
      this.deps.log.warn('memory: grant failed; spawning without memory', { e: String(e) })
      return null
    }
  }

  serverSpec(g: Pick<GrantRow, 'id'>): MemoryGrant['server'] {
    return {
      name: MEMORY_SERVER_NAME,
      command: this.deps.execPath,
      args: [this.deps.serverScript],
      env: { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_DB: this.paths.dbPath, HIVE_MEM_GRANT: g.id, HIVE_MEM_FP: this.paths.fpPath }
    }
  }

  /** hivemem with an empty grant (LIVE.md §4.2): only ask_user is listed and memory.db is never opened. */
  askOnlyServer(): MemoryGrant['server'] {
    return this.serverSpec({ id: '' })
  }

  /** "What agents learned" (LIVE.md §8): agent facts created since, active|pending, newest first. */
  factsSince(since: string, limit = 10): LearnedFact[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, e.name AS entity_name, g.repo_name AS g_repo_name, g.run_id AS g_run_id, g.run_title AS g_run_title
         FROM mem_fact f JOIN mem_entity e ON e.id = f.entity_id LEFT JOIN mem_grant g ON g.id = f.grant_id
         WHERE f.actor = 'agent' AND f.status IN ('active','pending') AND f.created_at >= ?
         ORDER BY f.created_at DESC LIMIT ?`
      )
      .all(since, Math.min(Math.max(limit, 1), 100)) as (FactRow & {
      entity_name: string
      g_repo_name: string | null
      g_run_id: string | null
      g_run_title: string | null
    })[]
    const map = new RowMapper(this.store, (t) => this.deps.redact(t))
    const facts = map.facts(rows)
    const repos = this.deps.listRepos()
    return rows.map((r, i) => ({
      fact: facts[i],
      entityName: this.deps.redact(r.entity_name),
      repoName: (r.repo_id ? repos.find((x) => x.id === r.repo_id)?.name : null) ?? r.g_repo_name ?? null,
      runId: r.g_run_id,
      runTitle: r.g_run_title ? this.deps.redact(r.g_run_title) : null
    }))
  }

  release(grantId: Id): void {
    try {
      this.store.closeGrant(grantId)
    } catch (e) {
      this.deps.log.warn('memory: release failed', { e: String(e) })
    }
    try {
      for (const f of fs.readdirSync(this.paths.spawnDir)) {
        if (f.startsWith(`${grantId}.`)) fs.rmSync(path.join(this.paths.spawnDir, f), { force: true })
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- change feed (§10.7) ----------
  private pendingCount(): number {
    return (
      this.db.prepare(
        "SELECT (SELECT count(*) FROM mem_fact WHERE status = 'pending') + (SELECT count(*) FROM mem_relation WHERE status = 'pending') AS n"
      ).get() as { n: number }
    ).n
  }

  /** 1 s tick: PRAGMA data_version sees commits from the server processes; main's own writes call flush(). */
  poll(): void {
    try {
      const v = Number(this.db.pragma('data_version', { simple: true }))
      if (v !== this.dataVersion) {
        this.dataVersion = v
        this.flush()
      } else if (!this.checkpointed && Date.now() - this.lastChangeAt > 60_000) {
        this.store.checkpoint()
        this.checkpointed = true
      }
    } catch (e) {
      this.deps.log.warn('memory: poll failed', { e: String(e) })
    }
  }

  /** Reads mem_event rows after lastSeq, re-screens new agent text (§9), emits memory:changed. */
  flush(): MemoryChangedEvent | null {
    const rows = this.db
      .prepare('SELECT seq, op, target_kind, target_id, entity_id, actor, run_id FROM mem_event WHERE seq > ? ORDER BY seq')
      .all(this.lastSeq) as { seq: number; op: string; target_kind: string; target_id: string; entity_id: string | null; actor: string; run_id: string | null }[]
    if (!rows.length) return null
    this.lastSeq = rows[rows.length - 1].seq
    this.lastChangeAt = Date.now()
    this.checkpointed = false
    for (const r of rows) {
      if (r.actor !== 'agent' || r.op !== 'create' || r.target_kind !== 'fact') continue
      const f = this.store.factRow(r.target_id)
      if (!f || f.status === 'invalid') continue
      const vaultRed = this.deps.redact(f.text)
      const cred = credentialHit(vaultRed)
      const red = cred ? redactCredentials(vaultRed) : vaultRed
      if (red !== f.text) {
        const name = /••••([A-Z_][A-Z0-9_]*)/.exec(vaultRed)?.[1] ?? cred ?? 'secret'
        this.store.quarantineSecretFact(f.id, red, name)
        this.deps.log.warn('memory: quarantined an agent fact containing a secret', { factId: f.id, secret: name })
      }
    }
    const pending = this.pendingCount()
    const ev: MemoryChangedEvent = {
      seq: this.store.lastSeq(),
      runIds: [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))],
      entityIds: [...new Set(rows.map((r) => r.entity_id).filter((x): x is string => !!x))],
      pendingDelta: pending !== this.lastPending
    }
    this.lastPending = pending
    this.lastSeq = Math.max(this.lastSeq, ev.seq)
    this.deps.emit(ev)
    return ev
  }
}

/**
 * Path of the bundled MCP server next to the main bundle (out/main/mcp-memory.js). In a packaged app the script is
 * asar-unpacked when that copy exists; Electron-as-node can also run it straight from app.asar.
 */
export function resolveServerScript(mainDir: string): string {
  const p = path.join(mainDir, 'mcp-memory.js')
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p
}
