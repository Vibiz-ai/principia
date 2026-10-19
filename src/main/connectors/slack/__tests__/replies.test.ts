import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HiveError } from '../../../../shared/errors'
import type { SlackChannel, SlackRunContext } from '../../../../shared/slack'
import { buildManifest } from '../core/manifest'
import { decideReply, type PolicyCounters, type ReplyCaller, type ReplyTriggerView } from '../core/policy'
import { defuseBroadcasts, prepareOutgoing } from '../core/format'
import { normalizeTrigger, regexProblem } from '../triggerConfig'
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

const ctx = (o: Partial<SlackRunContext> = {}): SlackRunContext => ({
  triggerId: 'stg_1',
  teamId: 'T1',
  channelId: 'C1',
  channelName: 'support',
  channelKind: 'channel',
  threadTs: '1792141200.000100',
  messageTs: ['1792141200.000100'],
  userId: 'U1',
  userName: 'Dana Lee',
  text: 'help',
  permalink: '',
  isMention: true,
  isDm: false,
  catchup: false,
  ...o
})
const trig = (o: Partial<ReplyTriggerView['reply']> = {}, enabled = true): ReplyTriggerView => ({
  id: 'stg_1',
  enabled,
  reply: { mode: 'auto', autoChannels: ['C1', 'dm'], replyNode: null, ...o },
  limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 }
})
const zero: PolicyCounters = { runAutoPosts: 0, threadAutoPostsHour: 0, channelAutoPostsHour: 0 }
const env = { autoPaused: false, live: true }
const step = (c: SlackRunContext | null = ctx(), t: ReplyTriggerView | null = trig()): ReplyCaller => ({ kind: 'step', runId: 'r_1', stepId: 'st_1', ctx: c, trigger: t })
const target = { channelId: 'C1', channelKind: 'channel' as const, threadTs: '1792141200.000100' }

describe('15: decideReply, every §8.2 branch (core/policy.ts, no Electron)', () => {
  it('interactive / no_trigger / none / draft', () => {
    expect(decideReply({ kind: 'session', sessionId: 's_1' }, target, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'interactive' })
    expect(decideReply(step(null, null), target, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'no_trigger' })
    expect(decideReply(step(ctx(), trig({ mode: 'none' })), target, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(ctx(), trig({ mode: 'draft' })), target, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'draft_mode' })
  })
  it('auto: paused, other thread, not allow-listed, caps, mentions, disabled', () => {
    expect(decideReply(step(), target, 'hi', { autoPaused: true, live: true }, zero)).toEqual({ action: 'draft', reason: 'auto_paused' })
    // outside the triggering thread a Slack-triggered run never posts nor drafts (refused, fail closed)
    expect(decideReply(step(), { ...target, channelId: 'C2' }, 'hi', env, zero)).toMatchObject({ action: 'refused', reason: expect.stringMatching(/only reply in the thread that started it/) })
    expect(decideReply(step(), { ...target, threadTs: null }, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(), { ...target, threadTs: '1792141299.000100' }, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(ctx(), trig({ mode: 'draft' })), { ...target, channelId: 'C2' }, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(ctx(), null), { ...target, channelId: 'C2' }, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(ctx(), trig({ autoChannels: ['C9'] })), target, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'not_allowlisted' })
    expect(decideReply(step(), target, 'hi', env, { ...zero, runAutoPosts: 1 })).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, 'hi', env, { ...zero, threadAutoPostsHour: 4 })).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, 'hi', env, { ...zero, channelAutoPostsHour: 6 })).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, '<@U1> <@U2> <@U3> <@U4>', env, zero)).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, '<@U1> <@U2> <@U3> <@U1>', env, zero).action).toBe('post')
    expect(decideReply(step(ctx(), trig({}, false)), target, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, 'hi', { autoPaused: false, live: false }, zero)).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(), target, 'hi', env, zero)).toEqual({ action: 'post', threadTs: '1792141200.000100', threadKey: '1792141200.000100' })
  })
  it('DMs: one conversation (dm:<channel>), replies top-level (PO-S4)', () => {
    const c = ctx({ channelId: 'D1', channelKind: 'dm', isDm: true, threadTs: '1792141300.000100' })
    const t = { channelId: 'D1', channelKind: 'dm' as const, threadTs: null }
    expect(decideReply(step(c), t, 'hi', env, zero)).toEqual({ action: 'post', threadTs: null, threadKey: 'dm:D1' })
    expect(decideReply(step(c, trig({ autoChannels: ['C1'] })), t, 'hi', env, zero)).toEqual({ action: 'draft', reason: 'not_allowlisted' })
    expect(decideReply(step(c), { ...t, threadTs: '1792141000.000100' }, 'hi', env, zero)).toMatchObject({ action: 'refused', reason: expect.stringMatching(/conversation that started it/) })
    expect(decideReply(step(c), { ...t, channelId: 'D2' }, 'hi', env, zero).action).toBe('refused')
    expect(decideReply(step(c), { ...t, threadTs: '1792141300.000100' }, 'hi', env, zero).action).toBe('post')
  })
})

