import { describe, expect, it } from 'vitest'
import { api, reconcile, sha256 } from '../src/core'
import { world } from './fakes'

const LAUTARO = 'gho_lautaro_0123456789abcdef'
const ADMIN_SHA = 'a'.repeat(64)

async function signedIn(w: ReturnType<typeof world>, gh = LAUTARO) {
  const call = api(w.ports)
  const e = await call({ method: 'POST', path: '/v1/enroll', headers: {}, body: JSON.stringify({ githubToken: gh }) })
  const key = (e.body as { key: string }).key
  const as = (method: string, path: string, body?: unknown) => call({ method, path, headers: { authorization: `Bearer ${key}` }, body: body === undefined ? null : JSON.stringify(body) })
  return { call, enroll: e, key, as }
}

/** the machine's own heartbeat, with the token from its user-data */
function machineToken(w: ReturnType<typeof world>): string {
  return /token=(\S+)/.exec(w.compute.lastUserData)![1]!
}
async function beat(w: ReturnType<typeof world>, activity: Record<string, unknown> | null, up = true) {
  return api(w.ports)({ method: 'POST', path: '/v1/heartbeat', headers: { authorization: `Bearer ${machineToken(w)}` }, body: JSON.stringify({ up, activity, uptimeSec: 60 }) })
}
const quiet = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) => ({ at: w.ports.now().toISOString(), busy: false, running: 0, queued: 0, lastActivityAt: null, nextScheduleAt: null, ...extra })

/** create → running, as a real boot would go */
async function upAndRunning(w: ReturnType<typeof world>) {
  const s = await signedIn(w)
  const c = await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA, workspaceName: 'Lautaro’s Mac cloud' })
  expect(c.status).toBe(201)
  w.compute.settle()
  await reconcile(w.ports)
  await beat(w, quiet(w))
  return s
}

describe('enroll', () => {
  it('signs in with GitHub, never keeps the GitHub token, and rotates the key', async () => {
    const w = world()
    const a = await signedIn(w)
    expect(a.enroll.body).toMatchObject({ login: 'lautaro', allowed: true, key: expect.stringMatching(/^pfk_/) })
    expect(JSON.stringify([...w.store.users.values()])).not.toContain(LAUTARO)
    const b = await signedIn(w)
    expect((await a.as('GET', '/v1/machine')).status).toBe(401)
    expect((await b.as('GET', '/v1/machine')).body).toMatchObject({ login: 'lautaro', allowed: true, machine: null })
  })

  it('lets in allowed logins and org members, and no one else', async () => {
    const w = world()
    expect((await signedIn(w, 'gho_friend_0123456789abcdefg')).enroll.body).toMatchObject({ allowed: true })
    const s = await signedIn(w, 'gho_stranger_0123456789abcde')
    expect(s.enroll.body).toMatchObject({ allowed: false })
    expect((await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).status).toBe(403)
    expect((await api(w.ports)({ method: 'POST', path: '/v1/enroll', headers: {}, body: JSON.stringify({ githubToken: 'gho_not_a_real_token_000000' }) })).status).toBe(401)
  })
})

