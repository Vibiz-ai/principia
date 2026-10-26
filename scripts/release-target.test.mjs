import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tagTargetProblem } from './release-target.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('a new tag is created at the built commit once that commit is pushed', () => {
  assert.equal(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: null, shaOnRemote: true }), null)
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: null, shaOnRemote: false }), /not on the release repository/)
})

test('an existing tag must point at the built commit', () => {
  assert.equal(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: A }), null)
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: B }), /v1\.0\.0 points at bbbbbbbbbbbb, not the built commit aaaaaaaaaaaa/)
})

test('CI: the checkout is the pushed tag commit, and the tag exists there', () => {
  assert.equal(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: A, ci: true, githubSha: A }), null)
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: A, ci: true, githubSha: B }), /not the commit this run was triggered for/)
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: A, ci: true }), /no GITHUB_SHA/)
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: A, tagCommit: null, shaOnRemote: true, ci: true, githubSha: A }), /does not exist/)
})

test('an unreadable HEAD never publishes', () => {
  assert.match(tagTargetProblem({ tag: 'v1.0.0', sha: '', tagCommit: null, shaOnRemote: true }), /could not read the built commit/)
})
