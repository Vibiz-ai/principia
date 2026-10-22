/**
 * VOICE.md §3.7 toast.task.done: the toast when you approve a task as done. "{persona} finished “{task}”." when the
 * task has an agent; *Bene factum* · well done rides along only on the first task-done toast of the day, and only in
 * playful (the Latin is rendered beside the text by the toaster, hidden from screen readers). A task with no agent
 * keeps the plain "PRN-14 is done".
 */
import { latinLine, t, type LatinPair, type Tone } from './voice/core'

/** localStorage key: the local day (YYYY-MM-DD) the Latin last rode a task-done toast. */
export const TASK_DONE_LATIN_KEY = 'principia.taskDoneLatinDay'

export interface TaskDoneToast {
  text: string
  latin?: LatinPair
  /** the day to store as "Latin shown", when it was shown */
  shownDay?: string
}

/** The local calendar day of `now`, as YYYY-MM-DD. */
export function localDay(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function taskDoneToast(
  i: { persona: string | null; task: string; identifier: string },
  tone: Tone,
  lastLatinDay: string | null,
  now: Date = new Date()
): TaskDoneToast {
  const persona = i.persona?.trim()
  const task = i.task.trim()
  if (!persona || !task) return { text: `${i.identifier} is done` }
  const text = t('toast.task.done', { persona, task }, tone)
  const day = localDay(now)
  const latin = lastLatinDay === day ? null : latinLine('toast.task.done', tone)
  return latin ? { text, latin, shownDay: day } : { text }
}
