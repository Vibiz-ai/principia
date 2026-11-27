import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { PhoneChanges, PhoneDir, PhoneFile, PhonePorts, PhoneShellServerMsg } from '../../../shared/remote'
import { isBinary, listeningPorts, parseProcNet, PREVIEW_CSP, SHELL_KEEP_CHARS } from '../phoneTools'
import { fakeClaudeChats, type FakeClaude } from './fakeClaude'
import { startHarness, type Harness } from './harness'

const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(80)
const GH = 'ghp_' + 'g'.repeat(36)

let h: Harness | null = null
const servers: Server[] = []
afterEach(async () => {
  await h?.close()
  h = null
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)))
})

const until = async (f: () => boolean | Promise<boolean>, what = 'condition') => {
  for (let i = 0; i < 600; i++) {
    if (await f()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function setup(o: { procRoot?: string | null; shellGraceMs?: number } = {}): Promise<{ h: Harness; mac: string; phone: string; chats: FakeClaude; id: string; root: string }> {
  const chats = fakeClaudeChats()
  const harness = await startHarness({ chats, phoneTools: { procRoot: o.procRoot ?? null, ...(o.shellGraceMs ? { shellGraceMs: o.shellGraceMs } : {}) } })
  h = harness
  const mac = await harness.pair()
  await harness.call('PUT', '/v1/providers/claude/credential', { token: mac, body: { kind: 'claude_oauth_token', value: TOKEN } })
  await harness.call('PUT', '/v1/accounts/github', { token: mac, body: { token: GH, login: 'lau' } })
  const link = await harness.call('POST', '/v1/phone-link', { token: mac })
  const code = /code=([0-9a-f]{32})$/.exec(link.json.link)![1]
  const phone = (await harness.call('POST', '/api/pair', { body: { code, name: 'iPhone' } })).json.token as string
  const id = (await harness.call('POST', '/api/c/cloud/chats/new', { token: phone, body: { text: 'hello' } })).json.sessionId as string
  await until(() => chats.said.get(id)?.length === 1, 'the chat to start')
  return { h: harness, mac, phone, chats, id, root: join(chats.dir, `chat_${id}`) }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString()

describe("a cloud chat's folder on the phone (docs/CLOUD-PHONE.md)", () => {
  it('is for a paired phone only, and for chats this cloud owns', async () => {
    const s = await setup()
    const p = `/api/c/cloud/sessions/${s.id}`
    expect((await s.h.call('GET', `${p}/files`)).status).toBe(401)
    expect((await s.h.call('GET', `${p}/files`, { token: 'pdt_nope' })).status).toBe(401)
    // a Mac's device token reaches the Phone API, but never a chat's folder
    expect((await s.h.call('GET', `${p}/files`, { token: s.mac })).status).toBe(403)
    expect((await s.h.call('GET', `${p}/changes`, { token: s.mac })).status).toBe(403)
    expect((await s.h.call('POST', `${p}/preview`, { token: s.mac, body: { port: 3000 } })).status).toBe(403)
    expect((await s.h.call('GET', `/api/c/cloud/sessions/nope/files`, { token: s.phone })).status).toBe(404)
    expect((await s.h.call('GET', `/api/c/other/sessions/${s.id}/files`, { token: s.phone })).status).toBe(404)
    expect((await s.h.call('GET', `${p}/files`, { token: s.phone })).status).toBe(200)
  })

  it('lists and shows files inside the folder, and nothing outside it', async () => {
    const s = await setup()
    const outside = mkdtempSync(join(tmpdir(), 'pcloud-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    mkdirSync(join(s.root, 'src'))
    writeFileSync(join(s.root, 'README.md'), '# Hello\n')
    writeFileSync(join(s.root, 'src', 'main.ts'), 'export const x = 1\n')
    writeFileSync(join(s.root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]))
    writeFileSync(join(s.root, 'big.txt'), 'a'.repeat(3 * 1024 * 1024))
    symlinkSync(outside, join(s.root, 'away'))
    symlinkSync(join(outside, 'secret.txt'), join(s.root, 'leak.txt'))
    symlinkSync(join(s.root, 'src', 'main.ts'), join(s.root, 'main-link.ts'))
    const q = (route: string, path: string) => s.h.call('GET', `/api/c/cloud/sessions/${s.id}/${route}?path=${encodeURIComponent(path)}`, { token: s.phone })

    const top = (await q('files', '')).json as PhoneDir
    expect(top.path).toBe('')
    expect(top.entries[0]).toMatchObject({ name: 'src', kind: 'dir' })
    const kinds = Object.fromEntries(top.entries.map((e) => [e.name, e.kind]))
    expect(kinds).toMatchObject({ 'README.md': 'file', away: 'link', 'leak.txt': 'link', 'main-link.ts': 'file' })
    expect(((await q('files', 'src')).json as PhoneDir).entries.map((e) => e.name)).toEqual(['main.ts'])
    expect(((await q('file', 'src/main.ts')).json as PhoneFile)).toMatchObject({ path: 'src/main.ts', text: 'export const x = 1\n', truncated: false })
    expect(((await q('file', 'main-link.ts')).json as PhoneFile).path).toBe('src/main.ts')

    // out by .., by an absolute path, by a link: refused, and the outside file never shows
    for (const [route, path] of [['files', '..'], ['files', '../..'], ['file', '../../etc/passwd'], ['files', 'away'], ['file', 'leak.txt'], ['file', 'away/secret.txt']] as const) {
      const r = await q(route, path)
      expect(r.status, `${route} ${path}`).toBe(400)
      expect(r.text).not.toContain('top secret')
    }
    // an absolute path is read inside the folder
    expect((await q('file', '/etc/passwd')).status).toBe(404)
    expect((await q('file', 'missing.txt')).status).toBe(404)
    const bin = await q('file', 'blob.bin')
    expect(bin.status).toBe(400)
    expect(bin.json.message).toContain('binary')
    expect((await q('file', 'big.txt')).json.message).toContain('too big')
    expect((await q('file', 'src')).status).toBe(400)
    expect(isBinary(Buffer.from('plain text\n'))).toBe(false)
  })

  it("shows git status, the working tree's diff and the branch's commits against the default branch", async () => {
    const s = await setup()
    const origin = join(s.chats.dir, `origin-${s.id}.git`)
    git(s.chats.dir, 'init', '--bare', origin)
    git(s.root, 'clone', origin, 'app')
    const app = join(s.root, 'app')
    writeFileSync(join(app, 'a.txt'), 'one\ntwo\n')
    git(app, 'add', '.')
    git(app, 'commit', '-m', 'first')
    git(app, 'push', 'origin', 'main')
    git(app, 'remote', 'set-head', 'origin', 'main')
    git(app, 'checkout', '-b', 'feat/x')
    writeFileSync(join(app, 'b.txt'), 'feature line\n')
    git(app, 'add', '.')
    git(app, 'commit', '-m', 'add the feature')
    writeFileSync(join(app, 'a.txt'), 'one\nchanged\n')
    writeFileSync(join(app, 'new.txt'), 'fresh\n')

    const c = (await s.h.call('GET', `/api/c/cloud/sessions/${s.id}/changes`, { token: s.phone })).json as PhoneChanges
    expect(c).toMatchObject({ repo: 'app', branch: 'feat/x', base: 'origin/main', ahead: null })
    expect(c.status).toEqual(expect.arrayContaining([{ code: ' M', path: 'a.txt' }, { code: '??', path: 'new.txt' }]))
    expect(c.diff).toContain('-two')
    expect(c.diff).toContain('+changed')
    expect(c.commits).toMatchObject([{ subject: 'add the feature' }])
    expect(c.branchDiff).toContain('+feature line')
    expect(c.branchDiff).not.toContain('+changed')

    // a chat with no repository: nothing to show, plainly
    const s2 = (await s.h.call('POST', '/api/c/cloud/chats/new', { token: s.phone, body: { text: 'again' } })).json.sessionId as string
    await until(() => s.chats.said.get(s2)?.length === 1, 'the second chat')
    expect((await s.h.call('GET', `/api/c/cloud/sessions/${s2}/changes`, { token: s.phone })).json).toMatchObject({ repo: null, status: [], diff: '' })
  })

  it('previews a server through a signed link: sandboxed, no cookies either way, and only for that phone', async () => {
    const s = await setup()
    const dev = createServer((req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: '/landed' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'sid=evil; Path=/', 'access-control-allow-origin': 'https://evil.example', 'access-control-allow-credentials': 'true' })
      res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }))
    })
    const wss = new WebSocketServer({ server: dev })
    wss.on('connection', (c, req) => c.send(`hi ${req.url}`))
    servers.push(dev)
    await new Promise<void>((r) => dev.listen(0, '127.0.0.1', () => r()))
    const port = (dev.address() as { port: number }).port
    const p = `/api/c/cloud/sessions/${s.id}/preview`

    expect((await s.h.call('POST', p, { body: { port } })).status).toBe(401)
    expect((await s.h.call('POST', p, { token: s.phone, body: { port: 80 } })).status).toBe(400)
    expect((await s.h.call('POST', p, { token: s.phone, body: { port: 70000 } })).status).toBe(400)
    const own = Number(new URL(s.h.url).port)
    expect((await s.h.call('POST', p, { token: s.phone, body: { port: own } })).status).toBe(400)
    const link = (await s.h.call('POST', p, { token: s.phone, body: { port } })).json as { url: string; expiresAt: string }
    expect(link.url.startsWith(`${s.h.url}/preview/${s.id}/${port}/`)).toBe(true)

    const r = await fetch(`${link.url}api/x?y=1`, { headers: { cookie: 'pp_session=console-cookie', authorization: 'Bearer pdt_mine' } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { url: string; host: string; cookie: string | null; auth: string | null }
    expect(body).toEqual({ url: '/api/x?y=1', host: `localhost:${port}`, cookie: null, auth: null })
    expect(r.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    const go = await fetch(`${link.url}go`, { redirect: 'manual' })
    expect(go.headers.get('location')).toBe(`${new URL(link.url).pathname}landed`)

    // its live-reload socket goes through too
    const ws = new WebSocket(`${link.url.replace('http', 'ws')}hmr`)
    const first = await new Promise<string>((ok, no) => { ws.once('message', (m) => ok(String(m))); ws.once('error', no) })
    expect(first).toBe('hi /hmr')
    ws.close()

    // a forged or altered link, another port, an unknown chat: refused
    const u = new URL(link.url)
    const parts = u.pathname.split('/')
    const tok = parts[4]!
    const bad = tok.slice(0, -1) + (tok.endsWith('0') ? '1' : '0')
    expect((await fetch(`${s.h.url}/preview/${s.id}/${port}/${bad}/`)).status).toBe(403)
    expect((await fetch(`${s.h.url}/preview/${s.id}/${port + 1}/${tok}/`)).status).toBe(403)
    expect((await fetch(`${s.h.url}/preview/${s.id}/${port}/nope/`)).status).toBe(404)
    const refused = new WebSocket(`${s.h.url.replace('http', 'ws')}/preview/${s.id}/${port}/${bad}/hmr`)
    await new Promise<void>((ok) => { refused.once('error', () => ok()); refused.once('close', () => ok()) })
    // nothing listening: a plain 502
    const idle = createServer()
    await new Promise<void>((r) => idle.listen(0, '127.0.0.1', () => r()))
    const freePort = (idle.address() as { port: number }).port
    await new Promise((r) => idle.close(() => r(null)))
    const dead = (await s.h.call('POST', p, { token: s.phone, body: { port: freePort } })).json as { url: string }
    expect((await fetch(dead.url)).status).toBe(502)

    // the phone signs out: its links stop at once
    await s.h.call('POST', '/api/sign-out', { token: s.phone })
    expect((await fetch(link.url)).status).toBe(403)
  })

  it('lists the ports the agent listens on, and previews only those (where /proc tells)', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'pcloud-proc-'))
    mkdirSync(join(proc, 'net'))
    const uid = process.getuid?.() ?? 0
    const row = (n: number, port: number, st: string, u: number, inode: string, addr = '00000000') => `   ${n}: ${addr}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${u}        0 ${inode} 1 0000000000000000 100 0 0 10 0`
    writeFileSync(join(proc, 'net', 'tcp'), ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode', row(0, 5173, '0A', uid, '111', '0100007F'), row(1, 9999, '0A', uid + 1, '222'), row(2, 3000, '01', uid, '333'), row(3, 80, '0A', uid, '444')].join('\n'))
    expect(parseProcNet(readFileSync(join(proc, 'net', 'tcp'), 'utf8'))).toHaveLength(3)
    const s = await setup({ procRoot: proc })
    const ports = (await s.h.call('GET', `/api/c/cloud/sessions/${s.id}/ports`, { token: s.phone })).json as PhonePorts
    expect(ports).toEqual({ known: true, ports: [{ port: 5173, chat: false, address: 'loopback' }] })
    expect((await s.h.call('POST', `/api/c/cloud/sessions/${s.id}/preview`, { token: s.phone, body: { port: 5173 } })).status).toBe(200)
    const no = await s.h.call('POST', `/api/c/cloud/sessions/${s.id}/preview`, { token: s.phone, body: { port: 9999 } })
    expect(no.status).toBe(404)
    expect(no.json.message).toContain('Nothing in your cloud listens on port 9999')
    expect(listeningPorts(null, uid, '/x', null)).toBeNull()
  })

  it('runs a shell in the chat folder over a socket that says who it is first', async () => {
    const s = await setup({ shellGraceMs: 100 })
    const wsUrl = `${s.h.url.replace('http', 'ws')}/api/shell`
    const open = async (token: string) => {
      const ws = new WebSocket(wsUrl)
      const got: PhoneShellServerMsg[] = []
      let closed: number | null = null
      ws.on('message', (m) => got.push(JSON.parse(String(m)) as PhoneShellServerMsg))
      ws.on('close', (c) => (closed = c))
      await new Promise<void>((ok, no) => { ws.once('open', () => ok()); ws.once('error', no) })
      ws.send(JSON.stringify({ t: 'auth', token }))
      return { ws, got, closed: () => closed, text: () => got.map((m) => (m.t === 'out' ? m.text : m.t === 'ready' ? m.text : '')).join('') }
    }
    // a wrong token, and a Mac's: closed
    for (const t of ['pdt_nope', s.mac]) {
      const bad = await open(t)
      await until(() => bad.closed() !== null, 'the refusal')
      expect(bad.closed()).toBe(4401)
    }
    const a = await open(s.phone)
    await until(() => a.got.some((m) => m.t === 'hello'), 'hello')
    a.ws.send(JSON.stringify({ t: 'open', sessionId: 'nope' }))
    await until(() => a.got.some((m) => m.t === 'error'), 'the unknown chat')
    a.ws.send(JSON.stringify({ t: 'open', sessionId: s.id }))
    await until(() => a.got.some((m) => m.t === 'ready'), 'ready')
    a.ws.send(JSON.stringify({ t: 'line', text: 'echo hi-$((1+1)); pwd -P' }))
    await until(() => a.text().includes('hi-2'), 'the echo')
    await until(() => a.text().includes(s.root), 'pwd')
    expect(a.text()).toContain('$ echo hi-$((1+1))')
    // Ctrl-C stops the command in front, the shell carries on
    a.ws.send(JSON.stringify({ t: 'line', text: 'sleep 30' }))
    await new Promise((r) => setTimeout(r, 150))
    a.ws.send(JSON.stringify({ t: 'int' }))
    a.ws.send(JSON.stringify({ t: 'line', text: 'echo after' }))
    await until(() => /\nafter\n/.test(a.text()), 'the shell after Ctrl-C')
    // the phone comes back within the grace: the same shell, its scrollback with it
    a.ws.close()
    const b = await open(s.phone)
    await until(() => b.got.some((m) => m.t === 'hello'), 'hello again')
    b.ws.send(JSON.stringify({ t: 'open', sessionId: s.id }))
    await until(() => b.got.some((m) => m.t === 'ready'), 'ready again')
    expect(b.text()).toContain('hi-2')
    // nobody there past the grace: it ends, and the next one starts fresh
    b.ws.close()
    await new Promise((r) => setTimeout(r, 400))
    const c = await open(s.phone)
    await until(() => c.got.some((m) => m.t === 'hello'), 'hello, third')
    c.ws.send(JSON.stringify({ t: 'open', sessionId: s.id }))
    await until(() => c.got.some((m) => m.t === 'ready'), 'ready, third')
    expect(c.text()).not.toContain('hi-2')
    c.ws.close()
  })

  it('reads the chat folder once a minute, not on every tap', async () => {
    const s = await setup()
    let calls = 0
    const orig = s.chats.workspace!.bind(s.chats)
    s.chats.workspace = (id, keys) => (calls++, orig(id, keys))
    for (let i = 0; i < 4; i++) expect((await s.h.call('GET', `/api/c/cloud/sessions/${s.id}/files`, { token: s.phone })).status).toBe(200)
    await s.h.call('GET', `/api/c/cloud/sessions/${s.id}/changes`, { token: s.phone })
    expect(calls).toBe(1)
  })

  it('lets go of a request whose tab went away, streams without a timeout, and tries ::1 when 127.0.0.1 refuses', async () => {
    const s = await setup()
    let upstreamClosed = false
    const dev = createServer((req, res) => {
      if (req.url === '/hang') return void req.on('close', () => (upstreamClosed = true))
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return void res.write('data: one\n\n')
      }
      res.end('ok')
    })
    servers.push(dev)
    await new Promise<void>((r) => dev.listen(0, '127.0.0.1', () => r()))
    const port = (dev.address() as { port: number }).port
    const link = (await s.h.call('POST', `/api/c/cloud/sessions/${s.id}/preview`, { token: s.phone, body: { port } })).json as { url: string }
    const ac = new AbortController()
    const hanging = fetch(`${link.url}hang`, { signal: ac.signal }).catch(() => null)
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await hanging
    await until(() => upstreamClosed, 'the request to the server to end')
    const ev = await fetch(`${link.url}events`)
    const reader = ev.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: one')
    await reader.cancel()

    // a server on IPv6 localhost only
    const six = createServer((_req, res) => res.end('six'))
    servers.push(six)
    const ok6 = await new Promise<boolean>((r) => { six.once('error', () => r(false)); six.listen(0, '::1', () => r(true)) })
    if (ok6) {
      const p6 = (six.address() as { port: number }).port
      const l6 = (await s.h.call('POST', `/api/c/cloud/sessions/${s.id}/preview`, { token: s.phone, body: { port: p6 } })).json as { url: string }
      expect(await (await fetch(l6.url)).text()).toBe('six')
    }
  })

  it('keeps the shell bounded, ends it when it exits, and closes it for a phone that signs out', async () => {
    const s = await setup()
    const wsUrl = `${s.h.url.replace('http', 'ws')}/api/shell`
    const open = async () => {
      const ws = new WebSocket(wsUrl)
      const got: PhoneShellServerMsg[] = []
      let closed: number | null = null
      ws.on('message', (m) => got.push(JSON.parse(String(m)) as PhoneShellServerMsg))
      ws.on('close', (c) => (closed = c))
      await new Promise<void>((ok, no) => { ws.once('open', () => ok()); ws.once('error', no) })
      ws.send(JSON.stringify({ t: 'auth', token: s.phone }))
      await until(() => got.some((m) => m.t === 'hello'), 'hello')
      ws.send(JSON.stringify({ t: 'open', sessionId: s.id }))
      await until(() => got.some((m) => m.t === 'ready'), 'ready')
      return { ws, got, closed: () => closed }
    }
    // output with no newline at all: the scrollback still stays within its cap
    const a = await open()
    a.ws.send(JSON.stringify({ t: 'line', text: `head -c ${SHELL_KEEP_CHARS + 100000} /dev/zero | tr '\\0' a; printf 'done-%s' it` }))
    // the typed line is echoed as `$ <line>`; it must not itself contain done-it, or the wait ends before the output does
    await until(() => a.got.some((m) => m.t === 'out' && m.text.includes('done-it')), 'the long output')
    a.ws.close()
    const b = await open()
    const ready = b.got.find((m) => m.t === 'ready') as Extract<PhoneShellServerMsg, { t: 'ready' }>
    expect(ready.text.length).toBeLessThanOrEqual(SHELL_KEEP_CHARS)
    expect(ready.text).toContain('done-it')
    // the shell exits while a process of its own session still holds its output: it is over all the same
    b.ws.send(JSON.stringify({ t: 'line', text: "perl -MPOSIX -e 'POSIX::setsid(); sleep 20' & exit" }))
    await until(() => b.got.some((m) => m.t === 'exit'), 'the exit')
    // a new one starts at once
    const c = await open()
    expect((c.got.find((m) => m.t === 'ready') as { text: string }).text).not.toContain('done-it')
    // the phone signs out: its shell socket closes, and nothing more runs on its say
    await s.h.call('POST', '/api/sign-out', { token: s.phone })
    await until(() => c.closed() !== null, 'the socket to close')
    expect(c.closed()).toBe(4401)
  })
})
