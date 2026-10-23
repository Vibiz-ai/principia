import type { EnvImportEntry, SecretMeta } from '../shared/types'
import { HiveError } from '../shared/errors'
import type { DB } from './db'
import { SECRET_NAME_RE, maskSecret, parseEnvText } from './envParse'

/** safeStorage in production, a fake in tests. No plaintext fallback, ever (SPEC K5). */
export interface Cipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

interface SecretRow {
  name: string
  label: string
  cipher: Buffer
  masked: string
  created_at: string
  updated_at: string
  last_used_at: string | null
}

const toMeta = (r: Omit<SecretRow, 'cipher'>): SecretMeta => ({
  name: r.name,
  label: r.label,
  masked: r.masked,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at
})

const MIN_REDACT_LEN = 4

/**
 * Keys vault. Values are encrypted with the Keychain-backed safeStorage key and only decrypted in main memory
 * (spawn env, redaction table, explicit Reveal/Copy).
 */
export class Vault {
  /** value -> NAME, longest first, rebuilt on every change. */
  private redactTable: [string, string][] = []
  /** SLACK.md §3.3: values that are not vault secrets but must be redacted (connector tokens). NAME -> value. */
  private extraRedactions = new Map<string, string>()
  private onChange: () => void = () => {}

  constructor(
    private db: DB,
    private cipher: Cipher,
    private now: () => Date = () => new Date()
  ) {
    this.rebuild()
  }

  setChangeListener(fn: () => void): void {
    this.onChange = fn
  }

  /** Add-only (SLACK.md §3.3): redact `value` as ••••NAME without listing it in `secrets` or any env. */
  addRedactions(name: string, value: string): void {
    if (!value || value.length < MIN_REDACT_LEN) return
    this.extraRedactions.set(name, value)
    this.rebuild()
  }
  removeRedactions(name: string): void {
    if (this.extraRedactions.delete(name)) this.rebuild()
  }
  /** Re-reads every shared and company value into the redact table (call after company_secrets changed). */
  refreshRedactions(): void {
    this.rebuild()
  }

  /** Vault values for memory's secret fingerprints (main only, never persisted in plaintext). Does not mark lastUsedAt. */
  secretValues(): { name: string; value: string }[] {
    return this.redactTable.map(([value, name]) => ({ name, value }))
  }

  available(): boolean {
    try {
      return this.cipher.available()
    } catch {
      return false
    }
  }

  private requireAvailable(): void {
    if (!this.available()) {
      throw new HiveError('vault_unavailable', "macOS Keychain encryption is unavailable, so Hive won't store keys.")
    }
  }

  list(): SecretMeta[] {
    const rows = this.db
      .prepare('SELECT name, label, masked, created_at, updated_at, last_used_at FROM secrets ORDER BY name')
      .all() as Omit<SecretRow, 'cipher'>[]
    return rows.map(toMeta)
  }

  /**
   * Names a selection covers (['*'] = all), without decrypting anything. COMPANY.md §4: with `companyId`, that
   * company's keys join the shared ones ('*' never reaches another company's keys).
   */
  names(selection: string[], companyId?: string | null): string[] {
    const all = selection.includes('*')
    const own = companyId ? this.companyRows(companyId).map((r) => r.name) : []
    return [...new Set([...this.list().map((m) => m.name), ...own])]
      .filter((n) => all || selection.includes(n))
      .sort()
  }

  /** company_secrets rows of one company, or of every company (redaction). [] when the table does not exist yet. */
  private companyRows(companyId?: string): { company_id: string; name: string; cipher: Buffer }[] {
    try {
      return (
        companyId
          ? this.db.prepare('SELECT company_id, name, cipher FROM company_secrets WHERE company_id = ?').all(companyId)
          : this.db.prepare('SELECT company_id, name, cipher FROM company_secrets').all()
      ) as { company_id: string; name: string; cipher: Buffer }[]
    } catch {
      return []
    }
  }

  get(name: string): SecretMeta | null {
    const r = this.db
      .prepare('SELECT name, label, masked, created_at, updated_at, last_used_at FROM secrets WHERE name = ?')
      .get(name) as Omit<SecretRow, 'cipher'> | undefined
    return r ? toMeta(r) : null
  }

  set(name: string, value: string, label?: string): SecretMeta {
    this.requireAvailable()
    this.upsert(name, value, label)
    this.rebuild()
    this.onChange()
    return this.get(name)!
  }

  private upsert(name: string, value: string, label?: string): void {
    if (!SECRET_NAME_RE.test(name)) {
      throw new HiveError('validation', 'Invalid key name', [
        { path: 'name', message: 'Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _), not starting with a digit' }
      ])
    }
    if (!value) throw new HiveError('validation', 'Empty value', [{ path: 'value', message: 'Value is empty' }])
    const ts = this.now().toISOString()
    const cipher = this.cipher.encrypt(value)
    const existing = this.get(name)
    if (existing) {
      this.db
        .prepare('UPDATE secrets SET cipher = ?, masked = ?, label = ?, updated_at = ? WHERE name = ?')
        .run(cipher, maskSecret(value), label ?? existing.label, ts, name)
    } else {
      this.db
        .prepare(
          'INSERT INTO secrets(name, label, cipher, masked, created_at, updated_at, last_used_at) VALUES (?,?,?,?,?,?,NULL)'
        )
        .run(name, label ?? '', cipher, maskSecret(value), ts, ts)
    }
  }

