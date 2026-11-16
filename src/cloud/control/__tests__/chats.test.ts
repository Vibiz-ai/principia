import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { CloudChatDown } from '../../../shared/cloud'
import { startHarness, type Harness } from './harness'

const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e'
const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(80)

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

function socket(url: string, id: string, from: number, token: string | null) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/v1/chats/${id}/attach?from=${from}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  const frames: CloudChatDown[] = []
  ws.on('message', (m) => frames.push(JSON.parse(String(m)) as CloudChatDown))
  const opened = new Promise<void>((ok, no) => {
    ws.once('open', () => ok())
    ws.once('error', no)
    ws.once('unexpected-response', (_q, r) => no(new Error(String(r.statusCode))))
  })
  return { ws, frames, opened }
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(f()).toBe(true)
}
const out = (frames: CloudChatDown[]) => frames.filter((f): f is Extract<CloudChatDown, { t: 'out' }> => f.t === 'out').map((f) => f.d).join('')

describe('cloud chats (docs/CLOUD-CHATS.md)', () => {
  it('needs Claude signed in on the cloud, then starts with the plain choices only', async () => {
    h = await startHarness()
    const dev = await h.pair()
    const start = { adapter: 'claude', conversationId: CONV, resume: false, model: 'opus', permissionMode: 'default', bypass: false, systemPrompt: null, repoUrl: 'https://github.com/acme/app', branch: 'main' }
    expect((await h.call('POST', '/v1/chats/s_1', { token: dev, body: start })).status).toBe(409)
    expect((await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: TOKEN } })).status).toBe(200)
    const r = await h.call('POST', '/v1/chats/s_1', { token: dev, body: start })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ id: 's_1', state: 'running' })
    const call = h.rt.calls.find((c) => c.method === 'chats.start')!.args[0] as Record<string, unknown>
    expect(call).toMatchObject({ id: 's_1', conversationId: CONV, model: 'opus', repo: { url: 'https://github.com/acme/app', branch: 'main' } })
    expect(call.provider).toMatchObject({ adapter: 'claude', value: '<secret>' })
    // never a local path, a flag or a non-GitHub address
    for (const bad of [{ repoUrl: 'file:///etc' }, { repoUrl: 'https://evil.example/x/y' }, { conversationId: '../x' }, { branch: '--upload-pack=x' }]) {
      expect((await h.call('POST', '/v1/chats/s_2', { token: dev, body: { ...start, ...bad } })).status).toBe(400)
    }
    expect((await h.call('GET', '/v1/chats', { token: dev })).json).toMatchObject([{ id: 's_1', state: 'running' }])
  })

  it('carries stdin and stdout over the socket, and a reconnect gets only what it has not seen', async () => {
    h = await startHarness()
    const dev = await h.pair()
    await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: TOKEN } })
    await h.call('POST', '/v1/chats/s_1', { token: dev, body: { conversationId: CONV } })
    const a = socket(h.url, 's_1', 0, dev)
    await a.opened
    a.ws.send(JSON.stringify({ t: 'in', d: 'one\n' }))
    await until(() => out(a.frames).includes('one'))
    const seen = out(a.frames).length
    a.ws.close()
    // while away
    h.rt.chats.write('s_1', 'two\n')
    const b = socket(h.url, 's_1', seen, dev)
    await b.opened
    await until(() => out(b.frames).includes('two'))
    expect(out(b.frames)).not.toContain('one')
    expect(b.frames.find((f) => f.t === 'state')).toMatchObject({ t: 'state', info: { state: 'running' } })
    b.ws.send(JSON.stringify({ t: 'signal', sig: 'SIGTERM' }))
    await until(() => b.frames.some((f) => f.t === 'state' && f.info.state === 'exited'))
    b.ws.close()
  })

  it('refuses a socket without a paired device, and an unknown chat', async () => {
    h = await startHarness()
    const dev = await h.pair()
    await expect(socket(h.url, 's_1', 0, null).opened).rejects.toThrow('401')
    await expect(socket(h.url, 's_1', 0, 'pdt_not-a-device').opened).rejects.toThrow('401')
    const s = socket(h.url, 's_nope', 0, dev)
    await s.opened
    const code = await new Promise<number>((r) => s.ws.once('close', (c) => r(c)))
    expect(code).toBe(4404)
  })

  it('a live chat keeps the machine busy', async () => {
    h = await startHarness()
    const dev = await h.pair()
    await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: TOKEN } })
    await h.call('POST', '/v1/chats/s_1', { token: dev, body: { conversationId: CONV } })
    expect(h.rt.chats.live()).toBe(1)
    expect((await h.call('DELETE', '/v1/chats/s_1', { token: dev })).status).toBe(200)
    expect(h.rt.chats.live()).toBe(0)
  })
})
