/**
 * Safe one-shot CLI calls (extracted from memory/vault/suggest/llm.ts; ONBOARDING.md "Plan generation"): one headless
 * turn of an installed agent CLI in an empty temp cwd, the prompt on stdin, no tools, the child env stripped of every
 * provider key except the company's own, a hard timeout, a 1 MB output cap and a killable handle.
 *
 * - `cliText` unwraps the CLI's stdout envelope (claude `result` / `structured_output`, gemini `response`, codex JSONL).
 * - `neutralizeFrame` defuses a prompt's framing tags inside untrusted text.
 * - `startOneshot` is the default `ExecFn` (engine/process.ts startProcess: own process group, so kill() takes the
 *   whole tree).
 * - `strippedChildEnv` / `pickCli` / `claudeCliAvailable` resolve the child env and the CLI from the provider list.
 *
 * No Electron imports.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderInfo } from '../shared/types'
import { startProcess } from './engine/process'
import { baseChildEnv } from './loginEnv'

// ---------- CLIs and provider keys ----------

export type OneshotCli = 'claude' | 'codex' | 'gemini'
/** Preference order when any installed CLI will do. */
export const ONESHOT_CLI_ORDER: readonly OneshotCli[] = ['claude', 'codex', 'gemini']
/** The provider API key env vars each CLI reads. */
export const CLI_PROVIDER_KEYS: Record<OneshotCli, string[]> = { claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }
/** Every provider key a one-shot child must not inherit. */
export const ALL_PROVIDER_KEYS: readonly string[] = [...new Set(Object.values(CLI_PROVIDER_KEYS).flat())]

/**
 * The child env for a one-shot call: the login base env minus every provider key, plus the company's own key(s) when
 * given (billing stays in the company; never a shared or other company's key).
 */
export function strippedChildEnv(companyKeys: Record<string, string> = {}, base: Record<string, string> = baseChildEnv()): Record<string, string> {
  const env = { ...base }
  for (const k of ALL_PROVIDER_KEYS) delete env[k]
  return { ...env, ...companyKeys }
}

/** The first available CLI in `order` from the provider list (binPath required), or null. */
export function pickCli<T extends OneshotCli>(providers: readonly ProviderInfo[], order: readonly T[]): { id: T; bin: string } | null {
  for (const id of order) {
    const p = providers.find((x) => x.id === id)
    if (p?.available && p.binPath) return { id, bin: p.binPath }
  }
  return null
}

/** The installed claude CLI, or null. */
export function claudeCliAvailable(providers: readonly ProviderInfo[]): { id: 'claude'; bin: string } | null {
  return pickCli(providers, ['claude'] as const)
}

// ---------- envelope ----------

/**
 * The model's text out of a CLI's stdout envelope: claude json (`structured_output` when present, else `result`),
 * gemini json (`response`), codex JSONL (last agent message). `is_error: true` throws. Non-JSON stdout of claude/gemini
 * is returned trimmed as is.
 */
export function cliText(cli: OneshotCli, stdout: string): string {
  const s = stdout.trim()
  if (cli === 'claude' || cli === 'gemini') {
    let v: unknown
    try {
      v = JSON.parse(s)
    } catch {
      return s
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { result?: unknown; response?: unknown; is_error?: unknown; structured_output?: unknown }
      if (o.is_error === true) throw new Error('the CLI reported an error')
      if (typeof o.structured_output === 'string') return o.structured_output
      if (o.structured_output && typeof o.structured_output === 'object') return JSON.stringify(o.structured_output)
      if (typeof o.result === 'string') return o.result
      if (typeof o.response === 'string') return o.response
    }
    return s
  }
  let last = ''
  for (const line of s.split('\n')) {
    try {
      const v = JSON.parse(line) as { item?: { type?: string; text?: string }; msg?: { type?: string; message?: string } }
      if (v.item?.type === 'agent_message' && typeof v.item.text === 'string') last = v.item.text
      else if (v.msg?.type === 'agent_message' && typeof v.msg.message === 'string') last = v.msg.message
    } catch {
      // not an event line
    }
  }
  return last
}

// ---------- prompt framing ----------

/** The vault suggestion prompt's framing tags (the default of neutralizeFrame). */
export const DEFAULT_FRAME_TAGS: readonly string[] = ['data', 'source_notes', 'known_notes']
const TAG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const frameRes = new Map<string, RegExp>()
function frameRe(tags: readonly string[]): RegExp {
  const key = tags.join('|')
  let re = frameRes.get(key)
  if (!re) {
    for (const t of tags) if (!TAG_NAME_RE.test(t)) throw new Error(`invalid frame tag: ${t}`)
    re = new RegExp(`<\\s*(\\/?)\\s*(${key})\\b[^>]*>`, 'gi')
    frameRes.set(key, re)
  }
  return re
}

