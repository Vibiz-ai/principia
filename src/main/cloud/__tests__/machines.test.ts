import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MachineView } from '../../../shared/machines'
import { isPrivateIpv4, sslipHost } from '../../../shared/machines'
import { CloudMachines, MACHINE_FILE, lookHint, type MachineDeps } from '../machines'
import { bootstrapScript, configureScript, installScript, prepareScript, releaseInputs } from '../machines/bootstrap'
import { FleetRequestError, type FleetClient, type FleetMachine } from '../machines/fleet'
import { digitalocean, hetzner, pickDefaultSize, type MachineApi } from '../machines/providers'
import { sshPublicKey } from '../machines/local'

const PROVIDER_TOKEN = 'hz-PROVIDER-token-0123456789abcdefghijklmnopqrstuvwxyz'
const cipher = { available: () => true, encrypt: (s: string) => Buffer.from(`enc:${s}`), decrypt: (b: Buffer) => b.toString().slice(4) }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pmach-'))

/** A fake provider and a fake cloud that only pairs with the token whose hash the user-data holds. */
function setup(o: { linked?: string | null; boots?: number; healthAfter?: number; failCreate?: boolean; noKey?: boolean; createGate?: Promise<void> } = {}) {
  const userData = tmp()
  const views: (MachineView | null)[] = []
  const servers = new Map<string, { userData: string; polls: number; sshKeyId: string | null }>()
  const calls: string[] = []
  let healthPolls = 0
  let linked: string | null = o.linked ?? null
  const paired: { url: string; code: string }[] = []
  const brought: string[] = []
  const api: MachineApi = {
    async options() {
      return { provider: 'hetzner', regions: [{ id: 'nbg1', label: 'Nuremberg' }], sizes: [], defaultRegion: 'nbg1', defaultSize: 'cpx31' }
    },
    async ensureSshKey(_n, k) {
      calls.push(`key ${k.split(' ')[0]}`)
      return '77'
    },
    async create(c) {
      calls.push(`create ${c.region} ${c.size}`)
      if (o.failCreate) throw new Error('Hetzner: server type cpx31 is unavailable in nbg1')
      if (o.createGate) await o.createGate
      servers.set('42', { userData: c.userData, polls: 0, sshKeyId: c.sshKeyId })
      return { id: '42', ip: null }
    },
    async status(id) {
      const s = servers.get(id)
      if (!s) return null
      s.polls++
      return s.polls > (o.boots ?? 1) ? { running: true, ip: '203.0.113.7' } : { running: false, ip: null }
    },
    async remove(id) {
      calls.push(`delete ${id}`)
      servers.delete(id)
    }
  }
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/v1/health')) {
      healthPolls++
      if (healthPolls <= (o.healthAfter ?? 1)) throw new Error('certificate not yet')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (u.endsWith('/v1/pair/start')) {
      const tok = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '')
      const want = [...servers.values()][0]?.userData.match(/ADMIN_SHA256='([0-9a-f]{64})'/)?.[1] ?? ssh.script.match(/ADMIN_SHA256='([0-9a-f]{64})'/)?.[1]
      if (createHash('sha256').update(tok).digest('hex') !== want) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({ code: 'K7QM-4XWD' }), { status: 201 })
    }
    throw new Error(`unexpected ${u}`)
  }) as typeof fetch
  const ssh = { script: '', target: null as unknown, code: 0 as number | null }
  const deps: MachineDeps = {
    userData,
    cipher,
    emit: (v) => views.push(v),
    api: (p, t) => {
      calls.push(`api ${p} ${t === PROVIDER_TOKEN ? 'token-ok' : 'token-bad'}`)
      return api
    },
    sshPublicKey: () => (o.noKey ? null : 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc me@mac'),
    runSsh: async (t, script, line) => {
      ssh.script = script
      ssh.target = t
      line('principia: start')
      line('principia: up at https://203-0-113-9.sslip.io')
      return { code: ssh.code, tail: ssh.code ? 'E: Unable to locate package' : '' }
    },
    resolve: async (h) => (h === 'box.example.com' ? '203.0.113.9' : '100.101.102.103'),
    pair: async (url, code) => {
      paired.push({ url, code })
      linked = url
    },
    linkedUrl: () => linked,
    unlink: async () => {
      calls.push('unlink')
      linked = null
    },
    bring: {
      keys: async () => void brought.push('keys'),
      github: async () => {
        brought.push('github')
        throw new Error('gh is not signed in. Run gh auth login')
      },
      login: async (a) => {
        brought.push(`login ${a}`)
        return a === 'claude' ? { ok: true, detail: null } : { ok: false, detail: 'Canceled.' }
      }
    },
    version: '0.4.8',
    hostName: 'studio',
    fetch: fakeFetch,
    sleep: async () => undefined,
    timeouts: { pollMs: 0 }
  }
  return { deps, views, calls, paired, brought, servers, ssh, userData, linked: () => linked }
}

