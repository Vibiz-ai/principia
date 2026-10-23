/**
 * A fake Principia Cloud control plane for FE tests (docs/CLOUD.md §15: "FE tests use a fake HTTP server that follows
 * src/shared/cloud.ts"). Real HTTP on 127.0.0.1, records every request, and implements just enough state: pairing,
 * devices, sync changes, SSE events, companies with a passport grant, workflows and schedules with revs (409 on a
 * stale baseRev), repos, secrets, connections, providers and runs. Also used by the visual QA script.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  CloudAsk,
  CloudCompany,
  CloudEvent,
  CloudRunSummary,
  CloudSchedule,
  CloudWorkflow,
  PairCompleteResponse,
  ProviderAccount,
  ProviderCredentialKind,
  SyncChanges,
  WorkspaceSummary
} from '../../../shared/cloud'
import { DEFAULT_QUOTAS } from '../../../shared/cloud'

export interface Recorded {
  method: string
  path: string
  query: Record<string, string>
  headers: http.IncomingHttpHeaders
  body: unknown
  raw: string
}

export const DEVICE_TOKEN = 'pdt_fake_device_token_0123456789abcdef'
export const PAIR_CODE = 'K7QM-4XWD'

export interface FakeCloud {
  url: string
  requests: Recorded[]
  /** what GET /v1/sync/changes answers next (each call shifts one; the last one repeats) */
  changes: Partial<SyncChanges>[]
  workflows: Map<string, CloudWorkflow & { file: unknown }>
  schedules: Map<string, CloudSchedule>
  companies: Map<string, CloudCompany>
  secrets: Map<string, string>
  connections: Map<string, unknown>
  repos: Map<string, unknown>
  providers: ProviderAccount[]
  runs: CloudRunSummary[]
  asks: CloudAsk[]
  /** pushes one SSE event to every open /v1/events stream */
  push(e: CloudEvent): void
  /** open SSE streams */
  streams(): number
  /** ends every open SSE stream (the client should reconnect) */
  dropStreams(): void
  /** make every device call answer 401 (a revoked device) */
  revoke(): void
  close(): Promise<void>
}

const WORKSPACE = { id: 'ws_test', name: 'lautaro-cloud', createdAt: '2026-10-21T00:00:00Z', paused: false, quotas: DEFAULT_QUOTAS, publicUrl: '', mode: 'self-host' as const }

