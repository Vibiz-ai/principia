/**
 * Usage / rate-limit classification (LANDSCAPE.md "Elon's cut" #4). Pure: no I/O, injectable clock.
 *
 * Sources, strictest first:
 * - structured stream lines: claude `rate_limit_event` with `rate_limit_info.status: "rejected"` (+ `resetsAt`, epoch s),
 *   claude assistant messages with `error: "rate_limit"`, claude `result` errors, codex `error` / `turn.failed`,
 *   gemini / cursor `error` and `result` events;
 * - claude's interactive `StopFailure` hook with `error: "rate_limit"` (+ `last_assistant_message`);
 * - CLI text (stderr, PTY screen, error strings), matched only against the CLIs' own wording:
 *   claude  "You've hit your session limit · resets 3pm (Europe/Madrid)", "5-hour limit reached ∙ resets 3pm",
 *           "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
 *           "Claude AI usage limit reached|1760000000", "API Error: 429 … rate_limit_error";
 *   codex   "You've hit your usage limit. … try again at 3:05 PM." / "… try again in 2 days 3 hours 5 minutes.",
 *           "exceeded retry limit, last status: 429 Too Many Requests";
 *   gemini  "You have exhausted your capacity on this model. Your quota will reset after 2h32m15s.",
 *           "Usage limit reached for all Pro models.", "Quota exceeded for quota metric …", RESOURCE_EXHAUSTED;
 *   cursor  "You've hit your usage limit …" (same shape as codex).
 * Reset times are parsed when the CLI says them; otherwise resetAt is null.
 */
import type { AdapterId, ISODate } from '../../../shared/types'

export interface LimitHit {
  /** The CLI's own line (trimmed, ≤ 300 chars). */
  message: string
  resetAt: ISODate | null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** CLI wording that means "you are out of quota / rate limited" (never generic prose like "rate limiting"). */
const LIMIT_TEXT: RegExp[] = [
  /You[’']ve (?:hit|reached) your [\w’' -]{0,40}?limit/i,
  /\b\d+-hour limit reached\b/i,
  /\b(?:Claude(?: AI)?|session|weekly|Opus|Sonnet) (?:usage )?limit reached\b/i,
  /\busage limit reached\b/i,
  /\bYour limit will reset at\b/i,
  /\bAPI Error: 429\b/i,
  /\brate_limit_error\b/,
  /\blast status: 429\b/i,
  /\b429 Too Many Requests\b/i,
  /\bYou have exhausted your (?:daily )?(?:quota|capacity)\b/i,
  /\bUsage limit reached for\b/i,
  /\bQuota exceeded for quota metric\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\byour quota will reset\b/i
]

/**
 * PTY screens show the agent's own prose too, so they only accept the CLIs' banner shapes (never a bare "429" or
 * RESOURCE_EXHAUSTED that an agent may quote while working on rate-limiting code).
 */
const STRICT_TEXT: RegExp[] = [
  /You[’']ve (?:hit|reached) your [\w’' -]{0,40}?limit\b/i,
  /\b\d+-hour limit reached\b/i,
  /\b(?:Claude(?: AI)?|session|weekly|Opus|Sonnet) (?:usage )?limit reached\b/i,
  /\bYour limit will reset at\b/i,
  /\bAPI Error: 429\b.*rate_limit_error/i,
  /\bYou have exhausted your (?:daily )?(?:quota|capacity)\b/i,
  /\bUsage limit reached for\b/i
]

/** Cheap prefilter for stream lines before JSON.parse. */
const PREFILTER = /limit|quota|429|RESOURCE_EXHAUSTED|rate_limit/i

const clip = (s: string, n = 300): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ---------- time zones ----------

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Offset (ms) of `tz` at instant `t`: wall clock in tz minus UTC. */
function tzOffset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(t))
  const n = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
  return wall - Math.floor(t / 1000) * 1000
}

/** Wall-clock fields in tz (or local time when tz is null). */
function wallParts(t: number, tz: string | null): { y: number; mo: number; d: number; wd: number } {
  if (!tz) {
    const x = new Date(t)
    return { y: x.getFullYear(), mo: x.getMonth(), d: x.getDate(), wd: x.getDay() }
  }
  const x = new Date(t + tzOffset(t, tz))
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay() }
}

