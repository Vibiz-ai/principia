/**
 * DASHBOARDS.md §5.5: engineering health for one GitHub repository. With a GITHUB_TOKEN it calls the REST API
 * directly; without one it goes through the signed-in `gh` CLI (`gh api`, as tasks:previewGithub already does), so a
 * founder who ran `gh auth login` adds it with no key at all.
 *
 * Search counts (open PRs, merged PRs, issues) use the search API's total_count; merge times and the weekly series use
 * up to 100 merged PRs of the last 12 weeks; CI success is over the last 50 finished runs on the default branch.
 */
import { execFile } from 'node:child_process'
import type { DashboardSnapshot, TableRow } from '../../../shared/dashboards'
import { configText } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, isoDay, type HttpFn, type HttpRes } from '../http'
import { secretsOf, type DashboardProvider, type ProviderCtx } from './types'

const API = 'https://api.github.com'
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const DAY_MS = 86_400_000

export function repoOf(ctx: Pick<ProviderCtx, 'config'>): string {
  const raw = configText(ctx.config.repo).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  const m = REPO_RE.exec(raw)
  if (!m || ['.', '..'].includes(m[1]) || ['.', '..'].includes(m[2])) throw new DashboardFetchError('config', 'Set the repository as owner/name (for example vercel/next.js).')
  return raw
}

/**
 * The transport for this context: the token over fetch when set, else `gh`. Throws a config error when neither exists.
 */
function transport(ctx: ProviderCtx): { http: HttpFn; headers: Record<string, string> } {
  const token = ctx.keys.GITHUB_TOKEN
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) return { http: ctx.http, headers: { ...headers, Authorization: `Bearer ${token}` } }
  if (ctx.gh) return { http: ctx.gh, headers }
  throw new DashboardFetchError('config', 'Add a GitHub token, or install the GitHub CLI and run gh auth login.')
}

const hints = (repo: string, viaCli: boolean) => ({
  ...(viaCli ? { invalid_key: 'With no token, Principia uses the GitHub CLI: run gh auth login in Terminal, then refresh.' } : {}),
  config: `GitHub cannot see ${repo}. Check the name, and that the token (or gh sign-in) has access to it.`,
  forbidden: 'The token is missing a permission: give it read access to Pull requests, Issues, Actions and Metadata.'
})

async function gh<T>(ctx: ProviderCtx, path: string, repo: string): Promise<T> {
  const t = transport(ctx)
  return getJson<T>(t.http, { url: `${API}${path}`, headers: t.headers }, { provider: 'GitHub', secrets: secretsOf(ctx), hints: hints(repo, !ctx.keys.GITHUB_TOKEN) })
}

interface SearchItem {
  title: string
  html_url?: string
  created_at: string
  closed_at: string | null
  user?: { login?: string } | null
  pull_request?: { merged_at?: string | null } | null
}
interface SearchRes {
  total_count: number
  items?: SearchItem[]
}
interface Run {
  name?: string | null
  head_branch?: string | null
  status: string
  conclusion: string | null
  created_at: string
}

const search = (ctx: ProviderCtx, repo: string, q: string, perPage = 1): Promise<SearchRes> =>
  gh<SearchRes>(ctx, `/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}&per_page=${perPage}`, repo)

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Hours between created and merged, for PRs merged in (from, to]. */
export function mergeHours(items: SearchItem[], from: number, to: number): number[] {
  return items.flatMap((i) => {
    const merged = i.pull_request?.merged_at ? Date.parse(i.pull_request.merged_at) : NaN
    return merged > from && merged <= to ? [(merged - Date.parse(i.created_at)) / 3_600_000] : []
  })
}

/** Merged PRs per week, 12 weeks ending now, oldest first (week label = its first day). */
export function weeklyMerged(items: SearchItem[], now: Date, weeks = 12): { t: string; v: number }[] {
  const end = now.getTime()
  return Array.from({ length: weeks }, (_, i) => {
    const to = end - (weeks - 1 - i) * 7 * DAY_MS
    const from = to - 7 * DAY_MS
    const v = items.filter((it) => {
      const m = it.pull_request?.merged_at ? Date.parse(it.pull_request.merged_at) : NaN
      return m > from && m <= to
    }).length
    return { t: new Date(from + DAY_MS).toISOString().slice(0, 10), v }
  })
}

/** Success share over finished runs (cancelled and skipped runs do not count). */
export function ciSuccess(runs: Run[]): number | null {
  const done = runs.filter((r) => r.status === 'completed' && r.conclusion && !['cancelled', 'skipped', 'neutral'].includes(r.conclusion))
  return done.length ? done.filter((r) => r.conclusion === 'success').length / done.length : null
}