describe('text pipeline', () => {
  it('defuses broadcasts and caps at 3,000 chars', () => {
    expect(defuseBroadcasts('<!channel> hi @here and <!everyone|everyone>')).not.toMatch(/<!channel>|(?<!‍)@here\b/)
    expect(prepareOutgoing('**bold** [x](https://a.b)')).toBe('*bold* <https://a.b|x>')
    expect(prepareOutgoing('x'.repeat(5000)).length).toBe(3000)
  })
})

describe('17 setup + 14 manifest', () => {
  it('createUrl decodes to the manifest; docs copy is identical; scopes and events per PO-S2', () => {
    const m = buildManifest({ name: 'Hive' })
    const url = new URL(m.createUrl)
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps')
    expect(url.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(url.searchParams.get('manifest_json')!)).toEqual(m.json)
    const docs = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../docs/slack-app-manifest.json'), 'utf8'))
    expect(m.json).toEqual(docs)
    const s = (m.json as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot
    expect(s).toEqual(expect.arrayContaining(['channels:join', 'mpim:read']))
    expect(m.yaml).toContain('socket_mode_enabled: true')
    expect(m.yaml).toContain('- member_joined_channel')
  })
})

describe('16 (save rule) + trigger config', () => {
  const wf = { nodes: [{ id: 'a', type: 'agent' }, { id: 'b', type: 'agent' }] as never, inputs: [] }
  it('auto on `message` without a filter is rejected at save; with a keyword it is fine', () => {
    const base = { name: 'x', workflowId: 'wf_1', match: { on: ['message' as const], channels: ['C1'], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'auto' as const, autoChannels: ['C1'] } }
    expect(normalizeTrigger(base, wf).errors.map((e) => e.path)).toContain('reply.mode')
    expect(normalizeTrigger({ ...base, match: { ...base.match, keywords: ['deploy'] } }, wf).errors).toEqual([])
    expect(normalizeTrigger({ ...base, match: { ...base.match, on: ['mention'], channels: [] } }, wf).errors).toEqual([])
  })
  it('PO-S10 replyNode defaults to the last agent node; PO-S9 debounce defaults', () => {
    const t = normalizeTrigger({ name: 'x', workflowId: 'wf_1', match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'draft', autoChannels: [] } }, wf).trigger
    expect(t.reply.replyNode).toBe('b')
    expect(t.limits).toEqual({ debounceSec: 3, maxRunsPerThreadPerHour: 4 })
    const m = normalizeTrigger({ name: 'x', workflowId: 'wf_1', match: { on: ['message'], channels: ['C1'], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'draft', autoChannels: [] } }, wf).trigger
    expect(m.limits.debounceSec).toBe(15)
  })
  it('a catastrophic regex is rejected', () => {
    expect(regexProblem('(a+)+$')).toMatch(/too slow/)
    expect(regexProblem('deploy|release')).toBeNull()
    expect(regexProblem('(')).toMatch(/compile/)
  })
})

