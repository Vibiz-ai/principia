/**
 * docs/MACHINES.md: one click makes your cloud. CloudMachines drives a machine through its phases and survives an app
 * restart (the state is `<userData>/cloud-machine.json`, 0600, secrets encrypted with safeStorage):
 *
 *   creating → booting → installing → pairing → signing-in → ready      (or failed, with the phase it stopped at)
 *
 * - creating: the provider API makes the server (Ubuntu 24.04, this Mac's SSH key, the bootstrap script as user-data).
 *   On "My own server" the script runs over SSH instead, and creating/booting are skipped.
 * - installing: waits until https://<ip>.sslip.io/v1/health answers with a valid certificate.
 * - pairing: POST /v1/pair/start with the one-time admin token (the machine knows only its hash), then the normal
 *   pairing. The admin token is forgotten right after.
 * - signing-in: the Shared keys marked "In the cloud" and this Mac's GitHub go up (docs/ACCOUNTS.md). Then the machine
 *   is ready, and the Claude and Codex sign-ins you chose open in the browser, one after the other.
 *
 * The provider token is kept (encrypted) only so "Delete machine" can delete the server. Nothing secret reaches the
 * renderer, an event or a log line.
 *
 * Provider 'principia' (docs/FLEET.md) is the managed fleet: this Mac signs in to it with its GitHub sign-in once (the
 * fleet keeps only who you are) and gets a fleet key, kept here encrypted in place of a provider token. The fleet
 * makes the machine from a ready image, so creating/booting is about a minute. A managed machine sleeps when idle:
 * `wakeForUse` starts it again when this Mac needs it (a change sent to the cloud that can't get through), and
 * `refresh` keeps its power and this month's hours on the Cloud page.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { HiveError } from '../../../shared/errors'
import {
  IPV4_RE,
  MACHINE_PROVIDER_INFO,
  isPrivateIpv4,
  sslipHost,
  type ApiProvider,
  type CreateMachineRequest,
  type MachineBring,
  type MachineInfo,
  type MachineOptions,
  type MachinePhase,
  type MachinePower,
  type MachineView
} from '../../../shared/machines'
import type { Cipher } from '../../vault'
import { bootstrapScript } from './bootstrap'
import { FleetRequestError, type FleetClient, type FleetMachine } from './fleet'
import type { MachineApi } from './providers'

export const MACHINE_FILE = 'cloud-machine.json'
const LIVE: MachinePhase[] = ['creating', 'booting', 'installing', 'pairing', 'signing-in']

interface MachineFile extends Omit<MachineView, 'notes'> {
  v: 1
  notes: string[]
  /** base64 safeStorage ciphertext of the provider API token (managed: the fleet key) */
  token: string | null
  /** managed: the GitHub login the fleet knows this Mac as */
  login?: string | null
  /** base64 safeStorage ciphertext of the one-time admin token, until pairing used it */
  admin: string | null
  ssh: { host: string; user: string; port: number } | null
}

