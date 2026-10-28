/**
 * PR-30: sign this Mac's Claude Code in from Principia, for people who never open Terminal. A Claude Desktop or
 * claude.ai sign-in doesn't sign in Claude Code, so Settings and setup offer "Sign in to Claude": it runs
 * `claude auth login --claudeai` with the user's own env (their real ~/.claude, unlike the cloud's setup-token flow).
 * The CLI opens the browser on claude.com and finishes by itself when the user approves (a localhost callback). If
 * the browser didn't open, the page the CLI prints shows a code instead; it goes to the CLI's stdin.
 *
 * No token passes through here: the CLI stores its own sign-in. One sign-in at a time, ten-minute timeout, Cancel
 * kills the CLI. Pure logic plus a spawn seam (tests use fake processes).
 */
import { signInUrl, stripAnsi } from './cloud/logins'
import { SIGN_IN_CODE_RE, type ClaudeSignInStatus } from '../shared/providerAuth'

export const CLAUDE_SIGN_IN_TIMEOUT_MS = 10 * 60_000
export const CLAUDE_SIGN_IN_ARGS = ['auth', 'login', '--claudeai']

export interface SignInProc {
  onOutput(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  write(text: string): void
  kill(): void
}
export type SignInSpawner = (file: string, args: string[]) => SignInProc


interface Active {
  proc: SignInProc
  url: string | null
  started: Promise<ClaudeSignInStatus>
  finished: Promise<ClaudeSignInStatus>
  finish: (s: ClaudeSignInStatus) => void
}

export class ClaudeSignIn {
  private active: Active | null = null
  constructor(private d: { spawn: SignInSpawner; bin: () => Promise<string | null>; timeoutMs?: number; urlWaitMs?: number }) {}

  running(): boolean {
    return !!this.active
  }

  /** Starts the CLI and resolves once it is waiting on the browser (or ended early). A second start cancels the first. */
  async start(): Promise<ClaudeSignInStatus> {
    if (this.active) this.cancel()
    const bin = await this.d.bin()
    if (!bin) return { phase: 'failed', url: null, message: 'Claude Code isn’t installed on this Mac yet.' }
    let proc: SignInProc
    try {
      proc = this.d.spawn(bin, CLAUDE_SIGN_IN_ARGS)
    } catch {
      return { phase: 'failed', url: null, message: 'Claude Code didn’t start. Try again.' }
    }
    let raw = ''
    let settle: (s: ClaudeSignInStatus) => void = () => undefined
    let markStarted: (s: ClaudeSignInStatus) => void = () => undefined
    const finished = new Promise<ClaudeSignInStatus>((r) => (settle = r))
    const started = new Promise<ClaudeSignInStatus>((r) => (markStarted = r))
    let done = false
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* gone */
      }
      finish({ phase: 'failed', url: null, message: 'Nothing came back from claude.com after 10 minutes. Try again.' })
    }, this.d.timeoutMs ?? CLAUDE_SIGN_IN_TIMEOUT_MS)
    // the CLI prints its fallback URL right away; don't keep the button waiting if a version prints none
    const urlTimer = setTimeout(() => markStarted({ phase: 'started', url: null, message: null }), this.d.urlWaitMs ?? 4000)
    const finish = (s: ClaudeSignInStatus): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(urlTimer)
      if (this.active === active) this.active = null
      markStarted(s)
      settle(s)
    }
    const active: Active = { proc, url: null, started, finished, finish }
    this.active = active
    proc.onOutput((chunk) => {
      raw = (raw + chunk).slice(-16_384)
      if (active.url) return
      const clean = stripAnsi(raw)
      const url = signInUrl(clean)
      // only take the URL once its line is complete, so a chunk boundary never cuts it
      if (url && /\s/.test(clean.slice(clean.indexOf(url) + url.length))) {
        active.url = url
        clearTimeout(urlTimer)
        markStarted({ phase: 'started', url, message: null })
      }
    })
    proc.onExit((code) =>
      finish(code === 0 ? { phase: 'done', url: null, message: null } : { phase: 'failed', url: null, message: 'The sign-in didn’t finish. Try again.' })
    )
    return started
  }

  /** Resolves with the final status of the running sign-in (or 'canceled' when none runs). */
  wait(): Promise<ClaudeSignInStatus> {
    return this.active?.finished ?? Promise.resolve({ phase: 'canceled', url: null, message: null })
  }

  /** The code the sign-in page shows when the browser callback can't reach this Mac. */
  submitCode(code: string): boolean {
    const c = code.trim()
    if (!this.active || !SIGN_IN_CODE_RE.test(c)) return false
    this.active.proc.write(`${c}\n`)
    return true
  }

  cancel(): void {
    const a = this.active
    if (!a) return
    try {
      a.proc.kill()
    } catch {
      /* gone */
    }
    a.finish({ phase: 'canceled', url: null, message: null })
  }
}