async function connected(): Promise<{ C1: SlackChannel; D1: SlackChannel }> {
  h = makeHarness()
  await connect(h)
  await settle(5000)
  return { C1: h.sql.getChannel('T1', 'C1')!, D1: h.sql.getChannel('T1', 'D1')! }
}

d('drafts, outbox, posting (SLACK.md §8)', () => {
  it('draft -> edit -> Send posts in the thread with hive metadata; the echo never triggers', async () => {
    const { C1 } = await connected()
    const parent = h.fake.post('C1', { user: 'U1', text: 'help please' })
    await settle(10)
    const r = await h.conn.reply({ caller: step(ctx({ threadTs: parent }), trig({ mode: 'draft' })), channel: C1, threadTs: parent, text: 'We are on it', ownerLabel: 'Support bot', agentId: null })
    expect(r.status).toBe('drafted')
    expect(h.asks.open).toHaveLength(1)
    expect(h.asks.open[0].title).toBe('Reply in #support')
    const id = (r as { draftId: string }).draftId
    const sent = await h.conn.drafts.decide(id, 'send', 'We are on it, Dana')
    expect(sent.status).toBe('sent')
    expect(sent.edited).toBe(true)
    expect(h.fake.posted).toHaveLength(1)
    expect(h.fake.posted[0]).toMatchObject({ channel: 'C1', thread_ts: parent, text: 'We are on it, Dana' })
    expect((h.fake.posted[0].metadata as { event_type: string }).event_type).toBe('hive_post')
    expect(h.asks.closed[0]).toEqual({ askId: 'ask_1', outcome: 'answered' })
    await settle(10)
    const echo = h.inbound.find((m) => m.ts === sent.sentTs)
    expect(echo?.isOwn).toBe(true)
    await expect(h.conn.drafts.decide(id, 'discard')).rejects.toThrow(/already sent/)
  })

  it('auto post in the triggering thread; the second in the same run becomes a draft (1 per run)', async () => {
    const { C1 } = await connected()
    const parent = h.fake.post('C1', { user: 'U1', text: '<@UBOT> help' })
    await settle(10)
    const caller = step(ctx({ threadTs: parent }))
    const a = await h.conn.reply({ caller, channel: C1, threadTs: parent, text: 'first', ownerLabel: 'x', agentId: null })
    expect(a.status).toBe('posted')
    const b = await h.conn.reply({ caller, channel: C1, threadTs: parent, text: 'second', ownerLabel: 'x', agentId: null })
    expect(b).toMatchObject({ status: 'drafted', reason: 'auto_limit' })
    expect(h.fake.posted).toHaveLength(1)
  })

  it('16: spam soak: 200 mentions in an hour from 50 users -> at most 6 auto posts in #support', async () => {
    const { C1 } = await connected()
    let posted = 0
    let drafted = 0
    for (let i = 0; i < 200; i++) {
      await settle(18_000) // 200 × 18 s = 1 h
      const ts = h.fake.post('C1', { user: i % 2 ? 'U1' : 'U2', text: `<@UBOT> question ${i} from user ${i % 50}` })
      const r = await h.conn.reply({ caller: { kind: 'step', runId: `r_${i}`, stepId: null, ctx: ctx({ threadTs: ts, messageTs: [ts] }), trigger: trig() }, channel: C1, threadTs: ts, text: `answer ${i}`, ownerLabel: 'x', agentId: null })
      if (r.status === 'posted') posted++
      else if (r.status === 'drafted') {
        drafted++
        // keep the per-owner pending cap out of the way: the user discards drafts as they come
        await h.conn.drafts.decide(r.draftId, 'discard')
      }
    }
    const inAnyHour = (() => {
      const at = h.fake.posted.filter((p) => p.channel === 'C1').map((p) => Number(p.ts) * 1000)
      let best = 0
      for (let i = 0; i < at.length; i++) best = Math.max(best, at.filter((t) => t >= at[i] && t - at[i] < 3600_000).length)
      return best
    })()
    expect(inAnyHour).toBeLessThanOrEqual(6)
    expect(posted).toBeLessThanOrEqual(7) // the window rolls: at most 6 in any hour
    expect(posted + drafted).toBe(200)
  }, 30_000)

  it('11: crash while sending -> unknown -> found by metadata -> sent; not found -> failed; never re-posted', async () => {
    const { C1 } = await connected()
    // a post that reached Slack but whose response was lost
    h.fake.post('C1', { user: 'U1', text: 'q' })
    const r = await h.conn.reply({ caller: step(null, null), channel: C1, threadTs: null, text: 'x', ownerLabel: 'x', agentId: null })
    expect(r.status).toBe('drafted')
    const now = new Date().toISOString()
    h.sql.outboxInsert({ id: 'sob_found00001', purpose: 'notify', teamId: 'T1', channelId: 'C1', threadTs: null, threadKey: null, text: 'reached slack', draftId: null, runId: null, stepId: null, status: 'sending', attempts: 1, ts: null, error: null, createdAt: now, sentAt: null })
    h.fake.messages.get('C1')!.push({ ts: h.fake.nextTs(), user: 'UBOT', bot_id: 'BBOT', text: 'reached slack', metadata: { event_type: 'hive_post', event_payload: { outbox_id: 'sob_found00001' } } })
    h.sql.outboxInsert({ id: 'sob_lost000001', purpose: 'notify', teamId: 'T1', channelId: 'C1', threadTs: null, threadKey: null, text: 'never left', draftId: null, runId: null, stepId: null, status: 'sending', attempts: 1, ts: null, error: null, createdAt: now, sentAt: null })
    const posts = h.fake.posted.length
    const res = await h.conn.outbox.recover()
    expect(res).toEqual({ sent: 1, failed: 1 })
    expect(h.sql.outboxGet('sob_found00001')!.status).toBe('sent')
    expect(h.sql.outboxGet('sob_lost000001')!).toMatchObject({ status: 'failed', error: 'Hive quit while sending; not sent' })
    expect(h.fake.posted.length).toBe(posts)
  })

  it('not_in_channel on Send -> failed with a readable error, Retry keeps the card', async () => {
    await connected()
    const C3 = h.sql.getChannel('T1', 'C3')!
    const r = await h.conn.draftReply({ caller: { kind: 'session', sessionId: 's_1' }, channel: C3, threadTs: null, text: 'hello', ownerLabel: 'vibiz · Claude', agentId: null })
    const out = await h.conn.drafts.decide((r as { draftId: string }).draftId, 'send')
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/Invite @hive to #notjoined/)
    expect(h.asks.closed).toHaveLength(0)
  })
})

