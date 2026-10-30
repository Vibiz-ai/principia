/** RA8: the quick tunnel keeps its address across a Quit, and comes back by itself when it stops. */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileKeep, KEPT_TUNNEL_MS, reaperScript, Tunnel, type KeptTunnel, type TunnelKeep, type TunnelProcs, type TunnelState } from './tunnel'

const URL_A = 'https://quiet-tree-forty-two.trycloudflare.com'
const URL_B = 'https://calm-sea-seven.trycloudflare.com'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  killed: string[] = []
  constructor(readonly pid: number) {
    super()
  }
  kill(sig: string): boolean {
    this.killed.push(sig)
    return true
  }
  say(url: string): void {
    this.stderr.emit('data', `INF |  ${url}  |`)
  }
}

function setup(o: { kept?: KeptTunnel | null; ours?: (pid: number, port: number) => boolean } = {}) {
  let kept = o.kept ?? null
  const keep: Pick<TunnelKeep, 'load' | 'save'> = { load: () => kept, save: (k) => (kept = k) }
  const killed: number[] = []
  const reapers: number[] = []
  const procs: TunnelProcs = {
    isOurs: o.ours ?? (() => true),
    running: () => true,
    kill: (pid) => void killed.push(pid),
    reapAfter: () => 777,
    endReaper: (pid) => void reapers.push(pid)
  }
  const spawned: FakeProc[] = []
  const states: TunnelState[] = []
  const t = new Tunnel({
    bin: () => '/bin/cloudflared',
    spawn: () => {
      const p = new FakeProc(100 + spawned.length)
      spawned.push(p)
      return p as unknown as ChildProcess
    },
    onChange: (s) => states.push(s),
    keep: { ...keep, logPath: path.join(tmp, 'tunnel.log') },
    procs,
    retryMs: [10, 50]
  })
  return { t, spawned, states, killed, reapers, procs, kept: () => kept }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr71-tunnel-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the tunnel across a restart (RA8)', () => {
  it('remembers a tunnel that came up, and reads the address cloudflared writes to its file', () => {
    const logPath = path.join(tmp, 'tunnel.log')
    const { t, spawned, kept } = setup()
    t.start(5000)
    fs.writeFileSync(logPath, `INF |  ${URL_A}  |`)
    vi.advanceTimersByTime(300)
    expect(t.state).toEqual({ state: 'on', url: URL_A, message: null })
    expect(kept()).toEqual({ pid: spawned[0].pid, port: 5000, url: URL_A, reaper: 777 })
  })

  it('has its end date from the moment it is up: a crash skips the Quit, and a Quit needs no second reaper', () => {
    const { t, spawned, procs } = setup()
    const reapAfter = vi.spyOn(procs, 'reapAfter')
    t.start(5000)
    spawned[0].say(URL_A)
    expect(reapAfter).toHaveBeenCalledWith(spawned[0].pid, KEPT_TUNNEL_MS)
    t.leaveRunning()
    expect(reapAfter).toHaveBeenCalledOnce()
  })

  it('a Quit leaves it running, with an end date; it is not killed', () => {
    const { t, spawned, kept, killed } = setup()
    t.start(5000)
    spawned[0].say(URL_A)
    t.leaveRunning()
    expect(spawned[0].killed).toEqual([])
    expect(killed).toEqual([])
    expect(kept()).toEqual({ pid: 100, port: 5000, url: URL_A, reaper: 777 })
    expect(KEPT_TUNNEL_MS).toBe(86_400_000)
  })

  it('the next launch takes it back: same address, no new cloudflared, the reaper called off', () => {
    const { t, spawned, reapers, kept } = setup({ kept: { pid: 42, port: 5000, url: URL_A, reaper: 777 } })
    expect(t.keptPort).toBe(5000)
    t.start(5000)
    expect(spawned).toHaveLength(0)
    expect(t.state.url).toBe(URL_A)
    expect(t.host).toBe('quiet-tree-forty-two.trycloudflare.com')
    expect(reapers).toEqual([777])
    expect(kept()).toEqual({ pid: 42, port: 5000, url: URL_A, reaper: 777 })
  })

  it('a kept tunnel on another port is ended, then a new one starts', () => {
    const { t, spawned, killed, reapers } = setup({ kept: { pid: 42, port: 5000, url: URL_A, reaper: 777 } })
    t.start(6000)
    expect(killed).toEqual([42])
    expect(reapers).toEqual([777])
    expect(spawned).toHaveLength(1)
  })

  it('a pid that is no longer cloudflared (a reboot) is never killed: a new tunnel starts', () => {
    const { t, spawned, killed } = setup({ kept: { pid: 42, port: 5000, url: URL_A }, ours: () => false })
    t.start(5000)
    expect(killed).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(t.state.state).toBe('starting')
  })

  it('Turn off ends a kept tunnel too and forgets it', () => {
    const { t, killed, kept } = setup({ kept: { pid: 42, port: 5000, url: URL_A } })
    t.start(5000)
    t.stop()
    expect(killed).toEqual([42])
    expect(kept()).toBeNull()
    expect(t.state.state).toBe('off')
  })

  it('Turn off ends its own process once, and nothing comes back', () => {
    const { t, spawned, killed, kept } = setup()
    t.start(5000)
    spawned[0].say(URL_A)
    t.stop()
    expect(spawned[0].killed).toEqual(['SIGTERM'])
    expect(killed).toEqual([])
    expect(kept()).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(1)
  })

  it('a Quit with no address yet leaves nothing behind', () => {
    const { t, spawned, kept } = setup()
    t.start(5000)
    t.leaveRunning()
    expect(spawned[0].killed).toEqual(['SIGTERM'])
    expect(kept()).toBeNull()
  })
})

