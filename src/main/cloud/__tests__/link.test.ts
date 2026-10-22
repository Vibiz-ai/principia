// docs/CLOUD.md §5, §8: pairing with a connect link, encrypted persistence (0600, safeStorage), unlink, 30 s polling
// plus SSE, schedule ownership (the local scheduler never fires cloud schedules), and PassportSync on a newer revision.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudDesktopEvent, Run, Schedule } from '../../../shared/types'
import { createScheduler } from '../../engine/scheduler'
import { MemStore } from '../../engine/__tests__/fakes'
import { CloudLink, LINK_FILE, type PassportSyncPort } from '../link'
import { DEVICE_TOKEN, PAIR_CODE, fakeCipher, startFakeCloud, until, type FakeCloud } from './fakeCloud'

let cloud: FakeCloud
let dir: string
let events: CloudDesktopEvent[]
const links: CloudLink[] = []

/** pairs and lets the first poll (started by pair) finish, so tests control what the next poll sees */
const paired = async (link: CloudLink): Promise<CloudLink> => {
  await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
  await link.pollNow().catch(() => undefined)
  return link
}
const make = (p: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}): CloudLink => {
  const l = new CloudLink({ userData: dir, cipher: fakeCipher(), emit: (e) => events.push(e), host: () => ({ deviceName: 'lautaro on studio', platform: 'darwin-arm64' }), sse: false, ...p })
  links.push(l)
  return l
}

beforeEach(async () => {
  cloud = await startFakeCloud()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-link-'))
  events = []
})
afterEach(async () => {
  for (const l of links.splice(0)) l.stop()
  await cloud.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pairing', () => {
  it('pairs with the connect link, sends the device name and platform, and starts linked and online', async () => {
    const link = make()
    const s = await link.pair({ link: `  ${cloud.url}/pair#k7qm4xwd \n` })
    expect(s).toMatchObject({ linked: true, url: cloud.url, workspace: { id: 'ws_test', name: 'lautaro-cloud' }, deviceId: 'dev_mac', online: true })
    const req = cloud.requests.find((r) => r.path === '/v1/pair/complete')!
    expect(req.body).toEqual({ code: PAIR_CODE, deviceName: 'lautaro on studio', platform: 'darwin-arm64' })
    expect(events.some((e) => e.kind === 'state' && e.state.linked)).toBe(true)
  })

  it('accepts the hidden URL + code fallback', async () => {
    const s = await make().pair({ url: `${cloud.url}/`, code: 'K7QM4XWD' })
    expect(s.linked).toBe(true)
  })

  it('refuses a bad link and a wrong code with plain copy', async () => {
    await expect(make().pair({ link: 'hello' })).rejects.toThrow(/not a connect link/)
    await expect(make().pair({ link: `${cloud.url}/pair#AAAA-BBBB` })).rejects.toThrow(/wrong or expired/)
  })

  it('refuses plain http for a non-local host', async () => {
    await expect(make().pair({ link: 'http://cloud.example.com/pair#K7QM-4XWD' })).rejects.toThrow(/https/)
  })

  it('refuses to pair (and stores nothing) when safeStorage is unavailable', async () => {
    const link = make({ cipher: fakeCipher(false) })
    await expect(link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })).rejects.toMatchObject({ code: 'vault_unavailable' })
    expect(fs.existsSync(path.join(dir, LINK_FILE))).toBe(false)
    expect(cloud.requests.length).toBe(0)
  })
})

describe('encrypted persistence', () => {
  it('writes cloud-link.json 0600 with the token encrypted, and a new instance reads it back', async () => {
    await make().pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    const file = path.join(dir, LINK_FILE)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain(DEVICE_TOKEN)
    expect(JSON.parse(raw)).toMatchObject({ v: 1, url: cloud.url, deviceId: 'dev_mac', workspace: { name: 'lautaro-cloud' } })
    const again = make()
    expect(again.state()).toMatchObject({ linked: true, url: cloud.url, deviceId: 'dev_mac' })
    await again.pollNow()
    const polled = cloud.requests.filter((r) => r.path === '/v1/sync/changes').at(-1)!
    expect(polled.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
  })

  it('never puts the token in an event or the state', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    await link.pollNow()
    expect(JSON.stringify(events)).not.toContain(DEVICE_TOKEN)
    expect(JSON.stringify(link.state())).not.toContain(DEVICE_TOKEN)
  })
})

