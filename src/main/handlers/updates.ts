/** RELEASING.md §4: updates:* (Settings › About and the "Update ready" toast). */
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { initialUpdateState, type RestartResult, type UpdateState } from '../../shared/updates'

export function registerUpdateHandlers(h: Hive): void {
  // a Principia without the service (it failed to build) answers like a build with updates off
  const off = (): UpdateState => initialUpdateState('', 'Updates are not available in this Principia.')
  handle('updates:state', (): UpdateState => h.updates?.state() ?? off())
  handle('updates:check', (): Promise<UpdateState> | UpdateState => h.updates?.check() ?? off())
  handle('updates:restart', (): RestartResult => h.updates?.restart() ?? { restarting: false, reason: 'No update is ready to install.' })
}
