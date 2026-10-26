/**
 * LINEAR.md §6: builds the Linear sync service over the app. The key is the company key LINEAR_API_KEY
 * (company_secrets, safeStorage, listed on the Keys page); saving or removing it refreshes the redaction table and
 * memory's fingerprints like the Keys page does. Changes reach the renderer as data:changed tasks/secrets.
 */
import { app } from 'electron'
import { CompanySecrets } from '../../db/companySecrets'
import type { Hive } from '../../hive'
import { emit } from '../../ipc'
import { log } from '../../log'
import type { Cipher } from '../../vault'
import { LINEAR_API, LINEAR_KEY_NAME, linearEndpoint } from './linear'
import { LinearSyncService } from './service'

export function wireLinearSync(h: Hive, cipher: Cipher): LinearSyncService {
  const secrets = new CompanySecrets(h.db, cipher)
  const keysChanged = () => {
    h.vault.refreshRedactions()
    h.memory?.refreshFingerprints()
    emit('data:changed', { domain: 'secrets' })
  }
  const c = h.company
  const svc = new LinearSyncService({
    db: h.db,
    board: {
      tasks: (companyId) => c.listTasks(companyId),
      createFromRemote: (input) => c.createFromRemote(input),
      applyRemote: (id, patch, message) => c.applyRemote(id, patch, message),
      note: (id, message) => { c.activity(id, 'updated', message, 'system') },
      inFlight: (t) => t.status === 'in_progress' && !!t.runId,
      depsDone: (t) => t.dependencyIds.every((d) => { try { return c.task(d).status === 'done' } catch { return false } }),
      onTaskWrite: (fn) => c.onTaskWrite(fn),
      setExternalLinks: (fn) => c.setExternalLinks(fn),
      companyExists: (id) => h.safe(() => !!c.passport(id), false),
      companyName: (id) => h.safe(() => c.passport(id).name, null)
    },
    keys: {
      // the prefix only ("lin_…••••"): the Board never shows any part of the secret itself
      masked: (companyId) => { const m = secrets.get(companyId, LINEAR_KEY_NAME)?.masked; return m ? `${m.split('…')[0]}…••••` : null },
      reveal: (companyId) => (secrets.get(companyId, LINEAR_KEY_NAME) ? secrets.reveal(companyId, LINEAR_KEY_NAME) : null),
      save: (companyId, value) => { secrets.set(companyId, LINEAR_KEY_NAME, value, 'Linear sync'); keysChanged() },
      remove: (companyId) => { if (secrets.get(companyId, LINEAR_KEY_NAME)) { secrets.remove(companyId, LINEAR_KEY_NAME); keysChanged() } }
    },
    onChange: () => emit('data:changed', { domain: 'tasks' }),
    log
  })
  if (linearEndpoint() !== LINEAR_API) log.warn('linear: PRINCIPIA_LINEAR_API is set, Linear sync talks to a local fake', { endpoint: linearEndpoint() })
  svc.start()
  app.on('will-quit', () => svc.stop())
  return svc
}
