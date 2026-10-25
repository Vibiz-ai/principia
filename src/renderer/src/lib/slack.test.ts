import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SlackChannel, SlackMessage, SlackStatus, SlackTriggerInput } from '@shared/slack'
import type { NotifyNode } from '@shared/types'
import { Mrkdwn } from '../components/slack/Mrkdwn'
import {
  SLACK_TEXT_MAX,
  TRIGGER_REFS,
  channelSections,
  defaultTrigger,
  draftEditState,
  draftReasonText,
  draftTitle,
  groupMessages,
  joinablePublic,
  lastAgentNodeId,
  manifestCreateUrl,
  mergeMessages,
  mrkdwnPreview,
  nonTriggerRefs,
  notifyChoice,
  notifyLabel,
  notifySlackOf,
  parseInline,
  parseMrkdwn,
  parsePermalink,
  replyModeRow,
  safeUrl,
  snippetParts,
  statusPill,
  syncLine,
  toggleOn,
  tokenProblem,
  triggerSentence,
  validateTriggerInput
} from './slack'
import { openTemplateAt } from './workflow'

const html = (text: string): string => renderToStaticMarkup(createElement(Mrkdwn, { text }))

const msg = (p: Partial<SlackMessage> & { ts: string }): SlackMessage => ({
  teamId: 'T1',
  channelId: 'C1',
  threadTs: null,
  userId: 'U1',
  botId: null,
  subtype: null,
  text: 'hi',
  plain: 'hi',
  files: [],
  reactions: [],
  replyCount: 0,
  latestReply: null,
  editedTs: null,
  deleted: false,
  fromHive: false,
  isMention: false,
  ...p
})
const chan = (p: Partial<SlackChannel> & { id: string; name: string }): SlackChannel => ({
  teamId: 'T1',
  kind: 'channel',
  dmUserId: null,
  topic: null,
  isMember: true,
  isArchived: false,
  memberCount: 3,
  lastMessageTs: null,
  unread: false,
  sync: 'done',
  ...p
})
const trig = (p: Partial<SlackTriggerInput> = {}): SlackTriggerInput => ({
  name: 'Support bot',
  workflowId: 'wf_1',
  match: { on: ['mention'], channels: ['C1'], keywords: [], regex: null, fromUsers: [] },
  reply: { mode: 'draft', autoChannels: [], replyNode: 'answer' },
  limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 },
  inputs: {},
  ...p
})
const namer = { channel: (id: string) => (id === 'dm' ? 'DMs with @hive' : id === 'C1' ? '#support' : `#${id}`), user: (id: string) => (id === 'U1' ? 'Dana Lee' : id), bot: 'hive' }

