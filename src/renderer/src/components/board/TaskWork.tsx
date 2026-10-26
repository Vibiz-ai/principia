import { useMemo, useState } from 'react'
import type { CompanyPassport, CompanyTask } from '@shared/company'
import type { Repo } from '@shared/types'
import { GH_TEXT, canStartWork, prChip, workGone, workQueued, workStarted } from '@shared/taskWork'
import { Button, IconButton } from '../ui'
import { errorMessage, hive } from '../../lib/hive'
import { reposOf } from '../../lib/companyModel'
import { branchFor, nextWorkStep, workSteps } from '../../lib/boardFlow'
import { focusSession, navigate, toast, useStore } from '../../state/store'
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
export function WorkSection({ task, onDone, compact = false }: { task: CompanyTask; onDone: () => void; /** five doors: the WorkFlow block above already shows the branch, the PR and its button */ compact?: boolean }): React.JSX.Element | null {
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
    {!compact && <div className="work-section__row">
      <BranchGlyph />
      <code className="work-section__branch selectable" title={w.branch}>{w.branch}</code>
      <PrChip task={task} />
    </div>}
    {started && !gone && <div className="work-section__path selectable" title={w.worktreePath}>{w.worktreePath}</div>}
    {workQueued(w) && <div className="work-section__note">Queued: it starts when a running task finishes.</div>}
    {w.removedAt && !gone && <div className="work-section__note">{task.status === 'done' || task.status === 'canceled' ? 'Worktree removed.' : `Worktree removed. Start (or Run now) checks out ${w.branch} again.`}</div>}
    {ghNote && <div className="work-section__note">{ghNote}. Statuses do not move by themselves until it is.</div>}
    {w.conflict && pr?.state === 'OPEN' && <div className="work-section__note work-section__note--failed">Merge conflict, open in editor.</div>}
    {w.error && !ghNote && !w.conflict && <div className="work-section__note">{w.error}</div>}
    <div className="work-section__actions">
      {[
        started && !gone && <button key="editor" className="link-btn" disabled={busy} onClick={() => void run(() => hive.taskWork.openEditor({ id: task.id }), (r) => (r as { opened: string }).opened === 'finder' ? 'Opened in Finder' : null)}>Open in Editor</button>,
        pr && !compact && <button key="pr" className="link-btn" disabled={busy} onClick={() => void run(() => hive.app.openExternal({ url: pr.url }))}>Open PR</button>,
        // A1: never while an agent works on it (it may still be pushing to the branch). The tooltip sits on a wrapper:
        // a disabled button gets no pointer events
        pr?.state === 'OPEN' && <span key="merge" className="work-section__merge" title={mergeTitle(inFlight, pr.isDraft)}><button className="link-btn" disabled={busy || pr.isDraft || inFlight} title={mergeTitle(inFlight, pr.isDraft)} onClick={() => void run(() => hive.taskWork.merge({ id: task.id }), (r) => (r ? (r as { message: string }).message : null))}>Merge…</button></span>,
        // a gone worktree has nothing to remove: the banner above offers what to do instead (QA)
        started && !gone && <button key="remove" className="link-btn" disabled={busy || inFlight} title={inFlight ? 'Stop the agent first' : 'Lists what would be lost first'} onClick={() => void run(() => hive.taskWork.remove({ id: task.id }), (r) => (r ? 'Worktree removed' : null))}>Remove Worktree…</button>
      ].filter(Boolean).flatMap((el, i) => (i ? [<span key={`sep${i}`} aria-hidden>·</span>, el] : [el]))}
    </div>
  </section>
}

/**
 * Five doors step 5 (design §4.5): a code task's work block in the inspector. Before Start: Repo, the branch it will
 * create ("(created on start)") and one primary, Start on a new branch, with ▾ for the other ways to start. After:
 * the stepper Branch → Pull request → Merged and only the next step (Connect GitHub, Open the chat, Open the pull
 * request). Status follows the PR (main moves it), so there is no Mark merged here.
 */
export function WorkFlow({ task, company, repoName, who, inFlight, liveSessionId, blocked = null, busy, onDone, otherStarts }: { task: CompanyTask; company: CompanyPassport | undefined; repoName: string | null; who: string | null; inFlight: boolean; liveSessionId: string | null; /** why Start can't run yet */ blocked?: string | null; busy: boolean; onDone: () => void; /** the ▾ menu next to Start: start in a chat / on my checkout */ otherStarts?: () => void }): React.JSX.Element | null {
  const [working, setWorking] = useState(false)
  const repoIds = useCompanyRepoIds(company)
  const canStart = !!company && canStartWork(task, repoIds)
  const w = task.work
  if (!w && !canStart) return null
  const branch = w?.branch ?? branchFor(task.identifier, task.title)
  const step = nextWorkStep(task, { canStart, inFlight, liveChat: !!liveSessionId, repoName, branch, who })
  const start = async (): Promise<void> => {
    setWorking(true)
    try {
      const r = await hive.taskWork.start({ id: task.id })
      toast(r.message)
      onDone()
    } catch (e) { toast(errorMessage(e), 'error') } finally { setWorking(false) }
  }
  const act = (): void => {
    if (step.kind === 'start') void start()
    else if (step.kind === 'connectGithub') void navigate({ name: 'settings', section: 'connections', connect: 'github', nonce: Date.now() })
    else if (step.kind === 'openChat' && liveSessionId) focusSession(liveSessionId)
    else if (step.kind === 'openChat' && task.runId) void navigate({ name: 'run', runId: task.runId })
    else if (step.kind === 'openPr' && w?.pr) void hive.app.openExternal({ url: w.pr.url }).catch((e: unknown) => toast(errorMessage(e), 'error'))
  }
  const started = step.kind !== 'start'
  return <section className="work-flow" aria-label="Branch and pull request">
    <dl className="work-flow__props">
      {repoName && <><dt>Repo</dt><dd className="work-flow__mono">{repoName}</dd></>}
      <dt>Branch</dt><dd className="work-flow__mono selectable">{branch}{!started && <span className="work-flow__dim"> (created on start)</span>}</dd>
    </dl>
    {started && <ol className="work-steps" aria-label="Branch to pull request">
      {workSteps(w, task.status).map((s) => <li key={s.key} className={`work-steps__step is-${s.state}`}><span className="work-steps__dot" aria-hidden />{s.key === 'pr' && w?.pr ? `#${w.pr.number}` : s.label}<span className="rm-sr"> {s.state === 'done' ? 'done' : s.state === 'current' ? 'next' : 'not yet'}</span></li>)}
    </ol>}
    {step.note && <div className={`work-flow__next work-flow__next--${step.kind}`} role="note">
      <span className="work-flow__glyph" aria-hidden>{step.kind === 'start' ? <BranchGlyph /> : step.kind === 'done' ? '✓' : '◆'}</span>
      <span>{step.note}</span>
    </div>}
    {step.label && <div className="work-flow__actions">
      <Button variant="primary" icon={step.kind === 'start' ? 'play' : step.kind === 'openPr' ? 'external' : undefined} disabled={busy || working || (step.kind === 'start' && !!blocked)} title={step.kind === 'start' && blocked ? blocked : undefined} onClick={act}>{working ? 'Starting…' : step.label}</Button>
      {step.kind === 'start' && blocked && <span className="work-flow__blocked">{blocked}</span>}
      {step.kind === 'start' && otherStarts && !blocked && <IconButton icon="chevronDown" label="Other ways to start" title="Start in a chat, or on my checkout" disabled={busy || working} onClick={otherStarts} />}
    </div>}
  </section>
}
