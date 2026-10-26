import { shell } from 'electron'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { connectionsFor } from '../../shared/gateway'
export function registerGatewayHandlers(h: Hive): void {
  const service = () => { if (!h.gateway) throw new Error('Connections unavailable'); return h.gateway }
  /** AUTOPILOT.md §6: an autopilot waiting for this connection starts now (never fails the connection's own call) */
  const wake = <T>(v: T): T => { try { if (h.playbooks) for (const c of h.company.listPassports()) if (!c.archivedAt && c.system !== 'personal') h.playbooks.wakeWaiting(c.id) } catch { /* the hourly check tries again */ } return v }
  handle('gateway:connect', async ({id}) => wake(await service().connect(id, async value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid OAuth authorization URL'); await shell.openExternal(url.toString()) })))
  handle('gateway:disconnect', ({id}) => service().disconnect(id))
  handle('gateway:list', (q) => connectionsFor(service().list(), q?.companyId))
  handle('gateway:save', input => wake(service().save(input)))
  handle('gateway:remove', ({id}) => service().remove(id))
  handle('gateway:test', ({id}) => service().test(id))
}