describe('create', () => {
  it('allocates a fixed address, launches with only hashes and a report-only token, and runs once the machine is up', async () => {
    const w = world()
    const s = await signedIn(w)
    const c = await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA, workspaceName: 'x' })
    expect(c.body).toMatchObject({ state: 'starting', host: '3-0-0-1.sslip.io', url: 'https://3-0-0-1.sslip.io', instanceType: 't4g.large' })
    expect(w.compute.lastUserData).toContain(`admin=${ADMIN_SHA}`)
    expect(w.compute.lastUserData).toContain('host=3-0-0-1.sslip.io')
    // only the token's hash is stored
    const m = [...w.store.machines.values()][0]!
    expect(m.machineTokenHash).toBe(sha256(machineToken(w)))
    expect(JSON.stringify(m)).not.toContain(machineToken(w))

    w.compute.settle()
    await reconcile(w.ports)
    expect(w.compute.calls).toContain('associate eipalloc-1 i-2')
    expect((await beat(w, quiet(w))).status).toBe(200)
    expect((await s.as('GET', '/v1/machine')).body).toMatchObject({ machine: { state: 'running' } })
    // one per person
    expect((await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).status).toBe(409)
  })

  it('falls back to the next instance type when AWS has no room', async () => {
    const w = world()
    w.compute.noRoom.add('t4g.large')
    const s = await signedIn(w)
    expect((await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).body).toMatchObject({ instanceType: 'm7g.large' })
  })

  it('says so when no type has room, and the failed machine is rebuilt in place on the next try', async () => {
    const w = world()
    w.compute.noRoom.add('t4g.large').add('m7g.large')
    const s = await signedIn(w)
    const c = await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    expect(c).toMatchObject({ status: 503, body: { error: 'no_capacity' } })
    expect((await s.as('GET', '/v1/machine')).body).toMatchObject({ machine: { state: 'failed', host: '3-0-0-1.sslip.io' } })
    w.compute.noRoom.clear()
    const again = await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    expect(again.body).toMatchObject({ state: 'starting', host: '3-0-0-1.sslip.io' })
    expect(w.compute.calls.filter((c) => c.startsWith('allocate'))).toHaveLength(1)
  })

  it('stops at the fleet-wide cap', async () => {
    const w = world({ maxMachines: 1, open: true })
    await (await signedIn(w)).as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    const r = await (await signedIn(w, 'gho_friend_0123456789abcdefg')).as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    expect(r).toMatchObject({ status: 503, body: { error: 'full' } })
  })

  it('concurrent creates can never pass the fleet-wide cap together', async () => {
    const w = world({ maxMachines: 1, open: true })
    const [a, b] = [await signedIn(w), await signedIn(w, 'gho_friend_0123456789abcdefg')]
    const rs = await Promise.all([a.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA }), b.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })])
    expect(rs.map((r) => r.status).sort()).toEqual([201, 503])
    expect(w.store.machines.size).toBe(1)
    expect(w.store.count).toBe(1)
  })

  it('a deleted machine gives its slot back', async () => {
    const w = world({ maxMachines: 1, open: true })
    const s = await upAndRunning(w)
    await s.as('DELETE', '/v1/machine')
    await reconcile(w.ports)
    expect(w.store.count).toBe(0)
    expect((await (await signedIn(w, 'gho_friend_0123456789abcdefg')).as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).status).toBe(201)
  })
})

describe('updates (docs/FLEET.md §10)', () => {
  it('a heartbeat is answered with the image every machine should run, when one is set', async () => {
    const w = world()
    await upAndRunning(w)
    expect((await beat(w, quiet(w))).body).toEqual({ ok: true })
    w.ports.cloudImage = async () => 'ghcr.io/vibiz-ai/principia-cloud:0.4.11'
    expect((await beat(w, quiet(w))).body).toEqual({ ok: true, image: 'ghcr.io/vibiz-ai/principia-cloud:0.4.11' })
    // a broken parameter never breaks the heartbeat
    w.ports.cloudImage = async () => { throw new Error('ssm down') }
    expect((await beat(w, quiet(w))).body).toEqual({ ok: true })
  })
})

