import { describe, expect, it } from 'vitest'
import { CLAUDE_SIGN_IN_ARGS, ClaudeSignIn, type SignInProc } from '../claudeSignIn'

/** A fake `claude auth login`: the test drives its output and exit. */
function fakeProc(): SignInProc & { out(s: string): void; exit(code: number | null): void; written: string[]; killed: boolean } {
  let onOut: (s: string) => void = () => undefined
  let onExit: (c: number | null) => void = () => undefined
  const p = {
    written: [] as string[],
    killed: false,
    onOutput: (cb: (s: string) => void) => void (onOut = cb),
    onExit: (cb: (c: number | null) => void) => void (onExit = cb),
    write: (t: string) => void p.written.push(t),
    kill: () => {
      p.killed = true
    },
    out: (s: string) => onOut(s),
    exit: (c: number | null) => onExit(c)
  }
  return p
}

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y'

function setup(opts: { bin?: string | null; timeoutMs?: number; urlWaitMs?: number } = {}) {
  const procs: ReturnType<typeof fakeProc>[] = []
  const calls: { file: string; args: string[] }[] = []
  const s = new ClaudeSignIn({
    bin: async () => (opts.bin === undefined ? '/u/.local/bin/claude' : opts.bin),
    spawn: (file, args) => {
      calls.push({ file, args })
      const p = fakeProc()
      procs.push(p)
      return p
    },
    timeoutMs: opts.timeoutMs,
    urlWaitMs: opts.urlWaitMs ?? 50
  })
  return { s, procs, calls }
}

describe('Claude sign-in from Principia (PR-30)', () => {
  it('runs claude auth login on the subscription and reports the fallback page once the CLI prints it', async () => {
    const { s, procs, calls } = setup()
    const started = s.start()
    await Promise.resolve()
    await Promise.resolve()
    procs[0].out('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/auth')
    procs[0].out(`orize?code=true&client_id=x&state=y\nPaste code here if prompted > `)
    expect(await started).toEqual({ phase: 'started', url: URL, message: null })
    expect(calls).toEqual([{ file: '/u/.local/bin/claude', args: CLAUDE_SIGN_IN_ARGS }])
    expect(CLAUDE_SIGN_IN_ARGS).toEqual(['auth', 'login', '--claudeai'])
    const wait = s.wait()
    procs[0].exit(0)
    expect(await wait).toEqual({ phase: 'done', url: null, message: null })
    expect(s.running()).toBe(false)
  })

  it('does not hold the button when no URL is printed, and a failed exit says so', async () => {
    const { s, procs } = setup({ urlWaitMs: 5 })
    expect(await s.start()).toEqual({ phase: 'started', url: null, message: null })
    const wait = s.wait()
    procs[0].exit(1)
    expect((await wait).phase).toBe('failed')
  })

  it('passes a pasted code to the CLI and refuses junk', async () => {
    const { s, procs } = setup({ urlWaitMs: 5 })
    await s.start()
    expect(s.submitCode('  abcDEF123456#state-xyz_09  ')).toBe(true)
    expect(procs[0].written).toEqual(['abcDEF123456#state-xyz_09\n'])
    expect(s.submitCode('rm -rf ~; echo')).toBe(false)
    expect(s.submitCode('short')).toBe(false)
    expect(procs[0].written).toHaveLength(1)
  })

  it('cancel kills the CLI; a second start replaces the first', async () => {
    const { s, procs } = setup({ urlWaitMs: 5 })
    await s.start()
    const first = s.wait()
    await s.start()
    expect(procs[0].killed).toBe(true)
    expect((await first).phase).toBe('canceled')
    const second = s.wait()
    s.cancel()
    expect(procs[1].killed).toBe(true)
    expect((await second).phase).toBe('canceled')
    expect(s.submitCode('abcdefgh1234')).toBe(false)
  })

  it('fails plainly without Claude Code, and times out', async () => {
    expect((await setup({ bin: null }).s.start()).phase).toBe('failed')
    const { s, procs } = setup({ timeoutMs: 20, urlWaitMs: 5 })
    await s.start()
    const r = await s.wait()
    expect(r.phase).toBe('failed')
    expect(r.message).toMatch(/10 minutes/)
    expect(procs[0].killed).toBe(true)
  })
})
