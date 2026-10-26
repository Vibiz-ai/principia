/** PLANS.md v2, pure: the experimental flag, a done plan's top line (PR, never a local merge), Pause, Start refusal. */
import { describe, expect, it } from 'vitest'
import { openPrInstructions, plansEnabled, whoseTurn, type Plan } from './plans'
import { canStartWork, type TaskPr } from './taskWork'

const base = (p: Partial<Plan> = {}): Plan => ({
  id: 'plan_1', companyId: 'co_1', repoId: 'repo_1', goal: 'Ship it', autonomy: 'checkins', status: 'done', headAgentId: null, body: '', milestones: [], tasks: [],
  drafting: false, draftError: null, halted: null, changes: [], createdAt: '', updatedAt: '', approvedAt: '', ...p
})
const pr = (state: TaskPr['state']): TaskPr => ({ number: 9, url: 'https://github.com/a/b/pull/9', state, isDraft: false, reviewDecision: null, mergedAt: null, checkedAt: '' })
const result = (o: Partial<NonNullable<Plan['result']>> = {}): NonNullable<Plan['result']> => ({ branch: 'hive/prn-2-m2', taskId: 'task_m2', baseBranch: 'main', pushed: true, pr: null, gh: 'ok', mergedAt: null, error: null, ...o })
const name = () => 'Ada'

describe('PLANS.md v2 shared', () => {
  it('Plans need their own experimental flag on top of the board', () => {
    expect(plansEnabled({ companies: true, departments: true })).toBe(false)
    expect(plansEnabled({ companies: true, departments: true, plans: true })).toBe(true)
    expect(plansEnabled({ companies: true, plans: true })).toBe(false)
    expect(plansEnabled(null)).toBe(false)
  })
  it('a done plan points at its PR and Merge…, never a local merge', () => {
    expect(whoseTurn(base({ result: result({ pr: pr('OPEN') }) }), [], name)).toEqual({ text: 'Your turn: review PR #9 (hive/prn-2-m2) and merge it into main.', who: 'you', action: { kind: 'merge', taskId: 'task_m2' } })
    expect(whoseTurn(base({ result: result() }), [], name)).toEqual({ text: 'Your turn: the work is on hive/prn-2-m2. Open a pull request into main.', who: 'you', action: { kind: 'openPr' } })
    expect(whoseTurn(base({ result: result({ pushed: false, error: 'The repository has no origin remote to push to' }) }), [], name).text).toBe('Your turn: the work is on hive/prn-2-m2, not pushed yet (The repository has no origin remote to push to).')
    expect(whoseTurn(base({ result: result({ pr: pr('MERGED'), mergedAt: 'x' }) }), [], name)).toEqual({ text: 'Done: merged into main (#9).', who: 'nobody', action: null })
    expect(whoseTurn(base({ status: 'archived', result: result({ pr: pr('OPEN') }) }), [], name).text).toBe('Archived: the work is in PR #9 (hive/prn-2-m2), not merged.')
    for (const r of [result(), result({ pr: pr('OPEN') }), result({ pushed: false })]) expect(whoseTurn(base({ result: r }), [], name).text).not.toMatch(/Merge it into|locally/)
  })
  it('Open a PR instructions: push first when not pushed, then gh pr create; never git merge', () => {
    expect(openPrInstructions(result({ pushed: false }))).toEqual(['git push -u origin hive/prn-2-m2', 'gh pr create --head hive/prn-2-m2 --base main'])
    expect(openPrInstructions(result())).toEqual(['gh pr create --head hive/prn-2-m2 --base main'])
    expect(openPrInstructions(result({ branch: null }))).toEqual([])
  })
  it('a paused plan says so', () => {
    expect(whoseTurn(base({ status: 'running', pausedAt: 'x' }), [], name)).toEqual({ text: 'Paused: nothing new starts. Resume it to go on.', who: 'you', action: { kind: 'resume' } })
  })
  it('a plan task never gets a Start of its own (it works in its milestone\'s worktree)', () => {
    expect(canStartWork({ repoId: 'repo_1', status: 'backlog', work: null, plan: { planId: 'plan_1' } }, ['repo_1'])).toBe(false)
    expect(canStartWork({ repoId: 'repo_1', status: 'backlog', work: null }, ['repo_1'])).toBe(true)
  })
})