export interface MachineDeps {
  userData: string
  cipher: Cipher
  emit(view: MachineView | null): void
  api(provider: ApiProvider, token: string): MachineApi
  /** the managed fleet, or null when this build has none */
  fleet?: FleetClient | null
  /** this Mac's GitHub sign-in (gh auth token), for the fleet's one-time enroll */
  ghToken?: () => Promise<string | null>
  /** this Mac's SSH public key (~/.ssh/id_ed25519.pub…), or null */
  sshPublicKey(): string | null
  /** runs the script as root on the server; `line` gets its output lines */
  runSsh(target: { host: string; user: string; port: number }, script: string, line: (l: string) => void): Promise<{ code: number | null; tail: string }>
  /** the IPv4 a host name resolves to */
  resolve(host: string): Promise<string>
  /** pairs this Mac's CloudLink with a code (link.pair) */
  pair(url: string, code: string): Promise<void>
  /** the URL this Mac is linked to, or null */
  linkedUrl(): string | null
  unlink(): Promise<void>
  bring: {
    keys(): Promise<void>
    github(): Promise<void>
    /** signs the cloud in: from the sign-in saved on this Mac, else the browser; resolves when it ended */
    login(adapter: 'claude' | 'codex'): Promise<{ ok: boolean; detail: string | null }>
    /** a sign-in for this adapter is saved on this Mac (docs/FLEET.md §9): no browser needed */
    saved?(adapter: 'claude' | 'codex'): boolean
  }
  /** app version: the image tag and the source tag to build from */
  version: string
  image?: string
  sourceRef?: string
  hostName?: string
  fetch?: typeof fetch
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  timeouts?: { bootMs?: number; installMs?: number; pollMs?: number; managedBootMs?: number; wakeMs?: number }
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class CloudMachines {
  private file: MachineFile | null = null
  private driving: Promise<void> | null = null
  /** bumped by delete: a drive loop that sees a newer generation stops */
  private gen = 0

  constructor(private d: MachineDeps) {
    this.load()
  }

  private get path(): string {
    return path.join(this.d.userData, MACHINE_FILE)
  }
  private now(): Date {
    return this.d.now?.() ?? new Date()
  }
  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  private load(): void {
    try {
      const f = JSON.parse(fs.readFileSync(this.path, 'utf8')) as MachineFile
      if (f?.v === 1 && f.provider) this.file = f
    } catch {
      this.file = null
    }
  }
  private save(): void {
    if (!this.file) {
      fs.rmSync(this.path, { force: true })
      return
    }
    fs.mkdirSync(this.d.userData, { recursive: true })
    const tmp = `${this.path}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.path)
  }

  view(): MachineView | null {
    const f = this.file
    if (!f) return null
    const { v: _v, token: _t, admin: _a, ssh: _s, login: _l, ...rest } = f
    return { ...rest, notes: [...f.notes] }
  }

  info(): MachineInfo {
    return { managed: !!this.d.fleet, github: this.file?.login ?? null }
  }

  private update(patch: Partial<MachineFile>): void {
    if (!this.file) return
    Object.assign(this.file, patch)
    this.save()
    this.d.emit(this.view())
  }

  private secret(b64: string | null): string | null {
    return b64 ? this.d.cipher.decrypt(Buffer.from(b64, 'base64')) : null
  }

  /** Regions and sizes for the provider, with the token checked on the way. */
  async options(provider: ApiProvider, token: string): Promise<MachineOptions> {
    if (!token.trim()) throw new HiveError('validation', `Paste a ${MACHINE_PROVIDER_INFO[provider].label} API token.`)
    return this.d.api(provider, token.trim()).options()
  }

  /** Starts making the machine and returns at once; progress arrives as views (evt:cloud kind 'machine'). */
  async create(q: CreateMachineRequest): Promise<MachineView> {
    if (!this.d.cipher.available()) throw new HiveError('vault_unavailable', "macOS Keychain encryption is unavailable, so Principia can't keep your cloud's keys on this Mac.")
    if (this.file && this.file.phase !== 'failed') throw new HiveError('conflict', 'You already have a cloud machine. Delete it first to make a new one.')
    if (this.d.linkedUrl()) throw new HiveError('conflict', 'This Mac is connected to a cloud. Disconnect it first, then make a new one.')
    if (this.file) await this.remove() // a failed one: clean up its server before the next
    let ssh: MachineFile['ssh'] = null
    let token: string | null = null
    if (q.provider === 'principia') {
      if (!this.d.fleet) throw new HiveError('not_implemented', 'Principia Cloud isn’t available in this build. Use your own provider or server.')
    } else if (q.provider === 'ssh') {
      const host = q.ssh?.host?.trim()
      if (!host || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new HiveError('validation', 'Enter the server’s address (an IP or a host name).')
      const user = (q.ssh?.user ?? 'root').trim() || 'root'
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new HiveError('validation', 'That is not a user name.')
      ssh = { host, user, port: q.ssh?.port ?? 22 }
    } else {
      token = q.token?.trim() ?? ''
      if (!token) throw new HiveError('validation', `Paste a ${MACHINE_PROVIDER_INFO[q.provider].label} API token.`)
      if (!q.region || !q.size) throw new HiveError('validation', 'Pick a region and a size.')
    }
    const admin = randomBytes(32).toString('base64url')
    this.gen++
    this.file = {
      v: 1,
      provider: q.provider,
      name: `principia-${randomBytes(3).toString('hex')}`,
      serverId: null,
      ip: null,
      url: null,
      region: q.provider === 'principia' ? null : (q.region ?? null),
      size: q.provider === 'principia' ? null : (q.size ?? null),
      createdAt: this.now().toISOString(),
      phase: q.provider === 'ssh' ? 'installing' : 'creating',
      failedAt: null,
      detail: null,
      error: null,
      bring: { ...q.bring },
      notes: [],
      install: null,
      token: token ? this.d.cipher.encrypt(token).toString('base64') : null,
      admin: this.d.cipher.encrypt(admin).toString('base64'),
      ssh
    }
    this.save()
    this.d.log?.info('cloud machine: create', { provider: q.provider, region: q.region ?? null, size: q.size ?? null })
    this.d.emit(this.view())
    this.drive()
    return this.view()!
  }

  /** Picks up a machine that was being made when the app quit. */
  resume(): void {
    if (this.file && LIVE.includes(this.file.phase)) this.drive()
  }

  /** Tries again from the phase where it stopped. */
  retry(): MachineView {
    const f = this.file
    if (!f) throw new HiveError('not_found', 'There is no cloud machine.')
    if (f.phase !== 'failed') return this.view()!
    if (f.failedAt === 'pairing' && !f.admin) throw new HiveError('conflict', 'This machine can no longer pair this Mac. Delete it and make a new one.')
    this.update({ phase: f.failedAt ?? 'creating', failedAt: null, error: null })
    this.drive()
    return this.view()!
  }

  /** Disconnects this Mac from it (when linked to it) and deletes the server at the provider. "My own server" is only forgotten. */
  async remove(): Promise<null> {
    const f = this.file
    if (!f) return null
    this.gen++
    if (f.url && this.d.linkedUrl() === f.url) {
      try {
        await this.d.unlink()
      } catch (e) {
        this.d.log?.warn('cloud machine: unlink failed', { error: msg(e) })
      }
    }
    if (f.provider === 'principia') {
      const key = this.secret(f.token)
      if (key && this.d.fleet) {
        try {
          await this.d.fleet.remove(key)
        } catch (e) {
          // a key the fleet no longer knows has nothing left to delete
          if (!(e instanceof FleetRequestError && e.status === 401)) throw e
        }
      }
    } else if (f.provider !== 'ssh' && f.serverId) {
      const token = this.secret(f.token)
      if (token) await this.d.api(f.provider, token).remove(f.serverId)
    }
    this.d.log?.info('cloud machine: removed', { provider: f.provider })
    this.file = null
    this.save()
    this.d.emit(null)
    return null
  }

  private drive(): void {
    if (this.driving) return
    const gen = this.gen
    this.driving = this.loop(gen)
      .catch((e) => {
        if (gen !== this.gen || !this.file) return
        const at = this.file.phase
        this.d.log?.warn('cloud machine: stopped', { phase: at, error: msg(e) })
        this.update({ phase: 'failed', failedAt: LIVE.includes(at) ? at : null, error: msg(e), detail: null })
      })
      .finally(() => {
        this.driving = null
      })
  }

  private alive(gen: number): boolean {
    return gen === this.gen && !!this.file
  }

  private async loop(gen: number): Promise<void> {
    const t = { bootMs: 5 * 60_000, installMs: 35 * 60_000, pollMs: 5_000, managedBootMs: 25 * 60_000, ...this.d.timeouts }
    while (this.alive(gen)) {
      const f = this.file!
      switch (f.phase) {
        case 'creating':
          await this.createServer(f, gen)
          break
        case 'booting':
          await (f.provider === 'principia' ? this.bootManaged(f, gen, t.managedBootMs, t.pollMs) : this.boot(f, gen, t.bootMs, t.pollMs))
          break
        case 'installing':
          await this.install(f, gen, t.installMs, t.pollMs * 2)
          break
        case 'pairing':
          await this.pairNow(f)
          break
        case 'signing-in':
          await this.signIn(f)
          return
        default:
          return
      }
    }
  }

  private async createServer(f: MachineFile, gen: number): Promise<void> {
    if (f.provider === 'ssh') return this.update({ phase: 'installing' })
    if (f.provider === 'principia') return this.createManaged(f, gen)
    const token = this.secret(f.token)
    if (!token) throw new HiveError('vault_unavailable', 'The provider token could not be read on this Mac. Delete the machine and make a new one.')
    const api = this.d.api(f.provider, token)
    let sshKeyId: string | null = null
    const key = this.d.sshPublicKey()
    if (key) {
      try {
        sshKeyId = await api.ensureSshKey(`principia ${this.d.hostName ?? 'Mac'}`.slice(0, 60), key)
      } catch (e) {
        this.d.log?.warn('cloud machine: ssh key not added', { error: msg(e) })
      }
    }
    this.update({ detail: `${f.size} in ${f.region}` })
    const userData = this.script('auto', f.admin)
    const s = await api.create({ name: f.name, region: f.region!, size: f.size!, userData, sshKeyId })
    // deleted while the provider was making it: remove() saw no server yet, so delete it here or it bills forever
    if (!this.alive(gen)) {
      this.d.log?.info('cloud machine: deleting a server made after its delete', { provider: f.provider })
      await api.remove(s.id)
      return
    }
    this.update({ serverId: s.id, ip: s.ip, url: s.ip ? `https://${sslipHost(s.ip)}` : null, phase: 'booting', detail: null })
  }

  private script(domain: string, adminB64: string | null): string {
    const admin = this.secret(adminB64)
    if (!admin) throw new HiveError('conflict', 'This machine can no longer pair this Mac. Delete it and make a new one.')
    const v = this.d.version.replace(/^v/, '')
    return bootstrapScript({
      domain,
      adminTokenSha256: sha256(admin),
      image: this.d.image ?? `ghcr.io/vibiz-ai/principia-cloud:${v}`,
      sourceRef: this.d.sourceRef ?? `v${v}`,
      workspaceName: `${this.d.hostName ?? 'My'} cloud`
    })
  }

  // ---------- managed (docs/FLEET.md) ----------

  private fleet(): FleetClient {
    if (!this.d.fleet) throw new HiveError('not_implemented', 'Principia Cloud isn’t available in this build.')
    return this.d.fleet
  }

  /** The fleet key, signing this Mac in to the fleet with its GitHub sign-in the first time. */
  private async fleetKey(f: MachineFile): Promise<string> {
    const have = this.secret(f.token)
    if (have) return have
    const gh = (await this.d.ghToken?.()) ?? null
    if (!gh) throw new HiveError('validation', 'Sign in to GitHub on this Mac first (Keys › GitHub, or `gh auth login`). Principia Cloud uses it to know it’s you.')
    this.update({ detail: 'Signing in with GitHub…' })
    const e = await this.fleet().enroll(gh)
    if (!e.allowed) throw new HiveError('forbidden', `Principia Cloud isn’t open for ${e.login} yet.`)
    this.update({ token: this.d.cipher.encrypt(e.key).toString('base64'), login: e.login })
    return e.key
  }

  private async createManaged(f: MachineFile, gen: number): Promise<void> {
    const key = await this.fleetKey(f)
    const admin = this.secret(f.admin)
    if (!admin) throw new HiveError('conflict', 'This machine can no longer pair this Mac. Delete it and make a new one.')
    this.update({ detail: 'Making your machine…' })
    let m: FleetMachine
    try {
      m = await this.fleet().create(key, { adminTokenSha256: sha256(admin), workspaceName: `${this.d.hostName ?? 'My'} cloud` })
    } catch (e) {
      // made already (the app quit half way): carry on with it
      if (!(e instanceof FleetRequestError && e.fleetCode === 'exists')) throw e
      const cur = (await this.fleet().machine(key)).machine
      if (!cur) throw e
      m = cur
    }
    // deleted while the fleet was making it: remove() may have reached the fleet before the machine existed
    if (!this.alive(gen)) {
      await this.fleet().remove(key).catch((e) => this.d.log?.warn('cloud machine: delete after cancel failed', { error: msg(e) }))
      return
    }
    this.update({ serverId: m.id, url: m.url, ip: m.host ? m.host.replace(/\.sslip\.io$/, '').replace(/-/g, '.') : null, size: m.instanceType, phase: 'booting', detail: null, ...this.powerOf(m) })
  }

  private async bootManaged(f: MachineFile, gen: number, timeoutMs: number, pollMs: number): Promise<void> {
    const key = await this.fleetKey(f)
    const until = Date.now() + timeoutMs
    while (this.alive(gen)) {
      const { machine: m } = await this.fleet().machine(key)
      if (!m) throw new HiveError('not_found', 'Your machine is gone. Make it again.')
      if (m.state === 'failed') throw new HiveError('internal', m.error ?? 'Your machine didn’t start. Try again.')
      this.update({ url: m.url, detail: m.state === 'running' ? null : 'Starting your machine…', ...this.powerOf(m) })
      if (m.state === 'running') return this.update({ phase: 'installing' })
      if (Date.now() > until) throw new HiveError('internal', `Your machine didn’t start in ${Math.round(timeoutMs / 60_000)} minutes. Try again.`)
      await this.sleep(pollMs)
    }
  }

  private powerOf(m: FleetMachine): Pick<MachineFile, 'power' | 'sleep' | 'usage'> {
    const power: MachinePower = m.state === 'running' ? 'awake' : m.state === 'starting' || m.state === 'creating' ? 'waking' : 'asleep'
    return { power, sleep: { reason: m.state === 'failed' ? m.error : m.sleepReason, wakeAt: m.wakeAt, idleMinutes: m.idleMinutes }, usage: m.usage }
  }

  /** The managed machine's power and hours, from the fleet (the Cloud page and the 1-minute watch). */
  async refresh(): Promise<MachineView | null> {
    const f = this.file
    if (!f || f.provider !== 'principia' || f.phase !== 'ready' || !this.d.fleet) return this.view()
    const key = this.secret(f.token)
    if (!key) return this.view()
    try {
      const { machine: m } = await this.d.fleet.machine(key)
      if (m && this.file === f) {
        const next = this.powerOf(m)
        if (JSON.stringify(next) !== JSON.stringify({ power: f.power, sleep: f.sleep, usage: f.usage })) this.update(next)
      }
    } catch (e) {
      this.d.log?.warn('cloud machine: refresh failed', { error: msg(e) })
    }
    return this.view()
  }

  private waking: Promise<boolean> | null = null
  /**
   * Starts a sleeping managed machine and resolves true once its cloud answers (false: not a managed machine, or it
   * didn't come up). Callers that wait share one wake.
   */
  wakeForUse(): Promise<boolean> {
    const f = this.file
    if (!f || f.provider !== 'principia' || f.phase !== 'ready' || !this.d.fleet || !f.url) return Promise.resolve(false)
    this.waking ??= this.wake(f).finally(() => {
      this.waking = null
    })
    return this.waking
  }

  private async wake(f: MachineFile): Promise<boolean> {
    const key = this.secret(f.token)
    if (!key) return false
    const t = { wakeMs: 4 * 60_000, pollMs: 5_000, ...this.d.timeouts }
    this.d.log?.info('cloud machine: wake')
    const m = await this.fleet().wake(key)
    this.update({ ...this.powerOf(m), power: 'waking' })
    const until = Date.now() + t.wakeMs
    const get = this.d.fetch ?? fetch
    while (Date.now() < until && this.file === f) {
      try {
        const res = await get(`${f.url}/v1/health`, { signal: AbortSignal.timeout(8_000) })
        if (res.ok && ((await res.json()) as { ok?: boolean }).ok) {
          this.update({ power: 'awake' })
          return true
        }
      } catch {
        /* still starting */
      }
      await this.sleep(t.pollMs)
    }
    await this.refresh()
    return false
  }

  private watchTimer: NodeJS.Timeout | null = null
  /** Keeps power and hours fresh while the app runs (one fleet read a minute, only for a ready managed machine). */
  watch(everyMs = 60_000): () => void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    void this.refresh()
    this.watchTimer = setInterval(() => void this.refresh(), everyMs)
    this.watchTimer.unref?.()
    return () => {
      if (this.watchTimer) clearInterval(this.watchTimer)
      this.watchTimer = null
    }
  }

