/**
 * REMOTE.md RA1: the optional quick tunnel. Runs `cloudflared tunnel --url http://127.0.0.1:<port>` (outbound only)
 * and reads the `https://….trycloudflare.com` address it prints. Principia never downloads cloudflared: a missing
 * binary is a state with a one-line install hint. The process is ours: stop() kills only it.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { RemoteTunnelState } from '../../shared/remote'

export const TUNNEL_INSTALL_HINT = 'Install it with: brew install cloudflared'
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi
/** cloudflared's own service host shows in its error lines ("failed to request quick Tunnel: Post https://api…") */
const NOT_A_TUNNEL = new Set(['https://api.trycloudflare.com'])

export interface TunnelState {
  state: RemoteTunnelState
  url: string | null
  message: string | null
}

/** The cloudflared binary on PATH or in the usual Homebrew places, or null. */
export function findCloudflared(envPath: string | undefined, exists: (p: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const dirs = [...(envPath ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin']
  for (const d of dirs) {
    const p = path.join(d, 'cloudflared')
    if (exists(p)) return p
  }
  return null
}

export function parseTunnelUrl(text: string): string | null {
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].toLowerCase()
    if (!NOT_A_TUNNEL.has(url)) return url
  }
  return null
}

export interface TunnelDeps {
  bin: () => string | null
  spawn?: (file: string, args: string[]) => ChildProcess
  onChange: (s: TunnelState) => void
  /** how long to wait for the address */
  timeoutMs?: number
}

export class Tunnel {
  private proc: ChildProcess | null = null
  private s: TunnelState = { state: 'off', url: null, message: null }
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly d: TunnelDeps) {}

  get state(): TunnelState {
    return this.s
  }
  /** The tunnel host ("abc.trycloudflare.com") while on. */
  get host(): string | null {
    return this.s.url ? new URL(this.s.url).host : null
  }
  private set(s: TunnelState): void {
    this.s = s
    this.d.onChange(s)
  }

  start(port: number): void {
    if (this.proc) return
    const bin = this.d.bin()
    if (!bin) return this.set({ state: 'missing', url: null, message: `cloudflared is not installed. ${TUNNEL_INSTALL_HINT}` })
    this.set({ state: 'starting', url: null, message: null })
    const spawn = this.d.spawn ?? ((f, a) => nodeSpawn(f, a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }))
    let p: ChildProcess
    try {
      p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`])
    } catch (e) {
      return this.set({ state: 'error', url: null, message: `cloudflared did not start: ${e instanceof Error ? e.message : String(e)}` })
    }
    this.proc = p
    let buf = ''
    const read = (chunk: Buffer | string): void => {
      if (this.s.url) return
      buf = (buf + chunk.toString()).slice(-8000)
      const url = parseTunnelUrl(buf)
      if (url && this.proc === p) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.set({ state: 'on', url, message: null })
      }
    }
    p.stdout?.on('data', read)
    p.stderr?.on('data', read)
    p.on('error', (e) => {
      if (this.proc !== p) return
      this.proc = null
      this.set({ state: 'error', url: null, message: `cloudflared failed: ${e.message}` })
    })
    p.on('exit', (code) => {
      if (this.proc !== p) return
      this.proc = null
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.set({ state: 'error', url: null, message: `The tunnel stopped (cloudflared exited${code === null ? '' : ` with ${code}`}). Try again.` })
    })
    this.timer = setTimeout(() => {
      if (this.proc !== p || this.s.url) return
      this.stop()
      this.set({ state: 'error', url: null, message: 'cloudflared gave no address in time. Check your internet and try again.' })
    }, this.d.timeoutMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    const p = this.proc
    this.proc = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (p && p.exitCode === null) {
      try {
        p.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          if (p.exitCode === null) p.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }, 2000)
      hard.unref?.()
    }
    if (this.s.state !== 'off') this.set({ state: 'off', url: null, message: null })
  }
}
