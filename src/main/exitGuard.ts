/**
 * Every exit of the main process (app.exit, the SIGTERM fallback, requestQuit's forced exit) goes through here.
 *
 * Order: live ptys are killed and their exit callbacks delivered first (exiting with a live node-pty aborts the process:
 * "libc++abi: terminating due to uncaught exception of type Napi::Error", which macOS reports as "Hive quit
 * unexpectedly"), then the reaper kills what this Hive tagged (CONTRACT §13), then Electron's own app.exit.
 *
 * Electron's app.exit is not a guarantee: it destroys the windows and stops the message loop, and the process can
 * still hang in teardown. So every exit also arms a hard kill of the process itself, the last resort.
 */

export interface ExitSessions {
  runningCount(): number
  shutdown(): Promise<void>
  /** sync SIGKILL of every live process group */
  killAllNow(): number
}

export interface ExitGuardDeps {
  sessions: () => ExitSessions | null | undefined
  /** CONTRACT §13: kill everything this Hive tagged (sync, best effort) */
  reap: () => void
  /** Electron's original app.exit */
  realExit: (code: number) => void
  /** the process is still alive this long after realExit: kill it (default: SIGKILL to itself) */
  hardKill?: (code: number) => void
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }
}

/** sessions.shutdown gets this long before every pty group is SIGKILLed */
export const EXIT_SESSIONS_GRACE_MS = 2500
/** after the SIGKILL, time for node-pty to deliver the exit callbacks */
export const EXIT_AFTER_KILL_MS = 300
/** realExit ran and the process is still here this long after: hard kill */
export const HARD_EXIT_MS = 2000

// SIGKILL, not process.exit: process.exit runs the same native teardown that may be what hangs. By now every pty was
// killed (or got its grace period), so nothing is left that needs a clean exit.
const defaultHardKill = (): void => {
  process.kill(process.pid, 'SIGKILL')
}

export function createGuardedExit(d: ExitGuardDeps): (code?: number) => void {
  const t = d.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (x) => clearTimeout(x as NodeJS.Timeout) }
  const hardKill = d.hardKill ?? defaultHardKill
  let exiting = false
  let hardArmed = false
  let exited = false

  const reap = (): void => {
    try {
      d.reap()
    } catch {
      /* best effort */
    }
  }
  /** Electron's exit, with the hard kill armed first so a hang (or a throw) in it cannot keep the process alive. */
  const finalExit = (code: number): void => {
    if (!hardArmed) {
      hardArmed = true
      t.setTimeout(() => {
        d.log?.warn('process still alive after exit; killing it', { code })
        hardKill(code)
      }, HARD_EXIT_MS)
    }
    if (exited) return
    exited = true
    reap()
    try {
      d.realExit(code)
    } catch (e) {
      d.log?.warn('app.exit threw; killing the process', { e: String(e) })
      hardKill(code)
    }
  }

  return (code = 0): void => {
    let sessions: ExitSessions | null | undefined = null
    let running = 0
    try {
      sessions = d.sessions()
      running = sessions?.runningCount() ?? 0
    } catch {
      /* treat as nothing running */
    }
    // a second exit while the first waits on ptys exits now (the caller wants out)
    if (exiting || !sessions || running === 0) {
      exiting = true
      return finalExit(code)
    }
    exiting = true
    const live = sessions
    const fallback = t.setTimeout(() => {
      try {
        live.killAllNow()
      } catch {
        /* best effort: exit anyway */
      }
      t.setTimeout(() => finalExit(code), EXIT_AFTER_KILL_MS)
    }, EXIT_SESSIONS_GRACE_MS)
    let shut: Promise<void>
    try {
      shut = live.shutdown()
    } catch (e) {
      shut = Promise.reject(e)
    }
    void shut
      .catch(() => undefined)
      .finally(() => {
        t.clearTimeout(fallback)
        finalExit(code)
      })
  }
}