  private async boot(f: MachineFile, gen: number, timeoutMs: number, pollMs: number): Promise<void> {
    const api = this.d.api(f.provider as ApiProvider, this.secret(f.token)!)
    const until = Date.now() + timeoutMs
    while (this.alive(gen)) {
      const s = await api.status(f.serverId!)
      if (!s) throw new HiveError('not_found', 'The server is gone at the provider. Delete it here and make a new one.')
      if (s.running && s.ip) return this.update({ ip: s.ip, url: `https://${sslipHost(s.ip)}`, phase: 'installing' })
      if (Date.now() > until) throw new HiveError('internal', 'The server did not start in 5 minutes. Check it at the provider, then try again.')
      await this.sleep(pollMs)
    }
  }

  private async install(f: MachineFile, gen: number, timeoutMs: number, pollMs: number): Promise<void> {
    if (f.provider === 'ssh' && f.ssh) {
      const ip = IPV4_RE.test(f.ssh.host) ? f.ssh.host : await this.d.resolve(f.ssh.host)
      if (isPrivateIpv4(ip)) throw new HiveError('validation', `${f.ssh.host} is a private address (${ip}). The cloud needs a public IP for its https certificate.`)
      const url = `https://${sslipHost(ip)}`
      this.update({ ip, url, detail: 'Connecting over SSH…' })
      const r = await this.d.runSsh(f.ssh, this.script(sslipHost(ip), f.admin), (l) => {
        if (l.startsWith('principia: ') && this.alive(gen)) this.update({ detail: l.slice(11, 160) })
      })
      if (!this.alive(gen)) return
      if (r.code !== 0) throw new HiveError('internal', `The install stopped on the server${r.tail ? `: ${r.tail.slice(-300)}` : '.'}`)
    }
    const url = this.file!.url
    if (!url) throw new HiveError('internal', 'The server has no public IPv4 address.')
    const started = Date.now()
    const f2 = this.d.fetch ?? fetch
    while (this.alive(gen)) {
      try {
        const res = await f2(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) })
        const j = res.ok ? ((await res.json()) as { ok?: boolean }) : null
        if (j?.ok) return this.update({ phase: 'pairing', detail: null })
      } catch {
        /* not up yet, or no certificate yet */
      }
      const min = Math.floor((Date.now() - started) / 60_000)
      const managed = f.provider === 'principia'
      this.update({ detail: managed ? 'Getting its https certificate…' : min < 1 ? 'Installing Docker and Principia Cloud…' : `Installing… ${min} min (a first install takes 3 to 10 minutes)` })
      if (Date.now() - started > timeoutMs) {
        const hint = this.file?.ip && !managed ? ` To look: ssh root@${this.file.ip} tail -50 /var/log/principia-bootstrap.log` : ''
        throw new HiveError('internal', `Principia Cloud did not answer at ${url} after ${Math.round(timeoutMs / 60_000)} minutes.${hint}`)
      }
      await this.sleep(pollMs)
    }
  }

  private async pairNow(f: MachineFile): Promise<void> {
    const admin = this.secret(f.admin)
    if (!admin) throw new HiveError('conflict', 'This machine can no longer pair this Mac. Delete it and make a new one.')
    const res = await (this.d.fetch ?? fetch)(`${f.url}/v1/pair/start`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new HiveError('internal', `Your cloud refused to pair (${res.status}). Delete the machine and make a new one.`)
    const { code } = (await res.json()) as { code?: string }
    if (!code) throw new HiveError('internal', 'Your cloud answered without a pairing code.')
    await this.d.pair(f.url!, code)
    // the one-time token has done its job: nothing left on this Mac can pair another device
    this.update({ admin: null, phase: 'signing-in', detail: null })
  }

  private async signIn(f: MachineFile): Promise<void> {
    const notes: string[] = []
    const b: MachineBring = f.bring
    if (b.keys) {
      try {
        await this.d.bring.keys()
      } catch (e) {
        notes.push(`Shared keys: ${msg(e)}`)
      }
    }
    if (b.github) {
      try {
        await this.d.bring.github()
      } catch (e) {
        notes.push(`GitHub: ${msg(e)}`)
      }
    }
    const logins = (['claude', 'codex'] as const).filter((a) => b[a])
    for (const a of logins) notes.push(this.d.bring.saved?.(a) ? `${a === 'claude' ? 'Claude' : 'Codex'}: signing in with your saved sign-in…` : `${a === 'claude' ? 'Claude' : 'Codex'}: finish signing in in your browser.`)
    this.update({ phase: 'ready', notes, detail: null, ...(f.provider === 'principia' ? { power: 'awake' as const } : {}) })
    // the browser sign-ins run after "ready": the machine works without them, and they wait for you
    void this.logins(logins)
  }

  private async logins(adapters: ('claude' | 'codex')[]): Promise<void> {
    for (const a of adapters) {
      const name = a === 'claude' ? 'Claude' : 'Codex'
      let note: string | null
      try {
        const r = await this.d.bring.login(a)
        note = r.ok ? null : `${name}: ${(r.detail ?? 'Not signed in').replace(/\.+$/, '')}. Connect it on Keys.`
      } catch (e) {
        note = `${name}: ${msg(e)}`
      }
      if (!this.file) return
      const notes = this.file.notes.filter((n) => !n.startsWith(`${name}:`))
      this.update({ notes: note ? [...notes, note] : notes })
    }
  }
}
