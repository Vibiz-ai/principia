/**
 * PLANS.md §2.4 and §2.6: where a plan's code lives, on top of the worktree track (WORKTREE.md). There is no second
 * worktree system: each milestone's worktree is its milestone task's `work` binding (TaskWorkService.bind →
 * WorktreeManager.ensureTask: `<userData>/worktrees/task-<ID>` on `hive/<id>-<slug>`, the push guard, one owner row,
 * one sweep rule). The milestone's plan tasks run in that worktree (TaskWorkService.workdir follows the owner).
 *
 * Git here runs only inside Hive's worktrees, never in the founder's checkout: a milestone that depends on several
 * starts from the first dependency's branch and merges the others in its own new worktree; when the plan is done the
 * other leaf milestones are merged into the first leaf's worktree, that branch is pushed (hive/* only, through the
 * worktree's pre-push guard) and a pull request is opened with gh. Merging the PR is the founder's (Merge… on the
 * worktree track: gh pr merge after a native confirm). Nothing here ever merges into the base branch.
 */
import fs from 'node:fs'
import { HiveError } from '../../shared/errors'
import { workStarted, type GhState, type TaskPr, type TaskWork } from '../../shared/taskWork'
import type { GitRunner } from '../worktrees'
import type { CompanyStore } from './index'
import type { TaskWorkService } from './taskWork'
import { createPr, type GhRunner } from './taskWorkGh'

export interface MilestoneTree { path: string; branch: string }
/** What git says about a milestone's worktree: the gate has no tools, so it gets these facts in its prompt. */
export interface MilestoneGit { branch: string; commits: string[]; uncommitted: string[] }
export interface PlanPublish { pushed: boolean; pr: TaskPr | null; gh: GhState | null; error: string | null }

/** What the plan pilot needs from git and gh. The real one is `taskPlanWork`; tests may fake it. */
export interface PlanWork {
  /**
   * The milestone task's worktree, created on first use. `from`: the milestone tasks it depends on (the first one's
   * branch is the start point, the others are merged in, inside the new worktree). null: the task has no repository.
   */
  ensure(milestoneTaskId: string, from: string[], label: string): Promise<MilestoneTree | null>
  /** `git diff --stat` plus the head of the diff against the milestone's start, for the gate check ('' when unknown). */
  diff(milestoneTaskId: string, maxChars?: number): Promise<string>
  /** The milestone branch's own commits since its start and the uncommitted files, for the gate (null when unknown). */
  gitState?(milestoneTaskId: string): Promise<MilestoneGit | null>
  /** Commits what the agent left uncommitted in the milestone's worktree (so its branch holds all of it). */
  commitLeftovers(milestoneTaskId: string, message: string): Promise<boolean>
  /** One branch with the whole plan: the other leaves merged into the first leaf's worktree. */
  collect(leafTaskIds: string[], label: string): Promise<{ taskId: string; branch: string }>
  /** Pushes that branch (guarded, hive/* only) and opens the pull request into `base`. Never merges. */
  publish(taskId: string, q: { base: string; title: string; body: string }): Promise<PlanPublish>
  /** After the PR merged: the milestone's worktree goes when nothing would be lost (WORKTREE.md's rule). */
  cleanup?(milestoneTaskId: string): Promise<void>
}

const short = (s: string) => s.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? ''

