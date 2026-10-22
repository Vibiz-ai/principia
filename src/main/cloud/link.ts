/**
 * Principia Cloud: this Mac's link to a cloud workspace (docs/CLOUD.md §5, §8). The desktop attaches to the cloud the
 * way Git attaches to a remote.
 *
 * - The connection lives in `<userData>/cloud-link.json` (0600): URL, workspace, device id and the device token,
 *   encrypted with safeStorage. Without safeStorage nothing is stored (and pairing refuses).
 * - While linked it polls GET /v1/sync/changes every 30 s, and at once when /v1/events says something moved.
 * - It owns the set of schedules placed in the cloud: the local scheduler never fires those (`guardSchedules`).
 * - When a cloud company's passport has a newer revision on the host, it runs the existing PassportSync for it.
 * - Every state change is emitted as evt:cloud. No token ever reaches an event, a log line or the renderer.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HiveError } from '../../shared/errors'
import { parseConnectLink, type CloudAsk, type CloudEvent, type PairCompleteResponse, type SyncChanges } from '../../shared/cloud'
import type { CloudDesktopEvent, CloudLinkState, CloudLoginStatus, Id, Schedule } from '../../shared/types'
import type { Cipher } from '../vault'
import { CloudClient, CloudRequestError } from './client'

export const LINK_FILE = 'cloud-link.json'
export const POLL_MS = 30_000

interface LinkFile {
  v: 1
  url: string
  workspace: { id: Id; name: string }
  deviceId: Id
  /** base64 of the safeStorage ciphertext of the device token */
  token: string
  /** the cloud rev each pushed workflow / schedule was last based on (baseRev of the next push) */
  revs: { workflows: Record<Id, number>; schedules: Record<Id, number> }
  /** schedules placed in the cloud */
  schedules: Id[]
  /** companies run in the cloud, with the passport the cloud created for each */
  companies: Record<Id, { passportId: string | null; hostUrl: string | null }>
  cursor: string | null
  /** the host passport revision PassportSync last caught up with, per company */
  passportRevs: Record<Id, number>
}

/** The PassportSync calls the link needs (handlers/openPassport.ts `sync`, with the existing config file). */
export interface PassportSyncPort {
  configure(companyId: Id, cfg: { url: string; passportId: string; token: string }): Promise<void> | void
  sync(companyId: Id): Promise<unknown>
  /** true when PassportSync has a host for this company */
  configured(companyId: Id): boolean
  /** removes the company's PassportSync host when it is this passport (the cloud's) */
  clear?(companyId: Id, passportId: string): Promise<void> | void
}

export interface CloudLinkDeps {
  userData: string
  cipher: Cipher
  emit(e: CloudDesktopEvent): void
  fetch?: typeof fetch
  now?: () => Date
  host?: () => { deviceName: string; platform: string }
  passport?: PassportSyncPort | null
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  pollMs?: number
  /** open /v1/events while linked (default true) */
  sse?: boolean
  /**
   * Schedules that fire on this Mac again (moved back, unticked, the server says local, or unlinked). The scheduler
   * recomputes their next slot from now: the slots the cloud owned are not "missed", and never caught up here.
   */
  released?(scheduleIds: Id[]): void
}

export function defaultHost(): { deviceName: string; platform: string } {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    /* no user info */
  }
  const host = os.hostname().replace(/\.local$/, '')
  const name = user ? `${user} on ${host}` : host
  return { deviceName: name.slice(0, 80) || 'This Mac', platform: `${process.platform}-${process.arch}` }
}

/** A loopback connect link that does not answer here: it was printed on another machine (CLOUD.md §12.1). */
export const LOCAL_LINK_ONLY = 'This link only works on the machine running your cloud. Open a tunnel to it (ssh -L 8787:127.0.0.1:8787 you@your-server), or give the cloud a public address and make a new link.'

export class CloudLink {
  private file: LinkFile | null = null
  private tokenPlain: string | null = null
  private timer: NodeJS.Timeout | null = null
  private sse: { close(): void } | null = null
  private pollDebounce: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null
  private syncing = new Set<Id>()
  private asks = new Map<Id, CloudAsk['status']>()
  private online = false
  private offlineSince: string | null = null
  private lastSyncAt: string | null = null
  private error: string | null = null
  private loginStatus: CloudLoginStatus | null = null
  /** guarded scheduler stores (re-wrapped never twice) */
  private guarded = new WeakSet<object>()

  constructor(private d: CloudLinkDeps) {
    this.load()
  }

