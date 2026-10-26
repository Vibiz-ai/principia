/**
 * LINEAR.md §4: what sync remembers, in two tables of hive.db that only this module touches. A connection per company
 * (the team, autosync, the cursor, the last error) and a link per task (the issue, and the fingerprint of every field
 * on both sides as they last agreed). No key is stored here: it is a company key (company_secrets).
 */
import type { DB } from '../../db'
import type { SyncProviderKind } from './provider'

/** ok; auth: the key was turned down; network: Linear could not be reached; error: something else went wrong */
export type SyncState = 'ok' | 'auth' | 'network' | 'error'
export interface SyncConnection {
  companyId: string
  provider: SyncProviderKind
  teamId: string
  teamKey: string
  teamName: string
  workspace: string | null
  autosync: boolean
  /** tasks created at or after this moment go out; null = every open task (Also send open tasks) */
  sendFrom: string | null
  connectedAt: string
  /** the newest remote updatedAt pulled; null until the first pull */
  cursor: string | null
  lastSyncedAt: string | null
  state: SyncState
  message: string | null
}
export type Fingerprints = Record<string, string>
export interface SyncLink {
  taskId: string
  companyId: string
  provider: SyncProviderKind
  remoteId: string
  /** "ENG-123" */
  key: string
  url: string
  /** the issue's state as last seen (kept when it already means the status being sent) */
  stateId: string | null
  local: Fingerprints
  remote: Fingerprints
  remoteUpdatedAt: string | null
  /** the issue's status in Board terms as last seen ("in review in Linear" on the card) */
  remoteStatus?: string | null
}

