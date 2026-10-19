import { execFile } from 'node:child_process'
import os from 'node:os'

/**
 * SPEC A14: Finder-launched apps get a minimal environment. Resolve the user's whole login-shell env once
 * (`$SHELL -ilc` printing `env -0` between markers, 3 s timeout, TERM=dumb), so nvm, CLAUDE_CONFIG_DIR, proxies,
 * Homebrew vars and PATH come along. Settings "Recheck" calls resolveLoginEnv() again.
 */
const START = '__HIVE_ENV_START__'
const END = '__HIVE_ENV_END__'
/** Shell-session noise that must not leak into children. */
const DROP = new Set(['PWD', 'SHLVL', '_', 'OLDPWD'])
export const FALLBACK_PATH_DIRS = (home = os.homedir()): string[] => [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']

/** Pure: extracts the env map printed between the markers by `env -0`. null if markers missing. */
export function parseEnvDump(stdout: string): Record<string, string> | null {
  const s = stdout.indexOf(START)
  if (s < 0) return null
  const e = stdout.indexOf(END, s + START.length)
  if (e < 0) return null
  const body = stdout.slice(s + START.length, e)
  const env: Record<string, string> = {}
  for (const entry of body.split('\0')) {
    const i = entry.indexOf('=')
    if (i <= 0) continue
    const k = entry.slice(0, i).replace(/^\n+/, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
    if (DROP.has(k) || k.startsWith('TERM_')) continue
    env[k] = entry.slice(i + 1)
  }
  return env
}

/** Pure: login PATH first, then the current PATH, then fallback dirs; de-duplicated. */
export function mergePath(...parts: (string | undefined | null)[]): string {
  const out: string[] = []
  for (const p of parts) for (const d of (p ?? '').split(':')) if (d && !out.includes(d)) out.push(d)
  return out.join(':')
}

export interface LoginEnvState {
  /** Full resolved env (process env overlaid with login env, merged PATH). No secrets. */
  env: Record<string, string>
  /** Login-shell PATH as printed by the shell, null if resolution failed. */
  loginPath: string | null
  shell: string
  resolvedAt: string
  ok: boolean
}

let state: LoginEnvState = {
  env: snapshotProcessEnv(),
  loginPath: null,
  shell: process.env.SHELL || '/bin/zsh',
  resolvedAt: new Date(0).toISOString(),
  ok: false
}

function snapshotProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

function runShell(shell: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' '${START}'; env -0; printf '%s' '${END}'`],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TERM: 'dumb', HIVE_RESOLVING_ENV: '1' },
        cwd: os.homedir()
      },
      (_err, stdout) => resolve(stdout ?? '')
    )
  })
}

/** Resolves the login env, updates process.env.PATH (so main's own spawns find CLIs) and returns the state. */
export async function resolveLoginEnv(timeoutMs = 3000): Promise<LoginEnvState> {
  const shell = process.env.SHELL || '/bin/zsh'
  const login = parseEnvDump(await runShell(shell, timeoutMs))
  const base = snapshotProcessEnv()
  const env: Record<string, string> = { ...base, ...(login ?? {}) }
  delete env.HIVE_RESOLVING_ENV
  env.PATH = mergePath(login?.PATH, base.PATH, FALLBACK_PATH_DIRS().join(':'))
  process.env.PATH = env.PATH
  state = { env, loginPath: login?.PATH ?? null, shell, resolvedAt: new Date().toISOString(), ok: !!login }
  return state
}

export function loginEnvState(): LoginEnvState {
  return state
}

/** User configuration that must survive the CLAUDE_CODE_* scrub. */
const KEEP_CLAUDE_VARS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH'
])
/** Exact names of parent-process markers (agent sessions, Electron, dev tooling) that must not reach children. */
const DROP_EXACT = new Set([
  'CLAUDECODE',
  'HIVE_SPAWN_ID', // CONTRACT §13: set per spawn; a Hive started from a Hive pane must not inherit its parent's tag
  'NODE_OPTIONS',
  'HIVE_SMOKE',
  'HIVE_NO_SCHEDULER',
  'HIVE_RESOLVING_ENV',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
  'CURSOR_AGENT',
  'npm_config_prefix'
])

/** Pure: true for vars inherited from the launching process that would confuse child agents (SPEC A3/H8). */
export function isInheritedMarker(k: string): boolean {
  if (DROP_EXACT.has(k)) return true
  if (k.startsWith('ELECTRON_') || k.startsWith('VITE_') || k.startsWith('npm_')) return true
  if (k.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_VARS.has(k)) return true
  if (k.startsWith('CLAUDE_AGENT_')) return true
  return false
}

/** CONTRACT §2.2 step 1: fresh copy of the login env minus Electron internals / parent-agent markers, plus terminal vars. No secrets. */
export function baseChildEnv(src: Record<string, string> = state.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (isInheritedMarker(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.HIVE = '1'
  return env
}
