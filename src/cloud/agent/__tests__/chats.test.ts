import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatProcInfo, ChatProcSpec } from '../../contract'
import { ChatProcs, chatArgv } from '../chats'
import { ProcessSandbox } from '../sandbox'
import { FAKE_BINS, tmp } from './fakes'

const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e'
const TOKEN = 'sk-ant-oat01-SECRET-' + 'y'.repeat(40)

function setup(o: { idleMs?: number; repoFails?: boolean } = {}) {
  const dir = tmp()
  const sandbox = new ProcessSandbox({ runtimeDir: join(dir, 'runtime'), workspaceDir: join(dir, 'ws'), agentUser: null })
  const synced: { companyId: string; url: string }[] = []
  const secrets: string[] = []
  const procs = new ChatProcs({
    sandbox,
    bin: FAKE_BINS.claude,
    git: 'git',
    codexBin: FAKE_BINS.codex,
    async syncRepo(companyId, repo) {
      synced.push({ companyId, url: repo.url })
      if (o.repoFails) return { ok: false, detail: 'Repository not found' }
      mkdirSync(join(sandbox.companyDir(companyId), repo.name), { recursive: true })
      return { ok: true, detail: null }
    },
    redact: (s) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), s),
    addSecret: (v) => void secrets.push(v),
    log: { info: () => undefined, warn: () => undefined },
    idleMs: o.idleMs
  })
  return { dir, sandbox, procs, synced }
}

const spec = (over: Partial<ChatProcSpec> = {}): ChatProcSpec => ({
  id: 'sess_1',
  conversationId: CONV,
  resume: false,
  model: null,
  permissionMode: null,
  bypass: false,
  systemPrompt: null,
  repo: null,
  provider: { credentialId: 'cred_1', adapter: 'claude', kind: 'claude_oauth_token', value: TOKEN },
  secrets: {},
  githubToken: null,
  ...over
})

function follow(procs: ChatProcs, id: string, from = 0) {
  const seen = { out: '', states: [] as ChatProcInfo[], err: '' }
  const detach = procs.attach(id, from, { out: (d) => (seen.out += d), err: (d) => (seen.err += d), state: (i) => seen.states.push(i) })
  return { seen, detach }
}
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  expect(f()).toBe(true)
}
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

describe('cloud chat processes (docs/CLOUD-CHATS.md)', () => {
  it('builds the argv from choices only: stream flags, the conversation, permission prompts back to the Mac', () => {
    expect(chatArgv({ conversationId: CONV, resume: true, model: 'opus', permissionMode: 'acceptEdits', bypass: false, systemPrompt: 'Be brief' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
      '--resume', CONV, '--model', 'opus', '--permission-mode', 'acceptEdits', '--permission-prompt-tool', 'stdio', '--append-system-prompt', 'Be brief'
    ])
    const bypass = chatArgv({ conversationId: CONV, resume: false, model: '--evil', permissionMode: 'weird', bypass: true, systemPrompt: null })
    expect(bypass).toContain('--dangerously-skip-permissions')
    expect(bypass).not.toContain('--evil')
    expect(bypass).not.toContain('--permission-prompt-tool')
  })

  it('runs Claude signed in, queues stdin while it prepares, and keeps the output for a late attach', async () => {
    const t = setup()
    const a = follow(t.procs, 'sess_1')
    expect(a.detach).toBeNull()
    await t.procs.start(spec())
    // written before the process is up: delivered once it is
    t.procs.write('sess_1', user('hello'))
    const b = follow(t.procs, 'sess_1')
    await until(() => b.seen.states.some((s) => s.state === 'exited'))
    expect(b.seen.states.map((s) => s.state)).toContain('running')
    expect(b.seen.out).toContain('fake-claude-ok')
    expect(b.seen.out).not.toContain(TOKEN)
    // a Mac that saw part of it gets the rest, nothing twice
    const half = Math.floor(b.seen.out.length / 2)
    const c = follow(t.procs, 'sess_1', half)
    expect(c.seen.out).toBe(b.seen.out.slice(half))
    expect(t.procs.live()).toBe(0)
    // the sign-in stays in the chat's own home (0600), for the next process of this chat
    expect(existsSync(join(t.dir, 'runtime', 'runs', 'chat_sess_1', 'home'))).toBe(true)
  })

  it('clones the repository into the chat folder first, and says why when it cannot', async () => {
    const t = setup({ repoFails: true })
    const a = follow(t.procs, 'sess_1')
    await t.procs.start(spec({ repo: { id: 'chat', name: 'app', url: 'https://github.com/acme/app', branch: null, token: 'ghp_x' } }))
    const b = follow(t.procs, 'sess_1')
    await until(() => b.seen.states.some((s) => s.state === 'exited'))
    expect(a.detach).toBeNull()
    expect(t.synced).toEqual([{ companyId: 'chat_sess_1', url: 'https://github.com/acme/app' }])
    expect(b.seen.states.at(-1)).toMatchObject({ state: 'exited', error: expect.stringContaining('Repository not found'), repo: 'acme/app' })
  })

  it('without a sign-in it does not start', async () => {
    const t = setup()
    await t.procs.start(spec({ provider: null }))
    const b = follow(t.procs, 'sess_1')
    await until(() => b.seen.states.some((s) => s.state === 'exited'))
    expect(b.seen.states.at(-1)!.error).toMatch(/not signed in/)
  })

  it('stops a process nobody follows after the idle time; a followed one keeps going', async () => {
    const t = setup({ idleMs: 60 })
    await t.procs.start(spec())
    const a = follow(t.procs, 'sess_1')
    await until(() => a.seen.states.some((s) => s.state === 'running'))
    await new Promise((r) => setTimeout(r, 150))
    expect(t.procs.live()).toBe(1)
    a.detach!()
    await until(() => t.procs.live() === 0)
    expect(t.procs.get('sess_1')!.state).toBe('exited')
  })

  it('remove deletes the chat folder and its home', async () => {
    const t = setup()
    await t.procs.start(spec({ repo: { id: 'chat', name: 'app', url: 'https://github.com/acme/app', branch: null, token: null } }))
    await until(() => t.procs.get('sess_1')!.state === 'running')
    await t.procs.remove('sess_1')
    expect(t.procs.get('sess_1')).toBeNull()
    expect(existsSync(join(t.dir, 'ws', 'chat_sess_1'))).toBe(false)
    expect(existsSync(join(t.dir, 'runtime', 'runs', 'chat_sess_1', 'home'))).toBe(false)
    void readFileSync
  })
})
