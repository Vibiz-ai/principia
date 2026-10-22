/**
 * The control plane app (CLOUD.md §6): node:http, no framework. Every route in CLOUD_ROUTES, CloudError bodies, body
 * caps, company scoping, an audit entry per mutation, SSE events, the static console with a strict CSP, the
 * connect-link page, and connector OAuth callbacks. Routes in NOT_IN_V1_ROUTES answer 501 `not_in_v1`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  CLOUD_API_VERSION, CLOUD_LIMITS, CLOUD_ROUTES, NOT_IN_V1_ROUTES, SESSION_TTL_MS, formatConnectLink,
  type CloudEvent, type CloudRouteName, type CloudRunTrigger, type MeResponse, type WorkspaceSummary
} from '../../shared/cloud'
import type { CloudRuntime, ControlPorts } from '../contract'
import {
  PairLimiter, anyDevicePaired, authenticate, checkAdmin, checkCsrf, completePairing, consumeLoginLink, createLoginLink, listDevices,
  mintPairingCode, revokeDevice, sessionCookie, type Principal
} from './auth'
import { createCompanies } from './companies'
import { createConnections } from './connections'
import { EventHub, NOOP_BILLING, auditEntries, workspaceOf, writeAudit, type Actor, type BillingSink, type ControlConfig, type Ctx } from './context'
import { iso, newId, openControlDb, type ControlDb } from './db'
import { API_HEADERS, ApiError, badRequest, clientIp, escapeHtml, notFound, readJson, sendHtml } from './http'
import { createLogger, createRedactor } from './log'
import { createPassportHost, type PassportHost } from './passportHost'
import { isPassportPath, proxyToPassport } from './passportProxy'
import { createProviders } from './providers'
import { createQueue } from './queue'
import { createSync, decodeCursor } from './sync'
import { usageSummary } from './usage'
import { createWrappedDek, openVault } from './vault'

export interface ControlAppOptions {
  config: ControlConfig
  masterKey: Buffer
  /** path of control.db (default <dataDir>/control.db), or an open db */
  db?: string | ControlDb
  createRuntime(ports: ControlPorts): CloudRuntime
  now?: () => Date
  logWrite?: (line: string) => void
  billing?: BillingSink
  /** SSE heartbeat (default 20 s) */
  heartbeatMs?: number
  /** dispatcher tick (default 5 s); 0 disables timers (tests) */
  tickMs?: number
}

type Policy = 'open' | 'device' | 'any' | 'pair' | 'session'
const SESSION_OK: CloudRouteName[] = ['me', 'logout', 'workspace', 'workspacePatch', 'companies', 'companyPatch', 'passportProposals', 'passportDecide', 'runs', 'run', 'runLog', 'runCancel', 'asks', 'askAnswer', 'events', 'usage', 'summary']
export function routePolicy(name: CloudRouteName): Policy {
  if (name === 'health' || name === 'pairComplete' || name === 'consoleLogin' || name === 'connectorCallback' || name === 'hookIngress' || name === 'hookIngressSecret') return 'open'
  if (name === 'pairStart') return 'pair'
  if (name === 'logout') return 'session'
  return SESSION_OK.includes(name) ? 'any' : 'device'
}

interface Compiled { name: CloudRouteName; method: string; re: RegExp; keys: string[] }
const ROUTES: Compiled[] = (Object.keys(CLOUD_ROUTES) as CloudRouteName[]).map(name => {
  const [method, path] = CLOUD_ROUTES[name].split(' ') as [string, string]
  const keys: string[] = []
  const re = new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)' }) + '/?$')
  return { name, method, re, keys }
})

export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }

const PAGE_STYLE = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#f4f4f2;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:28rem;padding:2rem 1.5rem;border:1px solid rgba(255,255,255,.18);border-radius:4px;margin:1rem}h1{font-weight:500;font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;color:rgba(244,244,242,.78)}'
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
export const page = (title: string, lines: string[]): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${lines.map(l => `<p>${escapeHtml(l)}</p>`).join('')}</main></body></html>`
export const PAIR_PAGE = page('Principia Cloud', ['Open Principia on your Mac → Cloud and paste this link.', 'The code after # stays in your browser. It is never sent to this server.'])

const workspacePatch = z.object({
  paused: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  quotas: z.object({
    maxConcurrentRuns: z.number().int().min(1).max(16).optional(),
    maxRunsPerDay: z.number().int().min(1).max(10_000).optional(),
    maxRunMinutesPerDay: z.number().int().min(1).max(100_000).optional(),
    runTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
    webhookPerMinute: z.number().int().min(1).max(1000).optional(),
    monthlyApiUsdPerCompany: z.number().positive().max(1_000_000).nullable().optional()
  }).optional()
})

export interface ControlApp {
  ctx: Ctx
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  server(): Server
  start(): Promise<void>
  close(): Promise<void>
  /** a fresh pairing code as a connect link (`<publicUrl>/pair#XXXX-XXXX`) */
  connectLink(): { link: string; expiresAt: string }
  ports: ControlPorts
  queue: ReturnType<typeof createQueue>
  host: PassportHost | null
}

