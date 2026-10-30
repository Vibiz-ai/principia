/**
 * REMOTE.md RA2: pairing codes and device tokens. A pairing code is random, lives 5 minutes and works once; a device
 * token is random and only its SHA-256 is kept (in hive.db through a DeviceStore, so a phone stays paired across
 * restarts; turning Phone off no longer signs anyone out). A token lives 90 days after its last use and is rotated when
 * the phone comes back (the old one works for a short grace). The CSRF value is bound to the device. Only the newest
 * code works (New code cancels the ones before it). Wrong codes are rate limited per caller (5 a minute each) and, as a
 * ceiling, across all callers; a live code always pairs, so junk tries from someone who found the address can never
 * lock the founder out. No Electron imports.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteDevice } from '../../shared/remote'
import { HELLO_NONCE_RE, helloMessage, REMOTE_LIMITS, REMOTE_PAIR_PER_MINUTE, REMOTE_PAIR_TTL_MS, REMOTE_ROTATE_GRACE_MS, REMOTE_TOKEN_TTL_MS } from '../../shared/remote'
import { MemoryDeviceStore, type DeviceStore, type StoredDevice } from './devices'

export type { StoredDevice } from './devices'

export class PairError extends Error {
  constructor(
    message: string,
    readonly code: 'expired' | 'rate_limited' | 'bad_request'
  ) {
    super(message)
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Sliding window: at most `max` hits per `windowMs`. */
export class RateLimit {
  private hits: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}
  take(): boolean {
    const t = this.now()
    this.hits = this.hits.filter((x) => t - x < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(t)
    return true
  }
}

/** RateLimit per key (the caller's address), with forgetting so the map cannot grow without end. */
export class KeyedRateLimit {
  private m = new Map<string, RateLimit>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}
  take(key: string): boolean {
    if (this.m.size > 2000) this.m.clear()
    let r = this.m.get(key)
    if (!r) this.m.set(key, (r = new RateLimit(this.max, this.windowMs, this.now)))
    return r.take()
  }
}

/** wrong codes from everyone together, a minute: well above any real use, a ceiling for a flood */
const PAIR_WRONG_ALL_PER_MINUTE = 60

export interface RemoteAuthOptions {
  now?: () => number
  /** where paired devices are kept (hive.db in the app); default: memory */
  store?: DeviceStore
}
/** last-seen writes to disk at most this often per device (every request updates it in memory) */
const SEEN_WRITE_MS = 60_000

export class RemoteAuth {
  private codes = new Map<string, number>()
  private devs: StoredDevice[]
  /** HMAC key for the CSRF values; a new one each time Phone turns off */
  private secret = randomBytes(32).toString('hex')
  private readonly now: () => number
  private readonly perCaller: KeyedRateLimit
  private readonly all: RateLimit
  private readonly store: DeviceStore
  /** device id -> when its last-seen was last written */
  private written = new Map<string, number>()

  constructor(o: RemoteAuthOptions = {}) {
    this.now = o.now ?? Date.now
    this.perCaller = new KeyedRateLimit(REMOTE_PAIR_PER_MINUTE, 60_000, this.now)
    this.all = new RateLimit(PAIR_WRONG_ALL_PER_MINUTE, 60_000, this.now)
    this.store = o.store ?? new MemoryDeviceStore()
    this.devs = this.store.load()
    this.sweepExpired()
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }
  /** an expired device is revoked (its hashes leave the disk) */
  private sweepExpired(): void {
    const t = this.now()
    for (const d of [...this.devs]) if (Date.parse(d.expiresAt) <= t) this.revoke(d.id)
  }

  /** A new one-time code (32 hex chars, 128 bits), valid for REMOTE_PAIR_TTL_MS. It cancels every earlier code. */
  createCode(): { code: string; expiresAt: number } {
    this.codes.clear()
    const code = randomBytes(16).toString('hex')
    const expiresAt = this.now() + REMOTE_PAIR_TTL_MS
    this.codes.set(sha256(code), expiresAt)
    return { code, expiresAt }
  }
  private sweep(): void {
    const t = this.now()
    for (const [k, exp] of this.codes) if (exp <= t) this.codes.delete(k)
  }

