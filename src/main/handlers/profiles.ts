import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { resolveLoginEnv } from '../loginEnv'

export function registerProfileHandlers(h: Hive): void {
  handle('profiles:list', () => h.store.listProfiles())
  handle('profiles:create', (input) => {
    const p = h.store.createProfile(input)
    emit('data:changed', { domain: 'profiles' })
    return p
  })
  handle('profiles:update', ({ id, ...patch }) => {
    const p = h.store.updateProfile(id, patch)
    emit('data:changed', { domain: 'profiles' })
    return p
  })
  handle('profiles:remove', ({ id }) => {
    h.store.removeProfile(id)
    emit('data:changed', { domain: 'profiles' })
  })
  handle('providers:list', async (req) => {
    if (req?.refresh) {
      // Settings "Recheck": re-resolve the login env first so newly installed CLIs are found (SPEC A14)
      await resolveLoginEnv()
    }
    const list = await h.engine.providers.list({ refresh: !!req?.refresh })
    h.ensureSeeds()
    return list
  })
}
