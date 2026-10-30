/**
 * REMOTE.md RA1: the optional quick tunnel. Runs `cloudflared tunnel --url http://127.0.0.1:<port>` (outbound only)
 * and reads the `https://….trycloudflare.com` address it prints. Principia never downloads cloudflared: a missing
 * binary is a state with a one-line install hint. The process is ours: stop() kills only it.
 *
 * RA8: a quick tunnel's address dies with its process, and a phone cannot be told the new one. So cloudflared runs
 * detached and writes to a file (a pipe would kill it when Principia exits): a Quit or an update leaves it running,
 * for up to KEPT_TUNNEL_MS, and the next launch takes it back on the same local port. If it stops or never comes up,
 * it is started again, with a wait between tries.
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { RemoteTunnelState } from '../../shared/remote'

export const TUNNEL_INSTALL_HINT = 'Install it with: brew install cloudflared'
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi
/** cloudflared's own service host shows in its error lines ("failed to request quick Tunnel: Post https://api…") */
const NOT_A_TUNNEL = new Set(['https://api.trycloudflare.com'])

/** RA8: how long a tunnel outlives Principia after a Quit: never a public address left running for good */
export const KEPT_TUNNEL_MS = 24 * 3_600_000
/** RA8: the waits between tries when the tunnel stopped or never came up (the last one repeats) */
export const TUNNEL_RETRY_MS = [5_000, 15_000, 60_000, 300_000]
const WATCH_KEPT_MS = 5_000
const REAPER_MARK = 'principia-phone-tunnel-reaper'
const READ_LOG_MS = 250

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

/** RA8: the running cloudflared a later launch can take back */
export interface KeptTunnel {
  pid: number
  port: number
  url: string
  /** the process that ends it KEPT_TUNNEL_MS after Principia is gone, however it went */
  reaper?: number
}

export interface TunnelKeep {
  load(): KeptTunnel | null
  save(k: KeptTunnel | null): void
  /** where cloudflared writes */
  logPath: string
}

export function fileKeep(file: string, logPath: string): TunnelKeep {
  return {
    logPath,
    load() {
      try {
        const k = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KeptTunnel>
        const url = parseTunnelUrl(String(k.url ?? ''))
        if (!Number.isInteger(k.pid) || !Number.isInteger(k.port) || !url) return null
        return { pid: k.pid!, port: k.port!, url, ...(Number.isInteger(k.reaper) ? { reaper: k.reaper } : {}) }
      } catch {
        return null
      }
    },
    save(k) {
      try {
        if (k) fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 })
        else fs.rmSync(file, { force: true })
      } catch {
        /* the next launch starts a new tunnel */
      }
    }
  }
}

/** What the Tunnel asks of processes that are not its own child. */
export interface TunnelProcs {
  /** is `pid` still cloudflared, serving that port? (a pid can be reused after a reboot) */
  isOurs(pid: number, port: number): boolean
  running(pid: number): boolean
  kill(pid: number, signal: NodeJS.Signals): void
  /** ends `pid` `ms` after this process is gone, crash included, unless it stopped or its pid went to another; its own pid */
  reapAfter(pid: number, ms: number): number | null
  /** the reaper is not needed any more (a stale pid is someone else's: left alone) */
  endReaper(pid: number): void
}

/** Identifies a process across pid reuse: its start time, as `ps` writes it. */
function startedAt(pid: number): string {
  return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).replace(/\n+$/, '')
}

/**
 * The reaper, for `sh -c`: $1 is Principia's pid and $2 its start time, $3 and $4 the tunnel's. It waits for Principia to
 * go, so a crash or a force quit is covered too, then for `ms`, and only ever ends the process it was given.
 */
export function reaperScript(ms: number, pollS = 30): string {
  return `alive() { [ "$(ps -o lstart= -p "$1")" = "$2" ]; }; while alive "$1" "$2"; do alive "$3" "$4" || exit 0; sleep ${pollS}; done; sleep ${Math.ceil(ms / 1000)}; alive "$3" "$4" && kill "$3" # ${REAPER_MARK}`
}