describe('mrkdwn parser', () => {
  it('parses bold, italic, strike, code, links, mentions and channels', () => {
    const inl = parseInline('*bold* _it_ ~gone~ `x<y` <https://a.com|site> <@U1> <#C1|support> <!here>')
    expect(inl.map((n) => n.t)).toEqual(['b', 'text', 'i', 'text', 's', 'text', 'code', 'text', 'link', 'text', 'user', 'text', 'channel', 'text', 'broadcast'])
    expect(inl[8]).toEqual({ t: 'link', url: 'https://a.com', label: 'site' })
    expect(inl[10]).toEqual({ t: 'user', id: 'U1', label: null })
    expect(inl[12]).toEqual({ t: 'channel', id: 'C1', label: 'support' })
    expect(inl[14]).toEqual({ t: 'broadcast', v: '@here' })
  })
  it('emphasis needs word boundaries (snake_case and 2*3*4 stay text)', () => {
    expect(parseInline('snake_case_name and 2*3*4').every((n) => n.t === 'text')).toBe(true)
  })
  it('code fences, quotes and unescaping', () => {
    const b = parseMrkdwn('before\n```\nconst a = 1 &lt; 2\n```\n&gt; quoted *line*\nafter')
    expect(b.map((x) => x.t)).toEqual(['p', 'pre', 'quote', 'p'])
    expect(b[1]).toEqual({ t: 'pre', v: 'const a = 1 < 2' })
  })
  it('only http(s)/mailto become links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('https://ok.example/x')).toBe('https://ok.example/x')
    expect(parseInline('<javascript:alert(1)|click>')).toEqual([{ t: 'text', v: 'click' }])
  })
  it('XSS strings render as text, never markup', () => {
    const out = html('<img src=x onerror=alert(1)> &lt;script&gt;alert(1)&lt;/script&gt; <javascript:alert(1)|x> *<b>b</b>*')
    // the only elements are ours; the payloads survive as escaped text
    const tags = new Set([...out.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]))
    expect([...tags].every((t) => ['div', 'strong', 'em', 's', 'code', 'pre', 'blockquote', 'a', 'span', 'br'].includes(t!))).toBe(true)
    expect(out).not.toMatch(/<script|<img|href="javascript/i)
    expect(out).toContain('img src=x onerror=alert(1)')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    const link = html('<https://evil.example/"onmouseover="x|y>')
    expect(link).not.toContain('onmouseover="x"')
  })
  it('previews resolve names and flatten markup', () => {
    expect(mrkdwnPreview('*Hey* <@U1>, see <#C9|eng>', { user: () => 'Dana' })).toBe('Hey @Dana, see #eng')
    expect(mrkdwnPreview('a'.repeat(300), undefined, 20)).toHaveLength(20)
  })
  it('search snippets split on «»', () => {
    expect(snippetParts('the «deploy» failed «again»')).toEqual([
      { text: 'the ', hit: false },
      { text: 'deploy', hit: true },
      { text: ' failed ', hit: false },
      { text: 'again', hit: true }
    ])
  })
})

describe('timeline helpers', () => {
  it('groups by author within 5 min; system lines and Principia posts stand alone', () => {
    const g = groupMessages([
      msg({ ts: '1000.000100' }),
      msg({ ts: '1100.000100' }),
      msg({ ts: '1500.000100' }),
      msg({ ts: '1510.000100', userId: 'U2' }),
      msg({ ts: '1520.000100', userId: 'U2', subtype: 'channel_join' }),
      msg({ ts: '1530.000100', userId: 'UBOT', fromHive: true })
    ])
    expect(g.map((x) => x.messages.length)).toEqual([2, 1, 1, 1, 1])
    expect(g[3]!.system).toBe(true)
  })
  it('merges live updates by ts in numeric order', () => {
    const out = mergeMessages([msg({ ts: '9.000001' }), msg({ ts: '10.000001', text: 'old' })], [msg({ ts: '10.000001', text: 'edited' }), msg({ ts: '100.000001' })])
    expect(out.map((m) => m.ts)).toEqual(['9.000001', '10.000001', '100.000001'])
    expect(out[1]!.text).toBe('edited')
  })
  it('sections: DMs by recency, members, not joined; Join all = public non-members only', () => {
    const list = [chan({ id: 'C1', name: 'support' }), chan({ id: 'C2', name: 'eng', isMember: false }), chan({ id: 'G1', name: 'secret', kind: 'private', isMember: false }), chan({ id: 'D1', name: 'dana', kind: 'dm', dmUserId: 'U1', lastMessageTs: '5.0' }), chan({ id: 'C3', name: 'old', isArchived: true, isMember: false })]
    const s = channelSections(list)
    expect(s.dms.map((c) => c.id)).toEqual(['D1'])
    expect(s.channels.map((c) => c.id)).toEqual(['C1'])
    expect(s.notJoined.map((c) => c.id)).toEqual(['C2', 'G1'])
    expect(joinablePublic(list).map((c) => c.id)).toEqual(['C2'])
    expect(channelSections(list, '#sup').channels.map((c) => c.id)).toEqual(['C1'])
  })
  it('permalinks parse to channel + ts', () => {
    expect(parsePermalink('https://acme.slack.com/archives/C0123ABC/p1760600000123456?thread_ts=1760600000.000100')).toEqual({ channelId: 'C0123ABC', ts: '1760600000.123456' })
    expect(parsePermalink('https://example.com')).toBeNull()
  })
})

