/**
 * The screen each company was left on (a per-Mac convenience, as Chats remembers its last conversation): switching
 * back to a company opens it there, not Home. Only what the screen *is* is kept; one-shot asks riding on a view
 * (open the quick-add box, the create sheet, a Connect card, a routine to add) are dropped so coming back does not
 * fire them again.
 */
import type { ViewState } from '../state/store'

/** Keys of a view that ask for something once, when it opens. */
const ONE_SHOT = ['quick', 'create', 'seed', 'addRoutine', 'addPlaybook', 'routineTime', 'connect', 'purpose', 'focus'] as const

/** Where a company's last screen is kept ('all' = All companies). */
export const lastScreenKey = (scope: string): string => `hive.company.screen.${scope}`

/** `view` as it is worth coming back to: the same screen without its one-shot asks. */
export function screenToKeep(view: ViewState): ViewState {
  const out: Record<string, unknown> = { ...view }
  for (const k of ONE_SHOT) delete out[k]
  return out as ViewState
}

/** A kept screen read back from storage, or null when it is not one (missing, corrupt, from an older build). */
export function keptScreen(v: unknown): ViewState | null {
  return v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? (v as ViewState) : null
}

/** Is a kept screen still there? An agent's desk or a department page that was removed or archived since is not. */
export function screenStillThere(view: ViewState, have: { agents: { id: string; archivedAt: string | null }[]; departments: { id: string; archivedAt: string | null }[] }): boolean {
  const live = (rows: { id: string; archivedAt: string | null }[], id: string): boolean => rows.some((r) => r.id === id && !r.archivedAt)
  if (view.name === 'agentSeat') return live(have.agents, view.id)
  if (view.name === 'department') return live(have.departments, view.id)
  return true
}
