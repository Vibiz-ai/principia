/**
 * GitHub repos in the cloud (CLOUD.md §7.4): clone or fetch `https://github.com/<owner>/<repo>` into
 * `<workspace>/<companyId>/<name>`. The token reaches git only through a per-call GIT_ASKPASS script that reads a
 * 0600 file; it is never in argv, the environment or the remote URL, no credential helper stores it, and the clone's
 * `.git/config` is scrubbed if it ever shows up there. Every clone gets the push guard (agents push branches, never
 * the default branch).
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoMaterial } from '../contract'
import { installPushGuard } from '../../main/engine/pushGuard'
import { capture } from './proc'

export const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

export interface RepoSyncDeps {
  git: string
  baseEnv(): Record<string, string>
  companyDir(companyId: string): string
  /** `<runtime>/tmp`: askpass folders live here briefly */
  tmpDir: string
  /** `<runtime>/push-guard`: the shared hooks folder */
  hooksDir: string
  redact(s: string): string
  /** tests: accept other URLs (a local bare repo) */
  allowUrl?: (url: string) => boolean
  /** CLOUD.md §7.8: git runs as the agent user, so the clone is the agent's to work in (null: the runtime's user) */
  user?: { uid: number; gid: number } | null
}

export function repoFolderName(r: Pick<RepoMaterial, 'name' | 'url'>): string {
  const fromUrl = GITHUB_URL.exec(r.url)?.[2]
  const name = (r.name || fromUrl || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100)
  if (!name || name === '.' || name === '..') throw new Error('The repository needs a folder name')
  return name
}

/** The askpass script: answers the username prompt with x-access-token and the password prompt from the file. */
export function askpassScript(tokenFile: string): string {
  const q = `'${tokenFile.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf '%s\\n' x-access-token ;;\n  *) cat ${q} ;;\nesac\n`
}

/**
 * The run's own GIT_ASKPASS (CLOUD.md §7.4): agents push branches with the repo's token, read from 0600 files in the
 * run home (deleted with it). The script answers for the repository git runs in (git starts its helpers from the
 * work tree's top folder), so each repo gets its own token and a folder outside them gets none. Never argv, never env.
 */
