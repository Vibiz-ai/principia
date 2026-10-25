import { describe, expect, it } from 'vitest'
import { ghAuth, lookupPr, mergePr, parseChangesReview, parsePr, type GhResult, type GhRunner } from './taskWorkGh'

const now = new Date('2026-10-25T00:00:00.000Z')
const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '', missing: false })
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr, missing: false })
const runner = (fn: (args: string[]) => GhResult): GhRunner & { calls: string[][] } => {
  const calls: string[][] = []
  const r = Object.assign(async (args: string[]) => { calls.push(args); return fn(args) }, { calls }) as unknown as GhRunner & { calls: string[][] }
  return r
}

describe('gh pr view parsing', () => {
  it('reads the fields WORKTREE.md uses', () => {
    expect(parsePr(JSON.stringify({ number: 7, url: 'https://github.com/a/b/pull/7', state: 'OPEN', isDraft: false, reviewDecision: '', mergedAt: null }), now)).toEqual({
      number: 7, url: 'https://github.com/a/b/pull/7', state: 'OPEN', isDraft: false, reviewDecision: null, mergedAt: null, checkedAt: now.toISOString()
    })
    expect(parsePr(JSON.stringify({ number: 7, url: 'https://github.com/a/b/pull/7', state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', mergedAt: '2026-10-24T00:00:00Z' }), now)).toMatchObject({ state: 'MERGED', reviewDecision: 'APPROVED', mergedAt: '2026-10-24T00:00:00Z' })
    expect(parsePr('not json', now)).toBeNull()
    expect(parsePr(JSON.stringify({ number: 7, url: 'x', state: 'WEIRD' }), now)).toBeNull()
  })
  it('picks the newest review asking for changes', () => {
    const reviews = [
      { author: { login: 'ana' }, state: 'CHANGES_REQUESTED', body: 'old', submittedAt: '2026-10-24T00:00:00Z' },
      { author: { login: 'bo' }, state: 'APPROVED', body: 'lgtm', submittedAt: '2026-10-24T02:00:00Z' },
      { author: { login: 'cy' }, state: 'CHANGES_REQUESTED', body: 'Rename the flag', submittedAt: '2026-10-24T03:00:00Z' }
    ]
    expect(parseChangesReview(JSON.stringify({ reviews }))).toEqual({ at: '2026-10-24T03:00:00Z', author: 'cy', body: 'Rename the flag' })
    expect(parseChangesReview(JSON.stringify({ reviews: [] }))).toBeNull()
  })
})

describe('gh calls', () => {
  it('signed out and missing are states, not errors', async () => {
    expect(await ghAuth(runner(() => ok('')), '/')).toBe('ok')
    expect(await ghAuth(runner(() => fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')), '/')).toBe('signed_out')
    expect(await ghAuth(runner(() => ({ code: 1, stdout: '', stderr: '', missing: true })), '/')).toBe('missing')
  })
  it('looks the PR up by branch until it is known, then by URL', async () => {
    const r = runner((a) => a.includes('hive/prn-1') ? fail('no pull requests found for branch "hive/prn-1"') : ok(JSON.stringify({ number: 3, url: 'https://github.com/a/b/pull/3', state: 'OPEN', isDraft: true })))
    expect(await lookupPr(r, { cwd: '/w', url: null, branch: 'hive/prn-1' }, now)).toEqual({ kind: 'none' })
    expect(r.calls[0]).toEqual(['pr', 'view', 'hive/prn-1', '--json', 'number,url,state,isDraft,reviewDecision,mergedAt'])
    const found = await lookupPr(r, { cwd: '/w', url: 'https://github.com/a/b/pull/3', branch: 'hive/prn-1' }, now)
    expect(found).toMatchObject({ kind: 'pr', pr: { number: 3, isDraft: true } })
    expect(await lookupPr(runner(() => fail('HTTP 502')), { cwd: '/w', url: null, branch: 'b' }, now)).toEqual({ kind: 'error', message: 'HTTP 502' })
  })
  it('merges by URL with --squash only (never --delete-branch), and names a conflict', async () => {
    const r = runner(() => ok(''))
    expect(await mergePr(r, '/w', 'https://github.com/a/b/pull/3')).toEqual({ kind: 'merged' })
    expect(r.calls[0]).toEqual(['pr', 'merge', 'https://github.com/a/b/pull/3', '--squash'])
    expect(await mergePr(runner(() => fail('X Pull request a/b#3 is not mergeable: the merge commit cannot be cleanly created.')), '/w', 'u')).toEqual({ kind: 'conflict' })
    expect((await mergePr(runner(() => fail('GraphQL: Base branch was modified')), '/w', 'u')).kind).toBe('error')
  })
})