describe('setup', () => {
  it('token prefix checks catch swapped tokens', () => {
    expect(tokenProblem('app', '')).toBeNull()
    expect(tokenProblem('app', 'xoxb-1234567890-1234567890-abcdef')).toMatch(/bot token/)
    expect(tokenProblem('bot', 'xapp-1-A1-1234567890-abcdef')).toMatch(/app-level/)
    expect(tokenProblem('bot', 'xoxb-short')).toMatch(/incomplete/)
    expect(tokenProblem('bot', 'xoxb-1234567890-1234567890-abcdefABCDEF')).toBeNull()
  })
  it('PO-S1: the create link carries the manifest, url-encoded', () => {
    const json = JSON.stringify({ display_information: { name: 'Principia' }, settings: { socket_mode_enabled: true } }, null, 2)
    const url = manifestCreateUrl(json)
    expect(url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true)
    expect(JSON.parse(decodeURIComponent(url.split('manifest_json=')[1]!))).toEqual(JSON.parse(json))
  })
  it('status pill and sync line', () => {
    const base: SlackStatus = { state: 'connected', error: null, warnings: [], since: null, nextRetryAt: null, lastEventAt: null, workspace: { teamId: 'T1', name: 'Acme', domain: 'acme', botUserId: 'UBOT', botName: 'hive' }, tokens: { bot: 'xoxb-…a1b2', app: 'xapp-…9f3c' }, missingScopes: [], sync: { state: 'running', channelsDone: 4, channelsTotal: 12, threadsPending: 31, rateLimitedUntil: null, days: 7 }, alertSuggestion: null }
    expect(statusPill(base)).toEqual({ text: 'Connected to Acme · @hive', tone: 'passed' })
    expect(statusPill({ ...base, missingScopes: ['im:write'] }).tone).toBe('warning')
    expect(statusPill({ ...base, state: 'reconnecting', nextRetryAt: new Date(10_000 + 12_000).toISOString() }, 10_000).text).toBe('Reconnecting in 12 s')
    expect(statusPill(null).text).toBe('Not available')
    expect(syncLine(base)).toBe('Syncing 4/12 channels · 31 threads · 7 days')
  })
})