/** the one workspace of a self-hosted install, created on first boot */
export function ensureWorkspace(db: ControlDb, masterKey: Buffer, name: string, now: Date): { id: string; dek: string } {
  const w = db.get<{ id: string; dek: string }>('SELECT id, dek FROM workspace LIMIT 1')
  if (w) return w
  const id = newId('ws_')
  const dek = createWrappedDek(masterKey, id)
  db.run('INSERT INTO workspace (id, name, created_at, paused, quotas, dek, mode) VALUES (?, ?, ?, 0, ?, ?, ?)', id, name, iso(now), '{}', dek, 'self-host')
  return { id, dek }
}

export function createControlApp(o: ControlAppOptions): ControlApp {
  const now = o.now ?? (() => new Date())
  const config = { ...o.config, publicUrl: o.config.publicUrl.replace(/\/+$/, '') }
  const db = typeof o.db === 'object' ? o.db : openControlDb(o.db ?? join(config.dataDir, 'control.db'))
  const ws = ensureWorkspace(db, o.masterKey, config.workspaceName, now())
  const vault = openVault(o.masterKey, ws.id, ws.dek)
  for (const s of [config.adminToken, config.passport?.adminToken]) if (s) vault.remember(s)
  const redact = createRedactor(() => vault.knownSecrets())
  const log = createLogger(redact, o.logWrite, now)
  const events = new EventHub()
  const ctx: Ctx = {
    config, db, vault, log, redact, events, now, billing: o.billing ?? NOOP_BILLING, workspaceId: ws.id,
    runtime: null as unknown as CloudRuntime,
    workspace: () => workspaceOf(db, config.publicUrl),
    quotas: () => workspaceOf(db, config.publicUrl).quotas,
    audit: (actor, action, companyId, target, detail) => writeAudit(db, redact, now(), actor, action, companyId, target, detail),
    kick: () => queue.kick()
  }
  const host = config.passport ? createPassportHost(config.passport, config.fetch ?? fetch) : null
  const connections = createConnections(ctx)
  const providers = createProviders(ctx)
  const companies = createCompanies(ctx, { host, connections, cancelCompanyRuns: (cid, reason) => queue.cancelCompanyRuns(cid, reason) })
  const sync = createSync(ctx)
  const queue = createQueue(ctx, { providers, companies, connections, sync })
  ctx.runtime = o.createRuntime(queue.ports)
  const limiter = new PairLimiter(now)
  const timers: NodeJS.Timeout[] = []
  const streams = new Set<ServerResponse>()

  const send = (res: ServerResponse, status: number, body: unknown, opts: { raw?: boolean; headers?: Record<string, string> } = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { ...API_HEADERS, ...opts.headers })
    res.end(opts.raw ? text : redact(text))
  }

  async function summary(): Promise<WorkspaceSummary> {
    const [list, provs, up] = await Promise.all([companies.list(), providers.list(), host ? host.health() : Promise.resolve(false)])
    let health: ReturnType<CloudRuntime['health']>
    try { health = ctx.runtime.health() } catch (e) { health = { status: 'down', detail: (e as Error).message } }
    const u = usageSummary(db, new Date(now().getTime() - 86_400_000), now(), now())
    return {
      workspace: ctx.workspace(),
      companies: list,
      providers: provs,
      runtime: { status: health.status, version: ctx.runtime.version, sandbox: ctx.runtime.sandbox, detail: health.detail ? redact(health.detail) : null },
      passportHost: { status: up ? 'ok' : 'down', url: host?.publicUrl ?? '' },
      usage24h: { runs: u.companies.reduce((s, c) => s + c.runs, 0), runMinutes: Math.round(u.companies.reduce((s, c) => s + c.runMinutes, 0) * 10) / 10 }
    }
  }

  function sse(req: IncomingMessage, res: ServerResponse, runId: string | null): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
    res.write('retry: 5000\n\n: connected\n\n')
    const write = (e: CloudEvent) => { res.write(`event: ${e.kind}\ndata: ${redact(JSON.stringify(e))}\n\n`) }
    const off = events.add({ runId, send: write })
    const beat = setInterval(() => res.write(': heartbeat\n\n'), o.heartbeatMs ?? 20_000)
    streams.add(res)
    const done = () => { clearInterval(beat); off(); streams.delete(res) }
    req.on('close', done)
    res.on('error', done)
  }

  function serveConsole(res: ServerResponse, pathname: string): void {
    const headers = (type: string, cache: string) => ({ 'content-type': type, 'cache-control': cache, 'content-security-policy': CONSOLE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })
    let rel: string
    try { rel = decodeURIComponent(pathname.replace(/^\/console\/?/, '')) } catch { res.writeHead(404, headers('text/plain; charset=utf-8', 'no-store')); res.end('Not found.'); return }
    let root: string
    try { root = realpathSync(resolve(config.consoleDir)) } catch {
      res.writeHead(404, headers('text/plain; charset=utf-8', 'no-store')); res.end('The console is not built. Run npm run cloud:console:build.'); return
    }
    const parts = rel.split('/').filter(Boolean)
    if (parts.some(p => p.startsWith('.') || p.includes('\0'))) { res.writeHead(404, headers('text/plain; charset=utf-8', 'no-store')); res.end('Not found.'); return }
    let file = resolve(root, ...parts)
    let isFile = false
    try { file = realpathSync(file); isFile = statSync(file).isFile() } catch { isFile = false }
    if (!isFile || (file !== root && !file.startsWith(root + sep))) {
      if (extname(rel)) { res.writeHead(404, headers('text/plain; charset=utf-8', 'no-store')); res.end('Not found.'); return }
      file = join(root, 'index.html')
    }
    let body: Buffer
    try { body = readFileSync(file) } catch { res.writeHead(404, headers('text/plain; charset=utf-8', 'no-store')); res.end('Not found.'); return }
    const ext = extname(file).toLowerCase()
    res.writeHead(200, headers(MIME[ext] ?? 'application/octet-stream', ext === '.html' ? 'no-store' : 'public, max-age=3600'))
    res.end(body)
  }

  const actorOf = (p: Principal | null, fallback: Actor): Actor => p?.actor ?? fallback
  const companyParam = (params: Record<string, string>) => companies.must(params.cid!).id

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    const path = url.pathname
    // HEAD answers like GET for the static pages (Node sends no body for HEAD)
    const read = method === 'GET' || method === 'HEAD'
    if (read && (path === '/pair' || path === '/pair/')) return sendHtml(res, 200, PAIR_PAGE, PAGE_CSP)
    if (read && path === '/') { res.writeHead(302, { location: '/console/', 'cache-control': 'no-store' }); res.end(); return }
    if (read && path === '/console') { res.writeHead(302, { location: '/console/', 'cache-control': 'no-store' }); res.end(); return }
    if (method === 'HEAD' && path.startsWith('/console/')) return serveConsole(res, path)

    let match: { r: Compiled; params: Record<string, string> } | null = null
    let pathMatched = false
    for (const r of ROUTES) {
      const m = r.re.exec(path)
      if (!m) continue
      pathMatched = true
      if (r.method !== method) continue
      const params: Record<string, string> = {}
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!) }) } catch { throw notFound() }
      match = { r, params }
      break
    }
    if (!match) {
      if (method === 'GET' && path.startsWith('/console/')) return serveConsole(res, path)
      throw pathMatched ? new ApiError('not_found', 'This method is not supported here.') : notFound()
    }
    const { r, params } = match
    const name = r.name
    if (NOT_IN_V1_ROUTES.includes(name)) throw new ApiError('not_in_v1', 'This is not in Principia Cloud v1 yet.')

    // ---------- auth ----------
    const policy = routePolicy(name)
    let principal: Principal | null = null
    let actor: Actor = { kind: 'system', id: null, name: null }
    if (policy === 'pair') {
      principal = authenticate(ctx, req)
      actor = principal?.kind === 'device' ? principal.actor : checkAdmin(ctx, req)
    } else if (policy !== 'open') {
      principal = authenticate(ctx, req)
      if (!principal) throw new ApiError('unauthorized', 'Sign in again: this device or session is not valid.')
      if (policy === 'device' && principal.kind !== 'device') throw new ApiError('forbidden', 'Do this from Principia on your Mac.')
      if (policy === 'session' && principal.kind !== 'session') throw new ApiError('bad_request', 'Only console sessions sign out.')
      if (method !== 'GET') checkCsrf(principal, req)
      actor = actorOf(principal, actor)
    }
    const isSession = principal?.kind === 'session'
    const body = async () => readJson(req, name === 'companyPut' ? CLOUD_LIMITS.bundleBodyBytes : CLOUD_LIMITS.jsonBodyBytes)
    const ok = (v: unknown, status = 200) => send(res, status, v)
    const q = url.searchParams

    switch (name) {
      case 'health': return ok({ ok: true, api: CLOUD_API_VERSION, workspaceId: ctx.workspaceId })
      case 'pairStart': {
        const out = mintPairingCode(ctx)
        ctx.audit(actor, 'pair.start', null, null, {})
        return send(res, 201, { ...out, link: formatConnectLink(config.publicUrl, out.code) }, { raw: true })
      }
      case 'pairComplete': return send(res, 201, completePairing(ctx, limiter, clientIp(req), (await body()) as Record<string, unknown>), { raw: true })
      case 'me': {
        const me: MeResponse = principal!.kind === 'device'
          ? { workspace: ctx.workspace(), device: principal!.device, session: null, csrf: null }
          : { workspace: ctx.workspace(), device: null, session: { id: principal!.session.id, expiresAt: principal!.session.expiresAt }, csrf: principal!.session.csrf }
        return send(res, 200, me, { raw: true })
      }
      case 'loginLink': {
        const out = createLoginLink(ctx, principal!.kind === 'device' ? principal!.device.id : '')
        ctx.audit(actor, 'login_link.create', null, null, {})
        return send(res, 201, out, { raw: true })
      }
      case 'consoleLogin': {
        const s = consumeLoginLink(ctx, q.get('t') ?? '')
        if (!s) return sendHtml(res, 400, page('This link has expired', ['Sign-in links work once, for 10 minutes.', 'On your Mac, open Cloud → Workspace → Open on your phone for a new one.']), PAGE_CSP)
        res.writeHead(302, { location: '/console/', 'set-cookie': sessionCookie(ctx, s.token, Math.floor(SESSION_TTL_MS / 1000)), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(); return
      }
      case 'logout': {
        db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now().toISOString(), principal!.kind === 'session' ? principal!.session.id : '')
        ctx.audit(actor, 'session.logout', null, null, {})
        return send(res, 200, { ok: true }, { headers: { 'set-cookie': sessionCookie(ctx, '', 0) } })
      }
      case 'devices': return ok(listDevices(ctx, principal!.kind === 'device' ? principal!.device.id : null))
      case 'deviceRevoke': {
        if (!revokeDevice(ctx, params.id!)) throw notFound('No such device.')
        ctx.audit(actor, 'device.revoke', null, params.id!, {})
        return ok({ ok: true })
      }
      case 'workspace': return ok(ctx.workspace())
      case 'workspacePatch': {
        const p = workspacePatch.safeParse(await body())
        if (!p.success) throw badRequest(`Invalid workspace patch: ${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim())
        if (isSession && (p.data.name !== undefined || p.data.quotas !== undefined)) throw new ApiError('forbidden', 'Change quotas from your Mac.')
        if (p.data.name) { db.run('UPDATE workspace SET name = ? WHERE id = ?', p.data.name, ctx.workspaceId); ctx.audit(actor, 'workspace.rename', null, ctx.workspaceId, { name: p.data.name }) }
        if (p.data.quotas) {
          const next = { ...ctx.quotas(), ...p.data.quotas }
          db.run('UPDATE workspace SET quotas = ? WHERE id = ?', JSON.stringify(next), ctx.workspaceId)
          ctx.audit(actor, 'workspace.quotas', null, ctx.workspaceId, Object.fromEntries(Object.entries(p.data.quotas).map(([k, v]) => [k, v ?? null])))
          queue.kick()
        }
        if (p.data.paused !== undefined && p.data.paused !== ctx.workspace().paused) await queue.setPaused(actor, p.data.paused)
        else if (p.data.name || p.data.quotas) events.emit({ kind: 'workspace', workspace: ctx.workspace() })
        return ok(ctx.workspace())
      }
      case 'companies': return ok(await companies.list())
      case 'companyPut': {
        const out = await companies.put(actor, params.cid!, await body(), q.get('rotateDesktopGrant') === '1')
        // the desktop passport key is shown once and must not be redacted
        const text = redact(JSON.stringify({ ...out, desktopPassportGrant: null }))
        const company = JSON.parse(text).company
        return send(res, 200, { company, desktopPassportGrant: out.desktopPassportGrant }, { raw: true })
      }
      case 'companyPatch': return ok(await companies.patch(actor, params.cid!, await body(), isSession))
      case 'companyDelete': { await companies.remove(actor, params.cid!); return ok({ ok: true }) }
      case 'passportProposals': return ok(await companies.proposals(params.cid!))
      case 'passportDecide': return ok(await companies.decide(actor, params.cid!, params.pid!, params.decision!))
      case 'providers': return ok(await providers.list())
      case 'providerPut': return ok(providers.put(actor, params.adapter!, (await body()) as Record<string, unknown>))
      case 'providerDelete': { providers.remove(actor, params.adapter!); return ok({ ok: true }) }
      case 'providerTest': { const b = (await body()) as { live?: unknown }; return ok(await providers.test(actor, params.adapter!, b?.live === true)) }
      case 'secrets': return ok(companies.secrets(params.cid!))
      case 'secretPut': return ok(companies.putSecret(actor, params.cid!, params.name!, (await body()) as { value?: unknown }))
      case 'secretDelete': { companies.removeSecret(actor, params.cid!, params.name!); return ok({ ok: true }) }
      case 'repos': return ok(companies.repos(params.cid!))
      case 'repoPut': return ok(companies.putRepo(actor, params.cid!, params.rid!, await body()))
      case 'repoSync': return ok(await companies.syncRepo(actor, params.cid!, params.rid!))
      case 'repoDelete': { companies.removeRepo(actor, params.cid!, params.rid!); return ok({ ok: true }) }
      case 'connections': { const c = companies.must(params.cid!); const link = (await companies.get(c.id)).passport; return ok(connections.list(c.id, link?.mcpUrl ?? null)) }
      case 'connectionPut': return ok(await connections.put(actor, companyParam(params), params.id!, await body()))
      case 'connectionDelete': { connections.remove(actor, companyParam(params), params.id!); return ok({ ok: true }) }
      case 'connectionAuthorize': return ok(await connections.authorize(actor, companyParam(params), params.id!))
      case 'connectorCallback': {
        const out = await connections.callback(q)
        return sendHtml(res, out.status, page(out.status === 200 ? 'Connected' : 'Sign-in did not finish', [out.text]), PAGE_CSP)
      }
      case 'workflows': return ok(sync.workflows(companyParam(params)))
      case 'workflowPut': return ok(sync.putWorkflow(actor, companyParam(params), params.wid!, await body()))
      case 'workflowDelete': { sync.removeWorkflow(actor, companyParam(params), params.wid!); return ok({ ok: true }) }
      case 'schedules': return ok(sync.schedules(companyParam(params)))
      case 'schedulePut': return ok(sync.putSchedule(actor, companyParam(params), params.sid!, await body()))
      case 'scheduleDelete': { sync.removeSchedule(actor, companyParam(params), params.sid!); return ok({ ok: true }) }
      case 'syncChanges': return ok(await queue.changes(decodeCursor(q.get('since'))))
      case 'runStart': {
        const trigger: CloudRunTrigger = isSession ? 'console' : 'desktop'
        return ok(await queue.startFromApi(actor, params.cid!, await body(), trigger), 202)
      }
      case 'runs': {
        const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50))
        return ok(queue.list({ companyId: q.get('companyId'), status: q.get('status'), limit }))
      }
      case 'run': return ok(queue.detail(params.id!))
      case 'runLog': return ok(queue.log(params.id!, q.get('step'), Number(q.get('tail') ?? 200) || 200))
      case 'runCancel': return ok(await queue.cancel(actor, params.id!))
      case 'asks': return ok(queue.asks(q.get('status') ?? 'open', q.get('companyId')))
      case 'askAnswer': return ok(await queue.answer(actor, params.id!, await body()))
      case 'events': return sse(req, res, q.get('runId'))
      case 'usage': {
        const to = q.get('to') ? new Date(q.get('to')!) : now()
        const from = q.get('from') ? new Date(q.get('from')!) : new Date(to.getTime() - 30 * 86_400_000)
        if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw badRequest('from and to must be ISO dates, from before to.')
        return ok(usageSummary(db, from, to, now()))
      }
      case 'audit': return ok(auditEntries(db, { companyId: q.get('companyId'), limit: Math.min(500, Math.max(1, Number(q.get('limit') ?? 100) || 100)) }))
      case 'summary': return ok(await summary())
      default: throw notFound()
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://control.local') } catch { url = new URL('http://control.local/') }
    try {
      if (config.passportProxy && config.passport && isPassportPath(url.pathname)) return void (await proxyToPassport(req, res, config.passportProxy, config.passport.publicUrl))
      await route(req, res, url)
    } catch (e) {
      const err = e instanceof ApiError ? e : null
      if (!err) log.error('request failed', { method: req.method, path: url.pathname, error: (e as Error).stack ?? String(e) })
      if (!res.headersSent) send(res, err?.status ?? 500, err ? err.body() : { error: 'internal', message: 'Something went wrong in the cloud. Check its logs.' })
      else res.end()
    } finally {
      if (url.pathname !== '/v1/health' && url.pathname !== '/v1/events') res.once('finish', () => log.info('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }))
    }
  }

  function connectLink() {
    const out = mintPairingCode(ctx)
    return { link: formatConnectLink(config.publicUrl, out.code), expiresAt: out.expiresAt }
  }

  let httpServer: Server | null = null
  return {
    ctx, handle, connectLink, ports: queue.ports, queue, host,
    server() {
      if (!httpServer) {
        httpServer = createServer((req, res) => void handle(req, res))
        httpServer.headersTimeout = 15_000
        httpServer.requestTimeout = 120_000
      }
      return httpServer
    },
    async start() {
      companies.primeSecrets()
      connections.primeSecrets()
      for (const r of db.all<{ id: string; ciphertext: string }>('SELECT id, ciphertext FROM credentials')) { try { vault.decrypt('provider', r.id, r.ciphertext) } catch { log.warn('a stored credential could not be decrypted', { credentialId: r.id }) } }
      queue.recover()
      await ctx.runtime.start()
      for (const c of db.all<{ id: string; name: string; slug: string }>('SELECT id, name, slug FROM companies')) {
        try { await ctx.runtime.ensureCompany({ workspaceId: ctx.workspaceId, companyId: c.id, name: c.name, slug: c.slug }) } catch (e) { log.warn('runtime.ensureCompany failed at boot', { companyId: c.id, error: (e as Error).message }) }
      }
      ctx.runtime.triggers.reloadSchedules()
      if (!anyDevicePaired(ctx)) {
        const l = connectLink()
        log.plain(`Connect link: ${l.link} (10 min)`)
        if (config.connectHint) log.plain(config.connectHint)
      }
      const tick = o.tickMs ?? 5_000
      if (tick > 0) {
        timers.push(setInterval(() => queue.kick(), tick))
        timers.push(setInterval(() => {
          const cutoff = new Date(now().getTime() - config.logRetentionDays * 86_400_000).toISOString()
          db.run('DELETE FROM run_steps WHERE run_id IN (SELECT id FROM cloud_runs WHERE ended_at IS NOT NULL AND ended_at < ?)', cutoff)
          db.run('DELETE FROM run_logs WHERE run_id IN (SELECT id FROM cloud_runs WHERE ended_at IS NOT NULL AND ended_at < ?)', cutoff)
          db.run('DELETE FROM pairing_codes WHERE expires_at < ?', cutoff)
          db.run('DELETE FROM login_links WHERE expires_at < ?', cutoff)
          db.run('DELETE FROM oauth_state WHERE expires_at < ?', cutoff)
        }, 3_600_000))
        for (const t of timers) t.unref()
      }
      queue.kick()
    },
    async close() {
      queue.stop()
      for (const t of timers) clearInterval(t)
      for (const s of streams) s.end()
      if (httpServer) await new Promise<void>(r => { httpServer!.close(() => r()); httpServer!.closeAllConnections() })
      try { await ctx.runtime.close() } catch (e) { log.warn('runtime.close failed', { error: (e as Error).message }) }
      db.close()
    }
  }
}

