// docs/CLOUD.md §6: the typed client (routes, Bearer, CloudError -> HiveError) and the SSE reader (reconnect, backoff).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CloudClient, CloudRequestError, sseParser, toCloudError } from '../client'
import { DEVICE_TOKEN, PAIR_CODE, startFakeCloud, until, type FakeCloud } from './fakeCloud'

let cloud: FakeCloud
beforeEach(async () => {
  cloud = await startFakeCloud()
  await new CloudClient({ url: cloud.url }).call('pairComplete', { body: { code: PAIR_CODE, deviceName: 'x', platform: 'y' } })
})
afterEach(() => cloud.close())

describe('CloudClient.call', () => {
  it('builds the route path with encoded params and query, and sends the Bearer token', async () => {
    const c = new CloudClient({ url: `${cloud.url}/`, token: DEVICE_TOKEN })
    expect(c.path('runLog', { id: 'crun 1' }, { step: 's', tail: 20, none: undefined })).toBe('/v1/runs/crun%201/log?step=s&tail=20')
    await c.call('syncChanges', { query: { since: 'c9' } })
    const r = cloud.requests.at(-1)!
    expect(r.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
    expect(r.query.since).toBe('c9')
  })
  it('maps a CloudError to a HiveError code, keeping the rev of a 409', async () => {
    const c = new CloudClient({ url: cloud.url, token: DEVICE_TOKEN })
    await c.call('companyPut', { params: { cid: 'co_a' }, body: { name: 'A', slug: 'a', passportBundle: 'UEs=' } })
    await c.call('workflowPut', { params: { cid: 'co_a', wid: 'wf' }, body: { file: { workflow: { name: 'W' } }, baseRev: null } })
    const e = await c.call('workflowPut', { params: { cid: 'co_a', wid: 'wf' }, body: { file: { workflow: { name: 'W' } }, baseRev: null } }).catch((x: unknown) => x as CloudRequestError)
    expect(e).toBeInstanceOf(CloudRequestError)
    expect(e).toMatchObject({ code: 'conflict', cloudCode: 'conflict', status: 409, rev: 1 })
  })
  it('a wrong token is unauthorized, in plain copy', async () => {
    const e = await new CloudClient({ url: cloud.url, token: 'pdt_nope' }).call('summary').then(() => null as unknown as CloudRequestError, (x: unknown) => x as CloudRequestError)
    expect(e).toMatchObject({ code: 'forbidden', cloudCode: 'unauthorized' })
    expect(e.message).toMatch(/no longer connected/)
  })
  it('an unreachable cloud says so, and names the URL but no token', async () => {
    const e = await new CloudClient({ url: 'http://127.0.0.1:1', token: DEVICE_TOKEN }).call('summary').then(() => null as unknown as CloudRequestError, (x: unknown) => x as CloudRequestError)
    expect(e).toMatchObject({ cloudCode: 'network' })
    expect(e.message).toContain('127.0.0.1:1')
    expect(e.message).not.toContain(DEVICE_TOKEN)
  })
  it('not_in_v1 maps to not_implemented', () => {
    expect(toCloudError(501, { error: 'not_in_v1', message: 'x' })).toMatchObject({ code: 'not_implemented' })
    expect(toCloudError(500, null)).toMatchObject({ code: 'internal' })
  })
})

describe('SSE', () => {
  it('parses events across chunk boundaries, ignoring comments', () => {
    const got: { event: string | null; data: string }[] = []
    const feed = sseParser((m) => got.push(m))
    feed(': heartbeat\n\nevent: run\nda')
    feed('ta: {"a":1}\r\n\r\ndata: x\ndata: y\n\n')
    expect(got).toEqual([{ event: 'run', data: '{"a":1}' }, { event: null, data: 'x\ny' }])
  })
  it('delivers events and reconnects with backoff after the stream drops', async () => {
    const c = new CloudClient({ url: cloud.url, token: DEVICE_TOKEN })
    const kinds: string[] = []
    let opens = 0
    const s = c.events((e) => kinds.push(e.kind), { onOpen: () => opens++, minBackoffMs: 20, maxBackoffMs: 40 })
    await until(() => cloud.streams() === 1)
    cloud.push({ kind: 'workspace', workspace: { id: 'ws', name: 'w', createdAt: '', paused: true, quotas: {} as never, publicUrl: '', mode: 'self-host' } })
    await until(() => kinds.includes('workspace'))
    // drop every stream: the client comes back
    cloud.dropStreams()
    await until(() => opens >= 2 && cloud.streams() === 1)
    s.close()
  })
  it('stops for good on 401 (a revoked device never comes back by retrying)', async () => {
    const c = new CloudClient({ url: cloud.url, token: 'pdt_wrong' })
    let errors = 0
    const s = c.events(() => {}, { onError: () => errors++, minBackoffMs: 10 })
    await until(() => errors === 1)
    await new Promise((r) => setTimeout(r, 80))
    expect(errors).toBe(1)
    s.close()
  })
})
