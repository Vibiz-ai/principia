/**
 * docs/RELEASING.md §5: the release tag names the commit the binaries were built from. `gh release create` alone
 * creates a missing tag from the default branch's latest state, which may be another commit by the time the build
 * is notarized, so release-mac.mjs passes the built SHA as --target and checks an existing tag with this.
 *
 * Returns null when publishing `tag` would describe the built commit, otherwise the reason it would not.
 *   sha          full SHA of the built HEAD
 *   tagCommit    full SHA the tag points at on the release repository, or null when the tag does not exist
 *   shaOnRemote  the release repository has the built commit (a new tag can only point at a pushed commit)
 *   ci           GitHub Actions run started by pushing the tag; githubSha is that run's GITHUB_SHA
 */
export function tagTargetProblem({ tag, sha, tagCommit, shaOnRemote, ci = false, githubSha = null }) {
  const short = (s) => String(s).slice(0, 12)
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return `could not read the built commit (${sha || 'no HEAD'})`
  if (ci && githubSha !== sha) return `the checkout (${short(sha)}) is not the commit this run was triggered for (${githubSha ? short(githubSha) : 'no GITHUB_SHA'})`
  if (tagCommit) return tagCommit === sha ? null : `${tag} points at ${short(tagCommit)}, not the built commit ${short(sha)}`
  if (ci) return `${tag} does not exist on the release repository, but this run was started by pushing it`
  return shaOnRemote ? null : `${short(sha)} is not on the release repository: push it first, the new ${tag} is created at the built commit`
}
