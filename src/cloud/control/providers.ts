/**
 * Model accounts (CLOUD.md §7.2): one credential per adapter per workspace, encrypted, write-only. Status is computed
 * from expiry and the last test or run failure; values never leave except into RunMaterials.
 */
import {
  CLOUD_ADAPTERS, CLOUD_LIMITS, NOT_IN_V1_CREDENTIAL_KINDS, PROVIDER_CREDENTIAL_KINDS,
  type CloudAdapter, type ProviderAccount, type ProviderCredentialKind, type ProviderStatus, type ProviderTestResponse
} from '../../shared/cloud'
import type { ProviderMaterial } from '../contract'
import type { Actor, Ctx } from './context'
import { newId } from './db'
import { ApiError, badRequest, notFound, notInV1 } from './http'

const DAY = 86_400_000
const EXPIRING_MS = 30 * DAY

export const KIND_LABEL: Record<ProviderCredentialKind, string> = {
  claude_oauth_token: 'Claude subscription',
  anthropic_api_key: 'Anthropic API key',
  openai_api_key: 'OpenAI API key',
  codex_auth_json: 'ChatGPT sign-in',
  codex_access_token: 'Codex access token',
  gemini_api_key: 'Gemini API key',
  google_service_account: 'Google service account'
}

export interface CredentialRow {
  id: string; adapter: string; kind: string; label: string; ciphertext: string; created_at: string; updated_at: string
  expires_at: string | null; last_used_at: string | null; failing: number; detail: string | null
}

export const isAdapter = (a: string): a is CloudAdapter => (CLOUD_ADAPTERS as readonly string[]).includes(a)

export function credentialStatus(row: CredentialRow | undefined, now: Date): ProviderStatus {
  if (!row) return 'missing'
  const exp = row.expires_at ? Date.parse(row.expires_at) : null
  if (exp !== null && exp <= now.getTime()) return 'expired'
  if (row.failing) return 'failing'
  if (exp !== null && exp - now.getTime() < EXPIRING_MS) return 'expiring'
  return 'ok'
}

export const credentialRow = (ctx: Pick<Ctx, 'db'>, adapter: CloudAdapter): CredentialRow | undefined =>
  ctx.db.get<CredentialRow>('SELECT * FROM credentials WHERE adapter = ? AND company_id IS NULL ORDER BY created_at DESC LIMIT 1', adapter)

function validate(kind: ProviderCredentialKind, value: string): void {
  const flat = !/\s/.test(value.trim())
  const ok = {
    claude_oauth_token: flat && value.trim().startsWith('sk-ant-') && value.trim().length >= 20,
    anthropic_api_key: flat && value.trim().startsWith('sk-ant-') && value.trim().length >= 20,
    openai_api_key: flat && value.trim().startsWith('sk-') && value.trim().length >= 20,
    codex_access_token: flat && value.trim().length >= 20,
    gemini_api_key: flat && value.trim().length >= 20,
    codex_auth_json: isJsonObject(value),
    google_service_account: isJsonObject(value)
  }[kind]
  if (!ok) throw badRequest(kind === 'codex_auth_json' || kind === 'google_service_account' ? `That does not look like a ${KIND_LABEL[kind]} file (JSON).` : `That does not look like a ${KIND_LABEL[kind]}.`)
}
const isJsonObject = (s: string): boolean => { try { const v = JSON.parse(s); return !!v && typeof v === 'object' && !Array.isArray(v) } catch { return false } }

function safeLabel(label: unknown, value: string, kind: ProviderCredentialKind): string {
  if (typeof label !== 'string' || !label.trim()) return KIND_LABEL[kind]
  const l = label.trim().slice(0, 80)
  for (let i = 0; i + 6 <= l.length; i++) if (value.includes(l.slice(i, i + 6))) throw badRequest('A label cannot contain part of the key.')
  return l
}

