/**
 * Pure Slack helpers for the renderer (SLACK.md §12): mrkdwn parsing (safe: produces a token tree, never HTML),
 * trigger sentences and form validation (PO-S3c), message grouping, status labels, draft-card state.
 * No DOM, no window.hive: unit-tested in node (lib/slack.test.ts).
 */
import type { NotifyNode, Workflow, WorkflowDraft } from '@shared/types'
import {
  SLACK_AUTO_LIMITS,
  autoModeProblem,
  defaultDebounceSec,
  type NotifySlackTarget,
  type SlackChannel,
  type SlackDraft,
  type SlackDraftReason,
  type SlackMessage,
  type SlackReplyMode,
  type SlackStatus,
  type SlackTriggerEventKind,
  type SlackTriggerInput,
  type SlackTriggerOn,
  type SlackUser
} from '@shared/slack'

/** chat.postMessage text cap Principia enforces (SLACK.md §8.3). */
export const SLACK_TEXT_MAX = 3000

// =====================================================================================================================
// mrkdwn → token tree
// =====================================================================================================================

export type MInline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: MInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; url: string; label: string }
  | { t: 'user'; id: string; label: string | null }
  | { t: 'channel'; id: string; label: string | null }
  | { t: 'broadcast'; v: string }
  | { t: 'br' }
export type MBlock = { t: 'p'; c: MInline[] } | { t: 'pre'; v: string } | { t: 'quote'; c: MInline[] }

/** Slack escapes only these three in message text. */
export function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Only these schemes become clickable (opened with app:openExternal, https only on main's side). */
export function safeUrl(url: string): string | null {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) && !/[\s"'<>`]/.test(u) ? u : null
}

/** Parses Slack's `<…>` entity body: `@U123|name`, `#C123|general`, `!here`, `https://x|label`. */
function entity(body: string): MInline {
  const [head, ...rest] = body.split('|')
  const label = rest.length ? unescapeSlack(rest.join('|')) : null
  const h = head ?? ''
  if (h.startsWith('@')) return { t: 'user', id: h.slice(1), label }
  if (h.startsWith('#')) return { t: 'channel', id: h.slice(1), label }
  if (h.startsWith('!')) {
    const name = h.slice(1).split('^')[0] ?? ''
    if (name === 'here' || name === 'channel' || name === 'everyone') return { t: 'broadcast', v: `@${name}` }
    if (name.startsWith('subteam')) return { t: 'text', v: label ?? '@group' }
    if (name.startsWith('date')) return { t: 'text', v: label ?? unescapeSlack(rest[rest.length - 1] ?? '') }
    return { t: 'text', v: label ?? `@${name}` }
  }
  const url = unescapeSlack(h)
  const safe = safeUrl(url)
  if (safe) return { t: 'link', url: safe, label: label ?? url }
  return { t: 'text', v: label ?? url }
}

const MARKS: Record<string, 'b' | 'i' | 's'> = { '*': 'b', _: 'i', '~': 's' }
const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c)

