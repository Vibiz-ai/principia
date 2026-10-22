// docs/CLOUD.md §7.2: Connect Claude and Sign in with ChatGPT run on this Mac with fake CLIs: the token is captured
// from ANSI output and sent straight to the cloud, temp homes are isolated and deleted, timeout, cancel, a missing
// binary and a busy port each say what to do, and the token never appears in a status the renderer could see.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CloudLoginStatus } from '../../../shared/types'
import { AccountLogins, signInUrl, stripAnsi, type LoginDeps, type LoginSpawner } from '../logins'

const TOKEN = 'sk-ant-oat01-AbC_dEf-123456789xyz'
let bin: string
let tmpRoot: string
let reports: CloudLoginStatus[]
let uploads: { adapter: string; kind: string; value: string }[]

/** child_process stands in for node-pty (Electron's native build cannot load under vitest) */
const spawner: LoginSpawner = (file, args, opts) => {
  const p = spawn(file, args, { env: opts.env, cwd: opts.cwd })
  return {
    onData: (cb) => {
      p.stdout.on('data', (b: Buffer) => cb(b.toString()))
      p.stderr.on('data', (b: Buffer) => cb(b.toString()))
    },
    onExit: (cb) => void p.on('close', (code) => cb(code)),
    kill: () => void p.kill('SIGTERM')
  }
}
const script = (name: string, body: string): void => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}
const deps = (p: Partial<LoginDeps> = {}): LoginDeps => ({
  spawn: spawner,
  env: () => ({ PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'sk-ant-api-should-not-leak', HOME: os.homedir() }),
  resolveBin: (name, env) => {
    for (const d of (env.PATH ?? '').split(':')) if (fs.existsSync(path.join(d, name))) return path.join(d, name)
    return null
  },
  upload: async (adapter, kind, value) => void uploads.push({ adapter, kind, value }),
  test: async () => ({ ok: true, detail: 'accepted' }),
  report: (s) => void reports.push(s),
  tmpRoot,
  portBusy: async () => false,
  ...p
})

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-'))
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'login-tmp-'))
  reports = []
  uploads = []
})
afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true })
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('Connect Claude', () => {
  it('captures the token from ANSI output in an isolated HOME, uploads it, tests it, deletes the temp dir', async () => {
    const envOut = path.join(bin, 'env.txt')
    script(
      'claude',
      `echo "HOME=$HOME CONFIG=$CLAUDE_CONFIG_DIR KEY=$ANTHROPIC_API_KEY ARGS=$*" > ${envOut}
printf '\\033[1mOpening https://claude.ai/oauth/authorize?code=true&state=abc\\033[0m\\n'
sleep 0.1
printf 'Your OAuth token (valid for 1 year):\\n\\n\\033[32m${TOKEN}\\033[39m\\n\\nStore this token securely.\\n'`
    )
    const s = await new AccountLogins(deps()).start('claude')
    expect(s).toMatchObject({ adapter: 'claude', phase: 'done', message: 'Connected.' })
    expect(uploads).toEqual([{ adapter: 'claude', kind: 'claude_oauth_token', value: TOKEN }])
    const env = fs.readFileSync(envOut, 'utf8')
    expect(env).toMatch(new RegExp(`HOME=${tmpRoot}/principia-claude-\\S+ CONFIG=${tmpRoot}/principia-claude-\\S+/\\.claude KEY= ARGS=setup-token`))
    expect(env).not.toContain(os.homedir())
    expect(fs.readdirSync(tmpRoot)).toEqual([])
    expect(reports.map((r) => r.phase)).toEqual(['starting', 'waiting', 'uploading', 'testing', 'done'])
    expect(reports.find((r) => r.phase === 'waiting')?.browserUrl).toBe('https://claude.ai/oauth/authorize?code=true&state=abc')
    // the token never reaches anything the renderer sees
    expect(JSON.stringify(reports)).not.toContain('sk-ant-oat01')
  })

  it('a missing claude says how to install it, or paste a token', async () => {
    const s = await new AccountLogins(deps()).start('claude')
    expect(s).toMatchObject({ phase: 'failed', reason: 'missing_cli', installHint: 'npm install -g @anthropic-ai/claude-code', message: 'Install Claude Code on this Mac, or paste a token.' })
    expect(uploads).toEqual([])
  })

  it('output without a token is no_token, a failing CLI is cli_failed', async () => {
    script('claude', `echo "something new"`)
    expect(await new AccountLogins(deps()).start('claude')).toMatchObject({ phase: 'failed', reason: 'no_token' })
    script('claude', `echo boom; exit 3`)
    expect(await new AccountLogins(deps()).start('claude')).toMatchObject({ phase: 'failed', reason: 'cli_failed' })
    expect(fs.readdirSync(tmpRoot)).toEqual([])
  })

  it('times out, kills the CLI and cleans up', async () => {
    script('claude', `echo "https://claude.ai/oauth/authorize?x"; sleep 30`)
    const s = await new AccountLogins(deps({ timeoutMs: 300 })).start('claude')
    expect(s).toMatchObject({ phase: 'failed', reason: 'timeout' })
    expect(fs.readdirSync(tmpRoot)).toEqual([])
  })

  it('Cancel stops it', async () => {
    script('claude', `echo "https://claude.ai/oauth/authorize?x"; sleep 30`)
    const logins = new AccountLogins(deps())
    const p = logins.start('claude')
    await new Promise((r) => setTimeout(r, 200))
    expect(logins.current()).toBe('claude')
    logins.cancel()
    expect(await p).toMatchObject({ phase: 'canceled' })
    expect(logins.current()).toBeNull()
    expect(uploads).toEqual([])
  })

  it('a rejected upload is reported plainly, without the token', async () => {
    script('claude', `printf '${TOKEN}\\n'`)
    const s = await new AccountLogins(deps({ upload: async () => Promise.reject(new Error('payload too large')) })).start('claude')
    expect(s).toMatchObject({ phase: 'failed', reason: 'upload_failed' })
    expect(JSON.stringify(reports)).not.toContain(TOKEN)
  })
})