export class SyncStore {
  constructor(private readonly db: DB) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_sync_connections (company_id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_sync_links (task_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL, remote_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_sync_links_remote ON task_sync_links(company_id, provider, remote_id);
      CREATE TABLE IF NOT EXISTS task_sync_seen (company_id TEXT NOT NULL, provider TEXT NOT NULL, remote_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (company_id, provider, remote_id));
      CREATE TABLE IF NOT EXISTS task_sync_field_times (task_id TEXT NOT NULL, field TEXT NOT NULL, print TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, field));`)
    // the link as it was at the disconnect (its fingerprints), so a reconnect sends only what changed since
    const cols = (db.prepare('PRAGMA table_info(task_sync_seen)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('data')) db.exec('ALTER TABLE task_sync_seen ADD COLUMN data TEXT')
  }

  connection(companyId: string): SyncConnection | null {
    const r = this.db.prepare('SELECT data FROM task_sync_connections WHERE company_id = ?').get(companyId) as { data: string } | undefined
    if (!r) return null
    try { return JSON.parse(r.data) as SyncConnection } catch { return null }
  }
  connections(): SyncConnection[] {
    return (this.db.prepare('SELECT data FROM task_sync_connections').all() as { data: string }[]).flatMap((r) => { try { return [JSON.parse(r.data) as SyncConnection] } catch { return [] } })
  }
  saveConnection(c: SyncConnection): SyncConnection {
    this.db.prepare('INSERT INTO task_sync_connections(company_id, provider, data) VALUES (?,?,?) ON CONFLICT(company_id) DO UPDATE SET provider = excluded.provider, data = excluded.data').run(c.companyId, c.provider, JSON.stringify(c))
    return c
  }
  patchConnection(companyId: string, patch: Partial<SyncConnection>): SyncConnection | null {
    const c = this.connection(companyId)
    return c ? this.saveConnection({ ...c, ...patch, companyId }) : null
  }
  /** Forgets the connection and every link of the company. Tasks stay as they are. */
  forget(companyId: string): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_sync_connections WHERE company_id = ?').run(companyId)
      return this.unlinkAll(companyId)
    })()
  }
  /**
   * Unlinks every task of the company. Which task an issue was stays remembered (task_sync_seen), so connecting
   * again finds the same task instead of bringing the issue over twice.
   */
  unlinkAll(companyId: string): number {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO task_sync_seen(company_id, provider, remote_id, task_id, data) SELECT company_id, provider, remote_id, task_id, data FROM task_sync_links WHERE company_id = ?').run(companyId)
      return this.db.prepare('DELETE FROM task_sync_links WHERE company_id = ?').run(companyId).changes
    })()
  }
  /** The task an issue was linked to before a disconnect, and the link as it was then (null: never seen). */
  seen(companyId: string, provider: string, remoteId: string): { taskId: string; link: SyncLink | null } | null {
    const r = this.db.prepare('SELECT task_id, data FROM task_sync_seen WHERE company_id = ? AND provider = ? AND remote_id = ?').get(companyId, provider, remoteId) as { task_id: string; data: string | null } | undefined
    if (!r) return null
    let link: SyncLink | null = null
    try { link = r.data ? JSON.parse(r.data) as SyncLink : null } catch { link = null }
    return { taskId: r.task_id, link }
  }
  seenTask(companyId: string, provider: string, remoteId: string): string | null { return this.seen(companyId, provider, remoteId)?.taskId ?? null }
  /** One task unlinked for good (its issue is gone): not remembered for a reconnect either. */
  dropLink(taskId: string): void {
    this.db.transaction(() => {
      const l = this.link(taskId)
      this.db.prepare('DELETE FROM task_sync_links WHERE task_id = ?').run(taskId)
      if (l) this.db.prepare('DELETE FROM task_sync_seen WHERE company_id = ? AND provider = ? AND remote_id = ?').run(l.companyId, l.provider, l.remoteId)
      this.db.prepare('DELETE FROM task_sync_field_times WHERE task_id = ?').run(taskId)
    })()
  }

  /**
   * LINEAR.md §3 per-field last writer wins: when a field of a linked task last changed here. Recorded on each local
   * write whose value differs from the agreed one; read only while the value is still the one recorded.
   */
  markLocal(taskId: string, field: string, print: string, at: string): void {
    this.db.prepare('INSERT INTO task_sync_field_times(task_id, field, print, at) VALUES (?,?,?,?) ON CONFLICT(task_id, field) DO UPDATE SET print = excluded.print, at = excluded.at').run(taskId, field, print, at)
  }
  fieldPrint(taskId: string, field: string): string | null {
    return (this.db.prepare('SELECT print FROM task_sync_field_times WHERE task_id = ? AND field = ?').get(taskId, field) as { print: string } | undefined)?.print ?? null
  }
  fieldTime(taskId: string, field: string, print: string): string | null {
    return (this.db.prepare('SELECT at FROM task_sync_field_times WHERE task_id = ? AND field = ? AND print = ?').get(taskId, field, print) as { at: string } | undefined)?.at ?? null
  }
  /** The other companies synced with this team (one team, one Board). */
  companiesOnTeam(provider: string, teamId: string, except: string): string[] {
    return this.connections().filter((c) => c.provider === provider && c.teamId === teamId && c.companyId !== except).map((c) => c.companyId)
  }

  links(companyId: string): SyncLink[] {
    return (this.db.prepare('SELECT data FROM task_sync_links WHERE company_id = ? ORDER BY rowid').all(companyId) as { data: string }[]).flatMap((r) => { try { return [JSON.parse(r.data) as SyncLink] } catch { return [] } })
  }
  link(taskId: string): SyncLink | null {
    const r = this.db.prepare('SELECT data FROM task_sync_links WHERE task_id = ?').get(taskId) as { data: string } | undefined
    if (!r) return null
    try { return JSON.parse(r.data) as SyncLink } catch { return null }
  }
  saveLink(l: SyncLink): SyncLink {
    // one issue, one task: a stale link that still names this issue (the tracker reused the id) gives way
    this.db.prepare('DELETE FROM task_sync_links WHERE company_id = ? AND provider = ? AND remote_id = ? AND task_id <> ?').run(l.companyId, l.provider, l.remoteId, l.taskId)
    this.db.prepare(`INSERT INTO task_sync_links(task_id, company_id, provider, remote_id, data) VALUES (?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, provider = excluded.provider, remote_id = excluded.remote_id, data = excluded.data`).run(l.taskId, l.companyId, l.provider, l.remoteId, JSON.stringify(l))
    return l
  }
  count(companyId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM task_sync_links WHERE company_id = ?').get(companyId) as { n: number }).n
  }
}
