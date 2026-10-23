/**
 * DASHBOARDS.md §2: installed dashboards over hive.db. One row per installed dashboard (a company, optionally a
 * department, a catalog kind and its non-secret config), with the last status and the last good snapshot as JSON so a
 * restart shows numbers immediately. Keys are not stored here: they live in the company's keys (company_secrets). The
 * table is created here, like the Forum's, so older builds simply ignore it. No Electron imports.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { DashboardConfig, DashboardKind, DashboardSnapshot, DashboardStatus } from '../../shared/dashboards'
import { DASHBOARD_KINDS } from '../../shared/dashboards'
import { HiveError } from '../../shared/errors'

type DB = Database.Database

export const DDL_DASHBOARDS = /* sql */ `
CREATE TABLE IF NOT EXISTS company_dashboards (
  id            TEXT PRIMARY KEY,          -- 'dsh_…'
  company_id    TEXT NOT NULL,
  department_id TEXT,                      -- null = company-level
  kind          TEXT NOT NULL,             -- catalog id (shared/dashboards.ts)
  config        TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT '{"state":"never"}',
  snapshot      TEXT,                      -- last good DashboardSnapshot
  fetched_at    TEXT,                      -- last attempt (good or not)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS company_dashboards_dept ON company_dashboards(company_id, department_id);
`

export interface DashboardRow {
  id: string
  companyId: string
  departmentId: string | null
  kind: DashboardKind
  config: DashboardConfig
  status: DashboardStatus
  snapshot: DashboardSnapshot | null
  fetchedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Raw {
  id: string
  company_id: string
  department_id: string | null
  kind: string
  config: string
  status: string
  snapshot: string | null
  fetched_at: string | null
  created_at: string
  updated_at: string
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const toRow = (r: Raw): DashboardRow => ({
  id: r.id,
  companyId: r.company_id,
  departmentId: r.department_id,
  kind: r.kind as DashboardKind,
  config: parse<DashboardConfig>(r.config, {}),
  status: parse<DashboardStatus>(r.status, { state: 'never' }),
  snapshot: parse<DashboardSnapshot | null>(r.snapshot, null),
  fetchedAt: r.fetched_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export function dashboardId(): string {
  let s = ''
  for (const b of randomBytes(10)) s += ALPHABET[b % 36]
  return `dsh_${s}`
}

export class DashboardStore {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {
    db.exec(DDL_DASHBOARDS)
  }

  /** A company's dashboards (rows of unknown kinds, from a newer build, are skipped). */
  list(companyId?: string, departmentId?: string | null): DashboardRow[] {
    const rows = (
      companyId
        ? departmentId !== undefined
          ? departmentId === null
            ? this.db.prepare('SELECT * FROM company_dashboards WHERE company_id = ? AND department_id IS NULL ORDER BY sort_order, created_at').all(companyId)
            : this.db.prepare('SELECT * FROM company_dashboards WHERE company_id = ? AND department_id = ? ORDER BY sort_order, created_at').all(companyId, departmentId)
          : this.db.prepare('SELECT * FROM company_dashboards WHERE company_id = ? ORDER BY sort_order, created_at').all(companyId)
        : this.db.prepare('SELECT * FROM company_dashboards ORDER BY company_id, sort_order, created_at').all()
    ) as Raw[]
    return rows.filter((r) => (DASHBOARD_KINDS as readonly string[]).includes(r.kind)).map(toRow)
  }

  get(id: string): DashboardRow {
    const r = this.db.prepare('SELECT * FROM company_dashboards WHERE id = ?').get(id) as Raw | undefined
    if (!r || !(DASHBOARD_KINDS as readonly string[]).includes(r.kind)) throw new HiveError('not_found', 'Dashboard not found')
    return toRow(r)
  }

  create(input: { companyId: string; departmentId: string | null; kind: DashboardKind; config: DashboardConfig }): DashboardRow {
    const id = dashboardId()
    const ts = this.now().toISOString()
    const order = (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM company_dashboards WHERE company_id = ?').get(input.companyId) as { n: number }).n
    this.db
      .prepare('INSERT INTO company_dashboards(id, company_id, department_id, kind, config, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.companyId, input.departmentId, input.kind, JSON.stringify(input.config), order, ts, ts)
    return this.get(id)
  }

  updateConfig(id: string, config: DashboardConfig): DashboardRow {
    this.db.prepare('UPDATE company_dashboards SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), this.now().toISOString(), id)
    return this.get(id)
  }

  /** A finished attempt: the status always, the snapshot only when it succeeded (a failure keeps the last good numbers). */
  recordFetch(id: string, status: DashboardStatus, snapshot?: DashboardSnapshot): void {
    const ts = this.now().toISOString()
    if (snapshot) this.db.prepare('UPDATE company_dashboards SET status = ?, snapshot = ?, fetched_at = ? WHERE id = ?').run(JSON.stringify(status), JSON.stringify(snapshot), ts, id)
    else this.db.prepare('UPDATE company_dashboards SET status = ?, fetched_at = ? WHERE id = ?').run(JSON.stringify(status), ts, id)
  }

  setStatus(id: string, status: DashboardStatus): void {
    this.db.prepare('UPDATE company_dashboards SET status = ? WHERE id = ?').run(JSON.stringify(status), id)
  }

  remove(id: string): void {
    const r = this.db.prepare('DELETE FROM company_dashboards WHERE id = ?').run(id)
    if (!r.changes) throw new HiveError('not_found', 'Dashboard not found')
  }
}
