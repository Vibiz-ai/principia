/**
 * Onboarding repo intake (ONBOARDING.md §5.1). Read-only: folder checks for the Connect step, a byte-capped scan of
 * local repos and a `gh api` read of a GitHub repo. Nothing here writes, spawns git, or follows a symlink out of a repo.
 *
 * - Each file read is capped at 64 KB; the top-level listing at 60 entries (no dotfiles, no node_modules).
 * - Stack detection is data (`STACK_MARKERS`): marker files/dirs, package.json deps, and patterns in manifest text.
 * - Every string leaves through `redactCredentials` + the injected vault redactor, then is capped to the schema.
 *
 * No Electron imports.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import { stripAll, stripTags } from '../../shared/stripAll'
import {
  GITHUB_FULL_NAME,
  MAX_ONBOARDING_PATHS,
  MAX_URL_LENGTH,
  type FolderCandidate,
  type RepoScan,
  type RepoScanSummary,
  type ScanResult,
  type ScanSummary
} from '../../shared/onboarding'
import { redactCredentials } from '../memory/screen'
import { isInside } from '../pathGuard'
import { cleanRemote } from '../repoMeta'
import { readOriginRemote } from './gitConfig'
import { ghApi, type GhDeps } from './github'

export type { ScanSummary, RepoScan, ScanResult }

export const SCAN_FILE_CAP = 64 * 1024
export const SCAN_LISTING_MAX = 60
export const SCAN_BUDGET_MS = 5000
const README_EXCERPT_MAX = 2048
/** readdir entries looked at before filtering/sorting (a huge folder is never fully listed). */
const LISTING_READ_MAX = 2000

// ---------- folders (Connect step) ----------

/** What inspectFolders needs from the store (wired by the handler). */
export interface FolderStore {
  getRepoByPath(p: string): { id: string; companyId?: string | null } | null
  companyName(companyId: string): string | null
}

