/**
 * Identity (CLOUD.md §5): pairing codes, device tokens (pdt_), console login links (pll_), sessions (pss_) with
 * double-submit CSRF, and the admin token (pairing only). Every token is 32 random bytes; only SHA-256 is stored.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import {
  CLOUD_LIMITS, CLOUD_TOKEN_PREFIX, CSRF_HEADER, LOGIN_LINK_TTL_MS, PAIRING_ALPHABET, PAIRING_TTL_MS, SESSION_TTL_MS,
  type CloudDevice, type LoginLinkResponse, type PairCompleteResponse, type PairStartResponse
} from '../../shared/cloud'
import type { Actor, Ctx } from './context'
import { newId } from './db'
import { ApiError, cookie } from './http'

export const SESSION_COOKIE = 'principia_session'
const LAST_SEEN_THROTTLE_MS = 60_000
const PAIR_WINDOW_MS = 10 * 60_000

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
export const mintToken = (prefix: string): string => prefix + randomBytes(32).toString('base64url')
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 'k7qm4xwd' / 'K7QM-4XWD' -> 'K7QM4XWD' (null when it cannot be a code) */
export function normalizeCode(code: string): string | null {
  const c = code.replace(/[\s-]/g, '').toUpperCase()
  return c.length === 8 && [...c].every(ch => PAIRING_ALPHABET.includes(ch)) ? c : null
}

export function mintPairingCode(ctx: Pick<Ctx, 'db' | 'now' | 'workspaceId'>): PairStartResponse {
  let raw = ''
  for (let i = 0; i < 8; i++) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
  const now = ctx.now()
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString()
  ctx.db.run('INSERT INTO pairing_codes (id, workspace_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', newId('pc_'), ctx.workspaceId, sha256(raw), now.toISOString(), expiresAt)
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt }
}

/** 10 failed pairing attempts per IP per 10 minutes, then 429 (CLOUD.md §11). */
export class PairLimiter {
  private fails = new Map<string, number[]>()
  constructor(private now: () => Date) {}
  private recent(ip: string): number[] {
    const t = this.now().getTime()
    const list = (this.fails.get(ip) ?? []).filter(x => t - x < PAIR_WINDOW_MS)
    if (list.length) this.fails.set(ip, list); else this.fails.delete(ip)
    return list
  }
  blocked(ip: string): boolean { return this.recent(ip).length >= CLOUD_LIMITS.pairAttempts }
  fail(ip: string): void { const l = this.recent(ip); l.push(this.now().getTime()); this.fails.set(ip, l) }
}

interface DeviceRow { id: string; name: string; platform: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }
const deviceOf = (r: DeviceRow, currentId?: string): CloudDevice => ({ id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ...(currentId ? { current: r.id === currentId } : {}) })

export function completePairing(ctx: Ctx, limiter: PairLimiter, ip: string, body: { code?: unknown; deviceName?: unknown; platform?: unknown }): PairCompleteResponse {
  if (limiter.blocked(ip)) throw new ApiError('rate_limited', 'Too many tries. Wait 10 minutes, then make a new connect link.')
  const code = typeof body.code === 'string' ? normalizeCode(body.code) : null
  const name = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 120) : ''
  const platform = typeof body.platform === 'string' ? body.platform.trim().slice(0, 64) : ''
  if (!name || !platform) throw new ApiError('bad_request', 'deviceName and platform are required.')
  const now = ctx.now().toISOString()
  const used = code ? ctx.db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', now, sha256(code), now) : 0
  if (!used) { limiter.fail(ip); throw new ApiError('unauthorized', 'That connect link is not valid or has expired. Run `principia-cloud pair` for a new one.') }
  const token = mintToken(CLOUD_TOKEN_PREFIX.device)
  const id = newId('dev_')
  ctx.db.run('INSERT INTO devices (id, workspace_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ctx.workspaceId, name, platform, sha256(token), now, now)
  ctx.audit({ kind: 'device', id, name }, 'device.pair', null, id, { platform })
  return { deviceToken: token, device: deviceOf(ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', id)!, id), workspace: ctx.workspace() }
}

export type Principal =
  | { kind: 'device'; device: CloudDevice; actor: Actor }
  | { kind: 'session'; session: { id: string; expiresAt: string; csrf: string }; actor: Actor }

export function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1]! : null
}

