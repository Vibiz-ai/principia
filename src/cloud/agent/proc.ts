/** One-shot child processes for the runtime's own work (logins, version checks, git): process group, timeout, stdin. */
import { spawn } from 'node:child_process'

export interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** spawn failed (ENOENT…) */
  error: string | null
}

export interface CaptureOptions {
  env: Record<string, string>
  cwd?: string
  /** written to stdin, then stdin is closed (secrets go here, never in argv) */
  stdin?: string
  timeoutMs?: number
  maxBytes?: number
  /** start as this user (agent work such as git for the company's repos, CLOUD.md §7.8) */
  user?: { uid: number; gid: number } | null
}

/** Runs `file args`, never through a shell. SIGTERM to the group on timeout, SIGKILL 3 s later. Never throws. */
export function capture(file: string, args: string[], o: CaptureOptions): Promise<CaptureResult> {
  const max = o.maxBytes ?? 1_000_000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const done = (r: Omit<CaptureResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killer)
      resolve({ ...r, stdout, stderr, timedOut })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(o.user ? { uid: o.user.uid, gid: o.user.gid } : {}) })
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: e instanceof Error ? e.message : String(e) })
    }
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* gone */
        }
      }
    }
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      killer = setTimeout(() => kill('SIGKILL'), 3000)
    }, o.timeoutMs ?? 60_000)
    child.stdout!.on('data', (c: Buffer) => {
      if (stdout.length < max) stdout += c.toString('utf8')
    })
    child.stderr!.on('data', (c: Buffer) => {
      if (stderr.length < max) stderr += c.toString('utf8')
    })
    child.stdin!.on('error', () => {})
    if (o.stdin !== undefined) child.stdin!.end(o.stdin)
    else child.stdin!.end()
    child.on('error', (e) => done({ code: null, error: e.message }))
    child.on('close', (code) => done({ code, error: null }))
  })
}