export async function startFakeCloud(opts: { passportHost?: string } = {}): Promise<FakeCloud> {
  const requests: Recorded[] = []
  const sse = new Set<http.ServerResponse>()
  const workflows = new Map<string, CloudWorkflow & { file: unknown }>()
  const schedules = new Map<string, CloudSchedule>()
  const companies = new Map<string, CloudCompany>()
  const secrets = new Map<string, string>()
  const connections = new Map<string, unknown>()
  const repos = new Map<string, unknown>()
  let revoked = false
  let paired = false
  const state = {
    changes: [] as Partial<SyncChanges>[],
    providers: [
      { adapter: 'claude', credential: null, status: 'missing', detail: null, cliVersion: '2.1.290' },
      { adapter: 'codex', credential: null, status: 'missing', detail: null, cliVersion: '0.130.0' },
      { adapter: 'gemini', credential: null, status: 'missing', detail: null, cliVersion: '0.20.0' }
    ] as ProviderAccount[],
    runs: [] as CloudRunSummary[],
    asks: [] as CloudAsk[]
  }
  const now = () => new Date().toISOString()

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const rec: Recorded = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body, raw }
      requests.push(rec)
      const json = (status: number, data: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): void => json(status, { error, message, ...extra })
      const m = rec.method
      const p = rec.path
      const seg = p.split('/').filter(Boolean)

      if (m === 'POST' && p === '/v1/pair/complete') {
        const b = body as { code?: string; deviceName?: string; platform?: string }
        if (b?.code !== PAIR_CODE) return fail(400, 'bad_request', 'That code is wrong or expired.')
        paired = true
        const out: PairCompleteResponse = {
          deviceToken: DEVICE_TOKEN,
          device: { id: 'dev_mac', name: b.deviceName ?? 'Mac', platform: b.platform ?? 'darwin-arm64', createdAt: now(), lastSeenAt: now(), current: true },
          workspace: { ...WORKSPACE, publicUrl: url }
        }
        return json(200, out)
      }
      if (p === '/v1/health') return json(200, { ok: true })
      // everything else needs the device token
      if (revoked || !paired || req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) return fail(401, 'unauthorized', 'Unknown device')

      if (m === 'GET' && p === '/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(': hello\n\n')
        sse.add(res)
        res.on('close', () => sse.delete(res))
        return
      }
      if (m === 'GET' && p === '/v1/sync/changes') {
        const next = state.changes.length > 1 ? state.changes.shift()! : (state.changes[0] ?? {})
        const out: SyncChanges = { cursor: next.cursor ?? `c${requests.length}`, runs: next.runs ?? [], asks: next.asks ?? [], passports: next.passports ?? [], schedules: next.schedules ?? [], ...(next.more ? { more: true } : {}) }
        return json(200, out)
      }
      if (m === 'GET' && p === '/v1/devices') return json(200, [{ id: 'dev_mac', name: 'Mac', platform: 'darwin-arm64', createdAt: now(), lastSeenAt: now(), current: true }, { id: 'dev_phone', name: 'Phone', platform: 'web', createdAt: now(), lastSeenAt: null }])
      if (m === 'DELETE' && seg[1] === 'devices') return json(200, { ok: true })
      if (m === 'GET' && p === '/v1/summary') {
        const out: WorkspaceSummary = {
          workspace: { ...WORKSPACE, publicUrl: url },
          companies: [...companies.values()],
          providers: state.providers,
          runtime: { status: 'ok', version: '1.0.0', sandbox: 'process', detail: null },
          passportHost: { status: 'ok', url: opts.passportHost ?? 'http://127.0.0.1:8788' },
          usage24h: { runs: state.runs.length, runMinutes: 12 }
        }
        return json(200, out)
      }
      if (m === 'GET' && p === '/v1/providers') return json(200, state.providers)
      if (seg[1] === 'providers' && seg[3] === 'credential') {
        const a = state.providers.find((x) => x.adapter === seg[2])
        if (!a) return fail(404, 'not_found', 'No such adapter')
        if (m === 'PUT') {
          const b = body as { kind: ProviderCredentialKind }
          a.credential = { id: `cred_${seg[2]}`, kind: b.kind, label: 'linked', createdAt: now(), lastUsedAt: null, expiresAt: b.kind === 'claude_oauth_token' ? '2027-10-21T00:00:00Z' : null }
          a.status = 'ok'
          return json(200, a)
        }
        if (m === 'DELETE') {
          a.credential = null
          a.status = 'missing'
          return json(200, a)
        }
      }
      if (m === 'POST' && seg[1] === 'providers' && seg[3] === 'test') return json(200, { ok: true, detail: `${seg[2]} 1.0 · accepted` })

      if (m === 'GET' && p === '/v1/companies') return json(200, [...companies.values()])
      if (seg[1] === 'companies' && seg.length === 3) {
        const cid = decodeURIComponent(seg[2])
        if (m === 'PUT') {
          const b = body as { name: string; slug: string; color?: string | null; passportBundle?: string }
          const first = !companies.has(cid)
          if (first && !b.passportBundle) return fail(400, 'bad_request', 'passportBundle is required on create')
          const c: CloudCompany = {
            id: cid,
            name: b.name,
            slug: b.slug,
            color: b.color ?? null,
            createdAt: now(),
            paused: false,
            passport: { hostUrl: opts.passportHost ?? 'http://127.0.0.1:8788', passportId: `pp_${cid}`, mcpUrl: `${opts.passportHost ?? 'http://127.0.0.1:8788'}/v1/passports/pp_${cid}/mcp`, revision: 1, pendingProposals: 0 },
            counts: { workflows: 0, schedules: 0, repos: 0, connections: 0, openAsks: 0, running: 0 },
            readiness: { ready: true, fixes: [] }
          }
          companies.set(cid, c)
          return json(200, { company: c, desktopPassportGrant: first ? { url: c.passport!.hostUrl, passportId: c.passport!.passportId, token: 'opk_desktop_grant_secret' } : null })
        }
        if (m === 'DELETE') {
          companies.delete(cid)
          return json(200, { ok: true })
        }
        if (m === 'PATCH') {
          const c = companies.get(cid)
          if (!c) return fail(404, 'not_found', 'No such company')
          c.paused = !!(body as { paused?: boolean }).paused
          return json(200, c)
        }
      }
      if (seg[1] === 'companies' && seg[3] === 'workflows') {
        const cid = decodeURIComponent(seg[2])
        if (m === 'GET') return json(200, [...workflows.values()].filter((w) => w.companyId === cid).map(({ file: _f, ...w }) => w))
        if (m === 'PUT') {
          const wid = decodeURIComponent(seg[4])
          const b = body as { file: { workflow: { name: string } }; baseRev: number | null }
          const cur = workflows.get(wid)
          if (cur && b.baseRev !== cur.rev) return fail(409, 'conflict', 'Stale baseRev', { rev: cur.rev })
          if (!cur && b.baseRev !== null) return fail(409, 'conflict', 'No such workflow to update', { rev: 0 })
          const w = { id: wid, companyId: cid, name: b.file.workflow.name, rev: (cur?.rev ?? 0) + 1, updatedAt: now(), problems: [], file: b.file }
          workflows.set(wid, w)
          const { file: _f, ...out } = w
          return json(200, out)
        }
      }
      if (seg[1] === 'companies' && seg[3] === 'schedules' && m === 'PUT') {
        const cid = decodeURIComponent(seg[2])
        const sid = decodeURIComponent(seg[4])
        const b = body as { schedule: CloudSchedule; placement: 'local' | 'cloud'; baseRev: number | null }
        const cur = schedules.get(sid)
        if (cur && b.baseRev !== cur.rev) return fail(409, 'conflict', 'Stale baseRev', { rev: cur.rev })
        const s: CloudSchedule = { ...b.schedule, id: sid, companyId: cid, placement: b.placement, rev: (cur?.rev ?? 0) + 1, nextFireAt: null, lastFireAt: null, lastRunId: null }
        schedules.set(sid, s)
        return json(200, s)
      }
      if (seg[1] === 'companies' && seg[3] === 'repos') {
        if (m === 'PUT') {
          repos.set(decodeURIComponent(seg[4]), body)
          return json(200, { id: seg[4], status: 'pending' })
        }
        if (m === 'POST' && seg[5] === 'sync') return json(200, { ok: true })
      }
      if (seg[1] === 'companies' && seg[3] === 'secrets' && m === 'PUT') {
        secrets.set(decodeURIComponent(seg[4]), (body as { value: string }).value)
        return json(200, { name: seg[4] })
      }
      if (seg[1] === 'companies' && seg[3] === 'connections') {
        if (m === 'PUT') {
          connections.set(decodeURIComponent(seg[4]), body)
          return json(200, { id: seg[4] })
        }
        if (m === 'POST' && seg[5] === 'authorize') return json(200, { authorizeUrl: 'https://auth.example.com/authorize?state=x' })
      }
      if (seg[1] === 'companies' && seg[3] === 'runs' && m === 'POST') {
        const r: CloudRunSummary = { id: `crun_${state.runs.length + 1}`, companyId: decodeURIComponent(seg[2]), kind: 'workflow', title: 'Morning brief', status: 'queued', trigger: 'desktop', adapters: ['codex'], createdAt: now(), startedAt: null, endedAt: null, summary: null }
        state.runs.unshift(r)
        return json(200, r)
      }
      if (seg[1] === 'companies' && seg[3] === 'passport' && seg[4] === 'proposals') {
        if (m === 'GET') return json(200, [{ id: 'prop_1', kind: 'delta', app: 'cloud-runtime', created: now(), summary: '3 facts for Marketing' }])
        return json(200, { ok: true })
      }
      if (m === 'GET' && p === '/v1/runs') return json(200, state.runs)
      if (m === 'GET' && seg[1] === 'runs' && seg.length === 3) {
        const r = state.runs.find((x) => x.id === seg[2])
        if (!r) return fail(404, 'not_found', 'No such run')
        return json(200, { ...r, steps: [], artifacts: [], forumPosts: [] })
      }
      if (m === 'GET' && seg[1] === 'runs' && seg[3] === 'log') return json(200, { lines: ['› step one', '  ••••FAL_KEY redacted'] })
      if (m === 'POST' && seg[1] === 'runs' && seg[3] === 'cancel') return json(200, { ok: true })
      if (m === 'GET' && p === '/v1/asks') return json(200, state.asks)
      if (m === 'POST' && seg[1] === 'asks' && seg[3] === 'answer') {
        const a = state.asks.find((x) => x.id === seg[2])
        if (!a) return fail(404, 'not_found', 'No such ask')
        a.status = 'answered'
        a.answer = (body as { answer: string }).answer
        return json(200, a)
      }
      if (m === 'POST' && p === '/v1/login-links') return json(200, { url: `${url}/console/login?t=pll_onetime`, expiresAt: now() })
      if (m === 'PATCH' && p === '/v1/workspace') return json(200, { ...WORKSPACE, paused: !!(body as { paused?: boolean }).paused })
      return fail(404, 'not_found', `No route ${m} ${p}`)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    get changes() {
      return state.changes
    },
    set changes(v) {
      state.changes = v
    },
    workflows,
    schedules,
    companies,
    secrets,
    connections,
    repos,
    get providers() {
      return state.providers
    },
    set providers(v) {
      state.providers = v
    },
    get runs() {
      return state.runs
    },
    set runs(v) {
      state.runs = v
    },
    get asks() {
      return state.asks
    },
    set asks(v) {
      state.asks = v
    },
    push(e: CloudEvent) {
      for (const res of sse) res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`)
    },
    streams: () => sse.size,
    dropStreams() {
      for (const res of sse) res.end()
    },
    revoke() {
      revoked = true
    },
    close: () =>
      new Promise<void>((r) => {
        for (const res of sse) res.end()
        server.closeAllConnections?.()
        server.close(() => r())
      })
  } as FakeCloud
}

/** A stand-in for safeStorage: reversible, but never the plaintext on disk. */
export const fakeCipher = (available = true) => ({
  available: () => available,
  encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decrypt: (b: Buffer) => Buffer.from(b.toString().replace(/^enc:/, ''), 'hex').toString()
})

export const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 15))
  }
}