  private get path(): string {
    return path.join(this.d.userData, LINK_FILE)
  }
  private now(): Date {
    return this.d.now?.() ?? new Date()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8')) as LinkFile
      if (raw?.v !== 1 || !raw.url || !raw.token) return
      this.file = { ...raw, revs: raw.revs ?? { workflows: {}, schedules: {} }, schedules: raw.schedules ?? [], companies: raw.companies ?? {}, passportRevs: raw.passportRevs ?? {}, cursor: raw.cursor ?? null }
    } catch {
      this.file = null
    }
  }
  private save(): void {
    if (!this.file) return
    fs.mkdirSync(this.d.userData, { recursive: true })
    const tmp = `${this.path}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.path)
    try {
      fs.chmodSync(this.path, 0o600)
    } catch {
      /* best effort */
    }
  }

  private encryption(): boolean {
    try {
      return this.d.cipher.available()
    } catch {
      return false
    }
  }

  /** The device token, decrypted in main memory only. */
  private token(): string | null {
    if (!this.file) return null
    if (this.tokenPlain) return this.tokenPlain
    if (!this.encryption()) return null
    try {
      this.tokenPlain = this.d.cipher.decrypt(Buffer.from(this.file.token, 'base64'))
    } catch {
      this.tokenPlain = null
    }
    return this.tokenPlain
  }

  get linked(): boolean {
    return !!this.file
  }

  state(): CloudLinkState {
    const f = this.file
    return {
      linked: !!f,
      url: f?.url ?? null,
      workspace: f?.workspace ?? null,
      deviceId: f?.deviceId ?? null,
      encryption: this.encryption(),
      online: !!f && this.online,
      offlineSince: f ? this.offlineSince : null,
      lastSyncAt: f ? this.lastSyncAt : null,
      error: f ? this.error : null,
      cloudCompanyIds: f ? Object.keys(f.companies) : [],
      cloudScheduleIds: f ? [...f.schedules] : [],
      openAsks: f ? [...this.asks.values()].filter((s) => s === 'open').length : 0,
      login: this.loginStatus
    }
  }

  private release(ids: Id[]): void {
    if (!ids.length || !this.d.released) return
    try {
      this.d.released(ids)
    } catch (e) {
      this.d.log?.warn('cloud: releasing schedules failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private changed(): void {
    this.d.emit({ kind: 'state', state: this.state() })
  }

  /** A client with the device token. Throws when this Mac is not linked (or the token cannot be read). */
  client(): CloudClient {
    const t = this.token()
    if (!this.file || !t) throw new HiveError('conflict', 'Connect this Mac to a cloud first.')
    return new CloudClient({ url: this.file.url, token: t, fetch: this.d.fetch })
  }

  /** Runs a cloud call and keeps the Online / Offline state honest. */
  async call<T>(fn: (c: CloudClient) => Promise<T>): Promise<T> {
    const c = this.client()
    try {
      const out = await fn(c)
      this.markOnline()
      return out
    } catch (e) {
      this.markFailure(e)
      throw e
    }
  }

  private markOnline(): void {
    const was = this.online && !this.error
    this.online = true
    this.offlineSince = null
    this.error = null
    if (!was) this.changed()
  }
  private markFailure(e: unknown): void {
    if (!(e instanceof CloudRequestError)) return
    if (e.cloudCode === 'unauthorized') {
      this.error = e.message
      this.online = false
      this.offlineSince ??= this.now().toISOString()
      this.stopTimers()
      this.changed()
    } else if (e.cloudCode === 'network' || e.cloudCode === 'timeout') {
      const was = this.online
      this.online = false
      this.offlineSince ??= this.now().toISOString()
      if (was || !this.error) this.changed()
    }
  }

  // ---------- pairing ----------

  /** Pairs with a connect link (`<url>/pair#XXXX-XXXX`), or a URL and code from the hidden fallback. */
  async pair(input: { link?: string; url?: string; code?: string }): Promise<CloudLinkState> {
    if (!this.encryption()) throw new HiveError('vault_unavailable', "macOS Keychain encryption is unavailable, so Principia won't store the cloud's token.")
    const parsed = input.link ? parseConnectLink(input.link) : input.url && input.code ? parseConnectLink(`${input.url.trim().replace(/\/+$/, '')}/pair#${input.code}`) : null
    if (!parsed) throw new HiveError('bad_request', input.link ? 'That is not a connect link. It looks like https://your-cloud/pair#K7QM-4XWD.' : 'Enter the cloud URL and the 8-character code.')
    const u = new URL(parsed.url)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (u.protocol !== 'https:' && !local) throw new HiveError('bad_request', 'Use an https:// address for your cloud (http only for localhost).')
    const host = (this.d.host ?? defaultHost)()
    const client = new CloudClient({ url: parsed.url, fetch: this.d.fetch })
    let res: PairCompleteResponse
    try {
      res = await client.call<PairCompleteResponse>('pairComplete', { body: { code: parsed.code, deviceName: host.deviceName, platform: host.platform } })
    } catch (e) {
      // CLOUD.md §12.1: a 127.0.0.1 link printed on a server only works on that server
      if (local && e instanceof CloudRequestError && (e.cloudCode === 'network' || e.cloudCode === 'timeout')) throw new HiveError('bad_request', LOCAL_LINK_ONLY)
      throw e
    }
    if (!res?.deviceToken || !res.device?.id) throw new HiveError('internal', 'Your cloud answered without a device token.')
    this.stop()
    this.file = {
      v: 1,
      url: parsed.url,
      workspace: { id: res.workspace.id, name: res.workspace.name },
      deviceId: res.device.id,
      token: this.d.cipher.encrypt(res.deviceToken).toString('base64'),
      revs: { workflows: {}, schedules: {} },
      schedules: [],
      companies: {},
      cursor: null,
      passportRevs: {}
    }
    this.tokenPlain = res.deviceToken
    this.asks.clear()
    this.online = true
    this.offlineSince = null
    this.error = null
    this.save()
    this.d.log?.info('cloud: paired', { url: parsed.url, workspace: res.workspace.id, device: res.device.id })
    this.changed()
    this.start()
    return this.state()
  }

  /** Revokes this device (best effort: an unreachable cloud must not keep the Mac linked) and forgets the link. */
  async unlink(): Promise<CloudLinkState> {
    const f = this.file
    if (f) {
      try {
        await this.client().call('deviceRevoke', { params: { id: f.deviceId } })
      } catch (e) {
        this.d.log?.warn('cloud: revoke on unlink failed', { error: e instanceof Error ? e.message : String(e) })
      }
    }
    this.stop()
    const released = f ? [...f.schedules] : []
    this.file = null
    this.tokenPlain = null
    this.asks.clear()
    this.online = false
    this.offlineSince = null
    this.error = null
    this.lastSyncAt = null
    try {
      fs.rmSync(this.path, { force: true })
    } catch {
      /* already gone */
    }
    this.release(released)
    this.changed()
    return this.state()
  }

  // ---------- polling and events ----------

  /** Starts polling (and the event stream) while linked. Idempotent. */
  start(): void {
    if (!this.file || this.timer || this.error) return
    this.timer = setInterval(() => void this.pollNow().catch(() => undefined), this.d.pollMs ?? POLL_MS)
    this.timer.unref?.()
    if (this.d.sse !== false) {
      try {
        this.sse = this.client().events((e) => this.onEvent(e), {
          onOpen: () => this.markOnline(),
          onError: (e) => this.markFailure(e)
        })
      } catch {
        this.sse = null
      }
    }
    void this.pollNow().catch(() => undefined)
  }
  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.pollDebounce) clearTimeout(this.pollDebounce)
    this.pollDebounce = null
    this.sse?.close()
    this.sse = null
  }
  stop(): void {
    this.stopTimers()
  }

  private onEvent(e: CloudEvent): void {
    this.d.emit({ kind: 'event', event: e })
    if (e.kind === 'ask') {
      this.asks.set(e.ask.id, e.ask.status)
      this.changed()
    }
    if (e.kind === 'run' || e.kind === 'ask' || e.kind === 'step' || e.kind === 'workspace') {
      if (this.pollDebounce) clearTimeout(this.pollDebounce)
      this.pollDebounce = setTimeout(() => void this.pollNow().catch(() => undefined), 250)
    }
  }

  /** One GET /v1/sync/changes. Concurrent callers share the request in flight. */
  pollNow(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.poll().finally(() => (this.polling = null))
    return this.polling
  }

  private async poll(): Promise<void> {
    const f = this.file
    if (!f) return
    const ch = await this.call((c) => c.call<SyncChanges>('syncChanges', { query: { since: f.cursor } }))
    if (this.file !== f) return
    this.lastSyncAt = this.now().toISOString()
    f.cursor = ch.cursor ?? f.cursor
    for (const a of ch.asks ?? []) this.asks.set(a.id, a.status)
    // schedules the server changed: keep our rev and placement in step with the cloud's
    const released: Id[] = []
    for (const s of ch.schedules ?? []) {
      f.revs.schedules[s.id] = s.rev
      const owned = f.schedules.includes(s.id)
      if (s.placement === 'cloud' && !owned) f.schedules.push(s.id)
      if (s.placement === 'local' && owned) {
        f.schedules = f.schedules.filter((x) => x !== s.id)
        released.push(s.id)
      }
    }
    this.save()
    this.release(released)
    const runs = ch.runs?.length ?? 0
    const asks = ch.asks?.length ?? 0
    if (runs + asks > 0) this.d.emit({ kind: 'changes', runs, asks })
    this.changed()
    for (const p of ch.passports ?? []) await this.passportCaughtUp(p.companyId, p.revision)
  }

  /** A newer passport revision on the host for a cloud company: pull it into the vault with PassportSync. */
  private async passportCaughtUp(companyId: Id, revision: number): Promise<void> {
    const f = this.file
    const port = this.d.passport
    if (!f || !port || !f.companies[companyId]) return
    const known = f.passportRevs[companyId]
    if (known !== undefined && revision <= known) return
    if (!port.configured(companyId) || this.syncing.has(companyId)) return
    this.syncing.add(companyId)
    try {
      const r = (await port.sync(companyId)) as { revision?: number; sync?: { revision?: number } } | undefined
      const after = r?.sync?.revision ?? r?.revision ?? revision
      f.passportRevs[companyId] = Math.max(revision, after)
      this.save()
    } catch (e) {
      this.d.log?.warn('cloud: passport sync failed', { companyId, error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.syncing.delete(companyId)
    }
  }

  // ---------- what this Mac pushed ----------

  ownsSchedule(id: Id): boolean {
    return !!this.file?.schedules.includes(id)
  }
  setSchedulePlacement(id: Id, placement: 'local' | 'cloud', rev?: number): void {
    const f = this.file
    if (!f) return
    const was = f.schedules.includes(id)
    f.schedules = f.schedules.filter((x) => x !== id)
    if (placement === 'cloud') f.schedules.push(id)
    if (rev !== undefined) f.revs.schedules[id] = rev
    this.save()
    if (was && placement === 'local') this.release([id])
    this.changed()
  }
  scheduleRev(id: Id): number | null {
    return this.file?.revs.schedules[id] ?? null
  }
  workflowRev(id: Id): number | null {
    return this.file?.revs.workflows[id] ?? null
  }
  setWorkflowRev(id: Id, rev: number | null): void {
    const f = this.file
    if (!f) return
    if (rev === null) delete f.revs.workflows[id]
    else f.revs.workflows[id] = rev
    this.save()
  }
  isCloudCompany(id: Id): boolean {
    return !!this.file?.companies[id]
  }
  cloudCompany(id: Id): { passportId: string | null; hostUrl: string | null } | null {
    return this.file?.companies[id] ?? null
  }
  markCompany(id: Id, passport: { passportId: string | null; hostUrl: string | null }): void {
    const f = this.file
    if (!f) return
    f.companies[id] = { ...(f.companies[id] ?? {}), ...passport }
    this.save()
    this.changed()
  }
  /** "Bring back to this Mac": the company and its schedules are local again. */
  unmarkCompany(id: Id, scheduleIds: Id[]): void {
    const f = this.file
    if (!f) return
    delete f.companies[id]
    delete f.passportRevs[id]
    const released = f.schedules.filter((s) => scheduleIds.includes(s))
    f.schedules = f.schedules.filter((s) => !scheduleIds.includes(s))
    for (const s of scheduleIds) delete f.revs.schedules[s]
    this.save()
    this.release(released)
    this.changed()
  }

  /** The account linking in progress (logins.ts reports here so the pane follows it through evt:cloud). */
  setLogin(status: CloudLoginStatus | null): void {
    this.loginStatus = status
    this.changed()
  }

  /**
   * Schedules placed in the cloud fire there only (CLOUD.md §8): the local scheduler reads its schedules through this
   * store, so they never fire here. Lists for the UI read the main Store and still show them, with the cloud mark.
   */
  guardSchedules<S extends { listSchedules(): Schedule[]; getSchedule?(id: Id): Schedule | null }>(store: S): S {
    if (this.guarded.has(store)) return store
    const original = store.listSchedules.bind(store)
    store.listSchedules = () => original().filter((s) => !this.ownsSchedule(s.id))
    // Run now and fire now read one schedule: a cloud-owned one is not this scheduler's to start (CLOUD.md §8)
    if (store.getSchedule) {
      const one = store.getSchedule.bind(store)
      store.getSchedule = (id: Id) => (this.ownsSchedule(id) ? null : one(id))
    }
    this.guarded.add(store)
    return store
  }
}
