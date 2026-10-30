/**
 * REMOTE.md RA8: the sealed address lookup. The Mac leaves its current address on the phone site, sealed so that only
 * the phone it belongs to can read it. Both sides start from sha256hex(token): the Mac keeps only that, the phone can
 * compute it, the site never sees it. One record per phone. The site holds random ids and ciphertext, nothing else.
 *
 * - write secret = HMAC(hash, RDV_WRITE_LABEL), hex. The site lets a write in only when sha256hex(write secret) = id.
 * - id = sha256hex(write secret). So reading (or logging) an id gives no way to overwrite its record.
 * - key = HMAC(hash, RDV_KEY_LABEL), for AES-256-GCM; sealed = base64url(iv (12 bytes) + ciphertext + tag).
 *
 * WebCrypto only: the same code runs on the Mac and in the phone app. ios/Principia/Core/MacMove.swift mirrors it.
 */
export const RDV_ROUTE = '/api/where'
export const RDV_WRITE_LABEL = 'principia-rdv-write-v1'
export const RDV_KEY_LABEL = 'principia-rdv-key-v1'
export const RDV_ID_RE = /^[0-9a-f]{64}$/
/** an address of up to 200 characters, sealed */
export const RDV_SEALED_RE = /^[A-Za-z0-9_-]{40,400}$/
const IV_BYTES = 12

const enc = new TextEncoder()
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const base64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unbase64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function hmac(hash: string, label: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(hash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, enc.encode(label))
}
const aesKey = async (hash: string): Promise<CryptoKey> => crypto.subtle.importKey('raw', await hmac(hash, RDV_KEY_LABEL), 'AES-GCM', false, ['encrypt', 'decrypt'])

/** Where a phone's record lives, and what lets the Mac write it. `hash` is sha256hex(token). */
export async function rdvIds(hash: string): Promise<{ id: string; write: string }> {
  const write = hex(await hmac(hash, RDV_WRITE_LABEL))
  return { id: hex(await crypto.subtle.digest('SHA-256', enc.encode(write))), write }
}
export async function sealAddress(hash: string, mac: string, iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(IV_BYTES))): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(hash), enc.encode(mac)))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv)
  out.set(ct, iv.length)
  return base64url(out)
}
/** The address, or null when this is not a record for this hash (or it was changed). */
export async function openAddress(hash: string, sealed: string): Promise<string | null> {
  try {
    const b = unbase64url(sealed)
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, IV_BYTES) }, await aesKey(hash), b.slice(IV_BYTES)))
  } catch {
    return null
  }
}