describe('trigger sentence and validation', () => {
  it('reads like the docs', () => {
    expect(triggerSentence(trig(), namer)).toBe('When @hive is mentioned in #support · replies as drafts')
    expect(triggerSentence(trig({ match: { on: ['dm'], channels: [], keywords: ['deploy', 'rollback'], regex: null, fromUsers: ['U1'] }, reply: { mode: 'auto', autoChannels: ['dm'], replyNode: null } }), namer)).toBe(
      'When someone DMs @hive and it contains “deploy” or “rollback” and it is from Dana Lee · auto-replies in DMs with @hive'
    )
  })
  it('PO-S3c: auto on an unfiltered "any message" trigger is rejected; a filter makes it ok', () => {
    const bad = trig({ match: { on: ['message'], channels: ['C1'], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'auto', autoChannels: ['C1'], replyNode: null } })
    expect(validateTriggerInput(bad).map((p) => p.path)).toContain('reply.mode')
    expect(validateTriggerInput({ ...bad, match: { ...bad.match, keywords: ['deploy'] } })).toEqual([])
    expect(validateTriggerInput(trig({ reply: { mode: 'auto', autoChannels: [], replyNode: null } })).map((p) => p.path)).toContain('reply.autoChannels')
  })
  it('message triggers need channels; regexes must compile; inputs only use trigger.*', () => {
    const t = trig({ match: { on: ['message'], channels: [], keywords: [], regex: '(', fromUsers: [] }, inputs: { q: '{{trigger.text}}', bad: '{{inputs.repo}}' } })
    const paths = validateTriggerInput(t, ['repo']).map((p) => p.path)
    expect(paths).toEqual(expect.arrayContaining(['match.channels', 'match.regex', 'inputs.bad', 'inputs.repo']))
    expect(nonTriggerRefs('{{trigger.text}} and {{ trigger.permalink }} {{steps.x}}')).toEqual(['steps.x'])
  })
  it('PO-S9 debounce defaults follow the "When" boxes until the user changes them', () => {
    let t = trig()
    t = toggleOn(t, 'message', true)
    expect(t.match.on).toEqual(['mention', 'message'])
    expect(t.limits?.debounceSec).toBe(15)
    t = toggleOn(t, 'message', false)
    expect(t.limits?.debounceSec).toBe(3)
    const custom = toggleOn({ ...t, limits: { debounceSec: 40, maxRunsPerThreadPerHour: 4 } }, 'message', true)
    expect(custom.limits?.debounceSec).toBe(40)
  })
  it('PO-S10: replyNode defaults to the last agent node', () => {
    const wf = { id: 'wf_1', name: 'Support', nodes: [{ id: 'triage', type: 'agent' }, { id: 'answer', type: 'agent' }, { id: 'ping', type: 'notify' }] } as unknown as Parameters<typeof defaultTrigger>[0]
    expect(lastAgentNodeId(wf)).toBe('answer')
    expect(defaultTrigger(wf).reply).toEqual({ mode: 'draft', autoChannels: [], replyNode: 'answer' })
  })
  it('approval card row: caution tone for auto with the fixed limits', () => {
    expect(replyModeRow('draft', [], 4, namer)).toEqual({ tone: 'neutral', text: 'Replies: as drafts you approve (Needs you)' })
    const auto = replyModeRow('auto', ['C1', 'dm'], 4, namer)
    expect(auto.tone).toBe('caution')
    expect(auto.text).toBe('Replies: AUTO-POSTS in #support, DMs with @hive (no approval) · 1 post per run · max 4 per thread and 6 per channel per hour')
  })
  it('input mapping autocomplete offers trigger.* after {{', () => {
    const text = 'Answer {{tri'
    const o = openTemplateAt(text, text.length)
    expect(o?.query).toBe('tri')
    expect(TRIGGER_REFS.filter((r) => r.includes(o!.query))).toHaveLength(TRIGGER_REFS.length)
  })
})

describe('draft card', () => {
  it('edit/send states', () => {
    expect(draftEditState('hello', 'pending')).toMatchObject({ canSend: true, over: false, empty: false, count: 5 })
    expect(draftEditState('   ', 'pending').canSend).toBe(false)
    expect(draftEditState('x'.repeat(SLACK_TEXT_MAX + 1), 'pending')).toMatchObject({ over: true, canSend: false })
    expect(draftEditState('retry me', 'failed').canSend).toBe(true)
    expect(draftEditState('done', 'sent').canSend).toBe(false)
    expect(draftEditState('busy', 'pending', true).canSend).toBe(false)
  })
  it('titles and reasons', () => {
    expect(draftTitle({ channelName: '#support', threadTs: '1.2' })).toBe('Reply in #support')
    expect(draftTitle({ channelName: 'Dana Lee', threadTs: null })).toBe('Reply to Dana Lee (DM)')
    expect(draftReasonText('not_allowlisted', '#random')).toBe('Saved as draft: #random is not in the auto list')
    expect(draftReasonText('auto_paused', '#x')).toMatch(/paused/)
    expect(draftReasonText('draft_mode', '#x')).toBeNull()
  })
})

describe('notify node (Slack replaces iMessage)', () => {
  const node = (p: Partial<NotifyNode>): NotifyNode => ({ id: 'n', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', ...p }) as NotifyNode
  it('reads slack targets', () => {
    expect(notifySlackOf(node({ slack: { kind: 'channel', channel: 'C1' } }))).toEqual({ kind: 'channel', channel: 'C1' })
    expect(notifySlackOf(node({ slack: null }))).toBeNull()
    expect(notifySlackOf(node({}))).toBeNull()
    expect(notifyChoice({ kind: 'me' })).toBe('me')
    expect(notifyLabel({ kind: 'channel', channel: 'C1' }, () => '#support')).toBe('Slack #support')
    expect(notifyLabel(null)).toBeNull()
  })
})
