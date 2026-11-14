/**
 * docs/FLEET.md §9: sign in once, for good. Every cloud sign-in this Mac makes (Claude's setup token, Codex's
 * auth.json, a pasted key) is also kept here, encrypted with safeStorage, in `<userData>/cloud-logins.json` (0600).
 * When a machine is made again (rebuilt, or turned off and on), it is signed in from here: no browser, nothing to do.
 * The browser opens only when there is nothing saved, or what is saved no longer works.
 *
 * The values never leave main: not the renderer, not an event, not a log line, not the fleet.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CloudAdapter, ProviderCredentialKind } from '../../shared/cloud'
import type { Cipher } from '../vault'

export const LOGIN_VAULT_FILE = 'cloud-logins.json'

interface Saved {
  kind: ProviderCredentialKind
  /** base64 safeStorage ciphertext */
  value: string
  savedAt: string
}

export class CloudLoginVault {
  constructor(private d: { userData: string; cipher: Cipher; now?: () => Date }) {}

  private get file(): string {
    return path.join(this.d.userData, LOGIN_VAULT_FILE)
  }
  private read(): Partial<Record<CloudAdapter, Saved>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Record<CloudAdapter, Saved>>
    } catch {
      return {}
    }
  }
  private write(all: Partial<Record<CloudAdapter, Saved>>): void {
    fs.mkdirSync(this.d.userData, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  save(adapter: CloudAdapter, kind: ProviderCredentialKind, value: string): void {
    if (!this.d.cipher.available()) return
    const all = this.read()
    all[adapter] = { kind, value: this.d.cipher.encrypt(value).toString('base64'), savedAt: (this.d.now?.() ?? new Date()).toISOString() }
    this.write(all)
  }

  get(adapter: CloudAdapter): { kind: ProviderCredentialKind; value: string } | null {
    const s = this.read()[adapter]
    if (!s) return null
    try {
      return { kind: s.kind, value: this.d.cipher.decrypt(Buffer.from(s.value, 'base64')) }
    } catch {
      return null
    }
  }

  has(adapter: CloudAdapter): boolean {
    return !!this.read()[adapter]
  }

  forget(adapter: CloudAdapter): void {
    const all = this.read()
    if (!all[adapter]) return
    delete all[adapter]
    this.write(all)
  }
}
