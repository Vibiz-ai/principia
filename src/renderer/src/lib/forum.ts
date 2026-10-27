/**
 * FORUM.md §8: pure helpers for the Forum view (grouping, inline tokens, composer autocomplete, slash commands,
 * channel ordering). No store, no DOM: unit-tested in forum.test.ts.
 */
import type { ForumChannel, ForumMember, ForumMessage, ForumPresence } from '@shared/forum'

const GROUP_GAP_MS = 5 * 60_000

export type ListItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'msg'; key: string; message: ForumMessage; head: boolean }

/** "Today", "Yesterday", "Monday, 20 October". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Day dividers, an "unread" line after `lastReadSeq`, and author runs: a message continues the previous one's header
 * when the same author posted within 5 minutes, same day, both plain text.
 */
export function groupMessages(messages: ForumMessage[], opts: { lastReadSeq?: number; me?: string; now?: Date } = {}): ListItem[] {
  const out: ListItem[] = []
  let prev: ForumMessage | null = null
  let unreadPlaced = false
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString()
    if (!prev || new Date(prev.createdAt).toDateString() !== day) {
      out.push({ kind: 'day', key: `day-${day}`, label: dayLabel(m.createdAt, opts.now) })
      prev = null
    }
    if (!unreadPlaced && opts.lastReadSeq !== undefined && opts.lastReadSeq > 0 && m.seq > opts.lastReadSeq && m.authorId !== opts.me) {
      out.push({ kind: 'unread', key: `unread-${m.seq}` })
      unreadPlaced = true
      prev = null
    }
    const head =
      !prev ||
      prev.authorId !== m.authorId ||
      m.kind !== 'text' ||
      prev.kind !== 'text' ||
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) > GROUP_GAP_MS
    out.push({ kind: 'msg', key: m.id, message: m, head })
    prev = m
  }
  return out
}

export type Token =
  | { t: 'text'; v: string }
  | { t: 'mention'; v: string; handle: string }
  | { t: 'channel'; v: string; name: string }
  | { t: 'task'; v: string }
  | { t: 'note'; v: string; title: string }
  | { t: 'url'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'msgref'; v: string }
  | { t: 'br' }

// five doors step 2: task ids carry their company's prefix (NC-12, LA-3); the case-insensitive flag is the other tokens'
const TOKEN_RE = /(`[^`\n]{1,400}`)|(\*\*[^*\n]{1,200}\*\*)|((?:https?|principia):\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])|(\[\[[^[\]\n]{1,200}\]\])|((?:^|(?<=[\s(]))@[a-z0-9][a-z0-9._-]{0,31})|((?:^|(?<=[\s(]))#[a-z0-9][a-z0-9-]{1,39})|(\b[A-Z][A-Z0-9]{1,4}-\d{1,7}\b)|((?:^|(?<=[\s(]))m[0-9a-z]*\d[0-9a-z]*(?=$|[\s),.:;!?]))|(\n)/gi

/** Inline tokens of a message text: mentions, channels, task ids, [[notes]], URLs, `code`, **bold**, m3fk refs. */
export function tokenize(text: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ t: 'text', v: text.slice(last, i) })
    const v = m[0]
    if (m[1]) out.push({ t: 'code', v: v.slice(1, -1) })
    else if (m[2]) out.push({ t: 'bold', v: v.slice(2, -2) })
    else if (m[3]) out.push({ t: 'url', v })
    else if (m[4]) out.push({ t: 'note', v, title: v.slice(2, -2).split(/[#^|]/)[0].trim() })
    else if (m[5]) out.push({ t: 'mention', v, handle: v.slice(1).toLowerCase().replace(/[._-]+$/, '') })
    else if (m[6]) out.push({ t: 'channel', v, name: v.slice(1).toLowerCase() })
    else if (m[7]) out.push({ t: 'task', v: v.toUpperCase() })
    else if (m[8] && v.length <= 9) out.push({ t: 'msgref', v })
    else if (m[9]) out.push({ t: 'br' })
    else out.push({ t: 'text', v })
    last = i + v.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/** The autocomplete trigger under the caret: `@que`, `#mar` or a leading `/comm`. */
