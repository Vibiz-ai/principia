import type { Hive } from '../hive'
import { handle } from '../ipc'
export function registerGatewayHandlers(h: Hive): void {
  const service = () => { if (!h.gateway) throw new Error('Connections unavailable'); return h.gateway }
  handle('gateway:list', () => service().list())
  handle('gateway:save', input => service().save(input))
  handle('gateway:remove', ({id}) => service().remove(id))
  handle('gateway:test', ({id}) => service().test(id))
}
