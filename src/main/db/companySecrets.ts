/**
 * Per-company keys (COMPANY.md §4): `company_secrets`, next to the Shared namespace (`secrets`, owned by vault.ts).
 * A company value overrides a shared one of the same name at spawn time (vault.ts `resolve(names, companyId)`).
 * Values are only ever stored as safeStorage ciphertext and decrypted in main; no plaintext fallback.
 */
import type { EnvImportEntry, Id, SecretMeta } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { SECRET_NAME_RE, maskSecret, parseEnvText } from '../envParse'
import type { Cipher, Vault } from '../vault'
import type { DB } from './index'

interface Row {
  company_id: string
  name: string
  label: string | null
  masked: string
  created_at: string
  updated_at: string
}
const COLS = 'company_id, name, label, masked, created_at, updated_at'
const toMeta = (r: Row): SecretMeta => ({
  name: r.name,
  companyId: r.company_id,
  label: r.label ?? '',
  masked: r.masked,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // company_secrets has no last_used_at (older builds never read this table)
  lastUsedAt: null
})

export class CompanySecrets {
  private onChange: () => void = () => {}
  constructor(
    private db: DB,
    private cipher: Cipher,
    private now: () => Date = () => new Date()
  ) {}

  setChangeListener(fn: () => void): void {
    this.onChange = fn
  }

  available(): boolean {
    try {
      return this.cipher.available()
    } catch {
      return false
    }
  }
  private requireAvailable(): void {
    if (!this.available()) throw new HiveError('vault_unavailable', "macOS Keychain encryption is unavailable, so Hive won't store keys.")
  }
  private requireCompany(companyId: Id): void {
    if (!this.db.prepare('SELECT 1 FROM company_passports WHERE id = ?').get(companyId)) throw new HiveError('not_found', 'Company not found')
  }

  /** One company's keys, or every company's (companyId omitted), by name. */
  list(companyId?: Id): SecretMeta[] {
    const rows = companyId
      ? this.db.prepare(`SELECT ${COLS} FROM company_secrets WHERE company_id = ? ORDER BY name`).all(companyId)
      : this.db.prepare(`SELECT ${COLS} FROM company_secrets ORDER BY name, company_id`).all()
    return (rows as Row[]).map(toMeta)
  }
  get(companyId: Id, name: string): SecretMeta | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM company_secrets WHERE company_id = ? AND name = ?`).get(companyId, name) as Row | undefined
    return r ? toMeta(r) : null
  }

  set(companyId: Id, name: string, value: string, label?: string): SecretMeta {
    this.requireAvailable()
    this.requireCompany(companyId)
    this.upsert(companyId, name, value, label)
    this.onChange()
    return this.get(companyId, name)!
  }
  private upsert(companyId: Id, name: string, value: string, label?: string): void {
    if (!SECRET_NAME_RE.test(name)) {
      throw new HiveError('validation', 'Invalid key name', [
        { path: 'name', message: 'Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _), not starting with a digit' }
      ])
    }
    if (!value) throw new HiveError('validation', 'Empty value', [{ path: 'value', message: 'Value is empty' }])
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO company_secrets(company_id, name, label, cipher, masked, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(company_id, name) DO UPDATE SET cipher = excluded.cipher, masked = excluded.masked,
           label = COALESCE(?, company_secrets.label), updated_at = excluded.updated_at`
      )
      .run(companyId, name, label ?? '', this.cipher.encrypt(value), maskSecret(value), ts, ts, label ?? null)
  }

  remove(companyId: Id, name: string): void {
    const r = this.db.prepare('DELETE FROM company_secrets WHERE company_id = ? AND name = ?').run(companyId, name)
    if (!r.changes) throw new HiveError('not_found', `No key named ${name} in this company`)
    this.onChange()
  }

  /** Plaintext for one explicit user action (Reveal / Copy / Move). */
  reveal(companyId: Id, name: string): string {
    this.requireAvailable()
    const r = this.db.prepare('SELECT cipher FROM company_secrets WHERE company_id = ? AND name = ?').get(companyId, name) as { cipher: Buffer } | undefined
    if (!r) throw new HiveError('not_found', `No key named ${name} in this company`)
    return this.cipher.decrypt(r.cipher)
  }

  /** Every decryptable company value (redaction stays global over all keys, §4). Undecryptable rows are skipped. */
  values(companyId?: Id): { companyId: Id; name: string; value: string }[] {
    if (!this.available()) return []
    const rows = (
      companyId
        ? this.db.prepare('SELECT company_id, name, cipher FROM company_secrets WHERE company_id = ?').all(companyId)
        : this.db.prepare('SELECT company_id, name, cipher FROM company_secrets').all()
    ) as { company_id: string; name: string; cipher: Buffer }[]
    const out: { companyId: Id; name: string; value: string }[] = []
    for (const r of rows) {
      try {
        out.push({ companyId: r.company_id, name: r.name, value: this.cipher.decrypt(r.cipher) })
      } catch {
        /* Keychain item reset */
      }
    }
    return out
  }

  parseEnv(companyId: Id, text: string): EnvImportEntry[] {
    return parseEnvText(text).map((e) => ({
      name: e.name,
      masked: e.value ? maskSecret(e.value) : '',
      valid: e.valid,
      exists: !!this.get(companyId, e.name),
      error: e.error
    }))
  }

  importEnv(companyId: Id, text: string, names: string[]): SecretMeta[] {
    this.requireAvailable()
    this.requireCompany(companyId)
    const parsed = parseEnvText(text).filter((e) => e.valid && names.includes(e.name))
    this.db.transaction(() => parsed.forEach((e) => this.upsert(companyId, e.name, e.value)))()
    this.onChange()
    return parsed.map((e) => this.get(companyId, e.name)!).filter(Boolean)
  }
}