describe('Sign in with ChatGPT', () => {
  it('runs codex login in a 0700 CODEX_HOME with file storage and uploads auth.json, then deletes it', async () => {
    const seen = path.join(bin, 'seen.txt')
    script(
      'codex',
      `stat -f '%Lp' "$CODEX_HOME" > ${seen}; cat "$CODEX_HOME/config.toml" >> ${seen}; echo "ARGS=$*" >> ${seen}
echo "Starting local login server on http://localhost:1455."
echo "If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?client_id=x"
printf '{"tokens":{"refresh_token":"rt-SECRET"}}' > "$CODEX_HOME/auth.json"
echo "Successfully logged in"`
    )
    const s = await new AccountLogins(deps()).start('codex')
    expect(s).toMatchObject({ adapter: 'codex', phase: 'done' })
    expect(uploads).toEqual([{ adapter: 'codex', kind: 'codex_auth_json', value: '{"tokens":{"refresh_token":"rt-SECRET"}}' }])
    expect(fs.readFileSync(seen, 'utf8')).toBe('700\ncli_auth_credentials_store = "file"\nARGS=login\n')
    expect(reports.find((r) => r.phase === 'waiting')?.browserUrl).toBe('https://auth.openai.com/oauth/authorize?client_id=x')
    expect(fs.readdirSync(tmpRoot)).toEqual([])
    expect(JSON.stringify(reports)).not.toContain('rt-SECRET')
  })

  it('a busy port 1455 says to close other Codex sign-ins (real socket)', async () => {
    script('codex', 'exit 0')
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as net.AddressInfo).port
    const { portIsBusy } = await import('../logins')
    expect(await portIsBusy(port)).toBe(true)
    srv.close()
    const s = await new AccountLogins(deps({ portBusy: async () => true })).start('codex')
    expect(s).toMatchObject({ phase: 'failed', reason: 'port_busy', message: 'Close other Codex sign-ins and try again.' })
  })

  it('a failed sign-in and a missing auth.json fail plainly; a missing codex offers the API key', async () => {
    expect(await new AccountLogins(deps()).start('codex')).toMatchObject({ reason: 'missing_cli', installHint: 'npm install -g @openai/codex' })
    script('codex', 'exit 1')
    expect(await new AccountLogins(deps()).start('codex')).toMatchObject({ reason: 'cli_failed' })
    script('codex', 'exit 0')
    expect(await new AccountLogins(deps()).start('codex')).toMatchObject({ reason: 'no_token' })
    expect(uploads).toEqual([])
  })
})

describe('pure helpers', () => {
  it('stripAnsi and signInUrl', () => {
    expect(stripAnsi('\x1b[1;32mhi\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07')).toBe('hi link')
    expect(signInUrl('go to https://claude.ai/oauth?x=1). then')).toBe('https://claude.ai/oauth?x=1')
    expect(signInUrl(`https://example.com/${TOKEN}`)).toBeNull()
  })
})

describe('pty chunk boundaries (QA)', () => {
  /** A spawner that replays fixed chunks, with a tick between each, then exits. */
  const chunked =
    (chunks: string[], code = 0): LoginSpawner =>
    () => {
      let data: (c: string) => void = () => undefined
      let exit: (c: number | null) => void = () => undefined
      setTimeout(async () => {
        for (const c of chunks) {
          data(c)
          await new Promise((r) => setTimeout(r, 5))
        }
        exit(code)
      }, 5)
      return { onData: (cb) => void (data = cb), onExit: (cb) => void (exit = cb), kill: () => undefined }
    }

  it('a token split across two chunks is captured whole, never truncated', async () => {
    script('claude', 'exit 0')
    const half = TOKEN.length - 10
    const s = await new AccountLogins(deps({ spawn: chunked(['Your OAuth token:\n\x1b[32m', TOKEN.slice(0, half), `${TOKEN.slice(half)}\x1b[39m\n`, 'Store this token securely.\n']) })).start('claude')
    expect(s).toMatchObject({ phase: 'done' })
    expect(uploads).toEqual([{ adapter: 'claude', kind: 'claude_oauth_token', value: TOKEN }])
  })

  it('an ANSI escape split across chunks does not end up in the token', async () => {
    script('claude', 'exit 0')
    await new AccountLogins(deps({ spawn: chunked([`${TOKEN}\x1b[3`, '9m\n']) })).start('claude')
    expect(uploads.map((u) => u.value)).toEqual([TOKEN])
  })

  it('a token in the very last bytes before exit (no newline) is still taken', async () => {
    script('claude', 'exit 0')
    await new AccountLogins(deps({ spawn: chunked(['token: ', TOKEN]) })).start('claude')
    expect(uploads.map((u) => u.value)).toEqual([TOKEN])
  })

  it('a sign-in URL split across chunks is reported whole', async () => {
    script('claude', 'exit 0')
    await new AccountLogins(deps({ spawn: chunked(['Opening https://claude.ai/oauth/auth', 'orize?code=true&state=abc\n', `${TOKEN}\n`]) })).start('claude')
    expect(reports.find((r) => r.phase === 'waiting')?.browserUrl).toBe('https://claude.ai/oauth/authorize?code=true&state=abc')
  })
})
