import { shell } from 'electron'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { connectionsFor } from '../../shared/gateway'
export function registerGatewayHandlers(h: Hive): void {
  const service = () => { if (!h.gateway) throw new Error('Connections unavailable'); return h.gateway }
  handle('gateway:connect', ({id}) => service().connect(id, async value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid OAuth authorization URL'); await shell.openExternal(url.toString()) }))
  handle('gateway:disconnect', ({id}) => service().disconnect(id))
  handle('gateway:list', (q) => connectionsFor(service().list(), q?.companyId))
  handle('gateway:save', input => service().save(input))
  handle('gateway:remove', ({id}) => service().remove(id))
  handle('gateway:test', ({id}) => service().test(id))
}