export function activeTrigger(text: string, caret: number): { trigger: '@' | '#' | '/'; query: string; start: number } | null {
  const before = text.slice(0, caret)
  const slash = /^\/([a-z]*)$/i.exec(before)
  if (slash) return { trigger: '/', query: slash[1].toLowerCase(), start: 0 }
  const m = /(^|[\s(])([@#])([a-z0-9._-]{0,32})$/i.exec(before)
  if (!m) return null
  return { trigger: m[2] as '@' | '#', query: m[3].toLowerCase(), start: before.length - m[3].length - 1 }
}

export interface Suggestion {
  key: string
  insert: string
  label: string
  detail: string
  kind: 'agent' | 'human' | 'guest' | 'department' | 'channel' | 'command' | 'broadcast'
  memberId?: string
  working?: boolean
}

export const SLASH_COMMANDS: readonly { name: string; args: string; detail: string }[] = [
  { name: 'invite', args: '@member …', detail: 'Add people or agents to this channel' },
  { name: 'ask', args: '@who question', detail: 'Ask someone; it waits in their Needs you' },
  { name: 'propose', args: 'department | agent', detail: 'Propose a new department or a hire' },
  { name: 'task', args: 'title', detail: 'Make a board task from this' },
  { name: 'visualize', args: '@agent what', detail: 'Ask an agent to draw it as a diagram' },
  { name: 'topic', args: 'text', detail: 'Set the channel topic' },
  { name: 'leave', args: '', detail: 'Leave this channel' }
]

/** Ranked by prefix, then substring; agents working first among ties. */
export function suggest(
  trigger: '@' | '#' | '/',
  query: string,
  src: { members: (ForumMember & { role2?: string; working?: boolean })[]; departments: { key: string; name: string; agents: number }[]; channels: ForumChannel[]; me: string }
): Suggestion[] {
  const q = query.toLowerCase()
  const score = (...fields: string[]) => {
    let best = Infinity
    for (const f of fields) {
      const s = f.toLowerCase()
      if (s.startsWith(q)) best = Math.min(best, 0)
      else if (s.includes(q)) best = Math.min(best, 1)
    }
    return best
  }
  const ranked = <T>(items: { item: T; s: number; tie: number }[]) => items.filter((x) => x.s < Infinity).sort((a, b) => a.s - b.s || a.tie - b.tie).map((x) => x.item)
  if (trigger === '/') {
    return ranked(SLASH_COMMANDS.map((c, i) => ({ item: { key: c.name, insert: `/${c.name} `, label: `/${c.name}`, detail: c.args ? `${c.args} · ${c.detail}` : c.detail, kind: 'command' as const }, s: score(c.name), tie: i })))
  }
  if (trigger === '#') {
    return ranked(src.channels.filter((c) => c.name && !c.archivedAt).map((c, i) => ({ item: { key: c.id, insert: `#${c.name} `, label: `#${c.name}`, detail: c.purpose, kind: 'channel' as const }, s: score(c.name!), tie: i }))).slice(0, 8)
  }
  type Ranked = { item: Suggestion; s: number; tie: number }
  const people: Ranked[] = src.members
    .filter((m) => m.status === 'active' && m.id !== src.me)
    .map((m, i) => ({
      item: { key: m.id, insert: `@${m.handle} `, label: m.name, detail: m.kind === 'agent' ? (m.role2 ?? 'agent') : m.kind === 'guest' ? 'guest' : m.role, kind: (m.kind === 'agent' ? 'agent' : m.kind === 'guest' ? 'guest' : 'human') as Suggestion['kind'], memberId: m.id, working: m.working },
      s: score(m.handle, m.name, m.role2 ?? ''),
      tie: (m.working ? 0 : 100) + (m.kind === 'agent' ? 0 : 50) + i
    }))
  const deps: Ranked[] = src.departments.map((d, i) => ({ item: { key: `dep:${d.key}`, insert: `@${d.key} `, label: d.name, detail: `@${d.key} · ${d.agents} agent${d.agents === 1 ? '' : 's'}`, kind: 'department' as const }, s: score(d.key, d.name), tie: 500 + i }))
  const here: Ranked = { item: { key: 'here', insert: '@here ', label: 'here', detail: 'Everyone in this channel', kind: 'broadcast' as const }, s: score('here', 'channel'), tie: 900 }
  return ranked([...people, ...deps, here]).slice(0, 9)
}

export type SlashCommand =
  | { cmd: 'invite'; handles: string[] }
  | { cmd: 'ask'; handles: string[]; question: string; options: string[] }
  | { cmd: 'propose'; kind: 'department' | 'agent' | null }
  | { cmd: 'task'; title: string }
  | { cmd: 'visualize'; handles: string[]; what: string }
  | { cmd: 'topic'; text: string }
  | { cmd: 'leave' }
  | { cmd: 'unknown'; name: string }

/** `/ask @ana Which tone? [playful|plain]` → handles, question, options. null = not a command. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return null
  const rest = (m[2] ?? '').trim()
  const handles = [...rest.matchAll(/@([a-z0-9][a-z0-9._-]{0,31})/gi)].map((x) => x[1].toLowerCase())
  switch (m[1].toLowerCase()) {
    case 'invite':
      return { cmd: 'invite', handles }
    case 'ask': {
      const opts = /\[([^\]]+)\]\s*$/.exec(rest)
      const options = opts ? opts[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6) : []
      const question = rest.replace(/\[[^\]]+\]\s*$/, '').replace(/@[a-z0-9][a-z0-9._-]{0,31}/gi, '').replace(/\s+/g, ' ').trim()
      return { cmd: 'ask', handles, question, options: options.length >= 2 ? options : [] }
    }
    case 'propose': {
      const k = rest.toLowerCase()
      return { cmd: 'propose', kind: k.startsWith('dep') ? 'department' : k.startsWith('agent') || k.startsWith('hire') ? 'agent' : null }
    }
    case 'task':
      return { cmd: 'task', title: rest }
    case 'visualize':
      return { cmd: 'visualize', handles, what: rest.replace(/@[a-z0-9][a-z0-9._-]{0,31}/gi, '').replace(/\s+/g, ' ').trim() }
    case 'topic':
      return { cmd: 'topic', text: rest }
    case 'leave':
      return { cmd: 'leave' }
    default:
      return { cmd: 'unknown', name: m[1] }
  }
}

/** Sidebar order: system channels first (#general), then by name; DMs by last activity. */
export function sortChannels(channels: ForumChannel[]): { channels: ForumChannel[]; dms: ForumChannel[] } {
  const named = channels.filter((c) => c.name && !c.archivedAt && (c.joined || c.kind === 'public'))
  const sys = (c: ForumChannel) => (c.system === 'general' ? 0 : c.system === 'proposals' ? 2 : 1)
  named.sort((a, b) => sys(a) - sys(b) || Number(b.joined) - Number(a.joined) || a.name!.localeCompare(b.name!))
  const dms = channels.filter((c) => !c.name && c.joined).sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
  return { channels: named, dms }
}

export function unreadTotals(channels: ForumChannel[]): { unread: number; mentions: number; channelsWithUnread: number } {
  let unread = 0
  let mentions = 0
  let channelsWithUnread = 0
  for (const c of channels) {
    if (!c.joined) continue
    unread += c.unread
    mentions += c.mentions + (!c.name ? c.unread : 0)
    if (c.unread) channelsWithUnread++
  }
  return { unread, mentions, channelsWithUnread }
}

/** "Marcus is reading #marketing · Livia is working" for the presence line of a channel. */
export function presenceLine(presence: ForumPresence[], channel: Pick<ForumChannel, 'id' | 'memberIds' | 'name'>, nameOf: (id: string) => string | null): string {
  const parts: string[] = []
  for (const p of presence) {
    const name = nameOf(p.memberId)
    if (!name) continue
    if ((p.state === 'reading' || p.state === 'composing') && p.channelId === channel.id) parts.push(`${name} is ${p.state === 'composing' ? 'writing' : 'reading'}${channel.name ? ` #${channel.name}` : ''}`)
    else if (p.state === 'working' && channel.memberIds.includes(p.memberId)) parts.push(`${name} is working`)
  }
  return parts.slice(0, 3).join(' · ')
}

export const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❓'] as const