/** Inline mrkdwn: entities, `code`, *bold*, _italic_, ~strike~ (emphasis only on word boundaries, like Slack). */
export function parseInline(src: string, depth = 0): MInline[] {
  const out: MInline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: unescapeSlack(buf) })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (ch === '<') {
      const end = src.indexOf('>', i + 1)
      if (end > i + 1 && !src.slice(i + 1, end).includes('\n')) {
        flush()
        out.push(entity(src.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'code', v: unescapeSlack(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    const mark = MARKS[ch]
    if (mark && depth < 4 && !isWordChar(src[i - 1]) && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== ch) {
      // find the closing mark: not preceded by a space, not followed by a word char, same line
      let j = i + 1
      let close = -1
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === ch && src[j - 1] !== ' ' && !isWordChar(src[j + 1])) {
          close = j
          break
        }
        j++
      }
      if (close > i + 1) {
        flush()
        out.push({ t: mark, c: parseInline(src.slice(i + 1, close), depth + 1) })
        i = close + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

/** Blocks: ``` fences → pre, lines starting with ">" (escaped &gt;) → quote, the rest → paragraphs. */
export function parseMrkdwn(text: string): MBlock[] {
  const blocks: MBlock[] = []
  const parts = text.split('```')
  parts.forEach((part, idx) => {
    if (idx % 2 === 1 && idx < parts.length - 1) {
      blocks.push({ t: 'pre', v: unescapeSlack(part.replace(/^\n/, '').replace(/\n$/, '')) })
      return
    }
    // an unclosed fence is plain text
    const chunk = idx % 2 === 1 ? '```' + part : part
    let para: string[] = []
    let quote: string[] = []
    const flushPara = (): void => {
      const s = para.join('\n')
      if (s.trim()) blocks.push({ t: 'p', c: parseInline(s.replace(/^\n+|\n+$/g, '')) })
      para = []
    }
    const flushQuote = (): void => {
      if (quote.length) blocks.push({ t: 'quote', c: parseInline(quote.join('\n')) })
      quote = []
    }
    for (const line of chunk.split('\n')) {
      const q = /^(&gt;|>)\s?(.*)$/.exec(line)
      if (q) {
        flushPara()
        quote.push(q[2] ?? '')
      } else {
        flushQuote()
        para.push(line)
      }
    }
    flushPara()
    flushQuote()
  })
  return blocks
}

/** One-line preview of mrkdwn (lists, search, cards). */
export function mrkdwnPreview(text: string, resolve?: { user?: (id: string) => string | null; channel?: (id: string) => string | null }, max = 140): string {
  const flat = (c: MInline[]): string =>
    c
      .map((n) => {
        switch (n.t) {
          case 'text':
            return n.v
          case 'b':
          case 'i':
          case 's':
            return flat(n.c)
          case 'code':
            return n.v
          case 'link':
            return n.label
          case 'user':
            return `@${n.label ?? resolve?.user?.(n.id) ?? n.id}`
          case 'channel':
            return `#${n.label ?? resolve?.channel?.(n.id) ?? n.id}`
          case 'broadcast':
            return n.v
          case 'br':
            return ' '
        }
      })
      .join('')
  const s = parseMrkdwn(text)
    .map((b) => (b.t === 'pre' ? b.v : flat(b.c)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Search snippets wrap matches in «»; split for highlighting. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  const re = /«([^»]*)»/g
  let last = 0
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), hit: false })
    out.push({ text: m[1] ?? '', hit: true })
    last = m.index + m[0].length
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false })
  return out
}

// =====================================================================================================================
// names, times, grouping
// =====================================================================================================================

export function userName(u: SlackUser | null | undefined, fallbackId?: string | null): string {
  if (!u) return fallbackId ?? 'Unknown'
  return u.displayName?.trim() || u.realName?.trim() || u.name || u.id
}
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase()
}
export function channelLabel(c: SlackChannel | null | undefined, users?: Record<string, SlackUser>): string {
  if (!c) return 'unknown'
  if (c.kind === 'dm') return c.dmUserId && users?.[c.dmUserId] ? userName(users[c.dmUserId]) : c.name
  if (c.kind === 'group_dm') return c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ')
  return `#${c.name}`
}
/** "#support", "DM with Dana Lee" — card titles, sentences. */
export function channelPhrase(c: SlackChannel | null | undefined, users?: Record<string, SlackUser>): string {
  if (!c) return 'a channel'
  return c.kind === 'dm' ? `DM with ${channelLabel(c, users)}` : channelLabel(c, users)
}

export function tsToMs(ts: string | null | undefined): number {
  if (!ts) return 0
  const n = Number(ts)
  return Number.isFinite(n) ? Math.round(n * 1000) : 0
}
export function tsToIso(ts: string | null | undefined): string | null {
  const ms = tsToMs(ts)
  return ms ? new Date(ms).toISOString() : null
}
/** Slack ts strings compare numerically (string compare breaks on differing lengths). */
export function cmpTs(a: string | null | undefined, b: string | null | undefined): number {
  return tsToMs(a) - tsToMs(b) || (a ?? '').localeCompare(b ?? '')
}

/** https://acme.slack.com/archives/C123/p1700000000123456(?thread_ts=…) → {channelId, ts}. */
export function parsePermalink(url: string): { channelId: string; ts: string } | null {
  const m = /\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url.trim())
  return m ? { channelId: m[1]!, ts: `${m[2]}.${m[3]}` } : null
}

