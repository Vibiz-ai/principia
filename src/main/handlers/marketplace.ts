import os from 'node:os'
import { net } from 'electron'
import type { Id } from '../../shared/types'
import type { MarketInstallResult, MarketRef } from '../../shared/marketplace'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { Marketplace } from '../marketplace'
import { resourcePath } from '../tray'
import { importWorkflowFile, parseWorkflowFile } from './workflows'
import { guardWorkflowTargets, requireCompany } from './companyScope'

/** https GET with a size cap and a 15 s timeout (main process, so no CORS and no renderer network access). */
async function fetchText(url: string, maxBytes: number): Promise<string> {
  if (!url.startsWith('https://')) throw new Error('only https:// links are allowed')
  const res = await net.fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('file is too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) throw new Error('file is too large')
  return buf.toString('utf8')
}

/** One Marketplace per Hive (the IPC handlers and onboarding launch share it, so the built-in catalog is read once). */
const markets = new WeakMap<Hive, Marketplace>()
export function marketplaceFor(h: Hive): Marketplace {
  let market = markets.get(h)
  if (market) return market
  market = new Marketplace({
    builtinDir: resourcePath('marketplace'),
    homeDir: os.homedir(),
    remoteUrl: () => h.store.getSettings().marketplaceUrl ?? null,
    fetchText,
    workflowNames: () => h.store.listWorkflows().map((w) => w.name),
    importWorkflow: (raw) => importWorkflowFile(h, raw),
    workflowNodes: (raw) =>
      parseWorkflowFile(h, raw).nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        ...(n.type === 'agent' ? { prompt: n.prompt } : {}),
        command: n.type === 'shell' || n.type === 'wait' ? n.command : n.type === 'check' ? n.command : null
      }))
  })
  markets.set(h, market)
  return market
}

/**
 * marketplace:install (also used by onboarding launch). COMPANY.md §6: workflows install into the caller's company
 * (absent = Personal, like first-run seeds); a refused cross-company install is undone.
 */
export async function installFromMarketplace(h: Hive, { overwrite, companyId, ...ref }: MarketRef & { overwrite?: boolean; companyId?: Id }): Promise<MarketInstallResult> {
  const market = marketplaceFor(h)
  const target = requireCompany(h, companyId)
  const result = await market.install(ref, { overwrite })
  if ('workflowId' in result && companyId) {
    const wf = h.store.getWorkflow(result.workflowId)
    if (wf && wf.companyId !== target) {
      try {
        guardWorkflowTargets(h, target, wf)
      } catch (e) {
        // refused (flag on): undo the install instead of leaving the copy in Personal
        h.store.removeWorkflow(wf.id)
        emit('data:changed', { domain: 'workflows' })
        throw e
      }
      h.store.setWorkflowCompany(wf.id, target)
      emit('data:changed', { domain: 'workflows' })
    }
  }
  return result
}

export function registerMarketplaceHandlers(h: Hive): void {
  const market = marketplaceFor(h)
  handle('marketplace:list', (req) => market.list({ refresh: req?.refresh }))
  handle('marketplace:preview', (ref) => market.preview(ref))
  // COMPANY.md §6: workflows install into the caller's company (absent = Personal, like first-run seeds)
  handle('marketplace:install', (req) => installFromMarketplace(h, req))
}
