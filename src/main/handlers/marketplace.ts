import os from 'node:os'
import { net } from 'electron'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { Marketplace } from '../marketplace'
import { resourcePath } from '../tray'
import { importWorkflowFile, parseWorkflowFile } from './workflows'

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

export function registerMarketplaceHandlers(h: Hive): void {
  const market = new Marketplace({
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
        command: n.type === 'shell' || n.type === 'wait' ? n.command : n.type === 'check' ? n.command : null
      }))
  })
  handle('marketplace:list', (req) => market.list({ refresh: req?.refresh }))
  handle('marketplace:preview', (ref) => market.preview(ref))
  handle('marketplace:install', ({ overwrite, ...ref }) => market.install(ref, { overwrite }))
}