describe('unlink', () => {
  it('revokes this device and deletes the file', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    const s = await link.unlink()
    expect(cloud.requests.some((r) => r.method === 'DELETE' && r.path === '/v1/devices/dev_mac')).toBe(true)
    expect(s.linked).toBe(false)
    expect(fs.existsSync(path.join(dir, LINK_FILE))).toBe(false)
  })
  it('forgets the link even when the cloud is unreachable', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    await cloud.close()
    expect((await link.unlink()).linked).toBe(false)
    cloud = await startFakeCloud()
  })
})

describe('polling', () => {
  it('polls /v1/sync/changes with the cursor, counts open asks and emits changes', async () => {
    const link = await paired(make())
    cloud.changes = [
      { cursor: 'c1', asks: [{ id: 'cask_1', companyId: 'co_v', runId: 'crun_1', agentName: 'Marcus · Copywriter', question: 'Today or Thursday?', options: ['Today', 'Thursday'], createdAt: '', status: 'open', answer: null }] },
      { cursor: 'c2' }
    ]
    await link.pollNow()
    expect(link.state().openAsks).toBe(1)
    expect(events.some((e) => e.kind === 'changes' && e.asks === 1)).toBe(true)
    await link.pollNow()
    const sinces = cloud.requests.filter((r) => r.path === '/v1/sync/changes').map((r) => r.query.since)
    expect(sinces.at(-1)).toBe('c1')
    expect(link.state().lastSyncAt).not.toBeNull()
  })

  it('polls on its own every pollMs while linked', async () => {
    const link = make({ pollMs: 40 })
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    await until(() => cloud.requests.filter((r) => r.path === '/v1/sync/changes').length >= 3)
  })

  it('goes offline (with the time) when the cloud is down, and online again', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    await cloud.close()
    await expect(link.pollNow()).rejects.toThrow(/Can't reach your cloud/)
    expect(link.state()).toMatchObject({ online: false })
    expect(link.state().offlineSince).not.toBeNull()
    cloud = await startFakeCloud()
  })

  it('a revoked device stops polling and says so plainly', async () => {
    const link = make({ pollMs: 30 })
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    cloud.revoke()
    await expect(link.pollNow()).rejects.toThrow(/no longer connected/)
    expect(link.state().error).toMatch(/no longer connected/)
    const n = cloud.requests.length
    await new Promise((r) => setTimeout(r, 120))
    expect(cloud.requests.length).toBe(n)
  })

  it('polls at once when /v1/events reports a run or an ask', async () => {
    const link = make({ sse: true, pollMs: 60_000 })
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    await until(() => cloud.streams() === 1)
    const before = cloud.requests.filter((r) => r.path === '/v1/sync/changes').length
    cloud.push({ kind: 'ask', ask: { id: 'cask_9', companyId: 'co_v', runId: null, agentName: null, question: 'Ship?', options: [], createdAt: '', status: 'open', answer: null } })
    await until(() => cloud.requests.filter((r) => r.path === '/v1/sync/changes').length > before)
    expect(events.some((e) => e.kind === 'event' && e.event.kind === 'ask')).toBe(true)
    expect(link.state().openAsks).toBeGreaterThanOrEqual(1)
  })
})