/** The prompt's own framing tags, neutralized inside untrusted text so the text cannot close <data> and speak as us. */
export function neutralizeFrame(text: string, tags: readonly string[] = DEFAULT_FRAME_TAGS): string {
  // no tags: nothing to defuse (an empty alternation would match, and erase, every tag in the text)
  if (tags.length === 0) return text
  return text.replace(frameRe(tags), (_m, slash: string, tag: string) => `‹${slash}${tag}›`)
}

// ---------- cwd ----------

const sharedCwds = new Map<string, string>()
/**
 * An empty temp folder for the CLI's cwd: one per process and prefix, reused while it stays empty, a fresh one
 * otherwise. Nothing removes it (the OS clears its temp folder).
 */
const CWD_PREFIX_RE = /^[A-Za-z0-9._-]+$/
export function emptyCwd(prefix = 'principia-oneshot-'): string {
  // a plain name: never a path that would put the cwd outside the temp folder
  if (!CWD_PREFIX_RE.test(prefix) || prefix.startsWith('.')) throw new Error(`invalid cwd prefix: ${prefix}`)
  const cur = sharedCwds.get(prefix)
  try {
    if (cur && fs.readdirSync(cur).length === 0) return cur
  } catch {
    // gone: make a new one
  }
  const next = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  sharedCwds.set(prefix, next)
  return next
}

// ---------- execution ----------

export const ONESHOT_TIMEOUT_MS = 60_000
export const ONESHOT_OUTPUT_CAP = 1024 * 1024

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** kill() was called before the process ended. */
  killed?: boolean
  /** stdout or stderr hit the output cap and was cut. */
  truncated?: boolean
  /** the process could not be started (e.g. ENOENT) */
  spawnError?: string
}
export interface ExecOpts {
  cwd: string
  env: Record<string, string>
  /** written to stdin, then stdin is closed */
  stdin: string
  /** <= 0 means ONESHOT_TIMEOUT_MS: a one-shot call is never unbounded */
  timeoutMs: number
  /** per stream, in UTF-16 code units; default ONESHOT_OUTPUT_CAP */
  outputCap?: number
}
export interface ExecHandle {
  /** Resolves when the process ended (never rejects). */
  promise: Promise<ExecResult>
  /** SIGTERM the process group (SIGKILL after the grace). Resolves when it exited. Idempotent. */
  kill(): Promise<void>
}
export type ExecFn = (file: string, args: string[], opts: ExecOpts) => ExecHandle

const KILL_GRACE_MS = 2000

/** Default ExecFn: startProcess (own process group) with the prompt piped on stdin. */
export const startOneshot: ExecFn = (file, args, opts) => {
  const cap = opts.outputCap && opts.outputCap > 0 ? opts.outputCap : ONESHOT_OUTPUT_CAP
  let stdout = ''
  let stderr = ''
  let truncated = false
  let killed = false
  let ended = false
  const take = (cur: string, chunk: string): string => {
    if (cur.length >= cap) {
      truncated = true
      return cur
    }
    const room = cap - cur.length
    if (chunk.length > room) truncated = true
    return cur + (chunk.length > room ? chunk.slice(0, room) : chunk)
  }
  let h: ReturnType<typeof startProcess>
  try {
    h = startProcess({
      file,
      args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs > 0 ? opts.timeoutMs : ONESHOT_TIMEOUT_MS,
      stdin: 'pipe',
      onStdout: (c) => (stdout = take(stdout, c)),
      onStderr: (c) => (stderr = take(stderr, c))
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const r: ExecResult = { code: null, stdout, stderr: msg, timedOut: false, spawnError: msg }
    return { promise: Promise.resolve(r), kill: () => Promise.resolve() }
  }
  h.write(opts.stdin)
  h.end()
  const promise = h.done.then(
    (r): ExecResult => {
      ended = true
      return {
        code: r.exitCode,
        stdout,
        stderr,
        timedOut: r.timedOut,
        ...(killed ? { killed: true } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(r.spawnError ? { spawnError: r.spawnError } : {})
      }
    },
    (e: unknown): ExecResult => ({ code: null, stdout, stderr: e instanceof Error ? e.message : String(e), timedOut: false })
  )
  const kill = async (): Promise<void> => {
    if (!ended) killed = true
    await h.kill(KILL_GRACE_MS).catch(() => undefined)
  }
  return { promise, kill }
}
