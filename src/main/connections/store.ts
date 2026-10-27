/**
 * CONNECTIONS.md §3.1: `company_connections`, one row per service per company. It holds choices only: which gateway
 * connection serves the service, which key serves which purpose, the service's non-secret settings (PostHog's host and
 * project), and reuse from another company. Never a credential: keys stay in the vault / company_secrets, MCP
 * connections in mcp-connections.json. Status is always computed live (resolver.ts). The table is created here, like
 * the dashboards', so older builds ignore it. No Electron imports.
 */
import type Database from 'better-sqlite3'
import { connectionsFor, type GatewayConnection } from '../../shared/gateway'
import { serviceById, serviceForConnection } from '../../shared/services'
import { dashboardDef } from '../../shared/dashboards'
import type { Purpose } from '../../shared/services'

type DB = Database.Database

export const DDL_CONNECTIONS = /* sql */ `
CREATE TABLE IF NOT EXISTS company_connections (
  company_id        TEXT NOT NULL,
  service_id        TEXT NOT NULL,             -- registry id (shared/services.ts)
  settings          TEXT NOT NULL DEFAULT '{}',-- non-secret: { host, projectId } …
  mcp_connection_id TEXT,                      -- the gateway connection that serves it here
  key_choice        TEXT NOT NULL DEFAULT '{}',-- { purpose: KEY_NAME }
  source_company_id TEXT,                      -- reused from this company ("Also use in…")
  hidden            INTEGER NOT NULL DEFAULT 0,
  mcp_confirmed     INTEGER NOT NULL DEFAULT 0,  -- the founder picked mcp_connection_id ("looks like PostHog?" → Use it)
  key_problems      TEXT NOT NULL DEFAULT '{}',  -- { KEY_NAME: { reason, at, purpose? } } a vendor turned the key down
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (company_id, service_id)
);
`

export interface ConnectionRow {
  companyId: string
  serviceId: string
  settings: Record<string, string>
  mcpConnectionId: string | null
  keyChoice: Partial<Record<Purpose, string>>
  sourceCompanyId: string | null
  hidden: boolean
  /** the founder linked mcpConnectionId themselves (a look-alike counts for agent tools only then) */
  mcpConfirmed: boolean
  /** keys a vendor turned down (an add-dashboard check, an agent's call): never a value */
  keyProblems: Record<string, KeyProblem>
  createdAt: string
  updatedAt: string
}

/** A vendor turned a key down. `purpose`: only for that (a dashboard's missing permission); absent = the key is off. */
export interface KeyProblem {
  reason: string
  at: string
  purpose?: Purpose
}

interface Raw {
  company_id: string
  service_id: string
  settings: string
  mcp_connection_id: string | null
  key_choice: string
  source_company_id: string | null
  hidden: number
  mcp_confirmed?: number
  key_problems?: string
  created_at: string
  updated_at: string
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}
const toRow = (r: Raw): ConnectionRow => ({
  companyId: r.company_id,
  serviceId: r.service_id,
  settings: parse<Record<string, string>>(r.settings, {}),
  mcpConnectionId: r.mcp_connection_id,
  keyChoice: parse<Partial<Record<Purpose, string>>>(r.key_choice, {}),
  sourceCompanyId: r.source_company_id,
  hidden: !!r.hidden,
  mcpConfirmed: !!r.mcp_confirmed,
  keyProblems: parse<Record<string, KeyProblem>>(r.key_problems ?? null, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** A settings value is plain text, capped. */
export const SETTING_MAX = 300
export function cleanSettings(serviceId: string, raw: Record<string, unknown>): Record<string, string> {
  const allowed = new Set((serviceById(serviceId)?.settings ?? []).map((s) => s.key))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k) || typeof v !== 'string') continue
    // eslint-disable-next-line no-control-regex
    const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, SETTING_MAX)
    if (t) out[k] = t
  }
  return out
}

export type ConnectionPatch = Partial<Pick<ConnectionRow, 'settings' | 'mcpConnectionId' | 'keyChoice' | 'sourceCompanyId' | 'hidden' | 'mcpConfirmed' | 'keyProblems'>>

