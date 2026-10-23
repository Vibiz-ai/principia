/**
 * Secrets vault (CLOUD.md §7.3). Envelope encryption: the KEK (PRINCIPIA_MASTER_KEY, 32-byte hex) wraps one random DEK
 * per workspace; every secret is AES-256-GCM under the DEK with AAD `${workspaceId}:${kind}:${id}`, so a row moved to
 * another workspace, kind or id fails to decrypt. Blobs are base64(iv | tag | ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type VaultKind =
  | 'dek'
  | 'provider'
  | 'company-secret'
  | 'repo-pat'
  | 'github-app-key'
  | 'connection-credentials'
  | 'connection-oauth'
  | 'oauth-verifier'
  | 'passport-grant'
  | 'webhook-secret'

/** 64 hex characters, or 32 bytes in base64 (what Render's `generateValue` makes, so a one-click deploy keeps the key off the disk). */
export function parseMasterKey(hex: string | undefined): Buffer {
  const v = hex?.trim() ?? ''
  if (/^[a-fA-F0-9]{64}$/.test(v)) return Buffer.from(v, 'hex')
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (b.length === 32) return b
  }
  throw new Error('PRINCIPIA_MASTER_KEY must be 64 hex characters (32 bytes) or 32 bytes in base64. Run `principia-cloud init` or set it.')
}

function seal(key: Buffer, aad: string, plain: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}
function open(key: Buffer, aad: string, blob: string): Buffer {
  const buf = Buffer.from(blob, 'base64')
  if (buf.length < 28) throw new Error('vault: ciphertext too short')
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()])
}

/**
 * Values worth redacting: the value itself; for JSON files (auth.json, service accounts) every token-shaped leaf and
 * every leaf under a secret-sounding key (never URLs, dates or prose); PEM bodies line by line; bare bearer tokens.
 */
const TOKEN_SHAPED = /^[A-Za-z0-9._~+/=-]{16,}$/
const SECRET_KEY = /(^|_)(token|secret|password|private_key|key|assertion|credential)s?$/i
export function secretParts(value: string): string[] {
  const out = [value]
  const t = value.trim()
  const leaf = (k: string, v: string) => {
    if (v.includes('://')) return
    if (/^(?:Bearer|Basic|Token)\s+\S+$/i.test(v.trim())) { out.push(v.trim()); return }
    if (v.includes('-----BEGIN')) { for (const line of v.split(/\r?\n/)) if (TOKEN_SHAPED.test(line.trim())) out.push(line.trim()); return }
    if ((TOKEN_SHAPED.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) || (SECRET_KEY.test(k) && v.length >= 8 && !/\s/.test(v))) out.push(v)
  }
  if (t.startsWith('{')) {
    try {
      const walk = (k: string, v: unknown): void => {
        if (typeof v === 'string') leaf(k, v)
        else if (Array.isArray(v)) v.forEach(x => walk(k, x))
        else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(kk, vv)
      }
      walk('', JSON.parse(t))
    } catch { /* not JSON */ }
  }
  // an Authorization header value: the bare token is the secret too
  for (const v of [...out]) { const m = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(v.trim()); if (m) out.push(m[1]!) }
  return out.filter(s => s.length >= 8)
}

export interface Vault {
  readonly workspaceId: string
  /** `secrets` names exactly what to redact (else secretParts(plain)) */
  encrypt(kind: VaultKind, id: string, plain: string, secrets?: string[]): string
  decrypt(kind: VaultKind, id: string, blob: string): string
  /** wrap the DEK under a new KEK (master key rotation); returns the new wrapped DEK to store */
  rewrap(newKek: Buffer): string
  /** every secret value encrypted or decrypted by this process (for redaction) */
  knownSecrets(): string[]
  remember(value: string): void
}

export const createWrappedDek = (kek: Buffer, workspaceId: string): string => seal(kek, `${workspaceId}:dek:${workspaceId}`, randomBytes(32))

export function openVault(kek: Buffer, workspaceId: string, wrappedDek: string): Vault {
  let dek: Buffer
  try { dek = open(kek, `${workspaceId}:dek:${workspaceId}`, wrappedDek) } catch { throw new Error('PRINCIPIA_MASTER_KEY does not open this workspace (wrong key, or the data volume belongs to another install)') }
  const known = new Set<string>()
  const remember = (value: string) => { for (const p of secretParts(value)) known.add(p) }
  return {
    workspaceId,
    encrypt: (kind, id, plain, secrets) => { if (secrets) for (const x of secrets) remember(x); else remember(plain); return seal(dek, `${workspaceId}:${kind}:${id}`, Buffer.from(plain, 'utf8')) },
    decrypt: (kind, id, blob) => { const v = open(dek, `${workspaceId}:${kind}:${id}`, blob).toString('utf8'); remember(v); return v },
    rewrap: newKek => seal(newKek, `${workspaceId}:dek:${workspaceId}`, dek),
    knownSecrets: () => [...known],
    remember
  }
}
