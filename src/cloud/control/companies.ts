/**
 * Companies (CLOUD.md §7.1, §7.3, §7.4): the Passport connected by default, company keys (names only out), and repos
 * (fine-grained PAT or public in v1). Every child id is looked up inside its own company, so a cross-company id is 404.
 */
import { z } from 'zod'
import {
  CLOUD_ADAPTERS, CLOUD_LIMITS,
  type CloudCompany, type CloudPassportLink, type CloudRepo, type CloudSecretMeta, type PassportProposal, type PutCompanyResponse
} from '../../shared/cloud'
import type { RepoMaterial } from '../contract'
import type { Actor, Ctx } from './context'
import type { Connections } from './connections'
import { ApiError, badRequest, notFound, notInV1 } from './http'
import { DESKTOP_SCOPES, OWNER_SCOPES, RUNTIME_SCOPES, toProposal, type PassportHost } from './passportHost'
import { credentialRow, credentialStatus } from './providers'
import { computeReadiness } from './readiness'
import type { WorkflowDeps } from './deps'

export const COMPANY_ID = /^[A-Za-z0-9_.-]{1,128}$/
export const CHILD_ID = /^[A-Za-z0-9_.-]{1,128}$/
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/
const PASSPORT_CACHE_MS = 30_000

export interface CompanyRow {
  id: string; name: string; slug: string; color: string | null; created_at: string; paused: number; cloud_agent_writes: string
  passport_id: string | null; passport_revision: number | null; passport_seq: number
  desktop_grant_id: string | null; runtime_grant_id: string | null; runtime_grant_ct: string | null; owner_grant_id: string | null; owner_grant_ct: string | null
}
interface RepoRow { company_id: string; id: string; name: string; url: string; branch: string | null; credential_kind: string; credential_ct: string | null; synced_at: string | null; status: string; detail: string | null; last_sync_ok: number | null }

const putSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100),
  color: z.string().max(32).nullable().optional(),
  passportBundle: z.string().optional(),
  cloudAgentWrites: z.enum(['propose', 'trusted']).optional()
})
const patchSchema = z.object({ paused: z.boolean().optional(), cloudAgentWrites: z.enum(['propose', 'trusted']).optional() })
const repoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().max(300),
  branch: z.string().trim().max(200).regex(/^[^\s~^:?*[\\]+$/).nullable().optional(),
  credential: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('github_pat'), value: z.string().trim().min(1).max(1000) }),
    z.object({ kind: z.literal('github_app'), installationId: z.number() }),
    z.object({ kind: z.literal('public') })
  ])
})

export interface CompanyDeps {
  host: PassportHost | null
  connections: Connections
  /** cancels queued and running runs of a company (pause, delete) */
  cancelCompanyRuns(cid: string, reason: string): Promise<void>
}

