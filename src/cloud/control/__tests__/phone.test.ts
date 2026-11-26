import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { PhoneChats, PhoneMe, PhoneNeeds, PhoneServerMsg, PhoneSession } from '../../../shared/remote'
import { fakeClaudeChats, type FakeClaude } from './fakeClaude'
import { startHarness, type Harness } from './harness'

const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(80)
const GH = 'ghp_' + 'g'.repeat(36)

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const until = async (f: () => boolean | Promise<boolean>, what = 'condition') => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const githubFetch: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url.startsWith('https://api.github.com/user/repos')) {
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${GH}`)
    return new Response(JSON.stringify([{ full_name: 'acme/app' }, { full_name: 'acme/old', archived: true }, { full_name: 'acme/site' }]), { status: 200 })
  }
  return fetch(input, init)
}

async function setup(o: { claude?: boolean; dir?: string; chats?: FakeClaude } = {}): Promise<{ h: Harness; mac: string; phone: string; chats: FakeClaude }> {
  const chats = o.chats ?? fakeClaudeChats()
  const harness = await startHarness({ chats, config: { fetch: githubFetch }, ...(o.dir ? { dir: o.dir } : {}) })
  h = harness
  const mac = await harness.pair()
  if (o.claude !== false) expect((await harness.call('PUT', '/v1/providers/claude/credential', { token: mac, body: { kind: 'claude_oauth_token', value: TOKEN } })).status).toBe(200)
  await harness.call('PUT', '/v1/accounts/github', { token: mac, body: { token: GH, login: 'lau' } })
  const link = await harness.call('POST', '/v1/phone-link', { token: mac })
  expect(link.status).toBe(201)
  const code = /#mac=[^&]+&code=([0-9a-f]{32})$/.exec(link.json.link)![1]
  const pair = await harness.call('POST', '/api/pair', { body: { code, name: 'iPhone' } })
  expect(pair.status).toBe(200)
  return { h: harness, mac, phone: pair.json.token as string, chats }
}

describe('the phone, straight to the cloud (docs/CLOUD-PHONE.md)', () => {
  it('pairs once with a one-time link from the Mac, then answers as the cloud', async () => {
    const s = await setup()
    const link = await s.h.call('POST', '/v1/phone-link', { token: s.mac })
    // the link opens this cloud's own phone app, and names this cloud as the address to talk to
    expect(link.json.link.startsWith(`${s.h.url}/#mac=${encodeURIComponent(s.h.url)}&code=`)).toBe(true)
    const code = link.json.link.split('code=')[1]
    expect((await s.h.call('POST', '/api/pair', { body: { code, name: 'iPad' } })).status).toBe(200)
    // once only
    expect((await s.h.call('POST', '/api/pair', { body: { code, name: 'iPad' } })).status).toBe(401)
    expect((await s.h.call('POST', '/api/pair', { body: { code: 'f'.repeat(32), name: 'x' } })).status).toBe(401)
    expect((await s.h.call('GET', '/api/me')).status).toBe(401)
    const me = (await s.h.call('GET', '/api/me', { token: s.phone })).json as PhoneMe
    expect(me).toMatchObject({ host: 'cloud', device: { name: 'iPhone' }, companies: [{ id: 'cloud', name: 'Your cloud' }] })
    // the phone is a device like the Mac: it shows on the cloud's device list
    expect((await s.h.call('GET', '/v1/devices', { token: s.mac })).json.map((d: { platform: string }) => d.platform)).toContain('phone')
    // the console's routes stay the Mac's: a phone's token reaches /api only
    expect((await s.h.call('POST', '/v1/phone-link', { token: null })).status).toBe(401)
    expect((await s.h.call('POST', '/v1/phone-link', { token: s.phone })).status).toBe(403)
    expect((await s.h.call('GET', '/v1/devices', { token: s.phone })).status).toBe(403)
    // revoked on the Mac: its live socket ends, its token stops working
    const ws = new WebSocket(`${s.h.url.replace('http', 'ws')}/api/live`)
    const got: PhoneServerMsg[] = []
    ws.on('message', (m) => got.push(JSON.parse(String(m)) as PhoneServerMsg))
    const closed = new Promise<number>((ok) => ws.once('close', (c) => ok(c)))
    ws.once('open', () => ws.send(JSON.stringify({ t: 'auth', token: s.phone })))
    await until(() => got.some((m) => m.t === 'hello'), 'hello')
    const phoneId = ((await s.h.call('GET', '/v1/devices', { token: s.mac })).json as { id: string; platform: string }[]).find((d) => d.platform === 'phone' && d.id === me.device.id)!.id
    expect((await s.h.call('DELETE', `/v1/devices/${phoneId}`, { token: s.mac })).status).toBe(200)
    expect(await closed).toBe(4401)
    expect(got.some((m) => m.t === 'bye')).toBe(true)
    expect((await s.h.call('GET', '/api/me', { token: s.phone })).status).toBe(401)
  })

  it('starts a chat in a clone of a GitHub repository, asks before acting, and finishes the turn', async () => {
    const s = await setup()
    const list = (await s.h.call('GET', '/api/c/cloud/chats', { token: s.phone })).json as PhoneChats
    expect(list).toMatchObject({ host: 'cloud', rows: [], repos: ['acme/app', 'acme/site'] })
    const r = await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'list the files and write hello.txt', repo: 'acme/app' } })
    expect(r.status).toBe(200)
    const id = r.json.sessionId as string
    await until(() => s.chats.said.get(id)?.length === 1, 'the first message')
    const spec = s.chats.specs[0]!
    expect(spec).toMatchObject({ id, conversationId: id, resume: false, permissionMode: 'auto', repo: { url: 'https://github.com/acme/app', token: GH }, githubToken: GH })
    expect(spec.provider?.value).toBe(TOKEN)
    expect(spec.systemPrompt).toContain('cloud machine')
    expect(s.chats.said.get(id)).toEqual(['list the files and write hello.txt'])
    // Claude asks to run Bash: it shows in Needs you and in the chat
    await until(async () => ((await s.h!.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds).count === 1, 'the permission ask')
    const needs = (await s.h.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds
    expect(needs.asks[0]).toMatchObject({ heading: 'Bash?', open: { kind: 'session', id }, options: [{ id: 'allow' }, { id: 'deny' }] })
    const now = (await s.h.call('GET', '/api/c/cloud/now', { token: s.phone })).json
    expect(now.working).toHaveLength(1)
    expect((await s.h.call('POST', `/api/c/cloud/asks/${encodeURIComponent(needs.asks[0]!.id)}/answer`, { token: s.phone, body: { optionId: 'allow' } })).status).toBe(200)
    await until(async () => ((await s.h!.call('GET', `/api/c/cloud/sessions/${id}`, { token: s.phone })).json as PhoneSession).chat?.turn === 'idle', 'the turn to end')
    const view = (await s.h.call('GET', `/api/c/cloud/sessions/${id}`, { token: s.phone })).json as PhoneSession
    expect(view).toMatchObject({ cloud: true, terminal: null, title: 'list the files and write hello.txt' })
    const words = JSON.stringify(view.chat!.items)
    expect(words).toContain('The directory was empty')
    expect(view.chat!.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'allowed' })
    const rows = ((await s.h.call('GET', '/api/c/cloud/chats', { token: s.phone })).json as PhoneChats).rows
    expect(rows).toMatchObject([{ ref: { kind: 'session', id }, cloud: true, live: false }])
    expect(rows[0]!.line).toContain('acme/app')
  })

  it('refuses what a cloud cannot do, plainly', async () => {
    const s = await setup({ claude: false })
    const none = await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'hi' } })
    expect(none.status).toBe(409)
    expect(none.json.message).toContain('Claude is not signed in')
    await s.h.call('PUT', '/v1/providers/claude/credential', { token: s.mac, body: { kind: 'claude_oauth_token', value: TOKEN } })
    expect((await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'hi', repo: '../etc' } })).status).toBe(400)
    expect((await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: '  ' } })).status).toBe(400)
    expect((await s.h.call('GET', '/api/c/other/chats', { token: s.phone })).status).toBe(404)
    expect((await s.h.call('GET', '/api/c/cloud/sessions/nope', { token: s.phone })).status).toBe(404)
    expect((await s.h.call('GET', '/api/c/cloud/room', { token: s.phone })).json).toMatchObject({ enabled: false })
    expect((await s.h.call('GET', '/api/c/cloud/tasks', { token: s.phone })).json).toMatchObject({ planned: [], working: [] })
  })

  it('streams the chat over the live socket, after the socket says who it is', async () => {
    const s = await setup()
    const id = (await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'hello' } })).json.sessionId as string
    const ws = new WebSocket(`${s.h.url.replace('http', 'ws')}/api/live`)
    const got: PhoneServerMsg[] = []
    ws.on('message', (m) => got.push(JSON.parse(String(m)) as PhoneServerMsg))
    await new Promise<void>((ok, no) => { ws.once('open', () => ok()); ws.once('error', no) })
    ws.send(JSON.stringify({ t: 'auth', token: s.phone }))
    await until(() => got.some((m) => m.t === 'hello'), 'hello')
    ws.send(JSON.stringify({ t: 'sub', companyId: 'cloud', sessionId: id }))
    await until(() => got.some((m) => m.t === 'subbed'), 'subbed')
    expect(got.find((m) => m.t === 'subbed')).toMatchObject({ sessionId: id })
    await until(async () => ((await s.h!.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds).count === 1, 'the ask')
    await s.h.call('POST', `/api/c/cloud/sessions/${id}/answer`, { token: s.phone, body: { requestId: (s.chats as FakeClaude).specs.length ? ((await s.h.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds).asks[0]!.id.split('~')[1] : '', decision: { kind: 'allow' } } })
    await until(() => got.some((m) => m.t === 'chat' && JSON.stringify(m.ops).includes('directory was')), 'chat ops')
    // a wrong token is refused
    const bad = new WebSocket(`${s.h.url.replace('http', 'ws')}/api/live`)
    const closed = new Promise<number>((ok) => bad.once('close', (code) => ok(code)))
    bad.once('open', () => bad.send(JSON.stringify({ t: 'auth', token: 'pdt_nope' })))
    expect(await closed).toBe(4401)
    ws.close()
  })

  it('keeps its chats across a restart, and a message resumes the conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcloud-phone-'))
    const chats = fakeClaudeChats()
    const s = await setup({ dir, chats })
    const id = (await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'first' } })).json.sessionId as string
    await until(async () => ((await s.h!.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds).count === 1, 'the ask')
    const ask = ((await s.h.call('GET', '/api/c/cloud/needs', { token: s.phone })).json as PhoneNeeds).asks[0]!
    await s.h.call('POST', `/api/c/cloud/asks/${encodeURIComponent(ask.id)}/answer`, { token: s.phone, body: { optionId: 'allow' } })
    await until(() => chats.transcripts.has(id), 'the transcript')
    const masterKey = s.h.masterKey
    await s.h.close()
    h = null
    // the same machine starts again: the chat is listed, opens from the transcript, and resumes on the next message
    const again = await startHarness({ chats, config: { fetch: githubFetch }, dir, masterKey })
    h = again
    const rows = ((await again.call('GET', '/api/c/cloud/chats', { token: s.phone })).json as PhoneChats).rows
    expect(rows.map((r) => r.ref.id)).toEqual([id])
    const view = (await again.call('GET', `/api/c/cloud/sessions/${id}`, { token: s.phone })).json as PhoneSession
    expect(view.chat).toMatchObject({ turn: 'ended', available: true })
    expect(JSON.stringify(view.chat!.items)).toContain('first')
    expect((await again.call('POST', `/api/c/cloud/sessions/${id}/send`, { token: s.phone, body: { text: 'second' } })).status).toBe(200)
    await until(() => chats.said.get(id)?.length === 2, 'the second message')
    expect(chats.specs.at(-1)).toMatchObject({ id, resume: true })
  })

  it('serves the phone app at the front page when it is built, else the console', async () => {
    const phoneDir = mkdtempSync(join(tmpdir(), 'pcloud-app-'))
    mkdirSync(join(phoneDir, 'assets'))
    writeFileSync(join(phoneDir, 'index.html'), '<!doctype html><title>Principia</title>')
    writeFileSync(join(phoneDir, 'assets', 'app-1.js'), 'console.log(1)')
    h = await startHarness({ config: { phoneDir } })
    const page = await h.call('GET', '/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('<title>Principia</title>')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self' ws://127.0.0.1:")
    expect((await h.call('GET', '/assets/app-1.js')).headers.get('cache-control')).toContain('immutable')
    expect((await h.call('GET', '/assets/../control.db')).status).not.toBe(200)
    await h.close()
    h = await startHarness({ config: { phoneDir: join(phoneDir, 'missing') } })
    const r = await h.call('GET', '/')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/console/')
  })
})
