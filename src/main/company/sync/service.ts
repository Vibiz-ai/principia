/**
 * LINEAR.md §5–§6: Linear sync for the app. Holds the per-company schedule (a pass at start, every minute, and about
 * five seconds after a local change), the connection lifecycle (Check Key, Connect, Sync Now, Autosync, Disconnect)
 * and the key, which lives in company_secrets, is read only here in main, and never appears in a result. A company
 * that never connected makes no request at all. No Electron imports (wire.ts plugs it into the app).
 */
import type { BoardTask } from '../../../shared/company'
import { HiveError } from '../../../shared/errors'
import { LINEAR_REJECTED, LINEAR_REJECTED_AUTOSYNC_OFF, type LinearConnectInput, type LinearKeyCheck, type LinearStatusView } from '../../../shared/linear'
import type { DB } from '../../db'
import { PassAborted, TaskSyncEngine, type SyncResult, type SyncTaskHost } from './engine'
import { SYNC_FIELDS, fingerprint, fingerprints, localValues } from './fields'
import { LinearProvider, linearKeyProblem } from './linear'
import { SyncError, type TaskSyncProvider } from './provider'
import { SyncStore, type SyncConnection } from './store'

export const START_MS = 3_000
export const POLL_MS = 60_000
export const SOON_MS = 5_000
export const MAX_BACKOFF_MS = 10 * 60_000

/** The company key behind the connection (company_secrets in the app). */
export interface LinearKeyStore {
  masked(companyId: string): string | null
  reveal(companyId: string): string | null
  save(companyId: string, value: string): void
  remove(companyId: string): void
}
export interface LinearBoard extends SyncTaskHost {
  onTaskWrite(fn: (task: BoardTask) => void): () => void
  setExternalLinks(fn: ((taskId: string) => { provider: 'linear'; key: string; url: string } | null) | null): void
  companyExists(companyId: string): boolean
  /** for the "already synced with this team" warning */
  companyName?(companyId: string): string | null
}
export interface LinearServiceDeps {
  db: DB
  board: LinearBoard
  keys: LinearKeyStore
  provider?: (key: string) => TaskSyncProvider
  /** after any change a renderer should see (tasks, links, status) */
  onChange?: (companyId: string) => void
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void }
  now?: () => Date
}

export class LinearSyncService {
  readonly store: SyncStore
  private readonly engine: TaskSyncEngine
  private readonly timers = new Map<string, { at: number; t: NodeJS.Timeout }>()
  private readonly running = new Map<string, Promise<SyncResult | null>>()
  private readonly again = new Set<string>()
  private readonly backoff = new Map<string, number>()
  private readonly providers = new Map<string, { key: string; p: TaskSyncProvider }>()
  private unlisten: (() => void) | null = null
  private stopped = false
  /** >0 while sync itself writes a task: those writes are not local changes (no extra pass, no field times) */
  private selfWriting = 0

  constructor(private readonly d: LinearServiceDeps) {
    this.store = new SyncStore(d.db)
    const own = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { this.selfWriting++; try { return fn(...a) } finally { this.selfWriting-- } }
    const b = d.board
    const host: SyncTaskHost = {
      tasks: (id) => b.tasks(id), inFlight: (t) => b.inFlight(t), depsDone: (t) => b.depsDone(t),
      createFromRemote: own((input) => b.createFromRemote(input)), applyRemote: own((id, patch, message) => b.applyRemote(id, patch, message)), note: own((id, message) => b.note(id, message))
    }
    this.engine = new TaskSyncEngine(this.store, host, d.now)
  }
  private now(): Date { return this.d.now?.() ?? new Date() }
  private makeProvider(companyId: string, key: string): TaskSyncProvider {
    const kept = this.providers.get(companyId)
    if (kept && kept.key === key) return kept.p
    const p = this.d.provider ? this.d.provider(key) : new LinearProvider(key)
    this.providers.set(companyId, { key, p })
    return p
  }

