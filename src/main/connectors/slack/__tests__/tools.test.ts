import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackRunContext } from '../../../../shared/slack'
import { buildAuthorHandlers, parseToolsets } from '../../../author/server/tools'
import { SlackTools } from '../tools'
import { CHANNELS, connect, makeHarness, nativeOk, settle, type Harness } from './harness'

const d = nativeOk ? describe : describe.skip
let h: Harness
let tools: SlackTools
let steps: Record<string, { ctx: SlackRunContext | null; slackTools: boolean }>
let trig: { mode: 'draft' | 'auto' | 'none' }

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00Z') })
})
afterEach(async () => {
  await h?.conn.stop()
  h?.db.close()
  vi.useRealTimers()
})

async function setup(extraChannels: typeof CHANNELS = []): Promise<void> {
  h = makeHarness(extraChannels?.length ? { channels: [...(CHANNELS ?? []), ...extraChannels] } : {})
  await connect(h)
  await settle(5000)
  steps = {}
  trig = { mode: 'draft' }
  tools = new SlackTools({
    connector: h.conn,
    sql: h.sql,
    redact: (s) => s.split('sk-live-SECRET123').join('••••STRIPE_KEY'),
    now: () => Date.now(),
    session: (sid) => (sid === 's_live' ? { label: 'vibiz · Claude', agentId: null } : null),
    step: (o) => (steps[o.stepId] ? { ...steps[o.stepId], label: 'Support bot', agentId: null } : null),
    trigger: (id) => (id === 'stg_1' ? { id, enabled: true, reply: { mode: trig.mode, autoChannels: ['C1'], replyNode: null }, limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 } } : null)
  })
}

const ctx = (threadTs: string, o: Partial<SlackRunContext> = {}): SlackRunContext => ({
  triggerId: 'stg_1', teamId: 'T1', channelId: 'C1', channelName: 'support', channelKind: 'channel', threadTs, messageTs: [threadTs],
  userId: 'U1', userName: 'Dana Lee', text: 'q', permalink: '', isMention: true, isDm: false, catchup: false, ...o
})
/** A second DM (Sam with the bot) and a group DM: other people's conversations a triggered run must never read. */
const PRIVATE_CONVERSATIONS: typeof CHANNELS = [
  { id: 'D2', name: 'U2', kind: 'dm', members: ['UBOT', 'U2'], user: 'U2' },
  { id: 'G9', name: 'mpdm-dana--sam-1', kind: 'group_dm', members: ['UBOT', 'U1', 'U2'] }
]

