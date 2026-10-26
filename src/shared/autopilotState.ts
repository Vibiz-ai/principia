/**
 * AUTOPILOT.md §7: the one answer to "is Autopilot on?" for a company. The header chip, Home's line, the rail tile,
 * the All companies cards, the Autopilots tab and the phone's Now header all read it from here, so they can never
 * disagree. Two things run on their own, and the answer names both:
 * - the company switch (`autopilot`): agents that act on their own start the work assigned to them;
 * - the autopilots that are on (playbooks: Ads watch, Site watch…), each with its own schedule and level.
 * "Autopilot on" means either is on; the chip and the lines say which ("Autopilot on · Ads watch"). Pure.
 */
import { DEFAULT_MAX_IN_FLIGHT, type CompanyPassport } from './company'

export type AutopilotMode = 'on' | 'off' | 'held'
export interface AutopilotState {
  /** on: assigned work starts by itself; off: agents wait for Start; held: off while the company is paused */
  mode: AutopilotMode
  /** "Autopilot on" / "Autopilot off" / "Autopilot off while paused" */
  label: string
  /** tasks at once */
  maxInFlight: number
  /** dollars a month, null = no cap */
  monthlyCap: number | null
  /** the company switch alone: assigned work starts by itself */
  switchOn: boolean
  /** autopilots (playbooks) on for the company, paused or waiting ones included */
  playbooks: number
  /** their short names, in the order they were turned on ("Ads watch") */
  names: string[]
  /** of those: running, waiting for their connection, paused */
  active: number
  waiting: number
  paused: number
}

/** One playbook on, as the state reads it (shared/autopilotPlaybooks PlaybookSummary rows + their names). */
export interface PlaybookOn { name: string; running?: boolean; waiting?: boolean }

type Row = Pick<CompanyPassport, 'autopilot' | 'maxInFlight' | 'pausedAt' | 'monthlyCap' | 'archivedAt'>

export function autopilotState(c: Partial<Row> | null | undefined, playbooks: readonly PlaybookOn[] = []): AutopilotState {
  const maxInFlight = typeof c?.maxInFlight === 'number' && c.maxInFlight >= 1 ? c.maxInFlight : DEFAULT_MAX_IN_FLIGHT
  const monthlyCap = typeof c?.monthlyCap === 'number' && c.monthlyCap > 0 ? c.monthlyCap : null
  const switchOn = !!c?.autopilot
  const names = playbooks.map((p) => p.name)
  const mode: AutopilotMode = c?.pausedAt || c?.archivedAt ? 'held' : switchOn || names.length ? 'on' : 'off'
  const waiting = playbooks.filter((p) => p.waiting).length
  const active = playbooks.filter((p) => !p.waiting && p.running !== false).length
  const paused = playbooks.length - waiting - active
  // never overstate: playbooks that only wait for their connection say so
  // never overstate: a playbook that waits for its connection or is paused says so ("Ads watch paused")
  const tail = names.length === 1 && playbooks[0]!.waiting ? `${names[0]} waiting for its connection` : names.length === 1 && playbooks[0]!.running === false ? `${names[0]} paused` : names.length > 1 && !active ? `${namesLine(names)} ${waiting === names.length ? 'waiting for their connections' : waiting ? 'waiting or paused' : 'paused'}` : namesLine(names)
  const label = mode === 'held' ? 'Autopilot off while paused' : mode === 'on' ? `Autopilot on${names.length ? ` · ${tail}` : ''}` : 'Autopilot off'
  return { mode, label, maxInFlight, monthlyCap, switchOn, playbooks: names.length, names, active, waiting, paused }
}

/** "Ads watch", "Ads watch and Site watch", "3 autopilots" */
export function namesLine(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.length} playbooks`
}
/**
 * The header chip's words, never more than is true: "Autopilot on", "Autopilot on · 1 active" (a playbook that runs),
 * "Autopilot on · 1 waiting for its connection", "Autopilot on · 1 paused", "Autopilot off". The names are in the
 * tooltip, the panel and Home's line.
 */
export function chipLabel(st: AutopilotState): string {
  if (st.mode !== 'on') return st.mode === 'held' ? 'Autopilot off while paused' : 'Autopilot off'
  const segs: string[] = []
  if (st.active) segs.push(`${st.active} active`)
  if (st.waiting) segs.push(`${st.waiting} waiting for ${st.waiting === 1 ? 'its connection' : 'their connections'}`)
  if (st.paused) segs.push(`${st.paused} paused`)
  return segs.length ? `Autopilot on · ${segs.join(' · ')}` : 'Autopilot on'
}

/**
 * AUTOPILOT.md §0, one name for one thing:
 * - Autopilot: everything in a company that runs without you pressing Start (the header chip and its panel);
 * - Auto-start: the company switch inside it (agents set to work on their own start what is assigned to them);
 * - playbooks: recurring watches with a level and hard limits (Ads watch…), listed under "On autopilot";
 * - schedule packs: the Setup checklist's ready-made bundles of ordinary schedules (Marketing pack, Company pack).
 */
export const AUTO_START = 'Auto-start'
/** The chip's words where the header is narrow: the same, with "waiting" for "waiting for its connection". */
export const chipShort = (st: AutopilotState): string => chipLabel(st).replace(/ waiting for (its|their) connections?/, ' waiting')

/** One line on what Auto-start does. */
export const AUTOPILOT_WHAT = 'Agents set to work on their own start the work assigned to them, without waiting for you to press Start.'
/** One sentence on Autopilot as a whole (onboarding, Start the first week, the new-company sheet). */
export const AUTOPILOT_SENTENCE = 'Autopilot lets work run without you pressing Start: agents set to work on their own pick up what is assigned to them, and schedules run at their times. Turn it off any time from the Autopilot chip.'

/** "Up to 3 tasks at once · monthly cap $200" (or "· no monthly cap"). */
export function autopilotLimits(s: Pick<AutopilotState, 'maxInFlight' | 'monthlyCap'>): string {
  return `Up to ${s.maxInFlight} task${s.maxInFlight === 1 ? '' : 's'} at once · ${s.monthlyCap ? `monthly cap $${s.monthlyCap}` : 'no monthly cap'}`
}

/** "N tasks will start" before Autopilot goes on (old leftover work never starts silently). */
export function willStartLine(n: number, max: number): string {
  if (n <= 0) return 'Nothing waits in To do, so nothing starts right away.'
  const now = Math.min(n, max)
  return n <= max ? `${n} task${n === 1 ? '' : 's'} will start right away.` : `${n} tasks are waiting: ${now} will start right away, the rest as others finish.`
}

/**
 * Home's one-line answer: "Northwind · nothing needs you · Autopilot on: Ads watch." (paused keeps its line). The
 * switch alone reads "Autopilot on"; autopilots read their names, so "is it on?" is answered with what runs.
 */
export function withAutopilot(line: string, st: AutopilotState | null): string {
  if (!st || st.mode === 'held') return line
  const tail = st.mode === 'off' ? 'Autopilot off' : st.playbooks ? `Autopilot on: ${st.label.replace(/^Autopilot on · /, '')}` : 'Autopilot on'
  return `${line.replace(/\.$/, '')} · ${tail}.`
}
