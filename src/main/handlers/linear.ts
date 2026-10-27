/**
 * LINEAR.md §6: the linear:* channels. Every request names a company; the service checks it exists. A pasted key
 * arrives on checkKey/connect only, and no response carries it (LinearStatusView has the Keys page mask at most).
 */
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import type { LinearSyncService } from '../company/sync/service'
import { connectionsChanged } from '../connections/events'

export function registerLinearHandlers(h: Hive): void {
  const svc = (): LinearSyncService => {
    if (!h.linear) throw new HiveError('not_implemented', 'Linear sync is not available in this Principia')
    return h.linear
  }
  handle('linear:status', ({ companyId }) => svc().status(companyId))
  handle('linear:checkKey', ({ companyId, key }) => svc().checkKey(companyId, key))
  handle('linear:preview', ({ companyId, teamId, key }) => svc().preview(companyId, teamId, key))
  // CONNECTIONS.md §3.7: Linear's card (sync + tools) follows
  const tell = <T>(companyId: string, v: T): T => (connectionsChanged(companyId, 'linear'), v)
  handle('linear:connect', async (q) => tell(q.companyId, await svc().connect(q)))
  handle('linear:sync', ({ companyId }) => svc().syncNow(companyId))
  handle('linear:setAutosync', ({ companyId, on }) => svc().setAutosync(companyId, on))
  handle('linear:disconnect', async ({ companyId }) => tell(companyId, await svc().disconnect(companyId)))
}
