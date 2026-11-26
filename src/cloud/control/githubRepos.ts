/**
 * The repositories a New chat can start in (docs/CLOUD-PHONE.md): what the cloud's GitHub sign-in reaches, the most
 * recently pushed first. Asked of GitHub at most every 5 minutes; a failure keeps the last list.
 */
const TTL_MS = 5 * 60_000
const MAX = 100

export function githubRepos(token: () => string | null, f: typeof fetch, now: () => number = Date.now): () => Promise<string[]> {
  let cache: { at: number; token: string; list: string[] } | null = null
  let inflight: Promise<string[]> | null = null
  return async () => {
    const t = token()
    if (!t) return []
    if (cache && cache.token === t && now() - cache.at < TTL_MS) return cache.list
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await f(`https://api.github.com/user/repos?sort=pushed&per_page=${MAX}&affiliation=owner,collaborator,organization_member`, {
          headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'user-agent': 'principia-cloud', 'x-github-api-version': '2022-11-28' },
          signal: AbortSignal.timeout(10_000)
        })
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
        const rows = (await res.json()) as { full_name?: unknown; archived?: unknown }[]
        const list = rows.filter((r) => typeof r.full_name === 'string' && !r.archived).map((r) => r.full_name as string)
        cache = { at: now(), token: t, list }
        return list
      } catch (e) {
        if (cache && cache.token === t) return cache.list
        throw e
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}