describe('sleep and wake', () => {
  it('stops after the idle time, never while busy, and wakes when asked', async () => {
    const w = world()
    const s = await upAndRunning(w)
    w.advance(10)
    await beat(w, quiet(w))
    expect((await reconcile(w.ports)).stopped).toEqual([])
    // busy for an hour: stays up
    w.advance(15)
    await beat(w, quiet(w, { busy: true, running: 1 }))
    w.advance(60)
    await beat(w, quiet(w, { busy: true, running: 1, lastActivityAt: new Date(w.ports.now().getTime() - 70 * 60_000).toISOString() }))
    expect((await reconcile(w.ports)).stopped).toEqual([])
    // done, and quiet for 21 minutes: stops
    await beat(w, quiet(w, { lastActivityAt: w.ports.now().toISOString() }))
    w.advance(21)
    await beat(w, quiet(w, { lastActivityAt: new Date(w.ports.now().getTime() - 21 * 60_000).toISOString() }))
    expect((await reconcile(w.ports)).stopped).toHaveLength(1)
    w.compute.settle()
    await reconcile(w.ports)
    expect((await s.as('GET', '/v1/machine')).body).toMatchObject({ machine: { state: 'sleeping', sleepReason: 'idle' } })

    const wk = await s.as('POST', '/v1/machine/wake')
    expect(wk).toMatchObject({ status: 202, body: { state: 'starting' } })
    w.compute.settle()
    await beat(w, quiet(w))
    expect((await s.as('GET', '/v1/machine')).body).toMatchObject({ machine: { state: 'running' } })
  })

  it('wakes a little before the next cloud schedule', async () => {
    const w = world()
    await upAndRunning(w)
    w.advance(25)
    await beat(w, quiet(w, { nextScheduleAt: '2026-11-14T14:00:00.000Z' }))
    await reconcile(w.ports)
    w.compute.settle()
    await reconcile(w.ports)
    const m = [...w.store.machines.values()][0]!
    expect(m).toMatchObject({ state: 'sleeping', wakeAt: '2026-11-14T13:57:00.000Z' })
    w.clock.t = new Date('2026-11-14T13:56:00.000Z')
    expect((await reconcile(w.ports)).woken).toEqual([])
    w.clock.t = new Date('2026-11-14T13:57:30.000Z')
    expect((await reconcile(w.ports)).woken).toEqual([m.id])
  })

  it('a wake while it is stopping starts it as soon as it stopped', async () => {
    const w = world()
    const s = await upAndRunning(w)
    w.advance(25)
    await beat(w, quiet(w))
    await reconcile(w.ports)
    expect((await s.as('POST', '/v1/machine/wake')).status).toBe(202)
    w.compute.settle()
    expect((await reconcile(w.ports)).woken).toHaveLength(1)
  })

  it('moves a stopped machine to another type when its zone is full', async () => {
    const w = world()
    const s = await upAndRunning(w)
    w.advance(25)
    await beat(w, quiet(w))
    await reconcile(w.ports)
    w.compute.settle()
    await reconcile(w.ports)
    w.compute.noRoom.add('t4g.large')
    expect((await s.as('POST', '/v1/machine/wake')).body).toMatchObject({ state: 'starting', instanceType: 'm7g.large' })
  })

  it('stops a machine whose heartbeat went quiet, and one that never came up (with the last step it reached)', async () => {
    const w = world()
    await upAndRunning(w)
    w.advance(16)
    expect((await reconcile(w.ports)).stopped).toHaveLength(1)
    expect([...w.store.machines.values()][0]).toMatchObject({ sleepReason: 'no heartbeat' })

    const w2 = world()
    const s2 = await signedIn(w2)
    await s2.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    w2.compute.settle()
    w2.compute.console = 'cloud-init: x\nprincipia: prepare\nprincipia: configure\nFLEET_TOKEN=pmt_secret'
    w2.advance(31)
    expect((await reconcile(w2.ports)).failed).toHaveLength(1)
    const m = [...w2.store.machines.values()][0]!
    expect(m.state).toBe('failed')
    expect(m.error).toContain('principia: configure')
    expect(w2.compute.instances.get(m.instanceId!)!.state).toBe('stopping')
  })
})

describe('the phone wakes the machine (docs/CLOUD-PHONE.md)', () => {
  it('gets a wake-only token from the Mac, wakes a sleeping machine with it, and learns nothing else', async () => {
    const w = world()
    const s = await upAndRunning(w)
    const t = await s.as('POST', '/v1/phone-wake')
    expect(t.status).toBe(201)
    const { url, token } = t.body as { url: string; token: string }
    expect(url).toMatch(/\/v1\/phone\/wake$/)
    expect(token).toMatch(/^pfw_\d+\./)
    expect(JSON.stringify([...w.store.users.values()])).not.toContain(token)
    const phone = (method: string, tok = token) => api(w.ports)({ method, path: '/v1/phone/wake', headers: { authorization: `Bearer ${tok}` }, body: null })
    expect((await phone('GET')).body).toEqual({ state: 'running', up: true })
    // asleep: the phone wakes it
    await s.as('POST', '/v1/machine/wake')
    w.advance(25)
    await beat(w, quiet(w, { lastActivityAt: new Date(w.ports.now().getTime() - 25 * 60_000).toISOString() }))
    await reconcile(w.ports)
    w.compute.settle()
    await reconcile(w.ports)
    expect((await phone('GET')).body).toEqual({ state: 'sleeping', up: false })
    expect(await phone('POST')).toMatchObject({ status: 202, body: { state: 'starting', up: false } })
    w.compute.settle()
    await beat(w, quiet(w))
    expect((await phone('GET')).body).toEqual({ state: 'running', up: true })
    // it can do nothing else: not the Mac's routes, and a new token replaces it
    expect((await api(w.ports)({ method: 'GET', path: '/v1/machine', headers: { authorization: `Bearer ${token}` }, body: null })).status).toBe(401)
    await s.as('POST', '/v1/phone-wake')
    expect((await phone('GET')).status).toBe(401)
    expect((await phone('GET', 'pfw_1.' + 'x'.repeat(40))).status).toBe(401)
  })
})