  start(): void {
    this.stopped = false
    this.d.board.setExternalLinks((taskId) => { const l = this.store.link(taskId); return l ? { provider: 'linear', key: l.key, url: l.url } : null })
    this.unlisten = this.d.board.onTaskWrite((t) => this.taskWritten(t))
    for (const c of this.store.connections()) if (c.autosync) this.schedule(c.companyId, START_MS)
  }
  stop(): void {
    this.stopped = true
    this.unlisten?.()
    this.unlisten = null
    for (const { t } of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** A local write: a linked or sendable task of an autosynced company syncs about SOON_MS later. */
  private taskWritten(t: BoardTask): void {
    if (this.selfWriting) return
    const c = this.store.connection(t.companyId)
    if (!c) return
    this.stampFields(t)
    if (!c.autosync || c.state === 'auth') return
    this.schedule(t.companyId, SOON_MS)
  }
  /** Per-field last writer wins: notes when each field of a linked task moved away from the agreed value here. */
  private stampFields(t: BoardTask): void {
    try {
      const link = this.store.link(t.id)
      if (!link) return
      const parent = t.parentId ? this.store.link(t.parentId)?.remoteId : null
      const prints = fingerprints(localValues(t, parent))
      const at = this.now().toISOString()
      for (const f of SYNC_FIELDS) {
        if (f === 'parent' && parent === undefined) continue
        if (prints[f] === link.local[f] || prints[f] === this.store.fieldPrint(t.id, f)) continue
        this.store.markLocal(t.id, f, prints[f], at)
      }
    } catch { /* a write never fails because of sync */ }
  }
  /** Keeps the earliest pending pass per company. */
  private schedule(companyId: string, ms: number): void {
    if (this.stopped) return
    const at = Date.now() + ms
    const cur = this.timers.get(companyId)
    if (cur && cur.at <= at) return
    if (cur) clearTimeout(cur.t)
    const t = setTimeout(() => { this.timers.delete(companyId); void this.pass(companyId, 'auto') }, ms)
    t.unref?.()
    this.timers.set(companyId, { at, t })
  }

  /** One pass, never two at once for a company (a request during a pass runs one more after it). */
  private pass(companyId: string, why: 'auto' | 'manual'): Promise<SyncResult | null> {
    const busy = this.running.get(companyId)
    if (busy) { this.again.add(companyId); return busy }
    const p = this.runPass(companyId, why).finally(() => {
      this.running.delete(companyId)
      if (this.again.delete(companyId)) this.schedule(companyId, 0)
    })
    this.running.set(companyId, p)
    this.d.onChange?.(companyId)
    return p
  }
  private async runPass(companyId: string, why: 'auto' | 'manual'): Promise<SyncResult | null> {
    const c = this.store.connection(companyId)
    if (!c || (why === 'auto' && !c.autosync)) return null
    const key = this.d.keys.reveal(companyId)
    if (!key) {
      this.store.patchConnection(companyId, { autosync: false, state: 'auth', message: 'The Linear key is gone from this company’s Keys. Autosync is off.' })
      this.d.onChange?.(companyId)
      return null
    }
    try {
      const r = await this.engine.run(c, this.makeProvider(companyId, key))
      this.backoff.delete(companyId)
      if (r.pulled || r.created || r.sent || r.pushed || r.applied || r.skipped || r.gone) this.d.log?.info('linear: synced', { companyId, ...r })
      if (r.skipped) this.d.log?.warn('linear: left for a later pass', { companyId, problems: r.problems.slice(0, 10) })
      return r
    } catch (e) {
      if (e instanceof PassAborted) return null
      this.failed(c, e)
      return null
    } finally {
      const now = this.store.connection(companyId)
      if (now?.autosync) this.schedule(companyId, this.backoff.get(companyId) ?? POLL_MS)
      this.d.onChange?.(companyId)
    }
  }
  private failed(c: SyncConnection, e: unknown): void {
    if (e instanceof SyncError && e.code === 'auth') {
      this.store.patchConnection(c.companyId, { autosync: false, state: 'auth', message: LINEAR_REJECTED_AUTOSYNC_OFF })
      this.d.log?.warn('linear: key turned down, autosync off', { companyId: c.companyId })
      return
    }
    const next = Math.min(MAX_BACKOFF_MS, (this.backoff.get(c.companyId) ?? POLL_MS / 2) * 2)
    this.backoff.set(c.companyId, next)
    // Offline only when Linear could not be reached or answered with a failure of its own
    const offline = e instanceof SyncError && (e.code === 'network' || e.code === 'rate_limited' || e.code === 'remote')
    const message = offline ? (e as SyncError).message
      : e instanceof SyncError && e.code === 'gone' ? `The ${c.teamName} team is gone from Linear, or this key can no longer see it. Reconnect to pick a team.`
      : 'Something went wrong syncing with Linear. Principia tries again later.'
    this.store.patchConnection(c.companyId, { state: offline ? 'network' : 'error', message })
    this.d.log?.warn('linear: sync failed, backing off', { companyId: c.companyId, code: e instanceof SyncError ? e.code : 'unknown', retryInMs: next, error: e instanceof SyncError ? undefined : String(e).slice(0, 200) })
  }

  // ---------- the IPC surface ----------

  private assertCompany(companyId: string): void {
    if (!this.d.board.companyExists(companyId)) throw new HiveError('not_found', 'Company not found')
  }

  status(companyId: string): LinearStatusView {
    this.assertCompany(companyId)
    const c = this.store.connection(companyId)
    const links: LinearStatusView['links'] = {}
    if (c) for (const l of this.store.links(companyId)) links[l.taskId] = { key: l.key, url: l.url, ...(l.remoteStatus ? { status: l.remoteStatus as NonNullable<LinearStatusView['links'][string]['status']> } : {}) }
    return {
      companyId, connected: !!c, keyMasked: c ? this.d.keys.masked(companyId) : null,
      team: c ? { id: c.teamId, key: c.teamKey, name: c.teamName } : null, workspace: c?.workspace ?? null,
      autosync: !!c?.autosync, state: c?.state ?? 'ok', message: c?.message ?? null, lastSyncedAt: c?.lastSyncedAt ?? null,
      syncing: this.running.has(companyId), linkedCount: Object.keys(links).length, links
    }
  }

  /** Check Key: the workspace's teams. A key Linear turns down answers ok:false with our sentence; nothing is saved. */
  async checkKey(companyId: string, key?: string): Promise<LinearKeyCheck> {
    this.assertCompany(companyId)
    const k = (key ?? this.d.keys.reveal(companyId) ?? '').trim()
    const problem = linearKeyProblem(k)
    if (problem) return { ok: false, workspace: null, teams: [], message: problem }
    try {
      const r = await this.makeProvider(`check:${companyId}`, k).teams()
      const teams = r.teams.map((t) => { const used = this.store.companiesOnTeam('linear', t.id, companyId).map((id) => this.d.board.companyName?.(id) ?? null).filter((n): n is string => !!n); return used.length ? { ...t, syncedWith: used } : t })
      return { ok: true, workspace: r.workspace, teams, message: r.teams.length ? null : 'This key sees no teams in Linear.' }
    } catch (e) {
      if (e instanceof SyncError && e.code === 'auth') return { ok: false, workspace: null, teams: [], message: LINEAR_REJECTED }
      return { ok: false, workspace: null, teams: [], message: e instanceof SyncError ? e.message : 'Could not reach Linear.' }
    } finally {
      this.providers.delete(`check:${companyId}`)
    }
  }

  async connect(q: LinearConnectInput): Promise<LinearStatusView> {
    this.assertCompany(q.companyId)
    const key = (q.key ?? this.d.keys.reveal(q.companyId) ?? '').trim()
    const problem = linearKeyProblem(key)
    if (problem) throw new HiveError('bad_request', problem)
    let teams
    try { teams = await this.makeProvider(`connect:${q.companyId}`, key).teams() } catch (e) {
      if (e instanceof SyncError && e.code === 'auth') throw new HiveError('bad_request', LINEAR_REJECTED)
      throw new HiveError('bad_request', e instanceof SyncError ? e.message : 'Could not reach Linear.')
    } finally { this.providers.delete(`connect:${q.companyId}`) }
    const team = teams.teams.find((t) => t.id === q.teamId)
    if (!team) throw new HiveError('bad_request', 'Pick one of the teams this key can see.')
    this.d.keys.save(q.companyId, key)
    const old = this.store.connection(q.companyId)
    const sameTeam = !!old && old.teamId === team.id
    // another team: the old team's links go first (its issues stay as tasks, unlinked)
    if (old && !sameTeam) { this.releaseStarted(q.companyId); this.store.unlinkAll(q.companyId) }
    const now = this.now().toISOString()
    this.store.saveConnection({
      companyId: q.companyId, provider: 'linear', teamId: team.id, teamKey: team.key, teamName: team.name, workspace: teams.workspace,
      autosync: q.autosync, sendFrom: q.sendOpen ? null : sameTeam ? old!.sendFrom : now, connectedAt: sameTeam ? old!.connectedAt : now,
      cursor: sameTeam ? old!.cursor : null, lastSyncedAt: sameTeam ? old!.lastSyncedAt : null, state: 'ok', message: null
    })
    this.backoff.delete(q.companyId)
    this.d.log?.info('linear: connected', { companyId: q.companyId, team: team.key, autosync: q.autosync, sendOpen: q.sendOpen })
    void this.pass(q.companyId, 'manual')
    return this.status(q.companyId)
  }

  /** Sync Now: one pass even with Autosync off; waits for it. */
  async syncNow(companyId: string): Promise<LinearStatusView> {
    this.assertCompany(companyId)
    if (!this.store.connection(companyId)) throw new HiveError('bad_request', 'Connect Linear first.')
    await this.pass(companyId, 'manual')
    return this.status(companyId)
  }

  setAutosync(companyId: string, on: boolean): LinearStatusView {
    this.assertCompany(companyId)
    const c = this.store.connection(companyId)
    if (!c) throw new HiveError('bad_request', 'Connect Linear first.')
    if (on && c.state === 'auth') throw new HiveError('bad_request', 'Linear turned down the key. Reconnect with a new one first.')
    this.store.patchConnection(companyId, { autosync: on })
    if (on) this.schedule(companyId, 0)
    else { const t = this.timers.get(companyId); if (t) { clearTimeout(t.t); this.timers.delete(companyId) } }
    this.d.onChange?.(companyId)
    return this.status(companyId)
  }

  /**
   * Before unlinking: a task that is in progress only in Linear (no run here) would look like running work with
   * nobody on it, so it goes back to Todo, with a line saying why. Nothing is sent to Linear.
   */
  private releaseStarted(companyId: string): void {
    const linked = new Map(this.store.links(companyId).map((l) => [l.taskId, l]))
    for (const t of this.d.board.tasks(companyId)) {
      const link = linked.get(t.id)
      if (!link || t.status !== 'in_progress' || t.runId) continue
      try {
        this.selfWriting++
        try { this.d.board.applyRemote(t.id, { status: 'todo' }, 'Unlinked from Linear while in progress there: moved to Todo') } finally { this.selfWriting-- }
        // remembered for a reconnect: this Todo is ours, not the founder's, so the status takes Linear's value then
        link.local.status = fingerprint('todo')
        link.remote.status = ''
        this.store.saveLink(link)
      } catch { /* left as it is */ }
    }
  }

  /** Forgets the key and the links. Tasks keep their content; nothing is sent to Linear. */
  disconnect(companyId: string): LinearStatusView {
    this.assertCompany(companyId)
    const t = this.timers.get(companyId)
    if (t) { clearTimeout(t.t); this.timers.delete(companyId) }
    this.releaseStarted(companyId)
    const n = this.store.forget(companyId)
    this.providers.delete(companyId)
    this.backoff.delete(companyId)
    try { this.d.keys.remove(companyId) } catch { /* already gone */ }
    this.d.log?.info('linear: disconnected', { companyId, unlinked: n })
    this.d.onChange?.(companyId)
    return this.status(companyId)
  }
}