d('slack_* tools (SLACK.md §11)', () => {
  it('a step of a non-Slack run without slackTools cannot use them; a session can', async () => {
    await setup()
    steps.st_plain = { ctx: null, slackTools: false }
    await expect(tools.call({ stepId: 'st_plain', runId: 'r_1' }, 'slack_list_channels', {})).rejects.toThrow(/Unknown tool/)
    const r = await tools.call({ sessionId: 's_live' }, 'slack_list_channels', {})
    expect((r.channels as { id: string }[]).map((c) => c.id)).toEqual(expect.arrayContaining(['C1', 'C2', 'G1', 'D1']))
    expect((r.channels as { id: string }[]).map((c) => c.id)).not.toContain('C3')
  })

  it('read_thread: mentions resolved, redacted, refreshed; channels the bot is not in are refused', async () => {
    await setup()
    const parent = h.fake.post('C1', { user: 'U1', text: '<@U2> the key is sk-live-SECRET123' })
    h.fake.post('C1', { user: 'U2', text: 'got it', thread_ts: parent })
    await settle(50)
    const r = await tools.call({ sessionId: 's_live' }, 'slack_read_thread', { channel: '#support', thread_ts: parent })
    const msgs = r.messages as { text: string; user: { name: string } }[]
    expect(msgs).toHaveLength(2)
    expect(msgs[0].text).toBe('@Sam Roe the key is ••••STRIPE_KEY')
    expect(JSON.stringify(r)).not.toContain('sk-live-SECRET123')
    expect(msgs[1].user.name).toBe('Sam Roe')
    await expect(tools.call({ sessionId: 's_live' }, 'slack_read_thread', { channel: 'C3' })).rejects.toThrow(/not in #notjoined/)
  })

  it('search: local FTS with quoted phrases and -exclude; says what it searched', async () => {
    await setup()
    h.fake.post('C1', { user: 'U1', text: 'the deploy failed on staging' })
    h.fake.post('C2', { user: 'U1', text: 'deploy went fine' })
    await settle(50)
    const r = await tools.call({ sessionId: 's_live' }, 'slack_search', { query: 'deploy -fine' })
    const hits = r.hits as { channel: { id: string }; snippet: string }[]
    expect(hits).toHaveLength(1)
    expect(hits[0].channel.id).toBe('C1')
    expect(hits[0].snippet).toContain('«deploy»')
    expect(r.searched).toMatch(/^local copy: \d+ channels/)
  })

  it('draft_reply never posts; slack_post drafts in draft mode and posts in auto mode for the triggering thread only', async () => {
    await setup()
    const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> help' })
    await settle(20)
    steps.st_a = { ctx: ctx(parent), slackTools: false }
    const owner = { stepId: 'st_a', runId: 'r_a' }
    const dr = await tools.call(owner, 'slack_draft_reply', { channel: 'C1', thread_ts: parent, text: 'draft text', note: 'because' })
    expect(dr).toMatchObject({ status: 'drafted' })
    expect(h.fake.posted).toHaveLength(0)
    const p1 = await tools.call(owner, 'slack_post', { channel: 'C1', thread_ts: parent, text: 'x' })
    expect(p1).toMatchObject({ status: 'drafted', reason: 'draft_mode' })
    trig.mode = 'auto'
    const other = await tools.call(owner, 'slack_post', { channel: 'C2', text: 'elsewhere' })
    expect(other).toMatchObject({ status: 'refused', reason: expect.stringMatching(/only reply in the thread that started it/) })
    const p2 = await tools.call(owner, 'slack_post', { channel: 'C1', thread_ts: parent, text: 'posted' })
    expect(p2).toMatchObject({ status: 'posted' })
    expect(h.fake.posted[0]).toMatchObject({ channel: 'C1', thread_ts: parent })
    trig.mode = 'none'
    expect(await tools.call(owner, 'slack_draft_reply', { channel: 'C1', text: 'no' })).toMatchObject({ status: 'refused' })
  })

  it('a Slack-triggered run reads only its own thread: not other threads, channels, DMs or group DMs (fail closed)', async () => {
    await setup(PRIVATE_CONVERSATIONS)
    const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> where is the runbook? secret-word' })
    h.fake.post('C1', { user: 'U2', text: 'secret-word reply in the thread', thread_ts: parent })
    const otherThread = h.fake.post('C1', { user: 'U2', text: 'unrelated secret-word thread' })
    h.fake.post('C2', { user: 'U1', text: 'secret-word in random' })
    h.fake.post('D1', { user: 'U1', text: 'secret-word in a DM with dana' })
    h.fake.post('D2', { user: 'U2', text: 'secret-word: sam private DM' })
    h.fake.post('G9', { user: 'U2', text: 'secret-word group DM' })
    await settle(50)
    steps.st_s = { ctx: ctx(parent), slackTools: false }
    const owner = { stepId: 'st_s', runId: 'r_s' }

    const list = await tools.call(owner, 'slack_list_channels', {})
    expect((list.channels as { id: string }[]).map((c) => c.id)).toEqual(['C1'])

    const own = await tools.call(owner, 'slack_read_thread', { channel: 'C1', thread_ts: parent })
    expect((own.messages as { text: string }[]).map((m) => m.text)).toEqual(['@hive where is the runbook? secret-word', 'secret-word reply in the thread'].map((t) => expect.stringContaining(t.split(' ').pop()!)))
    for (const args of [
      { channel: 'C1', thread_ts: otherThread },
      { channel: 'C1' },
      { channel: '#support' },
      { channel: 'C2' },
      { channel: 'G1' },
      { channel: 'D1' },
      { channel: 'D2' },
      { channel: '@sam' },
      { channel: 'G9' },
      { permalink: `https://acme.slack.com/archives/D2/p${parent.replace('.', '')}` }
    ]) {
      await expect(tools.call(owner, 'slack_read_thread', args), JSON.stringify(args)).rejects.toThrow(/only read the conversation that started it/)
    }

    const found = await tools.call(owner, 'slack_search', { query: 'secret-word' })
    const hits = found.hits as { channel: { id: string }; ts: string; thread_ts: string | null }[]
    expect(hits.length).toBe(2)
    expect(hits.every((x) => x.channel.id === 'C1' && (x.thread_ts ?? x.ts) === parent)).toBe(true)
    await expect(tools.call(owner, 'slack_search', { query: 'secret-word', channel: 'D2' })).rejects.toThrow(/only read the conversation/)
    await expect(tools.call(owner, 'slack_search', { query: 'secret-word', channel: '#random' })).rejects.toThrow(/only read the conversation/)
    // the user's own interactive session is not scoped
    const mine = await tools.call({ sessionId: 's_live' }, 'slack_search', { query: 'secret-word' })
    expect((mine.hits as unknown[]).length).toBeGreaterThan(2)
  })

  it('read_channels widens reads to whole channels, never to DMs or group DMs', async () => {
    await setup(PRIVATE_CONVERSATIONS)
    const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> faq?' })
    const faq = h.fake.post('C2', { user: 'U1', text: 'faq: restart the pod' })
    h.fake.post('D2', { user: 'U2', text: 'faq private' })
    await settle(50)
    // a hand-edited / older row listing DMs: still refused at read time
    steps.st_r = { ctx: { ...ctx(parent), access: { fullPermissions: true, secretNames: [], readChannels: ['C2', 'D2', 'G9'] } }, slackTools: false }
    const owner = { stepId: 'st_r', runId: 'r_r' }
    const list = await tools.call(owner, 'slack_list_channels', {})
    expect((list.channels as { id: string }[]).map((c) => c.id).sort()).toEqual(['C1', 'C2'])
    const r = await tools.call(owner, 'slack_read_thread', { channel: '#random' })
    expect((r.messages as { ts: string }[]).map((m) => m.ts)).toContain(faq)
    await expect(tools.call(owner, 'slack_read_thread', { channel: 'D2' })).rejects.toThrow(/only read the conversation/)
    await expect(tools.call(owner, 'slack_read_thread', { channel: 'G9' })).rejects.toThrow(/only read the conversation/)
    const hits = (await tools.call(owner, 'slack_search', { query: 'faq' })).hits as { channel: { id: string } }[]
    expect(hits.map((x) => x.channel.id).sort()).toEqual(['C1', 'C2'])
  })

  it('a DM-triggered run reads its whole DM but no other DM or channel', async () => {
    await setup(PRIVATE_CONVERSATIONS)
    const first = h.fake.post('D1', { user: 'U1', text: 'hello bot' })
    const last = h.fake.post('D1', { user: 'U1', text: 'can you help' })
    h.fake.post('D2', { user: 'U2', text: 'sam secrets' })
    await settle(50)
    steps.st_d = { ctx: ctx(last, { channelId: 'D1', channelName: 'Dana Lee', channelKind: 'dm', isDm: true, isMention: false }), slackTools: false }
    const owner = { stepId: 'st_d', runId: 'r_d' }
    const r = await tools.call(owner, 'slack_read_thread', { channel: 'D1' })
    expect((r.messages as { ts: string }[]).map((m) => m.ts)).toEqual(expect.arrayContaining([first, last]))
    await expect(tools.call(owner, 'slack_read_thread', { channel: 'D2' })).rejects.toThrow(/only read the conversation/)
    await expect(tools.call(owner, 'slack_read_thread', { channel: 'C1' })).rejects.toThrow(/only read the conversation/)
    expect(((await tools.call(owner, 'slack_list_channels', {})).channels as { id: string }[]).map((c) => c.id)).toEqual(['D1'])
  })

  it('a Slack-triggered run drafts and posts only in its own thread; it never opens a DM', async () => {
    await setup(PRIVATE_CONVERSATIONS)
    const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> help' })
    await settle(20)
    steps.st_w = { ctx: ctx(parent), slackTools: false }
    const owner = { stepId: 'st_w', runId: 'r_w' }
    const opens = h.fake.callsOf('conversations.open').length
    for (const channel of ['C2', 'D1', 'D2', 'G9', '#random']) {
      expect(await tools.call(owner, 'slack_draft_reply', { channel, text: 'leak' }), channel).toMatchObject({ status: 'refused' })
    }
    await expect(tools.call(owner, 'slack_draft_reply', { channel: '@sam', text: 'leak' })).resolves.toMatchObject({ status: 'refused' })
    await expect(tools.call(owner, 'slack_draft_reply', { channel: '@nobody', text: 'leak' })).rejects.toThrow()
    expect(await tools.call(owner, 'slack_draft_reply', { channel: 'C1', thread_ts: '1792140000.000100', text: 'leak' })).toMatchObject({ status: 'refused' })
    expect(h.fake.callsOf('conversations.open').length).toBe(opens)
    // its own channel without thread_ts: the triggering thread (placement is fixed)
    const ok = await tools.call(owner, 'slack_draft_reply', { channel: '#support', text: 'here' })
    expect(ok).toMatchObject({ status: 'drafted' })
    expect(h.sql.draftGet(ok.draft_id as string)).toMatchObject({ channelId: 'C1', threadTs: parent })
    trig.mode = 'auto'
    expect(await tools.call(owner, 'slack_post', { channel: 'D2', text: 'leak' })).toMatchObject({ status: 'refused' })
    expect(await tools.call(owner, 'slack_post', { channel: 'C1', text: 'answer' })).toMatchObject({ status: 'posted' })
    expect(h.fake.posted).toHaveLength(1)
    expect(h.fake.posted[0]).toMatchObject({ channel: 'C1', thread_ts: parent })
  })

  it('interactive sessions always draft, even with slack_post', async () => {
    await setup()
    expect(await tools.call({ sessionId: 's_live' }, 'slack_post', { channel: 'C1', text: 'hi' })).toMatchObject({ status: 'drafted', reason: 'interactive' })
    expect(h.fake.posted).toHaveLength(0)
  })
})

describe('hive MCP server toolsets (SLACK.md §11.1)', () => {
  it('HIVE_TOOLSETS selects the listed groups; absent = author only', () => {
    expect([...parseToolsets(undefined)]).toEqual(['author'])
    expect([...parseToolsets('slack')]).toEqual(['slack'])
    const dir = process.cwd()
    const step = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'slack' })
    expect(step.listTools().map((t) => t.name)).toEqual(['slack_list_channels', 'slack_read_thread', 'slack_search', 'slack_draft_reply', 'slack_post'])
    const both = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'author,slack' })
    expect(both.listTools().length).toBe(16) // 11 author + 5 slack
  })
})
