/**
 * PR-103: one state per chat row, the same in a company's Chats and in All companies (founder, 2026-11-05, after the
 * Conductor teardown). A row used to say "Decimus · PR-99 Retry stapling…" and lose its state to the ellipsis, with
 * the same dot on a week-old question as on fresh news. Now every row leads with exactly one state, each with its own
 * mark and tone:
 *
 *   working ● (shimmer) · waiting ◷ · slow ◷ · stuck ! · question ? · blocked ◆ · review ✓ · failed ✕ · done ✓ · queued ○
 *
 * and the unread dot shows only for news you have not read, never on a row that is working or already says it needs you.
 * Pure: no hive, no DOM (rowState.test.ts).
 */
import type { BlockReason, CompanyTask } from '@shared/company'
import { taskCardState } from '@shared/taskCard'
import type { LiveLine } from './liveLine'

export type RowStateKind = 'working' | 'waiting' | 'slow' | 'stuck' | 'question' | 'blocked' | 'review' | 'failed' | 'done' | 'queued'
export type RowTone = 'live' | 'needs' | 'bad' | 'good' | 'quiet'

export interface RowState {
  kind: RowStateKind
  /** the words that lead the row's second line */
  label: string
  /** a one-character mark before the label */
  mark: string
  tone: RowTone
  /** the shimmer belongs on it (something visibly happening) */
  spin: boolean
  /** the row waits on you: it sorts first and counts as needing you */
  needsYou: boolean
}

const MARK: Record<RowStateKind, string> = { working: '●', waiting: '◷', slow: '◷', stuck: '!', question: '?', blocked: '◆', review: '✓', failed: '✕', done: '✓', queued: '○' }
const TONE: Record<RowStateKind, RowTone> = { working: 'live', waiting: 'quiet', slow: 'needs', stuck: 'bad', question: 'needs', blocked: 'needs', review: 'good', failed: 'bad', done: 'quiet', queued: 'quiet' }
const state = (kind: RowStateKind, label: string, o: { spin?: boolean; needsYou?: boolean } = {}): RowState => ({ kind, label, mark: MARK[kind], tone: TONE[kind], spin: !!o.spin, needsYou: !!o.needsYou })

/** Why a task stopped, in the row's words. */
const STOPPED: Partial<Record<BlockReason, string>> = {
  run_failed: 'Stopped with an error',
  interrupted: 'Stopped when the app quit',
  no_report: 'Stopped without reporting',
  limit: 'Stopped at a limit'
}
/** Why a task is parked on you (not a question). */
const PARKED: Partial<Record<BlockReason, string>> = {
  agent: 'Blocked · needs you',
  handoff_cap: 'Too many handoffs · needs you',
  manual: 'Parked'
}

/** "3d", "5h": how long a question has waited, once it is more than an hour. */
export function waitedFor(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return null
  const h = Math.floor((now - t) / 3_600_000)
  if (h < 1) return null
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export type RowTask = Pick<CompanyTask, 'status' | 'runId' | 'updatedAt'> & Partial<Pick<CompanyTask, 'blockReason' | 'ask'>>

/**
 * A task row's one state. `line` is its live line (liveLine) while it works; `openAsk`: its run shows a live
 * permission or question right now.
 */
export function taskRowState(t: RowTask, o: { line?: LiveLine | null; openAsk?: boolean; now?: number } = {}): RowState {
  const now = o.now ?? Date.now()
  const card = taskCardState({ status: t.status, blockReason: t.blockReason ?? null, ask: t.ask ?? null, runId: t.runId }, { openAsk: !!o.openAsk })
  if (card === 'needs_you') {
    if (o.openAsk) return state('question', 'Asking you now', { needsYou: true })
    if (t.ask && !t.ask.answer) {
      const w = waitedFor(t.updatedAt, now)
      return state('question', `Question for you${w ? ` · ${w}` : ''}`, { needsYou: true })
    }
    return state('blocked', (t.blockReason && PARKED[t.blockReason]) ?? 'Needs you', { needsYou: t.blockReason !== 'manual' })
  }
  if (card === 'working') {
    const l = o.line
    if (!l || l.kind === 'working' || l.kind === 'in_chat') return state('working', l?.kind === 'in_chat' ? 'Working in its chat' : (l?.text ?? 'Working…'), { spin: true })
    if (l.kind === 'stuck') return state('stuck', l.label, { needsYou: false })
    return state(l.kind === 'slow' ? 'slow' : 'waiting', l.kind === 'waiting' ? l.text : l.label, { spin: l.spin })
  }
  if (card === 'failed') return state('failed', (t.blockReason && STOPPED[t.blockReason]) ?? (t.status === 'canceled' ? 'Canceled' : 'Stopped'))
  if (card === 'in_review') return state('review', 'Ready for review')
  if (card === 'done') return state('done', 'Done')
  return state('queued', t.blockReason === 'deps' ? 'Waiting on another task' : 'Queued')
}

/** A chat's own turn (an agent's chat or a direct chat with Claude): working, waiting for your OK, your turn, ended. */
export function chatRowState(o: { running: boolean; working: boolean; needs: boolean; yourTurn?: boolean; ended?: string | null; line?: LiveLine | null }): RowState | null {
  if (o.needs) return state('question', 'Waiting for you', { needsYou: true })
  if (o.running && o.working) {
    const l = o.line
    if (l?.kind === 'stuck') return state('stuck', l.label)
    if (l?.kind === 'slow') return state('slow', l.label)
    return state('working', 'Working…', { spin: true })
  }
  if (!o.running) return o.ended ? state('done', o.ended) : null
  return null
}

/** The unread dot: news you have not read, never on a row that works or already says it needs you (Conductor). */
export function showsDot(s: RowState | null, unread: boolean): boolean {
  if (!unread || !s) return unread && !s
  return !s.spin && !s.needsYou && s.kind !== 'stuck'
}
