/**
 * SecretPort on `connector_secrets` + the vault Cipher (SLACK.md §3.3, D4). Never in `secrets` (those are injected into
 * every agent env), never in any child env or log. vault_unavailable when safeStorage is unavailable: no plaintext
 * fallback. Values are also fed to the vault's redaction table so they never appear in step logs or tool results.
 */
import type Database from 'better-sqlite3'
import { HiveError } from '../../../shared/errors'
import { maskSecret } from '../../envParse'
import type { Cipher } from '../../vault'
import type { SecretName, SecretPort } from './core/ports'

const CONNECTOR = 'slack'
const REDACT_NAME: Record<SecretName, string> = { bot_token: 'SLACK_BOT_TOKEN', app_token: 'SLACK_APP_TOKEN' }

export interface RedactionSink {
  addRedactions(name: string, value: string): void
  removeRedactions(name: string): void
}

export class ConnectorSecrets implements SecretPort {
  constructor(
    private db: Database.Database,
    private cipher: Cipher,
    private redactions: RedactionSink | null = null,
    private now: () => Date = () => new Date()
  ) {}

  private available(): boolean {
    try {
      return this.cipher.available()
    } catch {
      return false
    }
  }

  /** Boot: put stored tokens into the redaction table. */
  loadRedactions(): void {
    if (!this.redactions || !this.available()) return
    for (const n of ['bot_token', 'app_token'] as SecretName[]) {
      const v = this.read(n)
      if (v) this.redactions.addRedactions(REDACT_NAME[n], v)
    }
  }

  private read(name: SecretName): string | null {
    const r = this.db.prepare('SELECT cipher FROM connector_secrets WHERE connector = ? AND name = ?').get(CONNECTOR, name) as { cipher: Buffer } | undefined
    if (!r || !this.available()) return null
    try {
      return this.cipher.decrypt(r.cipher)
    } catch {
      return null
    }
  }

  async get(name: SecretName): Promise<string | null> {
    return this.read(name)
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!this.available()) throw new HiveError('vault_unavailable', "macOS Keychain encryption is unavailable, so Hive won't store the Slack tokens.")
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO connector_secrets(connector, name, cipher, masked, created_at, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(connector, name) DO UPDATE SET cipher = excluded.cipher, masked = excluded.masked, updated_at = excluded.updated_at`
      )
      .run(CONNECTOR, name, this.cipher.encrypt(value), maskSecret(value), ts, ts)
    this.redactions?.addRedactions(REDACT_NAME[name], value)
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM connector_secrets WHERE connector = ?').run(CONNECTOR)
    this.redactions?.removeRedactions(REDACT_NAME.bot_token)
    this.redactions?.removeRedactions(REDACT_NAME.app_token)
  }

  async masked(): Promise<{ bot: string | null; app: string | null }> {
    const rows = this.db.prepare('SELECT name, masked FROM connector_secrets WHERE connector = ?').all(CONNECTOR) as { name: string; masked: string }[]
    const m = new Map(rows.map((r) => [r.name, r.masked]))
    return { bot: m.get('bot_token') ?? null, app: m.get('app_token') ?? null }
  }
}
