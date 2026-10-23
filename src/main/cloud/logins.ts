/**
 * Principia Cloud: link Claude and Codex accounts from this Mac, in the browser, with one click (docs/CLOUD.md §7.2).
 *
 * - Connect Claude: `claude setup-token` in a pty whose HOME and CLAUDE_CONFIG_DIR are a fresh temp dir, so the Mac's
 *   own Claude login is untouched. The CLI opens the browser; the output (ANSI stripped) is scanned for the token,
 *   which goes straight to PUT /v1/providers/claude/credential, then Test runs and the temp dir is deleted.
 * - Sign in with ChatGPT: `codex login` with CODEX_HOME set to a 0700 temp dir and file credential storage. On exit 0
 *   its auth.json is uploaded as `codex_auth_json`: a sign-in separate from the Mac's own ~/.codex.
 *
 * A token or auth.json never reaches the renderer, a log line, an event or the clipboard: status updates carry plain
 * copy only. Ten-minute timeout, Cancel kills the CLI. Pure logic plus a spawn seam (tests use fake CLIs).
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ProviderCredentialKind, ProviderTestResponse } from '../../shared/cloud'
import type { CloudLoginAdapter, CloudLoginStatus } from '../../shared/types'

export const LOGIN_TIMEOUT_MS = 10 * 60_000
export const CODEX_CALLBACK_PORT = 1455
export const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/
export const INSTALL_HINT: Record<CloudLoginAdapter, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex'
}

export interface LoginProc {
  onData(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}
export type LoginSpawner = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => LoginProc

export interface LoginDeps {
  spawn: LoginSpawner
  /** the login-shell environment (PATH included) */
  env(): Record<string, string>
  /** absolute path of the CLI on that PATH, or null */
  resolveBin(name: CloudLoginAdapter, env: Record<string, string>): string | null
  upload(adapter: CloudLoginAdapter, kind: ProviderCredentialKind, value: string): Promise<void>
  test(adapter: CloudLoginAdapter): Promise<ProviderTestResponse>
  report(status: CloudLoginStatus): void
  tmpRoot?: string
  timeoutMs?: number
  /** true when 127.0.0.1:port cannot be bound (another Codex sign-in is waiting there) */
  portBusy?(port: number): Promise<boolean>
}

// CSI, OSC (BEL or ST terminated) and two-character escapes
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')

/** The first https URL in CLI output (the sign-in page), without trailing punctuation. Never a token. */
export function signInUrl(text: string): string | null {
  const m = text.match(/https:\/\/[^\s"'<>]+/)
  if (!m) return null
  const url = m[0].replace(/[).,;]+$/, '')
  return CLAUDE_TOKEN_RE.test(url) ? null : url
}

/** Output up to (and including) its last whitespace: everything after it may still be growing. */
export function settledText(text: string): string {
  const i = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'), text.lastIndexOf(' '), text.lastIndexOf('\t'))
  return i < 0 ? '' : text.slice(0, i + 1)
}

export function portIsBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
}

/** Env for a sign-in CLI: the login PATH, nothing that would pick an account for it. */
function cleanEnv(base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|ELECTRON_)/.test(k) || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  return env
}

const status = (adapter: CloudLoginAdapter, phase: CloudLoginStatus['phase'], p: Partial<CloudLoginStatus> = {}): CloudLoginStatus => ({
  adapter,
  phase,
  message: null,
  reason: null,
  installHint: null,
  browserUrl: null,
  ...p
})

interface Active {
  adapter: CloudLoginAdapter
  proc: LoginProc | null
  canceled: boolean
  finish: (s: CloudLoginStatus) => void
}

export class AccountLogins {
  private active: Active | null = null
  constructor(private d: LoginDeps) {}

  current(): CloudLoginAdapter | null {
    return this.active?.adapter ?? null
  }

  cancel(): void {
    const a = this.active
    if (!a) return
    a.canceled = true
    try {
      a.proc?.kill()
    } catch {
      /* already gone */
    }
    a.finish(status(a.adapter, 'canceled', { message: 'Canceled.' }))
  }

