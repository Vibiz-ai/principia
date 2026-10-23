import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HiveError } from '../../shared/errors'
import type { GithubTaskPreview } from '../../shared/company'
const execute = promisify(execFile)
const issueSchema = z.object({ title: z.string().min(1), body: z.string().nullable(), html_url: z.string().url(), number: z.number().int().positive() })
export function githubIssuePath(url: string): { apiPath: string; canonicalUrl: string } {
  let u: URL
  try { u = new URL(url) } catch { throw new HiveError('bad_request', 'Paste a GitHub issue or pull request URL') }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(u.pathname)
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || !match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) {
    throw new HiveError('bad_request', 'Use https://github.com/owner/repository/issues/123 (or /pull/123)')
  }
  return { apiPath: `repos/${match[1]}/${match[2]}/issues/${match[4]}`, canonicalUrl: `https://github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}` }
}
export function parseGithubIssue(raw: string, expectedUrl: string): GithubTaskPreview {
  let data: z.infer<typeof issueSchema>
  try { data = issueSchema.parse(JSON.parse(raw)) } catch { throw new HiveError('bad_request', 'GitHub returned an invalid issue') }
  const expected = githubIssuePath(expectedUrl)
  const actual = githubIssuePath(data.html_url)
  if (actual.apiPath.toLowerCase() !== expected.apiPath.toLowerCase()) throw new HiveError('bad_request', 'GitHub returned a different issue')
  return { title: data.title.slice(0, 240), description: (data.body ?? '').slice(0, 50_000), source: 'github', sourceUrl: actual.canonicalUrl, externalId: actual.apiPath, truncated: data.title.length > 240 || (data.body?.length ?? 0) > 50_000 }
}
/** Read only; uses the machine's authenticated GitHub CLI. The caller previews and saves explicitly. */
export async function previewGithubIssue(url: string, env: Record<string, string>): Promise<GithubTaskPreview> {
  const issue = githubIssuePath(url)
  let raw: string
  try {
    const result = await execute('gh', ['api', '--hostname', 'github.com', issue.apiPath], { env: { ...env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
    raw = result.stdout
  } catch {
    throw new HiveError('bad_request', 'Could not read this GitHub issue. Check the URL and repository access, and sign in with gh auth login in your terminal. Nothing has been imported.')
  }
  return parseGithubIssue(raw, issue.canonicalUrl)
}
