/**
 * Principia Cloud IPC (docs/CLOUD.md §13.1): cloud:* channels for the Cloud pane, the sidebar badge and Home's Needs
 * you. Every call goes through this Mac's CloudLink with its device token, which stays in main. Responses never carry
 * a token, key or credential: provider accounts, connections and keys are write-only in the cloud and here.
 */
import { shell } from 'electron'
import type {
  AuthorizeConnectionResponse,
  CloudAsk,
  CloudCompany,
  CloudDevice,
  CloudRunDetail,
  CloudRunSummary,
  CloudWorkspace,
  LoginLinkResponse,
  PassportProposal,
  ProviderAccount,
  ProviderTestResponse,
  WorkspaceSummary
} from '../../shared/cloud'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { bringBack, buildMovePlan, moveCompany, runOnce } from '../cloud/move'
import type { CloudWiring } from '../cloud/wire'

/** List routes may answer an array or `{ <key>: [...] }`. */
export function listOf<T>(x: unknown, key: string): T[] {
  if (Array.isArray(x)) return x as T[]
  const v = x && typeof x === 'object' ? (x as Record<string, unknown>)[key] : undefined
  return Array.isArray(v) ? (v as T[]) : []
}

/** GET /v1/runs/:id/log answers `{lines}`, `{text}` or text: always lines here. */
export function logLines(x: unknown): string[] {
  if (typeof x === 'string') return x.split('\n')
  if (x && typeof x === 'object') {
    const o = x as { lines?: unknown; text?: unknown }
    if (Array.isArray(o.lines)) return o.lines.map(String)
    if (typeof o.text === 'string') return o.text.split('\n')
  }
  return []
}

