import { spawn } from 'node:child_process'
import type { ProcessReaper, ReaperRow } from '../../shared/engine'

/**
 * Headless child process: stdin = /dev/null (never waits for a human) unless `stdin: 'pipe'` (claude's stream-json
 * control protocol, LIVE.md §3.1), own process group (detached) so cancel/timeout kill the whole tree, optional
 * timeout that can be paused while the step waits on the user (LIVE.md §4.4). SPEC A8, CONTRACT 5.4.
 */
export interface ProcOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  onStdout(chunk: string): void
  onStderr(chunk: string): void
  /** 'pipe' keeps stdin open for write()/end(). Default 'ignore'. */
  stdin?: 'ignore' | 'pipe'
  /**
   * Spawn tagging + reaper (CONTRACT §13). The env must already carry reaper.tag(spawnId). When the process ends, is
   * killed or times out, its whole tree is reaped (group, descendants, env-tagged escapees). A leader that exited while
   * an escaped child still holds its stdout/stderr gets that tree reaped after `PIPE_GRACE_MS`, so the step ends.
   */
  reap?: { spawnId: string; reaper: ProcessReaper }
}
export interface ProcResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  killed: boolean
  spawnError: string | null
}
export interface ProcHandle {
  pid: number | null
  done: Promise<ProcResult>
  /** SIGTERM the process group, SIGKILL after `graceMs`. Resolves when the child exited. */
  kill(graceMs?: number): Promise<void>
  /** Write to stdin (stdin: 'pipe'). false when stdin is closed or not piped. Never throws. */
  write(data: string): boolean
  /** Close stdin. Idempotent. */
  end(): void
  /** Stop the timeout clock, keeping the remaining ms. Idempotent. */
  pauseTimeout(): void
  /** Restart the timeout clock with the remaining ms. Idempotent. */
  resumeTimeout(): void
}

const KILL_GRACE_MS = 3000
/** Leader exited but something still holds its pipes: reap the tree after this long so 'close' can fire. */
export const PIPE_GRACE_MS = 1500
/** Pre-kill tree snapshot budget: never let a slow `ps` delay a cancel. */
const COLLECT_BUDGET_MS = 2000

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      /* already gone */
    }
  }
}

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    /* already gone */
  }
}

/** Registry of every live child, for engine.shutdown(). */
export const liveProcs = new Set<ProcHandle>()

export function startProcess(o: ProcOptions): ProcHandle {
  let killed = false
  let timedOut = false
  let exited = false
  const child = spawn(o.file, o.args, {
    cwd: o.cwd,
    env: o.env,
    stdio: [o.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true
  })
  let stdinOpen = o.stdin === 'pipe' && !!child.stdin
  // EPIPE when the child exits before reading everything: harmless
  child.stdin?.on('error', () => {
    stdinOpen = false
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => o.onStdout(c))
  child.stderr?.on('data', (c: string) => o.onStderr(c))

  // ---------- reaper (CONTRACT §13) ----------
  const reap = o.reap && child.pid ? o.reap : null
  if (reap) reap.reaper.register(reap.spawnId, child.pid)
  let reapChain: Promise<unknown> = Promise.resolve()
  const reapTree = (pre?: ReaperRow[]): Promise<void> => {
    if (!reap || child.pid === undefined) return Promise.resolve()
    const pid = child.pid
    reapChain = reapChain.then(() => reap.reaper.reap(reap.spawnId, { rootPids: [pid], pre }).catch(() => 0))
    return reapChain.then(() => undefined)
  }
  let closed = false
  child.on('exit', () => {
    if (!reap) return
    // an escaped child (dev server, `cmd &` holding stdout) keeps the pipes open: reap so the step can end
    const t = setTimeout(() => {
      if (!closed) void reapTree()
    }, PIPE_GRACE_MS)
    t.unref?.()
  })

  let killTimer: NodeJS.Timeout | null = null
  const done = new Promise<ProcResult>((resolve) => {
    let spawnError: string | null = null
    child.on('error', (e) => {
      spawnError = e.message
      if (child.pid === undefined) {
        exited = true
        resolve({ exitCode: null, signal: null, timedOut, killed, spawnError })
      }
    })
    child.on('close', (code, signal) => {
      exited = true
      closed = true
      if (killTimer) clearTimeout(killTimer)
      // the owner ended: its whole tree goes (background; kill() awaits it)
      if (reap && !killed) void reapTree()
      resolve({ exitCode: code, signal, timedOut, killed, spawnError })
    })
  })

  const kill = async (graceMs = KILL_GRACE_MS): Promise<void> => {
    if (exited || child.pid === undefined) {
      await done
      return reapTree()
    }
    killed = true
    // collect the tree while the leader still holds its children (they are re-parented once it dies)
    let pre: ReaperRow[] = []
    if (reap) {
      pre = await Promise.race([
        reap.reaper.collect(reap.spawnId, [child.pid]).catch(() => [] as ReaperRow[]),
        new Promise<ReaperRow[]>((r) => setTimeout(() => r([]), COLLECT_BUDGET_MS))
      ])
      for (const r of pre) if (r.pid !== child.pid && r.pid > 1) signalPid(r.pid, 'SIGTERM')
    }
    signalGroup(child.pid, 'SIGTERM')
    if (!killTimer) killTimer = setTimeout(() => child.pid !== undefined && signalGroup(child.pid, 'SIGKILL'), graceMs)
    await done
    // the leader exited; make sure nothing in its group survives
    signalGroup(child.pid, 'SIGKILL')
    await reapTree(pre)
  }

  // pausable timeout: `remaining` ms left when paused, `deadline` while running
  let timer: NodeJS.Timeout | null = null
  let remaining = o.timeoutMs > 0 ? o.timeoutMs : 0
  let deadline = 0
  const arm = (ms: number): void => {
    deadline = Date.now() + ms
    timer = setTimeout(() => {
      timer = null
      timedOut = true
      void kill()
    }, ms)
  }
  if (remaining > 0) arm(remaining)

  const write = (data: string): boolean => {
    if (!stdinOpen || exited || !child.stdin || child.stdin.destroyed) return false
    try {
      return child.stdin.write(data) || true
    } catch {
      stdinOpen = false
      return false
    }
  }
  const end = (): void => {
    if (!stdinOpen) return
    stdinOpen = false
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
  }
  const pauseTimeout = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
    remaining = Math.max(1, deadline - Date.now())
  }
  const resumeTimeout = (): void => {
    if (timer || exited || remaining <= 0 || timedOut) return
    arm(remaining)
  }

  const handle: ProcHandle = { pid: child.pid ?? null, done, kill, write, end, pauseTimeout, resumeTimeout }
  liveProcs.add(handle)
  void done.then(() => {
    if (timer) clearTimeout(timer)
    timer = null
    stdinOpen = false
    liveProcs.delete(handle)
  })
  return handle
}

/** Small helper for detection: run, collect stdout, hard timeout. Never throws. */
export async function capture(
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 5000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  try {
    const h = startProcess({
      file,
      args,
      cwd: process.cwd(),
      env,
      timeoutMs,
      onStdout: (c) => (stdout += c),
      onStderr: (c) => (stderr += c)
    })
    const r = await h.done
    return { code: r.exitCode, stdout, stderr }
  } catch (e) {
    return { code: null, stdout, stderr: e instanceof Error ? e.message : String(e) }
  }
}
