/**
 * The `process` sandbox driver (CLOUD.md §7.8). Each run gets `<runtime>/runs/<runId>/{home (0700), logs, artifacts}`,
 * an environment built from an allowlist (nothing from the control plane's own environment), and a cwd confined to
 * `<workspace>/<companyId>`. Honest isolation between one owner's companies, not a multi-tenant boundary.
 */
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** The uid/gid every agent process runs as (RuntimeOptions.agentUser, CLOUD.md §7.8). */
export interface AgentUser {
  uid: number
  gid: number
}

/** chown without following symlinks, the whole tree when `recursive` (a link is re-owned, never its target). */
export function chownTree(path: string, u: AgentUser, recursive: boolean, chown: (p: string, uid: number, gid: number) => void = lchownSync): void {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return
  }
  chown(path, u.uid, u.gid)
  if (!recursive || !st.isDirectory()) return
  for (const name of readdirSync(path)) chownTree(join(path, name), u, true, chown)
}

/** Host variables a run may inherit. Everything else (PRINCIPIA_*, OPEN_PASSPORT_*, TELEGRAM_*, cloud credentials…) stays out. */
export const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM'] as const
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** Ids that become folder names. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,96}$/

export function assertSafeId(kind: string, id: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`Invalid ${kind} id`)
  return id
}

/** `child` is `root` or inside it (both already real paths). */
export const isInside = (root: string, child: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)

export interface RunSandbox {
  runId: string
  root: string
  home: string
  logs: string
  artifacts: string
  /** CLAUDE_CONFIG_DIR */
  claudeDir: string
  /** CODEX_HOME */
  codexHome: string
  /** gemini reads ~/.gemini */
  geminiDir: string
  tmp: string
}

export interface SandboxOptions {
  /** `<dataDir>/runtime` */
  runtimeDir: string
  workspaceDir: string
  /** the host environment to pick the allowlist from (tests pass their own) */
  hostEnv?: NodeJS.ProcessEnv
  /**
   * CLOUD.md §7.8: agents run as this user. The runtime's own folders become traverse-only (0711) and everything an
   * agent works in (its run home, the company folder, artifacts) is handed over to it. null = one user (dev, tests).
   */
  agentUser?: AgentUser | null
  /** test seam for chown */
  chown?: (p: string, uid: number, gid: number) => void
}

export class ProcessSandbox {
  readonly runtimeDir: string
  readonly workspaceDir: string
  private readonly hostEnv: NodeJS.ProcessEnv
  /** HOME for processes outside a run (gateway upstreams, version checks): empty and private */
  readonly neutralHome: string
  readonly agentUser: AgentUser | null
  private readonly chown: (p: string, uid: number, gid: number) => void

  constructor(o: SandboxOptions) {
    mkdirSync(o.runtimeDir, { recursive: true, mode: 0o700 })
    mkdirSync(o.workspaceDir, { recursive: true })
    this.runtimeDir = realpathSync(o.runtimeDir)
    this.workspaceDir = realpathSync(o.workspaceDir)
    this.hostEnv = o.hostEnv ?? process.env
    this.neutralHome = join(this.runtimeDir, 'home')
    mkdirSync(this.neutralHome, { recursive: true, mode: 0o700 })
    this.agentUser = o.agentUser ?? null
    this.chown = o.chown ?? lchownSync
    if (this.agentUser) {
      // agents may pass through these folders to their own, but never list or read them (engine.db, forum.db…)
      chmodSync(this.runtimeDir, 0o711)
      chmodSync(this.workspaceDir, 0o711)
      mkdirSync(join(this.runtimeDir, 'runs'), { recursive: true, mode: 0o711 })
      chmodSync(join(this.runtimeDir, 'runs'), 0o711)
    }
  }

  /** The user a run's processes start as (null: the runtime's own). */
  spawnUser(): AgentUser | null {
    return this.agentUser
  }

  /** Hands a folder (and with `recursive` everything in it) to the agent user. No-op without one. */
  grant(path: string, recursive = false): void {
    if (!this.agentUser) return
    chownTree(path.replace(/\/+$/, '') || path, this.agentUser, recursive, this.chown)
  }

  /** A folder of the runtime an agent must pass through but not list (0711, owned by the runtime). */
  traverseOnly(path: string): void {
    if (!this.agentUser) return
    try {
      chmodSync(path, 0o711)
    } catch {
      /* not there yet */
    }
  }

  /** After the runtime wrote the run's own files (accounts, askpass): the run home belongs to the agent. */
  handOver(box: RunSandbox): void {
    this.grant(box.home, true)
  }