const SYSTEM_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive', 'group_join', 'group_leave'])
export function isSystemMessage(m: SlackMessage): boolean {
  if (!m.subtype) return false
  if (SYSTEM_SUBTYPES.has(m.subtype)) return true
  return !['thread_broadcast', 'file_share', 'me_message', 'bot_message'].includes(m.subtype)
}

/** Merge by ts (live updates replace edits/deletes in place), sorted oldest first. */
export function mergeMessages(cur: SlackMessage[], incoming: SlackMessage[]): SlackMessage[] {
  const m = new Map(cur.map((x) => [x.ts, x]))
  for (const x of incoming) m.set(x.ts, x)
  return [...m.values()].sort((a, b) => cmpTs(a.ts, b.ts))
}
/** Channel timeline rows: top-level messages and "also send to channel" replies. */
export const isTopLevel = (m: SlackMessage): boolean => !m.threadTs || m.threadTs === m.ts || m.subtype === 'thread_broadcast'

export interface MessageGroup {
  key: string
  authorId: string | null
  fromHive: boolean
  system: boolean
  messages: SlackMessage[]
}
/** Consecutive messages by the same author within 5 min form one group (SLACK.md §12.2). System lines stand alone. */
export function groupMessages(msgs: SlackMessage[], windowMs = 5 * 60_000): MessageGroup[] {
  const out: MessageGroup[] = []
  for (const m of msgs) {
    const author = m.userId ?? m.botId
    const system = isSystemMessage(m)
    const last = out[out.length - 1]
    const prev = last?.messages[last.messages.length - 1]
    if (last && prev && !system && !last.system && last.authorId === author && last.fromHive === m.fromHive && !m.deleted && !prev.deleted && tsToMs(m.ts) - tsToMs(prev.ts) <= windowMs) {
      last.messages.push(m)
    } else out.push({ key: m.ts, authorId: author, fromHive: m.fromHive, system, messages: [m] })
  }
  return out
}