async function settle(m: CloudMachines, phase: string, n = 200): Promise<MachineView> {
  for (let i = 0; i < n; i++) {
    const v = m.view()
    if (v && v.phase === phase) return v
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`never reached ${phase}: ${JSON.stringify(m.view())}`)
}

const BRING = { github: true, keys: true, claude: true, codex: true }

describe('CloudMachines (docs/MACHINES.md)', () => {
  it('creates at Hetzner, waits for boot and https, pairs with the hashed token, signs in, then forgets the admin token', async () => {
    const t = setup({ boots: 2, healthAfter: 2 })
    const m = new CloudMachines(t.deps)
    const first = await m.create({ provider: 'hetzner', token: ` ${PROVIDER_TOKEN} `, region: 'nbg1', size: 'cpx31', bring: BRING })
    expect(first.phase).toBe('creating')
    const v = await settle(m, 'ready')
    expect(v).toMatchObject({ provider: 'hetzner', serverId: '42', ip: '203.0.113.7', url: 'https://203-0-113-7.sslip.io', region: 'nbg1', size: 'cpx31' })
    expect(t.calls).toContain('key ssh-ed25519')
    expect(t.calls).toContain('create nbg1 cpx31')
    expect(t.calls.filter((c) => c.startsWith('api')).every((c) => c.endsWith('token-ok'))).toBe(true)
    expect(t.servers.get('42')!.sshKeyId).toBe('77')
    expect(t.paired).toEqual([{ url: 'https://203-0-113-7.sslip.io', code: 'K7QM-4XWD' }])
    // the phases the renderer saw, in order
    const phases = t.views.map((x) => x?.phase).filter((p, i, a) => p !== a[i - 1])
    expect(phases).toEqual(['creating', 'booting', 'installing', 'pairing', 'signing-in', 'ready'])
    // keys and GitHub before ready (a failure is a note, not a stop); the browser sign-ins after it, one by one
    await new Promise((r) => setTimeout(r, 5))
    expect(t.brought).toEqual(['keys', 'github', 'login claude', 'login codex'])
    expect(m.view()!.notes).toEqual(['GitHub: gh is not signed in. Run gh auth login', 'Codex: Canceled. Connect it on Keys.'])
    // on disk: provider token encrypted, admin token gone; nothing secret in any view
    const file = fs.readFileSync(path.join(t.userData, MACHINE_FILE), 'utf8')
    expect(fs.statSync(path.join(t.userData, MACHINE_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(file).admin).toBeNull()
    expect(file).not.toContain(PROVIDER_TOKEN)
    expect(JSON.stringify(t.views)).not.toMatch(/token|enc:/i)
    // the user-data has the hash only
    const ud = t.servers.get('42')!.userData
    expect(ud).toMatch(/ADMIN_SHA256='[0-9a-f]{64}'/)
    expect(ud).toContain("DOMAIN='auto'")
    expect(ud).toContain("IMAGE='ghcr.io/vibiz-ai/principia-cloud:0.4.8'")
    expect(ud).toContain("SOURCE_REF='v0.4.8'")
  })

  it('delete disconnects this Mac and deletes the server', async () => {
    const t = setup()
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'cpx31', bring: { github: false, keys: false, claude: false, codex: false } })
    await settle(m, 'ready')
    expect(t.linked()).toBe('https://203-0-113-7.sslip.io')
    expect(await m.remove()).toBeNull()
    expect(t.calls.filter((c) => !c.startsWith('api')).slice(-2)).toEqual(['unlink', 'delete 42'])
    expect(m.view()).toBeNull()
    expect(t.views.at(-1)).toBeNull()
    expect(fs.existsSync(path.join(t.userData, MACHINE_FILE))).toBe(false)
  })

  it('a delete while the provider is still making the server deletes that server when it arrives', async () => {
    let open!: () => void
    const t = setup({ createGate: new Promise<void>((r) => (open = r)) })
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'cpx31', bring: { github: false, keys: false, claude: false, codex: false } })
    for (let i = 0; i < 50 && !t.calls.includes('create nbg1 cpx31'); i++) await new Promise((r) => setTimeout(r, 0))
    expect(await m.remove()).toBeNull()
    expect(t.calls).not.toContain('delete 42')
    open()
    for (let i = 0; i < 50 && !t.calls.includes('delete 42'); i++) await new Promise((r) => setTimeout(r, 0))
    expect(t.calls).toContain('delete 42')
    expect(t.servers.size).toBe(0)
    expect(m.view()).toBeNull()
  })

  it('a failure stops at its phase, says why, and retry picks up there', async () => {
    const t = setup({ failCreate: true })
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'cpx31', bring: BRING })
    const v = await settle(m, 'failed')
    expect(v).toMatchObject({ failedAt: 'creating', error: 'Hetzner: server type cpx31 is unavailable in nbg1' })
    m.retry()
    expect((await settle(m, 'failed')).failedAt).toBe('creating')
  })

  it('resumes after an app restart from the saved phase', async () => {
    const t = setup({ healthAfter: Infinity })
    const m = new CloudMachines({ ...t.deps, sleep: () => new Promise((r) => setTimeout(r, 1)), timeouts: { pollMs: 0, installMs: 60_000 } })
    await m.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'cpx31', bring: BRING })
    await settle(m, 'installing')
    // a new instance (the app restarted) reads the file and goes on from "installing"
    const t2 = { ...t.deps, fetch: (async (u: string, i?: RequestInit) => (String(u).endsWith('/v1/health') ? new Response('{"ok":true}') : t.deps.fetch!(u, i))) as typeof fetch }
    const again = new CloudMachines(t2)
    expect(again.view()!.phase).toBe('installing')
    // the first instance's loop is still polling: stop it the way delete would
    m['gen']++
    again.resume()
    expect((await settle(again, 'ready')).url).toBe('https://203-0-113-7.sslip.io')
  })

  it('on my own server: installs over SSH, with the domain from its address', async () => {
    const t = setup()
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'ssh', ssh: { host: 'box.example.com' }, bring: { github: false, keys: true, claude: false, codex: false } })
    const v = await settle(m, 'ready')
    expect(v).toMatchObject({ provider: 'ssh', ip: '203.0.113.9', url: 'https://203-0-113-9.sslip.io', serverId: null })
    expect(t.ssh.target).toEqual({ host: 'box.example.com', user: 'root', port: 22 })
    expect(t.ssh.script).toContain("DOMAIN='203-0-113-9.sslip.io'")
    expect(t.calls.some((c) => c.startsWith('api'))).toBe(false)
    // forgetting it never deletes anything at a provider
    await m.remove()
    expect(t.calls).toEqual(['unlink'])
  })

  it('refuses a private address, a second machine, and a Mac already linked elsewhere', async () => {
    const t = setup()
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'ssh', ssh: { host: 'tail.example.com' }, bring: BRING })
    expect((await settle(m, 'failed')).error).toMatch(/private address \(100\.101\.102\.103\)/)
    const busy = setup({ linked: 'https://other.example.com' })
    await expect(new CloudMachines(busy.deps).create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'x', bring: BRING })).rejects.toMatchObject({ code: 'conflict' })
    const two = setup({ healthAfter: Infinity })
    const m2 = new CloudMachines({ ...two.deps, sleep: () => new Promise((r) => setTimeout(r, 1)), timeouts: { pollMs: 0, installMs: 60_000 } })
    await m2.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'x', bring: BRING })
    await expect(m2.create({ provider: 'hetzner', token: PROVIDER_TOKEN, region: 'nbg1', size: 'x', bring: BRING })).rejects.toMatchObject({ code: 'conflict' })
    m2['gen']++
  })
})

