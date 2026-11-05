/**
 * PR-102: what a working task says it is doing right now, in one place, so no screen shows a spinner with no end.
 * Modeled on how Conductor names every pending state (founder, 2026-11-05): each line says what it is waiting for,
 * and a wait that goes on too long turns into words you can act on instead of spinning forever.
 *
 * - working: the agent's own activity, spinning;
 * - waiting: a named wait (a free slot, the run starting up, a usage limit), no spinner once it is not quick;
 * - slow: the agent has been silent past Settings.stallMinutes (stalledSince), "Quiet for 12m";
 * - stuck: no agent ever showed up for the run, or it has been silent for 3x the stall time: "Not responding";
 * - in_chat: the task is worked on in a chat (PR-100): the chat is where its progress is.
 *
 * Pure: no hive, no DOM (liveLine.test.ts).
 */
import type { AgentNode } from '@shared/live'
import { SLOT_WAIT_LABEL, SLOT_WAIT_LINE, SLOT_WAIT_WHY } from '@shared/taskCard'

export type LiveLineKind = 'working' | 'waiting' | 'slow' | 'stuck' | 'in_chat'

export interface LiveLine {
  kind: LiveLineKind
  /** the header's one word ("Waiting", "Not responding") */
  label: string
  text: string
  /** a spinner/shimmer belongs on it: only while something is visibly happening, or for the first moments of a start */
  spin: boolean
  /** a sentence for the tooltip: why it waits, or what to do */
  why?: string
}

/** How long a run may take to show its agent before "Starting…" stops spinning, and before it reads as not starting. */
export const START_SPIN_MS = 45_000
export const START_STUCK_MS = 5 * 60_000
/** Silent for this many stall periods reads as not responding (once is "Quiet for…"). */
export const STUCK_STALLS = 3

export type LiveRoot = Pick<AgentNode, 'status' | 'activity' | 'stalledSince' | 'stopReason' | 'resetAt'>

export interface LiveLineInput {
  /** the task is in progress (taskCardState 'working') */
  working: boolean
  /** the run waits for a free shared slot since then (store.slotWaits) */
  slotWaitSince?: string | null
  /** the task is a chat's own tracked task (PR-100) */
  inChat?: boolean
  /** the run's (or the chat's) root agent, when the live snapshot has it */
  root?: LiveRoot | null
  /** the running call in words, or the activity in plain words, when there is one */
  doing?: string | null
  /** when the task started working (its root's start, else when it moved to in progress) */
  since: string
  /** Settings.stallMinutes */
  stallMinutes: number
  now: number
}

const LIVE = new Set(['starting', 'working', 'needs_you', 'idle'])
const minutes = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The live line of a working task, or null when it is not working (its card says done, failed, needs you…). */
export function liveLine(o: LiveLineInput): LiveLine | null {
  if (!o.working) return null
  if (o.slotWaitSince) return { kind: 'waiting', label: SLOT_WAIT_LABEL, text: SLOT_WAIT_LINE, spin: false, why: SLOT_WAIT_WHY }
  const root = o.root && LIVE.has(o.root.status) ? o.root : null
  if (root?.stopReason === 'rate_limited')
    return { kind: 'waiting', label: 'Usage limit', text: root.resetAt ? `Hit the usage limit · resumes at ${clock(root.resetAt)}` : 'Hit the usage limit', spin: false, why: 'The agent reached its usage limit. It picks up again when the limit resets.' }
  if (root?.stalledSince) {
    const quiet = o.now - Date.parse(root.stalledSince) + o.stallMinutes * 60_000
    if (quiet >= STUCK_STALLS * o.stallMinutes * 60_000)
      return { kind: 'stuck', label: 'Not responding', text: `Not responding · quiet for ${minutes(quiet)}`, spin: false, why: 'No output for a long time. Open the full log to see what it last did, or stop it and try again.' }
    return { kind: 'slow', label: 'Taking longer', text: `Taking longer than usual · quiet for ${minutes(quiet)}`, spin: false, why: 'The agent has shown no output for a while. Long commands do this; it is not stopped.' }
  }
  if (root) return { kind: 'working', label: 'Working', text: o.doing || (root.status === 'starting' ? 'Starting…' : 'Working…'), spin: true }
  if (o.inChat) return { kind: 'in_chat', label: 'Working', text: 'Being worked on in its chat', spin: false }
  const waited = o.now - Date.parse(o.since)
  if (Number.isNaN(waited)) return { kind: 'waiting', label: 'Starting', text: 'Starting', spin: false }
  if (waited < START_SPIN_MS) return { kind: 'waiting', label: 'Starting', text: 'Starting…', spin: true }
  if (waited < START_STUCK_MS) return { kind: 'waiting', label: 'Starting', text: `Still starting · ${minutes(waited)}`, spin: false, why: 'The run was started but its agent has not shown up yet.' }
  return { kind: 'stuck', label: "Didn't start", text: `Didn't start · no agent after ${minutes(waited)}`, spin: false, why: 'The run never showed an agent. Open the task on the Board to try again.' }
}
