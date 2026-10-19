/**
 * Text pipeline (SLACK.md §8.4, §6, §11.2). Pure.
 * - mrkdwn -> plain (search + agents): mentions/channels resolved, links reduced to their label, markup stripped.
 * - outgoing: redact -> Markdown to mrkdwn -> defuse broadcasts -> cap 3,000 chars.
 */

export const MAX_POST_CHARS = 3000
const TRUNC = '…(truncated, full text in Hive)'
const ZWJ = '‍'

export interface Resolver {
  user(id: string): string | null
  channel(id: string): string | null
}

const decodeEntities = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Slack mrkdwn -> plain text. `<@U1>` -> `@Dana Lee`, `<#C1|support>` -> `#support`, `<url|label>` -> `label`. */
export function mrkdwnToPlain(text: string, r: Resolver): string {
  if (!text) return ''
  let s = text.replace(/<([^<>]+)>/g, (_m, inner: string) => {
    const [target, label] = splitOnce(inner, '|')
    if (target.startsWith('@')) {
      const id = target.slice(1)
      return `@${label || r.user(id) || id}`
    }
    if (target.startsWith('#')) {
      const id = target.slice(1)
      return `#${label || r.channel(id) || id}`
    }
    if (target.startsWith('!subteam^')) return `@${label?.replace(/^@/, '') || 'group'}`
    if (target.startsWith('!')) {
      const k = target.slice(1).split('^')[0]
      return `@${label?.replace(/^@/, '') || k}`
    }
    return label || target.replace(/^mailto:/, '')
  })
  s = s
    .replace(/```([\s\S]*?)```/g, (_m, c: string) => c)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^&gt;\s?/gm, '')
  return decodeEntities(s).trim()
}

function splitOnce(s: string, sep: string): [string, string | null] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]
}

/** Markdown (what agents write) -> Slack mrkdwn. Fenced code is kept verbatim. */
export function markdownToMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g)
  return parts
    .map((p) => {
      if (p.startsWith('```')) return p
      return p
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '*$1*')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    })
    .join('')
}

/** `<!channel>`, `<!here>`, `<!everyone>`, `@channel`, `@here`, `@everyone` -> plain text with a zero-width joiner. */
export function defuseBroadcasts(text: string): string {
  return text
    .replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, (_m, k: string) => `@${ZWJ}${k}`)
    .replace(/<!subteam\^[A-Z0-9]+(\|[^>]*)?>/gi, (_m, l?: string) => `@${ZWJ}${(l ?? '|group').slice(1).replace(/^@/, '')}`)
    .replace(/(^|[^\w‍])@(channel|here|everyone)\b/gi, (_m, pre: string, k: string) => `${pre}@${ZWJ}${k}`)
}

export function capText(text: string, max = MAX_POST_CHARS): string {
  return text.length > max ? `${text.slice(0, max - TRUNC.length)}${TRUNC}` : text
}

/** Every outgoing post: redact -> Markdown to mrkdwn -> defuse broadcasts -> cap. */
export function prepareOutgoing(text: string, redact: (s: string) => string = (s) => s): string {
  return capText(defuseBroadcasts(markdownToMrkdwn(redact(text))))
}

/** Distinct `<@U…>` / `<@W…>` user mentions (PO-S3d). */
export function userMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g)].map((m) => m[1]))]
}

export const mentionsUser = (text: string, userId: string): boolean => !!userId && text.includes(`<@${userId}`)

/** "1729070000.123456" -> ISO. */
export const tsToIso = (ts: string): string => new Date(Math.floor(Number(ts) * 1000)).toISOString()
export const tsToMs = (ts: string): number => Math.floor(Number(ts) * 1000)
export const msToTs = (ms: number): string => (ms / 1000).toFixed(6)
/** Numeric compare of two Slack ts strings. */
export const tsCmp = (a: string, b: string): number => {
  const [as, au = '0'] = a.split('.')
  const [bs, bu = '0'] = b.split('.')
  return Number(as) - Number(bs) || Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'))
}
export const tsMax = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : tsCmp(a, b) >= 0 ? a : b)

/** Fallback permalink when chat.getPermalink is unavailable. */
export const fallbackPermalink = (domain: string | null, channelId: string, ts: string, threadTs?: string | null): string =>
  `https://${domain || 'app'}.slack.com/archives/${channelId}/p${ts.replace('.', '')}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channelId}` : ''}`

/** Parses a Slack permalink: .../archives/<C>/p<digits>[?thread_ts=…]. */
export function parsePermalink(url: string): { channelId: string; ts: string; threadTs: string | null } | null {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/.exec(url.trim())
  if (!m) return null
  const q = new URLSearchParams(m[4] ?? '')
  return { channelId: m[1], ts: `${m[2]}.${m[3]}`, threadTs: q.get('thread_ts') }
}

/**
 * User search text -> a safe FTS5 query: every token quoted, `-x` -> `NOT "x"`, `"phrases"` kept. Returns null when
 * nothing searchable remains.
 */
export function toFtsQuery(q: string): string | null {
  const pos: string[] = []
  const neg: string[] = []
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g
  for (const m of q.matchAll(re)) {
    const negated = (m[1] || m[3]) === '-'
    const raw = (m[2] ?? m[4] ?? '').replace(/"/g, '').trim()
    const words = raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
    if (!words.length) continue
    const term = `"${words.join(' ')}"`
    ;(negated ? neg : pos).push(term)
  }
  if (!pos.length) return null
  return [pos.join(' '), ...neg.map((n) => `NOT ${n}`)].join(' ')
}

/** "[2026-10-16 09:14] Dana Lee: text" (the {{trigger.thread}} format, SLACK.md §9.2). */
export function transcriptLine(ts: string, who: string, plain: string): string {
  const d = new Date(tsToMs(ts))
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `[${stamp}] ${who}: ${plain}`
}

/** ≤ maxMsgs messages and ≤ maxChars, oldest dropped first, the parent always kept. */
export function buildTranscript(lines: string[], maxMsgs = 50, maxChars = 20_000): string {
  if (!lines.length) return ''
  const parent = lines[0]
  let rest = lines.slice(1)
  if (rest.length > maxMsgs - 1) rest = rest.slice(rest.length - (maxMsgs - 1))
  const total = () => parent.length + rest.reduce((n, l) => n + l.length + 1, 0)
  while (rest.length && total() > maxChars) rest = rest.slice(1)
  const out = [parent, ...rest].join('\n')
  return out.length > maxChars ? out.slice(0, maxChars) : out
}

/** Masks token-looking strings in log text (xoxb-, xoxp-, xapp-…). */
export function maskTokens(s: string): string {
  return s.replace(/\b(xox[abposr]|xapp)-[A-Za-z0-9-]{6,}/g, (m) => `${m.split('-')[0]}-…${m.slice(-4)}`)
}