/** A fake fleet (fleet/src/core.ts) whose machine pairs with the admin hash it was given. */
function managed(o: { allowed?: boolean; gh?: string | null; startPolls?: number } = {}) {
  const t = setup({ healthAfter: 1 })
  const calls: string[] = []
  let admin: string | null = null
  let fm: FleetMachine | null = null
  let polls = 0
  const KEY = 'pfk_fleet-key-0123456789abcdefghijklmnop'
  const view = (state: FleetMachine['state']): FleetMachine => ({ id: 'm_1', state, host: '3-0-0-1.sslip.io', url: 'https://3-0-0-1.sslip.io', instanceType: 't4g.large', createdAt: 'x', error: null, wakeAt: null, sleepReason: null, usage: { month: '2026-11', hours: 1.5, limitHours: 200 }, idleMinutes: 20 })
  const fleet: FleetClient = {
    async enroll(gh) {
      calls.push(`enroll ${gh}`)
      return { key: KEY, login: 'lautaro', allowed: o.allowed ?? true }
    },
    async machine(key) {
      calls.push(`machine ${key === KEY}`)
      if (fm?.state === 'starting' && ++polls > (o.startPolls ?? 1)) fm = view('running')
      return { login: 'lautaro', allowed: true, machine: fm }
    },
    async create(key, b) {
      calls.push(`create ${key === KEY} ${b.workspaceName}`)
      if (fm) throw new FleetRequestError(409, 'exists', 'You already have a cloud machine.')
      admin = b.adminTokenSha256
      fm = view('starting')
      return fm
    },
    async wake(key) {
      calls.push(`wake ${key === KEY}`)
      fm = view('starting')
      return fm
    },
    async remove(key) {
      calls.push(`remove ${key === KEY}`)
      fm = null
    }
  }
  const base = t.deps.fetch!
  t.deps.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/pair/start')) {
      const tok = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '')
      if (createHash('sha256').update(tok).digest('hex') !== admin) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({ code: 'K7QM-4XWD' }), { status: 201 })
    }
    return base(url, init)
  }) as typeof fetch
  t.deps.fleet = fleet
  t.deps.ghToken = async () => (o.gh === undefined ? 'gho_mac_signin_0123456789' : o.gh)
  return { ...t, fleet, fleetCalls: calls, KEY, setState: (s: FleetMachine['state'] | null) => (fm = s ? view(s) : null) }
}

