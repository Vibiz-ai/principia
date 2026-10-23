/** What every control plane module shares: config, db, vault, logger, events, runtime, audit and the workspace row. */
import { DEFAULT_QUOTAS, type AuditEntry, type CloudEvent, type CloudQuotas, type CloudWorkspace } from '../../shared/cloud'
import type { CloudRuntime } from '../contract'
import type { ControlDb } from './db'
import { newId } from './db'
import type { Logger, Redactor } from './log'
import type { Vault } from './vault'

export interface ControlConfig {
  /** PRINCIPIA_PUBLIC_URL without a trailing slash */
  publicUrl: string
  /** PRINCIPIA_ADMIN_TOKEN (32+ chars) or null: POST /v1/pair/start then needs a device token */
  adminToken: string | null
  workspaceName: string
  consoleDir: string
  dataDir: string
  workspaceDir: string
  logRetentionDays: number
  /** hosts a connector URL may use even when they resolve to private addresses (PRINCIPIA_CONNECTOR_ALLOW_PRIVATE) */
  connectorAllowPrivate: string[]
  passport: { internalUrl: string; publicUrl: string; adminToken: string } | null
  /**
   * PRINCIPIA_PASSPORT=embedded (one-container hosts: Render, Fly): the host's own paths (/v1/passports, /oauth,
   * /.well-known/oauth-*, /p) are proxied to it on the cloud's origin, so ChatGPT and Claude.ai reach the passport at
   * the same https URL as the console. null = a separate passport container (compose).
   */
  passportProxy?: string | null
  /** one plain line printed under a connect link only this machine can open (CLOUD.md §12.1) */
  connectHint?: string | null
  /** test seams */
  fetch?: typeof fetch
  lookup?: (host: string) => Promise<string[]>
}

export type ActorKind = AuditEntry['actor']['kind']
export interface Actor { kind: ActorKind | 'admin'; id: string | null; name: string | null }
export const SYSTEM: Actor = { kind: 'system', id: null, name: null }

/** Billing hook (CLOUD.md §10.3). The default sink does nothing; managed sends Stripe meter events later. */
export interface BillingSink {
  record(e: { workspaceId: string; metric: 'run_minutes' | 'sandbox_cpu_seconds' | 'storage_gb_day'; quantity: number; at: string }): void
}
export const NOOP_BILLING: BillingSink = { record: () => {} }

export interface Subscriber { runId: string | null; send(e: CloudEvent): void }
export class EventHub {
  private subs = new Set<Subscriber>()
  add(s: Subscriber): () => void { this.subs.add(s); return () => { this.subs.delete(s) } }
  emit(e: CloudEvent): void {
    for (const s of this.subs) {
      if (e.kind === 'log' && s.runId !== e.runId) continue
      try { s.send(e) } catch { this.subs.delete(s) }
    }
  }
  get size(): number { return this.subs.size }
}

export interface Ctx {
  config: ControlConfig
  db: ControlDb
  vault: Vault
  log: Logger
  redact: Redactor
  runtime: CloudRuntime
  events: EventHub
  billing: BillingSink
  now(): Date
  workspaceId: string
  workspace(): CloudWorkspace
  quotas(): CloudQuotas
  audit(actor: Actor, action: string, companyId: string | null, target: string | null, detail?: AuditEntry['detail']): void
  /** set by the queue: start what can start now */
  kick(): void
}

interface WorkspaceRow { id: string; name: string; created_at: string; paused: number; quotas: string; mode: string }

export function workspaceOf(db: ControlDb, publicUrl: string): CloudWorkspace {
  const w = db.get<WorkspaceRow>('SELECT * FROM workspace LIMIT 1')!
  return { id: w.id, name: w.name, createdAt: w.created_at, paused: !!w.paused, quotas: { ...DEFAULT_QUOTAS, ...JSON.parse(w.quotas) }, publicUrl, mode: w.mode === 'managed' ? 'managed' : 'self-host' }
}

export function writeAudit(db: ControlDb, redact: Redactor, now: Date, actor: Actor, action: string, companyId: string | null, target: string | null, detail: AuditEntry['detail'] = {}): void {
  const kind = actor.kind === 'admin' ? 'system' : actor.kind
  const name = actor.kind === 'admin' ? 'admin token' : actor.name
  const clean = JSON.parse(redact(JSON.stringify(detail))) as AuditEntry['detail']
  db.run('INSERT INTO audit (id, seq, at, actor_kind, actor_id, actor_name, action, company_id, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId('aud_'), db.nextSeq(), now.toISOString(), kind, actor.id, name, action, companyId, target === null ? null : redact(target), JSON.stringify(clean))
}

export function auditEntries(db: ControlDb, opts: { companyId?: string | null; limit: number }): AuditEntry[] {
  const rows = opts.companyId
    ? db.all<Record<string, string | null>>('SELECT * FROM audit WHERE company_id = ? ORDER BY seq DESC LIMIT ?', opts.companyId, opts.limit)
    : db.all<Record<string, string | null>>('SELECT * FROM audit ORDER BY seq DESC LIMIT ?', opts.limit)
  return rows.map(r => ({ at: r.at!, actor: { kind: r.actor_kind as ActorKind, id: r.actor_id, name: r.actor_name }, action: r.action!, companyId: r.company_id, target: r.target, detail: JSON.parse(r.detail!) }))
}
