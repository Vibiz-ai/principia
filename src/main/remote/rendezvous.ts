/**
 * REMOTE.md RA8: the Mac leaves its current address on the phone site, sealed for each paired phone
 * (src/shared/rendezvous.ts). Only when the tunnel gets an address: a phone needs a record only after the address
 * changed, and that is when every phone's current hash goes up. A failed try is tried again later; a site with no
 * lookup (a self-hosted static site) is left alone until the next address. No Electron imports.
 */
import { RDV_ROUTE, rdvIds, sealAddress } from '../../shared/rendezvous'

const TIMEOUT_MS = 15_000
/** after a failed try; then every last one */
export const RDV_RETRY_MS = [30_000, 120_000, 600_000, 3_600_000]

export interface RendezvousDeps {
  /** the phone site's origin, or null: nothing is published */
  site: () => string | null
  /** sha256hex(token) of each paired phone, now */
  hashes: () => string[]
  fetch?: typeof fetch
  retryMs?: number[]
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export class Rendezvous {
  private url: string | null = null
  private run = 0
  private tries = 0
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly d: RendezvousDeps) {}

  /** The tunnel's address now (null: none). A new address goes up for every paired phone. */
  address(url: string | null): void {
    if (url === this.url) return
    this.stop()
    this.url = url
    if (url) void this.publish(url, this.run)
  }

  stop(): void {
    this.url = null
    this.run++
    this.tries = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async publish(url: string, run: number): Promise<void> {
    const site = this.d.site()
    if (!site) return
    const f = this.d.fetch ?? fetch
    let failed = 0
    for (const hash of this.d.hashes()) {
      if (run !== this.run) return
      try {
        const { id, write } = await rdvIds(hash)
        const sealed = await sealAddress(hash, url)
        if (run !== this.run) return
        const res = await f(`${site}${RDV_ROUTE}?id=${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ write, sealed }), signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (res.status === 404 || res.status === 405) {
          this.d.log?.info('[remote] this phone site has no address lookup')
          return
        }
        if (!res.ok) failed++
      } catch {
        failed++
      }
    }
    if (run !== this.run) return
    if (!failed) {
      this.tries = 0
      return
    }
    const steps = this.d.retryMs ?? RDV_RETRY_MS
    const wait = steps[Math.min(this.tries++, steps.length - 1)]
    this.d.log?.warn('[remote] could not leave the address for the phone', { failed, retryMs: wait })
    this.timer = setTimeout(() => void this.publish(url, run), wait)
    this.timer.unref?.()
  }
}
