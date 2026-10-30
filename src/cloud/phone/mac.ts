/**
 * Hosted mode (REMOTE.md RA6): the Mac this phone paired with, kept in this site's localStorage. The address (a quick
 * tunnel's https origin) and the device token; nothing else from the Mac is stored. The Mac keeps only the token's
 * SHA-256, so revoking it there (or Sign out all phones) makes this copy worthless at once. Turning Phone off keeps it.
 */
import { helloMessage, parsePairHash, siteOrigin, type PhoneHelloResponse } from '../../shared/remote'
import { openAddress, RDV_ROUTE, RDV_SEALED_RE, rdvIds } from '../../shared/rendezvous'

export interface PairedMac {
  /** the Mac's origin, e.g. https://quiet-tree-42.trycloudflare.com */
  mac: string
  token: string
  device: { id: string; name: string }
  pairedAt: string
}

export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export const MAC_KEY = 'principia.phone.mac'

export function loadMac(s: StorageLike | null): PairedMac | null {
  try {
    const raw = s?.getItem(MAC_KEY)
    if (!raw) return null
    const m = JSON.parse(raw) as Partial<PairedMac>
    const mac = siteOrigin(m.mac)
    if (!mac || typeof m.token !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(m.token)) return null
    return { mac, token: m.token, device: { id: String(m.device?.id ?? ''), name: String(m.device?.name ?? 'Phone') }, pairedAt: String(m.pairedAt ?? '') }
  } catch {
    return null
  }
}
export function saveMac(s: StorageLike | null, m: PairedMac): void {
  try {
    s?.setItem(MAC_KEY, JSON.stringify(m))
  } catch {
    /* private mode: paired for this visit only */
  }
}
/** Signed out (revoked, Phone turned off, a token the Mac no longer knows): the token goes. */
export function forgetMac(s: StorageLike | null): void {
  try {
    s?.removeItem(MAC_KEY)
  } catch {
    /* nothing kept */
  }
}
/** "quiet-tree-42.trycloudflare.com" for the screens */
export function macHost(mac: string | null | undefined): string {
  try {
    return mac ? new URL(mac).host : ''
  } catch {
    return ''
  }
}
/** the live socket's address on the Mac (the token is never in it: it goes in the first message) */
export function liveUrl(base: string, loc: { protocol: string; host: string }): string {
  if (!base) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/live`
  const u = new URL(base)
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/api/live`
}
/**
 * A pairing link pasted into the app (a Home Screen app on iPhone, which the QR never opens): the whole link of this
 * site, or just its `#mac=…&code=…` part. Returns the fragment to open, or null. A link for another site is refused, so
 * pasting cannot be used to send this app somewhere else.
 */
export function pastedPairHash(text: string, siteOriginNow: string): string | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 2048) return null
  const i = t.indexOf('#')
  if (i < 0) return null
  if (i > 0) {
    try {
      if (new URL(t).origin !== siteOriginNow) return null
    } catch {
      return null
    }
  }
  const frag = t.slice(i)
  const p = parsePairHash(frag)
  return p && p.mac ? frag : null
}

// ---------- RA8: the Mac's new address ----------

const enc = new TextEncoder()
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}
/** The proof the real Mac gives at `origin`: HMAC-SHA256 keyed with sha256hex(token) (the Mac keeps only that hash). */
export async function helloProofFor(token: string, origin: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(await sha256Hex(token)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(helloMessage(origin, nonce))))
}
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export type MacCheck = 'ok' | 'unknown' | 'wrong' | 'gone'
/**
 * RA8: is `mac` the Mac this phone is paired with? It must sign a fresh nonce bound to that very address with the
 * token's hash. The token itself is never sent: a look-alike address (a forged link, a typo, a relay) learns nothing.
 * ok: go there; unknown: that Mac does not know this phone (pair again); wrong: not our Mac; gone: nothing answers.
 */
export async function checkMac(f: typeof fetch, mac: string, p: Pick<PairedMac, 'token' | 'device'>): Promise<MacCheck> {
  const origin = siteOrigin(mac)
  if (!origin || !p.device.id) return 'wrong'
  const nonce = newNonce()
  let res: Response
  try {
    res = await f(`${origin}/api/hello`, {
      method: 'POST',
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ device: p.device.id, nonce })
    })
  } catch {
    return 'gone'
  }
  const body = (await res.json().catch(() => null)) as (PhoneHelloResponse & { message?: string }) | null
  // a dead quick tunnel answers from Cloudflare's edge (HTML), never JSON
  if (!body || typeof body !== 'object') return res.status >= 500 || res.status === 404 ? 'gone' : 'wrong'
  if (res.status === 404) return 'unknown'
  if (!res.ok || typeof body.proof !== 'string') return 'wrong'
  return body.proof === (await helloProofFor(p.token, origin, nonce)) ? 'ok' : 'wrong'
}
/**
 * RA8: the Mac's new address, from the sealed record it left on this site, and only if the Mac there passes checkMac.
 * Anything else (no record, a record that does not open, a Mac that does not answer yet) is null: the phone just keeps
 * waiting, and the token has gone nowhere.
 */
export async function findMac(f: typeof fetch, site: string, p: Pick<PairedMac, 'mac' | 'token' | 'device'>): Promise<string | null> {
  try {
    const hash = await sha256Hex(p.token)
    const res = await f(`${site}${RDV_ROUTE}?id=${(await rdvIds(hash)).id}`, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    if (!res.ok) return null
    const sealed = ((await res.json()) as { sealed?: unknown }).sealed
    if (typeof sealed !== 'string' || !RDV_SEALED_RE.test(sealed)) return null
    const mac = siteOrigin(await openAddress(hash, sealed))
    return mac && mac !== p.mac && (await checkMac(f, mac, p)) === 'ok' ? mac : null
  } catch {
    return null
  }
}
