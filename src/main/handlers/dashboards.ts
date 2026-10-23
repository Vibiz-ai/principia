/**
 * DASHBOARDS.md §8: the dashboards:* channels. Every channel needs the Companies + Departments flags; ids are resolved
 * to their own company by the service, never trusted from the renderer. Pasted keys arrive on install/update only and
 * no response carries a key value.
 */
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import type { DashboardService } from '../dashboards/service'

export function registerDashboardHandlers(h: Hive): void {
  const svc = (): DashboardService => {
    const s = h.dashboards
    if (!s) throw new HiveError('not_implemented', 'Dashboards are not available in this Principia')
    s.assertEnabled()
    return s
  }
  handle('dashboards:list', ({ companyId, departmentId }) => svc().list(companyId, departmentId))
  handle('dashboards:keys', ({ companyId, kind }) => svc().lookupKeys(companyId, kind))
  handle('dashboards:install', (req) => svc().install(req))
  handle('dashboards:update', ({ id, config, keys }) => svc().update(id, { config, keys }))
  handle('dashboards:refresh', ({ id }) => svc().refresh(id))
  handle('dashboards:remove', ({ id }) => svc().remove(id))
  handle('dashboards:sample', ({ kind }) => svc().sample(kind))
}
