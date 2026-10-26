/**
 * ORCHESTRATOR.md §3, §5 in the renderer: the words for "Principia runs the team" (This company > Team & autonomy),
 * Principia's suggestions in Needs you, and the chief of staff's lines in Activity. Pure: no store, no DOM.
 */
import { orchestratorFor, type OrchDecisionRecord, type OrchDecisionResult, type OrchestratorCompanySettings, type OrchestratorSettings, type OrchSuggestion } from '@shared/orchestrator'

export const CHIEF = 'Principia (chief of staff)'

/** The three switches of one company, as the section shows them. */
export interface TeamSwitches {
  /** Principia runs the team (mode not off) */
  on: boolean
  /** "Let Principia decide next steps with AI" (coordinator 'model') */
  ai: boolean
  callsPerDay: number
  /** the app-wide debugging switch: Principia only writes down what it would do */
  shadow: boolean
}

export function teamSwitches(raw: Partial<OrchestratorSettings> | null | undefined, companyId: string): TeamSwitches {
  const s = orchestratorFor(raw, companyId)
  return { on: s.mode !== 'off', ai: s.coordinator === 'model', callsPerDay: s.callsPerDay, shadow: s.mode === 'shadow' }
}

/** The settings:update patch for one company's switch (other companies keep theirs; main merges company by company). */
export function teamPatch(companyId: string, change: { on?: boolean; ai?: boolean; callsPerDay?: number }): { orchestrator: { companies: Record<string, OrchestratorCompanySettings> } } {
  const own: OrchestratorCompanySettings = {
    ...(change.on !== undefined ? { mode: change.on ? 'on' : 'off' } : {}),
    ...(change.ai !== undefined ? { coordinator: change.ai ? 'model' : 'rules' } : {}),
    ...(change.callsPerDay !== undefined ? { callsPerDay: Math.min(200, Math.max(0, Math.round(change.callsPerDay))) } : {})
  }
  return { orchestrator: { companies: { [companyId]: own } } }
}

/** The button of a suggestion. */
export function suggestionAction(s: Pick<OrchSuggestion, 'kind' | 'taskId' | 'routineId'>): string {
  if (s.kind === 'routine') return s.routineId ? 'See the routine' : 'Make it a routine'
  if (s.kind === 'connection') return 'Set it up'
  return s.taskId ? 'Start it' : 'Add to To do'
}
/** The small label above a suggestion. */
export function suggestionKind(s: Pick<OrchSuggestion, 'kind'>): string {
  return s.kind === 'routine' ? 'Routine idea' : s.kind === 'connection' ? 'Connection' : 'Next step'
}

const STATUS: Record<OrchDecisionResult['status'], string> = { done: '', refused: 'Refused', skipped: 'Skipped', shadow: 'Would do', failed: 'Failed' }
/** One result as a line ("Skipped: …"); a done one reads as itself. */
export function resultLine(r: OrchDecisionResult): string {
  const head = STATUS[r.status]
  return head && !r.detail.startsWith('Refused') ? `${head}: ${r.detail}` : r.detail
}

const EVENT: Record<string, string> = { run_ended: 'a run ended', task_done: 'a task was done', task_created: 'a task was added', ask_answered: 'a question was answered', forum_human_post: 'you posted', tick: 'the daily check' }
/** "After a run ended and a task was added · with AI" */
export function batchLine(d: Pick<OrchDecisionRecord, 'events' | 'mode'>): string {
  const what = d.events.map((e) => EVENT[e] ?? e)
  const list = what.length <= 2 ? what.join(' and ') : `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}`
  return `After ${list || 'a change'}${d.mode === 'model' ? ' · with AI' : ''}`
}
