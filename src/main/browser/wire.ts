/**
 * BROWSER.md: the company browser inside Principia's main process. Builds the host (views, sessions, debugger) and the
 * service (tokens, 127.0.0.1 endpoint, MCP spec), and registers the browser:* IPC handlers.
 */
import { dialog, shell } from 'electron'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'
import { HiveError } from '../../shared/errors'
import { addressToUrl, type BrowserState } from '../../shared/browser'
import { BrowserError } from './driver'
import { BrowserHost } from './host'
import { BrowserService, bridgeScriptPath } from './service'
import fs from 'node:fs'

export interface BrowserWiring {
  host: BrowserHost
  service: BrowserService
}

const originOf = (u: string | null | undefined): string | null => {
  if (!u) return null
  try {
    const x = new URL(u)
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : null
  } catch {
    return null
  }
}

export function createBrowser(h: Hive, o: { mainDir: string }): BrowserWiring {
  let service: BrowserService | null = null
  const host = new BrowserHost({
    window: () => h.windows?.get() ?? null,
    workspaceDir: (companyId) => h.company.workspaceDir(companyId),
    // Principia's own pages and servers stay out of reach of the company browser
    blockedOrigins: () =>
      [originOf(process.env.ELECTRON_RENDERER_URL), service?.url ?? null, originOf(h.forum?.http?.url), originOf(h.remote?.state().localUrl ?? null)].filter((x): x is string => !!x),
    emit: (s) => emit('browser:changed', s),
    confirm: async (message, detail) => {
      const win = h.windows?.get()
      const opts = { type: 'warning' as const, message, detail, buttons: ['Download', 'Cancel'], defaultId: 1, cancelId: 1 }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    },
    log
  })
  const bridge = bridgeScriptPath(o.mainDir)
  service = new BrowserService({
    backend: host,
    bridgeScript: fs.existsSync(bridge) ? bridge : null,
    log
  })
  void service.start().catch((e) => log.error('browser endpoint failed', { error: String(e) }))
  return { host, service }
}

export function registerBrowserHandlers(h: Hive): void {
  const host = (): BrowserHost => {
    if (!h.browser) throw new HiveError('internal', 'The company browser is not available in this Principia')
    return h.browser.host
  }
  const company = (id: string): string => {
    // only a company this Principia has
    if (!companyExists(h, id)) throw new HiveError('not_found', 'No such company')
    return id
  }
  const wrap = async (f: () => Promise<unknown> | unknown, companyId: string, scope: string): Promise<BrowserState> => {
    try {
      await f()
    } catch (e) {
      if (e instanceof BrowserError) throw new HiveError('bad_request', e.message)
      throw e
    }
    return host().state(companyId, scope)
  }
  // every call names the chat or task on screen (its scope): the panel only reaches that chat's tabs
  handle('browser:state', ({ companyId, scope }) => host().state(company(companyId), scope))
  handle('browser:bounds', ({ companyId, scope, bounds }) => {
    host().setBounds(company(companyId), scope, bounds)
  })
  handle('browser:navigate', ({ companyId, scope, url }) => wrap(() => host().navigate(company(companyId), scope, addressToUrl(url)), companyId, scope))
  handle('browser:nav', ({ companyId, scope, action }) => wrap(() => host().nav(company(companyId), scope, action), companyId, scope))
  handle('browser:tab', ({ companyId, scope, op, tabId, url }) =>
    wrap(() => {
      const id = company(companyId)
      if (op === 'new') {
        const v = url ? host().check(addressToUrl(url)) : null
        if (v && !v.ok) throw new BrowserError(v.reason)
        host().openTab(id, scope, v?.ok ? v.url : undefined)
      } else if (op === 'select') host().selectTab(id, scope, tabId ?? '')
      else host().closeTab(id, scope, tabId ?? '')
    }, companyId, scope)
  )
  handle('browser:takeover', ({ companyId, scope, on }) => wrap(() => host().setTakeover(company(companyId), scope, on), companyId, scope))
  handle('browser:openShot', async ({ companyId, id }) => {
    const p = host().shotPath(company(companyId), id)
    if (!p) throw new HiveError('not_found', 'That screenshot is gone')
    const err = await shell.openPath(p)
    if (err) throw new HiveError('internal', err)
  })
  handle('browser:clear', ({ companyId, scope }) => wrap(() => host().clear(company(companyId)), companyId, scope))
}

function companyExists(h: Hive, id: string): boolean {
  try {
    return !!h.company.passport(id)
  } catch {
    return false
  }
}