  /** The allowlisted base every spawn starts from (EngineContext.baseEnv). Fresh copy per call. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of ENV_ALLOWLIST) {
      const v = this.hostEnv[name]
      if (typeof v === 'string' && v) env[name] = v
    }
    env.PATH ??= DEFAULT_PATH
    env.SHELL ??= existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    env.LANG ??= 'C.UTF-8'
    env.TERM ??= 'dumb'
    env.HOME = this.neutralHome
    env.NO_COLOR = '1'
    return env
  }

  runDir(runId: string): string {
    return join(this.runtimeDir, 'runs', assertSafeId('run', runId))
  }

  /** Creates the run's folders. Idempotent. */
  prepare(runId: string): RunSandbox {
    const root = this.runDir(runId)
    const home = join(root, 'home')
    const box: RunSandbox = {
      runId,
      root,
      home,
      logs: join(root, 'logs'),
      artifacts: join(root, 'artifacts'),
      claudeDir: join(home, '.claude'),
      codexHome: join(home, '.codex'),
      geminiDir: join(home, '.gemini'),
      tmp: join(home, 'tmp')
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    // with an agent user the run folder is traverse-only: the agent reaches its home, never the logs beside it
    if (this.agentUser) chmodSync(root, 0o711)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    for (const dir of [box.claudeDir, box.codexHome, box.geminiDir, box.tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    return box
  }

  /**
   * The run's own variables, merged over baseEnv() for every process of the run: its HOME and the CLIs' config homes,
   * then the provider variables, then the company keys. Provider and key names may not override the sandbox's own.
   */
  runEnv(box: RunSandbox, provider: Record<string, string> = {}, secrets: Record<string, string> = {}): Record<string, string> {
    const own: Record<string, string> = {
      HOME: box.home,
      CLAUDE_CONFIG_DIR: box.claudeDir,
      CODEX_HOME: box.codexHome,
      XDG_CONFIG_HOME: join(box.home, '.config'),
      XDG_CACHE_HOME: join(box.home, '.cache'),
      TMPDIR: box.tmp
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(secrets)) if (isSafeKeyName(k)) env[k] = v
    Object.assign(env, provider, own)
    return env
  }

  /** The full environment of a run's process (what the agent sees). */
  buildEnv(box: RunSandbox, provider: Record<string, string> = {}, secrets: Record<string, string> = {}): Record<string, string> {
    return { ...this.baseEnv(), ...this.runEnv(box, provider, secrets) }
  }

  /** `<workspace>/<companyId>`, created on first use. */
  companyDir(companyId: string): string {
    const dir = join(this.workspaceDir, assertSafeId('company', companyId))
    mkdirSync(dir, { recursive: true, mode: 0o750 })
    // the agent works here (repos, scratch): it owns the folder, the runtime only creates it
    // (recursive once: a folder from before agents had their own user, with repos cloned by the runtime)
    if (this.agentUser && statSync(dir).uid !== this.agentUser.uid) this.grant(dir, true)
    return realpathSync(dir)
  }

  /**
   * A cwd inside the company folder. Relative paths resolve against it; the real path (symlinks followed) must stay
   * inside. Throws a plain sentence otherwise.
   */
  confine(companyId: string, cwd: string | null | undefined): string {
    const root = this.companyDir(companyId)
    if (!cwd || !cwd.trim()) return root
    if (cwd.includes('{{')) throw new Error('Folder templates are not supported in the cloud; use a folder inside the company')
    const target = resolve(root, cwd.trim())
    if (!isInside(root, target)) throw new Error('That folder is outside the company folder')
    let real: string
    try {
      real = realpathSync(target)
    } catch {
      throw new Error(`Folder not found in the company folder: ${cwd.trim()}`)
    }
    if (!isInside(root, real)) throw new Error('That folder leads outside the company folder')
    return real
  }

  /** Deletes the run's home (after the readback hooks ran). Logs and artifacts stay with the run. */
  cleanup(box: RunSandbox): void {
    rmSync(box.home, { recursive: true, force: true })
  }

  /** Removes `<workspace>/<companyId>`. */
  removeCompanyDir(companyId: string): void {
    const dir = join(this.workspaceDir, assertSafeId('company', companyId))
    if (!existsSync(dir)) return
    const real = realpathSync(dir)
    if (!isInside(this.workspaceDir, real) || real === this.workspaceDir) throw new Error('Refusing to remove a folder outside the workspace')
    rmSync(real, { recursive: true, force: true })
  }
}

/** Company key names (CLOUD.md §7.3): ENV_NAME, never a name the sandbox or the loader owns. */
export function isSafeKeyName(name: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) return false
  if (/^(PRINCIPIA_|OPEN_PASSPORT_|TELEGRAM_|HIVE_|ELECTRON_|NODE_|LD_|DYLD_|GIT_|SSH_)/.test(name)) return false
  return !['PATH', 'HOME', 'SHELL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'IFS'].includes(name)
}
