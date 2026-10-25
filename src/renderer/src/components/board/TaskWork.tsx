import { useMemo, useState } from 'react'
import type { CompanyPassport, CompanyTask } from '@shared/company'
import type { Repo } from '@shared/types'
import { GH_TEXT, canStartWork, prChip, workGone, workQueued, workStarted } from '@shared/taskWork'
import { Button } from '../ui'
import { errorMessage, hive } from '../../lib/hive'
import { reposOf } from '../../lib/companyModel'
import { toast, useStore } from '../../state/store'
import '../../styles/taskWork.css'

/** WORKTREE.md: a git branch in white line art (the board card, the strip, the Work section). */
export function BranchGlyph({ size = 12 }: { size?: number }): React.JSX.Element {
  return <svg className="work-branch-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden>
    <circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5.5" r="1.6" />
    <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.2-5.4 4.1" />
  </svg>
}

/** The PR chip: "#42 Open", "#42 Changes requested", "#42 Merged" (greys plus colour only for meaning). */
export function PrChip({ task }: { task: CompanyTask }): React.JSX.Element | null {
  const chip = prChip(task.work?.pr)
  if (!chip) return null
  return <span className={`work-pr-chip work-pr-chip--${chip.tone}`}>{chip.label}</span>
}

/** Board card: a branch glyph, and the PR number once there is one. */
export function WorkCardBadge({ task }: { task: CompanyTask }): React.JSX.Element | null {
  const w = task.work
  if (!w || (!workStarted(w) && !workQueued(w) && !w.pr)) return null
  return <span className="work-card-badge" title={workQueued(w) ? 'Queued for a free seat' : w.branch}>
    <BranchGlyph size={11} />{w.pr ? `#${w.pr.number}` : workQueued(w) ? 'queued' : null}
  </span>
}

/**
 * The repositories of a company as of now: its Passport's list plus the live repo list (a repo added a moment ago is
 * Personal's at once, before the company rows reload). Main checks again on Start.
 */
export function companyRepoIds(company: CompanyPassport | undefined, repos: Repo[]): string[] {
  return company ? [...new Set([...company.repoIds, ...reposOf(repos, company.id).map((r) => r.id)])] : []
}
export function useCompanyRepoIds(company: CompanyPassport | undefined): string[] {
  const repos = useStore((s) => s.repos)
  return useMemo(() => companyRepoIds(company, repos), [company, repos])
}

/**
 * The inspector header's one main action: Start (white outline) for a code task not started yet; once started, the
 * same spot shows the PR state. Hidden for a task without a repository of its company.
 */
export function WorkStart({ task, company, busy, onDone }: { task: CompanyTask; company: CompanyPassport | undefined; busy: boolean; onDone: () => void }): React.JSX.Element | null {
  const [working, setWorking] = useState(false)
  const repoIds = useCompanyRepoIds(company)
  const w = task.work
  if (w && (workStarted(w) || workQueued(w))) {
    const chip = prChip(w.pr)
    return <div className="work-start work-start--state">
      {chip ? <PrChip task={task} /> : <span className="work-pr-chip work-pr-chip--idle">{workQueued(w) ? 'Waiting for a free seat' : 'No pull request yet'}</span>}
    </div>
  }
  if (!company || !canStartWork(task, repoIds)) return null
  const start = async (): Promise<void> => {
    setWorking(true)
    try {
      const r = await hive.taskWork.start({ id: task.id })
      toast(r.message)
      onDone()
    } catch (e) { toast(errorMessage(e), 'error') } finally { setWorking(false) }
  }
  return <div className="work-start">
    <Button className="work-start__btn" icon="play" disabled={busy || working} onClick={() => void start()}>{working ? 'Starting…' : 'Start'}</Button>
    <span className="work-start__sub">{w?.startedAt ? `Checks out ${w.branch} in a new worktree.` : 'Opens a new branch and worktree.'} Your checkout is not touched.</span>
  </div>
}

/** Why Merge… is (not) available: an agent at work comes first, then a draft. */
export function mergeTitle(inFlight: boolean, draft: boolean): string {
  if (inFlight) return 'An agent is working on this task. Merge once it is In Review.'
  if (draft) return 'The pull request is a draft'
  return 'Squash-merge it on GitHub (a confirm comes first)'
}

/**
 * Under the title: the gone banner (Cancel Task · Back to Backlog · Keep As Is), then branch (mono), worktree path,
 * PR chip and gh state, and Open in Editor · Open PR · Merge… · Remove Worktree….
 */
