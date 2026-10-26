/**
 * Hosted mode (REMOTE.md RA6): the Mac this phone paired with, kept in this site's localStorage. The address (a quick
 * tunnel's https origin) and the device token; nothing else from the Mac is stored. The Mac keeps only the token's
 * SHA-256, so revoking it there, or turning Phone off, makes this copy worthless at once.
 */
import { parsePairHash, siteOrigin } from '../../shared/remote'

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