describe('money', () => {
  it('counts awake hours per month, stops at the limit and refuses a wake until next month', async () => {
    const w = world({ maxHoursPerMonth: 1 })
    const s = await upAndRunning(w)
    for (let i = 0; i < 13; i++) {
      w.advance(5)
      await beat(w, quiet(w, { busy: true }))
      await reconcile(w.ports)
    }
    const m = [...w.store.machines.values()][0]!
    expect(m.sleepReason).toBe('limit')
    expect(m.awakeSeconds).toBeGreaterThanOrEqual(3600)
    w.compute.settle()
    await reconcile(w.ports)
    expect(await s.as('POST', '/v1/machine/wake')).toMatchObject({ status: 429, body: { error: 'limit' } })
    w.clock.t = new Date('2026-12-01T00:10:00.000Z')
    expect((await s.as('POST', '/v1/machine/wake')).status).toBe(202)
  })

  it('deleting the machine and making a new one does not reset the month', async () => {
    const w = world({ maxHoursPerMonth: 1 })
    const s = await upAndRunning(w)
    for (let i = 0; i < 13; i++) {
      w.advance(5)
      await beat(w, quiet(w, { busy: true }))
      await reconcile(w.ports)
    }
    w.compute.settle()
    await reconcile(w.ports)
    expect((await s.as('DELETE', '/v1/machine')).status).toBe(202)
    await reconcile(w.ports)
    await reconcile(w.ports)
    expect(w.store.machines.size).toBe(0)
    expect(await s.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).toMatchObject({ status: 429, body: { error: 'limit' } })
    // signing in again keeps it too
    const again = await signedIn(w)
    expect((await again.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })).status).toBe(429)
    // a new month starts from zero
    w.clock.t = new Date('2026-12-01T00:10:00.000Z')
    const c = await again.as('POST', '/v1/machine', { adminTokenSha256: ADMIN_SHA })
    expect(c.status).toBe(201)
    expect(c.body).toMatchObject({ usage: { hours: 0 } })
  })

  it('never bills a gap the reconciler didn’t see', async () => {
    const w = world()
    await upAndRunning(w)
    w.advance(120)
    await beat(w, quiet(w, { busy: true }))
    await reconcile(w.ports)
    expect([...w.store.machines.values()][0]!.awakeSeconds).toBeLessThanOrEqual(5 * 60 + 60)
  })

  it('terminates orphan instances and releases orphan addresses once they are old enough', async () => {
    const w = world()
    w.compute.instances.set('i-stray', { instanceId: 'i-stray', state: 'running', publicIp: null, instanceType: 't4g.large', machineId: 'm_gone', launchedAt: w.ports.now().toISOString() })
    w.compute.addresses.set('eipalloc-stray', { allocationId: 'eipalloc-stray', ip: '3.3.3.3', machineId: 'm_gone', instanceId: null, createdAt: w.ports.now().toISOString() })
    expect((await reconcile(w.ports)).orphans).toEqual([])
    w.advance(16)
    expect((await reconcile(w.ports)).orphans).toEqual(['i-stray', 'eipalloc-stray'])
  })

  it('a failed machine is stopped, never left running', async () => {
    const w = world()
    const s = await upAndRunning(w)
    const m = [...w.store.machines.values()][0]!
    await w.store.putMachine({ ...m, state: 'failed', rev: m.rev + 1 }, m.rev)
    w.compute.instances.get(m.instanceId!)!.state = 'running'
    await reconcile(w.ports)
    expect(w.compute.instances.get(m.instanceId!)!.state).toBe('stopping')
    void s
  })
})

describe('delete', () => {
  it('terminates, then releases the address and forgets the machine', async () => {
    const w = world()
    const s = await upAndRunning(w)
    expect((await s.as('DELETE', '/v1/machine')).status).toBe(202)
    expect(w.compute.calls).toContain('terminate i-2')
    await reconcile(w.ports)
    expect(w.compute.calls).toContain('release eipalloc-1')
    expect(w.store.machines.size).toBe(0)
    expect((await s.as('GET', '/v1/machine')).body).toMatchObject({ machine: null })
    // a deleted machine's token reports nothing
    expect((await beat(w, quiet(w))).status).toBe(401)
  })
})
