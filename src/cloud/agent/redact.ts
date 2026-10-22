/**
 * The runtime's redactor (CLOUD.md §7.3): every secret value the control plane knows (ports.knownSecrets()) plus each
 * run's materials, and the token shapes of the providers we hold. Applied to every log line, step output, summary and
 * Forum text the runtime reports. Values shorter than 6 characters are ignored (they would mask ordinary words).
 */
const MIN_LEN = 6
/** Token shapes that are masked even when nobody told us the value (CLOUD.md §7.3). */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(?:pdt|pll|pss|whk|opk|prt)_[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
]

export class Redactor {
  private readonly values = new Map<string, string>()
  private sorted: [string, string][] | null = null

  /** `label`: the key name when known (`••••NAME`), else a generic mask. */
  add(value: string | null | undefined, label?: string): void {
    if (typeof value !== 'string') return
    for (const v of variants(value)) {
      if (v.length < MIN_LEN || this.values.has(v)) continue
      this.values.set(v, label ? `••••${label}` : '[REDACTED]')
      this.sorted = null
    }
  }
  addAll(values: Iterable<string>): void {
    for (const v of values) this.add(v)
  }
  has(value: string): boolean {
    return this.values.has(value)
  }
  redact(text: string): string {
    if (!text) return text
    // longest first, so a value that contains another is masked whole
    this.sorted ??= [...this.values.entries()].sort((a, b) => b[0].length - a[0].length)
    let out = text
    for (const [v, mask] of this.sorted) if (out.includes(v)) out = out.split(v).join(mask)
    for (const re of PATTERNS) out = out.replace(re, '[REDACTED]')
    return out
  }
}

/** A secret and the forms it takes in files and logs: whole, each line of a multi-line value, JSON-escaped. */
function variants(value: string): string[] {
  const v = value.trim()
  if (!v) return []
  const out = new Set([v])
  const json = JSON.stringify(v).slice(1, -1)
  if (json !== v) out.add(json)
  // an Authorization header value: the token alone shows up in logs too
  const auth = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(v)
  if (auth) out.add(auth[1]!)
  if (v.includes('\n')) for (const line of v.split(/\r?\n/)) if (line.trim().length >= 20) out.add(line.trim())
  // file credentials (auth.json, service accounts): the token fields inside
  if (v.startsWith('{')) {
    try {
      collectStrings(JSON.parse(v), out)
    } catch {
      /* not JSON */
    }
  }
  return [...out]
}
function collectStrings(o: unknown, out: Set<string>): void {
  if (typeof o === 'string') {
    if (o.length >= 20 && !/^https?:\/\//.test(o) && !/^\d{4}-\d\d-\d\dT/.test(o) && !/\s/.test(o.trim())) out.add(o)
    else if (o.includes('PRIVATE KEY')) out.add(o)
    return
  }
  if (Array.isArray(o)) for (const x of o) collectStrings(x, out)
  else if (o && typeof o === 'object') for (const x of Object.values(o)) collectStrings(x, out)
}