const nodeProcs: TunnelProcs = {
  isOurs(pid, port) {
    try {
      const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
      return cmd.includes('cloudflared') && cmd.includes(`http://127.0.0.1:${port}`)
    } catch {
      return false
    }
  },
  running(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  },
  reapAfter(pid, ms) {
    try {
      const self = startedAt(process.pid)
      const tunnel = startedAt(pid)
      if (!self || !tunnel) return null
      const p = nodeSpawn('/bin/sh', ['-c', reaperScript(ms), 'reaper', String(process.pid), self, String(pid), tunnel], { stdio: 'ignore', detached: true })
      p.on('error', () => undefined)
      p.unref()
      return p.pid ?? null
    } catch {
      return null
    }
  },
  endReaper(pid) {
    try {
      const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
      // its own process group: the sleep goes with it
      if (cmd.includes(REAPER_MARK)) process.kill(-pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export interface TunnelDeps {
  bin: () => string | null
  /** `out`: a file for cloudflared's output, or 'pipe' */
  spawn?: (file: string, args: string[], out: number | 'pipe') => ChildProcess
  onChange: (s: TunnelState) => void
  /** how long to wait for the address */
  timeoutMs?: number
  /** RA8: without it the tunnel ends with Principia */
  keep?: TunnelKeep
  procs?: TunnelProcs
  retryMs?: number[]
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export class Tunnel {
  private proc: ChildProcess | null = null
  /** the cloudflared a previous launch left running */
  private adopted: number | null = null
  private s: TunnelState = { state: 'off', url: null, message: null }
  private timer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  /** the port the tunnel should serve; null: nobody wants one */
  private port: number | null = null
  private tries = 0
  constructor(private readonly d: TunnelDeps) {}

  private get procs(): TunnelProcs {
    return this.d.procs ?? nodeProcs
  }
  get state(): TunnelState {
    return this.s
  }
  /** The tunnel host ("abc.trycloudflare.com") while on. */
  get host(): string | null {
    return this.s.url ? new URL(this.s.url).host : null
  }
  /** RA8: the port a kept tunnel serves: the server listens there again so the tunnel still reaches it */
  get keptPort(): number | null {
    return this.d.keep?.load()?.port ?? null
  }
  private set(s: TunnelState): void {
    this.s = s
    this.d.onChange(s)
  }
  private clearTimers(): void {
    for (const t of [this.timer, this.retryTimer]) if (t) clearTimeout(t)
    if (this.ticker) clearInterval(this.ticker)
    this.timer = this.retryTimer = this.ticker = null
  }
  private up(pid: number | undefined, port: number, url: string): void {
    this.tries = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // from the moment it is up: a crash leaves it running as much as a quit does
    if (pid && this.d.keep) this.d.keep.save({ pid, port, url, reaper: this.procs.reapAfter(pid, KEPT_TUNNEL_MS) ?? undefined })
    this.set({ state: 'on', url, message: null })
  }
  /** It stopped or never came up, and it is still wanted: go again after a wait. */
  private fell(message: string): void {
    this.clearTimers()
    this.proc = null
    this.adopted = null
    this.d.keep?.save(null)
    const port = this.port
    if (port === null) return this.set({ state: 'error', url: null, message })
    const waits = this.d.retryMs ?? TUNNEL_RETRY_MS
    const wait = waits[Math.min(this.tries++, waits.length - 1)]
    this.d.log?.warn('[remote] tunnel down, trying again', { message, waitMs: wait })
    this.set({ state: 'error', url: null, message: `${message} Trying again by itself.` })
    this.retryTimer = setTimeout(() => this.start(port), wait)
    this.retryTimer.unref?.()
  }

  /** RA8: the kept tunnel ends, and what would have ended it. */
  private discard(k: KeptTunnel, spare?: number): void {
    if (k.reaper) this.procs.endReaper(k.reaper)
    if (k.pid !== spare && this.procs.isOurs(k.pid, k.port)) this.procs.kill(k.pid, 'SIGTERM')
    this.d.keep?.save(null)
  }

  /** RA8: the kept tunnel if it still serves this port. Anything else that was kept goes. */
  private adopt(port: number): boolean {
    const k = this.d.keep?.load()
    if (!k) return false
    if (k.port !== port || !this.procs.isOurs(k.pid, k.port)) {
      this.discard(k)
      return false
    }
    if (k.reaper) this.procs.endReaper(k.reaper)
    this.adopted = k.pid
    this.ticker = setInterval(() => {
      if (this.adopted !== k.pid || this.procs.running(k.pid)) return
      this.fell('The tunnel stopped.')
    }, WATCH_KEPT_MS)
    this.ticker.unref?.()
    this.d.log?.info('[remote] tunnel kept across the restart: same address')
    this.up(k.pid, port, k.url)
    return true
  }

  start(port: number): void {
    if (this.proc || this.adopted) return
    this.clearTimers()
    this.port = port
    if (this.adopt(port)) return
    const bin = this.d.bin()
    if (!bin) return this.set({ state: 'missing', url: null, message: `cloudflared is not installed. ${TUNNEL_INSTALL_HINT}` })
    this.set({ state: 'starting', url: null, message: null })
    const logPath = this.d.keep?.logPath
    const spawn =
      this.d.spawn ??
      ((f, a, out) => {
        const c = nodeSpawn(f, a, { stdio: ['ignore', out, out], detached: out !== 'pipe', env: { ...process.env, NO_COLOR: '1' } })
        if (out !== 'pipe') c.unref()
        return c
      })
    let p: ChildProcess
    let out: number | 'pipe' = 'pipe'
    try {
      if (logPath) out = fs.openSync(logPath, 'w', 0o600)
      p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], out)
    } catch (e) {
      this.fell(`cloudflared did not start: ${e instanceof Error ? e.message : String(e)}.`)
      return
    } finally {
      if (typeof out === 'number') fs.closeSync(out)
    }
    this.proc = p
    let buf = ''
    const read = (text: string): void => {
      if (this.s.url || this.proc !== p) return
      buf = (buf + text).slice(-8000)
      const url = parseTunnelUrl(buf)
      if (!url) return
      if (this.ticker) clearInterval(this.ticker)
      this.ticker = null
      this.up(p.pid, port, url)
    }
    p.stdout?.on('data', (c: Buffer | string) => read(c.toString()))
    p.stderr?.on('data', (c: Buffer | string) => read(c.toString()))
    if (logPath) {
      this.ticker = setInterval(() => {
        try {
          buf = ''
          read(fs.readFileSync(logPath, 'utf8'))
        } catch {
          /* not written yet */
        }
      }, READ_LOG_MS)
      this.ticker.unref?.()
    }
    p.on('error', (e) => {
      if (this.proc === p) this.fell(`cloudflared failed: ${e.message}.`)
    })
    p.on('exit', (code) => {
      if (this.proc === p) this.fell(`The tunnel stopped (cloudflared exited${code === null ? '' : ` with ${code}`}).`)
    })
    this.timer = setTimeout(() => {
      if (this.proc !== p || this.s.url) return
      this.end(p)
      this.fell('cloudflared gave no address in time. Check your internet.')
    }, this.d.timeoutMs ?? 30_000)
    this.timer.unref?.()
  }

  private end(p: ChildProcess): void {
    this.proc = null
    if (p.exitCode !== null) return
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

  stop(): void {
    this.clearTimers()
    this.port = null
    const own = this.proc?.pid
    if (this.proc) this.end(this.proc)
    const k = this.d.keep?.load()
    if (k) this.discard(k, own)
    this.adopted = null
    if (this.s.state !== 'off') this.set({ state: 'off', url: null, message: null })
  }

  /** RA8: Principia is quitting: the tunnel stays up for the next launch, and its reaper ends it after KEPT_TUNNEL_MS. */
  leaveRunning(): void {
    const pid = this.proc?.pid ?? this.adopted
    const url = this.s.url
    const port = this.port
    if (!this.d.keep || !pid || !url || port === null) return this.stop()
    this.clearTimers()
    this.proc = null
    this.adopted = null
    this.port = null
    // its reaper has been waiting since the tunnel came up
    this.d.keep.save({ pid, port, url, reaper: this.d.keep.load()?.reaper ?? this.procs.reapAfter(pid, KEPT_TUNNEL_MS) ?? undefined })
    this.set({ state: 'off', url: null, message: null })
  }
}
