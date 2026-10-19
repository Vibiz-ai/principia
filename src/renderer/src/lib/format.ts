/** Human-facing labels: never show raw commands, IDs or escape sequences as titles. */
import type { Run, Session } from '@shared/types'

/** First meaningful line, whitespace collapsed (literal "\n" too), capped with an ellipsis. */
export function firstLine(text: string, max = 40): string {
  const line =
    text
      .replace(/\\[nrt]/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? ''
  return cap(line, max)
}

function cap(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const SHELLISH = /^(cd|export|set|source|mkdir|pushd|unset|printf|echo|cat|npm|pnpm|bun|yarn|git|bash|sh|zsh|node|python3?)\b/
const NOISE = /^(cd|export|set|source|\.|mkdir|pushd|popd|unset|true)\b/

/**
 * Title for a prompt: first line, with shell noise trimmed — `cd "$ARTIFACTS_DIR"; printf "# Weekly report\n…" > r.md`
 * reads "Weekly report". Natural-language prompts are left alone apart from leading markdown markers.
 */
export function promptTitle(text: string, max = 40): string {
  let line = firstLine(text, 1000)
  const shell = SHELLISH.test(line)
  if (shell) {
    const segs = line.split(/\s*(?:;|&&|\|\|)\s*/).filter(Boolean)
    line = segs.find((s) => !NOISE.test(s)) ?? segs[0] ?? line
    const m = /^(?:printf|echo)(?:\s+-\w+)*\s+(["'])((?:\\.|(?!\1).)*)/.exec(line)
    if (m) line = m[2]!
    else line = line.replace(/\s*\d?>>?\s*\S+\s*$/, '') // trailing redirect
  }
  line = line
    .replace(/^#+\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\$\{?ARTIFACTS_DIR\}?\/?/g, '')
    .trim()
  if (shell) return cap(line, max)
  // natural language: drop a "Step 1:" / "Task:" lead-in and keep the first sentence
  line = line.replace(/^(?:step\s*\d+|task|prompt|goal)\s*[:.)\-–—]\s*/i, '')
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(line)
  if (sentence) line = sentence[1]!.replace(/\.$/, '')
  if (line) line = line[0]!.toUpperCase() + line.slice(1)
  return capWords(line, max)
}

/** Cut at a word boundary when one is close, so titles don't end mid-word ("general-purpo…"). */
function capWords(line: string, max: number): string {
  if (line.length <= max) return line
  const head = line.slice(0, max - 1)
  const sp = head.lastIndexOf(' ')
  return `${(sp >= max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:–—-]+$/, '')}…`
}

/** Run title for lists, headers and canvas frames. Prompt runs: first line of the prompt, shell noise trimmed. */
export function runTitle(r: Pick<Run, 'kind' | 'title' | 'target'>, max = 40): string {
  if (r.kind === 'prompt') {
    const src = r.target.kind === 'prompt' ? r.target.prompt : r.title
    return promptTitle(src, max) || 'Prompt'
  }
  return r.title
}

/** /Users/me/x -> ~/x. */
export function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/** Folder shown for a session: "Chat" for the scratch folder, else ~/path. */
export function sessionPlace(s: Pick<Session, 'repoId' | 'cwd'>): string {
  return s.repoId ? tildify(s.cwd) : 'Chat'
}

/** Signals Principia sends on Kill (HUP/TERM/KILL, as 128+n or the bare signal number), or no code at all. */
const STOP_CODES = new Set([9, 15, 129, 130, 137, 143])

/** "stopped" for a session the user killed, "ended" for a clean exit, "exited N" otherwise. */
export function sessionEndLabel(s: Pick<Session, 'status' | 'exitCode'>, killedByUser = false): string {
  if (s.status === 'running') return 'running'
  if (killedByUser || s.exitCode === null || STOP_CODES.has(s.exitCode)) return 'stopped'
  if (s.exitCode === 0) return 'ended'
  return `exited ${s.exitCode}`
}

/**
 * Exited sessions auto-collapse: keep every running session, plus only the newest exited one per repo
 * (Chat counts as one repo). Returns the kept list (input order preserved) and how many were folded away.
 */
export function collapseExited<T extends Pick<Session, 'id' | 'repoId' | 'status' | 'startedAt'>>(list: T[]): { shown: T[]; hidden: number } {
  const newest = new Map<string, T>()
  for (const s of list) {
    if (s.status === 'running') continue
    const k = s.repoId ?? '__chat'
    const cur = newest.get(k)
    if (!cur || s.startedAt > cur.startedAt) newest.set(k, s)
  }
  const keep = new Set([...newest.values()].map((s) => s.id))
  const shown = list.filter((s) => s.status === 'running' || keep.has(s.id))
  return { shown, hidden: list.length - shown.length }
}

/**
 * Readable step logs can start with the tail of a multi-line command header ("$ claude -p '…If yo…'") followed by
 * "# cwd: …". Drop everything up to and including that cwd line (and one blank line) when it sits in the first lines
 * and nothing before it looks like transcript output.
 */
export function stripLogHeader(text: string): string {
  const lines = text.split('\n')
  const limit = Math.min(lines.length, 40)
  for (let i = 0; i < limit; i++) {
    const l = lines[i]!
    if (l.startsWith('# cwd: ')) {
      let j = i + 1
      if (lines[j] === '') j++
      return lines.slice(j).join('\n')
    }
    if (/^(→|←|— done|✕)/.test(l)) return text
  }
  return text
}