export function createProviders(ctx: Ctx) {
  let versions: { at: number; v: Partial<Record<string, string>> } | null = null
  async function cliVersions(): Promise<Partial<Record<string, string>>> {
    if (versions && Date.now() - versions.at < 10 * 60_000) return versions.v
    try { versions = { at: Date.now(), v: await ctx.runtime.providers.cliVersions() } } catch { versions = { at: Date.now(), v: {} } }
    return versions.v
  }
  function account(adapter: CloudAdapter, v: Partial<Record<string, string>> = versions?.v ?? {}): ProviderAccount {
    const r = credentialRow(ctx, adapter)
    return {
      adapter,
      credential: r ? { id: r.id, kind: r.kind as ProviderCredentialKind, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at } : null,
      status: credentialStatus(r, ctx.now()),
      detail: r?.detail ? ctx.redact(r.detail) : null,
      cliVersion: v[adapter] ?? null
    }
  }
  const emit = (adapter: CloudAdapter) => ctx.events.emit({ kind: 'provider', account: account(adapter) })
  function adapterOf(a: string): CloudAdapter { if (!isAdapter(a)) throw notFound('Unknown adapter.'); return a }

  /** insert or replace the workspace credential of an adapter; returns its id */
  function store(adapter: CloudAdapter, kind: ProviderCredentialKind, value: string, label: string, keepId: string | null): string {
    const now = ctx.now()
    const expires = kind === 'claude_oauth_token' ? new Date(now.getTime() + 365 * DAY).toISOString() : null
    return ctx.db.tx(() => {
      const existing = keepId ? ctx.db.get<CredentialRow>('SELECT * FROM credentials WHERE id = ? AND adapter = ?', keepId, adapter) : undefined
      if (existing && existing.kind === kind) {
        ctx.db.run('UPDATE credentials SET ciphertext = ?, updated_at = ?, failing = 0, detail = NULL WHERE id = ?', ctx.vault.encrypt('provider', existing.id, value), now.toISOString(), existing.id)
        return existing.id
      }
      ctx.db.run('DELETE FROM credentials WHERE adapter = ? AND company_id IS NULL', adapter)
      const id = newId('cred_')
      ctx.db.run('INSERT INTO credentials (id, workspace_id, company_id, adapter, kind, label, ciphertext, created_at, updated_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        id, ctx.workspaceId, adapter, kind, label, ctx.vault.encrypt('provider', id, value), now.toISOString(), now.toISOString(), expires)
      return id
    })
  }

  function material(adapter: CloudAdapter, touch = true): ProviderMaterial | null {
    const r = credentialRow(ctx, adapter)
    if (!r) return null
    if (touch) ctx.db.run('UPDATE credentials SET last_used_at = ? WHERE id = ?', ctx.now().toISOString(), r.id)
    return { credentialId: r.id, adapter, kind: r.kind as ProviderCredentialKind, value: ctx.vault.decrypt('provider', r.id, r.ciphertext) }
  }

  return {
    cliVersions,
    account,
    async list(): Promise<ProviderAccount[]> { const v = await cliVersions(); return CLOUD_ADAPTERS.map(a => account(a, v)) },
    put(actor: Actor, a: string, body: { kind?: unknown; value?: unknown; label?: unknown }): ProviderAccount {
      const adapter = adapterOf(a)
      const kind = body.kind as ProviderCredentialKind
      if (typeof body.kind !== 'string' || !PROVIDER_CREDENTIAL_KINDS[adapter].includes(kind)) throw badRequest(`Unknown credential kind for ${adapter}.`)
      if (NOT_IN_V1_CREDENTIAL_KINDS.includes(kind)) throw notInV1()
      if (typeof body.value !== 'string' || !body.value.trim()) throw badRequest('value is required.')
      if (Buffer.byteLength(body.value, 'utf8') > CLOUD_LIMITS.credentialBytes) throw new ApiError('payload_too_large', 'That credential is larger than 64 KB.')
      const value = kind === 'codex_auth_json' || kind === 'google_service_account' ? body.value : body.value.trim()
      validate(kind, value)
      const label = safeLabel(body.label, value, kind)
      const id = store(adapter, kind, value, label, null)
      ctx.audit(actor, 'provider.credential.set', null, adapter, { adapter, kind, credentialId: id })
      emit(adapter)
      return account(adapter)
    },
    remove(actor: Actor, a: string): void {
      const adapter = adapterOf(a)
      if (!ctx.db.run('DELETE FROM credentials WHERE adapter = ? AND company_id IS NULL', adapter)) throw notFound('No credential for this adapter.')
      ctx.audit(actor, 'provider.credential.delete', null, adapter, { adapter })
      emit(adapter)
    },
    async test(actor: Actor, a: string, live: boolean): Promise<ProviderTestResponse> {
      const adapter = adapterOf(a)
      const m = material(adapter, false)
      if (!m) throw notFound('Add a credential first.')
      let out: ProviderTestResponse
      try { out = await ctx.runtime.providers.test(m, { live }) } catch (e) { out = { ok: false, detail: (e as Error).message } }
      const detail = ctx.redact(out.detail ?? '').slice(0, 300)
      ctx.db.run('UPDATE credentials SET failing = ?, detail = ? WHERE id = ?', out.ok ? 0 : 1, out.ok ? null : detail, m.credentialId)
      ctx.audit(actor, 'provider.credential.test', null, adapter, { adapter, ok: out.ok, live })
      emit(adapter)
      return { ok: out.ok, detail }
    },
    /** decrypted, for a run (touches lastUsedAt) or a test */
    material,
    /** ports.saveProviderCredential: a refreshed codex auth.json (or any file credential) written back after a run */
    save(c: { credentialId: string | null; adapter: CloudAdapter; kind: ProviderCredentialKind; value: string }): void {
      if (!isAdapter(c.adapter) || !PROVIDER_CREDENTIAL_KINDS[c.adapter].includes(c.kind)) throw new Error('saveProviderCredential: unknown adapter or kind')
      if (Buffer.byteLength(c.value, 'utf8') > CLOUD_LIMITS.credentialBytes) throw new Error('saveProviderCredential: value too large')
      // a write-back for a credential the user replaced or removed during the run is stale: the newer one wins
      if (c.credentialId) {
        const cur = credentialRow(ctx, c.adapter)
        if (!cur || cur.id !== c.credentialId || cur.kind !== c.kind) {
          ctx.log.warn('stale credential write-back dropped', { adapter: c.adapter, credentialId: c.credentialId })
          return
        }
      }
      const id = store(c.adapter, c.kind, c.value, KIND_LABEL[c.kind], c.credentialId)
      ctx.audit({ kind: 'system', id: null, name: 'runtime' }, 'provider.credential.refresh', null, c.adapter, { adapter: c.adapter, kind: c.kind, credentialId: id })
      emit(c.adapter)
    },
    /** a test or the user marked an adapter's current credential failing (the pane shows it, readiness asks for a fix) */
    markFailing(adapter: CloudAdapter, detail: string): void {
      ctx.db.run('UPDATE credentials SET failing = 1, detail = ? WHERE adapter = ? AND company_id IS NULL', ctx.redact(detail).slice(0, 300), adapter)
      emit(adapter)
    },
    /**
     * ports.providerStatus (CLOUD.md §7.2, §7.9): what a real run saw. A sign-in the CLI rejected is Expired (the
     * Accounts row says Connect Claude, readiness lists the fix); a usage limit is Failing with the reset time; a
     * passed step clears either. A report about a credential the user has replaced since is stale and dropped.
     */
    status(c: { credentialId: string; adapter: CloudAdapter; status: 'ok' | 'expired' | 'limited'; detail: string | null }): void {
      if (!isAdapter(c.adapter)) return
      const cur = credentialRow(ctx, c.adapter)
      if (!cur || cur.id !== c.credentialId) { ctx.log.warn('stale provider status dropped', { adapter: c.adapter, credentialId: c.credentialId, status: c.status }); return }
      const now = ctx.now()
      const detail = c.detail ? ctx.redact(c.detail).replace(/\s+/g, ' ').slice(0, 300) : null
      if (c.status === 'ok') {
        // a passed step proves the sign-in works: clear a limit or a failing test, never a real expiry date
        if (!cur.failing) return
        ctx.db.run('UPDATE credentials SET failing = 0, detail = NULL WHERE id = ?', cur.id)
      } else if (c.status === 'expired') {
        const exp = cur.expires_at && Date.parse(cur.expires_at) <= now.getTime() ? cur.expires_at : now.toISOString()
        if (cur.failing && cur.detail === detail && cur.expires_at === exp) return
        ctx.db.run('UPDATE credentials SET failing = 1, detail = ?, expires_at = ? WHERE id = ?', detail ?? `${KIND_LABEL[cur.kind as ProviderCredentialKind] ?? 'The sign-in'} was rejected during a run.`, exp, cur.id)
      } else {
        if (cur.failing && cur.detail === detail) return
        ctx.db.run('UPDATE credentials SET failing = 1, detail = ? WHERE id = ?', detail ?? 'It hit its usage limit during a run.', cur.id)
      }
      ctx.audit({ kind: 'system', id: null, name: 'runtime' }, 'provider.credential.status', null, c.adapter, { adapter: c.adapter, status: c.status, credentialId: cur.id })
      emit(c.adapter)
    }
  }
}
export type Providers = ReturnType<typeof createProviders>