export function taskPlanWork(d: { company: () => CompanyStore; work: () => TaskWorkService; git: GitRunner; gh: GhRunner }): PlanWork {
  const bound = (taskId: string): TaskWork => {
    const w = d.company().task(taskId).work
    if (!w || !workStarted(w) || !fs.existsSync(w.worktreePath)) throw new HiveError('bad_request', 'The milestone worktree is not there')
    return w
  }
  /** A commit identity for repos (and test envs) with none configured; the founder's own config wins. */
  const who = async (cwd: string): Promise<string[]> => {
    const r = await d.git(['config', 'user.email'], { cwd })
    return r.code === 0 && r.stdout.trim() ? [] : ['-c', 'user.name=Principia', '-c', 'user.email=principia@localhost']
  }
  /** Merges `branches` into the worktree at `cwd`; a conflict aborts the merge and throws with the files. */
  const mergeIn = async (cwd: string, branches: string[], message: (b: string) => string): Promise<void> => {
    for (const b of branches) {
      const r = await d.git([...(await who(cwd)), 'merge', '--no-ff', '-m', message(b), b], { cwd, timeoutMs: 120_000 })
      if (r.code === 0) continue
      const u = await d.git(['diff', '--name-only', '--diff-filter=U'], { cwd })
      const files = u.stdout.trim().split('\n').filter(Boolean).slice(0, 8).join(', ')
      await d.git(['merge', '--abort'], { cwd })
      throw new Error(files ? `merging ${b} conflicts in ${files}` : `merging ${b} failed: ${short(r.stderr || r.stdout)}`)
    }
  }
  const commitLeftovers = async (taskId: string, message: string): Promise<boolean> => {
    let w: TaskWork
    try { w = bound(taskId) } catch { return false }
    const st = await d.git(['status', '--porcelain'], { cwd: w.worktreePath })
    if (st.code !== 0 || !st.stdout.trim()) return false
    await d.git(['add', '-A'], { cwd: w.worktreePath })
    return (await d.git([...(await who(w.worktreePath)), 'commit', '-q', '-m', message], { cwd: w.worktreePath })).code === 0
  }
  return {
    async ensure(taskId, from, label) {
      const t = d.company().task(taskId)
      if (!t.repoId) return null
      if (workStarted(t.work) && fs.existsSync(t.work!.worktreePath)) return { path: t.work!.worktreePath, branch: t.work!.branch }
      // the dependencies' work first: their leftovers committed, so their branches hold all of it
      const deps: string[] = []
      for (const id of from) {
        await commitLeftovers(id, `Plan: leftover changes before ${label}`)
        const w = d.company().task(id).work
        if (!w?.branch) throw new HiveError('bad_request', `${label} waits for a milestone that has no branch yet`)
        deps.push(w.branch)
      }
      const { work, created } = await d.work().bind(taskId, deps[0] ?? null)
      if (created && deps.length > 1) {
        try {
          await mergeIn(work.worktreePath, deps.slice(1), (b) => `Plan ${label}: start from ${b}`)
          // every dependency is in now: the gate measures from here, so their work is not counted as this milestone's
          const head = await d.git(['rev-parse', 'HEAD'], { cwd: work.worktreePath })
          if (head.code === 0 && head.stdout.trim()) d.work().writeWork(taskId, { baseSha: head.stdout.trim() })
        } catch (err) {
          const why = `${label} needs the work of ${deps.length} milestones, and ${(err as Error).message}. Resolve it by hand, or make ${label} depend on one milestone.`
          await d.work().unbind(taskId, `The worktree for ${label} was taken away again: ${why}`)
          throw new HiveError('conflict', why)
        }
      }
      return { path: work.worktreePath, branch: work.branch }
    },
    async diff(taskId, maxChars = 6000) {
      let w: TaskWork
      try { w = bound(taskId) } catch { return '' }
      const base = w.baseSha ?? 'HEAD'
      const [stat, body, untracked] = await Promise.all([
        d.git(['diff', '--stat', base], { cwd: w.worktreePath }),
        d.git(['diff', base], { cwd: w.worktreePath }),
        d.git(['ls-files', '--others', '--exclude-standard'], { cwd: w.worktreePath })
      ])
      const parts = [stat.stdout.trim(), untracked.stdout.trim() ? `Untracked:\n${untracked.stdout.trim().split('\n').slice(0, 40).join('\n')}` : '', body.stdout.slice(0, maxChars)]
      return parts.filter(Boolean).join('\n\n').slice(0, maxChars + 2000)
    },
    async gitState(taskId) {
      let w: TaskWork
      try { w = bound(taskId) } catch { return null }
      const range = w.baseSha ? `${w.baseSha}..HEAD` : 'HEAD'
      const [log, st] = await Promise.all([
        d.git(['log', '--oneline', '--no-decorate', '-n', '30', range], { cwd: w.worktreePath }),
        d.git(['status', '--porcelain'], { cwd: w.worktreePath })
      ])
      if (log.code !== 0 || st.code !== 0) return null
      const lines = (x: string) => x.split('\n').map((l) => l.trimEnd()).filter(Boolean)
      return { branch: w.branch, commits: lines(log.stdout), uncommitted: lines(st.stdout).slice(0, 40) }
    },
    commitLeftovers,
    async collect(leaves, label) {
      if (!leaves.length) throw new HiveError('bad_request', 'The plan has no milestone work to collect')
      for (const id of leaves) await commitLeftovers(id, `Plan: leftover changes (${label})`)
      const first = bound(leaves[0])
      const others = leaves.slice(1).map((id) => d.company().task(id).work?.branch).filter((b): b is string => !!b)
      if (others.length) {
        // already merged in by an earlier collect: merging again is a no-op
        await mergeIn(first.worktreePath, others, (b) => `Plan: bring in ${b}`)
      }
      return { taskId: leaves[0], branch: first.branch }
    },
    async publish(taskId, q) {
      const w = bound(taskId)
      // the guarded push rules: only Hive's own hive/* branches, never the base, never force
      if (!w.branch.startsWith('hive/')) return { pushed: false, pr: null, gh: null, error: `${w.branch} is not a hive/ branch; Principia only pushes its own branches` }
      const remotes = await d.git(['remote'], { cwd: w.worktreePath })
      if (!remotes.stdout.split('\n').map((s) => s.trim()).includes('origin')) return { pushed: false, pr: null, gh: null, error: 'The repository has no origin remote to push to' }
      // the worktree's own core.hooksPath runs the pre-push guard (hive/* only, protected branches, no deletes)
      const push = await d.git(['push', '-u', 'origin', `HEAD:refs/heads/${w.branch}`], { cwd: w.worktreePath, timeoutMs: 120_000 })
      if (push.code !== 0) return { pushed: false, pr: null, gh: null, error: `The push was refused: ${short(push.stderr || push.stdout) || `git exited ${push.code}`}` }
      const gh = await d.work().ghReady(w.worktreePath)
      if (gh !== 'ok') return { pushed: true, pr: null, gh, error: null }
      const made = await createPr(d.gh, w.worktreePath, { head: w.branch, base: q.base, title: q.title, body: q.body })
      if (made.kind === 'missing') return { pushed: true, pr: null, gh: 'missing', error: null }
      if (made.kind === 'error') return { pushed: true, pr: null, gh: 'ok', error: `gh could not open the pull request: ${made.message}` }
      const pr = await d.work().recordPr(taskId, made.kind === 'created' ? made.url : null)
      return pr ? { pushed: true, pr, gh: 'ok', error: null } : { pushed: true, pr: null, gh: 'ok', error: 'The pull request was opened but gh could not read it back' }
    },
    async cleanup(taskId) {
      const w = d.company().task(taskId).work
      if (workStarted(w)) await d.work().cleanupMerged(taskId)
    }
  }
}