describe('the tunnel comes back by itself (RA8)', () => {
  it('starts again after cloudflared exits, waiting longer each time, and resets once it is up', () => {
    const { t, spawned, kept } = setup()
    t.start(5000)
    spawned[0].say(URL_A)
    spawned[0].emit('exit', 1)
    expect(t.state.state).toBe('error')
    expect(t.state.message).toMatch(/Trying again by itself/)
    expect(kept()).toBeNull()
    vi.advanceTimersByTime(10)
    expect(spawned).toHaveLength(2)
    spawned[1].emit('exit', 1)
    vi.advanceTimersByTime(49)
    expect(spawned).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(spawned).toHaveLength(3)
    spawned[2].say(URL_B)
    expect(t.state).toEqual({ state: 'on', url: URL_B, message: null })
    spawned[2].emit('exit', 1)
    vi.advanceTimersByTime(10)
    expect(spawned).toHaveLength(4)
  })

  it('tries again when no address came in time (no internet at launch)', () => {
    const { t, spawned } = setup()
    t.start(5000)
    vi.advanceTimersByTime(30_000)
    expect(spawned[0].killed).toContain('SIGTERM')
    expect(t.state.message).toMatch(/no address in time/)
    vi.advanceTimersByTime(10)
    expect(spawned).toHaveLength(2)
  })

  it('notices a kept tunnel that died', () => {
    const procs: TunnelProcs = { isOurs: () => true, running: () => false, kill: () => undefined, reapAfter: () => null, endReaper: () => undefined }
    let kept: KeptTunnel | null = { pid: 42, port: 5000, url: URL_A }
    const spawned: FakeProc[] = []
    const t = new Tunnel({ bin: () => '/bin/cloudflared', spawn: () => (spawned.push(new FakeProc(9)), spawned[0] as unknown as ChildProcess), onChange: () => undefined, keep: { load: () => kept, save: (k) => (kept = k), logPath: path.join(tmp, 'x.log') }, procs, retryMs: [10] })
    t.start(5000)
    vi.advanceTimersByTime(5000)
    expect(t.state.state).toBe('error')
    vi.advanceTimersByTime(10)
    expect(spawned).toHaveLength(1)
  })
})

describe('fileKeep', () => {
  it('survives a restart, and a damaged file or a foreign address is nothing', () => {
    const file = path.join(tmp, 'kept.json')
    const k = fileKeep(file, path.join(tmp, 'log'))
    k.save({ pid: 1, port: 2, url: URL_A })
    expect(fileKeep(file, '').load()).toEqual({ pid: 1, port: 2, url: URL_A })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    fs.writeFileSync(file, '{"pid":1,"port":2,"url":"https://evil.example.com"}')
    expect(k.load()).toBeNull()
    fs.writeFileSync(file, 'nope')
    expect(k.load()).toBeNull()
    k.save(null)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('the reaper (RA8)', () => {
  const sleeper = (): ChildProcess => spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  const startOf = (pid: number): string => execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).replace(/\n+$/, '')
  const gone = (p: ChildProcess): Promise<void> => new Promise((res) => (p.exitCode !== null || p.signalCode ? res() : p.once('exit', () => res())))
  const reap = (parent: ChildProcess, tunnel: ChildProcess, tunnelStart = startOf(tunnel.pid!)): ChildProcess =>
    spawn('/bin/sh', ['-c', reaperScript(1000, 0.1), 'reaper', String(parent.pid), startOf(parent.pid!), String(tunnel.pid), tunnelStart], { stdio: 'ignore' })

  it('ends the tunnel after Principia dies, however it died', async () => {
    const [parent, tunnel] = [sleeper(), sleeper()]
    const reaper = reap(parent, tunnel)
    parent.kill('SIGKILL')
    await gone(reaper)
    await gone(tunnel)
    expect(tunnel.signalCode).toBe('SIGTERM')
  }, 10_000)

  it('leaves alone a process that merely has the same pid', async () => {
    const [parent, tunnel] = [sleeper(), sleeper()]
    const reaper = reap(parent, tunnel, 'Thu Jan  1 00:00:00 1970')
    await gone(reaper)
    expect(tunnel.exitCode === null && !tunnel.signalCode).toBe(true)
    parent.kill()
    tunnel.kill()
  }, 10_000)
})