describe('Principia Cloud, managed (docs/FLEET.md)', () => {
  it('turns on with one click: GitHub sign-in once, the fleet makes it, this Mac pairs with the hash it sent', async () => {
    const t = managed({ startPolls: 2 })
    const m = new CloudMachines(t.deps)
    expect(m.info()).toEqual({ managed: true, github: null })
    await m.create({ provider: 'principia', bring: BRING })
    const v = await settle(m, 'ready')
    expect(v).toMatchObject({ provider: 'principia', serverId: 'm_1', url: 'https://3-0-0-1.sslip.io', power: 'awake', region: null })
    expect(t.fleetCalls[0]).toBe('enroll gho_mac_signin_0123456789')
    expect(t.fleetCalls).toContain('create true studio cloud')
    expect(t.paired).toEqual([{ url: 'https://3-0-0-1.sslip.io', code: 'K7QM-4XWD' }])
    expect(m.info().github).toBe('lautaro')
    // the fleet key is on disk encrypted, never in a view; the GitHub token is nowhere
    const file = fs.readFileSync(path.join(t.userData, MACHINE_FILE), 'utf8')
    expect(file).not.toContain(t.KEY)
    expect(file).not.toContain('gho_mac_signin')
    expect(JSON.stringify(t.views)).not.toMatch(/pfk_|gho_|enc:/)
  })

  it('Turn On right after Turn Off waits for the old machine to go, then makes the new one', async () => {
    const t = managed()
    t.setState('deleting')
    const machine = t.fleet.machine.bind(t.fleet)
    let seen = 0
    t.fleet.machine = async (key) => {
      const r = await machine(key)
      // the fleet's tick removes the old record after a few looks
      if (r.machine?.state === 'deleting' && ++seen >= 3) t.setState(null)
      return r
    }
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'principia', bring: BRING })
    const v = await settle(m, 'ready')
    expect(v).toMatchObject({ serverId: 'm_1', power: 'awake' })
    expect(t.fleetCalls.filter((c) => c.startsWith('create')).length).toBe(4)
    expect(t.paired).toEqual([{ url: 'https://3-0-0-1.sslip.io', code: 'K7QM-4XWD' }])
  })

  it('needs GitHub on this Mac, and says so when the account is not let in yet', async () => {
    const a = managed({ gh: null })
    const m1 = new CloudMachines(a.deps)
    await m1.create({ provider: 'principia', bring: BRING })
    expect((await settle(m1, 'failed')).error).toMatch(/Sign in to GitHub on this Mac first/)
    const b = managed({ allowed: false })
    const m2 = new CloudMachines(b.deps)
    await m2.create({ provider: 'principia', bring: BRING })
    expect((await settle(m2, 'failed')).error).toBe('Principia Cloud isn’t open for lautaro yet.')
  })

  it('is not offered without a fleet', async () => {
    const t = setup()
    const m = new CloudMachines(t.deps)
    expect(m.info().managed).toBe(false)
    await expect(m.create({ provider: 'principia', bring: BRING })).rejects.toThrow(/isn’t available/)
  })

  it('wakes a sleeping machine for use, once for many callers, and reports its power', async () => {
    const t = managed()
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'principia', bring: BRING })
    await settle(m, 'ready')
    t.setState('sleeping')
    expect((await m.refresh())!.power).toBe('asleep')
    const [a, b] = await Promise.all([m.wakeForUse(), m.wakeForUse()])
    expect([a, b]).toEqual([true, true])
    expect(t.fleetCalls.filter((c) => c.startsWith('wake'))).toEqual(['wake true'])
    expect(m.view()!.power).toBe('awake')
    expect(m.view()!.usage).toEqual({ month: '2026-11', hours: 1.5, limitHours: 200 })
  })

  it('turn off deletes it at the fleet and disconnects this Mac', async () => {
    const t = managed()
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'principia', bring: BRING })
    await settle(m, 'ready')
    await m.remove()
    expect(t.fleetCalls).toContain('remove true')
    expect(t.calls).toContain('unlink')
    expect(m.view()).toBeNull()
  })

  it('a machine made again signs in from the saved sign-in: the note says so, no browser', async () => {
    const t = managed()
    t.deps.bring.saved = (a) => a === 'claude'
    const m = new CloudMachines(t.deps)
    await m.create({ provider: 'principia', bring: { github: false, keys: false, claude: true, codex: false } })
    await settle(m, 'ready')
    expect(t.views.find((x) => x?.phase === 'ready')!.notes).toEqual(['Claude: signing in with your saved sign-in…'])
    await new Promise((r) => setTimeout(r, 5))
    expect(t.brought).toEqual(['login claude'])
    expect(m.view()!.notes).toEqual([])
  })

  it('never wakes anything that is not a ready managed machine', async () => {
    const t = setup()
    const m = new CloudMachines(t.deps)
    expect(await m.wakeForUse()).toBe(false)
  })
})