const age = (iso: string, now: Date): string => {
  const h = (now.getTime() - Date.parse(iso)) / 3_600_000
  return h < 48 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} d`
}

export const githubProvider: DashboardProvider = {
  kind: 'github',
  async validate(ctx) {
    const repo = repoOf(ctx)
    await gh(ctx, `/repos/${repo}`, repo)
  },
  async fetch(ctx) {
    const repo = repoOf(ctx)
    const now = ctx.now
    const d30 = isoDay(now, 30)
    const d60 = isoDay(now, 60)
    const d84 = isoDay(now, 84)
    const meta = await gh<{ default_branch?: string }>(ctx, `/repos/${repo}`, repo)
    const branch = meta.default_branch ?? 'main'
    const [open, merged30, merged60, merged84, openIssues, closed30, closed60, runs, waiting] = await Promise.all([
      search(ctx, repo, 'is:pr is:open'),
      search(ctx, repo, `is:pr is:merged merged:>=${d30}`),
      search(ctx, repo, `is:pr is:merged merged:${d60}..${isoDay(now, 31)}`),
      search(ctx, repo, `is:pr is:merged merged:>=${d84}`, 100),
      search(ctx, repo, 'is:issue is:open'),
      search(ctx, repo, `is:issue is:closed closed:>=${d30}`),
      search(ctx, repo, `is:issue is:closed closed:${d60}..${isoDay(now, 31)}`),
      gh<{ workflow_runs?: Run[] }>(ctx, `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`, repo),
      search(ctx, repo, 'is:pr is:open sort:created-asc', 8)
    ])
    const items = merged84.items ?? []
    const t = now.getTime()
    const hours = median(mergeHours(items, t - 30 * DAY_MS, t))
    const hoursPrev = median(mergeHours(items, t - 60 * DAY_MS, t - 30 * DAY_MS))
    const runList = runs.workflow_runs ?? []
    const runRows: TableRow[] = runList.slice(0, 8).map((r) => ({
      workflow: r.name ?? 'Workflow',
      branch: r.head_branch ?? branch,
      result: r.status === 'completed' ? (r.conclusion ?? 'done') : r.status,
      when: `${age(r.created_at, now)} ago`
    }))
    const warnings: string[] = []
    if (merged84.total_count > items.length) warnings.push(`Merge times and the weekly chart use the latest ${items.length} of ${merged84.total_count} merged PRs.`)
    return {
      fetchedAt: now.toISOString(),
      period: `${repo} · last 30 days vs the 30 before`,
      kpis: {
        openPrs: { value: open.total_count, previous: null },
        mergedPrs: { value: merged30.total_count, previous: merged60.total_count },
        // hours → seconds, the duration format's unit
        timeToMerge: { value: hours == null ? null : hours * 3600, previous: hoursPrev == null ? null : hoursPrev * 3600 },
        ciSuccess: { value: ciSuccess(runList), previous: null },
        openIssues: { value: openIssues.total_count, previous: null },
        issuesClosed: { value: closed30.total_count, previous: closed60.total_count }
      },
      series: { mergedWeekly: [{ label: 'Merged PRs', points: weeklyMerged(items, now) }] },
      tables: {
        runs: runRows,
        waiting: (waiting.items ?? []).map((i) => ({ title: i.title, author: i.user?.login ?? '—', age: age(i.created_at, now) }))
      },
      ...(warnings.length ? { warnings } : {})
    } satisfies DashboardSnapshot
  }
}

// ---------- gh CLI transport ----------

/** HTTP status from a failed `gh api` call's stderr ("HTTP 404: Not Found"), else 0. */
export function ghStatus(stderr: string): number {
  const m = /HTTP (\d{3})/.exec(stderr)
  if (m) return Number(m[1])
  if (/rate limit/i.test(stderr)) return 429
  if (/auth login|not logged|authentication/i.test(stderr)) return 401
  return 0
}

/**
 * `gh api` as an HttpFn for api.github.com GET URLs. The CLI holds the credentials; nothing is passed to it but the
 * path. null when `gh` is not installed or not signed in is decided per call (a 401 status).
 */
export function ghCliHttp(env: () => Record<string, string>, bin = 'gh'): HttpFn {
  return (req) =>
    new Promise<HttpRes>((resolve, reject) => {
      const u = new URL(req.url)
      if (u.origin !== API || (req.method && req.method !== 'GET')) return reject(new DashboardFetchError('config', 'Only GitHub API reads go through gh.'))
      execFile(
        bin,
        ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', `${u.pathname.slice(1)}${u.search}`],
        { env: { ...env(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }, timeout: req.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new DashboardFetchError('config', 'Add a GitHub token, or install the GitHub CLI and run gh auth login.'))
          if (err) {
            const status = ghStatus(String(stderr))
            if (!status) return reject(new DashboardFetchError('network', 'The GitHub CLI could not reach GitHub.'))
            let body: unknown = null
            try {
              body = JSON.parse(stdout)
            } catch {
              body = null
            }
            return resolve({ status, body, retryAfter: null })
          }
          try {
            resolve({ status: 200, body: JSON.parse(stdout), retryAfter: null })
          } catch {
            reject(new DashboardFetchError('unavailable', 'The GitHub CLI returned something that is not JSON.'))
          }
        }
      )
    })
}
