/**
 * Hive hook script logic (docs/LIVE.md §5). Pure Node, no dependencies: built into out/main/hive-hook.js via hookMain.ts
 * and run by agent CLIs as `ELECTRON_RUN_AS_NODE=1 '<Hive>' '<hive-hook.js>' --events <f> --dir <d> --provider <id> [--gate]`.
 *
 * 1. read stdin (<= 1 MB), parse JSON;
 * 2. truncate tool_response / tool_input / last_assistant_message / prompt strings to 2 KB;
 * 3. append ONE line `{"v":1,provider,received_at,gate_id?,payload}` to events.jsonl (single appendFileSync);
 * 4. --gate only (headless gemini/cursor, when HOOKS_VERIFIED): wait for answers/<gate_id>.json (watch + 250 ms poll,
 *    <= 3600 s), print it, append `{"hive":"gate_closed","gate_id"}`.
 * Prints only JSON or nothing; exits 0 on any internal error.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { nudgeDecision } from './nudge'

export const STDIN_CAP = 1024 * 1024
export const FIELD_CAP = 2048
export const GATE_WAIT_MS = 3600_000
const TRUNC_FIELDS = ['tool_response', 'tool_input', 'last_assistant_message', 'prompt', 'toolResponse', 'llm_request', 'llm_response']

export interface HookArgs {
  events: string | null
  dir: string | null
  provider: string
  gate: boolean
  /** PROACTIVE.md §4: print this file (SessionStart context) and nothing else */
  context?: string | null
  /** PROACTIVE.md §4: answer a Stop hook with the one-time nudge */
  nudge?: boolean
}

export function parseArgs(argv: string[]): HookArgs {
  const a: HookArgs = { events: null, dir: null, provider: 'unknown', gate: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--context') a.context = argv[++i] ?? null
    else if (k === '--nudge') a.nudge = true
    else if (k === '--events') a.events = argv[++i] ?? null
    else if (k === '--dir') a.dir = argv[++i] ?? null
    else if (k === '--provider') a.provider = argv[++i] ?? 'unknown'
    else if (k === '--gate') a.gate = true
  }
  return a
}

function truncDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > FIELD_CAP ? v.slice(0, FIELD_CAP) + '…' : v
  if (depth > 6 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => truncDeep(x, depth + 1))
  const o: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = truncDeep(x, depth + 1)
  return o
}

/** Truncates the big fields of a hook payload. Non-objects are wrapped as { raw }. */
export function shrinkPayload(p: unknown): unknown {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { raw: typeof p === 'string' ? p.slice(0, FIELD_CAP) : p }
  const o: Record<string, unknown> = { ...(p as Record<string, unknown>) }
  for (const f of TRUNC_FIELDS) if (f in o) o[f] = truncDeep(o[f])
  return o
}

export function buildLine(args: HookArgs, payload: unknown, gateId: string | null, now = new Date()): string {
  return (
    JSON.stringify({
      v: 1,
      provider: args.provider,
      received_at: now.toISOString(),
      ...(gateId ? { gate_id: gateId } : {}),
      payload: shrinkPayload(payload)
    }) + '\n'
  )
}

/** Decision printed when the gate times out: deny in the adapter's own format. */
export function timeoutDecision(provider: string): unknown {
  const msg = 'No answer from the user within 60 min'
  if (provider === 'cursor') return { permission: 'deny', agent_message: msg }
  if (provider === 'gemini') return { decision: 'deny', reason: msg }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: msg } } }
}

export async function readStdin(stream: NodeJS.ReadableStream, idleMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(buf)
    }
    let t = setTimeout(finish, idleMs)
    stream.setEncoding?.('utf8')
    stream.on('data', (c: string | Buffer) => {
      if (buf.length < STDIN_CAP) buf += typeof c === 'string' ? c : c.toString('utf8')
      if (buf.length >= STDIN_CAP) buf = buf.slice(0, STDIN_CAP)
      clearTimeout(t)
      t = setTimeout(finish, idleMs)
    })
    stream.on('end', finish)
    stream.on('error', finish)
  })
}

/** Waits for answers/<gateId>.json; resolves its parsed content, or null on timeout. Deletes the file after reading. */
export function waitForAnswer(dir: string, gateId: string, timeoutMs = GATE_WAIT_MS, pollMs = 250): Promise<unknown | null> {
  const ansDir = path.join(dir, 'answers')
  const file = path.join(ansDir, `${gateId}.json`)
  return new Promise((resolve) => {
    let done = false
    let watcher: fs.FSWatcher | null = null
    const check = () => {
      if (done) return
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return
      }
      let v: unknown = null
      try {
        v = JSON.parse(text)
      } catch {
        return // partially visible? rename is atomic, so this is a bad file: keep waiting
      }
      finish(v)
    }
    const finish = (v: unknown | null) => {
      if (done) return
      done = true
      clearInterval(iv)
      clearTimeout(to)
      watcher?.close()
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    try {
      fs.mkdirSync(ansDir, { recursive: true, mode: 0o700 })
      watcher = fs.watch(ansDir, { persistent: false }, () => check())
    } catch {
      watcher = null
    }
    const iv = setInterval(check, pollMs)
    const to = setTimeout(() => finish(null), timeoutMs)
    check()
  })
}

export async function runHook(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: { write(s: string): unknown }; now?: () => Date; gateWaitMs?: number }
): Promise<number> {
  try {
    const args = parseArgs(argv)
    // PROACTIVE.md §4: SessionStart (resume / compact) prints the Principia rules file as context; nothing is logged
    if (args.context) {
      await readStdin(io.stdin, 500)
      const text = fs.readFileSync(args.context, 'utf8')
      if (text.trim()) io.stdout.write(text)
      return 0
    }
    // PROACTIVE.md §4: the Stop hook's one-time "track it" nudge
    if (args.nudge) {
      const raw = await readStdin(io.stdin, 2000)
      const d = nudgeDecision(raw.trim() ? JSON.parse(raw) : {})
      if (d) io.stdout.write(JSON.stringify(d))
      return 0
    }
    if (!args.events) return 0
    const raw = await readStdin(io.stdin)
    let payload: unknown
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      payload = { raw: raw.slice(0, FIELD_CAP) }
    }
    const gateId = args.gate && args.dir ? `gate_${crypto.randomBytes(8).toString('hex')}` : null
    fs.appendFileSync(args.events, buildLine(args, payload, gateId, io.now?.() ?? new Date()), { mode: 0o600 })
    if (!gateId || !args.dir) return 0
    const answer = await waitForAnswer(args.dir, gateId, io.gateWaitMs ?? GATE_WAIT_MS)
    const decision = answer ?? timeoutDecision(args.provider)
    io.stdout.write(JSON.stringify(decision))
    try {
      fs.appendFileSync(args.events, JSON.stringify({ hive: 'gate_closed', gate_id: gateId, timeout: answer === null }) + '\n')
    } catch {
      /* ignore */
    }
    return 0
  } catch {
    return 0
  }
}