describe('schedule ownership', () => {
  const sched = (id: string): Schedule => ({ id, name: id, target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, preset: null, enabled: true, sentence: '', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: null, createdAt: '', updatedAt: '' })

  it('the guarded scheduler store never lists cloud-placed schedules; the main store is untouched', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    const engineStore = { listSchedules: () => [sched('s_local'), sched('s_cloud')] }
    link.guardSchedules(engineStore)
    link.guardSchedules(engineStore) // idempotent
    expect(engineStore.listSchedules().map((s) => s.id)).toEqual(['s_local', 's_cloud'])
    link.setSchedulePlacement('s_cloud', 'cloud', 3)
    expect(link.ownsSchedule('s_cloud')).toBe(true)
    expect(engineStore.listSchedules().map((s) => s.id)).toEqual(['s_local'])
    expect(link.state().cloudScheduleIds).toEqual(['s_cloud'])
    expect(link.scheduleRev('s_cloud')).toBe(3)
    link.setSchedulePlacement('s_cloud', 'local')
    expect(engineStore.listSchedules().map((s) => s.id)).toEqual(['s_local', 's_cloud'])
  })

  it('ownership survives a restart and follows schedules the server moved', async () => {
    const link = await paired(make())
    link.setSchedulePlacement('s_a', 'cloud', 1)
    expect(make().ownsSchedule('s_a')).toBe(true)
    cloud.changes = [{ schedules: [{ id: 's_a', companyId: 'co', name: 'a', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, enabled: true, placement: 'local', rev: 2, nextFireAt: null, lastFireAt: null, lastRunId: null }] }]
    await link.pollNow()
    expect(link.ownsSchedule('s_a')).toBe(false)
    expect(link.scheduleRev('s_a')).toBe(2)
  })

  it('unlinking hands every schedule back to this Mac', async () => {
    const link = make()
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    link.setSchedulePlacement('s_a', 'cloud', 1)
    await link.unlink()
    expect(link.ownsSchedule('s_a')).toBe(false)
  })
})

describe('schedules back on this Mac (QA)', () => {
  const NOW = new Date('2026-10-15T10:00:30.000Z')
  const daily = (id: string): Schedule => ({ id, name: id, target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, preset: null, enabled: true, sentence: '', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: '2026-10-15T09:00:00.000Z', createdAt: '', updatedAt: '' })
  /** a real scheduler over a guarded store; `released` wired the way wire.ts wires it (scheduler.upsert) */
  const rig = (wire: boolean) => {
    const store = new MemStore()
    store.schedules.set('s_daily', daily('s_daily'))
    const started: string[] = []
    let sch: ReturnType<typeof createScheduler> | null = null
    const link = make(wire ? { released: (ids) => ids.forEach((id) => sch!.upsert(id)) } : {})
    link.guardSchedules(store)
    sch = createScheduler({ store, startRun: (_t, o) => (started.push(o.scheduleId ?? ''), { id: 'r' } as Run), isScheduleActive: () => false, emit: () => {}, log: { info: () => {}, warn: () => {} }, now: () => NOW, paused: false })
    return { store, started, link, sch }
  }

  it('without the release hook, bringing a schedule back would re-run the slot the cloud already ran (control)', async () => {
    const { link, sch, started } = rig(false)
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    link.setSchedulePlacement('s_daily', 'cloud', 1)
    sch.tick()
    expect(started).toEqual([])
    link.setSchedulePlacement('s_daily', 'local', 2)
    sch.tick()
    expect(started).toEqual(['s_daily'])
  })

  it('moving back to local recomputes the next slot: no catch-up run, no missed event', async () => {
    const { link, sch, started, store } = rig(true)
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    link.setSchedulePlacement('s_daily', 'cloud', 1)
    link.setSchedulePlacement('s_daily', 'local', 2)
    sch.tick()
    expect(started).toEqual([])
    expect(store.events).toEqual([])
    expect(store.getSchedule('s_daily')?.nextFireAt).toBe('2026-10-16T09:00:00.000Z')
  })

  it('every path that hands schedules back releases them: server says local, bring back, unlink; moving to the cloud does not', async () => {
    const released: string[][] = []
    const link = await paired(make({ released: (ids) => void released.push(ids) }))
    link.setSchedulePlacement('s_a', 'cloud', 1)
    link.setSchedulePlacement('s_b', 'cloud', 1)
    link.setSchedulePlacement('s_c', 'cloud', 1)
    link.setSchedulePlacement('s_never', 'local')
    expect(released).toEqual([])
    cloud.changes = [{ schedules: [{ id: 's_a', companyId: 'co', name: 'a', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, enabled: true, placement: 'local', rev: 2, nextFireAt: null, lastFireAt: null, lastRunId: null }] }]
    await link.pollNow()
    expect(released).toEqual([['s_a']])
    link.markCompany('co', { passportId: null, hostUrl: null })
    link.unmarkCompany('co', ['s_b', 's_unowned'])
    expect(released).toEqual([['s_a'], ['s_b']])
    await link.unlink()
    expect(released).toEqual([['s_a'], ['s_b'], ['s_c']])
  })

  it('a failing release hook never breaks the link', async () => {
    const link = await paired(make({ released: () => { throw new Error('engine down') } }))
    link.setSchedulePlacement('s_a', 'cloud', 1)
    expect(() => link.setSchedulePlacement('s_a', 'local')).not.toThrow()
    expect(link.ownsSchedule('s_a')).toBe(false)
  })

  it('a sync answer with asks but no runs list does not throw', async () => {
    // an older or partial control plane may leave out empty lists
    let partial = false
    const f: typeof fetch = async (u, init) => {
      if (partial && String(u).includes('/v1/sync/changes')) return new Response(JSON.stringify({ cursor: 'c9', asks: [{ id: 'ask_1', status: 'open' }] }), { status: 200 })
      return fetch(u, init)
    }
    const link = await paired(make({ fetch: f }))
    partial = true
    await expect(link.pollNow()).resolves.toBeUndefined()
    expect(link.state()).toMatchObject({ online: true, openAsks: 1 })
    expect(events.some((e) => e.kind === 'changes' && e.runs === 0 && e.asks === 1)).toBe(true)
  })
})