describe('provider APIs', () => {
  const recorder = (answers: Record<string, unknown>) => {
    const seen: { method: string; url: string; auth: string; body: any }[] = []
    const f = (async (url: string, init: RequestInit) => {
      const key = `${init.method} ${String(url).replace(/\?.*$/, '')}`
      seen.push({ method: init.method!, url: String(url), auth: (init.headers as Record<string, string>).authorization, body: init.body ? JSON.parse(String(init.body)) : null })
      if (!(key in answers)) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 404 })
      const a = answers[key]
      if (a instanceof Response) return a
      return new Response(a === null ? null : JSON.stringify(a), { status: a === null ? 204 : 200 })
    }) as unknown as typeof fetch
    return { f, seen }
  }

  it('Hetzner: x86 sizes that are not deprecated, a 4/8 default, key reuse, create with user-data, delete', async () => {
    const r = recorder({
      'GET https://api.hetzner.cloud/v1/locations': { locations: [{ name: 'fsn1', city: 'Falkenstein', country: 'DE' }, { name: 'nbg1', city: 'Nuremberg', country: 'DE' }] },
      'GET https://api.hetzner.cloud/v1/server_types': {
        server_types: [
          { name: 'cx22', cores: 2, memory: 4, disk: 40, cpu_type: 'shared', architecture: 'x86', deprecation: { announced: 'x' }, prices: [{ location: 'nbg1', price_monthly: { gross: '4.5' } }] },
          { name: 'cx33', cores: 4, memory: 8, disk: 80, cpu_type: 'shared', architecture: 'x86', deprecation: null, prices: [{ location: 'nbg1', price_monthly: { gross: '6.49' } }] },
          { name: 'cpx31', cores: 4, memory: 8, disk: 160, cpu_type: 'shared', architecture: 'x86', deprecation: null, prices: [{ location: 'nbg1', price_monthly: { gross: '15.9' } }] },
          { name: 'cax21', cores: 4, memory: 8, disk: 80, cpu_type: 'shared', architecture: 'arm', deprecation: null, prices: [{ location: 'nbg1', price_monthly: { gross: '6' } }] }
        ]
      },
      'GET https://api.hetzner.cloud/v1/ssh_keys': { ssh_keys: [{ id: 5, public_key: 'ssh-ed25519 AAAAkey other-comment' }] },
      'POST https://api.hetzner.cloud/v1/servers': { server: { id: 99, status: 'initializing', public_net: { ipv4: { ip: '198.51.100.4' } } } },
      'GET https://api.hetzner.cloud/v1/servers/99': { server: { id: 99, status: 'running', public_net: { ipv4: { ip: '198.51.100.4' } } } },
      'DELETE https://api.hetzner.cloud/v1/servers/99': { action: {} }
    })
    const h = hetzner('HZTOKEN', r.f)
    const o = await h.options()
    expect(o.sizes.map((s) => s.id)).toEqual(['cx33', 'cpx31'])
    expect(o).toMatchObject({ defaultRegion: 'nbg1', defaultSize: 'cx33' })
    expect(await h.ensureSshKey('principia', 'ssh-ed25519 AAAAkey me@mac')).toBe('5')
    expect(await h.create({ name: 'principia-a1', region: 'nbg1', size: 'cx33', userData: '#!/bin/bash', sshKeyId: '5' })).toEqual({ id: '99', ip: '198.51.100.4' })
    const post = r.seen.find((s) => s.method === 'POST')!
    expect(post.body).toMatchObject({ image: 'ubuntu-24.04', user_data: '#!/bin/bash', ssh_keys: [5], location: 'nbg1', server_type: 'cx33' })
    expect(await h.status('99')).toEqual({ running: true, ip: '198.51.100.4' })
    await h.remove('99')
    await h.remove('100') // already gone is fine
    expect(await h.status('100')).toBeNull()
    expect(r.seen.every((s) => s.auth === 'Bearer HZTOKEN' && s.url.startsWith('https://api.hetzner.cloud/'))).toBe(true)
  })

  it('a rejected token reads as its fix', async () => {
    const f = (async () => new Response('{"error":{"message":"unable to authenticate"}}', { status: 401 })) as unknown as typeof fetch
    await expect(hetzner('bad', f).options()).rejects.toThrow(/rejected the API token/)
    await expect(digitalocean('bad', f).options()).rejects.toThrow(/DigitalOcean rejected/)
  })

  it('DigitalOcean: basic droplet sizes, registers a missing key, the public IPv4', async () => {
    const r = recorder({
      'GET https://api.digitalocean.com/v2/regions': { regions: [{ slug: 'nyc3', name: 'New York 3', available: true }, { slug: 'old1', name: 'Old', available: false }] },
      'GET https://api.digitalocean.com/v2/sizes': {
        sizes: [
          { slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48, available: true, regions: ['nyc3'] },
          { slug: 'g-4vcpu-16gb', memory: 16384, vcpus: 4, disk: 50, price_monthly: 126, available: true, regions: ['nyc3'] },
          { slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, available: true, regions: ['nyc3'] }
        ]
      },
      'GET https://api.digitalocean.com/v2/account/keys': { ssh_keys: [] },
      'POST https://api.digitalocean.com/v2/account/keys': { ssh_key: { id: 12 } },
      'POST https://api.digitalocean.com/v2/droplets': { droplet: { id: 7, status: 'new', networks: { v4: [] } } },
      'GET https://api.digitalocean.com/v2/droplets/7': { droplet: { id: 7, status: 'active', networks: { v4: [{ type: 'private', ip_address: '10.0.0.2' }, { type: 'public', ip_address: '192.0.2.10' }] } } }
    })
    const d = digitalocean('DOTOKEN', r.f)
    const o = await d.options()
    expect(o.regions).toEqual([{ id: 'nyc3', label: 'New York 3' }])
    expect(o.sizes.map((s) => s.id)).toEqual(['s-4vcpu-8gb', 's-2vcpu-4gb'])
    expect(o.defaultSize).toBe('s-4vcpu-8gb')
    expect(await d.ensureSshKey('principia', 'ssh-ed25519 AAAAnew me')).toBe('12')
    expect(await d.create({ name: 'p', region: 'nyc3', size: 's-4vcpu-8gb', userData: 'x', sshKeyId: '12' })).toEqual({ id: '7', ip: null })
    expect(await d.status('7')).toEqual({ running: true, ip: '192.0.2.10' })
  })

  it('pickDefaultSize falls back to 2/4 and respects the region', () => {
    const s = (id: string, cores: number, mem: number, amount: number, regions: string[] = []) => ({ id, label: id, cores, memoryGb: mem, diskGb: 40, monthly: { amount, currency: 'EUR' }, regions })
    expect(pickDefaultSize([s('a', 2, 4, 5), s('b', 8, 16, 30), s('c', 4, 8, 9, ['hel1'])], 'nbg1')?.id).toBe('b')
    expect(pickDefaultSize([s('a', 2, 4, 5), s('z', 1, 2, 3)], null)?.id).toBe('a')
  })
})

