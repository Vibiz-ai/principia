/**
 * REMOTE.md: the Phone switch. On = the 127.0.0.1 server; the tunnel is a second, separate switch. Off (or quit) =
 * tunnel and server stopped, every socket closed; paired phones stay paired (kept in hive.db) and get back in when
 * Phone is on again. "Sign out all phones" and Revoke sign phones out. RA8: with "Turn Phone on when Principia starts"
 * (default: on once a phone is paired) both come back by themselves at launch. No Electron imports: wire.ts gives it
 * the host, the device store and the event sink.
 */
import { pairLinkFor, phoneAutoStartOn, type RemotePairLink, type RemoteState } from '../../shared/remote'
import { RemoteAuth } from './auth'
import type { DeviceStore } from './devices'
import { PhoneApi, type PhoneHost } from './api'
import { RemoteServer, type RemoteApi } from './server'
import { Tunnel, type TunnelDeps } from './tunnel'

export interface RemoteServiceDeps {
  host: PhoneHost
  bundleDir: string | null
  emit: (s: RemoteState) => void
  tunnel: Pick<TunnelDeps, 'bin' | 'spawn' | 'timeoutMs'>
  /** RA6: the hosted phone app's origin (Settings › App › Phone › Phone app address), or null: the Mac's own page only */
  site?: () => string | null
  /** RA2: where paired phones are kept (hive.db); default memory */
  devices?: DeviceStore
  /** RA8: the "Turn Phone on when Principia starts" setting (null/undefined: on once a phone is paired) */
  autoStart?: () => boolean | null | undefined
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export class RemoteService {
  readonly auth: RemoteAuth
  private api: PhoneApi | null = null
  private server: RemoteServer | null = null
  private readonly tunnel: Tunnel
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: RemoteServiceDeps) {
    this.auth = new RemoteAuth({ store: d.devices })
    this.tunnel = new Tunnel({ ...d.tunnel, onChange: () => this.changed() })
  }

  state(): RemoteState {
    const online = this.server?.onlineDevices() ?? new Set<string>()
    return {
      enabled: !!this.server?.listening,
      localUrl: this.server?.localUrl ?? null,
      tunnel: { ...this.tunnel.state },
      devices: this.auth.devices((id) => online.has(id)),
      autoStart: this.autoStartWanted()
    }
  }
  /** RA8: the setting, or its default (on once a phone is paired) */
  autoStartWanted(): boolean {
    let v: boolean | null | undefined
    try {
      v = this.d.autoStart?.()
    } catch {
      v = undefined
    }
    return phoneAutoStartOn(v, this.auth.count)
  }
  /** RA8: at launch, Phone and its tunnel come back by themselves when wanted. */
  async autoStartIfWanted(): Promise<boolean> {
    if (!this.autoStartWanted()) return false
    await this.setEnabled(true)
    await this.setTunnel(true)
    this.d.log?.info('[remote] Phone on at launch', { devices: this.auth.count })
    return true
  }
  changed(): void {
    try {
      this.d.emit(this.state())
    } catch {
      /* the window may be gone */
    }
  }

  /** one switch at a time (a double click never starts two servers) */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.busy.then(f, f)
    this.busy = next.catch(() => undefined)
    return next
  }

  setEnabled(on: boolean): Promise<RemoteState> {
    return this.serial(async () => {
      if (on && !this.server) {
        const api = new PhoneApi(this.d.host)
        // a phone coming online or leaving updates the device list on the Mac
        const counted: RemoteApi = {
          handle: (...a) => api.handle(...a),
          socket: (ws, dev) => {
            api.socket(ws, dev)
            ws.on('close', () => this.changed())
            this.changed()
          }
        }
        const s = new RemoteServer({ auth: this.auth, api: counted, bundleDir: this.d.bundleDir, extraHosts: () => (this.tunnel.host ? [this.tunnel.host] : []), allowedOrigins: () => this.siteOrigins(), log: this.d.log })
        await s.start()
        this.api = api
        this.server = s
        this.d.log?.info('[remote] Phone on', { url: s.localUrl })
      } else if (!on && this.server) {
        await this.shutdown()
      }
      this.changed()
      return this.state()
    })
  }

  setTunnel(on: boolean): Promise<RemoteState> {
    return this.serial(async () => {
      if (on) {
        if (!this.server) throw Object.assign(new Error('Turn Phone on first'), { code: 'conflict' })
        const port = this.server.address?.port
        if (port) this.tunnel.start(port)
      } else this.tunnel.stop()
      this.changed()
      return this.state()
    })
  }

  private site(): string | null {
    try {
      return this.d.site?.() ?? null
    } catch {
      return null
    }
  }
  private siteOrigins(): string[] {
    const s = this.site()
    return s ? [s] : []
  }

  /**
   * A fresh one-time link: through the tunnel when it is on, else this Mac only. With a hosted phone app it opens that
   * site with this Mac's address in the fragment (`<site>/#mac=…&code=…`); without one, the Mac's own page.
   */
  pairLink(): RemotePairLink {
    if (!this.server?.localUrl) throw Object.assign(new Error('Turn Phone on first'), { code: 'conflict' })
    const { code, expiresAt } = this.auth.createCode()
    const mac = this.tunnel.state.url ?? this.server.localUrl
    const site = this.site()
    return { link: pairLinkFor({ site, mac, code }), expiresAt: new Date(expiresAt).toISOString(), public: !!this.tunnel.state.url, site }
  }

  revoke(id: string): RemoteState {
    this.api?.bye('revoked', id)
    this.auth.revoke(id)
    this.server?.closeDevice(id)
    this.changed()
    return this.state()
  }

  /** RA2: every paired phone is signed out (bye, its sockets closed, its token dead). */
  signOutAll(): RemoteState {
    this.api?.bye('revoked')
    for (const id of this.auth.revokeAll()) this.server?.closeDevice(id)
    this.changed()
    return this.state()
  }

  private async shutdown(): Promise<void> {
    // no bye: the phones keep their token and come back when Phone is on again (the sockets just close, 1001)
    this.tunnel.stop()
    const s = this.server
    this.server = null
    this.api?.dispose()
    this.api = null
    await s?.stop().catch(() => undefined)
    // RA2: codes die with the server; paired phones stay paired
    this.auth.endSession()
    this.d.log?.info('[remote] Phone off')
  }

  /** Quit: the same as Turn off. */
  stop(): Promise<void> {
    return this.serial(() => this.shutdown())
  }
}