/** The Vault surface the namespaces use (Shared = vault.ts `secrets`). */
type SharedVault = Pick<Vault, 'list' | 'get' | 'set' | 'remove' | 'reveal' | 'parseEnv' | 'importEnv' | 'refreshRedactions'>

/**
 * Keys page namespaces (COMPANY.md §4): `null` = Shared, an id = that company. Lists answer every key (absent), the
 * Shared keys (null) or a company's keys plus the Shared ones it inherits (an id). Plaintext never leaves main: moving
 * a key between namespaces decrypts and re-encrypts here.
 */
export class KeyNamespaces {
  /**
   * onChange: runs after every company-key change (and once here), so consumers of the redaction table refresh too.
   * Memory's secret fingerprints are built from vault.secretValues(); a company key added later would otherwise never
   * be screened out of memory writes.
   */
  constructor(
    readonly shared: SharedVault,
    readonly company: CompanySecrets,
    private onChange: () => void = () => {}
  ) {
    company.setChangeListener(() => {
      this.syncRedactions()
      this.onChange()
    })
    this.syncRedactions()
    this.onChange()
  }

  /**
   * Redaction stays global over every key (§4): a key of company A is masked in company B's output too. vault.ts reads
   * company_secrets itself (masked as ••••NAME, trimmed form included); this re-reads it after a company-key change.
   */
  syncRedactions(): void {
    this.shared.refreshRedactions()
  }

  list(space?: Id | null): SecretMeta[] {
    const shared = this.shared.list().map((m) => ({ ...m, companyId: null }))
    if (space === undefined) return [...shared, ...this.company.list()]
    if (space === null) return shared
    return [...this.company.list(space), ...shared]
  }
  set(space: Id | null | undefined, name: string, value: string, label?: string): SecretMeta {
    return space ? this.company.set(space, name, value, label) : { ...this.shared.set(name, value, label), companyId: null }
  }
  remove(space: Id | null | undefined, name: string): void {
    if (space) this.company.remove(space, name)
    else this.shared.remove(name)
  }
  reveal(space: Id | null | undefined, name: string): string {
    return space ? this.company.reveal(space, name) : this.shared.reveal(name)
  }
  parseEnv(space: Id | null | undefined, text: string): EnvImportEntry[] {
    return space ? this.company.parseEnv(space, text) : this.shared.parseEnv(text)
  }
  importEnv(space: Id | null | undefined, text: string, names: string[]): SecretMeta[] {
    return space ? this.company.importEnv(space, text, names) : this.shared.importEnv(text, names).map((m) => ({ ...m, companyId: null }))
  }
  /** "Move to company…" / "Make shared". conflict when the destination already has the name; the label moves along. */
  move(name: string, from: Id | null, to: Id | null): SecretMeta {
    if (from === to) throw new HiveError('bad_request', 'The key is already there')
    const meta = from ? this.company.get(from, name) : this.shared.get(name)
    if (!meta) throw new HiveError('not_found', `No key named ${name}`)
    const taken = to ? this.company.get(to, name) : this.shared.get(name)
    if (taken) throw new HiveError('conflict', to ? `That company already has a key named ${name}` : `A shared key named ${name} already exists`)
    const moved = this.set(to, name, this.reveal(from, name), meta.label)
    this.remove(from, name)
    return moved
  }
}
