/**
 * Review fixes (Slack v1): no blind re-post of chat.postMessage, failed ingest recovered without a reconnect, reply
 * counts after a deleted reply, durable inbound dedupe, members-only trigger gate, durable notify rate guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoModeProblem, slackAuthorKind, slackAuthorProblem, slackWhoCanTrigger, type SlackInboundMessage } from '../../../../shared/slack'
import { NotifyNode, RATE_NOTE, type SlackAlertPort } from '../../../notifyNode'
import { normalizeTrigger, triggerSentence } from '../triggerConfig'
import { SlackTriggerStore } from '../triggerStore'
import { CHANNELS, USERS, connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const d = nativeOk ? describe : describe.skip
let h: Harness | undefined
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00Z') })
})
afterEach(async () => {
  await h?.conn.stop()
  h?.db.close()
  h = undefined
  vi.useRealTimers()
})

const people = [
  ...USERS,
  { id: 'UGUEST', name: 'gina', real_name: 'Gina Guest', is_restricted: true },
  { id: 'USINGLE', name: 'sol', real_name: 'Sol Single', is_ultra_restricted: true },
  { id: 'UEXT', name: 'xavi', real_name: 'Xavi External', team_id: 'T9' },
  { id: 'UGONE', name: 'gone', real_name: 'Gone User', deleted: true }
]

async function up(): Promise<Harness> {
  h = makeHarness({ users: people, channels: CHANNELS!.map((c) => (c.id === 'C1' ? { ...c, members: [...c.members, 'UGUEST', 'USINGLE', 'UEXT', 'UGONE'] } : c)) })
  await connect(h)
  await settle(5000)
  return h
}
const draftSend = async (x: Harness, text: string) => {
  const C1 = x.sql.getChannel('T1', 'C1')!
  const r = await x.conn.draftReply({ caller: { kind: 'session', sessionId: 's_1' }, channel: C1, threadTs: null, text, ownerLabel: 'me', agentId: null })
  const p = x.conn.drafts.decide((r as { draftId: string }).draftId, 'send')
  await settle(30_000)
  return p
}

d('chat.postMessage is never re-posted blindly', () => {
  it('Slack posted but the answer was lost (network) -> one message, row sent from history', async () => {
    const x = await up()
    x.fake.failAfterAccept('chat.postMessage', 'network')
    const before = x.fake.posted.length
    const out = await draftSend(x, 'answer once')
    expect(out.status).toBe('sent')
    expect(x.fake.posted.length).toBe(before + 1)
    expect(x.fake.callsOf('chat.postMessage')).toHaveLength(1)
    const row = x.db.prepare("SELECT status, attempts, ts FROM slack_outbox WHERE text = 'answer once'").get() as { status: string; attempts: number; ts: string }
    expect(row).toMatchObject({ status: 'sent', attempts: 1 })
    expect(row.ts).toBe(x.fake.posted[x.fake.posted.length - 1].ts)
  })

  it('a 5xx Slack did not act on -> history shows nothing -> sent again, once', async () => {
    const x = await up()
    x.fake.failNext('chat.postMessage', '5xx')
    const before = x.fake.posted.length
    const out = await draftSend(x, 'second try')
    expect(out.status).toBe('sent')
    expect(x.fake.posted.length).toBe(before + 1)
    expect(x.fake.callsOf('chat.postMessage')).toHaveLength(2)
  })

  it('the history lookup fails too -> failed "could not confirm", never re-sent; Retry looks first', async () => {
    const x = await up()
    x.fake.failAfterAccept('chat.postMessage', '5xx')
    x.fake.failNext('conversations.history', 'network', 4)
    const before = x.fake.posted.length
    const out = await draftSend(x, 'maybe posted')
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/could not confirm/)
    expect(x.fake.posted.length).toBe(before + 1)
    const row = x.db.prepare("SELECT id FROM slack_outbox WHERE text = 'maybe posted'").get() as { id: string }
    const p = x.conn.outbox.retry(row.id)
    await settle(1000)
    expect((await p).status).toBe('sent')
    expect(x.fake.posted.length).toBe(before + 1)
  })
})

d('a failed ingest is recovered without waiting for a reconnect', () => {
  it('released event id, local re-ingest after 1 s, inbound emitted once', async () => {
    const x = await up()
    let faults = 1
    x.conn.injectIngestFault(() => {
      if (faults-- > 0) throw new Error('database is locked')
    })
    const ts = x.fake.post('C1', { user: 'U1', text: 'help please' })
    await settle(10)
    const has = () => !!x.db.prepare('SELECT 1 FROM slack_messages WHERE ts = ?').get(ts)
    expect(has()).toBe(false)
    expect(x.fake.unacked()).toEqual([])
    await settle(1500)
    expect(has()).toBe(true)
    expect(x.inbound.filter((m) => m.ts === ts)).toHaveLength(1)
  })

  it('every local retry fails -> the message is fetched from Slack as a catch-up', async () => {
    const x = await up()
    x.conn.injectIngestFault(() => {
      throw new Error('broken')
    })
    const ts = x.fake.post('C1', { user: 'U1', text: '<@UBOT> are you there' })
    // the three local re-ingests (1 s, 5 s, 30 s) all fail; then Hive fetches the message from Slack
    await settle(40_000)
    x.conn.injectIngestFault(null)
    await settle(100)
    expect(x.db.prepare('SELECT source FROM slack_messages WHERE ts = ?').get(ts)).toEqual({ source: 'gapfill' })
    const m = x.inbound.filter((i) => i.ts === ts)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ source: 'gapfill', catchup: true, isMention: true })
  })
})

d('reply counts follow deletes', () => {
  it('deleting one of three replies -> parent shows 2, and Slack’s number wins on refetch', async () => {
    const x = await up()
    const parent = x.fake.post('C1', { user: 'U1', text: 'thread' })
    const r = [1, 2, 3].map((i) => x.fake.post('C1', { user: 'U2', text: `reply ${i}`, thread_ts: parent }))
    await settle(200)
    expect(x.sql.getMessage('T1', 'C1', parent)!.replyCount).toBe(3)
    x.fake.delete('C1', r[2])
    await settle(500)
    const p = x.sql.getMessage('T1', 'C1', parent)!
    expect(p.replyCount).toBe(2)
    expect(p.latestReply).toBe(r[1])
    // a second delete event for the same ts does not decrement again
    x.fake.deliver({ type: 'message', subtype: 'message_deleted', channel: 'C1', channel_type: 'channel', hidden: true, deleted_ts: r[2], ts: x.fake.nextTs() })
    await settle(500)
    expect(x.sql.getMessage('T1', 'C1', parent)!.replyCount).toBe(2)
    // the timeline page (slack.messages) carries the new count
    expect(x.sql.getMessages({ teamId: 'T1', channelId: 'C1', limit: 50 }).find((m) => m.ts === parent)!.replyCount).toBe(2)
  })
})

d('who wrote it: members, guests, Slack Connect externals', () => {
  it('stores guest/team fields and stamps author on inbound', async () => {
    const x = await up()
    const g = x.sql.getUser('T1', 'UGUEST')!
    expect(g).toMatchObject({ restricted: true, homeTeamId: 'T1' })
    const tss = ['U1', 'UGUEST', 'USINGLE', 'UEXT', 'UGONE'].map((u) => x.fake.post('C1', { user: u, text: `<@UBOT> from ${u}` }))
    await settle(2000)
    const by = (ts: string) => x.inbound.find((m) => m.ts === ts)?.author
    expect(tss.map(by)).toEqual(['member', 'guest', 'guest', 'external', 'deleted'])
  })

  it('a DM from a guest is never offered as the alert user', async () => {
    h = makeHarness({ users: people, channels: [...CHANNELS!, { id: 'D9', name: 'UGUEST', kind: 'dm', members: ['UBOT', 'UGUEST'], user: 'UGUEST' }] })
    await connect(h)
    await settle(5000)
    h.fake.post('D9', { user: 'UGUEST', text: 'hi' })
    await settle(500)
    expect(h.suggestions).toEqual([])
  })
})

describe('members-only gate (shared rule)', () => {
  const msg = (author: SlackInboundMessage['author'], userId = 'UX'): Pick<SlackInboundMessage, 'userId' | 'author'> => ({ userId, author })
  const base = { on: ['dm' as const], channels: [], keywords: [], regex: null, fromUsers: [] as string[] }
  it('default allows members only; fromUsers and allowGuests opt in; deleted never', () => {
    expect(slackAuthorProblem(base, msg('member'))).toBeNull()
    for (const a of ['guest', 'external', 'unknown', 'deleted', undefined] as const) expect(slackAuthorProblem(base, msg(a))).toMatch(/workspace members only/)
    expect(slackAuthorProblem({ ...base, fromUsers: ['UX'] }, msg('external'))).toBeNull()
    expect(slackAuthorProblem({ ...base, allowGuests: true }, msg('external'))).toBeNull()
    expect(slackAuthorProblem({ ...base, allowGuests: true }, msg('deleted'))).not.toBeNull()
  })
  it('classifies by user_team, home team, enterprise, guest flags', () => {
    const ws = { teamId: 'T1', enterpriseId: null }
    expect(slackAuthorKind({ deleted: false }, ws)).toBe('member')
    expect(slackAuthorKind({ deleted: false }, ws, 'T9')).toBe('external')
    expect(slackAuthorKind({ deleted: false, homeTeamId: 'T9' }, ws)).toBe('external')
    expect(slackAuthorKind({ deleted: false, homeTeamId: 'T2', enterpriseId: 'E1' }, { teamId: 'T1', enterpriseId: 'E1' })).toBe('member')
    expect(slackAuthorKind({ deleted: false, ultraRestricted: true }, ws)).toBe('guest')
    expect(slackAuthorKind(null, ws)).toBe('unknown')
  })
  it('auto + allowGuests needs people; the sentence and the card line say who can trigger', () => {
    expect(autoModeProblem({ ...base, allowGuests: true })).toMatch(/list of people/)
    expect(autoModeProblem({ ...base, allowGuests: true, fromUsers: ['U1'] })).toBeNull()
    const n = normalizeTrigger({ name: 't', workflowId: 'wf_1', match: { ...base, allowGuests: true }, reply: { mode: 'auto', autoChannels: ['dm'] } }, null)
    expect(n.errors.map((e) => e.path)).toContain('reply.mode')
    const ok = normalizeTrigger({ name: 't', workflowId: 'wf_1', match: base, reply: { mode: 'draft', autoChannels: [] } }, null)
    expect(ok.trigger.match.allowGuests).toBeUndefined()
    expect(triggerSentence(ok.trigger)).toBe('When someone DMs @hive · workspace members only · replies as drafts')
    expect(slackWhoCanTrigger({ fromUsers: [], allowGuests: true })).toMatch(/including guests/)
  })
})

d('trigger list scoping (main-side gate)', () => {
  it('scoped() limits list() only inside the call', async () => {
    h = makeHarness()
    h.db.pragma('foreign_keys = OFF')
    const st = new SlackTriggerStore(h.db)
    const t = (allowGuests: boolean) =>
      st.insert({ name: `t${allowGuests}`, workflowId: 'wf_1', enabled: true, match: { on: ['dm'], channels: [], keywords: [], regex: null, fromUsers: [], ...(allowGuests ? { allowGuests } : {}) }, reply: { mode: 'draft', autoChannels: [], replyNode: null }, limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 }, inputs: {} } as never)
    const a = t(false)
    const b = t(true)
    expect(st.list()).toHaveLength(2)
    const inside = st.scoped(new Set([b.id]), () => st.list().map((x) => x.id))
    expect(inside).toEqual([b.id])
    expect(st.list().map((x) => x.id)).toEqual([a.id, b.id])
    expect(st.get(b.id)!.match.allowGuests).toBe(true)
  })
})

d('durable dedupe and counters', () => {
  it('a message already handed to trigger matching is not handed again after a restart (new connector, same db)', async () => {
    const x = await up()
    const ts = x.fake.post('C1', { user: 'U1', text: '<@UBOT> once' })
    await settle(500)
    expect(x.inbound.filter((m) => m.ts === ts)).toHaveLength(1)
    expect(x.sql.claimInbound('T1', 'C1', ts)).toBe(false)
    expect(x.sql.claimInbound('T1', 'C1', '1.000001')).toBe(true)
  })

  it('notify posts are counted from the outbox', async () => {
    const x = await up()
    const all = [0, 1, 2].map((i) => x.conn.postAlert({ channelId: 'C1' }, `alert ${i}`, 'notify', 'r_1', null))
    all.push(x.conn.postAlert({ channelId: 'C1' }, 'mirror', 'mirror', null, null))
    await settle(10_000)
    await Promise.all(all)
    expect(await x.conn.notifyPostsSince({ runId: null, sinceMs: Date.now() - 3600_000 })).toBe(3)
    expect(await x.conn.notifyPostsSince({ runId: 'r_1', sinceMs: 0 })).toBe(3)
    expect(await x.conn.notifyPostsSince({ runId: 'r_2', sinceMs: 0 })).toBe(0)
  })
})

describe('notify rate guard survives a restart', () => {
  it('uses the port count: 60 in the last hour -> Mac only', async () => {
    const posted: string[] = []
    const port = (hour: number, run: number): SlackAlertPort => ({
      connected: () => true,
      alertUserId: () => 'U1',
      post: async (_t, text) => void posted.push(text),
      recentPosts: async (q) => (q.runId ? run : hour)
    })
    const fresh = new NotifyNode({ post: () => {}, redact: (s) => s, slack: () => port(60, 0) })
    expect(await fresh.slack({ kind: 'me' }, 't', 'm', 'r_1', null)).toEqual({ slack: 'failed', note: RATE_NOTE })
    const perRun = new NotifyNode({ post: () => {}, redact: (s) => s, slack: () => port(0, 10) })
    expect(await perRun.slack({ kind: 'me' }, 't', 'm', 'r_1', null)).toEqual({ slack: 'failed', note: RATE_NOTE })
    const okNode = new NotifyNode({ post: () => {}, redact: (s) => s, slack: () => port(59, 9) })
    expect(await okNode.slack({ kind: 'me' }, 't', 'm', 'r_1', null)).toEqual({ slack: 'sent', note: null })
    expect(posted).toHaveLength(1)
  })
})
