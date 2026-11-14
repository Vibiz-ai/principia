/**
 * docs/ACCOUNTS.md, the Mac side: sign in once, here, and every run in the cloud is signed in.
 *
 * - GitHub: this Mac's `gh` sign-in (or a pasted token) goes to the cloud as its workspace GitHub account.
 * - Shared keys marked "In the cloud" (settings.cloudKeys) are pushed as the cloud's shared keys whenever one changes,
 *   when this Mac connects, and on "Sync now". Turning a key off, or deleting it here, deletes it there. Keys this Mac
 *   never marked are left alone, so a second Mac's keys survive.
 *
 * Values travel once, over the paired device's HTTPS link, and are never returned, logged or kept outside the vault.
 * Pure: every effect is a dependency, so it is tested without Electron or a cloud.
 */
import { isGithubToken, type CloudAccounts, type CloudAccountsView } from '../../shared/cloud'
export type { CloudAccountsView }
import { HiveError } from '../../shared/errors'
import type { CloudClient } from './client'

export interface CloudAccountsDeps {
  /** CloudLink.call: runs `f` with the paired client (throws when this Mac is not connected) */
  call<T>(f: (c: CloudClient) => Promise<T>): Promise<T>
  linked(): boolean
  /** this Mac's gh sign-in (onboarding/github ghToken) */
  ghToken(): Promise<{ token: string; login: string | null } | null>
  /** Shared keys only (the vault's `secrets` table): names, and one value on demand */
  sharedKeyNames(): string[]
  revealShared(name: string): string
  /** settings.cloudKeys */
  cloudKeys(): string[]
  setCloudKeys(names: string[]): void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const EMPTY: Omit<CloudAccountsView, 'cloudKeys'> = { linked: false, github: null, inCloud: [] }

export class CloudAccountsSync {
  private running: Promise<CloudAccountsView> | null = null
  private again = false

  constructor(private d: CloudAccountsDeps) {}

  async view(): Promise<CloudAccountsView> {
    if (!this.d.linked()) return { ...EMPTY, cloudKeys: this.d.cloudKeys() }
    const a = await this.d.call((c) => c.call<CloudAccounts>('accounts'))
    return { linked: true, github: a.github, inCloud: a.secrets.map((s) => s.name), cloudKeys: this.d.cloudKeys() }
  }

  /** GitHub from this Mac's gh sign-in, or a pasted token. */
  async connectGithub(input: { token?: string | null }): Promise<CloudAccountsView> {
    this.requireLinked()
    let body: { token: string; login?: string | null }
    if (input.token) {
      if (!isGithubToken(input.token)) throw new HiveError('validation', 'That does not look like a GitHub token (gho_, ghp_ or github_pat_…).')
      body = { token: input.token.trim() }
    } else {
      const gh = await this.d.ghToken()
      if (!gh) throw new HiveError('conflict', 'GitHub CLI is not signed in on this Mac. Run `gh auth login` in Terminal, or paste a token.')
      body = gh
    }
    await this.d.call((c) => c.call('githubAccountPut', { body }))
    return this.view()
  }

  async removeGithub(): Promise<CloudAccountsView> {
    this.requireLinked()
    await this.d.call((c) => c.call('githubAccountDelete'))
    return this.view()
  }

  /** Mark or unmark one Shared key for the cloud, then sync. */
  async setKey(name: string, on: boolean): Promise<CloudAccountsView> {
    if (on && !this.d.sharedKeyNames().includes(name)) throw new HiveError('not_found', `${name} is not a Shared key. Only Shared keys go to the cloud.`)
    const cur = this.d.cloudKeys()
    const next = on ? [...new Set([...cur, name])].sort() : cur.filter((n) => n !== name)
    this.d.setCloudKeys(next)
    if (!this.d.linked()) return { ...EMPTY, cloudKeys: next }
    if (!on) await this.deleteRemote([name])
    return this.sync()
  }

  /**
   * Push every marked key that still exists; delete the marked ones the vault no longer has (and forget them).
   * Overlapping calls coalesce: a change during a sync runs one more pass.
   */
  sync(): Promise<CloudAccountsView> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        let v: CloudAccountsView
        do {
          this.again = false
          v = await this.syncOnce()
        } while (this.again)
        return v
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  /** After a Shared key changed here (set, import, move, remove): sync when it is one of the cloud's. Never throws. */
  keysChanged(): void {
    if (!this.d.linked() || !this.d.cloudKeys().length) return
    void this.sync().catch((e) => this.d.log?.warn('cloud: shared key sync failed', { error: e instanceof Error ? e.message : String(e) }))
  }

  private async syncOnce(): Promise<CloudAccountsView> {
    if (!this.d.linked()) return { ...EMPTY, cloudKeys: this.d.cloudKeys() }
    const have = new Set(this.d.sharedKeyNames())
    const marked = this.d.cloudKeys()
    const gone = marked.filter((n) => !have.has(n))
    if (gone.length) {
      this.d.setCloudKeys(marked.filter((n) => have.has(n)))
      await this.deleteRemote(gone)
    }
    for (const name of marked.filter((n) => have.has(n))) {
      await this.d.call((c) => c.call('sharedSecretPut', { params: { name }, body: { value: this.d.revealShared(name) } }))
    }
    return this.view()
  }

  private async deleteRemote(names: string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.d.call((c) => c.call('sharedSecretDelete', { params: { name } }))
      } catch (e) {
        // already gone there is fine; anything else surfaces
        if (!(e instanceof HiveError && e.code === 'not_found')) throw e
      }
    }
  }

  private requireLinked(): void {
    if (!this.d.linked()) throw new HiveError('conflict', 'Connect this Mac to a cloud first.')
  }
}