export interface ChannelSections {
  dms: SlackChannel[]
  channels: SlackChannel[]
  notJoined: SlackChannel[]
}
/** Left column (§12.2): DMs, member channels, then channels the bot is not in (public: Join; private: /invite). */
export function channelSections(list: SlackChannel[], query = ''): ChannelSections {
  const q = query.trim().toLowerCase().replace(/^[#@]/, '')
  const keep = (c: SlackChannel): boolean => !c.isArchived && (!q || c.name.toLowerCase().includes(q))
  const byRecent = (a: SlackChannel, b: SlackChannel): number => cmpTs(b.lastMessageTs, a.lastMessageTs) || a.name.localeCompare(b.name)
  const byName = (a: SlackChannel, b: SlackChannel): number => a.name.localeCompare(b.name)
  return {
    dms: list.filter((c) => keep(c) && (c.kind === 'dm' || c.kind === 'group_dm')).sort(byRecent),
    channels: list.filter((c) => keep(c) && (c.kind === 'channel' || c.kind === 'private') && c.isMember).sort(byName),
    notJoined: list.filter((c) => keep(c) && (c.kind === 'channel' || c.kind === 'private') && !c.isMember).sort(byName)
  }
}
/** Public channels a "Join all public channels" click would join (PO-S2). */
export function joinablePublic(list: SlackChannel[]): SlackChannel[] {
  return list.filter((c) => c.kind === 'channel' && !c.isMember && !c.isArchived)
}

// =====================================================================================================================
// connection status / setup
// =====================================================================================================================

export type Tone = 'passed' | 'running' | 'warning' | 'failed' | 'idle' | 'canceled'
export function statusPill(s: SlackStatus | null, now = Date.now()): { text: string; tone: Tone } {
  if (!s) return { text: 'Not available', tone: 'canceled' }
  switch (s.state) {
    case 'disabled':
      return { text: 'Not connected', tone: 'idle' }
    case 'connecting':
      return { text: 'Connecting…', tone: 'running' }
    case 'connected':
      return { text: s.workspace ? `Connected to ${s.workspace.name} · @${s.workspace.botName}` : 'Connected', tone: s.warnings.length || s.missingScopes.length ? 'warning' : 'passed' }
    case 'reconnecting': {
      const sec = s.nextRetryAt ? Math.max(0, Math.round((Date.parse(s.nextRetryAt) - now) / 1000)) : null
      return { text: sec !== null && sec > 0 ? `Reconnecting in ${sec} s` : 'Reconnecting…', tone: 'warning' }
    }
    case 'paused':
      return { text: 'Paused (sleep)', tone: 'canceled' }
    case 'error':
      return { text: 'Error', tone: 'failed' }
  }
}
export function syncLine(s: SlackStatus | null): string | null {
  if (!s || s.sync.state !== 'running') return null
  const threads = s.sync.threadsPending ? ` · ${s.sync.threadsPending} thread${s.sync.threadsPending === 1 ? '' : 's'}` : ''
  return `Syncing ${s.sync.channelsDone}/${s.sync.channelsTotal} channels${threads} · ${s.sync.days} days`
}

export const TOKEN_SHAPES = { bot: /^xoxb-[A-Za-z0-9-]{20,}$/, app: /^xapp-[A-Za-z0-9-]{20,}$/ } as const
/** Inline prefix check while typing (§12.1). null = fine (or empty). */
export function tokenProblem(kind: 'bot' | 'app', value: string): string | null {
  const v = value.trim()
  if (!v) return null
  const prefix = kind === 'bot' ? 'xoxb-' : 'xapp-'
  if (kind === 'bot' && v.startsWith('xapp-')) return 'That is the app-level token. Paste it in the field above.'
  if (kind === 'app' && v.startsWith('xoxb-')) return 'That is the bot token. Paste it in the next step.'
  if (!v.startsWith(prefix)) return `Starts with ${prefix}`
  if (!TOKEN_SHAPES[kind].test(v)) return 'Looks incomplete. Copy the whole token.'
  return null
}

/** PO-S1: Slack pre-fills the manifest from this link. */
export function manifestCreateUrl(manifestJson: string): string {
  let compact = manifestJson
  try {
    compact = JSON.stringify(JSON.parse(manifestJson))
  } catch {
    /* keep as given */
  }
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(compact)}`
}

// =====================================================================================================================
// triggers
// =====================================================================================================================

export const TRIGGER_REFS = ['trigger.text', 'trigger.thread', 'trigger.channel', 'trigger.channel_id', 'trigger.ts', 'trigger.thread_ts', 'trigger.user', 'trigger.user_id', 'trigger.permalink'] as const

/** PO-S10: the workflow's last agent node (in node order). */
export function lastAgentNodeId(draft: Pick<WorkflowDraft, 'nodes'> | null | undefined): string | null {
  const agents = (draft?.nodes ?? []).filter((n) => n.type === 'agent')
  return agents.length ? agents[agents.length - 1]!.id : null
}

export function defaultTrigger(w: Pick<Workflow, 'id' | 'name' | 'nodes'> | null, botName = 'hive'): SlackTriggerInput {
  return {
    name: w ? `${w.name} · Slack` : `When @${botName} is mentioned`,
    workflowId: w?.id ?? '',
    enabled: true,
    match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] },
    reply: { mode: 'draft', autoChannels: [], replyNode: lastAgentNodeId(w) },
    limits: { debounceSec: defaultDebounceSec(['mention']), maxRunsPerThreadPerHour: 4 },
    inputs: {}
  }
}

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : xs.length === 2 ? `${xs[0]} or ${xs[1]}` : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`)

export interface Namer {
  channel: (id: string) => string
  user: (id: string) => string
  bot: string
}
const defaultNamer: Namer = { channel: (id) => (id === 'dm' ? 'DMs' : `#${id}`), user: (id) => id, bot: 'hive' }

/** "When @hive is mentioned in #support · replies as drafts" (live preview, list rows, approval card). */
export function triggerSentence(t: Pick<SlackTriggerInput, 'match' | 'reply'>, n: Partial<Namer> = {}): string {
  const nm = { ...defaultNamer, ...n }
  const on = new Set(t.match.on)
  const chans = t.match.channels.map(nm.channel)
  const parts: string[] = []
  if (on.has('mention')) parts.push(`@${nm.bot} is mentioned${chans.length ? ` in ${list(chans)}` : ''}`)
  if (on.has('dm')) parts.push(`someone DMs @${nm.bot}`)
  if (on.has('message')) parts.push(chans.length ? `a message is posted in ${list(chans)}` : 'a message is posted')
  let s = parts.length ? `When ${parts.join(', or ')}` : 'Never (pick at least one “When”)'
  const filters: string[] = []
  const kw = t.match.keywords.filter((k) => k.trim())
  if (kw.length) filters.push(`it contains ${list(kw.map((k) => `“${k}”`))}`)
  if (t.match.regex?.trim()) filters.push(`it matches /${t.match.regex.trim()}/`)
  if (t.match.fromUsers.length) filters.push(`it is from ${list(t.match.fromUsers.map(nm.user))}`)
  if (filters.length) s += ` and ${filters.join(' and ')}`
  return `${s} · ${replyPhrase(t.reply.mode, t.reply.autoChannels, nm)}`
}
export function replyPhrase(mode: SlackReplyMode, autoChannels: string[], n: Partial<Namer> = {}): string {
  const nm = { ...defaultNamer, ...n }
  if (mode === 'none') return 'no reply'
  if (mode === 'draft') return 'replies as drafts'
  if (autoChannels.includes('*')) return 'auto-replies wherever it is tagged'
  return `auto-replies in ${autoChannels.length ? list(autoChannels.map(nm.channel)) : '(no channels)'}`
}

/** The approval card's reply-mode row (§9.5): own row, amber for auto, limits spelled out. */
export function replyModeRow(mode: SlackReplyMode, autoChannels: string[], maxPerThread: number, n: Partial<Namer> = {}): { tone: 'neutral' | 'amber'; text: string } {
  const nm = { ...defaultNamer, ...n }
  if (mode === 'draft') return { tone: 'neutral', text: 'Replies: as drafts you approve (Needs you)' }
  if (mode === 'none') return { tone: 'neutral', text: 'Replies: none' }
  const where = autoChannels.includes('*') ? 'any conversation where it is tagged or DMed' : autoChannels.length ? autoChannels.map(nm.channel).join(', ') : '(no channels)'
  return { tone: 'amber', text: `Replies: AUTO-POSTS in ${where} (no approval) · 1 post per run · max ${maxPerThread} per thread and ${SLACK_AUTO_LIMITS.perChannelPerHour} per channel per hour` }
}

export interface TriggerProblem {
  path: string
  message: string
}
function regexProblem(src: string): string | null {
  try {
    new RegExp(src, 'i')
    return null
  } catch (e) {
    return `Not a valid regex: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`
  }
}
/** Template refs in a trigger input value that are not {{trigger.*}} (§9.2: inputs may reference only trigger.*). */
export function nonTriggerRefs(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const ref = m[1]!
    if (!(TRIGGER_REFS as readonly string[]).includes(ref)) out.push(ref)
  }
  return out
}

