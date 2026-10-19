import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUDGETS } from '../core/limiter'
import { FakeSlack, globalClock, type FakeChannel, type FakeMessage } from '../testing/fakeSlack'
import { CHANNELS, USERS, connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const d = nativeOk ? describe : describe.skip
const NOW = new Date('2026-10-16T09:00:00Z').getTime()
let h: Harness
let h2: Harness | null = null
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(async () => {
  await h2?.conn.stop()
  await h?.conn.stop()
  h?.db.close()
  h2 = null
  vi.useRealTimers()
})

/** Max calls of `method` in any 60 s window. */
function maxPerMinute(fake: FakeSlack, method: string, from = 0, to = Infinity): number {
  const at = fake.callsOf(method).map((c) => c.at).filter((t) => t >= from && t < to)
  let best = 0
  for (let i = 0; i < at.length; i++) {
    let n = 0
    for (let k = i; k < at.length && at[k] - at[i] < 60_000; k++) n++
    best = Math.max(best, n)
  }
  return best
}

function bigWorkspace(): FakeSlack {
  const channels: FakeChannel[] = []
  const messages: Record<string, FakeMessage[]> = {}
  for (let i = 0; i < 30; i++) channels.push({ id: `C${100 + i}`, name: `ch-${i}`, kind: 'channel', members: ['UBOT', 'U1'] })
  // 450 messages per channel over the last 6 days, ascending ts, 100 threads overall
  let t = NOW - 6 * 86400_000
  const step = Math.floor((6 * 86400_000 - 3600_000) / (30 * 450))
  let threads = 0
  const fake = new FakeSlack({ clock: globalClock, users: USERS, channels, enforceTiers: true })
  for (let k = 0; k < 450; k++) {
    for (let i = 0; i < 30; i++) {
      t += step
      const cid = `C${100 + i}`
      const list = (messages[cid] ??= [])
      list.push({ ts: fake.nextTs(t), user: 'U1', text: `m${k} in ${cid}` })
    }
  }
  for (let i = 0; i < 30 && threads < 100; i++) {
    const cid = `C${100 + i}`
    for (let k = 400; k < 450 && threads < 100; k += 12) {
      const parent = messages[cid][k]
      t += 1
      messages[cid].push({ ts: fake.nextTs(t), user: 'U2', text: `reply to ${parent.ts}`, thread_ts: parent.ts })
      threads++
    }
  }
  return new FakeSlack({ clock: globalClock, users: USERS, channels, messages, enforceTiers: true })
}

d('sync (SLACK.md §5, §6)', () => {
  it('8: backfill 30 channels × 450 + 100 threads within budget; a restart resumes from the persisted cursor', async () => {
    const fake = bigWorkspace()
    h = makeHarness({ fake })
    await connect(h)
    await settle(90_000)
    const done1 = (h.db.prepare("SELECT count(*) AS n FROM slack_sync_state WHERE backfill_status = 'done'").get() as { n: number }).n
    expect(done1).toBeGreaterThan(0)
    expect(done1).toBeLessThan(30)
    // kill mid-way: a new connector on the same store
    await h.conn.stop()
    const killAt = Date.now()
    await settle(1000) // the process is gone: its in-flight page lands (or is lost) before the next start
    const callsAtKill = fake.callsOf('conversations.history').map((c) => `${c.body.channel}|${c.body.cursor ?? ''}`)
    h2 = makeHarness({ db: h.db, fake })
    await h2.conn.start()
    await settle(10 * 60_000)
    const states = h.db.prepare('SELECT backfill_status AS s FROM slack_sync_state').all() as { s: string }[]
    expect(states.filter((x) => x.s === 'done').length).toBe(30)
    const n = (h.db.prepare('SELECT count(*) AS n FROM slack_messages').get() as { n: number }).n
    expect(n).toBe(30 * 450 + 100)
    const parents = (h.db.prepare('SELECT count(*) AS n FROM slack_messages WHERE reply_count > 0').get() as { n: number }).n
    expect(parents).toBe(100)
    // no page fetched twice
    const all = fake.callsOf('conversations.history').map((c) => `${c.body.channel}|${c.body.cursor ?? ''}`)
    expect(new Set(all).size).toBe(all.length)
    expect(all.slice(0, callsAtKill.length)).toEqual(callsAtKill)
    // each process stays within Hive's budget (a fresh process starts a fresh window)
    for (const m of ['conversations.history', 'conversations.replies', 'conversations.list', 'users.list']) {
      expect(maxPerMinute(fake, m, 0, killAt)).toBeLessThanOrEqual(BUDGETS[m])
      expect(maxPerMinute(fake, m, killAt)).toBeLessThanOrEqual(BUDGETS[m])
    }
    expect(fake.calls.filter((c) => c.status === 429)).toHaveLength(0)
    // backfilled messages never trigger
    expect(h.inbound.length + h2.inbound.length).toBe(0)
  }, 30_000)

  it('9: 429 with Retry-After 7 -> no call to that method for 7 s; other methods continue', async () => {
    h = makeHarness()
    await connect(h)
    await settle(5000)
    h.fake.rateLimit('conversations.history', 7, 1)
    const t0 = Date.now()
    const p = h.conn.sync.fetchLatest('C1')
    const q = h.conn.permalink('C1', '1792141200.000100')
    await settle(100)
    const hist = h.fake.callsOf('conversations.history').filter((c) => c.at >= t0)
    expect(hist).toHaveLength(1) // the 429
    await q
    expect(h.fake.callsOf('chat.getPermalink').filter((c) => c.at >= t0).length).toBe(1)
    expect(h.conn.status().warnings.join(' ')).toMatch(/slow down/)
    await settle(6800)
    expect(h.fake.callsOf('conversations.history').filter((c) => c.at >= t0)).toHaveLength(1)
    await settle(400)
    await p
    const after = h.fake.callsOf('conversations.history').filter((c) => c.at >= t0)
    expect(after).toHaveLength(2)
    expect(after[1].at - after[0].at).toBeGreaterThanOrEqual(7000)
  })

  it('10: ingest throws -> ack still sent fast; the message comes back through gap-fill', async () => {
    h = makeHarness()
    await connect(h)
    await settle(5000)
    h.fake.post('C1', { user: 'U1', text: 'anchor' })
    await settle(10)
    h.conn.injectIngestFault(() => {
      throw new Error('disk full')
    })
    const ackBefore = h.fake.acks.length
    const lost = h.fake.post('C1', { user: 'U1', text: 'lost to a fault' })
    await settle(10)
    expect(h.fake.acks.length).toBe(ackBefore + 1)
    expect(h.fake.unacked()).toEqual([])
    h.conn.injectIngestFault(null)
    const has = () => !!h.db.prepare('SELECT 1 FROM slack_messages WHERE ts = ?').get(lost)
    expect(has()).toBe(false)
    h.fake.dropSocket()
    await settle(3000)
    expect(has()).toBe(true)
  })

  it('channels: public channels the bot is not in are listed (Join), private ones are not; Join and Join all', async () => {
    h = makeHarness()
    await connect(h)
    await settle(5000)
    const list = h.sql.listChannels('T1')
    expect(list.find((c) => c.id === 'C3')?.isMember).toBe(false)
    expect(list.find((c) => c.id === 'D1')?.name).toBe('Dana Lee')
    const joined = await h.conn.join('C3')
    expect(joined?.isMember).toBe(true)
    expect(h.fake.channels.get('C3')!.members).toContain('UBOT')
    const r = await h.conn.joinAll()
    expect(r.joined).toBe(0)
    void CHANNELS
  })
})
