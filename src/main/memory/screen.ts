/**
 * Text normalization (MEMORY.md §4.1), secret fingerprints (§9.1) and the imperative screen (§9.2, PO7).
 * Pure Node (crypto, fs). No Electron imports: the MCP server bundles this too.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

/** NFKC, lowercase, trim, collapse whitespace, strip surrounding quotes/backticks. Keeps . / _ - : */
export function normalizeName(s: string): string {
  let t = s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  t = t.replace(/^["'`‘’“”]+|["'`‘’“”]+$/g, '').trim()
  return t
}

/** normalizeName + collapse punctuation runs + drop a trailing period. */
export function normalizeText(s: string): string {
  return normalizeName(s)
    .replace(/([!?,;.])\1+/g, '$1')
    .replace(/\.$/, '')
    .trim()
}

export function textHash(s: string): string {
  return crypto.createHash('sha256').update(normalizeText(s)).digest('hex')
}

// ---------- imperative screen (PO7: never quarantine plain "always/never" conventions) ----------
const IMPERATIVE_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all|previous|prior)\s+instructions/i, 'ignore instructions'],
  [/system\s+prompt/i, 'system prompt'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, 'pipe to shell'],
  [/base64\s+(-d|--decode)\b/i, 'base64 -d'],
  [/rm\s+-rf\s+(\/(\s|$|\*)|~)/i, 'rm -rf / or ~']
]

/** Returns the matched pattern label (quarantine reason) or null. */
export function imperativeHit(text: string): string | null {
  for (const [re, label] of IMPERATIVE_PATTERNS) if (re.test(text)) return label
  return null
}

// ---------- secret fingerprints (§9.1) ----------
export interface FingerprintFile {
  salt: string
  entries: { len: number; h: string; name: string }[]
}
const FP_MIN_LEN = 8

const sha = (salt: string, v: string) => crypto.createHash('sha256').update(salt + v).digest('hex')

/** Main: builds the fingerprint file content from vault values. No plaintext leaves this function. */
export function buildFingerprints(secrets: { name: string; value: string }[], salt = crypto.randomBytes(16).toString('hex')): FingerprintFile {
  const seen = new Set<string>()
  const entries: FingerprintFile['entries'] = []
  for (const { name, value } of secrets) {
    for (const v of new Set([value, value.trim()])) {
      if (v.length < FP_MIN_LEN) continue
      const h = sha(salt, v)
      if (seen.has(h)) continue
      seen.add(h)
      entries.push({ len: v.length, h, name })
    }
  }
  return { salt, entries }
}

export function writeFingerprintFile(file: string, fp: FingerprintFile): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(fp), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readFingerprintFile(file: string | undefined): FingerprintFile | null {
  if (!file) return null
  try {
    const fp = JSON.parse(fs.readFileSync(file, 'utf8')) as FingerprintFile
    return fp && typeof fp.salt === 'string' && Array.isArray(fp.entries) ? fp : null
  } catch {
    return null
  }
}

/** Slides a window of each fingerprinted length over `text`. Returns the secret name on a hit. */
export function secretHit(fp: FingerprintFile | null, text: string): string | null {
  if (!fp || !fp.entries.length || !text) return null
  const byLen = new Map<number, Map<string, string>>()
  for (const e of fp.entries) {
    if (!byLen.has(e.len)) byLen.set(e.len, new Map())
    byLen.get(e.len)!.set(e.h, e.name)
  }
  for (const [len, hashes] of byLen) {
    if (len > text.length) continue
    for (let i = 0; i + len <= text.length; i++) {
      const name = hashes.get(sha(fp.salt, text.slice(i, i + len)))
      if (name) return name
    }
  }
  return null
}

// ---------- credential shapes (§9.1 addendum): catches well-known secrets that are not in the vault ----------
const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bsk-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/, 'sk- API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, 'private key']
]
/** A 40-char base64ish run with mixed case, a digit and / or + (an AWS secret key shape). Only redacted alongside a hit. */
const AWS_SECRET_SHAPE = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

/** Returns a label when `text` contains a credential-shaped string, else null. */
export function credentialHit(text: string): string | null {
  for (const [re, label] of CREDENTIAL_PATTERNS) if (re.test(text)) return label
  return null
}

/** Replaces credential-shaped substrings with ••••credential (used when quarantining an already-stored row). */
export function redactCredentials(text: string): string {
  let out = text
  for (const [re] of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), '••••credential')
  out = out.replace(/••••credential[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g, '••••credential')
  out = out.replace(AWS_SECRET_SHAPE, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) && /[/+]/.test(m) ? '••••credential' : m))
  return out
}

// ---------- one screen for every write source (PASSPORT.md §7.3) ----------
export interface ScreenHit {
  kind: 'secret' | 'credential' | 'imperative'
  label: string
}

/**
 * Secrets (vault fingerprints and credential shapes) refuse a write from any source. The imperative screen applies to
 * agent text only (`agent`), and holds that line for review instead of refusing the call.
 */
export function screenText(fp: FingerprintFile | null, text: string, opts: { agent?: boolean } = {}): ScreenHit | null {
  const secret = secretHit(fp, text)
  if (secret) return { kind: 'secret', label: secret }
  const cred = credentialHit(text)
  if (cred) return { kind: 'credential', label: cred }
  if (opts.agent) {
    const imp = imperativeHit(text)
    if (imp) return { kind: 'imperative', label: imp }
  }
  return null
}
