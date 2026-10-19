import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const d = nativeOk ? describe : describe.skip

let h: Harness
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00Z') })
})
afterEach(async () => {
  await h?.conn.stop()
  h?.db.close()
  vi.useRealTimers()
})

d('S1 connection (SLACK.md §13.2)', () => {
  it('1: connect -> hello -> connected; 1,000 envelopes all acked fast, nothing unacked', async () => {
    h = makeHarness()
    await connect(h)
    expect(h.conn.status().state).toBe('connected')
    expect(h.conn.status().workspace?.name).toBe('Acme')
    await settle(2000)
    for (let i = 0; i < 1000; i++) h.fake.post('C1', { user: 'U1', text: `msg ${i}` })
    await settle(50)
    expect(h.fake.unacked()).toEqual([])
    const n = h.sql.getMessages({ teamId: 'T1', channelId: 'C1', limit: 2000 }).length
    expect(n).toBeGreaterThanOrEqual(1000)
    // ack time: frames are delivered and acked within the same tick budget (< 50 ms each)
    expect(h.fake.acks.length).toBeGreaterThanOrEqual(1000)
  })

  it('2: duplicate delivery (same event_id, retry_attempt 1) -> one row, two acks', async () => {
    h = makeHarness()
    await connect(h)
    await settle(2000)
    const before = h.fake.acks.length
    const payload = {
      team_id: 'T1',
      api_app_id: 'A1',
      type: 'event_callback',
      event_id: 'EvDUP1',
      event_time: Math.floor(Date.now() / 1000),
      event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'dup', ts: '1792141200.000100' }
    }
    h.fake.emitRaw({ envelope_id: 'e-a', type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '', payload })
    await settle(10)
    h.fake.emitRaw({ envelope_id: 'e-b', type: 'events_api', accepts_response_payload: false, retry_attempt: 1, retry_reason: 'timeout', payload })
    await settle(10)
    expect(h.fake.acks.slice(before).map((a) => a.envelopeId)).toEqual(['e-a', 'e-b'])
    const rows = h.db.prepare("SELECT count(*) AS n FROM slack_messages WHERE ts = '1792141200.000100'").get() as { n: number }
    expect(rows.n).toBe(1)
    expect(h.inbound.filter((m) => m.ts === '1792141200.000100')).toHaveLength(1)
  })
})

const localTs = (h: Harness, ch: string) => new Set((h.db.prepare('SELECT ts FROM slack_messages WHERE channel_id = ?').all(ch) as { ts: string }[]).map((r) => r.ts))
const fakeTs = (h: Harness, ch: string) => (h.fake.messages.get(ch) ?? []).map((m) => m.ts)

d('S1 socket lifecycle (SLACK.md §4, PO-S6)', () => {
  it('3: warning / refresh_requested -> reconnect at once, never 2 sockets, zero messages lost', async () => {
    h = makeHarness()
    await connect(h)
    await settle(2000)
    for (let round = 0; round < 3; round++) {
      // apps.connections.open is Tier 1: Hive's budget is 3 per minute, so warnings are a minute apart here
      await settle(61_000)
      h.fake.post('C1', { user: 'U1', text: `before ${round}` })
      h.fake.disconnect(round % 2 ? 'refresh_requested' : 'warning')
      h.fake.post('C1', { user: 'U1', text: `during ${round}` })
      await settle(5)
      h.fake.post('C1', { user: 'U2', text: `after ${round}` })
      await settle(3000)
      expect(h.conn.status().state).toBe('connected')
    }
    await settle(15_000)
    expect(h.fake.maxOpenConnections).toBe(1)
    const local = localTs(h, 'C1')
    for (const ts of fakeTs(h, 'C1')) expect(local.has(ts)).toBe(true)
  })

  it('4: link_disabled -> error, no retries scheduled', async () => {
    h = makeHarness()
    await connect(h)
    h.fake.disconnect('link_disabled')
    await settle(200)
    const s = h.conn.status()
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/Socket Mode is turned off/)
    expect(s.nextRetryAt).toBeNull()
    const calls = h.fake.callsOf('apps.connections.open').length
    await settle(5 * 60_000)
    expect(h.fake.callsOf('apps.connections.open').length).toBe(calls)
    expect(h.fatal).toHaveLength(1)
  })

  it('5: dropSocket -> jittered backoff -> reconnect -> gap-fill fetches exactly the missed messages', async () => {
    h = makeHarness()
    await connect(h)
    await settle(5000)
    h.fake.post('C1', { user: 'U1', text: 'seen live' })
    await settle(10)
    h.fake.dropSocket()
    const missed = [h.fake.post('C1', { user: 'U1', text: 'missed 1', emit: false }), h.fake.post('C1', { user: 'U2', text: 'missed <@UBOT> 2', emit: false })]
    await settle(1)
    const s = h.conn.status()
    expect(s.state).toBe('reconnecting')
    const wait = Date.parse(s.nextRetryAt!) - Date.now()
    expect(wait).toBeGreaterThanOrEqual(0)
    expect(wait).toBeLessThanOrEqual(1000) // full jitter: random(0, min(60 s, 1 s × 2^0))
    const histBefore = h.fake.callsOf('conversations.history').length
    await settle(3000)
    expect(h.conn.status().state).toBe('connected')
    const local = localTs(h, 'C1')
    for (const ts of missed) expect(local.has(ts)).toBe(true)
    const gap = h.fake.callsOf('conversations.history').slice(histBefore)
    expect(gap.length).toBeGreaterThan(0)
    expect(gap.every((c) => c.body.inclusive === false)).toBe(true)
    const caught = h.inbound.filter((m) => missed.includes(m.ts))
    expect(caught).toHaveLength(2)
    expect(caught.every((m) => m.catchup && m.source === 'gapfill')).toBe(true)
    expect(caught.find((m) => m.plain.includes('missed'))).toBeTruthy()
    expect(caught[1].isMention).toBe(true)
  })

  it('6: half-open socket -> ping timeout -> reconnect within 40 s', async () => {
    h = makeHarness()
    await connect(h)
    await settle(1000)
    const opens = h.fake.callsOf('apps.connections.open').length
    h.fake.halfOpen()
    await settle(41_000)
    expect(h.fake.callsOf('apps.connections.open').length).toBeGreaterThan(opens)
    await settle(2000)
    expect(h.conn.status().state).toBe('connected')
  })

  it('7: sleep closes with 1000 and never retries; wake reconnects and gap-fills (catch-up only for fresh messages)', async () => {
    h = makeHarness()
    await connect(h)
    await settle(5000)
    h.conn.pause()
    expect(h.conn.status().state).toBe('paused')
    expect(h.fake.openConnections()).toBe(0)
    const opens = h.fake.callsOf('apps.connections.open').length
    const old = h.fake.post('C1', { user: 'U1', text: 'old while asleep', emit: false })
    await settle(15 * 60_000)
    expect(h.fake.callsOf('apps.connections.open').length).toBe(opens)
    const fresh = h.fake.post('C1', { user: 'U1', text: 'fresh while asleep', emit: false })
    h.conn.resume('wake')
    await settle(3000)
    expect(h.conn.status().state).toBe('connected')
    const local = localTs(h, 'C1')
    expect(local.has(old) && local.has(fresh)).toBe(true)
    expect(h.inbound.find((m) => m.ts === fresh)?.catchup).toBe(true)
    expect(h.inbound.find((m) => m.ts === old)).toBeUndefined()
  })
})