export function WorkSection({ task, onDone }: { task: CompanyTask; onDone: () => void }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const w = task.work
  // a task that had a worktree keeps its branch line after Keep As Is or Remove Worktree…
  if (!w || (!workStarted(w) && !workQueued(w) && !w.pr && !w.startedAt)) return null
  const run = async (fn: () => Promise<unknown>, done?: (r: unknown) => string | null): Promise<void> => {
    setBusy(true)
    try { const r = await fn(); const m = done?.(r); if (m) toast(m); onDone() } catch (e) { toast(errorMessage(e), 'error') } finally { setBusy(false) }
  }
  const started = workStarted(w)
  const gone = workGone(w)
  const pr = w.pr
  const inFlight = task.status === 'in_progress'
  const ghNote = w.gh && w.gh !== 'ok' ? GH_TEXT[w.gh] : null
  return <section className="work-section" aria-label="Work">
    {gone && <div className="work-gone" role="alert">
      <span>The worktree for {task.identifier} is gone.</span>
      <span className="work-gone__actions">
        <button className="link-btn" disabled={busy} onClick={() => void run(() => hive.taskWork.resolveGone({ id: task.id, choice: 'cancel' }), () => `Canceled ${task.identifier}`)}>Cancel Task</button>
        <span aria-hidden>·</span>
        <button className="link-btn" disabled={busy} onClick={() => void run(() => hive.taskWork.resolveGone({ id: task.id, choice: 'backlog' }), () => `${task.identifier} is back in Backlog`)}>Back to Backlog</button>
        <span aria-hidden>·</span>
        <button className="link-btn" disabled={busy} onClick={() => void run(() => hive.taskWork.resolveGone({ id: task.id, choice: 'keep' }), () => null)}>Keep As Is</button>
      </span>
    </div>}
    <div className="work-section__row">
      <BranchGlyph />
      <code className="work-section__branch selectable" title={w.branch}>{w.branch}</code>
      <PrChip task={task} />
    </div>
    {started && !gone && <div className="work-section__path selectable" title={w.worktreePath}>{w.worktreePath}</div>}
    {workQueued(w) && <div className="work-section__note">Queued: it starts when a running task finishes.</div>}
    {w.removedAt && !gone && <div className="work-section__note">{task.status === 'done' || task.status === 'canceled' ? 'Worktree removed.' : `Worktree removed. Start (or Run now) checks out ${w.branch} again.`}</div>}
    {ghNote && <div className="work-section__note">{ghNote}. Statuses do not move by themselves until it is.</div>}
    {w.conflict && pr?.state === 'OPEN' && <div className="work-section__note work-section__note--failed">Merge conflict, open in editor.</div>}
    {w.error && !ghNote && !w.conflict && <div className="work-section__note">{w.error}</div>}
    <div className="work-section__actions">
      {[
        started && !gone && <button key="editor" className="link-btn" disabled={busy} onClick={() => void run(() => hive.taskWork.openEditor({ id: task.id }), (r) => (r as { opened: string }).opened === 'finder' ? 'Opened in Finder' : null)}>Open in Editor</button>,
        pr && <button key="pr" className="link-btn" disabled={busy} onClick={() => void run(() => hive.app.openExternal({ url: pr.url }))}>Open PR</button>,
        // A1: never while an agent works on it (it may still be pushing to the branch). The tooltip sits on a wrapper:
        // a disabled button gets no pointer events
        pr?.state === 'OPEN' && <span key="merge" className="work-section__merge" title={mergeTitle(inFlight, pr.isDraft)}><button className="link-btn" disabled={busy || pr.isDraft || inFlight} title={mergeTitle(inFlight, pr.isDraft)} onClick={() => void run(() => hive.taskWork.merge({ id: task.id }), (r) => (r ? (r as { message: string }).message : null))}>Merge…</button></span>,
        // a gone worktree has nothing to remove: the banner above offers what to do instead (QA)
        started && !gone && <button key="remove" className="link-btn" disabled={busy || inFlight} title={inFlight ? 'Stop the agent first' : 'Lists what would be lost first'} onClick={() => void run(() => hive.taskWork.remove({ id: task.id }), (r) => (r ? 'Worktree removed' : null))}>Remove Worktree…</button>
      ].filter(Boolean).flatMap((el, i) => (i ? [<span key={`sep${i}`} aria-hidden>·</span>, el] : [el]))}
    </div>
  </section>
}
