import { afterEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../../../cloud/control/__tests__/harness'
import { chatChoices, cloudChildSpawn, githubHttps } from '../chatChild'
import { CloudClient } from '../client'
import { toChatArgs } from '../../chat/chatArgs'

const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e'
const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(80)

let h: Harness | null = null
afterEach(async () => {
  await h?.close()
  h = null
})

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  expect(f()).toBe(true)
}

describe('cloud chat on the Mac (docs/CLOUD-CHATS.md)', () => {
  it('sends only the choices in the chat argv: never a Mac path or another flag', () => {
    const interactive = ['--settings', '/Users/me/.hive/hooks.json', '--mcp-config', '/Users/me/mcp.json', '--add-dir', '/Users/me/x', '--session-id', CONV, '--model', 'opus', '--permission-mode', 'default', '--append-system-prompt', 'Be brief']
    const { args } = toChatArgs(interactive)
    const c = chatChoices(args)
    expect(c).toEqual({ conversationId: CONV, resume: false, model: 'opus', permissionMode: 'default', bypass: false, systemPrompt: 'Be brief' })
    expect(JSON.stringify(c)).not.toContain('/Users/me')
    expect(chatChoices(['--resume', CONV, '--dangerously-skip-permissions'])).toMatchObject({ resume: true, bypass: true })
  })

  it('reads the GitHub repository from any remote form', () => {
    expect(githubHttps('git@github.com:Vibiz-ai/principia.git')).toBe('https://github.com/Vibiz-ai/principia')
    expect(githubHttps('https://github.com/Vibiz-ai/principia')).toBe('https://github.com/Vibiz-ai/principia')
    expect(githubHttps('https://x-access-token:abc@github.com/o/r.git')).toBe('https://github.com/o/r')
    expect(githubHttps('ssh://git@github.com/o/r.git')).toBe('https://github.com/o/r')
    expect(githubHttps('https://gitlab.com/o/r')).toBeNull()
  })

  it('runs in the cloud: starts there with the repository, stdin up, stdout down, a dropped socket loses nothing', async () => {
    h = await startHarness()
    const dev = await h.pair()
    await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: TOKEN } })
    const client = new CloudClient({ url: h.url, token: dev })
    const statuses: string[] = []
    const saved: [string, string][] = []
    const spawn = cloudChildSpawn({ client: () => client, repoOf: async () => ({ url: 'https://github.com/acme/app', branch: 'main' }), backoffMs: () => 10, transcriptQuietMs: 20, saveTranscript: (c, t) => saved.push([c, t]) })
    const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--session-id', CONV, '--model', 'opus'], { cwd: '/Users/me/app', env: {} })
    child.onStatus?.((t) => statuses.push(t))
    let out = ''
    child.stdout!.on('data', (d) => (out += String(d)))
    let exit: [number | null, string | null] | null = null
    child.on('exit', (c, s) => (exit = [c, s]))
    // written before the cloud even answered: delivered once connected
    child.stdin!.write('one\n')
    await until(() => out.includes('one'))
    const start = h.rt.calls.find((c) => c.method === 'chats.start')!.args[0] as Record<string, unknown>
    expect(start).toMatchObject({ id: CONV, conversationId: CONV, model: 'opus', repo: { url: 'https://github.com/acme/app', branch: 'main' } })
    // the connection drops (Wi-Fi, a sleeping laptop): output while away arrives after the reconnect, once
    ;(child as unknown as { child: { ws: { terminate(): void } } }).child.ws.terminate()
    h.rt.chats.write(CONV, 'two\n')
    await until(() => out.includes('two'))
    expect(out.match(/one/g)!.length).toBe(1)
    // quiet output: this Mac keeps a copy of the conversation's history (it shows after a restart of the app)
    await until(() => saved.length > 0)
    expect(saved[0]![0]).toBe(CONV)
    expect(saved[0]![1]).toContain('"type":"user"')
    child.kill('SIGTERM')
    await until(() => exit !== null)
    expect(exit).toEqual([null, 'SIGTERM'])
    expect(statuses[0]).toBe('Starting in your cloud…')
  })

  it('says why when the cloud refuses (Claude not signed in there), and ends', async () => {
    h = await startHarness()
    const dev = await h.pair()
    const client = new CloudClient({ url: h.url, token: dev })
    const spawn = cloudChildSpawn({ client: () => client, repoOf: async () => null })
    const child = spawn('claude', ['--session-id', CONV], { cwd: '/tmp', env: {} })
    let err = ''
    child.stderr!.on('data', (d) => (err += String(d)))
    let code: number | null | undefined
    child.on('exit', (c) => (code = c))
    await until(() => code !== undefined)
    expect(code).toBe(1)
    expect(err).toMatch(/Claude is not signed in on your cloud/)
  })

  it('a cloud from before cloud chats (no such route) says to Turn Off and On', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'not_found', message: 'Not found.' }), { status: 404 })) as typeof fetch
    const spawn = cloudChildSpawn({ client: () => new CloudClient({ url: 'http://old.invalid', token: 'pdt_x', fetch: f }), repoOf: async () => null })
    const child = spawn('claude', ['--session-id', CONV], { cwd: '/tmp', env: {} })
    let err = ''
    child.stderr!.on('data', (d) => (err += String(d)))
    let code: number | null | undefined
    child.on('exit', (c) => (code = c))
    await until(() => code !== undefined)
    expect(err).toMatch(/older version without cloud chats.*Turn Off and then Turn On/)
  })
})
