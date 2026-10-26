import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { baseChildEnv, resolveLoginEnv } from '../loginEnv'
import { defaultGhExec } from '../onboarding/github'
import { parseClaudeAuth, type ClaudeAuthStatus } from '../../shared/providerAuth'

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
    // DEPARTMENTS.md §1.1: an agent seat never points at a deleted profile
    h.company.departments.assertNotBacking('profile', id)
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
  // five doors E12: the real Claude check (`claude auth status --json`), cached for a minute; Recheck refreshes it
  let authMemo: { at: number; v: ClaudeAuthStatus } | null = null
  handle('providers:claudeAuth', async (req) => {
    if (!req?.refresh && authMemo && Date.now() - authMemo.at < 60_000) return authMemo.v
    const claude = (await h.engine.providers.list({ refresh: !!req?.refresh })).find((p) => p.id === 'claude')
    let v: ClaudeAuthStatus
    if (!claude?.available || !claude.binPath) v = parseClaudeAuth({ code: null, stdout: '', missing: true })
    else {
      const r = await defaultGhExec(claude.binPath, ['auth', 'status', '--json'], { env: baseChildEnv(), timeoutMs: 10_000, outputCap: 16 * 1024 }).promise
      v = parseClaudeAuth({ code: r.code, stdout: r.stdout, timedOut: r.timedOut, missing: !!r.spawnError && /ENOENT/.test(r.spawnError) })
    }
    authMemo = { at: Date.now(), v }
    return v
  })
}
