/**
 * REMOTE.md RA2: pairing codes and device tokens. A pairing code is random, lives 5 minutes and works once; a device
 * token is random and only its SHA-256 is kept (in memory: turning Phone off or quitting signs every phone out), and
 * the CSRF value is bound to the device. Only the newest code works (New code cancels the ones before it). Wrong
 * codes are rate limited per caller (5 a minute each) and, as a ceiling, across all callers; a live code always pairs,
 * so junk tries from someone who found the address can never lock the founder out. No Electron imports.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteDevice } from '../../shared/remote'
import { REMOTE_LIMITS, REMOTE_PAIR_PER_MINUTE, REMOTE_PAIR_TTL_MS } from '../../shared/remote'

export interface StoredDevice {
  id: string
  name: string
  /** sha256(token), hex */
  hash: string
  createdAt: string
  lastSeenAt: string | null
}

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
}

export class RemoteAuth {
  private codes = new Map<string, number>()
  private devs: StoredDevice[] = []
  /** HMAC key for the CSRF values; a new one each time Phone turns on */
  private secret = randomBytes(32).toString('hex')
  private readonly now: () => number
  private readonly perCaller: KeyedRateLimit
  private readonly all: RateLimit

  constructor(o: RemoteAuthOptions = {}) {
    this.now = o.now ?? Date.now
    this.perCaller = new KeyedRateLimit(REMOTE_PAIR_PER_MINUTE, 60_000, this.now)
    this.all = new RateLimit(PAIR_WRONG_ALL_PER_MINUTE, 60_000, this.now)
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
    const device: StoredDevice = { id: `dev_${randomBytes(8).toString('hex')}`, name: label || 'Phone', hash: sha256(token), createdAt: new Date(this.now()).toISOString(), lastSeenAt: new Date(this.now()).toISOString() }
    this.devs.push(device)
    return { token, device }
  }

  /** The device a token belongs to, or null (unknown, revoked). */
  verify(token: string | null | undefined): StoredDevice | null {
    if (!token || token.length > 200) return null
    const h = sha256(token)
    const d = this.devs.find((x) => eq(x.hash, h)) ?? null
    if (d) d.lastSeenAt = new Date(this.now()).toISOString()
    return d
  }

  csrfFor(deviceId: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${deviceId}`).digest('base64url')
  }
  checkCsrf(deviceId: string, header: string | null | undefined): boolean {
    return typeof header === 'string' && eq(header, this.csrfFor(deviceId))
  }

  devices(online: (id: string) => boolean = () => false): RemoteDevice[] {
    return this.devs.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: online(d.id) }))
  }
  revoke(id: string): boolean {
    const before = this.devs.length
    this.devs = this.devs.filter((d) => d.id !== id)
    return this.devs.length !== before
  }
  /** Turn off: every code and every device token dies, and the CSRF key changes. */
  reset(): void {
    this.codes.clear()
    this.devs = []
    this.secret = randomBytes(32).toString('hex')
  }
}
