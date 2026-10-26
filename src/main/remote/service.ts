/**
 * REMOTE.md: the Phone switch. Off by default and at every launch. On = the 127.0.0.1 server; the tunnel is a second,
 * separate switch. Off (or quit) = tunnel and server stopped, every socket closed, every phone signed out. No Electron
 * imports: wire.ts gives it the host and the event sink.
 */
import type { RemotePairLink, RemoteState } from '../../shared/remote'
import { RemoteAuth } from './auth'
import { PhoneApi, type PhoneHost } from './api'
import { RemoteServer, type RemoteApi } from './server'
import { Tunnel, type TunnelDeps } from './tunnel'

export interface RemoteServiceDeps {
  host: PhoneHost
  bundleDir: string | null
  emit: (s: RemoteState) => void
  tunnel: Pick<TunnelDeps, 'bin' | 'spawn' | 'timeoutMs'>
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export class RemoteService {
  readonly auth = new RemoteAuth()
  private api: PhoneApi | null = null
  private server: RemoteServer | null = null
  private readonly tunnel: Tunnel
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: RemoteServiceDeps) {
    this.tunnel = new Tunnel({ ...d.tunnel, onChange: () => this.changed() })
  }

  state(): RemoteState {
    const online = this.server?.onlineDevices() ?? new Set<string>()
    return {
      enabled: !!this.server?.listening,
      localUrl: this.server?.localUrl ?? null,
      tunnel: { ...this.tunnel.state },
      devices: this.server ? this.auth.devices((id) => online.has(id)) : []
    }
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
        const s = new RemoteServer({ auth: this.auth, api: counted, bundleDir: this.d.bundleDir, extraHosts: () => (this.tunnel.host ? [this.tunnel.host] : []), log: this.d.log })
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

  /** A fresh one-time link: through the tunnel when it is on, else this Mac only. */
  pairLink(): RemotePairLink {
    if (!this.server?.localUrl) throw Object.assign(new Error('Turn Phone on first'), { code: 'conflict' })
    const { code, expiresAt } = this.auth.createCode()
    const base = this.tunnel.state.url ?? this.server.localUrl
    return { link: `${base}/#pair=${code}`, expiresAt: new Date(expiresAt).toISOString(), public: !!this.tunnel.state.url }
  }

  revoke(id: string): RemoteState {
    this.api?.bye('revoked', id)
    this.auth.revoke(id)
    this.server?.closeDevice(id)
    this.changed()
    return this.state()
  }

  private async shutdown(): Promise<void> {
    this.api?.bye('off')
    this.tunnel.stop()
    const s = this.server
    this.server = null
    this.api?.dispose()
    this.api = null
    await s?.stop().catch(() => undefined)
    // RA2: off signs every phone out; codes die with the server
    this.auth.reset()
    this.d.log?.info('[remote] Phone off')
  }

  /** Quit: the same as Turn off. */
  stop(): Promise<void> {
    return this.serial(() => this.shutdown())
  }
}