/** Instant of a wall-clock time in tz (or local time when tz is null). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string | null): number {
  if (!tz) return new Date(y, mo, d, h, mi, 0, 0).getTime()
  const guess = Date.UTC(y, mo, d, h, mi)
  let t = guess - tzOffset(guess, tz)
  t = guess - tzOffset(t, tz)
  return t
}

// ---------- reset time parsing ----------

const DUR_UNIT: Record<string, number> = { d: 86400_000, h: 3600_000, m: 60_000, s: 1000 }

/** "2 days 3 hours 5 minutes", "2h32m15s", "45 min" -> ms; null when nothing parses. */
export function parseDuration(text: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi
  let total = 0
  let any = false
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const unit = m[2]!.toLowerCase()
    const key = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : unit.startsWith('m') ? 'm' : 's'
    total += Number(m[1]) * DUR_UNIT[key]!
    any = true
  }
  return any ? total : null
}

/**
 * Parses the reset moment out of a CLI limit line. Understands "resets 3pm", "resets at 3:30 PM (Europe/Madrid)",
 * "resets Oct 20, 3pm", "resets Mon 9am", "reset at 15:00", "resets 2026-08-08 00:00 UTC", "try again at 3:05 PM",
 * "try again in 2 days 3 hours", "will reset after 2h32m15s", "resets in 45m" and claude's "|<epoch seconds>".
 * A bare clock time is the next such time after `now` (in the named zone, else local time).
 */
export function parseResetTime(text: string, now: Date): Date | null {
  const t = text.replace(/[∙·•]/g, '·')
  const epoch = t.match(/limit reached\|(\d{10,13})/i)
  if (epoch) {
    const n = Number(epoch[1])
    return new Date(n < 1e12 ? n * 1000 : n)
  }
  const rel = t.match(/(?:reset(?:s)?(?: in| after)|try again in|retry in|available again in)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i)
  if (rel) {
    const ms = parseDuration(rel[1]!)
    if (ms != null) return new Date(now.getTime() + ms)
  }
  const iso = t.match(/(?:reset(?:s)?|try again)(?: at| on)?\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*(UTC|Z)?/i)
  if (iso) {
    const [, y, mo, d, h, mi, utc] = iso
    const ms = utc ? Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!) : new Date(+y!, +mo! - 1, +d!, +h!, +mi!).getTime()
    return new Date(ms)
  }
  const at = t.match(
    /(?:reset(?:s)?|try again)(?:\s+at|\s+on)?\s+(?:(?:on\s+)?(?<wd>mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(?:at\s+)?)?(?:(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<mi>\d{2}))?\s*(?<ap>a\.?m\.?|p\.?m\.?)?(?:\s*\((?<tz>[A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\)|\s+(?<utc>UTC))?/i
  )
  if (!at?.groups) return null
  const g = at.groups
  let h = Number(g.h)
  const mi = g.mi ? Number(g.mi) : 0
  const ap = g.ap?.toLowerCase().replace(/\./g, '')
  // a bare number with no am/pm and no minutes is not a time ("resets 3 days" etc. handled above)
  if (!ap && !g.mi) return null
  if (h > 23 || mi > 59) return null
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  const tz = g.utc ? 'UTC' : g.tz && validTz(g.tz) ? g.tz : null
  const nowMs = now.getTime()
  const today = wallParts(nowMs, tz)
  if (g.mon && g.day) {
    const mo = MONTHS.indexOf(g.mon.toLowerCase().slice(0, 3))
    let ms = zoned(today.y, mo, Number(g.day), h, mi, tz)
    if (ms < nowMs - 2 * 86400_000) ms = zoned(today.y + 1, mo, Number(g.day), h, mi, tz)
    return new Date(ms)
  }
  let ms = zoned(today.y, today.mo, today.d, h, mi, tz)
  if (g.wd) {
    const want = WEEKDAYS.indexOf(g.wd.toLowerCase().slice(0, 3))
    let add = (want - today.wd + 7) % 7
    if (add === 0 && ms <= nowMs - 60_000) add = 7
    ms = zoned(today.y, today.mo, today.d + add, h, mi, tz)
    return new Date(ms)
  }
  // bare clock time: the next one (a reset is never in the past; a minute of slack for clocks that just ticked)
  if (ms <= nowMs - 60_000) ms = zoned(today.y, today.mo, today.d + 1, h, mi, tz)
  return new Date(ms)
}

// ---------- text ----------

/**
 * A limit line in free text (stderr, an error string, the last screen of a PTY). `tailLines` > 0 only looks at the
 * last n non-empty lines (PTY screens: the CLI's own message sits at the bottom; older scrollback is the agent's prose).
 * `strict` accepts only the CLIs' banner shapes (PTY screens).
 */
export function classifyLimitText(text: string, now: Date, opts: { tailLines?: number; strict?: boolean } = {}): LimitHit | null {
  if (!text || !PREFILTER.test(text)) return null
  let lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (opts.tailLines && opts.tailLines > 0) lines = lines.slice(-opts.tailLines)
  const patterns = opts.strict ? STRICT_TEXT : LIMIT_TEXT
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!patterns.some((re) => re.test(line))) continue
    // the reset often sits on the same line; claude's TUI may wrap it onto the next one
    const around = [line, lines[i + 1] ?? ''].join(' ')
    const reset = parseResetTime(around, now)
    return { message: clip(line), resetAt: reset ? reset.toISOString() : null }
  }
  return null
}