  /**
   * Trades a code for a device token. The code is spent even when the name is bad. Throws PairError. `caller` is who
   * asks (the phone's address); a wrong code costs that caller one of its tries, a live code always works.
   */
  pair(code: unknown, name: unknown, caller = 'local'): { token: string; device: StoredDevice } {
    this.sweep()
    const key = typeof code === 'string' && /^[0-9a-f]{32}$/.test(code) ? sha256(code) : null
    const exp = key ? this.codes.get(key) : undefined
    if (!key || exp === undefined || exp <= this.now()) {
      const ok = this.perCaller.take(caller) && this.all.take()
      if (!ok) throw new PairError('Too many tries. Wait a minute and scan the code again.', 'rate_limited')
      throw new PairError('This link expired. Make a new one on your Mac.', 'expired')
    }
    this.codes.delete(key)
    const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, REMOTE_LIMITS.name) : ''
    const token = randomBytes(32).toString('base64url')
    const now = this.iso()
    const device: StoredDevice = { id: `dev_${randomBytes(8).toString('hex')}`, name: label || 'Phone', hash: sha256(token), prevHash: null, prevUntil: null, createdAt: now, lastSeenAt: now, expiresAt: this.iso(this.now() + REMOTE_TOKEN_TTL_MS) }
    this.devs.push(device)
    this.store.put(device)
    this.written.set(device.id, this.now())
    return { token, device }
  }

  /**
   * The device a token belongs to, or null (unknown, revoked, expired). Each use pushes the expiry out 90 days. The
   * token before the last rotation still works during its grace; the first use of the new one ends that grace.
   */
  verify(token: string | null | undefined): StoredDevice | null {
    if (!token || token.length > 200) return null
    const h = sha256(token)
    const t = this.now()
    let d = this.devs.find((x) => eq(x.hash, h)) ?? null
    let current = !!d
    if (!d) {
      d = this.devs.find((x) => !!x.prevHash && !!x.prevUntil && Date.parse(x.prevUntil) > t && eq(x.prevHash, h)) ?? null
      current = false
    }
    if (!d) return null
    if (Date.parse(d.expiresAt) <= t) {
      this.revoke(d.id)
      return null
    }
    let must = false
    if (current && d.prevHash) {
      d.prevHash = null
      d.prevUntil = null
      must = true
    }
    d.lastSeenAt = this.iso(t)
    d.expiresAt = this.iso(t + REMOTE_TOKEN_TTL_MS)
    if (must || t - (this.written.get(d.id) ?? 0) >= SEEN_WRITE_MS) {
      this.store.put(d)
      this.written.set(d.id, t)
    }
    return d
  }

  /** RA2: a new token for this device (the phone came back). The old one works for REMOTE_ROTATE_GRACE_MS. */
  rotate(id: string): { token: string; expiresAt: string } | null {
    const d = this.devs.find((x) => x.id === id)
    if (!d) return null
    const token = randomBytes(32).toString('base64url')
    const t = this.now()
    d.prevHash = d.hash
    d.prevUntil = this.iso(t + REMOTE_ROTATE_GRACE_MS)
    d.hash = sha256(token)
    d.lastSeenAt = this.iso(t)
    d.expiresAt = this.iso(t + REMOTE_TOKEN_TTL_MS)
    this.store.put(d)
    this.written.set(d.id, t)
    return { token, expiresAt: d.expiresAt }
  }

  /**
   * RA8: the Mac proves it knows this device at `origin` (the address the phone called): HMAC-SHA256 keyed with the
   * token's hash, which only this Mac and the phone have. null: unknown, revoked or expired device, or a bad nonce.
   */
  helloProof(id: unknown, origin: string, nonce: unknown): string | null {
    if (typeof id !== 'string' || typeof nonce !== 'string' || !HELLO_NONCE_RE.test(nonce)) return null
    const d = this.devs.find((x) => x.id === id)
    if (!d || Date.parse(d.expiresAt) <= this.now()) return null
    return createHmac('sha256', d.hash).update(helloMessage(origin, nonce)).digest('hex')
  }

  csrfFor(deviceId: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${deviceId}`).digest('base64url')
  }
  checkCsrf(deviceId: string, header: string | null | undefined): boolean {
    return typeof header === 'string' && eq(header, this.csrfFor(deviceId))
  }

  /** RA8: sha256hex(token) of each paired phone, for its sealed address */
  hashes(): string[] {
    this.sweepExpired()
    return this.devs.map((d) => d.hash)
  }
  get count(): number {
    return this.devs.length
  }
  devices(online: (id: string) => boolean = () => false): RemoteDevice[] {
    return this.devs.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: online(d.id) }))
  }
  revoke(id: string): boolean {
    const before = this.devs.length
    this.devs = this.devs.filter((d) => d.id !== id)
    this.store.revoke(id, this.iso())
    this.written.delete(id)
    return this.devs.length !== before
  }
  /** "Sign out all phones": every device token dies. Returns the ids that were signed out. */
  revokeAll(): string[] {
    const ids = this.devs.map((d) => d.id)
    for (const id of ids) this.revoke(id)
    return ids
  }
  /** Turn off: codes die and the CSRF key changes. Paired phones stay paired (their tokens work when Phone is on again). */
  endSession(): void {
    this.codes.clear()
    this.secret = randomBytes(32).toString('hex')
  }
  /** Everything at once: every code and every device token dies, and the CSRF key changes. */
  reset(): void {
    this.revokeAll()
    this.endSession()
  }
}