describe('the bootstrap script', () => {
  const script = bootstrapScript({ domain: '203-0-113-7.sslip.io', adminTokenSha256: 'ab'.repeat(32), image: 'ghcr.io/vibiz-ai/principia-cloud:0.4.8', sourceRef: 'v0.4.8' })

  it('holds a hash, never a token; keys only; metadata blocked; hardened container behind Caddy', () => {
    expect(script).toContain(`ADMIN_SHA256='${'ab'.repeat(32)}'`)
    expect(script).not.toMatch(/PRINCIPIA_ADMIN_TOKEN=|PRINCIPIA_MASTER_KEY/)
    expect(script).toContain('PasswordAuthentication no')
    expect(script).toContain('iptables -I DOCKER-USER -d 169.254.169.254 -j DROP')
    expect(script).toContain('no-new-privileges:true')
    expect(script).toContain('read_only: true')
    expect(script).toContain('reverse_proxy principia:8787')
    expect(script).toContain('PRINCIPIA_PUBLIC_URL=https://$DOMAIN')
    // falls back to building the same version from the public source
    expect(script).toContain('git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" src')
  })

  it('refuses values that would break out of the script', () => {
    expect(() => bootstrapScript({ domain: "x'; rm -rf / #", adminTokenSha256: 'ab'.repeat(32), image: 'i', sourceRef: 'r' })).toThrow(/Invalid domain/)
    expect(() => bootstrapScript({ domain: 'x', adminTokenSha256: 'nothex', image: 'i', sourceRef: 'r' })).toThrow(/hash/)
  })

  it('splits into prepare (the same everywhere, for a baked image) and configure (this machine, its heartbeat)', () => {
    const prep = prepareScript({ image: 'x:1', sourceRef: 'main' })
    expect(prep).not.toMatch(/ADMIN_SHA256|FLEET_TOKEN=|docker compose up/)
    expect(prep).toContain('principia-heartbeat.timer')
    const conf = configureScript({ domain: '3-0-0-1.sslip.io', adminTokenSha256: 'ab'.repeat(32), fleet: { url: 'https://fleet.example.com', machineToken: `pmt_${'x'.repeat(43)}` } })
    expect(conf).toContain('FLEET_URL=https://fleet.example.com')
    expect(conf).toContain('chmod 600 fleet.env')
    expect(conf).toContain('systemctl enable --now principia-heartbeat.timer')
    expect(configureScript({ domain: 'a.sslip.io', adminTokenSha256: 'ab'.repeat(32) })).not.toContain('fleet.env')
    expect(() => configureScript({ domain: 'a', adminTokenSha256: 'ab'.repeat(32), fleet: { url: 'http://insecure', machineToken: 'pmt_x'.repeat(10) } })).toThrow(/fleet/)
    expect(() => configureScript({ domain: 'a', adminTokenSha256: 'ab'.repeat(32), fleet: { url: 'https://f.example.com', machineToken: "x'; rm -rf /" } })).toThrow(/fleet/)
  })

  it('passes bash -n (and shellcheck when installed)', () => {
    const dir = tmp()
    const f = path.join(dir, 'boot.sh')
    fs.writeFileSync(f, script)
    execFileSync('bash', ['-n', f])
    let hasShellcheck = true
    try {
      execFileSync('shellcheck', ['--version'], { stdio: 'ignore' })
    } catch {
      hasShellcheck = false
    }
    if (hasShellcheck) execFileSync('shellcheck', ['-s', 'bash', f])
  })
})