/** Device token or console session; null when neither is valid. */
export function authenticate(ctx: Ctx, req: IncomingMessage): Principal | null {
  const tok = bearer(req)
  const now = ctx.now()
  if (tok?.startsWith(CLOUD_TOKEN_PREFIX.device)) {
    const r = ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', sha256(tok))
    if (!r) return null
    if (!r.last_seen_at || now.getTime() - Date.parse(r.last_seen_at) >= LAST_SEEN_THROTTLE_MS) {
      ctx.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now.toISOString(), r.id)
      r.last_seen_at = now.toISOString()
    }
    return { kind: 'device', device: deviceOf(r, r.id), actor: { kind: 'device', id: r.id, name: r.name } }
  }
  const c = cookie(req, SESSION_COOKIE)
  if (c?.startsWith(CLOUD_TOKEN_PREFIX.session)) {
    const s = ctx.db.get<{ id: string; csrf: string; expires_at: string }>('SELECT id, csrf, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?', sha256(c), now.toISOString())
    if (!s) return null
    return { kind: 'session', session: { id: s.id, expiresAt: s.expires_at, csrf: s.csrf }, actor: { kind: 'session', id: s.id, name: 'console' } }
  }
  return null
}

export function checkCsrf(p: Principal, req: IncomingMessage): void {
  if (p.kind !== 'session') return
  const h = req.headers[CSRF_HEADER]
  if (typeof h !== 'string' || !safeEqual(h, p.session.csrf)) throw new ApiError('forbidden', 'Missing or wrong CSRF header. Reload the console.')
}

/** The admin bearer is valid only for POST /v1/pair/start. Without PRINCIPIA_ADMIN_TOKEN the route answers 403. */
export function checkAdmin(ctx: Ctx, req: IncomingMessage): Actor {
  const tok = bearer(req)
  if (!ctx.config.adminToken) throw new ApiError('forbidden', 'Pairing over the API is off. Run `principia-cloud pair` on the server.')
  if (!tok || !safeEqual(tok, ctx.config.adminToken)) throw new ApiError('unauthorized', 'A valid admin token is required.')
  return { kind: 'admin', id: null, name: 'admin token' }
}

export function createLoginLink(ctx: Ctx, deviceId: string): LoginLinkResponse {
  const token = mintToken(CLOUD_TOKEN_PREFIX.loginLink)
  const now = ctx.now()
  const expiresAt = new Date(now.getTime() + LOGIN_LINK_TTL_MS).toISOString()
  ctx.db.run('INSERT INTO login_links (id, workspace_id, token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', newId('ll_'), ctx.workspaceId, sha256(token), deviceId, now.toISOString(), expiresAt)
  return { url: `${ctx.config.publicUrl}/console/login?t=${token}`, expiresAt }
}

/** Single use. Returns the new session's cookie value, or null. */
export function consumeLoginLink(ctx: Ctx, token: string): { token: string; id: string; expiresAt: string } | null {
  if (!token.startsWith(CLOUD_TOKEN_PREFIX.loginLink)) return null
  const now = ctx.now()
  const link = ctx.db.get<{ id: string; device_id: string | null }>('SELECT id, device_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(token), now.toISOString())
  // the device that minted the link must still be paired
  if (link?.device_id && !ctx.db.get('SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL', link.device_id)) return null
  if (!link || !ctx.db.run('UPDATE login_links SET used_at = ? WHERE id = ? AND used_at IS NULL', now.toISOString(), link.id)) return null
  const session = mintToken(CLOUD_TOKEN_PREFIX.session)
  const id = newId('ses_')
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  ctx.db.run('INSERT INTO sessions (id, workspace_id, token_hash, csrf, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ctx.workspaceId, sha256(session), randomBytes(24).toString('base64url'), link.device_id, now.toISOString(), expiresAt)
  ctx.audit({ kind: 'session', id, name: 'console' }, 'session.create', null, id, {})
  return { token: session, id, expiresAt }
}

export function sessionCookie(ctx: Ctx, value: string, maxAgeSec: number): string {
  const secure = ctx.config.publicUrl.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`
}

export function listDevices(ctx: Ctx, currentId: string | null): CloudDevice[] {
  return ctx.db.all<DeviceRow>('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at').map(r => deviceOf(r, currentId ?? ''))
}

export function revokeDevice(ctx: Ctx, id: string): boolean {
  const ok = ctx.db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ctx.now().toISOString(), id) > 0
  if (ok) ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', ctx.now().toISOString(), id)
  return ok
}

export const anyDevicePaired = (ctx: Pick<Ctx, 'db'>): boolean => !!ctx.db.get('SELECT id FROM devices WHERE revoked_at IS NULL LIMIT 1')