function hasGit(dir: string): boolean {
  try {
    const st = fs.lstatSync(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** realpath, folder check, isGit, owner and why it can't be added. De-duplicated by realpath. Adds nothing. */
export function inspectFolders(paths: string[], store: FolderStore): FolderCandidate[] {
  const out: FolderCandidate[] = []
  const seen = new Set<string>()
  const home = (() => {
    try {
      return fs.realpathSync(os.homedir())
    } catch {
      return os.homedir()
    }
  })()
  for (const p of paths.slice(0, MAX_ONBOARDING_PATHS)) {
    if (typeof p !== 'string' || !p) continue
    let real: string
    try {
      real = fs.realpathSync(p)
    } catch {
      const abs = path.resolve(p)
      if (seen.has(abs)) continue
      seen.add(abs)
      out.push({ path: abs, name: path.basename(abs), isGit: false, ownedBy: null, blockedReason: 'Folder not found' })
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    const name = path.basename(real) || real
    let isDir = false
    try {
      isDir = fs.statSync(real).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      out.push({ path: real, name, isGit: false, ownedBy: null, blockedReason: 'Not a folder' })
      continue
    }
    const isGit = hasGit(real)
    const repo = store.getRepoByPath(real)
    const cand: FolderCandidate = { path: real, name, isGit, ownedBy: null }
    if (repo) {
      const companyId = repo.companyId ?? PERSONAL_COMPANY_ID
      const personal = companyId === PERSONAL_COMPANY_ID
      const cname = store.companyName(companyId) ?? (personal ? 'Personal' : 'another company')
      cand.ownedBy = { companyId, name: cname, personal }
      cand.existingRepoId = repo.id
      if (!personal) cand.blockedReason = `Belongs to ${cname}, can't add`
    }
    if (!cand.blockedReason && (real === path.parse(real).root || real === home)) {
      cand.blockedReason = `Choose a project folder, not ${real === home ? 'your whole home folder' : 'the whole disk'}`
    }
    out.push(cand)
  }
  return out
}

// ---------- stack markers ----------

export interface StackMarker {
  label: string
  /** Top-level (or repo-relative) files whose presence means this stack. */
  files?: string[]
  /** Top-level file name prefixes (`next.config.` matches next.config.js/mjs/ts). */
  prefixes?: string[]
  /** Repo-relative directories. */
  dirs?: string[]
  /** package.json dependency names (dependencies, devDependencies, peerDependencies). */
  deps?: string[]
  /** A pattern found in one of these manifest files (read capped). */
  text?: { files: string[]; re: RegExp }
}

/** Stack detection, in display order (the first hit leads). Extend by adding rows. */
export const STACK_MARKERS: readonly StackMarker[] = [
  { label: 'Next.js', prefixes: ['next.config.'], deps: ['next'] },
  { label: 'Nuxt', prefixes: ['nuxt.config.'], deps: ['nuxt'] },
  { label: 'Astro', prefixes: ['astro.config.'], deps: ['astro'] },
  { label: 'SvelteKit', prefixes: ['svelte.config.'], deps: ['@sveltejs/kit'] },
  { label: 'Remix', deps: ['@remix-run/react', '@remix-run/node'] },
  { label: 'Vite', prefixes: ['vite.config.'], deps: ['vite'] },
  { label: 'React', deps: ['react'] },
  { label: 'Vue', deps: ['vue'] },
  { label: 'Svelte', deps: ['svelte'] },
  { label: 'Angular', files: ['angular.json'], deps: ['@angular/core'] },
  { label: 'Electron', deps: ['electron'] },
  { label: 'Express', deps: ['express'] },
  { label: 'NestJS', deps: ['@nestjs/core'] },
  { label: 'Tailwind', prefixes: ['tailwind.config.'], deps: ['tailwindcss'] },
  { label: 'TypeScript', files: ['tsconfig.json'], deps: ['typescript'] },
  { label: 'Node.js', files: ['package.json'] },
  { label: 'Python', files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] },
  { label: 'Django', files: ['manage.py'], text: { files: ['requirements.txt', 'pyproject.toml', 'Pipfile'], re: /(^\s*|["'])django\b/im } },
  { label: 'FastAPI', text: { files: ['requirements.txt', 'pyproject.toml', 'Pipfile'], re: /(^\s*|["'])fastapi\b/im } },
  { label: 'Flask', text: { files: ['requirements.txt', 'pyproject.toml', 'Pipfile'], re: /(^\s*|["'])flask\b/im } },
  { label: 'Rust', files: ['Cargo.toml'] },
  { label: 'Axum', text: { files: ['Cargo.toml'], re: /^\s*axum\s*=/m } },
  { label: 'Actix', text: { files: ['Cargo.toml'], re: /^\s*actix-web\s*=/m } },
  { label: 'Go', files: ['go.mod'] },
  { label: 'Ruby', files: ['Gemfile'] },
  { label: 'Rails', text: { files: ['Gemfile'], re: /^\s*gem\s+["']rails["']/m } },
  { label: 'PHP', files: ['composer.json'] },
  { label: 'Laravel', text: { files: ['composer.json'], re: /"laravel\/framework"/ } },
  { label: 'Prisma', files: ['prisma/schema.prisma'], deps: ['prisma', '@prisma/client'] },
  { label: 'Supabase', dirs: ['supabase'], deps: ['@supabase/supabase-js'] },
  { label: 'Postgres', deps: ['pg', 'postgres', '@neondatabase/serverless'], text: { files: ['requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod'], re: /psycopg|asyncpg|sqlx|tokio-postgres|jackc\/pgx|lib\/pq/i } },
  { label: 'Stripe', deps: ['stripe', '@stripe/stripe-js'], text: { files: ['requirements.txt', 'pyproject.toml', 'Gemfile', 'composer.json', 'go.mod', 'Cargo.toml'], re: /\bstripe\b/i } },
  { label: 'Docker', files: ['Dockerfile', 'docker-compose.yml', 'compose.yaml'] },
  { label: 'Vercel', files: ['vercel.json'] },
  { label: 'Netlify', files: ['netlify.toml'] }
]

// ---------- safe reads ----------

/** `rel` resolved inside `root` (a realpath), following symlinks only while they stay inside. null when outside/missing. */
function inside(root: string, rel: string): string | null {
  const p = path.join(root, rel)
  if (!isInside(p, root)) return null
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    return null
  }
  return isInside(real, root) ? real : null
}

/** First `cap` bytes of a regular file inside `root`, as UTF-8. null when missing, not a file or outside the repo. */
function readCapped(root: string, rel: string, cap = SCAN_FILE_CAP): string | null {
  const real = inside(root, rel)
  if (!real) return null
  let fd: number | null = null
  try {
    if (!fs.statSync(real).isFile()) return null
    // O_NONBLOCK + fstat: a file swapped for a FIFO after the stat can't hang the main process
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(cap)
    const n = fs.readSync(fd, buf, 0, cap, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function isFileInside(root: string, rel: string): boolean {
  const real = inside(root, rel)
  try {
    return !!real && fs.statSync(real).isFile()
  } catch {
    return false
  }
}
function isDirInside(root: string, rel: string): boolean {
  const real = inside(root, rel)
  try {
    return !!real && fs.statSync(real).isDirectory()
  } catch {
    return false
  }
}

/** Top-level names (dirs end in `/`), no dotfiles, no node_modules, sorted, ≤ 60. */
function listTop(root: string): string[] {
  const names: string[] = []
  let dir: fs.Dir | null = null
  try {
    dir = fs.opendirSync(root)
    let e: fs.Dirent | null
    let seen = 0
    while ((e = dir.readSync()) && seen++ < LISTING_READ_MAX) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      names.push(e.isDirectory() ? `${e.name}/` : e.name)
    }
  } catch {
    /* unreadable: empty listing */
  } finally {
    try {
      dir?.closeSync()
    } catch {
      /* already closed */
    }
  }
  return names.sort((a, b) => a.localeCompare(b)).slice(0, SCAN_LISTING_MAX)
}

// ---------- README ----------

const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i
const BADGE_HOSTS = /(^|\.)(shields\.io|badgen\.net|badge\.fury\.io|travis-ci\.(org|com)|circleci\.com|codecov\.io|coveralls\.io|github\.com\/[^/]+\/[^/]+\/(actions|workflows)|img\.shields\.io|deepscan\.io|snyk\.io)/i

export interface ReadmeFacts {
  heading?: string
  line?: string
  excerpt?: string
  link?: string
}

/** First heading, first meaningful prose line, first 2 KB and first non-badge https link. Pure. */
export function readmeFacts(text: string): ReadmeFacts {
  const out: ReadmeFacts = {}
  const body = stripAll(text, /<!--[\s\S]*?-->/g)
  out.excerpt = text.slice(0, README_EXCERPT_MAX)
  let inFence = false
  for (const raw of body.split('\n')) {
    const l = raw.trim()
    if (/^(```|~~~)/.test(l)) {
      inFence = !inFence
      continue
    }
    if (inFence || !l) continue
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(l) ?? /^<h[1-6][^>]*>(.*?)<\/h[1-6]>$/i.exec(l)
    if (h) {
      const t = stripMd(h[1])
      if (!out.heading && t) out.heading = t
      continue
    }
    if (out.line) continue
    if (/^(=+|-+|\*{3,}|_{3,}|\|.*\|)$/.test(l)) continue
    if (/^(!\[|\[!\[|<img|<p\b[^>]*>\s*<img|<a\b[^>]*>\s*<img)/i.test(l)) continue
    const t = stripMd(l)
    if (t && /[\p{L}]{2,}/u.test(t) && t.split(/\s+/).length >= 3) out.line = t
  }
  // links: not in code, not a badge (`[![alt](img)](target)`) and not an image
  const prose = body
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
  const linkRe = /https:\/\/[^\s)<>"'\]`]+/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(prose))) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (BADGE_HOSTS.test(url.replace(/^https:\/\//, '')) || /\.(svg|png|jpe?g|gif|webp)(\?|$)/i.test(url)) continue
    out.link = url
    break
  }
  return out
}

function stripMd(s: string): string {
  return stripTags(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^>\s*/, '')
    .replace(/^[-+*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- scan ----------

export interface ScanDeps {
  /** vault.redact (masks every stored secret value). */
  redact?: (text: string) => string
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Credential shapes, URL credentials and vault values masked, then capped. undefined for empty. */
function cleaner(redact: (t: string) => string): (s: unknown, n: number) => string | undefined {
  return (s, n) => {
    if (typeof s !== 'string') return undefined
    const v = redact(redactCredentials(s.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1'))).trim()
    return v ? cap(v, n) : undefined
  }
}
const asHttpUrl = (s: unknown): string | undefined =>
  typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s.trim()) ? cleanRemote(s.trim()) : undefined

function depNames(pkg: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = pkg[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const n of Object.keys(v)) out.add(n)
  }
  return out
}

/** Stack labels for a repo, in STACK_MARKERS order. */
export function detectStack(root: string, top: string[], deps: Set<string>, markers: readonly StackMarker[] = STACK_MARKERS): string[] {
  const topFiles = top.filter((n) => !n.endsWith('/'))
  const texts = new Map<string, string | null>()
  const text = (f: string): string | null => {
    if (!texts.has(f)) texts.set(f, readCapped(root, f))
    return texts.get(f) ?? null
  }
  const out: string[] = []
  for (const m of markers) {
    const hit =
      (m.files ?? []).some((f) => isFileInside(root, f)) ||
      (m.prefixes ?? []).some((p) => topFiles.some((n) => n.startsWith(p) && isFileInside(root, n))) ||
      (m.dirs ?? []).some((d) => isDirInside(root, d)) ||
      (m.deps ?? []).some((d) => deps.has(d)) ||
      (!!m.text && m.text.files.some((f) => {
        const t = text(f)
        return !!t && m.text!.re.test(t)
      }))
    if (hit && !out.includes(m.label)) out.push(m.label)
  }
  return out.slice(0, 30)
}

/** One local repo. Throws only when the folder can't be read at all. */
export function scanRepo(repoPath: string, deps: ScanDeps = {}): RepoScan {
  // never relative to the app's cwd
  if (!path.isAbsolute(repoPath)) throw new Error('not an absolute path')
  const root = fs.realpathSync(repoPath)
  if (!fs.statSync(root).isDirectory()) throw new Error('not a folder')
  const clean = cleaner(deps.redact ?? ((t) => t))

  // the full listing for marker prefixes (before the 60-entry cap), then the capped one for the result
  const topAll: string[] = []
  let dir: fs.Dir | null = null
  try {
    dir = fs.opendirSync(root)
    let e: fs.Dirent | null
    let n = 0
    while ((e = dir.readSync()) && n++ < LISTING_READ_MAX) topAll.push(e.isDirectory() ? `${e.name}/` : e.name)
  } catch {
    /* unreadable */
  } finally {
    try {
      dir?.closeSync()
    } catch {
      /* closed */
    }
  }

  let pkg: Record<string, unknown> = {}
  const pkgText = readCapped(root, 'package.json')
  if (pkgText) {
    try {
      const v = JSON.parse(pkgText) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) pkg = v as Record<string, unknown>
    } catch {
      /* truncated or invalid: no package facts */
    }
  }
  const stack = detectStack(root, topAll, depNames(pkg))

  const readmeName = topAll.filter((n) => !n.endsWith('/') && README_RE.test(n)).sort((a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)))[0]
  const readmeRaw = readmeName ? readCapped(root, readmeName) : null
  // redact the whole capped text first, so a token straddling the excerpt boundary is never half-kept
  const readme = readmeRaw !== null ? readmeFacts(clean(readmeRaw, SCAN_FILE_CAP) ?? '') : {}

  const cnameRaw = readCapped(root, 'CNAME', 1024)?.split('\n')[0]?.trim().toLowerCase()
  const cname = cnameRaw && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(cnameRaw) ? cnameRaw : undefined

  // origin only from a regular .git/config that resolves inside the repo (never fsRepoMeta: it opens README files unchecked)
  const remote = readOriginRemote(root)

  const listing = listTop(root)
    .map((n) => clean(n, 255))
    .filter((n): n is string => !!n)
  const scan: RepoScan = {
    source: 'local',
    label: clean(path.basename(root), 200) ?? 'repo',
    path: clean(root, 4096),
    packageName: clean(pkg.name, 214),
    description: clean(pkg.description, 500),
    homepage: clean(asHttpUrl(pkg.homepage), MAX_URL_LENGTH),
    cname: clean(cname, 253),
    readmeHeading: clean(readme.heading, 200),
    readmeLine: clean(readme.line, 500),
    readmeExcerpt: clean(readme.excerpt, README_EXCERPT_MAX),
    readmeLink: clean(readme.link, MAX_URL_LENGTH),
    remote: clean(remote ?? undefined, MAX_URL_LENGTH),
    stack: stack.map((s) => cap(s, 40)),
    listing
  }
  return dropUndefined(scan)
}

function dropUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

/** Local repos, in order; unreadable ones become warnings. Stops at the deadline (partial). */
export function scanRepos(paths: string[], deps: ScanDeps & { deadline?: number } = {}): { repos: RepoScan[]; warnings: string[]; partial: boolean } {
  const repos: RepoScan[] = []
  const warnings: string[] = []
  const clean = cleaner(deps.redact ?? ((t) => t))
  let partial = false
  for (const p of paths.slice(0, MAX_ONBOARDING_PATHS)) {
    if (deps.deadline !== undefined && Date.now() > deps.deadline) {
      partial = true
      break
    }
    try {
      repos.push(scanRepo(p, deps))
    } catch {
      warnings.push(`Couldn't read ${clean(path.basename(p), 200) ?? 'a folder'}`)
    }
  }
  return { repos, warnings, partial }
}

/** A GitHub repo via `gh api repos/{o}/{r}` and `/readme` (README optional). Throws a HiveError when the repo can't be read. */
export async function scanGithub(fullName: string, deps: ScanDeps & GhDeps & { timeoutMs?: number } = {}): Promise<RepoScan> {
  if (!GITHUB_FULL_NAME.test(fullName)) throw new Error('owner/repo')
  const clean = cleaner(deps.redact ?? ((t) => t))
  const started = Date.now()
  const budget = deps.timeoutMs ?? SCAN_BUDGET_MS
  const repo = (await ghApi(`repos/${fullName}`, { ...deps, timeoutMs: budget })) as Record<string, unknown> | null
  const r = repo && typeof repo === 'object' ? repo : {}
  let readmeText: string | null = null
  const left = budget - (Date.now() - started)
  if (left > 50) {
    try {
      const rd = (await ghApi(`repos/${fullName}/readme`, { ...deps, timeoutMs: left })) as Record<string, unknown> | null
      if (rd && typeof rd.content === 'string' && (rd.encoding === undefined || rd.encoding === 'base64')) {
        readmeText = Buffer.from(rd.content.slice(0, Math.ceil((SCAN_FILE_CAP * 4) / 3) + 4).replace(/\s+/g, ''), 'base64')
          .subarray(0, SCAN_FILE_CAP)
          .toString('utf8')
      }
    } catch {
      /* no README is fine */
    }
  }
  const readme = readmeText !== null ? readmeFacts(clean(readmeText, SCAN_FILE_CAP) ?? '') : {}
  const lang = r.language ?? (r.primaryLanguage && typeof r.primaryLanguage === 'object' ? (r.primaryLanguage as Record<string, unknown>).name : undefined)
  const scan: RepoScan = {
    source: 'github',
    label: clean(fullName, 200) ?? fullName,
    fullName,
    description: clean(r.description, 500),
    homepage: clean(asHttpUrl(r.homepage), MAX_URL_LENGTH),
    readmeHeading: clean(readme.heading, 200),
    readmeLine: clean(readme.line, 500),
    readmeExcerpt: clean(readme.excerpt, README_EXCERPT_MAX),
    readmeLink: clean(readme.link, MAX_URL_LENGTH),
    primaryLanguage: clean(lang, 60),
    remote: clean(asHttpUrl(r.html_url) ?? `https://github.com/${fullName}`, MAX_URL_LENGTH),
    stack: typeof lang === 'string' && lang.trim() ? [cap(lang.trim(), 40)] : [],
    listing: []
  }
  return dropUndefined(scan)
}

/** The draft/plan summary: every repo minus its listing, plus the de-duplicated stack in detection order. */
export function toSummary(repos: RepoScan[]): ScanSummary {
  const summaries: RepoScanSummary[] = repos.slice(0, MAX_ONBOARDING_PATHS).map(({ listing: _listing, ...rest }) => rest)
  const stack: string[] = []
  for (const r of summaries) for (const s of r.stack) if (!stack.includes(s)) stack.push(s)
  return { repos: summaries, stack: stack.slice(0, 30) }
}

/** onboarding:scan: local paths and/or one GitHub repo inside a 5 s budget. Never throws for a single target. */
export async function runScan(req: { paths?: string[]; github?: { fullName: string } }, deps: ScanDeps & GhDeps & { budgetMs?: number } = {}): Promise<ScanResult> {
  const started = Date.now()
  const budget = deps.budgetMs ?? SCAN_BUDGET_MS
  const deadline = started + budget
  const local = scanRepos(req.paths ?? [], { ...deps, deadline })
  const repos = [...local.repos]
  const warnings = [...local.warnings]
  let partial = local.partial
  if (req.github) {
    const left = deadline - Date.now()
    if (left <= 0) partial = true
    else {
      try {
        repos.push(await scanGithub(req.github.fullName, { ...deps, timeoutMs: left }))
      } catch (e) {
        const why = e instanceof Error && /not installed/.test(e.message) ? 'the GitHub CLI is not installed' : e instanceof Error && e.message === 'not found' ? 'not found' : 'GitHub did not answer'
        warnings.push(`Couldn't read ${cleaner(deps.redact ?? ((t) => t))(req.github.fullName, 200) ?? 'the repo'}: ${why}`)
      }
    }
  }
  return { repos, summary: toSummary(repos), warnings, partial, elapsedMs: Date.now() - started }
}