export function registerCloudHandlers(h: Hive, cloud: CloudWiring = h.cloud): void {
  const { link, logins } = cloud
  const call = link.call.bind(link)
  const providers = () => call((c) => c.call<unknown>('providers')).then((x) => listOf<ProviderAccount>(x, 'providers'))

  handle('cloud:state', () => link.state())
  handle('cloud:pair', (q) => link.pair(q))
  handle('cloud:unlink', async () => {
    logins.cancel()
    const s = await link.unlink()
    emit('data:changed', { domain: 'schedules' })
    return s
  })
  handle('cloud:summary', () => call((c) => c.call<WorkspaceSummary>('summary')))

  handle('cloud:providers', () => providers())
  handle('cloud:providerPut', async ({ adapter, kind, value }) => {
    await call((c) => c.call('providerPut', { params: { adapter }, body: { kind, value } }))
    return providers()
  })
  handle('cloud:providerDelete', async ({ adapter }) => {
    await call((c) => c.call('providerDelete', { params: { adapter } }))
    return providers()
  })
  handle('cloud:providerTest', ({ adapter, live }) => call((c) => c.call<ProviderTestResponse>('providerTest', { params: { adapter }, body: live ? { live: true } : {} })))

  // CLOUD.md §7.2: the flow runs in main; progress reaches the pane through evt:cloud (state.login)
  const startLogin = (adapter: 'claude' | 'codex') => {
    if (!link.linked) throw new HiveError('conflict', 'Connect this Mac to a cloud first.')
    void logins.start(adapter).then(() => emit('cloud', { kind: 'changes', runs: 0, asks: 0 }))
    return link.state().login ?? { adapter, phase: 'starting' as const, message: null, reason: null, installHint: null, browserUrl: null }
  }
  handle('cloud:loginClaude', () => startLogin('claude'))
  handle('cloud:loginCodex', () => startLogin('codex'))
  handle('cloud:loginCancel', () => logins.cancel())

  handle('cloud:movePlan', ({ companyId }) => {
    h.company.passport(companyId)
    return buildMovePlan(cloud.move, companyId)
  })
  handle('cloud:move', async (choices) => {
    h.company.passport(choices.companyId)
    const r = await moveCompany(cloud.move, choices)
    emit('data:changed', { domain: 'schedules' })
    return r
  })
  handle('cloud:runOnce', ({ companyId, workflowId }) => runOnce(cloud.move, companyId, workflowId))
  handle('cloud:bringBack', async ({ companyId }) => {
    await bringBack(cloud.move, companyId)
    emit('data:changed', { domain: 'schedules' })
    return link.state()
  })

  handle('cloud:runs', (q) => call((c) => c.call<unknown>('runs', { query: { companyId: q?.companyId, limit: q?.limit ?? 50 } })).then((x) => listOf<CloudRunSummary>(x, 'runs')))
  handle('cloud:run', ({ id }) => call((c) => c.call<CloudRunDetail>('run', { params: { id } })))
  handle('cloud:runLog', ({ id, stepId, tail }) => call((c) => c.call<unknown>('runLog', { params: { id }, query: { step: stepId, tail: tail ?? 200 } })).then((x) => ({ lines: logLines(x) })))
  handle('cloud:runCancel', async ({ id }) => {
    await call((c) => c.call('runCancel', { params: { id } }))
  })

  handle('cloud:asks', () => call((c) => c.call<unknown>('asks')).then((x) => listOf<CloudAsk>(x, 'asks')))
  handle('cloud:answer', async ({ id, answer }) => {
    const r = await call((c) => c.call<CloudAsk | { ask: CloudAsk }>('askAnswer', { params: { id }, body: { answer } }))
    void link.pollNow().catch(() => undefined)
    return (r && 'ask' in r ? r.ask : r) as CloudAsk
  })

  handle('cloud:proposals', ({ companyId }) => call((c) => c.call<unknown>('passportProposals', { params: { cid: companyId } })).then((x) => listOf<PassportProposal>(x, 'proposals')))
  handle('cloud:decideProposal', async ({ companyId, proposalId, decision }) => {
    await call((c) => c.call('passportDecide', { params: { cid: companyId, pid: proposalId, decision }, body: {} }))
  })

  handle('cloud:devices', () => call((c) => c.call<unknown>('devices')).then((x) => listOf<CloudDevice>(x, 'devices')))
  handle('cloud:revokeDevice', async ({ id }) => {
    if (id === link.state().deviceId) throw new HiveError('conflict', 'To remove this Mac, use Disconnect.')
    await call((c) => c.call('deviceRevoke', { params: { id } }))
    return call((c) => c.call<unknown>('devices')).then((x) => listOf<CloudDevice>(x, 'devices'))
  })
  // a fresh one-time console link: opened in the browser, or returned for the QR code and Copy
  handle('cloud:loginLink', async (q) => {
    const r = await call((c) => c.call<LoginLinkResponse>('loginLink', { body: {} }))
    if (q?.open && /^https?:\/\//.test(r.url)) await shell.openExternal(r.url)
    return r
  })
  handle('cloud:pause', ({ paused }) => call((c) => c.call<CloudWorkspace | { workspace: CloudWorkspace }>('workspacePatch', { body: { paused } })).then((r) => (r && 'workspace' in r ? r.workspace : r) as CloudWorkspace))
  handle('cloud:pauseCompany', ({ companyId, paused }) =>
    call((c) => c.call<CloudCompany | { company: CloudCompany }>('companyPatch', { params: { cid: companyId }, body: { paused } })).then((r) => (r && 'company' in r ? r.company : r) as CloudCompany)
  )
  handle('cloud:connectionAuthorize', async ({ companyId, connectionId }) => {
    const r = await call((c) => c.call<AuthorizeConnectionResponse>('connectionAuthorize', { params: { cid: companyId, id: connectionId }, body: {} }))
    if (/^https:\/\//.test(r.authorizeUrl)) await shell.openExternal(r.authorizeUrl)
    return r
  })

  // while linked: poll every 30 s and follow /v1/events (a revoked device stops itself)
  link.start()
}
