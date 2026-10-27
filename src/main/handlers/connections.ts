/**
 * CONNECTIONS.md §3.6: the connections:* channels. Every answer is a ServiceStatus (names, states, masked forms); a
 * pasted key arrives once on connectKey and never comes back. The forms keep their own channels (secrets:*, gateway:*,
 * linear:*, slack:*, dashboards:*); these only add the one-service view and the shared connect flow.
 */
import crypto from 'node:crypto'
import { BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { HiveError } from '../../shared/errors'
import { connectionsFor } from '../../shared/gateway'
import { dashboardDef, type DashboardKind } from '../../shared/dashboards'
import { connectionHost, keyAliases, keyForms, mcpForm, serviceById, serviceForConnection, type Purpose, type ServiceDef, type ServiceStatus } from '../../shared/services'
import { CompanySecrets } from '../db/companySecrets'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { cleanSettings } from '../connections/store'
import { connectionsChanged } from '../connections/events'
import type { ConnectionResolver } from '../connections/resolver'

const VALUE_MAX = 64 * 1024

export function registerConnectionHandlers(h: Hive): void {
  const resolver = (): ConnectionResolver => {
    if (!h.connections) throw new HiveError('not_implemented', 'Connections are not available in this Principia')
    return h.connections
  }
  const company = new CompanySecrets(h.db, { available: () => safeStorage.isEncryptionAvailable(), encrypt: (v: string) => safeStorage.encryptString(v), decrypt: (b: Buffer) => safeStorage.decryptString(b) })
  const def = (id: string): ServiceDef => {
    const s = serviceById(id)
    if (!s) throw new HiveError('bad_request', 'Unknown service')
    return s
  }
  const changed = (companyId: string, serviceId: string): ServiceStatus => {
    connectionsChanged(companyId, serviceId)
    // AUTOPILOT.md §6: an autopilot waiting for this service starts now (never fails the connect itself)
    h.safe(() => h.playbooks?.wakeWaiting(companyId), undefined)
    return resolver().status(companyId, serviceId)
  }

  handle('connections:list', ({ companyId }) => resolver().list(companyId))
  handle('connections:get', ({ companyId, serviceId }) => resolver().status(companyId, serviceId))
  handle('connections:usage', ({ companyId, serviceId }) => resolver().status(companyId, serviceId).usedBy)

  handle('connections:connectKey', async ({ companyId, serviceId, keys, settings, purpose }) => {
    const s = def(serviceId)
    resolver().status(companyId, serviceId) // company exists
    const fields = keyForms(s).flatMap((f) => f.keys)
    const pasted: Record<string, string> = {}
    for (const [name, raw] of Object.entries(keys)) {
      const field = fields.find((k) => k.name === name)
      if (!field) throw new HiveError('validation', `${name} is not a ${s.name} key`, [{ path: `keys.${name}`, message: `Not a ${s.name} key` }])
      const v = raw.trim()
      if (!v) continue
      if (v.length > VALUE_MAX) throw new HiveError('validation', `${field.label} is too long`, [{ path: `keys.${name}`, message: 'That is too long to be a key' }])
      for (const r of field.refuse ?? []) {
        if (r.purposes && purpose && !r.purposes.includes(purpose)) continue
        if (new RegExp(r.pattern).test(v)) throw new HiveError('validation', r.reason, [{ path: `keys.${name}`, message: r.reason }])
      }
      pasted[name] = v
    }
    if (!Object.keys(pasted).length) throw new HiveError('validation', 'Paste a key first', [{ path: 'keys', message: 'Paste a key first' }])
    const before = resolver().status(companyId, serviceId)
    // a company that pastes its own key stops borrowing: its own settings apply from now on (checked like any save)
    const clean = resolver().checkSettings(serviceId, cleanSettings(serviceId, settings ?? {}))
    const merged = { ...(before.sharedFrom ? {} : before.settings), ...clean }
    // CONN-QA-01: the vendor's read-only check runs on every connect (the dashboard's own check when its settings are
    // known, else a check of the key alone, like PostHog's /api/users/@me). A rejected key stores nothing; a check that
    // can't reach the vendor saves the key as "not checked".
    let checked: 'ok' | 'unchecked' | 'none' = 'none'
    const kind = s.capabilities.find((c) => c.purpose === 'dashboard')?.refs?.[0] as DashboardKind | undefined
    const dash = kind ? dashboardDef(kind) : undefined
    if (dash && h.dashboards && dash.keys.some((k) => k.name in pasted)) {
      const r = await h.dashboards.checkKeys(dash.id, companyId, pasted, merged)
      checked = r.checked
      for (const [k, v] of Object.entries(r.settings ?? {})) if (!merged[k]) clean[k] = v
    }
    for (const [name, value] of Object.entries(pasted)) {
      const field = fields.find((k) => k.name === name)!
      company.set(companyId, name, value, `${s.name} · ${field.label}`)
      // QP-10: "Replace" on a key saved under an older name saves it under the new name: never two keys side by side
      for (const old of keyAliases(name)) if (company.get(companyId, old)) company.remove(companyId, old)
    }
    h.vault.refreshRedactions()
    h.memory?.refreshFingerprints()
    // a new key replaces whatever a vendor said about the old one
    resolver().clearKeyProblems(companyId, serviceId, Object.keys(pasted))
    if (before.sharedFrom) resolver().reuse(companyId, serviceId, null)
    if (Object.keys(clean).length) resolver().settings(companyId, serviceId, clean)
    emit('data:changed', { domain: 'secrets' })
    return { ...changed(companyId, serviceId), checked }
  })

  handle('connections:signIn', async ({ companyId, serviceId }) => {
    const s = def(serviceId)
    const form = mcpForm(s)
    if (!form) throw new HiveError('validation', `${s.name} has no sign-in. Paste a key instead.`)
    if (form.setupRequired) throw new HiveError('validation', s.note ?? `${s.name} can’t be connected in one click yet.`)
    if (form.auth !== 'oauth') throw new HiveError('validation', `${s.name} connects with a token, not a browser sign-in. Paste it on its card.`)
    const gw = h.gateway
    if (!gw) throw new HiveError('not_implemented', 'Connections unavailable')
    resolver().status(companyId, serviceId) // company exists
    // this company's own connection to the service first, then a shared one; else a new one only this company gets.
    // SEC-1: only a connection at the service's own https URL is reused for a sign-in, never a look-alike by name
    const mine = connectionsFor(gw.list(), companyId).filter((c) => c.transport === 'http' && c.authentication === 'oauth' && serviceForConnection(c)?.id === s.id)
    let conn = mine.find((c) => c.companyIds?.includes(companyId)) ?? mine[0]
    if (!conn) conn = gw.save({ id: `connection-${crypto.randomUUID()}`, name: s.name, transport: 'http', url: form.url, authentication: 'oauth', enabled: true, roots: [], scope: 'global', companyIds: [companyId] })
    resolver().linkConnection(companyId, serviceId, conn.id)
    await gw.connect(conn.id, async (value) => {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid OAuth authorization URL')
      await shell.openExternal(url.toString())
    })
    return changed(companyId, serviceId)
  })

  handle('connections:settings', ({ companyId, serviceId, settings }) => {
    def(serviceId)
    const clean = cleanSettings(serviceId, settings)
    // an empty value clears that setting
    for (const k of Object.keys(settings)) if (!(k in clean) && (serviceById(serviceId)?.settings ?? []).some((f) => f.key === k)) clean[k] = ''
    resolver().settings(companyId, serviceId, clean)
    return changed(companyId, serviceId)
  })

  handle('connections:choose', ({ companyId, serviceId, purpose, keyName }) => {
    resolver().chooseKey(companyId, serviceId, purpose as Purpose, keyName)
    return changed(companyId, serviceId)
  })

  handle('connections:reuse', ({ companyId, serviceId, from }) => {
    const was = h.connections?.status(companyId, serviceId).sharedFrom?.companyId ?? null
    resolver().reuse(companyId, serviceId, from)
    // the lending company's card lists who uses it
    connectionsChanged(from ?? was)
    return changed(companyId, serviceId)
  })

  handle('connections:confirm', ({ companyId, serviceId, connectionId }) => {
    def(serviceId)
    resolver().confirmConnection(companyId, serviceId, connectionId)
    return changed(companyId, serviceId)
  })

  handle('connections:sources', ({ companyId, serviceId }) => {
    def(serviceId)
    return resolver().sources(companyId, serviceId)
  })

  handle('connections:keyTools', ({ companyId, serviceId, on }) => {
    const s = def(serviceId)
    const bearer = mcpForm(s)?.bearerFromKey
    if (!bearer?.optIn) throw new HiveError('validation', `${s.name}’s key already gives agents its tools.`)
    if (on) resolver().chooseKey(companyId, serviceId, 'agentTools', bearer.key)
    else resolver().unchooseKey(companyId, serviceId, 'agentTools')
    return changed(companyId, serviceId)
  })

  handle('connections:disconnect', async ({ companyId, serviceId, forms }, sender) => {
    const s = def(serviceId)
    const gw = h.gateway
    // SEC-5 / QP-3: every name of the service's keys (POSTHOG_API_KEY too); SEC-1 / SEC-2: only the connections that ARE it
    const plan = resolver().disconnectPlan(companyId, serviceId, (n) => !!company.get(companyId, n))
    const st = plan.status
    const ownKeys = forms.includes('key') ? plan.keys : []
    const ownConns = forms.includes('mcp') && gw ? plan.connections : []
    if (!ownKeys.length && !ownConns.length) {
      const shared = st.forms.some((f) => f.keyNames?.some((k) => k.source === 'shared') || f.detail.includes('shared by every company'))
      if (st.sharedFrom) throw new HiveError('validation', `This company uses ${st.sharedFrom.name}’s ${s.name}. Stop using it here instead; disconnecting is done in ${st.sharedFrom.name}.`)
      throw new HiveError('validation', shared ? `${s.name} is shared by every company here. Remove it from Settings › Keys (Shared) or its connection card.` : `${s.name} has nothing of this company’s to remove.`)
    }
    const borrowers = plan.borrowers.map((b) => b.name)
    const used = st.usedBy.filter((u) => u.kind !== 'company').map((u) => u.label)
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Disconnect', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Disconnect ${s.name}?`,
      detail: [
        ownKeys.length ? `Removes ${ownKeys.join(', ')} from this company’s keys.` : '',
        ownConns.length ? `Removes ${ownConns.map((c) => `the connection “${c.name}” (${connectionHost(c)})`).join(' and ')}.` : '',
        used.length ? `Stops working: ${used.join(', ')}.` : '',
        borrowers.length ? `${borrowers.join(', ')} ${borrowers.length === 1 ? 'uses' : 'use'} this company’s ${s.name} and ${borrowers.length === 1 ? 'loses' : 'lose'} it too.` : ''
      ].filter(Boolean).join('\n\n')
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response !== 0) return st
    for (const n of ownKeys) company.remove(companyId, n)
    for (const c of ownConns) {
      if ((c.companyIds?.length ?? 0) > 1) {
        const { hasCredentials: _h, authStatus: _s, authError: _e, ...input } = c
        gw!.save({ ...input, companyIds: c.companyIds!.filter((id) => id !== companyId) })
      }
      else gw!.remove(c.id)
    }
    if (ownKeys.length) {
      h.vault.refreshRedactions()
      h.memory?.refreshFingerprints()
      emit('data:changed', { domain: 'secrets' })
      resolver().clearKeyProblems(companyId, serviceId)
    }
    if (ownConns.length && st.forms.some((f) => f.kind === 'mcp' && f.connectionId && ownConns.some((c) => c.id === f.connectionId) && !f.exact)) resolver().confirmConnection(companyId, serviceId, null)
    const after = changed(companyId, serviceId)
    // SEC-7: with nothing left to lend, the borrowers stop for good (never a dormant link that wakes up on a reconnect)
    if (after.state === 'notConnected') {
      for (const b of st.usedBy.filter((u) => u.kind === 'company' && u.id)) {
        h.safe(() => resolver().reuse(b.id!, serviceId, null), undefined)
        connectionsChanged(b.id!, serviceId)
      }
    }
    return after
  })
}