describe('PassportSync on a newer revision', () => {
  const port = (configured = true) => {
    const p: PassportSyncPort & { calls: string[] } = {
      calls: [],
      configure: vi.fn(),
      sync: vi.fn(async (cid: string) => {
        p.calls.push(cid)
        return { config: null, sync: { revision: 7 } }
      }),
      configured: () => configured
    }
    return p
  }

  it('syncs a cloud company whose passport revision moved, once per revision', async () => {
    const p = port()
    const link = await paired(make({ passport: p }))
    link.markCompany('co_v', { passportId: 'pp_co_v', hostUrl: 'http://127.0.0.1:8788' })
    cloud.changes = [{ passports: [{ companyId: 'co_v', revision: 5 }] }, { passports: [{ companyId: 'co_v', revision: 6 }] }, { passports: [{ companyId: 'co_v', revision: 9 }] }]
    await link.pollNow()
    expect(p.calls).toEqual(['co_v'])
    // revision 6 <= 7 (what the sync reached): nothing to do
    await link.pollNow()
    expect(p.calls).toEqual(['co_v'])
    await link.pollNow()
    expect(p.calls).toEqual(['co_v', 'co_v'])
  })

  it('ignores companies this Mac did not move and companies without a PassportSync host', async () => {
    const p = port(false)
    const link = await paired(make({ passport: p }))
    link.markCompany('co_v', { passportId: 'pp', hostUrl: null })
    cloud.changes = [{ passports: [{ companyId: 'co_other', revision: 3 }, { companyId: 'co_v', revision: 3 }] }]
    await link.pollNow()
    expect(p.calls).toEqual([])
  })
})

describe('connect link reachability (CLOUD.md §12.1)', () => {
  it('a 127.0.0.1 link that does not answer here says it only works on the cloud\'s own machine', async () => {
    const net = await import('node:net')
    const port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
    const link = make()
    await expect(link.pair({ link: `http://127.0.0.1:${port}/pair#${PAIR_CODE}` })).rejects.toThrow(/only works on the machine running your cloud/)
    await expect(link.pair({ url: `http://127.0.0.1:${port}`, code: PAIR_CODE })).rejects.toThrow(/ssh -L 8787:127\.0\.0\.1:8787/)
  })

  it('a link with credentials in it never logs them, and pairs with the plain origin', async () => {
    const lines: string[] = []
    const link = make({ log: { info: (m, meta) => void lines.push(`${m} ${JSON.stringify(meta)}`), warn: (m, meta) => void lines.push(`${m} ${JSON.stringify(meta)}`) } })
    const u = new URL(cloud.url)
    await link.pair({ link: `http://alice:hunter2pass@${u.host}/pair#${PAIR_CODE}` })
    expect(link.state().url).toBe(cloud.url)
    expect(lines.join('\n')).not.toMatch(/alice|hunter2pass/)
  })
})
