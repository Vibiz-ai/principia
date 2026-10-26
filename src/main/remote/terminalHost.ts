/**
 * REMOTE.md RA3 "a terminal on the phone": where a terminal session's transcript is, what its screen shows, and typing
 * a message into it, for the Phone API (terminalFeed.ts). Claude Code: the transcript_path its hooks report (kept after
 * the pane exits), else <claude dir>/projects/<slug>/<conversation id>.jsonl. Codex (no hooks): the rollout under
 * $CODEX_HOME/sessions/YYYY/MM/DD that began in the session's folder right after the session started. Files are only
 * read, and only inside those folders. No Electron imports (wire.ts passes the desktop's pieces).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Id, Session } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import type { PhoneTerminalHost } from './terminalFeed'
import { codexMeta, type TranscriptRef } from './transcript'

export interface TerminalHostDeps {
  /** the live terminal session (SessionLive), or null once it ended */
  live(sessionId: Id): { transcriptPath: string | null; screen(): string | null; type(text: string): void; typeHeld(): string | null } | null
  /** Claude's transcript of a conversation id, or null */
  claudeFile(conv: string): string | null
  /** folders a Claude transcript may be read from (…/projects) */
  claudeRoots(): string[]
  /** $CODEX_HOME, else ~/.codex */
  codexHome(): string
  redact(text: string): string
  log?: { info(m: string, meta?: Record<string, unknown>): void }
  now?: () => number
}

const HEAD_MAX = 1024 * 1024
/** a rollout belongs to the session when it began this soon around the session's start */
const EARLY_MS = 10_000

function real(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}
function inside(file: string, roots: string[]): boolean {
  const f = real(file)
  return !!f && roots.some((r) => {
    const rr = real(r)
    return !!rr && f.startsWith(rr + path.sep)
  })
}

/** The first line of a file (a rollout's session_meta), at most HEAD_MAX bytes read. */
function firstLine(file: string): unknown {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(HEAD_MAX, fs.fstatSync(fd).size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    return JSON.parse(nl >= 0 ? text.slice(0, nl) : text)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * The Codex rollout of a terminal session: begun in its folder, at or just after its start (and before it ended), the
 * earliest such that no other session took. Codex names its day folders in local time; the day before and after are
 * looked at too.
 */
export function findCodexRollout(home: string, s: Pick<Session, 'cwd' | 'startedAt' | 'endedAt'>, taken: ReadonlySet<string> = new Set(), now = Date.now()): string | null {
  const start = Date.parse(s.startedAt)
  if (!Number.isFinite(start)) return null
  const end = s.endedAt ? Date.parse(s.endedAt) : now
  const cwd = real(s.cwd) ?? s.cwd
  const days = new Set<string>()
  for (const t of [start - 86_400_000, start, start + 86_400_000, end]) {
    const d = new Date(t)
    days.add(path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
  }
  let best: { file: string; at: number } | null = null
  for (const day of days) {
    const dir = path.join(home, 'sessions', day)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue
      const file = path.join(dir, n)
      if (taken.has(file)) continue
      try {
        if (fs.statSync(file).mtimeMs < start - EARLY_MS) continue
      } catch {
        continue
      }
      const meta = codexMeta(firstLine(file))
      if (!meta || meta.at < start - EARLY_MS || meta.at > end) continue
      if ((real(meta.cwd) ?? meta.cwd) !== cwd) continue
      if (!best || meta.at < best.at) best = { file, at: meta.at }
    }
  }
  return best?.file ?? null
}

export function terminalHost(d: TerminalHostDeps): PhoneTerminalHost {
  /** the last transcript seen per session (a hook path outlives the pane; a found rollout is not searched again) */
  const known = new Map<Id, TranscriptRef>()
  const takenCodex = (except: Id): Set<string> => new Set([...known].filter(([id, r]) => id !== except && r.format === 'codex').map(([, r]) => r.file))
  return {
    transcript(s: Session): TranscriptRef | null {
      if (s.adapter === 'claude') {
        const hooked = d.live(s.id)?.transcriptPath ?? null
        if (hooked && fs.existsSync(hooked) && inside(hooked, d.claudeRoots())) known.set(s.id, { file: hooked, format: 'claude' })
        const k = known.get(s.id)
        if (k && fs.existsSync(k.file)) return k
        const byId = s.agentSessionId ? d.claudeFile(s.agentSessionId) : null
        return byId ? { file: byId, format: 'claude' } : null
      }
      if (s.adapter === 'codex') {
        const k = known.get(s.id)
        if (k && fs.existsSync(k.file)) return k
        const file = findCodexRollout(d.codexHome(), s, takenCodex(s.id), d.now?.() ?? Date.now())
        if (!file) return null
        const ref: TranscriptRef = { file, format: 'codex' }
        known.set(s.id, ref)
        return ref
      }
      return null
    },
    screen(sessionId: Id): string | null {
      return d.live(sessionId)?.screen() ?? null
    },
    held(sessionId: Id): string | null {
      return d.live(sessionId)?.typeHeld() ?? null
    },
    type(sessionId: Id, text: string): void {
      const l = d.live(sessionId)
      if (!l) throw new HiveError('conflict', 'This session has ended')
      l.type(text)
      // the pane's own log keeps what the terminal showed; the app log says only that the phone typed
      d.log?.info('[remote] message typed into a terminal session', { sessionId, chars: text.length })
    },
    redact: (t) => d.redact(t)
  }
}
