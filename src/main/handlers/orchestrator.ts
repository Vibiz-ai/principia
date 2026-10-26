/**
 * ORCHESTRATOR.md §3, §5: the orchestrator:* channels. Views (a run's actions, the chief of staff's batches, open
 * suggestions) and one write: the founder's yes or no on a suggestion. The layer itself runs from run hooks.
 */
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'

export function registerOrchestratorHandlers(h: Hive): void {
  handle('orchestrator:forRun', ({ runId }) => {
    const o = h.orchestrator
    if (!o) return null
    return o.forRun(runId)
  })
  handle('orchestrator:suggestions', (q) => h.orchestrator?.openSuggestions(q?.companyId ?? null) ?? [])
  handle('orchestrator:decideSuggestion', ({ id, decision }) => {
    const o = h.orchestrator
    if (!o) throw new HiveError('conflict', 'Principia’s team layer is not running')
    try {
      return o.decideSuggestion(id, decision)
    } catch (e) {
      if (e instanceof HiveError) throw e
      throw new HiveError('conflict', e instanceof Error ? e.message : String(e))
    }
  })
  handle('orchestrator:decisions', ({ companyId, limit }) => h.orchestrator?.decisions(companyId, limit) ?? [])
}