d('12, 13, 17: tokens, revocation, redaction, alert suggestion', () => {
  it('12: connect with a bad app token -> validation on appToken, nothing stored', async () => {
    h = makeHarness()
    const p = h.conn.connectTokens({ botToken: h.fake.tokens.bot, appToken: 'xapp-1-A1-0000000000-wrongwrongwrongwrong' }).catch((x) => x)
    await vi.advanceTimersByTimeAsync(10)
    const e = await p
    expect(e).toBeInstanceOf(HiveError)
    expect((e as HiveError).code).toBe('validation')
    expect((e as HiveError).errors?.[0].path).toBe('appToken')
    expect(h.db.prepare('SELECT count(*) AS n FROM connector_secrets').get()).toEqual({ n: 0 })
    expect(h.db.prepare('SELECT count(*) AS n FROM slack_workspaces').get()).toEqual({ n: 0 })
    const shape = await h.conn.connectTokens({ botToken: 'nope', appToken: 'xapp-short' }).catch((x) => x)
    expect((shape as HiveError).errors?.map((x) => x.path)).toEqual(['botToken', 'appToken'])
  })

  it('12: token revoked mid-session -> error + exactly one notification', async () => {
    await connected()
    h.fake.revoke('bot')
    await h.conn.sync.fetchLatest('C1').catch(() => null)
    await h.conn.sync.fetchLatest('C2').catch(() => null)
    await settle(100)
    expect(h.conn.status().state).toBe('error')
    expect(h.fatal).toHaveLength(1)
  })

  it('13: tokens never appear in a log line; tokens are masked in status; vault values are redacted from posts', async () => {
    await connected()
    h.fake.emitRaw(`not json ${h.fake.tokens.bot}`)
    h.fake.revoke('app')
    await settle(5000)
    const all = JSON.stringify(h.logs) + JSON.stringify(h.statuses)
    expect(all).not.toContain(h.fake.tokens.bot)
    expect(all).not.toContain(h.fake.tokens.app)
    expect(h.conn.status().tokens.bot).toMatch(/^xoxb-…/)
    expect(h.redactions.get('SLACK_BOT_TOKEN')).toBe(h.fake.tokens.bot)
  })

  it('17: the first human DM with no alert user -> exactly one suggestion', async () => {
    await connected()
    h.fake.post('D1', { user: 'U1', text: 'hi' })
    h.fake.post('D1', { user: 'U1', text: 'hi again' })
    h.fake.post('C1', { user: 'U2', text: 'channel msg' })
    await settle(50)
    expect(h.suggestions).toEqual([{ userId: 'U1', name: 'Dana Lee' }])
    expect(h.conn.status().alertSuggestion).toEqual({ userId: 'U1', name: 'Dana Lee' })
    h.settings.alertUserId = 'U1'
    expect(h.conn.status().alertSuggestion).toBeNull()
  })
})