export function runAskpass(home: string, repos: { dir: string; token: string }[]): Record<string, string> {
  const dir = join(home, '.git-askpass')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
  const cases: string[] = []
  // deepest folder first, so a nested clone wins over its parent
  ;[...repos]
    .sort((a, b) => b.dir.length - a.dir.length)
    .forEach((r, i) => {
      const file = join(dir, `${i}.token`)
      writeFileSync(file, r.token, { mode: 0o600 })
      cases.push(`  ${q(r.dir.replace(/\/+$/, ''))}/*) cat ${q(file)}; exit 0 ;;`)
    })
  const script = join(dir, 'askpass.sh')
  writeFileSync(
    script,
    `#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf '%s\\n' x-access-token; exit 0 ;;\nesac\nhere="$(pwd -P)/"\ncase "$here" in\n${cases.join('\n')}\nesac\nexit 1\n`,
    { mode: 0o700 }
  )
  return { GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0' }
}

/** Plain-words failure for the readiness row ("GitHub said the token cannot read vibiz-ai/quest"). */
export function gitFailureDetail(text: string, slug: string): string {
  if (/authentication failed|could not read username|invalid username or password|403|terminal prompts disabled/i.test(text)) return `GitHub said the token cannot read ${slug}.`
  if (/repository not found|not found/i.test(text)) return `GitHub could not find ${slug}, or the token cannot see it.`
  if (/could not resolve host|unable to access|timed out|connection/i.test(text)) return 'GitHub could not be reached from the cloud.'
  if (/couldn't find remote ref|did not match any|not a valid ref/i.test(text)) return 'That branch does not exist on GitHub.'
  return 'git failed. Try Sync again.'
}

export async function syncRepo(d: RepoSyncDeps, companyId: string, repo: RepoMaterial): Promise<{ ok: boolean; detail: string | null }> {
  const url = repo.url.trim()
  const m = GITHUB_URL.exec(url)
  if (!m && !d.allowUrl?.(url)) return { ok: false, detail: 'Only https://github.com/<owner>/<repo> repositories are supported.' }
  const slug = m ? `${m[1]}/${m[2]}` : repo.name
  if (repo.branch && !BRANCH.test(repo.branch)) return { ok: false, detail: 'That branch name is not valid.' }
  let folder: string
  try {
    folder = repoFolderName(repo)
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
  const dest = join(d.companyDir(companyId), folder)
  mkdirSync(d.tmpDir, { recursive: true, mode: 0o700 })
  if (d.user) chmodSync(d.tmpDir, 0o711)
  const work = join(d.tmpDir, `askpass-${randomBytes(8).toString('hex')}`)
  mkdirSync(work, { mode: 0o700 })
  const env: Record<string, string> = { ...d.baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  if (repo.token) {
    const tokenFile = join(work, 'token')
    writeFileSync(tokenFile, repo.token, { mode: 0o600 })
    const script = join(work, 'askpass.sh')
    writeFileSync(script, askpassScript(tokenFile), { mode: 0o700 })
    env.GIT_ASKPASS = script
  }
  // git (as the agent) reads the askpass files: they are the agent's, in a folder only it can open
  if (d.user) for (const p of [work, ...readdirSync(work).map((n) => join(work, n))]) chownSync(p, d.user.uid, d.user.gid)
  // no credential helper may keep the token; never ask on a terminal
  const git = (args: string[], cwd?: string) => capture(d.git, ['-c', 'credential.helper=', '-c', 'core.askPass=', ...args], { env, cwd, timeoutMs: 10 * 60_000, user: d.user ?? null })
  const fail = (r: { stdout: string; stderr: string; error: string | null }) => ({ ok: false, detail: gitFailureDetail(d.redact(`${r.stderr}\n${r.stdout}\n${r.error ?? ''}`), slug) })
  try {
    const cloned = existsSync(join(dest, '.git'))
    if (!cloned) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      const r = await git(['clone', '--origin', 'origin', ...(repo.branch ? ['--branch', repo.branch] : []), '--', url, dest])
      if (r.code !== 0) return fail(r)
    } else {
      const r = await git(['fetch', '--prune', 'origin'], dest)
      if (r.code !== 0) return fail(r)
      if (repo.branch) {
        const co = await git(['checkout', repo.branch], dest)
        if (co.code !== 0) return fail(co)
        const ff = await git(['merge', '--ff-only', `origin/${repo.branch}`], dest)
        if (ff.code !== 0) return { ok: false, detail: 'The cloud copy has local changes on that branch; it was fetched but not moved.' }
      }
    }
    // the remote stays the plain URL, and the push guard is on
    await git(['remote', 'set-url', 'origin', url], dest)
    installPushGuard(d.hooksDir)
    // the agent runs the hooks but cannot change them
    if (d.user) for (const p of [d.hooksDir, ...readdirSync(d.hooksDir).map((n) => join(d.hooksDir, n))]) chmodSync(p, 0o755)
    await git(['config', 'core.hooksPath', d.hooksDir], dest)
    if (repo.token) scrubToken(join(dest, '.git', 'config'), repo.token)
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dest)
    const branch = head.code === 0 ? head.stdout.trim() : (repo.branch ?? '')
    return { ok: true, detail: `Cloned · ${branch || 'default branch'}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Removes any line of `.git/config` that carries the token (it should never be there). */
export function scrubToken(configPath: string, token: string): boolean {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return false
  }
  if (!text.includes(token)) return false
  writeFileSync(configPath, text.split('\n').filter((l) => !l.includes(token)).join('\n'))
  return true
}