describe('a server without systemd, and the hint to look at it', () => {
  it('starts Docker with its init script and applies the metadata rule once when systemd is not running', () => {
    const prep = prepareScript({ image: 'x:1', sourceRef: 'main' })
    expect(prep).toContain('[ -d /run/systemd/system ] || SYSTEMD=')
    expect(prep).toContain('service docker start')
    // an init script that fails (a container's ulimit) falls back to dockerd itself
    expect(prep).toContain('nohup dockerd >>/var/log/dockerd.log 2>&1 &')
    // the units are written only under systemd; the DROP rule is inserted directly otherwise
    expect(prep.indexOf('if [ -n "$SYSTEMD" ]; then\ncat > /etc/systemd/system/principia-metadata-block.service')).toBeGreaterThan(0)
  })

  it('names the user and port it connected with', () => {
    expect(lookHint({ user: 'root', port: 22 }, '203.0.113.7')).toBe('ssh root@203.0.113.7 tail -50 /var/log/principia-bootstrap.log')
    expect(lookHint({ user: 'ubuntu', port: 2222 }, '203.0.113.7')).toBe('ssh -p 2222 ubuntu@203.0.113.7 sudo tail -50 /var/log/principia-bootstrap.log')
    expect(lookHint(null, '203.0.113.7')).toContain('root@203.0.113.7')
  })
})