/** Client-side checks mirroring main's `validation` (§9.1, PO-S3c). Main stays the authority. */
export function validateTriggerInput(t: SlackTriggerInput, required: string[] = []): TriggerProblem[] {
  const p: TriggerProblem[] = []
  if (!t.name.trim()) p.push({ path: 'name', message: 'Give it a name.' })
  if (!t.workflowId) p.push({ path: 'workflowId', message: 'Pick a workflow.' })
  if (!t.match.on.length) p.push({ path: 'match.on', message: 'Pick at least one “When”.' })
  if (t.match.on.includes('message') && !t.match.channels.length) p.push({ path: 'match.channels', message: '“Any message in…” needs at least one channel.' })
  if (t.match.keywords.length > 20) p.push({ path: 'match.keywords', message: 'At most 20 keywords.' })
  if (t.match.keywords.some((k) => k.length > 100)) p.push({ path: 'match.keywords', message: 'Keywords are at most 100 characters.' })
  if (t.match.regex) {
    if (t.match.regex.length > 300) p.push({ path: 'match.regex', message: 'Regex is at most 300 characters.' })
    const r = regexProblem(t.match.regex)
    if (r) p.push({ path: 'match.regex', message: r })
  }
  if (t.reply.mode === 'auto') {
    if (!t.reply.autoChannels.length) p.push({ path: 'reply.autoChannels', message: 'Auto needs at least one allowed channel (or DMs).' })
    const blocked = autoModeProblem(t.match)
    if (blocked) p.push({ path: 'reply.mode', message: blocked })
  }
  const d = t.limits?.debounceSec
  if (d !== undefined && (d < 0 || d > 600)) p.push({ path: 'limits.debounceSec', message: 'Debounce is 0–600 s.' })
  const m = t.limits?.maxRunsPerThreadPerHour
  if (m !== undefined && (m < 1 || m > 30)) p.push({ path: 'limits.maxRunsPerThreadPerHour', message: 'Runs per thread per hour is 1–30.' })
  for (const [k, v] of Object.entries(t.inputs ?? {})) {
    const bad = nonTriggerRefs(v)
    if (bad.length) p.push({ path: `inputs.${k}`, message: `Only {{trigger.*}} works here (not {{${bad[0]}}}).` })
  }
  for (const name of required) if (!(t.inputs?.[name] ?? '').trim()) p.push({ path: `inputs.${name}`, message: `Input “${name}” has no default: map it.` })
  return p
}

