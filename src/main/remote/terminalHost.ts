/**
 * REMOTE.md RA3 "a terminal on the phone": where a terminal session's transcript is, what its screen shows, and typing
 * a message into it, for the Phone API (terminalFeed.ts). Claude Code: the transcript_path its hooks report (kept after
 * the pane exits), else <claude dir>/projects/<slug>/<conversation id>.jsonl. Codex (no hooks): the rollout under
 * $CODEX_HOME/sessions/YYYY/MM/DD that began in the session's folder right after the session started, settled across
 * every Codex session in that folder (findCodexRollout). Files are only
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
  /** the desktop's recent Codex sessions (terminal and chat): a rollout goes to the one it belongs to among them */
  codexSessions?(): CodexSession[]
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

/** A desktop Codex session (terminal or chat) that may own a rollout in the same folder. */
export type CodexSession = Pick<Session, 'id' | 'cwd' | 'startedAt' | 'endedAt'> & { agentSessionId?: string | null }

/** sessions started this long before this one can still hold a rollout it would otherwise take */
const PEER_MS = 86_400_000

/**
 * The Codex rollout of a session: begun in its folder at or just after its start (and before it ended). Ownership is
 * settled across every desktop Codex session in that folder, so it never depends on which one a phone opens first:
 * a rollout whose conversation id is a session's (a Codex chat's thread) or already given to one (`claimed`, file ->
 * session id) is that session's; the rest go in start order, each session taking the earliest rollout left that
 * fits its time. Codex names its day folders in local time; the days around each start are looked at too.
 */
export function findCodexRollout(
  home: string,
  s: CodexSession,
  o: { sessions?: readonly CodexSession[]; claimed?: ReadonlyMap<string, Id>; now?: number } = {}
): string | null {
  const now = o.now ?? Date.now()
  const span = (x: CodexSession): { start: number; end: number } => ({ start: Date.parse(x.startedAt), end: x.endedAt ? Date.parse(x.endedAt) : now })
  const me = span(s)
  if (!Number.isFinite(me.start)) return null
  const cwd = real(s.cwd) ?? s.cwd
  // only sessions that started before this one (or with it) can take its rollout first
  const order = (x: CodexSession, y: CodexSession): number => span(x).start - span(y).start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  const peers = (o.sessions ?? [])
    .filter((x) => x.id !== s.id && Number.isFinite(span(x).start) && me.start - span(x).start <= PEER_MS && span(x).end >= me.start - PEER_MS - EARLY_MS)
    .filter((x) => order(x, s) < 0 || !!x.agentSessionId || [...(o.claimed?.values() ?? [])].includes(x.id))
    .filter((x) => (real(x.cwd) ?? x.cwd) === cwd)
  const all = [...peers, s].sort(order)
  const from = Math.min(...all.map((x) => span(x).start)) - EARLY_MS
  const days = new Set<string>()
  for (let t = from - 86_400_000; t <= me.end + 86_400_000; t += 86_400_000) {
    const d = new Date(t)
    days.add(path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
  }
  const rollouts: { file: string; at: number; id: string | null }[] = []
  for (const day of [...days].sort()) {
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
      try {
        if (fs.statSync(file).mtimeMs < from) continue
      } catch {
        continue
      }
      const meta = codexMeta(firstLine(file))
      if (!meta || meta.at < from || meta.at > me.end) continue
      if ((real(meta.cwd) ?? meta.cwd) !== cwd) continue
      rollouts.push({ file, at: meta.at, id: meta.id })
    }
  }
  rollouts.sort((x, y) => x.at - y.at || (x.file < y.file ? -1 : 1))
  const owner = new Map<string, Id>()
  const owned = new Set<Id>()
  const give = (file: string, id: Id): void => {
    if (owner.has(file) || owned.has(id)) return
    owner.set(file, id)
    owned.add(id)
  }
  // fixed first: a conversation id that names its session, then what was already given out
  for (const r of rollouts) {
    const byId = r.id ? all.find((x) => x.agentSessionId === r.id) : undefined
    if (byId) give(r.file, byId.id)
  }
  for (const [file, id] of o.claimed ?? []) if (all.some((x) => x.id === id)) give(file, id)
  for (const x of all) {
    if (owned.has(x.id)) continue
    const w = span(x)
    const r = rollouts.find((r) => !owner.has(r.file) && r.at >= w.start - EARLY_MS && r.at <= w.end)
    if (r) give(r.file, x.id)
  }
  for (const [file, id] of owner) if (id === s.id) return file
  return null
}

export function terminalHost(d: TerminalHostDeps): PhoneTerminalHost {
  /** the last transcript seen per session (a hook path outlives the pane; a found rollout is not searched again) */
  const known = new Map<Id, TranscriptRef>()
  const claimedCodex = (except: Id): Map<string, Id> => new Map([...known].filter(([id, r]) => id !== except && r.format === 'codex').map(([id, r]) => [r.file, id]))
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
        let sessions: CodexSession[] = []
        try {
          sessions = d.codexSessions?.() ?? []
        } catch {
          sessions = []
        }
        const file = findCodexRollout(d.codexHome(), s, { sessions, claimed: claimedCodex(s.id), now: d.now?.() ?? Date.now() })
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