describe('the one-line install (cloud/install.sh, docs/MACHINES.md §7)', () => {
  const version = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../package.json'), 'utf8')) as { version: string }).version
  const text = installScript(version)

  it('is exactly what bootstrap.ts makes at the app version (npm run cloud:install-sh rewrites it)', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../../../cloud/install.sh'), 'utf8')).toBe(text)
  })

  it('reuses prepare and configure, with no admin hash, and prints the links', () => {
    expect(text).toContain(prepareScript(releaseInputs(version), { header: false, keysOnlyIfKeyed: true }).split('\n').slice(-3).join('\n'))
    expect(text).toContain(`IMAGE='ghcr.io/vibiz-ai/principia-cloud:${version}'`)
    expect(text).toMatch(/# x-release-please-start-version\nIMAGE=.*\nSOURCE_REPO=.*\nSOURCE_REF='v.*'\n# x-release-please-end/)
    expect(text).toContain("ADMIN_SHA256=''")
    expect(text).toContain('DOMAIN="${PRINCIPIA_DOMAIN:-auto}"')
    expect(text).toContain('principia-cloud pair')
    expect(text).toContain('principia-cloud phone-link')
    expect(text).toContain('qrencode -t ANSIUTF8')
    // the whole script is parsed before it runs, and nothing it runs reads the curl pipe
    expect(text.trimEnd().endsWith('principia_install "$@" </dev/null')).toBe(true)
    // password login stays on when nobody logs in with a key yet
    expect(text).toContain('if [ -n "$KEYED" ] && [ -d /etc/ssh/sshd_config.d ]; then')
    expect(() => installScript('main; rm -rf /')).toThrow(/version/)
  })

  it('configure without an admin hash writes none; with one it writes it, one-time (PRINCIPIA_ADMIN_TOKEN_ONCE)', () => {
    expect(configureScript({ domain: 'a.sslip.io', adminTokenSha256: null })).toContain("ADMIN_SHA256=''")
    const c = configureScript({ domain: 'a.sslip.io', adminTokenSha256: 'ab'.repeat(32) })
    expect(c).toContain('${ADMIN_SHA256:+PRINCIPIA_ADMIN_TOKEN_SHA256=$ADMIN_SHA256}')
    expect(c).toContain('${ADMIN_SHA256:+PRINCIPIA_ADMIN_TOKEN_ONCE=1}')
  })

  it('keeps the links out of the 0600 log, judges keys by the sudo user, and does not give up on a hiccup', () => {
    // the log exists 0600 before the first write to it, in both scripts
    for (const t of [text, bootstrapScript({ domain: 'a.sslip.io', adminTokenSha256: 'ab'.repeat(32), image: 'x:1', sourceRef: 'main' })]) expect(t.indexOf('chmod 600 /var/log/principia-bootstrap.log')).toBeLessThan(t.indexOf('exec > >(tee -a /var/log/principia-bootstrap.log)'))
    expect(text).toContain('(umask 077; touch /var/log/principia-bootstrap.log)')
    // links go to fd 3, the terminal saved before the tee
    expect(text.indexOf('exec 3>&1')).toBeLessThan(text.indexOf('exec > >(tee'))
    expect(text).toMatch(/show\(\) \{\n {2}\{[\s\S]*?\n {2}\} >&3\n\}/)
    expect(text).not.toMatch(/echo "[^"]*\$(LINK|PHONE)/)
    expect(text).toContain('KEYHOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"')
    expect(text).not.toContain('/root/.ssh/authorized_keys "')
    expect(text).toContain('case "$RC" in 0|2) break ;; esac')
    // no iptables permission (a container without NET_ADMIN) warns instead of stopping the install
    expect(text).toContain('|| echo "principia: warning: could not block the metadata service')
  })

  it('passes bash -n (and shellcheck when installed)', () => {
    const f = path.join(tmp(), 'install.sh')
    fs.writeFileSync(f, text)
    execFileSync('bash', ['-n', f])
    try {
      execFileSync('shellcheck', ['--version'], { stdio: 'ignore' })
    } catch {
      return
    }
    execFileSync('shellcheck', ['-s', 'bash', f])
  })
})

describe('helpers', () => {
  it('sslip names and private addresses', () => {
    expect(sslipHost('203.0.113.7')).toBe('203-0-113-7.sslip.io')
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.5', '100.100.1.1', '127.0.0.1', '169.254.169.254']) expect(isPrivateIpv4(ip)).toBe(true)
    for (const ip of ['203.0.113.7', '172.32.0.1', '100.128.0.1', '8.8.8.8']) expect(isPrivateIpv4(ip)).toBe(false)
  })

  it('reads the first SSH public key', () => {
    const home = tmp()
    expect(sshPublicKey(home)).toBeNull()
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa.pub'), 'ssh-rsa AAAArsa me\n')
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAed me\n')
    expect(sshPublicKey(home)).toBe('ssh-ed25519 AAAAed me')
  })
})