export class ConnectionStore {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {
    db.exec(DDL_CONNECTIONS)
    // columns added after the first release of the table (older rows: not confirmed, no problems)
    const cols = new Set((db.prepare('PRAGMA table_info(company_connections)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('mcp_confirmed')) db.exec('ALTER TABLE company_connections ADD COLUMN mcp_confirmed INTEGER NOT NULL DEFAULT 0')
    if (!cols.has('key_problems')) db.exec("ALTER TABLE company_connections ADD COLUMN key_problems TEXT NOT NULL DEFAULT '{}'")
  }

  get(companyId: string, serviceId: string): ConnectionRow | null {
    const r = this.db.prepare('SELECT * FROM company_connections WHERE company_id = ? AND service_id = ?').get(companyId, serviceId) as Raw | undefined
    return r ? toRow(r) : null
  }
  list(companyId?: string): ConnectionRow[] {
    const rows = companyId ? this.db.prepare('SELECT * FROM company_connections WHERE company_id = ? ORDER BY service_id').all(companyId) : this.db.prepare('SELECT * FROM company_connections ORDER BY company_id, service_id').all()
    return (rows as Raw[]).map(toRow)
  }

  /** Creates or merges one row. `settings` merges key by key (an empty string clears that key). */
  patch(companyId: string, serviceId: string, p: ConnectionPatch): ConnectionRow {
    const ts = this.now().toISOString()
    const old = this.get(companyId, serviceId)
    const settings = { ...(old?.settings ?? {}) }
    for (const [k, v] of Object.entries(p.settings ?? {})) if (v) settings[k] = v; else delete settings[k]
    const next = {
      settings,
      mcpConnectionId: p.mcpConnectionId !== undefined ? p.mcpConnectionId : (old?.mcpConnectionId ?? null),
      keyChoice: p.keyChoice !== undefined ? p.keyChoice : (old?.keyChoice ?? {}),
      sourceCompanyId: p.sourceCompanyId !== undefined ? p.sourceCompanyId : (old?.sourceCompanyId ?? null),
      hidden: p.hidden !== undefined ? p.hidden : (old?.hidden ?? false),
      mcpConfirmed: p.mcpConfirmed !== undefined ? p.mcpConfirmed : p.mcpConnectionId !== undefined ? false : (old?.mcpConfirmed ?? false),
      keyProblems: p.keyProblems !== undefined ? p.keyProblems : (old?.keyProblems ?? {})
    }
    this.db
      .prepare(
        `INSERT INTO company_connections (company_id, service_id, settings, mcp_connection_id, key_choice, source_company_id, hidden, mcp_confirmed, key_problems, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(company_id, service_id) DO UPDATE SET settings = excluded.settings, mcp_connection_id = excluded.mcp_connection_id,
           key_choice = excluded.key_choice, source_company_id = excluded.source_company_id, hidden = excluded.hidden,
           mcp_confirmed = excluded.mcp_confirmed, key_problems = excluded.key_problems, updated_at = excluded.updated_at`
      )
      .run(companyId, serviceId, JSON.stringify(next.settings), next.mcpConnectionId, JSON.stringify(next.keyChoice), next.sourceCompanyId, next.hidden ? 1 : 0, next.mcpConfirmed ? 1 : 0, JSON.stringify(next.keyProblems), old?.createdAt ?? ts, ts)
    return this.get(companyId, serviceId)!
  }

  /** Forget a company's rows (the company was deleted), and every other company's reuse of it. */
  removeCompany(companyId: string): void {
    this.db.prepare('DELETE FROM company_connections WHERE company_id = ?').run(companyId)
    this.clearReuseFrom(companyId)
  }

  /** The companies that read `companyId`'s connection to `serviceId` ("Also use in…"), or to any service. */
  borrowers(companyId: string, serviceId?: string): { companyId: string; serviceId: string }[] {
    const rows = (serviceId
      ? this.db.prepare('SELECT company_id, service_id FROM company_connections WHERE source_company_id = ? AND service_id = ?').all(companyId, serviceId)
      : this.db.prepare('SELECT company_id, service_id FROM company_connections WHERE source_company_id = ?').all(companyId)) as { company_id: string; service_id: string }[]
    return rows.map((r) => ({ companyId: r.company_id, serviceId: r.service_id }))
  }

  /**
   * SEC-9: the source company was archived or deleted: every reuse of it stops for good (un-archiving never turns it
   * back on silently; each company chooses again). Returns the companies that lost a connection.
   */
  clearReuseFrom(sourceCompanyId: string): string[] {
    const hit = this.borrowers(sourceCompanyId)
    if (hit.length) this.db.prepare('UPDATE company_connections SET source_company_id = NULL, updated_at = ? WHERE source_company_id = ?').run(this.now().toISOString(), sourceCompanyId)
    return [...new Set(hit.map((h) => h.companyId))]
  }

  /**
   * CONNECTIONS.md §3.5: derive, never move. Links each company's gateway connections to their service (when the row has
   * none yet) and copies installed dashboards' non-secret settings (projectId, host, siteId, siteUrl) when empty.
   * Touches nothing else: keys keep their names and rows, gateway configs keep their companyIds. Idempotent.
   */
  backfill(input: { companyIds: readonly string[]; gateway: readonly GatewayConnection[]; dashboards: readonly { companyId: string; kind: string; config: Record<string, string | string[]> }[] }): { companies: number; links: number; settings: number } {
    let links = 0
    let settings = 0
    const tx = this.db.transaction(() => {
      for (const companyId of input.companyIds) {
        for (const c of connectionsFor(input.gateway, companyId)) {
          const svc = serviceForConnection(c)
          if (!svc) continue
          const row = this.get(companyId, svc.id)
          // a link stands when the founder chose it or it is still that service's own URL; an older look-alike link (by
          // name, before exact URLs) is replaced
          const linked = row?.mcpConnectionId ? input.gateway.find((g) => g.id === row.mcpConnectionId) : undefined
          if (row?.mcpConnectionId && (row.mcpConfirmed || (linked && serviceForConnection(linked)?.id === svc.id))) continue
          if (row?.mcpConnectionId === c.id) continue
          this.patch(companyId, svc.id, { mcpConnectionId: c.id })
          links++
        }
      }
      const known = new Set(input.companyIds)
      for (const d of input.dashboards) {
        if (!known.has(d.companyId)) continue
        const def = dashboardDef(d.kind)
        for (const sid of def?.services ?? []) {
          const fields = serviceById(sid)?.settings ?? []
          if (!fields.length) continue
          const row = this.get(d.companyId, sid)
          const add: Record<string, string> = {}
          for (const f of fields) {
            const v = d.config[f.key]
            if (typeof v === 'string' && v.trim() && !row?.settings[f.key]) add[f.key] = v.trim().slice(0, SETTING_MAX)
          }
          if (Object.keys(add).length) {
            this.patch(d.companyId, sid, { settings: add })
            settings++
          }
        }
      }
    })
    tx()
    return { companies: input.companyIds.length, links, settings }
  }
}
