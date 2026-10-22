/**
 * Onboarding GitHub intake (ONBOARDING.md §5.2): `gh` status, the founder's recent repos, a read-only `gh api` call and
 * the launch-time clone. Separate from company/github.ts (issue preview).
 *
 * - Every process goes through an injectable `GhExec` (default: engine/process.ts startProcess, own process group, so
 *   kill() takes the whole tree). No shell, stdin closed, prompts disabled, hard timeouts, capped output.
 * - clone writes only inside `<parentDir>/<repo>`: the parent is never created (unless asked), an existing destination is
 *   reused only when it is a git repo with the same origin, and a failed clone removes only what it created.
 * - Clone URLs: only https://, ssh:// and git@host:path; credentials are stripped before git sees them.
 *
 * No Electron imports.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { HiveError } from '../../shared/errors'
import { CLONE_URL, GITHUB_FULL_NAME, type GhStatus, type GithubRepo } from '../../shared/onboarding'
import { startProcess } from '../engine/process'
import { baseChildEnv } from '../loginEnv'
import { redactCredentials } from '../memory/screen'
import { isInside } from '../pathGuard'
import { cleanRemote } from '../repoMeta'
import { readOriginRemote } from './gitConfig'

// ---------- exec ----------

export interface GhRunOpts {
  env: Record<string, string>
  timeoutMs: number
  cwd?: string
  /** Streamed stderr (git progress). */
  onStderr?(chunk: string): void
  /** Per stream, in UTF-16 code units. Default 2 MB. */
  outputCap?: number
}
export interface GhRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  killed?: boolean
  /** The binary could not be started (ENOENT: not installed). */
  spawnError?: string
}
export interface GhRunHandle {
  /** Never rejects. */
  promise: Promise<GhRunResult>
  /** Kills the process group. Idempotent. */
  kill(): Promise<void>
}
export type GhExec = (file: string, args: string[], opts: GhRunOpts) => GhRunHandle

const DEFAULT_OUTPUT_CAP = 2 * 1024 * 1024