/** Toggling a "When" checkbox: keeps the debounce on its default unless the user changed it (PO-S9). */
export function toggleOn(t: SlackTriggerInput, which: SlackTriggerOn, checked: boolean): SlackTriggerInput {
  const on = (checked ? [...new Set([...t.match.on, which])] : t.match.on.filter((x) => x !== which)) as SlackTriggerOn[]
  const order: SlackTriggerOn[] = ['mention', 'dm', 'message']
  on.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const wasDefault = (t.limits?.debounceSec ?? defaultDebounceSec(t.match.on)) === defaultDebounceSec(t.match.on)
  const limits = { debounceSec: t.limits?.debounceSec ?? defaultDebounceSec(on), maxRunsPerThreadPerHour: t.limits?.maxRunsPerThreadPerHour ?? 4 }
  if (wasDefault) limits.debounceSec = defaultDebounceSec(on)
  return { ...t, match: { ...t.match, on }, limits }
}

const EVENT_TEXT: Record<SlackTriggerEventKind, string> = {
  fired: 'Started a run',
  debounced: 'Waiting for more messages',
  coalesced: 'Queued: a run is already answering this thread',
  skipped_own: 'Skipped: Principia’s own message',
  skipped_bot: 'Skipped: sent by another bot',
  skipped_limit: 'Skipped: hit the runs-per-hour limit',
  skipped_stale: 'Skipped: the message was too old',
  skipped_paused: 'Skipped: Slack or schedules were paused',
  error: 'Couldn’t start the run'
}
export function triggerEventText(kind: SlackTriggerEventKind): string {
  return EVENT_TEXT[kind]
}

// =====================================================================================================================
// drafts
// =====================================================================================================================

export function draftReasonText(reason: SlackDraftReason, channel: string): string | null {
  switch (reason) {
    case 'not_allowlisted':
      return `Saved as draft: ${channel} is not in the auto list`
    case 'other_thread':
      return 'Saved as draft: auto only replies in the thread that triggered the run'
    case 'auto_limit':
      return 'Saved as draft: the auto-reply limit was reached'
    case 'auto_paused':
      return 'Saved as draft: auto-replies are paused'
    default:
      return null
  }
}
export function draftTitle(d: Pick<SlackDraft, 'channelName' | 'threadTs'>): string {
  const n = d.channelName
  return n.startsWith('#') || !n ? `Reply in ${n || 'Slack'}` : `Reply to ${n} (DM)`
}

export interface DraftEditState {
  count: number
  over: boolean
  empty: boolean
  canSend: boolean
}
export function draftEditState(text: string, status: SlackDraft['status'], busy = false): DraftEditState {
  const count = [...text].length
  const over = count > SLACK_TEXT_MAX
  const empty = !text.trim()
  return { count, over, empty, canSend: !busy && !over && !empty && (status === 'pending' || status === 'failed') }
}

// =====================================================================================================================
// notify node (SLACK.md §10)
// =====================================================================================================================

export type NotifyChoice = 'off' | 'me' | 'channel'
/** The node's Slack target (null = Mac notification only). Stored nodes were migrated off iMessage (SLACK.md §10.4). */
export function notifySlackOf(n: NotifyNode): NotifySlackTarget | null {
  return n.slack ?? null
}
export function notifyChoice(t: NotifySlackTarget | null): NotifyChoice {
  return !t ? 'off' : t.kind
}
export function notifyLabel(t: NotifySlackTarget | null, channelName?: (id: string) => string): string | null {
  if (!t) return null
  return t.kind === 'me' ? 'Slack DM' : `Slack ${channelName ? channelName(t.channel) : t.channel}`
}