  /**
   * Starts a sign-in and resolves with its final status (done, failed or canceled). Progress goes to `report`.
   * One at a time: a second start cancels the first.
   */
  start(adapter: CloudLoginAdapter): Promise<CloudLoginStatus> {
    if (this.active) this.cancel()
    return adapter === 'claude' ? this.claude() : this.codex()
  }

  private tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(this.d.tmpRoot ?? os.tmpdir(), prefix))
    fs.chmodSync(dir, 0o700)
    return dir
  }

  /** The shared run loop: spawn, scan output, time out, cancel, clean up. `onOutput` returns a value to finish with. */
  private run<T>(
    adapter: CloudLoginAdapter,
    file: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    scan: (clean: string) => T | null
  ): Promise<{ kind: 'found'; value: T } | { kind: 'exit'; code: number | null; output: string } | { kind: 'timeout' } | { kind: 'canceled' }> {
    return new Promise((resolve) => {
      // raw pty output: ANSI is stripped from the whole buffer, so an escape split across chunks is still removed
      let raw = ''
      let settled = false
      let url: string | null = null
      const done = (r: Parameters<typeof resolve>[0]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.active === active) this.active = null
        resolve(r)
      }
      const active: Active = { adapter, proc: null, canceled: false, finish: () => done({ kind: 'canceled' }) }
      this.active = active
      const timer = setTimeout(() => {
        try {
          active.proc?.kill()
        } catch {
          /* gone */
        }
        done({ kind: 'timeout' })
      }, this.d.timeoutMs ?? LOGIN_TIMEOUT_MS)
      let proc: LoginProc
      try {
        proc = this.d.spawn(file, args, { env, cwd })
      } catch {
        done({ kind: 'exit', code: 127, output: '' })
        return
      }
      active.proc = proc
      proc.onData((chunk) => {
        if (settled) return
        raw = (raw + chunk).slice(-65_536)
        // a pty splits output anywhere: only scan up to the last whitespace, so a token or URL cut in half by a chunk
        // boundary is never taken (the rest arrives in the next chunk, or the exit scan reads the whole output)
        const out = settledText(stripAnsi(raw))
        if (!url) {
          url = signInUrl(out)
          if (url) this.d.report(status(adapter, 'waiting', { message: adapter === 'claude' ? 'Your browser is open on claude.ai. Approve there and come back.' : 'Your browser is open on ChatGPT. Approve there and come back.', browserUrl: url }))
        }
        const v = scan(out)
        if (v !== null) done({ kind: 'found', value: v })
      })
      proc.onExit((code) => {
        // the token may arrive in the last chunk before exit
        const out = stripAnsi(raw)
        const v = scan(out)
        done(v !== null ? { kind: 'found', value: v } : { kind: 'exit', code, output: out })
      })
    })
  }

  private finish(s: CloudLoginStatus): CloudLoginStatus {
    // a flow canceled because another one started stays quiet: the new one owns the row
    if (!(s.phase === 'canceled' && this.active)) this.d.report(s)
    return s
  }

  private async claude(): Promise<CloudLoginStatus> {
    const adapter: CloudLoginAdapter = 'claude'
    const base = cleanEnv(this.d.env())
    const bin = this.d.resolveBin('claude', base)
    if (!bin) return this.finish(status(adapter, 'failed', { reason: 'missing_cli', installHint: INSTALL_HINT.claude, message: 'Install Claude Code on this Mac, or paste a token.' }))
    this.d.report(status(adapter, 'starting', { message: 'Opening claude.ai in your browser…' }))
    const home = this.tmp('principia-claude-')
    try {
      const config = path.join(home, '.claude')
      fs.mkdirSync(config, { mode: 0o700 })
      // a fresh config dir would otherwise start Claude Code's first-run screens before setup-token
      const seed = JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' })
      fs.writeFileSync(path.join(home, '.claude.json'), seed, { mode: 0o600 })
      fs.writeFileSync(path.join(config, '.claude.json'), seed, { mode: 0o600 })
      const env = { ...base, HOME: home, CLAUDE_CONFIG_DIR: config }
      const r = await this.run(adapter, bin, ['setup-token'], env, home, (clean) => clean.match(CLAUDE_TOKEN_RE)?.[0] ?? null)
      if (r.kind === 'canceled') return this.finish(status(adapter, 'canceled', { message: 'Canceled.' }))
      if (r.kind === 'timeout') return this.finish(status(adapter, 'failed', { reason: 'timeout', message: 'Nothing came back after 10 minutes. Try again, or paste a token.' }))
      if (r.kind === 'exit')
        return this.finish(
          status(adapter, 'failed', {
            reason: r.code === 0 ? 'no_token' : 'cli_failed',
            message: r.code === 0 ? "Couldn't read the token from Claude Code. Paste it instead: run claude setup-token in Terminal." : 'Claude Code stopped before it gave a token. Try again, or paste a token.'
          })
        )
      return await this.store(adapter, 'claude_oauth_token', r.value)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  private async codex(): Promise<CloudLoginStatus> {
    const adapter: CloudLoginAdapter = 'codex'
    const base = cleanEnv(this.d.env())
    const bin = this.d.resolveBin('codex', base)
    if (!bin) return this.finish(status(adapter, 'failed', { reason: 'missing_cli', installHint: INSTALL_HINT.codex, message: 'Install Codex on this Mac, or use an API key instead.' }))
    if (await (this.d.portBusy ?? portIsBusy)(CODEX_CALLBACK_PORT)) return this.finish(status(adapter, 'failed', { reason: 'port_busy', message: 'Close other Codex sign-ins and try again.' }))
    this.d.report(status(adapter, 'starting', { message: 'Opening ChatGPT in your browser…' }))
    const home = this.tmp('principia-codex-')
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 })
      const env = { ...base, CODEX_HOME: home }
      const r = await this.run(adapter, bin, ['login'], env, home, () => null)
      if (r.kind === 'canceled') return this.finish(status(adapter, 'canceled', { message: 'Canceled.' }))
      if (r.kind === 'timeout') return this.finish(status(adapter, 'failed', { reason: 'timeout', message: 'Nothing came back after 10 minutes. Try again, or use an API key instead.' }))
      if (r.kind !== 'exit') return this.finish(status(adapter, 'failed', { reason: 'cli_failed', message: 'Codex stopped unexpectedly. Try again.' }))
      if (/address already in use|EADDRINUSE|port 1455/i.test(r.output) && r.code !== 0) return this.finish(status(adapter, 'failed', { reason: 'port_busy', message: 'Close other Codex sign-ins and try again.' }))
      if (r.code !== 0) return this.finish(status(adapter, 'failed', { reason: 'cli_failed', message: 'The ChatGPT sign-in did not finish. Try again, or use an API key instead.' }))
      let auth: string
      try {
        auth = fs.readFileSync(path.join(home, 'auth.json'), 'utf8')
        JSON.parse(auth)
      } catch {
        return this.finish(status(adapter, 'failed', { reason: 'no_token', message: "Codex signed in but didn't save a sign-in file. Try again, or use an API key instead." }))
      }
      return await this.store(adapter, 'codex_auth_json', auth)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  /** Upload, then Test. The value leaves this function only inside the PUT body. */
  private async store(adapter: CloudLoginAdapter, kind: ProviderCredentialKind, value: string): Promise<CloudLoginStatus> {
    this.d.report(status(adapter, 'uploading', { message: 'Sending it to your cloud, encrypted…' }))
    try {
      await this.d.upload(adapter, kind, value)
    } catch (e) {
      return this.finish(status(adapter, 'failed', { reason: 'upload_failed', message: `Your cloud did not take it: ${e instanceof Error ? e.message : String(e)}` }))
    }
    this.d.report(status(adapter, 'testing', { message: 'Testing…' }))
    try {
      const t = await this.d.test(adapter)
      return this.finish(status(adapter, 'done', { message: t.ok ? 'Connected.' : `Saved, but the test failed: ${t.detail}` }))
    } catch (e) {
      return this.finish(status(adapter, 'done', { message: `Saved. The test could not run: ${e instanceof Error ? e.message : String(e)}` }))
    }
  }
}
