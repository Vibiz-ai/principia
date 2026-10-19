/**
 * LiveBridge (docs/LIVE.md §5): per-owner live dirs under <userData>/live/<ownerId>/ (0700), events.jsonl tailing and
 * atomic answer files. Strictly local: files only, no listeners. No Electron imports (testable in Node).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { LiveBridge, LiveChannel, LiveOwner } from '../../shared/engine'
import { JsonlTailer } from './tailer'

export interface LiveBridgeDeps {
  userData: string
  /** process.execPath (the Hive binary, run with ELECTRON_RUN_AS_NODE=1). */
  execPath: string
  /** Absolute path of out/main/hive-hook.js. */
  hookScript: string
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
  pollMs?: number
  /**
   * AUTHORING.md §1.2: `hive` server mailbox lines (`{hive:'author_call'|'author_cancelled'}`) are intercepted here and
   * never reach the channel callbacks (engine / SessionLive). The caller's identity is the channel's owner only.
   */
  onAuthor?(owner: LiveOwner, line: { hive: 'author_call' | 'author_cancelled'; [k: string]: unknown }, writeAnswer: (callId: string, payload: unknown) => void): void
}

const isAuthorLine = (l: unknown): l is { hive: 'author_call' | 'author_cancelled'; [k: string]: unknown } =>
  !!l && typeof l === 'object' && ((l as { hive?: unknown }).hive === 'author_call' || (l as { hive?: unknown }).hive === 'author_cancelled')

const GATE_ID = /^[A-Za-z0-9_.-]{1,128}$/

/** POSIX single-quote a path for a `sh -c` command line (userData contains a space). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function liveRoot(userData: string): string {
  return path.join(userData, 'live')
}

/** Boot: remove every live dir left by a previous Hive process. */
export function sweepLiveDirs(userData: string): number {
  const root = liveRoot(userData)
  let n = 0
  try {
    for (const f of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, f), { recursive: true, force: true })
      n++
    }
  } catch {
    /* no live dir yet */
  }
  return n
}

export function hookCommandFor(execPath: string, hookScript: string, dir: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shQuote(execPath)} ${shQuote(hookScript)} --events ${shQuote(path.join(dir, 'events.jsonl'))} --dir ${shQuote(dir)}`
}

/** Path of the bundled hook script next to the main bundle; asar-unpacked copy preferred when it exists. */
export function resolveHookScript(mainDir: string): string {
  const p = path.join(mainDir, 'hive-hook.js')
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p
}

export function createLiveBridge(deps: LiveBridgeDeps): LiveBridge & { openChannels(): number } {
  const open = new Map<string, LiveChannel>()
  return {
    openChannels: () => open.size,
    open(owner: LiveOwner): LiveChannel {
      const ownerId = 'sessionId' in owner ? owner.sessionId : owner.stepId
      if (!/^[a-z]+_[0-9a-z]+$/.test(ownerId)) throw new Error(`bad live owner id ${ownerId}`)
      open.get(ownerId)?.close()
      const root = liveRoot(deps.userData)
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      const dir = path.join(root, ownerId)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(path.join(dir, 'answers'), { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(root, 0o700)
        fs.chmodSync(dir, 0o700)
      } catch {
        /* best effort */
      }
      const events = path.join(dir, 'events.jsonl')
      fs.writeFileSync(events, '', { mode: 0o600 })
      const cbs: ((line: unknown) => void)[] = []
      const queued: unknown[] = []
      // eslint-disable-next-line prefer-const
      let ch: LiveChannel
      const tailer = new JsonlTailer(events, {
        pollMs: deps.pollMs,
        onLine: (line) => {
          if (isAuthorLine(line)) {
            if (!deps.onAuthor) {
              const id = (line as { call_id?: unknown }).call_id
              if (line.hive === 'author_call' && typeof id === 'string' && GATE_ID.test(id)) ch.writeAnswer(id, { ok: false, error: 'Hive authoring is not available' })
              return
            }
            try {
              deps.onAuthor(owner, line, (callId, payload) => ch.writeAnswer(callId, payload))
            } catch (e) {
              deps.log?.warn('live: author line failed', { ownerId, e: String(e) })
            }
            return
          }
          if (!cbs.length) {
            if (queued.length < 1000) queued.push(line)
            return
          }
          for (const cb of cbs) cb(line)
        },
        onBadLine: (t) => deps.log?.warn('live: dropped a non-JSON line', { ownerId, line: t.slice(0, 80) })
      })
      tailer.start()
      let closed = false
      ch = {
        dir,
        hookCommand: hookCommandFor(deps.execPath, deps.hookScript, dir),
        mcpEnv: { HIVE_LIVE_DIR: dir },
        onLine(cb) {
          cbs.push(cb)
          for (const l of queued.splice(0)) cb(l)
        },
        writeAnswer(gateId, payload) {
          if (closed) return
          if (!GATE_ID.test(gateId)) throw new Error(`bad gate id ${gateId}`)
          const ans = path.join(dir, 'answers')
          fs.mkdirSync(ans, { recursive: true, mode: 0o700 })
          const file = path.join(ans, `${gateId}.json`)
          const tmp = `${file}.tmp`
          fs.writeFileSync(tmp, JSON.stringify(payload ?? null), { mode: 0o600 })
          fs.renameSync(tmp, file)
        },
        close() {
          if (closed) return
          closed = true
          tailer.close()
          if (open.get(ownerId) === ch) open.delete(ownerId)
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {
            /* best effort; swept at boot */
          }
        }
      }
      open.set(ownerId, ch)
      return ch
    }
  }
}
