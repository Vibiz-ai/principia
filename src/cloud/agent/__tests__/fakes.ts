/** Test doubles for the agent runtime: a ControlPorts recorder, a fake Open Passport host, temp folders, fake CLIs. */
import { mkdtempSync, realpathSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlPorts, ScheduleRow } from '../../contract'

export const BIN = join(__dirname, 'bin')
export const FAKE_BINS = { claude: join(BIN, 'claude'), codex: join(BIN, 'codex'), gemini: join(BIN, 'gemini') }

export const tmp = (prefix = 'principia-agent-'): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

export interface PortsRecord {
  runStatus: { runId: string; status: string; summary: string | null }[]
  runStep: { runId: string; step: Parameters<ControlPorts['runStep']>[1] }[]
  runLog: { runId: string; stepId: string; lines: string[] }[]
  usage: Parameters<ControlPorts['usage']>[0][]
  asks: (Parameters<ControlPorts['openAsk']>[0] & { id: string })[]
  requests: Parameters<ControlPorts['requestRun']>[0][]
  fired: { scheduleId: string; slot: string; runId: string | null }[]
  saved: Parameters<ControlPorts['saveProviderCredential']>[0][]
  /** ports.providerStatus: what real runs learned about their accounts */
  accounts: Parameters<NonNullable<ControlPorts['providerStatus']>>[0][]
  forum: { companyId: string; channelId: string; messageId: string }[]
  audit: { action: string; companyId: string | null; detail: Record<string, unknown> }[]
  logs: { level: string; msg: string; meta?: Record<string, unknown> }[]
}

export function fakePorts(o: { schedules?: () => ScheduleRow[]; secrets?: string[]; refuse?: string | null } = {}): ControlPorts & { rec: PortsRecord; finalStatus(runId: string): string | undefined } {
  const rec: PortsRecord = { runStatus: [], runStep: [], runLog: [], usage: [], asks: [], requests: [], fired: [], saved: [], accounts: [], forum: [], audit: [], logs: [] }
  let n = 0
  return {
    rec,
    finalStatus: (runId) => [...rec.runStatus].reverse().find((s) => s.runId === runId)?.status,
    runStatus: (runId, status, summary) => void rec.runStatus.push({ runId, status, summary }),
    runStep: (runId, step) => void rec.runStep.push({ runId, step }),
    runLog: (runId, stepId, lines) => void rec.runLog.push({ runId, stepId, lines }),
    usage: (e) => void rec.usage.push(e),
    openAsk: (a) => {
      const id = `cask_${++n}`
      rec.asks.push({ ...a, id })
      return id
    },
    requestRun: (r) => {
      rec.requests.push(r)
      return o.refuse ? { runId: null, refused: o.refuse } : { runId: `crun_req${++n}`, refused: null }
    },
    cloudSchedules: () => o.schedules?.() ?? [],
    markScheduleFired: (scheduleId, slot, runId) => void rec.fired.push({ scheduleId, slot, runId }),
    saveProviderCredential: (c) => void rec.saved.push(c),
    providerStatus: (c) => void rec.accounts.push(c),
    forumEvent: (companyId, channelId, messageId) => void rec.forum.push({ companyId, channelId, messageId }),
    audit: (action, companyId, detail) => void rec.audit.push({ action, companyId, detail }),
    knownSecrets: () => o.secrets ?? [],
    log: {
      info: (msg, meta) => void rec.logs.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => void rec.logs.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => void rec.logs.push({ level: 'error', msg, meta })
    }
  }
}

export interface FakeHost {
  url: string
  token: string
  requests: { method: string; path: string; auth: string | undefined; body: string }[]
  notes: unknown[]
  revision: number
  card: string
  /** ms to wait before answering (timeouts) */
  delayMs: number
  close(): Promise<void>
}

/** A fake Open Passport host: the card (json + markdown), POST /notes, and a minimal remote MCP endpoint. */
export async function fakePassportHost(token = 'opk_test_runtime_grant_0123456789abcdef'): Promise<FakeHost> {
  const host: FakeHost = { url: '', token, requests: [], notes: [], revision: 3, card: '<company-passport>\nAcme sells invoicing to bakeries.\n</company-passport>', delayMs: 0, close: async () => {} }
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url ?? '/', 'http://x')
    host.requests.push({ method: req.method ?? '', path: url.pathname + url.search, auth: req.headers.authorization, body })
    if (host.delayMs) await new Promise((r) => setTimeout(r, host.delayMs))
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
    const m = /^\/v1\/passports\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!m) return void res.writeHead(404).end()
    const rest = m[2] ?? ''
    if (!rest && req.method === 'GET') {
      if (url.searchParams.get('format') === 'json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: m[1], name: 'Acme', revision: host.revision, l0: host.card }))
      const dep = url.searchParams.get('department')
      return void res.writeHead(200, { 'content-type': 'text/markdown' }).end(dep ? `${host.card}\n## ${dep}\n` : host.card)
    }
    if (rest === '/notes' && req.method === 'POST') {
      host.notes.push(JSON.parse(body))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"proposed","proposal":"prop_1"}')
    }
    if (rest === '/mcp' && req.method === 'POST') {
      const msg = JSON.parse(body) as { id?: number; method: string }
      if (msg.id === undefined) return void res.writeHead(202).end()
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'open-passport', version: '0.1.0' } } : { tools: [{ name: 'passport_search', inputSchema: { type: 'object' } }] }
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  host.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  host.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return host
}

export const waitFor = async (cond: () => boolean, ms = 10_000, step = 25): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, step))
  }
}