/** Default GhExec: startProcess (own process group, stdin /dev/null). */
export const defaultGhExec: GhExec = (file, args, opts) => {
  const cap = opts.outputCap && opts.outputCap > 0 ? opts.outputCap : DEFAULT_OUTPUT_CAP
  let stdout = ''
  let stderr = ''
  let killed = false
  const take = (cur: string, chunk: string): string => (cur.length >= cap ? cur : cur + chunk.slice(0, cap - cur.length))
  let h: ReturnType<typeof startProcess>
  try {
    h = startProcess({
      file,
      args,
      cwd: opts.cwd ?? os.tmpdir(),
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      onStdout: (c) => (stdout = take(stdout, c)),
      onStderr: (c) => {
        stderr = take(stderr, c)
        opts.onStderr?.(c)
      }
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { promise: Promise.resolve({ code: null, stdout, stderr: msg, timedOut: false, spawnError: msg }), kill: () => Promise.resolve() }
  }
  const promise = h.done.then(
    (r): GhRunResult => ({
      code: r.exitCode,
      stdout,
      stderr,
      timedOut: r.timedOut,
      ...(killed || r.killed ? { killed: true } : {}),
      ...(r.spawnError ? { spawnError: r.spawnError } : {})
    }),
    (e: unknown): GhRunResult => ({ code: null, stdout, stderr: e instanceof Error ? e.message : String(e), timedOut: false })
  )
  return {
    promise,
    kill: async () => {
      killed = true
      await h.kill(2000).catch(() => undefined)
    }
  }
}

export interface GhDeps {
  exec?: GhExec
  /** Base child env (default: the login env). Prompt-disabling vars are always added on top. */
  env?: Record<string, string>
}

/** The env every gh/git child gets: never prompts, never pages, no colour. */
export function ghEnv(base: Record<string, string> = baseChildEnv()): Record<string, string> {
  const env: Record<string, string> = { ...base, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
  // never wait on an ssh passphrase / host-key prompt (there is no terminal); respect a user's own ssh command
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  // no ext::, file://, fd:: transports, even from a redirect or a submodule
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  return env
}

const isMissing = (r: GhRunResult): boolean => !!r.spawnError && /ENOENT|not found/i.test(r.spawnError)

/** Redacts tokens and URL credentials in a line of CLI output. */
export function scrubLine(s: string, redact: (t: string) => string = (t) => t): string {
  const noCreds = s.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1')
  return redact(redactCredentials(noCreds))
}

// ---------- status ----------

export const GH_STATUS_TIMEOUT_MS = 10_000

/** `gh auth status`: missing (not installed), signedOut, or ok with the login when it can be read. */
export async function ghStatus(deps: GhDeps = {}): Promise<{ gh: GhStatus; login?: string }> {
  const exec = deps.exec ?? defaultGhExec
  const r = await exec('gh', ['auth', 'status', '--hostname', 'github.com'], { env: ghEnv(deps.env), timeoutMs: GH_STATUS_TIMEOUT_MS, outputCap: 64 * 1024 }).promise
  if (isMissing(r)) return { gh: 'missing' }
  if (r.code !== 0 || r.timedOut) return { gh: 'signedOut' }
  const text = `${r.stdout}\n${r.stderr}`
  const m = /Logged in to \S+ (?:account|as) ([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/.exec(text)
  return m ? { gh: 'ok', login: m[1] } : { gh: 'ok' }
}

// ---------- list ----------

export const GH_LIST_TIMEOUT_MS = 15_000
export const GH_LIST_FIELDS = 'name,owner,description,url,homepageUrl,primaryLanguage,isPrivate,pushedAt'

const ghRepoSchema = z.object({
  name: z.string().min(1).max(100),
  owner: z.object({ login: z.string().min(1).max(39) }).passthrough(),
  description: z.string().nullable().optional(),
  url: z.string().max(2048),
  homepageUrl: z.string().nullable().optional(),
  primaryLanguage: z.object({ name: z.string() }).passthrough().nullable().optional(),
  isPrivate: z.boolean().optional(),
  pushedAt: z.string().nullable().optional()
})

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const httpOrNull = (u: string | null | undefined): string | null => {
  const v = (u ?? '').trim()
  return /^https?:\/\/\S+$/i.test(v) ? cut(cleanRemote(v), 2048) : null
}

/** Parses `gh repo list --json …` output. Drops malformed rows; never throws. */
export function parseRepoList(stdout: string, redact: (t: string) => string = (t) => t): GithubRepo[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: GithubRepo[] = []
  for (const row of raw) {
    const p = ghRepoSchema.safeParse(row)
    if (!p.success) continue
    const r = p.data
    const fullName = `${r.owner.login}/${r.name}`
    if (!GITHUB_FULL_NAME.test(fullName)) continue
    const desc = r.description?.trim() ? cut(scrubLine(r.description.trim(), redact), 500) : null
    out.push({
      name: r.name,
      owner: r.owner.login,
      fullName,
      description: desc,
      url: httpOrNull(r.url) ?? `https://github.com/${fullName}`,
      homepageUrl: httpOrNull(r.homepageUrl),
      primaryLanguage: r.primaryLanguage?.name ? cut(r.primaryLanguage.name, 60) : null,
      isPrivate: r.isPrivate === true,
      pushedAt: r.pushedAt ?? null
    })
  }
  return out
}

/** Case-insensitive filter on name, owner/name and description. */
export function filterRepos(repos: GithubRepo[], query?: string): GithubRepo[] {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return repos
  return repos.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
}

/** The founder's 100 most recent repos (`gh repo list`), filtered by `query`. */
export async function listRepos(query: string | undefined, deps: GhDeps & { redact?: (t: string) => string } = {}): Promise<GithubRepo[]> {
  const exec = deps.exec ?? defaultGhExec
  const r = await exec('gh', ['repo', 'list', '--limit', '100', '--json', GH_LIST_FIELDS], { env: ghEnv(deps.env), timeoutMs: GH_LIST_TIMEOUT_MS }).promise
  if (isMissing(r)) throw new HiveError('adapter_unavailable', 'The GitHub CLI (gh) is not installed. Paste a repo link instead.')
  if (r.timedOut) throw new HiveError('bad_request', 'GitHub took too long to answer. Try again, or paste a repo link.')
  if (r.code !== 0) throw new HiveError('bad_request', 'Could not list your GitHub repos. Run `gh auth login` in Terminal, then Recheck.')
  return filterRepos(parseRepoList(r.stdout, deps.redact), query)
}

// ---------- api ----------

export const GH_API_TIMEOUT_MS = 10_000

/** Read-only `gh api <path>` against github.com. Resolves to the parsed JSON, or throws a HiveError. */
export async function ghApi(apiPath: string, deps: GhDeps & { timeoutMs?: number } = {}): Promise<unknown> {
  if (!/^repos\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(\/readme)?$/.test(apiPath) || /\/\.{1,2}(\/|$)/.test(apiPath)) {
    throw new HiveError('bad_request', 'Invalid GitHub path')
  }
  const exec = deps.exec ?? defaultGhExec
  const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? GH_API_TIMEOUT_MS, GH_API_TIMEOUT_MS))
  const r = await exec('gh', ['api', '--hostname', 'github.com', '--method', 'GET', apiPath], { env: ghEnv(deps.env), timeoutMs, outputCap: 1024 * 1024 }).promise
  if (isMissing(r)) throw new HiveError('adapter_unavailable', 'The GitHub CLI (gh) is not installed')
  if (r.timedOut) throw new HiveError('bad_request', 'GitHub took too long to answer')
  if (r.code !== 0) throw new HiveError('not_found', /404|Not Found/i.test(r.stdout + r.stderr) ? 'not found' : 'GitHub refused the request')
  try {
    return JSON.parse(r.stdout) as unknown
  } catch {
    throw new HiveError('bad_request', 'GitHub returned something unexpected')
  }
}

// ---------- clone ----------

export const CLONE_TIMEOUT_MS = 5 * 60_000
const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

export type CloneSource = { fullName: string; url?: undefined } | { url: string; fullName?: undefined }
export interface CloneTarget {
  /** What git/gh is given: `owner/repo`, or the URL with credentials stripped. */
  arg: string
  kind: 'gh' | 'git'
  /** Destination folder name. */
  repo: string
  /** Shown in progress and errors (no credentials). */
  label: string
  /** Comparable identity: `host/path` lowercased, no scheme, user or `.git`. */
  identity: string
}

/** `host/owner/repo` lowercased from any remote form (https, ssh://, git@host:path, owner/repo), or null. */
export function remoteIdentity(remote: string): string | null {
  const s = remote.trim()
  let host: string
  let p: string
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(s)
  if (scp) {
    host = scp[1]
    p = scp[2]
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) {
    let u: URL
    try {
      u = new URL(s)
    } catch {
      return null
    }
    host = u.hostname
    p = u.pathname
  } else if (GITHUB_FULL_NAME.test(s)) {
    host = 'github.com'
    p = s
  } else return null
  const clean = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!host || !clean) return null
  return `${host}/${clean}`.toLowerCase()
}

/** Validates a clone source and strips credentials. Throws a HiveError with copy for the founder. */
export function cloneTarget(src: CloneSource): CloneTarget {
  if (src.fullName !== undefined) {
    const fullName = src.fullName.trim()
    if (!GITHUB_FULL_NAME.test(fullName)) throw new HiveError('bad_request', 'Choose a GitHub repo like owner/name')
    const repo = fullName.split('/')[1]
    return { arg: fullName, kind: 'gh', repo, label: fullName, identity: `github.com/${fullName}`.toLowerCase() }
  }
  const raw = (src.url ?? '').trim()
  const bad = (): never => {
    throw new HiveError('bad_request', 'Use an https://, ssh:// or git@ link to the repo')
  }
  if (!raw || raw.startsWith('-') || !CLONE_URL.test(raw) || /[\s\\]/.test(raw) || raw.includes('::')) bad()
  let arg: string
  let host: string
  let repoPath: string
  if (/^git@/i.test(raw)) {
    const m = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9._~/-]+)$/.exec(raw)
    if (!m || m[2].startsWith('/') || m[2].startsWith('-')) bad()
    host = m![1]
    repoPath = m![2]
    arg = `git@${host}:${repoPath}`
  } else {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return bad()
    }
    if (u.protocol !== 'https:' && u.protocol !== 'ssh:') bad()
    if (!u.hostname || u.hostname.startsWith('-') || u.search || u.hash) bad()
    // credentials: https keeps none (a token is often the user part); ssh keeps a plain user (git@) but no password
    if (u.protocol === 'https:') u.username = ''
    u.password = ''
    host = u.hostname
    repoPath = decodeURIComponent(u.pathname)
    arg = u.toString()
  }
  const segs = repoPath.replace(/\/+$/, '').split('/').filter(Boolean)
  if (segs.length < 1 || segs.some((x) => x === '.' || x === '..')) bad()
  const repo = segs[segs.length - 1].replace(/\.git$/i, '')
  if (!REPO_NAME.test(repo)) bad()
  const identity = remoteIdentity(arg)
  if (!identity) bad()
  return { arg, kind: 'git', repo, label: cleanRemote(arg), identity: identity! }
}