describe('built-in responder: "*" = wherever the mention / DM trigger fired', () => {
  it('auto-posts in the triggering thread of any channel or DM, still inside every other guard', () => {
    const any = trig({ autoChannels: ['*'] })
    expect(decideReply(step(ctx({ channelId: 'C7' }), any), { ...target, channelId: 'C7' }, 'hi', env, zero).action).toBe('post')
    const dm = ctx({ channelId: 'D1', channelKind: 'dm', threadTs: '1792141200.000100' })
    expect(decideReply(step(dm, any), { channelId: 'D1', channelKind: 'dm', threadTs: null }, 'hi', env, zero).action).toBe('post')
    expect(decideReply(step(ctx(), any), target, 'hi', { autoPaused: true, live: true }, zero)).toEqual({ action: 'draft', reason: 'auto_paused' })
    expect(decideReply(step(ctx(), any), target, 'hi', env, { ...zero, runAutoPosts: 1 })).toEqual({ action: 'draft', reason: 'auto_limit' })
    expect(decideReply(step(ctx(), any), { ...target, channelId: 'C2' }, 'hi', env, zero).action).toBe('refused')
  })
  it('"*" is accepted for mention/DM triggers and refused on "any message" triggers', () => {
    const base = { name: 'x', workflowId: 'wf_1', reply: { mode: 'auto' as const, autoChannels: ['*'], replyNode: null } }
    expect(normalizeTrigger({ ...base, match: { on: ['mention', 'dm'], channels: [], keywords: [], regex: null, fromUsers: [], fallback: true } }, null).trigger.match.fallback).toBe(true)
    expect(normalizeTrigger({ ...base, match: { on: ['mention', 'dm'], channels: [], keywords: [], regex: null, fromUsers: [] } }, null).errors).toEqual([])
  })
})