// ---------- structured stream lines ----------

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c === 'string' ? c : str(obj(c)?.text) ?? ''))
    .filter(Boolean)
    .join('\n')
}

function epochToIso(v: unknown): ISODate | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

/**
 * One stdout line of a headless step. Structured signals first (they carry exact reset times), then the line's text
 * fields through classifyLimitText. Non-JSON lines are treated as text.
 */
export function classifyStreamLine(provider: AdapterId, line: string, now: Date): LimitHit | null {
  if (!line || !PREFILTER.test(line)) return null
  let o: Record<string, unknown> | null = null
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      o = obj(JSON.parse(trimmed))
    } catch {
      o = null
    }
  }
  if (!o) return classifyLimitText(line, now)
  const type = str(o.type)
  if (provider === 'claude' || provider === 'cursor') {
    if (type === 'rate_limit_event') {
      const info = obj(o.rate_limit_info)
      if (str(info?.status) !== 'rejected') return null
      const kind = str(info?.rateLimitType)
      return { message: kind ? `Usage limit reached (${kind.replace(/_/g, ' ')})` : 'Usage limit reached', resetAt: epochToIso(info?.resetsAt) }
    }
    if (type === 'assistant') {
      const msg = obj(o.message)
      const text = contentText(msg?.content)
      if (str(o.error) === 'rate_limit') {
        const hit = classifyLimitText(text, now)
        return hit ?? { message: clip(text || 'Rate limited'), resetAt: null }
      }
      // ordinary assistant prose never counts (an agent may well write about rate limits)
      return null
    }
    if (type === 'result') {
      if (o.is_error !== true && str(o.subtype) === 'success') return null
      return classifyLimitText(str(o.result) ?? '', now)
    }
  }
  if (provider === 'codex') {
    if (type === 'error') return classifyLimitText(str(o.message) ?? '', now)
    if (type === 'turn.failed') return classifyLimitText(str(obj(o.error)?.message) ?? '', now)
    if (type === 'item.completed' || type === 'item.started') return null
  }
  if (provider === 'gemini') {
    if (type === 'error') return classifyLimitText([str(o.message), str(obj(o.error)?.message)].filter(Boolean).join('\n'), now)
    if (type === 'result') {
      const err = obj(o.error)
      return err ? classifyLimitText([str(err.message), str(err.type), str(err.status)].filter(Boolean).join('\n'), now) : null
    }
    if (type === 'message' || type === 'tool_use' || type === 'tool_result') return null
  }
  if (type === 'error') return classifyLimitText(str(o.message) ?? str(obj(o.error)?.message) ?? '', now)
  return null
}

/** claude's interactive StopFailure hook payload (`error: "rate_limit"`, `last_assistant_message`). */
export function classifyStopFailure(payload: unknown, now: Date): LimitHit | null {
  const p = obj(payload)
  if (!p || str(p.hook_event_name) !== 'StopFailure') return null
  const error = str(p.error)
  const text = str(p.last_assistant_message) ?? ''
  if (error === 'rate_limit') return classifyLimitText(text, now) ?? { message: clip(text || 'Rate limited'), resetAt: null }
  if (error === 'billing_error') return classifyLimitText(text, now)
  return null
}

/** Later reset wins (a run limited on two steps retries after both reset). */
export function laterReset(a: ISODate | null | undefined, b: ISODate | null | undefined): ISODate | null {
  if (!a) return b ?? null
  if (!b) return a
  return a > b ? a : b
}