  remove(name: string): void {
    const r = this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name)
    if (!r.changes) throw new HiveError('not_found', `No key named ${name}`)
    this.rebuild()
    this.onChange()
  }

  /** Plaintext for one explicit user action (Reveal / Copy). */
  reveal(name: string): string {
    this.requireAvailable()
    const r = this.db.prepare('SELECT cipher FROM secrets WHERE name = ?').get(name) as { cipher: Buffer } | undefined
    if (!r) throw new HiveError('not_found', `No key named ${name}`)
    return this.cipher.decrypt(r.cipher)
  }

  /**
   * Decrypted { NAME: value } for spawn env. ['*'] = all. Unknown names skipped. Marks lastUsedAt (shared keys).
   * COMPANY.md §4: `companyId` overlays that company's keys: a company value overrides a shared one of the same name,
   * and '*' means every shared key plus this company's, never another company's. Absent = shared keys only.
   */
  resolve(names: string[], companyId?: string | null): Record<string, string> {
    if (!names.length || !this.available()) return {}
    const all = names.includes('*')
    const rows = this.db.prepare('SELECT name, cipher FROM secrets').all() as Pick<SecretRow, 'name' | 'cipher'>[]
    const out: Record<string, string> = {}
    const used: string[] = []
    for (const r of rows) {
      if (!all && !names.includes(r.name)) continue
      try {
        out[r.name] = this.cipher.decrypt(r.cipher)
        used.push(r.name)
      } catch {
        /* undecryptable (Keychain item reset) -> skip */
      }
    }
    for (const r of companyId ? this.companyRows(companyId) : []) {
      if (!all && !names.includes(r.name)) continue
      try {
        out[r.name] = this.cipher.decrypt(r.cipher)
      } catch {
        /* undecryptable: the shared value (if any) stays */
      }
    }
    if (used.length) {
      const ts = this.now().toISOString()
      const stmt = this.db.prepare('UPDATE secrets SET last_used_at = ? WHERE name = ?')
      this.db.transaction(() => used.forEach((n) => stmt.run(ts, n)))()
    }
    return out
  }

  /**
   * Only this company's own values for `names` (no shared fallback). PASSPORT.md §12: the AI suggestion call bills the
   * company's own provider key, never a shared one.
   */
  resolveCompanyOnly(names: string[], companyId: string): Record<string, string> {
    if (!names.length || !this.available()) return {}
    const out: Record<string, string> = {}
    for (const r of this.companyRows(companyId)) {
      if (!names.includes(r.name)) continue
      try {
        out[r.name] = this.cipher.decrypt(r.cipher)
      } catch {
        /* undecryptable: skipped */
      }
    }
    return out
  }

  /** Replace every vault value (len >= 4) with ••••NAME. */
  redact(text: string): string {
    if (!text || !this.redactTable.length) return text
    let out = text
    for (const [value, name] of this.redactTable) {
      if (out.includes(value)) out = out.split(value).join(`••••${name}`)
    }
    return out
  }

  private rebuild(): void {
    if (!this.available()) {
      this.redactTable = [...this.extraRedactions].map(([name, value]) => [value, name] as [string, string]).sort((a, b) => b[0].length - a[0].length)
      return
    }
    // COMPANY.md §4: redaction stays global, so a key of company A is masked in company B's output too
    const rows = [...(this.db.prepare('SELECT name, cipher FROM secrets').all() as Pick<SecretRow, 'name' | 'cipher'>[]), ...this.companyRows()]
    const table: [string, string][] = []
    for (const r of rows) {
      try {
        const v = this.cipher.decrypt(r.cipher)
        if (v.length >= MIN_REDACT_LEN) table.push([v, r.name])
        // also redact the trimmed/single-line form of multi-line values
        const t = v.trim()
        if (t !== v && t.length >= MIN_REDACT_LEN) table.push([t, r.name])
      } catch {
        /* skip */
      }
    }
    for (const [name, value] of this.extraRedactions) table.push([value, name])
    table.sort((a, b) => b[0].length - a[0].length)
    this.redactTable = table
  }

  parseEnv(text: string): EnvImportEntry[] {
    return parseEnvText(text).map((e) => ({
      name: e.name,
      masked: e.value ? maskSecret(e.value) : '',
      valid: e.valid,
      exists: !!this.get(e.name),
      error: e.error
    }))
  }

  importEnv(text: string, names: string[]): SecretMeta[] {
    this.requireAvailable()
    const parsed = parseEnvText(text).filter((e) => e.valid && names.includes(e.name))
    this.db.transaction(() => parsed.forEach((e) => this.upsert(e.name, e.value)))()
    this.rebuild()
    this.onChange()
    return parsed.map((e) => this.get(e.name)!).filter(Boolean)
  }
}
