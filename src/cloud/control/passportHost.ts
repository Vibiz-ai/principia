/**
 * Client for the workspace's Open Passport host (CLOUD.md §7.1, Open Passport SPEC §11.2). The admin token creates
 * passports and their first owner grant; the stored owner grant does everything else for that passport.
 */
import type { PassportProposal } from '../../shared/cloud'
import { ApiError } from './http'

export interface HostProposal { id: string; kind: 'delta' | 'taste' | 'conflict'; app: string; created: string; payload: unknown }
export interface Grant { id: string; token: string }

export const DESKTOP_SCOPES = ['write:all', 'read:all']
export const RUNTIME_SCOPES = ['read:all', 'write:proposals', 'write:taste']
export const OWNER_SCOPES = ['owner']

export interface PassportHost {
  readonly publicUrl: string
  readonly internalUrl: string
  health(): Promise<boolean>
  create(bundle: Uint8Array, preferredId: string): Promise<{ id: string; revision: number }>
  grant(passportId: string, auth: string, app: string, scopes: string[], trusted: boolean): Promise<Grant>
  revoke(grantId: string, auth: string): Promise<void>
  setTrusted(passportId: string, grantId: string, auth: string, trusted: boolean): Promise<void>
  revision(passportId: string, auth: string): Promise<number>
  proposals(passportId: string, auth: string): Promise<HostProposal[]>
  decide(passportId: string, proposalId: string, accept: boolean, auth: string): Promise<{ status: string }>
}

export function createPassportHost(cfg: { internalUrl: string; publicUrl: string; adminToken: string }, fetchFn: typeof fetch = fetch, now: () => number = Date.now): PassportHost {
  const base = cfg.internalUrl.replace(/\/+$/, '')
  let healthAt = 0
  let healthy = false
  async function call(method: string, path: string, auth: string, body?: { json?: unknown; zip?: Uint8Array }): Promise<unknown> {
    let res: Response
    try {
      res = await fetchFn(base + path, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(body?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(body?.zip ? { 'content-type': 'application/zip' } : {}) },
        body: body?.zip ? Buffer.from(body.zip) : body?.json !== undefined ? JSON.stringify(body.json) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      healthy = false; healthAt = now()
      throw new ApiError('unavailable', 'The passport host is not answering. Check that the passport container is running.')
    }
    const text = await res.text()
    let data: unknown = text
    try { data = text ? JSON.parse(text) : null } catch { /* markdown or empty */ }
    if (res.ok) return data
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error).slice(0, 300) : `HTTP ${res.status}`
    if (res.status === 404) throw new ApiError('not_found', `The passport host says: ${msg}`)
    if (res.status === 409) throw new ApiError('conflict', `The passport host says: ${msg}`)
    if (res.status === 413 || res.status === 422 || res.status === 400) throw new ApiError('bad_request', `The passport host refused it: ${msg}`)
    if (res.status === 401 || res.status === 403) throw new ApiError('unavailable', 'The passport host rejected Principia\'s key. Check OPEN_PASSPORT_ADMIN_TOKEN.')
    throw new ApiError('unavailable', `The passport host failed (HTTP ${res.status}).`)
  }
  return {
    publicUrl: cfg.publicUrl.replace(/\/+$/, ''),
    internalUrl: base,
    async health() {
      if (now() - healthAt < 30_000) return healthy
      try { const r = await fetchFn(`${base}/healthz`, { signal: AbortSignal.timeout(5_000), redirect: 'error' }); healthy = r.ok } catch { healthy = false }
      healthAt = now()
      return healthy
    },
    async create(bundle, preferredId) {
      const id = /^[A-Za-z0-9_-]{1,64}$/.test(preferredId) ? preferredId : null
      const attempt = (pid: string | null) => call('POST', `/v1/passports${pid ? `?id=${encodeURIComponent(pid)}` : ''}`, cfg.adminToken, { zip: bundle }) as Promise<{ id: string; revision: number }>
      try { return await attempt(id) } catch (e) {
        // a passport with this id survives a company removal (hosts never delete); give the new one a fresh id
        if (e instanceof ApiError && e.code === 'conflict') return attempt(`${(id ?? 'op').slice(0, 50)}-${now().toString(36)}`)
        throw e
      }
    },
    async grant(passportId, auth, app, scopes, trusted) {
      const r = await call('POST', `/v1/passports/${encodeURIComponent(passportId)}/grants`, auth, { json: { app, scopes, trusted } }) as { id: string; token: string }
      return { id: r.id, token: r.token }
    },
    async revoke(grantId, auth) { await call('DELETE', `/v1/grants/${encodeURIComponent(grantId)}`, auth) },
    async setTrusted(passportId, grantId, auth, trusted) { await call('PATCH', `/v1/passports/${encodeURIComponent(passportId)}/grants/${encodeURIComponent(grantId)}`, auth, { json: { trusted } }) },
    async revision(passportId, auth) {
      const r = await call('GET', `/v1/passports/${encodeURIComponent(passportId)}?format=json`, auth) as { revision?: number }
      return Number(r?.revision ?? 0)
    },
    async proposals(passportId, auth) { return (await call('GET', `/v1/passports/${encodeURIComponent(passportId)}/proposals`, auth) as HostProposal[]) ?? [] },
    async decide(passportId, proposalId, accept, auth) {
      const r = await call('POST', `/v1/passports/${encodeURIComponent(passportId)}/proposals/${encodeURIComponent(proposalId)}/${accept ? 'accept' : 'reject'}`, auth) as { status?: string }
      return { status: String(r?.status ?? 'unchanged') }
    }
  }
}

const titleOf = (path: string): string => {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return base ? base[0]!.toUpperCase() + base.slice(1) : 'the passport'
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "3 new facts for Marketing", "1 taste: prefers short emails", "A conflict in Company: the passport kept its line". */
export function proposalSummary(p: HostProposal): string {
  if (p.kind === 'conflict') {
    const c = (p.payload ?? {}) as { path?: string }
    return `A conflict in ${titleOf(c.path ?? '')}: the passport kept its line.`
  }
  const payload = (p.payload ?? {}) as { ops?: { op?: string; note?: string; path?: string; line?: string; polarity?: string; statement?: string }[]; polarity?: string; statement?: string; text?: string }
  if (p.kind === 'taste') {
    const s = payload.statement ?? payload.text ?? ''
    return s ? `1 taste from ${p.app}: ${payload.polarity ? `${payload.polarity} ` : ''}${s.slice(0, 120)}` : `1 taste from ${p.app}`
  }
  const ops = payload.ops ?? []
  const adds = ops.filter(o => o.op === 'add' || o.op === 'update')
  const notes = ops.filter(o => o.op === 'note')
  const where = [...new Set([...adds.map(o => o.note ?? ''), ...notes.map(o => o.path ?? '')].filter(Boolean).map(titleOf))]
  const parts: string[] = []
  if (adds.length) parts.push(plural(adds.length, 'new fact', 'new facts'))
  if (notes.length) parts.push(plural(notes.length, 'new note', 'new notes'))
  const rest = ops.length - adds.length - notes.length
  if (rest > 0) parts.push(plural(rest, 'other change', 'other changes'))
  if (!parts.length) return `A suggestion from ${p.app}`
  return `${parts.join(' and ')}${where.length ? ` for ${where.slice(0, 2).join(' and ')}${where.length > 2 ? ` and ${where.length - 2} more` : ''}` : ''} from ${p.app}`
}

export const toProposal = (p: HostProposal): PassportProposal => ({ id: p.id, kind: p.kind, app: p.app, created: p.created, summary: proposalSummary(p) })