export interface CloneProgress {
  percent: number | null
  line: string
}
export interface CloneResult {
  path: string
  reused: boolean
  /** owner/repo or the cleaned URL. */
  label: string
}
export interface CloneJob {
  /** Rejects with a HiveError (copy for the founder, no credentials). */
  promise: Promise<CloneResult>
  /** Stops the clone and removes the partial folder. Idempotent. */
  kill(): Promise<void>
}
export interface CloneDeps extends GhDeps {
  redact?: (t: string) => string
  timeoutMs?: number
  /** Create `parentDir` when missing (the only write outside the destination; off by default). */
  createParent?: boolean
}

const tilde = (p: string): string => {
  const home = os.homedir()
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p
}

/** Parses git's progress (`Receiving objects:  45% (450/1000)`). Percent only for the receive/resolve phases. */
export function parseProgressLine(line: string): CloneProgress | null {
  const l = line.trim()
  if (!l) return null
  const m = /^(?:remote:\s*)?(Receiving objects|Resolving deltas):\s+(\d{1,3})%/.exec(l)
  return { percent: m ? Math.min(100, Number(m[2])) : null, line: l.slice(0, 300) }
}

function isGitRepo(dir: string): boolean {
  try {
    const st = fs.lstatSync(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** In-flight clones by destination: a Retry while the first clone runs joins it instead of racing it. */
const inflight = new Map<string, { identity: string; job: CloneJob }>()

/** The scratch folder a clone is written to before it is renamed into place (named, so a crashed attempt is ours). */
export function cloneScratchDir(parent: string, repo: string): string {
  return path.join(parent, `.${repo}.principia-clone`)
}

/**
 * Clones into `<parentDir>/<repo>` (`gh repo clone … -- --filter=blob:none` or `git clone --filter=blob:none -- <url>`).
 * An existing destination is reused when it is a git repo with the same origin, otherwise refused.
 *
 * The clone is written to `<parent>/.<repo>.principia-clone` and renamed to `<parent>/<repo>` only once it finished, so
 * the destination never holds a half clone: an app killed mid-clone leaves only the scratch folder, which the next
 * attempt removes and starts over (resume), instead of later "reusing" an incomplete repo.
 */
export function clone(src: CloneSource, parentDir: string, onProgress: (p: CloneProgress) => void = () => undefined, deps: CloneDeps = {}): CloneJob {
  const fail = (msg: string): CloneJob => ({ promise: Promise.reject(new HiveError('bad_request', msg)), kill: () => Promise.resolve() })
  let target: CloneTarget
  try {
    target = cloneTarget(src)
  } catch (e) {
    return { promise: Promise.reject(e), kill: () => Promise.resolve() }
  }
  if (!path.isAbsolute(parentDir)) return fail('Choose a folder to clone into')
  let parent: string
  try {
    if (deps.createParent && !fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })
    parent = fs.realpathSync(parentDir)
    if (!fs.statSync(parent).isDirectory()) return fail(`${tilde(parentDir)} is not a folder. Choose another folder.`)
  } catch {
    return fail(`The folder ${tilde(parentDir)} doesn't exist. Choose another folder.`)
  }
  const dest = path.join(parent, target.repo)
  const scratch = cloneScratchDir(parent, target.repo)
  if (!isInside(dest, parent) || dest === parent || !isInside(scratch, parent)) return fail('Choose another folder')
  const refuse = `A folder named ${target.repo} already exists in ${tilde(parent)}. Choose another folder.`

  const running = inflight.get(dest)
  if (running) {
    if (running.identity !== target.identity) return fail(refuse)
    return running.job
  }

  const exists = (p: string): boolean => {
    try {
      fs.lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  if (exists(dest)) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(dest)
    } catch {
      return fail(refuse)
    }
    if (!st.isDirectory() || !isGitRepo(dest)) return fail(refuse)
    const remote = readOriginRemote(dest)
    const same = remote ? remoteIdentity(remote) : null
    if (!same || same !== target.identity) return fail(refuse)
    return { promise: Promise.resolve({ path: dest, reused: true, label: target.label }), kill: () => Promise.resolve() }
  }

  // leftovers of a crashed or killed attempt at this same clone (only our scratch name, never a symlink's target)
  try {
    if (exists(scratch)) fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    return fail(`Couldn't clear an unfinished clone of ${target.repo} in ${tilde(parent)}. Choose another folder.`)
  }

  const exec = deps.exec ?? defaultGhExec
  const redact = deps.redact ?? ((t: string) => t)
  const args =
    target.kind === 'gh'
      ? ['repo', 'clone', target.arg, scratch, '--', '--filter=blob:none', '--progress']
      : ['clone', '--filter=blob:none', '--progress', '--', target.arg, scratch]
  let pending = ''
  let lastLine = ''
  const onStderr = (chunk: string): void => {
    pending += chunk
    const parts = pending.split(/[\r\n]/)
    pending = parts.pop() ?? ''
    if (pending.length > 4096) pending = pending.slice(-4096)
    for (const raw of parts) {
      const p = parseProgressLine(scrubLine(raw, redact))
      if (!p) continue
      lastLine = p.line
      try {
        onProgress(p)
      } catch {
        /* a listener error never breaks the clone */
      }
    }
  }
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? Math.min(deps.timeoutMs, CLONE_TIMEOUT_MS) : CLONE_TIMEOUT_MS
  const h = exec(target.kind === 'gh' ? 'gh' : 'git', args, { env: ghEnv(deps.env), timeoutMs, cwd: parent, onStderr })
  let cancelled = false
  const cleanup = (): void => {
    // only the scratch folder this clone wrote, and only inside the parent; the destination was never touched
    try {
      if (isInside(scratch, parent) && scratch !== parent) fs.rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* the next attempt clears it */
    }
  }
  const promise = h.promise
    .then((r): CloneResult => {
      if (r.code === 0 && !r.timedOut && !r.killed && !cancelled && isGitRepo(scratch)) {
        if (exists(dest)) {
          cleanup()
          throw new HiveError('bad_request', refuse)
        }
        try {
          fs.renameSync(scratch, dest)
        } catch {
          cleanup()
          throw new HiveError('bad_request', `Couldn't move the clone of ${target.label} into ${tilde(parent)}. Choose another folder.`)
        }
        return { path: dest, reused: false, label: target.label }
      }
      cleanup()
      if (isMissing(r)) {
        throw new HiveError('adapter_unavailable', target.kind === 'gh' ? 'The GitHub CLI (gh) is not installed. Paste the repo link instead.' : 'git is not installed.')
      }
      if (cancelled || r.killed) throw new HiveError('bad_request', 'Clone cancelled')
      if (r.timedOut) throw new HiveError('bad_request', `Cloning ${target.label} took longer than 5 minutes and was stopped.`)
      const tail = (lastLine && !/^(Receiving|Resolving|remote:)/.test(lastLine) ? lastLine : '') || scrubLine(r.stderr.trim().split(/[\r\n]+/).pop() ?? '', redact)
      throw new HiveError('bad_request', `Couldn't clone ${target.label}${tail ? `: ${cut(tail.split(scratch).join(dest), 200)}` : ''}`)
    })
    .finally(() => {
      if (inflight.get(dest)?.job === job) inflight.delete(dest)
    })
  const job: CloneJob = {
    promise,
    kill: async () => {
      cancelled = true
      await h.kill()
    }
  }
  inflight.set(dest, { identity: target.identity, job })
  return job
}
