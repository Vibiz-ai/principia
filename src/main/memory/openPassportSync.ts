/**
 * Publish / sync a company's Passport with an Open Passport host (open-passport SPEC.md §11.4). Off by default: a
 * company syncs only after the user sets a host URL, passport id and token for it (Settings → Passport). Each sync
 * pulls first (the host's head merged into the vault three-way, base = the host revision we last saw), then pushes the
 * vault as a bundle with `X-Base-Revision`, so both sides converge on one revision. Conflicts stay ours locally (Inbox)
 * and stay the host's there (the owner's proposals). The config, token included, lives in `<userData>`, 0600, never in
 * the vault (which may sync through iCloud or git).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Manifest } from '../openPassport'
import { readZip } from '../openPassport/fs'
import { incomingFromFiles, type IncomingPassport, type MergeImportResult } from './openPassportIo'

export interface SyncConfig {
  /** host base URL, e.g. https://passport.example.com */
  url: string
  passportId: string
  token: string
  /** the host revision this vault last pulled or pushed, and its digest (the merge base) */
  base: number | null
  baseDigest: string | null
  lastSync: string | null
}
/** What the renderer sees: never the token. */
export type SyncConfigView = Omit<SyncConfig, 'token'> & { hasToken: boolean }

export interface SyncResult {
  pulled: { from: number | null; to: number; notes: number; conflicts: number } | null
  pushed: { revision: number; conflicts: number } | null
  revision: number
}

export interface SyncDeps {
  userData: string
  fetch?: typeof fetch
  now?: () => Date
  /** builds the company's bundle (exportOpenPassport) */
  exportZip(companyId: string): { zip: Uint8Array; manifest: Manifest }
  /** merges a pulled bundle into the vault against the given base snapshot */
  merge(companyId: string, inc: IncomingPassport, baseDigest: string | null): Promise<MergeImportResult>
  /** keeps a bundle as a future merge base */
  remember(companyId: string, inc: IncomingPassport): void
}

const FILE = 'open-passport-sync.json'
const TIMEOUT_MS = 30_000

export class PassportSync {
  private deps: SyncDeps
  constructor(deps: SyncDeps) {
    this.deps = deps
  }

  private file(): string {
    return path.join(this.deps.userData, FILE)
  }
  private all(): Record<string, SyncConfig> {
    try {
      return JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, SyncConfig>
    } catch {
      return {}
    }
  }
  private write(all: Record<string, SyncConfig>): void {
    const tmp = `${this.file()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.file())
  }

  config(companyId: string): SyncConfig | null {
    return this.all()[companyId] ?? null
  }
  view(companyId: string): SyncConfigView | null {
    const c = this.config(companyId)
    if (!c) return null
    const { token, ...rest } = c
    return { ...rest, hasToken: !!token }
  }

  /** Sets (or with null, removes) a company's host. A new URL or passport starts over without a base. */
  configure(companyId: string, cfg: { url: string; passportId: string; token?: string } | null): SyncConfigView | null {
    const all = this.all()
    if (!cfg) {
      delete all[companyId]
      this.write(all)
      return null
    }
    const url = new URL(cfg.url)
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use an https:// host (http only for localhost)')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.passportId)) throw new Error('The passport id is letters, digits, - and _')
    const prev = all[companyId]
    const same = prev && prev.url === url.origin && prev.passportId === cfg.passportId
    const token = cfg.token?.trim() || prev?.token || ''
    if (!token) throw new Error('Paste the token the host gave you')
    all[companyId] = { url: url.origin, passportId: cfg.passportId, token, base: same ? prev.base : null, baseDigest: same ? prev.baseDigest : null, lastSync: same ? prev.lastSync : null }
    this.write(all)
    return this.view(companyId)
  }

  private async request(c: SyncConfig, p: string, init: RequestInit = {}): Promise<Response> {
    const f = this.deps.fetch ?? fetch
    const res = await f(`${c.url}/v1/passports/${encodeURIComponent(c.passportId)}${p}`, {
      ...init,
      headers: { authorization: `Bearer ${c.token}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) {
      let msg = `${res.status}`
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg
      } catch {
        // not JSON
      }
      throw new SyncError(res.status, res.status === 401 ? 'The host refused the token (revoked or wrong)' : res.status === 403 ? `The token cannot do this: ${msg}` : `Passport host: ${msg}`)
    }
    return res
  }

  /** Pull, then push. Throws SyncError for host errors; a 409 on push (the head moved meanwhile) pulls once more. */
  async sync(companyId: string): Promise<SyncResult> {
    const c = this.config(companyId)
    if (!c) throw new Error('This company is not connected to a Passport host')
    const pulled = await this.pull(companyId, c)
    let pushed: SyncResult['pushed']
    try {
      pushed = await this.push(companyId, c)
    } catch (e) {
      if (!(e instanceof SyncError && e.status === 409)) throw e
      await this.pull(companyId, c)
      pushed = await this.push(companyId, c)
    }
    c.lastSync = (this.deps.now?.() ?? new Date()).toISOString()
    this.save(companyId, c)
    return { pulled, pushed, revision: c.base ?? 0 }
  }

  private save(companyId: string, c: SyncConfig): void {
    const all = this.all()
    if (all[companyId]) all[companyId] = { ...c, token: all[companyId].token }
    this.write(all)
  }

  private async pull(companyId: string, c: SyncConfig): Promise<SyncResult['pulled']> {
    const revs = (await (await this.request(c, '/revisions')).json()) as { head: number; revisions: { revision: number; digest: string }[] }
    if (!revs.head || revs.head === c.base) return null
    const zip = new Uint8Array(await (await this.request(c, '/bundle')).arrayBuffer())
    const inc = incomingFromFiles(readZip(zip), `${c.url}/v1/passports/${c.passportId}`)
    if (inc.errors.length) throw new SyncError(422, `The host's passport was refused: ${inc.errors.slice(0, 2).join('; ')}`)
    const r = await this.deps.merge(companyId, inc, c.baseDigest)
    this.deps.remember(companyId, inc)
    const from = c.base
    c.base = revs.head
    c.baseDigest = inc.manifest?.digest ?? null
    this.save(companyId, c)
    return { from, to: revs.head, notes: r.updated + r.created, conflicts: r.conflicts }
  }

  private async push(companyId: string, c: SyncConfig): Promise<SyncResult['pushed']> {
    const { zip, manifest } = this.deps.exportZip(companyId)
    if (c.baseDigest && manifest.digest === c.baseDigest) return null
    const res = await this.request(c, '/revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', ...(c.base ? { 'x-base-revision': String(c.base) } : {}) },
      body: zip as unknown as BodyInit
    })
    const out = (await res.json()) as { revision: number; conflicts?: unknown[] }
    // the host's head now holds our content (its own lines win conflicts); our export is the new base
    c.base = out.revision
    c.baseDigest = manifest.digest
    this.save(companyId, c)
    return { revision: out.revision, conflicts: Array.isArray(out.conflicts) ? out.conflicts.length : 0 }
  }
}

export class SyncError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
