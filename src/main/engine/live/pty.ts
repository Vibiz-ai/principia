/**
 * PTY heuristics (LIVE.md §3.8, A9): detect a permission/trust prompt on the ANSI-stripped quiet tail of an
 * interactive pane, and the keys that answer it. Main runs the detector after 300 ms of no output, and re-runs it
 * right before writing reply keys (A9 guard). Pure.
 */
import type { AdapterId } from '../../../shared/types'
import type { PtyPrompt } from './types'

/**
 * Strips CSI/OSC escape sequences and carriage returns. Differential TUIs (claude) position words with cursor moves
 * instead of spaces ("Do\x1b[5Gyou\x1b[9Gwant"), so horizontal moves become a space and vertical/absolute moves a
 * newline; everything else (colors, modes) is dropped.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_m, f: string) => (f === 'G' || f === 'C' ? ' ' : 'ABEFHdf'.includes(f) ? '\n' : '')) // CSI
    .replace(/\x1b[@-Z\\-_]/g, '') // 2-char escapes
    .replace(/\r/g, '')
}

const TAIL = 4096
const CLAUDE_TRUST = /Quick safety check|Is this a project you created or one you trust/
const CLAUDE_PERMISSION = /Do you want to (proceed|make this edit[^?]*)\?/
const CLAUDE_YES = /❯\s*1\.\s*Yes/
/** trust dialog options (numbered in older CLIs, "❯ No, exit / Yes, I trust this folder" in 2.1.x). */
const CLAUDE_TRUST_OPTION = /No,\s*exit|Yes,\s*I\s*trust|Yes,\s*proceed/
const NEVER = /(?!)/
const GEMINI_PERMISSION = /Allow execution of[^\n?]*\?|Apply this change\?|Do you want to proceed\?/
const GEMINI_OPTION = /Allow once/
/** gemini's composer; it is hidden while a confirmation dialog waits, so seeing it below a match means model text. */
const GEMINI_COMPOSER = /Type your message/
const CURSOR_PERMISSION = /Run this command outside the sandbox\?|Run this command\?|Run this MCP tool\?|Waiting for approval\.\.\./
/** cursor dialog options: "Run (once) (y)", "Allow once (y)", "Skip ... (esc or n)". */
const CURSOR_OPTION = /\((?:y|esc or n)\)|Run \(once\)|Allow once|Skip/
/** cursor's idle composer (hidden while an approval waits). */
const CURSOR_COMPOSER = /Add a follow-up|Plan, search, build anything/
/**
 * A live dialog is the last thing a TUI draws (options, then at most a footer/status bar). Text the model printed
 * earlier is followed by the rest of the transcript and the composer. Max non-empty lines allowed after the title.
 */
const MAX_LINES_AFTER = 12

/** The last few non-empty lines above `idx`, as a tool hint ("Bash command", file names...). */
function hintBefore(text: string, idx: number): string | null {
  const lines = text.slice(0, idx).split('\n').map((l) => l.replace(/[│╭╮╰╯─]+/g, ' ').trim()).filter(Boolean)
  const l = lines[lines.length - 1]
  return l ? l.slice(0, 120) : null
}

/** Non-empty lines after the match's line. */
function linesAfter(text: string, idx: number): string[] {
  const nl = text.indexOf('\n', idx)
  if (nl < 0) return []
  return text.slice(nl + 1).split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Dialog-shaped: options on their own lines below the title, near the end, and no idle composer below it. */
function dialogAt(text: string, idx: number, option: RegExp | null, composer: RegExp): boolean {
  const after = linesAfter(text, idx)
  if (after.length > MAX_LINES_AFTER) return false
  const below = after.join('\n')
  if (composer.test(below)) return false
  return option ? option.test(below) : true
}

/** Last match of re in s (title = matched text). */
function lastMatch(re: RegExp, s: string): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let m: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((m = g.exec(s))) last = m
  return last
}

/**
 * The prompt currently on screen, or null. `screenTail` may contain ANSI; only the last 4 KB are considered.
 * gemini/cursor: the match must look like a live dialog (option lines below the title, at the end of the output, no
 * idle composer after it), so model text quoting a dialog never opens an ask or passes the A9 guard.
 * claude permission matches are returned too (the tracker ignores them while hooks work; the A9 guard needs them).
 */
export function detectPtyPrompt(provider: AdapterId, screenTail: string): PtyPrompt | null {
  const t = stripAnsi(screenTail).slice(-TAIL)
  if (provider === 'claude') {
    // dialog-shaped only: model text quoting the trust question (no options below, or more transcript after) is not it
    const tm = lastMatch(CLAUDE_TRUST, t)
    if (tm && dialogAt(t, tm.index, CLAUDE_TRUST_OPTION, NEVER)) return { kind: 'trust', title: 'Trust this folder?' }
    const m = lastMatch(CLAUDE_PERMISSION, t)
    if (m && CLAUDE_YES.test(t.slice(m.index))) return { kind: 'permission', title: m[0], toolHint: hintBefore(t, m.index) }
    return null
  }
  if (provider === 'gemini') {
    const m = lastMatch(GEMINI_PERMISSION, t)
    if (m && dialogAt(t, m.index, GEMINI_OPTION, GEMINI_COMPOSER)) return { kind: 'permission', title: m[0], toolHint: hintBefore(t, m.index) }
    return null
  }
  if (provider === 'cursor') {
    const m = lastMatch(CURSOR_PERMISSION, t)
    const status = m?.[0] === 'Waiting for approval...'
    if (m && dialogAt(t, m.index, status ? null : CURSOR_OPTION, CURSOR_COMPOSER)) return { kind: 'permission', title: m[0] === 'Waiting for approval...' ? 'Waiting for approval' : m[0], toolHint: hintBefore(t, m.index) }
    return null
  }
  return null
}

/** Same prompt? (A9 guard: kind equal and title equal.) */
export function samePrompt(a: PtyPrompt | null, b: PtyPrompt | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.title === b.title
}

/**
 * Keys that answer a PTY prompt. Trust prompts are never answered by Hive (focus only) -> null.
 * Hive never sends "always" through the PTY (A1).
 */
export function ptyReplyKeys(provider: AdapterId, kind: 'permission' | 'trust' | 'question', decision: 'allow' | 'deny'): string | null {
  if (kind !== 'permission') return null
  switch (provider) {
    case 'claude':
      return decision === 'allow' ? '1' : '\x1b'
    case 'gemini':
      return decision === 'allow' ? '\r' : '\x1b'
    case 'cursor':
      return decision === 'allow' ? 'y' : 'n'
    default:
      return null
  }
}
