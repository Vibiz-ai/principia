/**
 * Workspace accounts and shared keys (docs/ACCOUNTS.md). The person signs in once, on the Mac, and every run in this
 * cloud is signed in:
 *
 * - GitHub: one token for the workspace, kept in `credentials` (adapter 'github', company_id NULL, vault kind
 *   'provider' so boot primes the redactor with it like every model account). A repo with no token of its own clones
 *   and pushes with it (through the runtime's GIT_ASKPASS, never argv or the remote URL), and runs get it as GH_TOKEN
 *   and GITHUB_TOKEN for `gh` and the API, unless the company set its own key of that name.
 * - Shared keys: `workspace_secrets`, the desktop's Shared keys the person marked "In the cloud". Every company's runs
 *   get them; a company key of the same name wins (the same rule as the desktop vault).
 *
 * Values are write-only: nothing here returns one except `githubToken` and `secretMaterials`, which build a run's
 * materials in memory.
 */
import { CLOUD_LIMITS, isGithubToken, type CloudAccounts, type CloudGithubAccount, type CloudSecretMeta } from '../../shared/cloud'
import type { Actor, Ctx } from './context'
import { newId } from './db'
import { ApiError, badRequest, notFound } from './http'
import type { CredentialRow } from './providers'

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
/** The variables the workspace GitHub token is offered as. */
export const GITHUB_ENV = ['GH_TOKEN', 'GITHUB_TOKEN'] as const
const GITHUB = 'github'
const GITHUB_KIND = 'github_token'

interface SecretRow { name: string; ciphertext: string; created_at: string; updated_at: string; last_used_at: string | null }

export function createAccounts(ctx: Ctx) {
  const githubRow = (): CredentialRow | undefined =>
    ctx.db.get<CredentialRow>("SELECT * FROM credentials WHERE adapter = ? AND company_id IS NULL ORDER BY created_at DESC LIMIT 1", GITHUB)

  function github(): CloudGithubAccount | null {
    const r = githubRow()
    return r ? { login: r.label === GITHUB_KIND ? null : r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at } : null
  }
  function secrets(): CloudSecretMeta[] {
    return ctx.db.all<SecretRow>('SELECT name, created_at, updated_at, last_used_at FROM workspace_secrets ORDER BY name')
      .map((s) => ({ name: s.name, createdAt: s.created_at, updatedAt: s.updated_at, lastUsedAt: s.last_used_at }))
  }
  const emit = () => ctx.events.emit({ kind: 'accounts' })

  return {
    list(): CloudAccounts {
      return { github: github(), secrets: secrets() }
    },

    // ---------- GitHub ----------
    putGithub(actor: Actor, body: { token?: unknown; login?: unknown }): CloudGithubAccount {
      if (typeof body.token !== 'string' || !isGithubToken(body.token)) throw badRequest('That does not look like a GitHub token (gho_, ghp_ or github_pat_…).')
      const token = body.token.trim()
      const login = typeof body.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(body.login.trim()) ? body.login.trim() : GITHUB_KIND
      const now = ctx.now().toISOString()
      const id = newId('cred_')
      ctx.db.tx(() => {
        ctx.db.run('DELETE FROM credentials WHERE adapter = ? AND company_id IS NULL', GITHUB)
        ctx.db.run('INSERT INTO credentials (id, workspace_id, company_id, adapter, kind, label, ciphertext, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          id, ctx.workspaceId, GITHUB, GITHUB_KIND, login, ctx.vault.encrypt('provider', id, token), now, now)
      })
      ctx.audit(actor, 'account.github.set', null, GITHUB, { login: login === GITHUB_KIND ? null : login })
      emit()
      return github()!
    },
    removeGithub(actor: Actor): void {
      if (!ctx.db.run('DELETE FROM credentials WHERE adapter = ? AND company_id IS NULL', GITHUB)) throw notFound('GitHub is not connected to this cloud.')
      ctx.audit(actor, 'account.github.delete', null, GITHUB, {})
      emit()
    },
    /** decrypted, for a run's materials (touches lastUsedAt); null when GitHub is not connected */
    githubToken(touch = true): string | null {
      const r = githubRow()
      if (!r) return null
      if (touch) ctx.db.run('UPDATE credentials SET last_used_at = ? WHERE id = ?', ctx.now().toISOString(), r.id)
      return ctx.vault.decrypt('provider', r.id, r.ciphertext)
    },

    // ---------- shared keys ----------
    secretNames(): string[] {
      return ctx.db.all<{ name: string }>('SELECT name FROM workspace_secrets').map((s) => s.name)
    },
    putSecret(actor: Actor, name: string, body: { value?: unknown }): CloudSecretMeta {
      if (!SECRET_NAME.test(name)) throw badRequest('Key names look like ENV_NAMES: capitals, digits and _.')
      if (typeof body.value !== 'string' || !body.value.length) throw badRequest('value is required.')
      if (Buffer.byteLength(body.value, 'utf8') > CLOUD_LIMITS.credentialBytes) throw new ApiError('payload_too_large', 'That key is larger than 64 KB.')
      const now = ctx.now().toISOString()
      ctx.db.run(`INSERT INTO workspace_secrets (name, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`, name, ctx.vault.encrypt('workspace-secret', name, body.value), now, now)
      ctx.audit(actor, 'workspace.secret.set', null, name, {})
      emit()
      return secrets().find((s) => s.name === name)!
    },
    removeSecret(actor: Actor, name: string): void {
      if (!ctx.db.run('DELETE FROM workspace_secrets WHERE name = ?', name)) throw notFound('No such key.')
      ctx.audit(actor, 'workspace.secret.delete', null, name, {})
      emit()
    },

    /**
     * What a run of `companyKeys`' company gets as keys: the GitHub token as GH_TOKEN / GITHUB_TOKEN, then the shared
     * keys, then the company's own keys, each later layer winning over the one before.
     */
    secretMaterials(companyKeys: Record<string, string>): Record<string, string> {
      const out: Record<string, string> = {}
      const gh = this.githubToken()
      if (gh) for (const k of GITHUB_ENV) out[k] = gh
      const rows = ctx.db.all<SecretRow>('SELECT name, ciphertext FROM workspace_secrets')
      if (rows.length) ctx.db.run('UPDATE workspace_secrets SET last_used_at = ?', ctx.now().toISOString())
      for (const s of rows) out[s.name] = ctx.vault.decrypt('workspace-secret', s.name, s.ciphertext)
      return { ...out, ...companyKeys }
    },

    /** decrypt every shared key once at boot so the redactor knows them (GitHub is primed with the credentials) */
    primeSecrets(): void {
      for (const s of ctx.db.all<SecretRow>('SELECT name, ciphertext FROM workspace_secrets')) {
        try { ctx.vault.decrypt('workspace-secret', s.name, s.ciphertext) } catch { ctx.log.warn('a shared key could not be decrypted', { name: s.name }) }
      }
    }
  }
}
export type Accounts = ReturnType<typeof createAccounts>