export function createCompanies(ctx: Ctx, deps: CompanyDeps) {
  const cache = new Map<string, { at: number; revision: number | null; pending: number }>()
  const creating = new Set<string>()
  const companyRow = (cid: string) => ctx.db.get<CompanyRow>('SELECT * FROM companies WHERE id = ?', cid)
  function must(cid: string): CompanyRow { const r = COMPANY_ID.test(cid) ? companyRow(cid) : undefined; if (!r) throw notFound('No such company in this cloud.'); return r }
  const ownerToken = (r: CompanyRow) => (r.owner_grant_ct && r.owner_grant_id ? ctx.vault.decrypt('passport-grant', r.owner_grant_id, r.owner_grant_ct) : null)
  const mcpUrl = (pid: string) => `${deps.host!.publicUrl}/v1/passports/${encodeURIComponent(pid)}/mcp`

  /** revision and pending proposals from the host, cached 30 s; a new revision bumps the sync cursor */
  async function refreshPassport(r: CompanyRow, force = false): Promise<void> {
    if (!deps.host || !r.passport_id) return
    const c = cache.get(r.id)
    if (!force && c && Date.now() - c.at < PASSPORT_CACHE_MS) return
    const token = ownerToken(r)
    if (!token) return
    try {
      const [revision, proposals] = await Promise.all([deps.host.revision(r.passport_id, token), deps.host.proposals(r.passport_id, token)])
      cache.set(r.id, { at: Date.now(), revision, pending: proposals.length })
      if (revision !== r.passport_revision) ctx.db.run('UPDATE companies SET passport_revision = ?, passport_seq = ? WHERE id = ?', revision, ctx.db.nextSeq(), r.id)
    } catch {
      cache.set(r.id, { at: Date.now(), revision: c?.revision ?? r.passport_revision, pending: c?.pending ?? 0 })
    }
  }

  function passportLink(r: CompanyRow): CloudPassportLink | null {
    if (!deps.host || !r.passport_id) return null
    const c = cache.get(r.id)
    return { hostUrl: deps.host.publicUrl, passportId: r.passport_id, mcpUrl: mcpUrl(r.passport_id), revision: c?.revision ?? r.passport_revision, pendingProposals: c?.pending ?? 0 }
  }

  function readiness(r: CompanyRow, hostUp: boolean) {
    const wfs = ctx.db.all<{ id: string; name: string; problems: string; deps: string }>('SELECT id, name, problems, deps FROM workflows WHERE company_id = ? ORDER BY id', r.id)
    const now = ctx.now()
    const rows = Object.fromEntries(CLOUD_ADAPTERS.map(a => [a, credentialRow(ctx, a)]))
    const providers = Object.fromEntries(CLOUD_ADAPTERS.map(a => [a, credentialStatus(rows[a], now)])) as Parameters<typeof computeReadiness>[0]['providers']
    return computeReadiness({
      workflows: wfs.map(w => ({ id: w.id, name: w.name, problems: JSON.parse(w.problems) as string[], deps: JSON.parse(w.deps) as WorkflowDeps })),
      providers,
      providerDetails: Object.fromEntries(CLOUD_ADAPTERS.map(a => [a, rows[a]?.detail ? ctx.redact(rows[a]!.detail!) : null])),
      secretNames: ctx.db.all<{ name: string }>('SELECT name FROM company_secrets WHERE company_id = ?', r.id).map(s => s.name),
      connections: deps.connections.rows(r.id).filter(c => c.enabled).map(c => ({ id: c.id, name: c.name, authentication: c.authentication, authStatus: c.authStatus })),
      repos: ctx.db.all<RepoRow>('SELECT * FROM repos WHERE company_id = ?', r.id).map(x => ({ id: x.id, name: x.name, url: x.url, status: x.status, detail: x.detail, lastSyncOk: x.last_sync_ok === null ? null : !!x.last_sync_ok })),
      passport: { configured: !!deps.host, hostUp, passportId: r.passport_id }
    })
  }

  function view(r: CompanyRow, hostUp: boolean): CloudCompany {
    const n = (sql: string) => ctx.db.get<{ n: number }>(sql, r.id)!.n
    return {
      id: r.id, name: r.name, slug: r.slug, color: r.color, createdAt: r.created_at, paused: !!r.paused,
      passport: passportLink(r),
      counts: {
        workflows: n('SELECT COUNT(*) AS n FROM workflows WHERE company_id = ?'),
        schedules: n('SELECT COUNT(*) AS n FROM schedules WHERE company_id = ?'),
        repos: n('SELECT COUNT(*) AS n FROM repos WHERE company_id = ?'),
        connections: n('SELECT COUNT(*) AS n FROM connections WHERE company_id = ?'),
        openAsks: n("SELECT COUNT(*) AS n FROM asks WHERE company_id = ? AND status = 'open'"),
        running: n("SELECT COUNT(*) AS n FROM cloud_runs WHERE company_id = ? AND status = 'running'")
      },
      readiness: readiness(r, hostUp),
      cloudAgentWrites: r.cloud_agent_writes === 'trusted' ? 'trusted' : 'propose'
    }
  }

  const hostUp = async () => (deps.host ? deps.host.health() : false)

  async function provision(cid: string, bundleB64: string, writes: 'propose' | 'trusted') {
    const host = deps.host!
    const bundle = Buffer.from(bundleB64, 'base64')
    if (!bundle.length || bundle.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('passportBundle must be the base64 of a .passport.zip.')
    const created = await host.create(bundle, cid)
    const owner = await host.grant(created.id, ctx.config.passport!.adminToken, 'principia-cloud-owner', OWNER_SCOPES, false)
    const desktop = await host.grant(created.id, owner.token, 'principia-desktop', DESKTOP_SCOPES, false)
    const runtime = await host.grant(created.id, owner.token, 'principia-cloud-agents', RUNTIME_SCOPES, writes === 'trusted')
    return { passportId: created.id, revision: created.revision, owner, desktop, runtime }
  }

  return {
    must,
    row: companyRow,
    ownerToken,
    async list(): Promise<CloudCompany[]> {
      const rows = ctx.db.all<CompanyRow>('SELECT * FROM companies ORDER BY created_at, id')
      const up = await hostUp()
      if (up) await Promise.all(rows.map(r => refreshPassport(r)))
      return rows.map(r => view(companyRow(r.id)!, up))
    },
    async get(cid: string): Promise<CloudCompany> { const r = must(cid); const up = await hostUp(); if (up) await refreshPassport(r); return view(companyRow(cid)!, up) },
    async refreshAll(): Promise<void> { if (await hostUp()) await Promise.all(ctx.db.all<CompanyRow>('SELECT * FROM companies').map(r => refreshPassport(r))) },
    async put(actor: Actor, cid: string, body: unknown, rotateDesktopGrant: boolean): Promise<PutCompanyResponse> {
      if (!COMPANY_ID.test(cid)) throw badRequest('Company ids use letters, digits, ., _ and - (128 at most).')
      const p = putSchema.safeParse(body)
      if (!p.success) throw badRequest(`Invalid company: ${p.error.issues[0]?.path.join('.') || 'body'} ${p.error.issues[0]?.message ?? ''}`.trim())
      const b = p.data
      const now = ctx.now().toISOString()
      const existing = companyRow(cid)
      let grant: PutCompanyResponse['desktopPassportGrant'] = null
      if (existing) {
        ctx.db.run('UPDATE companies SET name = ?, slug = ?, color = ?, updated_at = ? WHERE id = ?', b.name, b.slug, b.color ?? existing.color, now, cid)
        if (rotateDesktopGrant) {
          if (!deps.host || !existing.passport_id) throw new ApiError('conflict', 'This company has no passport to rotate a key for.')
          const owner = ownerToken(existing)!
          if (existing.desktop_grant_id) await deps.host.revoke(existing.desktop_grant_id, owner).catch(e => { if (!(e instanceof ApiError && e.code === 'not_found')) throw e })
          const d = await deps.host.grant(existing.passport_id, owner, 'principia-desktop', DESKTOP_SCOPES, false)
          ctx.db.run('UPDATE companies SET desktop_grant_id = ? WHERE id = ?', d.id, cid)
          grant = { url: deps.host.publicUrl, passportId: existing.passport_id, token: d.token }
          ctx.audit(actor, 'company.passport.rotate_desktop_grant', cid, existing.passport_id, {})
        }
        ctx.audit(actor, 'company.update', cid, cid, { name: b.name })
      } else {
        const writes = b.cloudAgentWrites ?? 'propose'
        if (deps.host && !b.passportBundle) throw badRequest('passportBundle is required the first time a company moves to the cloud.')
        // one first-time move per company at a time: a second one would provision a second passport
        if (creating.has(cid)) throw new ApiError('conflict', 'This company is already moving to the cloud. Wait for it to finish.')
        creating.add(cid)
        let prov: Awaited<ReturnType<typeof provision>> | null = null
        try {
          // prepare the company folder first: when it fails nothing is provisioned, so a retry starts clean
          try { await ctx.runtime.ensureCompany({ workspaceId: ctx.workspaceId, companyId: cid, name: b.name, slug: b.slug }) } catch (e) {
            ctx.log.error('runtime.ensureCompany failed', { companyId: cid, error: (e as Error).message })
            throw new ApiError('unavailable', 'The cloud could not prepare the company folder. Try again.')
          }
          if (deps.host) prov = await provision(cid, b.passportBundle!, writes)
        } finally { creating.delete(cid) }
        ctx.db.run(`INSERT INTO companies (id, workspace_id, name, slug, color, created_at, updated_at, cloud_agent_writes, passport_id, passport_revision, passport_seq,
            desktop_grant_id, runtime_grant_id, runtime_grant_ct, owner_grant_id, owner_grant_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          cid, ctx.workspaceId, b.name, b.slug, b.color ?? null, now, now, writes, prov?.passportId ?? null, prov?.revision ?? null, prov ? ctx.db.nextSeq() : 0,
          prov?.desktop.id ?? null, prov?.runtime.id ?? null, prov ? ctx.vault.encrypt('passport-grant', prov.runtime.id, prov.runtime.token) : null,
          prov?.owner.id ?? null, prov ? ctx.vault.encrypt('passport-grant', prov.owner.id, prov.owner.token) : null)
        if (prov) grant = { url: deps.host!.publicUrl, passportId: prov.passportId, token: prov.desktop.token }
        ctx.audit(actor, 'company.create', cid, cid, { name: b.name, passport: prov?.passportId ?? null })
      }
      return { company: await this.get(cid), desktopPassportGrant: grant }
    },
    async patch(actor: Actor, cid: string, body: unknown, sessionOnly: boolean): Promise<CloudCompany> {
      const r = must(cid)
      const p = patchSchema.safeParse(body)
      if (!p.success) throw badRequest('Invalid company patch.')
      if (sessionOnly && p.data.cloudAgentWrites !== undefined) throw new ApiError('forbidden', 'Change agent writes from your Mac.')
      if (p.data.paused !== undefined && p.data.paused !== !!r.paused) {
        ctx.db.run('UPDATE companies SET paused = ?, updated_at = ? WHERE id = ?', p.data.paused ? 1 : 0, ctx.now().toISOString(), cid)
        ctx.audit(actor, p.data.paused ? 'company.pause' : 'company.resume', cid, cid, {})
        if (p.data.paused) await deps.cancelCompanyRuns(cid, 'Company paused')
        ctx.runtime.triggers.reloadSchedules()
        ctx.kick()
      }
      if (p.data.cloudAgentWrites && p.data.cloudAgentWrites !== r.cloud_agent_writes) {
        if (deps.host && r.passport_id && r.runtime_grant_id) await deps.host.setTrusted(r.passport_id, r.runtime_grant_id, ownerToken(r)!, p.data.cloudAgentWrites === 'trusted')
        ctx.db.run('UPDATE companies SET cloud_agent_writes = ? WHERE id = ?', p.data.cloudAgentWrites, cid)
        ctx.audit(actor, 'company.agent_writes', cid, cid, { cloudAgentWrites: p.data.cloudAgentWrites })
      }
      return this.get(cid)
    },
    async remove(actor: Actor, cid: string): Promise<void> {
      const r = must(cid)
      ctx.db.run('UPDATE companies SET paused = 1 WHERE id = ?', cid)
      await deps.cancelCompanyRuns(cid, 'Company removed from the cloud')
      if (deps.host && r.passport_id) {
        const owner = ownerToken(r)
        for (const gid of [r.desktop_grant_id, r.runtime_grant_id, r.owner_grant_id]) {
          if (gid && owner) await deps.host.revoke(gid, owner).catch(e => ctx.log.warn('passport grant revoke failed', { companyId: cid, error: (e as Error).message }))
        }
      }
      try { await ctx.runtime.removeCompany(ctx.workspaceId, cid) } catch (e) { ctx.log.warn('runtime.removeCompany failed', { companyId: cid, error: (e as Error).message }) }
      ctx.db.tx(() => {
        ctx.db.run('DELETE FROM run_steps WHERE run_id IN (SELECT id FROM cloud_runs WHERE company_id = ?)', cid)
        ctx.db.run('DELETE FROM schedule_fires WHERE schedule_id IN (SELECT id FROM schedules WHERE company_id = ?)', cid)
        for (const t of ['cloud_runs', 'asks', 'usage', 'oauth_state', 'credentials']) ctx.db.run(`DELETE FROM ${t} WHERE company_id = ?`, cid)
        ctx.db.run('DELETE FROM companies WHERE id = ?', cid)
      })
      cache.delete(cid)
      ctx.runtime.triggers.reloadSchedules()
      ctx.audit(actor, 'company.delete', cid, cid, { passport: r.passport_id })
    },
    async proposals(cid: string): Promise<PassportProposal[]> {
      const r = must(cid)
      if (!deps.host || !r.passport_id) return []
      return (await deps.host.proposals(r.passport_id, ownerToken(r)!)).map(toProposal)
    },
    async decide(actor: Actor, cid: string, pid: string, decision: string): Promise<{ status: string }> {
      const r = must(cid)
      if (decision !== 'accept' && decision !== 'reject') throw notFound('Use accept or reject.')
      if (!deps.host || !r.passport_id) throw notFound('This company has no passport.')
      const out = await deps.host.decide(r.passport_id, pid, decision === 'accept', ownerToken(r)!)
      ctx.audit(actor, `passport.proposal.${decision}`, cid, pid, { status: out.status })
      await refreshPassport(companyRow(cid)!, true)
      return out
    },
    passportMaterial(cid: string) {
      const r = companyRow(cid)
      if (!deps.host || !r?.passport_id || !r.runtime_grant_id || !r.runtime_grant_ct) return null
      return { internalUrl: deps.host.internalUrl, publicUrl: deps.host.publicUrl, passportId: r.passport_id, token: ctx.vault.decrypt('passport-grant', r.runtime_grant_id, r.runtime_grant_ct) }
    },
    passportChanges(sinceSeq: number, uptoSeq: number): { companyId: string; revision: number }[] {
      return ctx.db.all<{ id: string; passport_revision: number }>('SELECT id, passport_revision FROM companies WHERE passport_seq > ? AND passport_seq <= ? AND passport_revision IS NOT NULL ORDER BY id', sinceSeq, uptoSeq).map(r => ({ companyId: r.id, revision: r.passport_revision }))
    },

    // ---------- company keys ----------
    secrets(cid: string): CloudSecretMeta[] {
      must(cid)
      return ctx.db.all<{ name: string; created_at: string; updated_at: string; last_used_at: string | null }>('SELECT name, created_at, updated_at, last_used_at FROM company_secrets WHERE company_id = ? ORDER BY name', cid)
        .map(s => ({ name: s.name, createdAt: s.created_at, updatedAt: s.updated_at, lastUsedAt: s.last_used_at }))
    },
    putSecret(actor: Actor, cid: string, name: string, body: { value?: unknown }): CloudSecretMeta {
      must(cid)
      if (!SECRET_NAME.test(name)) throw badRequest('Key names look like ENV_NAMES: capitals, digits and _.')
      if (typeof body.value !== 'string' || !body.value.length) throw badRequest('value is required.')
      if (Buffer.byteLength(body.value, 'utf8') > CLOUD_LIMITS.credentialBytes) throw new ApiError('payload_too_large', 'That key is larger than 64 KB.')
      const now = ctx.now().toISOString()
      ctx.db.run(`INSERT INTO company_secrets (company_id, name, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (company_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`, cid, name, ctx.vault.encrypt('company-secret', `${cid}/${name}`, body.value), now, now)
      ctx.audit(actor, 'company.secret.set', cid, name, {})
      return this.secrets(cid).find(s => s.name === name)!
    },
    removeSecret(actor: Actor, cid: string, name: string): void {
      must(cid)
      if (!ctx.db.run('DELETE FROM company_secrets WHERE company_id = ? AND name = ?', cid, name)) throw notFound('No such key.')
      ctx.audit(actor, 'company.secret.delete', cid, name, {})
    },
    secretMaterials(cid: string): Record<string, string> {
      const rows = ctx.db.all<{ name: string; ciphertext: string }>('SELECT name, ciphertext FROM company_secrets WHERE company_id = ?', cid)
      if (rows.length) ctx.db.run('UPDATE company_secrets SET last_used_at = ? WHERE company_id = ?', ctx.now().toISOString(), cid)
      return Object.fromEntries(rows.map(s => [s.name, ctx.vault.decrypt('company-secret', `${cid}/${s.name}`, s.ciphertext)]))
    },

    // ---------- repos ----------
    repos(cid: string): CloudRepo[] {
      must(cid)
      return ctx.db.all<RepoRow>('SELECT * FROM repos WHERE company_id = ? ORDER BY id', cid).map(repoView)
    },
    putRepo(actor: Actor, cid: string, rid: string, body: unknown): CloudRepo {
      must(cid)
      if (!CHILD_ID.test(rid)) throw badRequest('Repo ids use letters, digits, ., _ and -.')
      const p = repoSchema.safeParse(body)
      if (!p.success) throw badRequest(`Invalid repo: ${p.error.issues[0]?.path.join('.') || 'body'} ${p.error.issues[0]?.message ?? ''}`.trim())
      const b = p.data
      if (b.credential.kind === 'github_app') throw notInV1()
      if (!GITHUB_URL.test(b.url)) throw badRequest('Use a GitHub HTTPS URL like https://github.com/owner/repo.')
      const now = ctx.now().toISOString()
      const key = `${cid}/${rid}`
      const prev = ctx.db.get<RepoRow>('SELECT * FROM repos WHERE company_id = ? AND id = ?', cid, rid)
      const ct = b.credential.kind === 'github_pat' ? ctx.vault.encrypt('repo-pat', key, b.credential.value) : null
      ctx.db.run(`INSERT INTO repos (company_id, id, name, url, branch, credential_kind, credential_ct, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (company_id, id) DO UPDATE SET name = excluded.name, url = excluded.url, branch = excluded.branch, credential_kind = excluded.credential_kind,
          credential_ct = excluded.credential_ct, status = 'pending', detail = NULL, last_sync_ok = NULL, updated_at = excluded.updated_at`,
        cid, rid, b.name, b.url, b.branch ?? null, b.credential.kind, ct, now, now)
      ctx.audit(actor, prev ? 'repo.update' : 'repo.create', cid, rid, { url: b.url, credential: b.credential.kind })
      return repoView(ctx.db.get<RepoRow>('SELECT * FROM repos WHERE company_id = ? AND id = ?', cid, rid)!)
    },
    removeRepo(actor: Actor, cid: string, rid: string): void {
      must(cid)
      if (!ctx.db.run('DELETE FROM repos WHERE company_id = ? AND id = ?', cid, rid)) throw notFound('No such repo.')
      ctx.audit(actor, 'repo.delete', cid, rid, {})
    },
    async syncRepo(actor: Actor, cid: string, rid: string): Promise<CloudRepo> {
      must(cid)
      const r = ctx.db.get<RepoRow>('SELECT * FROM repos WHERE company_id = ? AND id = ?', cid, rid)
      if (!r) throw notFound('No such repo.')
      let out: { ok: boolean; detail: string | null }
      try { out = await ctx.runtime.syncRepo(cid, repoMaterial(r)) } catch (e) { out = { ok: false, detail: (e as Error).message } }
      const detail = out.ok ? null : ctx.redact(out.detail ?? 'GitHub refused it').slice(0, 300)
      ctx.db.run('UPDATE repos SET status = ?, detail = ?, last_sync_ok = ?, synced_at = ?, updated_at = ? WHERE company_id = ? AND id = ?',
        out.ok ? 'ready' : 'failed', detail, out.ok ? 1 : 0, ctx.now().toISOString(), ctx.now().toISOString(), cid, rid)
      ctx.audit(actor, 'repo.sync', cid, rid, { ok: out.ok })
      return repoView(ctx.db.get<RepoRow>('SELECT * FROM repos WHERE company_id = ? AND id = ?', cid, rid)!)
    },
    repoMaterials(cid: string): RepoMaterial[] {
      return ctx.db.all<RepoRow>('SELECT * FROM repos WHERE company_id = ? ORDER BY id', cid).map(repoMaterial)
    },
    /** decrypt every stored secret once at boot so the redactor knows them */
    primeSecrets(): void {
      for (const r of ctx.db.all<CompanyRow>('SELECT * FROM companies')) {
        try { ownerToken(r); if (r.runtime_grant_ct && r.runtime_grant_id) ctx.vault.decrypt('passport-grant', r.runtime_grant_id, r.runtime_grant_ct) } catch { /* skipped */ }
      }
      for (const r of ctx.db.all<RepoRow>('SELECT * FROM repos WHERE credential_ct IS NOT NULL')) { try { repoMaterial(r) } catch { /* skipped */ } }
      for (const s of ctx.db.all<{ company_id: string; name: string; ciphertext: string }>('SELECT company_id, name, ciphertext FROM company_secrets')) { try { ctx.vault.decrypt('company-secret', `${s.company_id}/${s.name}`, s.ciphertext) } catch { /* skipped */ } }
    }
  }

  function repoView(r: RepoRow): CloudRepo {
    return { id: r.id, name: r.name, url: r.url, branch: r.branch, credentialKind: r.credential_kind as CloudRepo['credentialKind'], syncedAt: r.synced_at, status: r.status as CloudRepo['status'], detail: r.detail }
  }
  function repoMaterial(r: RepoRow): RepoMaterial {
    return { id: r.id, name: r.name, url: r.url, branch: r.branch, token: r.credential_ct ? ctx.vault.decrypt('repo-pat', `${r.company_id}/${r.id}`, r.credential_ct) : null }
  }
}
export type Companies = ReturnType<typeof createCompanies>
