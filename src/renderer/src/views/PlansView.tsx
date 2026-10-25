/**
 * PLANS.md §3: the Plans view. A list of plans; a plan page whose top line is one sentence saying whose turn it is,
 * under it the graph of milestones and tasks, and one contextual button (Approve Plan, Pass Milestone 2, Start
 * PRN-31, Resume). The empty state has one button, New Plan. The New Plan sheet has a goal box and three cards.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Id } from '@shared/types'
import { AUTONOMY_LABEL, PLAN_AUTONOMY, milestoneComplete, openPrInstructions, type Milestone, type Plan, type PlanAutonomy, type PlanDetail, type PlanTask } from '@shared/plans'
import { prChip, type TaskPr } from '@shared/taskWork'
import { agentActive } from '@shared/company'
import { Button, EmptyState, ErrorState, Loading, Pill, RelativeTime, Segmented, Sheet, Toolbar } from '../components/ui'
import { GraphView } from '../components/GraphView'
import { Icon } from '../components/Icon'
import { useAgentDisplay } from '../components/board/NeedsYouTasks'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { planGraph } from '../lib/planGraph'
import { reposOf } from '../lib/companyModel'
import { activeCompany, navigate, toast, useStore } from '../state/store'
import '../styles/plans.css'

const STATUS_LABEL: Record<Plan['status'], string> = { draft: 'Draft', approved: 'Approved', running: 'Running', done: 'Done', archived: 'Archived' }
const STATUS_TONE: Record<Plan['status'], 'idle' | 'running' | 'passed' | 'scheduled'> = { draft: 'idle', approved: 'scheduled', running: 'running', done: 'passed', archived: 'idle' }
const copy = (text: string, label: string): void => { void navigator.clipboard.writeText(text).then(() => toast(`${label} copied`), () => toast(`Could not copy the ${label.toLowerCase()}`)) }

export function PlansView({ planId, create, nonce }: { planId?: Id; create?: boolean; nonce?: number }): React.JSX.Element {
  const [sheet, setSheet] = useState(!!create)
  useEffect(() => { if (create) setSheet(true) }, [create, nonce])
  return (
    <div className="view plans-view">
      {planId ? <PlanPage id={planId} /> : <PlanList onNew={() => setSheet(true)} />}
      {sheet && <NewPlanSheet onClose={() => setSheet(false)} />}
    </div>
  )
}

// ---------- the list ----------

function PlanList({ onNew }: { onNew: () => void }): React.JSX.Element {
  const active = useStore((s) => activeCompany(s))
  const companies = useStore((s) => s.companies)
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [archived, setArchived] = useState(false)
  const load = (): void => { void hive.plans.list({ ...(active === 'all' ? {} : { companyId: active }), includeArchived: archived }).then((l) => { setPlans(l); setError(null) }, (e) => setError(errorMessage(e))) }
  useEffect(load, [active, archived])
  useHiveEvent('data:changed', ({ domain }) => { if (domain === 'tasks') load() })
  if (error) return <><Toolbar title="Plans" /><ErrorState error={error} onRetry={load} /></>
  if (!plans) return <><Toolbar title="Plans" /><Loading label="Loading plans…" /></>
  return (
    <>
      <Toolbar title="Plans">
        {(plans.length > 0 || archived) && <button type="button" className={`hchip ${archived ? 'is-on' : ''}`} aria-pressed={archived} onClick={() => setArchived(!archived)}>Archived</button>}
        {plans.length > 0 && <Button icon="plus" onClick={onNew}>New Plan</Button>}
      </Toolbar>
      {plans.length === 0 && !archived ? (
        <EmptyState icon="plans" text="A plan turns one goal into milestones and tasks that one head agent runs at the pace you pick.">
          <Button variant="primary" icon="plus" onClick={onNew}>New Plan</Button>
        </EmptyState>
      ) : (
        <div className="plans-list">
          {plans.map((p) => {
            const done = p.milestones.filter((m) => milestoneComplete(p, m)).length
            return (
              <button key={p.id} type="button" className="plans-row" onClick={() => void navigate({ name: 'plans', planId: p.id })}>
                <Icon name="plans" />
                <div className="plans-row__main">
                  <div className="plans-row__goal">{p.goal}</div>
                  <div className="plans-row__sub">
                    {active === 'all' && <>{companies.find((c) => c.id === p.companyId)?.name} · </>}
                    {AUTONOMY_LABEL[p.autonomy].title} · {p.milestones.length ? `${done} of ${p.milestones.length} milestones` : p.drafting ? 'drafting…' : 'no milestones yet'} · <RelativeTime iso={p.updatedAt} />
                    {p.halted && <span className="plans-row__halted"> · stopped</span>}
                  </div>
                </div>
                <Pill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Pill>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

// ---------- the New Plan sheet ----------

function NewPlanSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const active = useStore((s) => activeCompany(s))
  const allCompanies = useStore((s) => s.companies)
  const companies = allCompanies.filter((c) => !c.archivedAt)
  const repos = useStore((s) => s.repos)
  const agents = useStore((s) => s.companyAgents)
  const who = useAgentDisplay()
  const [companyId, setCompanyId] = useState<string>(active !== 'all' ? active : (companies.find((c) => c.system !== 'personal')?.id ?? companies[0]?.id ?? ''))
  const [goal, setGoal] = useState('')
  const [autonomy, setAutonomy] = useState<PlanAutonomy>('checkins')
  const own = reposOf(repos, companyId)
  const [repoId, setRepoId] = useState<string>('')
  const seats = agents.filter((a) => a.companyId === companyId && agentActive(a) && a.kind === 'profile')
  const [headAgentId, setHead] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setRepoId(own.length === 1 ? own[0].id : ''); setHead('') }, [companyId])
  const submit = async (): Promise<void> => {
    if (!goal.trim() || !companyId) return
    setBusy(true); setError(null)
    try {
      const p = await hive.plans.create({ companyId, goal: goal.trim(), autonomy, repoId: repoId || null, headAgentId: headAgentId || null })
      onClose()
      void navigate({ name: 'plans', planId: p.id })
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Sheet title="New Plan" onCancel={onClose} onPrimary={() => void submit()} primaryLabel="Draft Plan" primaryDisabled={busy || !goal.trim() || !companyId} width={560}>
      <div className="plan-sheet">
        {active === 'all' && companies.length > 1 && (
          <select aria-label="Company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        )}
        <textarea className="plan-sheet__goal" aria-label="Goal" data-autofocus rows={4} maxLength={4000} placeholder="What should be true when this is done? e.g. Every task runs in its own worktree, and the Plans view shows whose turn it is." value={goal} onChange={(e) => setGoal(e.target.value)} />
        <div className="plan-sheet__cards" role="radiogroup" aria-label="How it runs">
          {PLAN_AUTONOMY.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={autonomy === a} className={`plan-card ${autonomy === a ? 'is-selected' : ''}`} onClick={() => setAutonomy(a)}>
              <span className="plan-card__title">{AUTONOMY_LABEL[a].title}</span>
              <span className="plan-card__text">{AUTONOMY_LABEL[a].text}</span>
            </button>
          ))}
        </div>
        <div className="plan-sheet__row">
          <label><span>Repository</span><select aria-label="Repository" value={repoId} onChange={(e) => setRepoId(e.target.value)}><option value="">Company workspace</option>{own.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label><span>Head agent</span><select aria-label="Head agent" value={headAgentId} onChange={(e) => setHead(e.target.value)}><option value="">Department head (default)</option>{seats.map((a) => <option key={a.id} value={a.id}>{who(a)?.name ?? a.name} · {a.name}</option>)}</select></label>
        </div>
        {error && <div className="company-error" role="alert">{error}</div>}
      </div>
    </Sheet>
  )
}

// ---------- one plan ----------

function PlanPage({ id }: { id: Id }): React.JSX.Element {
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [sendBack, setSendBack] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [actError, setActError] = useState<string | null>(null)
  const agents = useStore((s) => s.companyAgents)
  const who = useAgentDisplay()
  const req = useRef(0)
  const load = (): void => { const n = ++req.current; void hive.plans.get({ id }).then((d) => { if (req.current === n) { setDetail(d); setError(null) } }, (e) => { if (req.current === n) setError(errorMessage(e)) }) }
  useEffect(load, [id])
  useHiveEvent('data:changed', ({ domain }) => { if (domain === 'tasks') load() })
  useHiveEvent('run:updated', () => load())
  // the head agent drafts in the background: poll gently until it lands
  useEffect(() => { if (!detail?.plan.drafting && !detail?.checking) return; const t = setInterval(load, 2500); return () => clearInterval(t) }, [detail?.plan.drafting, detail?.checking])
  const name = (aid: string | null): string => { const a = agents.find((x) => x.id === aid); return a ? (who(a)?.name ?? a.name) : '' }
  const graph = useMemo(() => (detail ? planGraph(detail.plan, detail.tasks, name, detail.waits) : null), [detail, agents])
  const act = async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    // an action's error stays until the next action (a reload from a run event must not wipe it)
    setBusy(true); setActError(null)
    try { await fn(); load(); if (done) toast(done); return true } catch (e) { setActError(errorMessage(e)); return false } finally { setBusy(false) }
  }
  if (!detail) return <><Toolbar title="Plan" left={<BackButton />} />{error ? <ErrorState error={error} onRetry={load} /> : <Loading label="Loading plan…" />}</>
  const { plan, turn } = detail
  const action = turn.action
  const milestone = action?.kind === 'pass' ? plan.milestones.find((m) => m.id === action.milestoneId) : undefined
  const startTask = action?.kind === 'start' ? detail.tasks.find((t) => t.id === action.taskId) : undefined
  const reviewTask = action?.kind === 'review' ? detail.tasks.find((t) => t.id === action.taskId) : undefined
  const mNum = (m: Milestone) => m.key.replace(/^M/, '')
  const halted = plan.halted?.milestoneId ? plan.milestones.find((m) => m.id === plan.halted!.milestoneId && m.gate.result === 'fail') : undefined
  const live = detail.tasks.some((t) => t.status === 'in_progress')
  const open = detail.tasks.filter((t) => ['triage', 'backlog', 'todo', 'blocked'].includes(t.status)).length
  const inReview = detail.tasks.filter((t) => t.status === 'in_review').length
  return (
    <>
      <Toolbar title="Plan" left={<BackButton />}>
        {/* a finished plan has no pace left to change */}
        {showsAutonomy(plan) && <Segmented<PlanAutonomy> size="sm" items={PLAN_AUTONOMY.map((a) => ({ value: a, label: AUTONOMY_LABEL[a].title, title: AUTONOMY_LABEL[a].text }))} value={plan.autonomy} onChange={(a) => void act(() => hive.plans.setAutonomy({ id, autonomy: a }))} />}
      </Toolbar>
      <div className="plan-page">
        <header className="plan-head">
          <div className="plan-head__goal selectable">{plan.goal}</div>
          <div className={`plan-turn plan-turn--${turn.who}`} role="status">{turn.text}</div>
          {(actError ?? error) && <div className="company-error" role="alert">{actError ?? error}</div>}
          <div className="plan-head__actions">
            {action?.kind === 'approve' && <>
              <Button variant="primary" icon="check" disabled={busy} onClick={() => void act(() => hive.plans.approve({ id }), 'Plan approved: its tasks are on the Board')}>Approve Plan</Button>
              <Button disabled={busy} onClick={() => void act(async () => { await hive.plans.discard({ id }); void navigate({ name: 'plans' }) }, 'Draft discarded')}>Discard</Button>
            </>}
            {plan.status === 'draft' && plan.draftError && <Button variant="primary" icon="refresh" disabled={busy} onClick={() => void act(() => hive.plans.redraft({ id }))}>Draft Again</Button>}
            {plan.status === 'draft' && plan.draftError && <Button disabled={busy} onClick={() => void act(async () => { await hive.plans.discard({ id }); void navigate({ name: 'plans' }) })}>Discard</Button>}
            {milestone && !sendBack && <>
              <Button variant="primary" icon="check" disabled={busy} onClick={() => void act(() => hive.plans.pass({ id, milestoneId: milestone.id }), `Milestone ${mNum(milestone)} passed`)}>Pass Milestone {mNum(milestone)}</Button>
              <Button icon="reply" disabled={busy} onClick={() => setSendBack(true)}>Send Back</Button>
            </>}
            {milestone && sendBack && <form className="plan-sendback" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void act(() => hive.plans.sendBack({ id, milestoneId: milestone.id, note: note.trim() }), 'Sent back with a fix task').then((ok) => { if (ok) { setSendBack(false); setNote('') } }) }}>
              <input autoFocus aria-label="What to change" placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="primary" type="submit" disabled={busy || !note.trim()}>Send Back</Button>
              <Button type="button" onClick={() => setSendBack(false)}>Cancel</Button>
            </form>}
            {startTask && <Button variant="primary" icon="play" disabled={busy} onClick={() => void act(() => hive.plans.start({ id, taskId: startTask.id }), `Started ${startTask.identifier}`)}>Start {startTask.identifier}</Button>}
            {reviewTask && <Button variant="primary" icon="external" onClick={() => void navigate({ name: 'tasks', taskId: reviewTask.id })}>Open {reviewTask.identifier}</Button>}
            {action?.kind === 'resume' && <Button variant="primary" icon="play" disabled={busy} onClick={() => void act(() => hive.plans.resume({ id }), 'Resumed')}>{halted ? 'Run Fixes' : 'Resume'}</Button>}
            {action?.kind === 'resume' && halted && <Button icon="check" disabled={busy} onClick={() => void act(() => hive.plans.pass({ id, milestoneId: halted.id }), `Milestone ${mNum(halted)} passed`)}>Pass Milestone {mNum(halted)} Anyway</Button>}
            {/* PLANS.md §2.6: never a local merge. The PR's Merge… is the worktree track's (gh pr merge after a native confirm) */}
            {action?.kind === 'merge' && plan.result?.pr && <>
              <Button variant="primary" icon="check" disabled={busy} title="Squash-merge the pull request on GitHub (a confirm comes first)" onClick={() => void act(async () => { const r = await hive.taskWork.merge({ id: action.taskId }); if (r) toast(r.message) })}>Merge…</Button>
              <Button icon="external" onClick={() => void hive.app.openExternal({ url: plan.result!.pr!.url })}>Open PR #{plan.result.pr.number}</Button>
            </>}
            {action?.kind === 'openPr' && <>
              <Button variant="primary" icon="upload" disabled={busy} title="Push the branch and open the pull request with the GitHub CLI" onClick={() => void act(() => hive.plans.publish({ id }))}>Open a PR</Button>
              {plan.result?.branch && <Button icon="copy" onClick={() => copy(plan.result!.branch!, 'Branch name')}>Copy Branch</Button>}
            </>}
            <span className="plan-head__spacer" />
            {plan.status === 'running' && !plan.halted && !plan.pausedAt && <Button size="sm" disabled={busy} title="Nothing new starts; a task already running finishes" onClick={() => void act(() => hive.plans.pause({ id }), 'Plan paused')}>Pause Plan</Button>}
            {(plan.status === 'done' || plan.status === 'running') && !archiving && <Button size="sm" disabled={busy || live} title={live ? 'A task is in progress: let it finish or stop it first' : undefined} onClick={() => plan.status === 'done' || (!open && !inReview) ? void act(() => hive.plans.archive({ id }), 'Plan archived') : setArchiving(true)}>{plan.status === 'done' ? 'Archive' : 'Stop and Archive'}</Button>}
            {archiving && <>
              <span className="board-muted">{archiveText(open, inReview)}</span>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => hive.plans.archive({ id }), 'Plan archived').then(() => setArchiving(false))}>Stop and Archive</Button>
              <Button size="sm" onClick={() => setArchiving(false)}>Keep It</Button>
            </>}
          </div>
        </header>
        {graph && graph.nodes.length > 0 ? (
          <div className="plan-graph plans-graph">
            <GraphView nodes={graph.nodes} edges={graph.edges} fitKey={`${plan.id}:${plan.milestones.length}:${plan.tasks.length}`}
              onOpen={(ref) => { if (ref.kind === 'wfnode' && ref.nodeId.startsWith('task:')) void navigate({ name: 'tasks', taskId: ref.nodeId.slice(5) }) }}
              onSelect={(ref) => { if (ref.kind === 'wfnode' && ref.nodeId.startsWith('task:')) void navigate({ name: 'tasks', taskId: ref.nodeId.slice(5) }) }} />
          </div>
        ) : plan.drafting ? <Loading label={`${name(plan.headAgentId) || 'The head agent'} is drafting…`} /> : null}
        {plan.status === 'draft' && !plan.drafting && plan.milestones.length > 0 && <DraftEditor plan={plan} busy={busy} onSave={(m, t) => act(() => hive.plans.saveDraft({ id, milestones: m, tasks: t }))} name={name} />}
        {plan.status !== 'draft' && <PlanNotes plan={plan} />}
      </div>
    </>
  )
}

/** The Step by Step / Check-ins / Autopilot control: only while there is something left to run. */
export const showsAutonomy = (p: Pick<Plan, 'status'>): boolean => p.status === 'running' || p.status === 'approved'

/** What Stop and Archive does to this plan's tasks: the open ones are canceled, the ones in review leave Needs you. */
export function archiveText(open: number, inReview: number): string {
  const parts = [open ? `${open} open task${open === 1 ? '' : 's'}` : '', inReview ? `${inReview} in review` : ''].filter(Boolean)
  return `Cancels ${parts.join(' and ')} of this plan${inReview ? ' (they leave Needs you)' : ''}.`
}

function BackButton(): React.JSX.Element {
  return <button type="button" className="link-btn plans-back" onClick={() => void navigate({ name: 'plans' })}><Icon name="chevronLeft" size={12} /> Plans</button>
}

/** The founder edits the draft before approval: titles, criteria, and which agent runs each milestone. */
function DraftEditor({ plan, busy, onSave, name }: { plan: Plan; busy: boolean; onSave: (m: Milestone[], t: PlanTask[]) => Promise<boolean>; name: (id: string | null) => string }): React.JSX.Element {
  const allAgents = useStore((s) => s.companyAgents)
  const agents = allAgents.filter((a) => a.companyId === plan.companyId && agentActive(a) && a.kind === 'profile')
  const [ms, setMs] = useState(plan.milestones)
  const [ts, setTs] = useState(plan.tasks)
  const dirty = JSON.stringify(ms) !== JSON.stringify(plan.milestones) || JSON.stringify(ts) !== JSON.stringify(plan.tasks)
  useEffect(() => { setMs(plan.milestones); setTs(plan.tasks) }, [plan.updatedAt])
  return (
    <section className="plan-draft">
      {plan.body && <p className="plan-draft__body selectable">{plan.body}</p>}
      {ms.map((m) => (
        <div key={m.id} className="plan-draft__milestone">
          <div className="plan-draft__mhead">
            <span className="plan-draft__key">{m.key}</span>
            <input aria-label={`${m.key} title`} value={m.title} onChange={(e) => setMs(ms.map((x) => x.id === m.id ? { ...x, title: e.target.value } : x))} />
            <select aria-label={`${m.key} agent`} value={m.agentId ?? ''} onChange={(e) => setMs(ms.map((x) => x.id === m.id ? { ...x, agentId: e.target.value || null } : x))}>
              <option value="">{name(plan.headAgentId) || 'Head agent'} (head)</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{name(a.id)} · {a.name}</option>)}
            </select>
          </div>
          {m.dependsOn.length > 0 && <div className="board-muted plan-draft__deps">After {m.dependsOn.map((d) => ms.find((x) => x.id === d)?.key).filter(Boolean).join(', ')}</div>}
          {m.passCriteria.length > 0 && <ul className="plan-draft__pass">{m.passCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          {ts.filter((t) => t.milestoneId === m.id).map((t) => (
            <div key={t.id} className="plan-draft__task">
              <input aria-label="Task title" value={t.title} onChange={(e) => setTs(ts.map((x) => x.id === t.id ? { ...x, title: e.target.value } : x))} />
              <div className="board-muted">{t.briefSeed.criteria.length} criteria{t.touches.length ? ` · ${t.touches.slice(0, 3).join(', ')}` : ''}{t.blockers.length ? ` · after ${t.blockers.map((b) => ts.find((x) => x.id === b)?.title).filter(Boolean).join(', ')}` : ''}</div>
              <button type="button" className="link-btn" disabled={ts.filter((x) => x.milestoneId === m.id).length < 2} onClick={() => setTs(ts.filter((x) => x.id !== t.id).map((x) => ({ ...x, blockers: x.blockers.filter((b) => b !== t.id) })))}>Remove</button>
            </div>
          ))}
        </div>
      ))}
      {dirty && <div className="plan-draft__save"><Button disabled={busy} onClick={() => { setMs(plan.milestones); setTs(plan.tasks) }}>Revert</Button><Button disabled={busy} onClick={() => void onSave(ms, ts)}>Save Draft</Button></div>}
    </section>
  )
}

/** The plan's PR, as the worktree track's chip says it ("#42 Open", "#42 Merged"). */
function PrChipLine({ pr }: { pr: TaskPr }): React.JSX.Element | null {
  const chip = prChip(pr)
  return chip ? <div className="plan-code__pr"><Pill tone={chip.tone}>{chip.label}</Pill></div> : null
}

/** Where the code is (the plan's branch, each milestone's), gate records with their evidence, and the change log. */
export function PlanNotes({ plan }: { plan: Plan }): React.JSX.Element {
  const checked = plan.milestones.filter((m) => m.gate.result)
  const branches = plan.milestones.filter((m) => m.worktree)
  const r = plan.result
  return (
    <section className="plan-notes">
      {(branches.length > 0 || r) && <div className="plan-notes__code">
        <h3>Code</h3>
        {r?.branch && <div className="plan-code plan-code--result">
          <div><strong>{r.mergedAt ? `Merged into ${r.baseBranch ?? 'the base branch'}` : 'The whole plan'}</strong> {r.mergedAt ? <span className="board-muted">· <RelativeTime iso={r.mergedAt} /></span> : <span className="board-muted">· {r.pr ? `PR #${r.pr.number} into ${r.baseBranch ?? 'the base branch'}` : r.pushed ? 'pushed, no pull request yet' : 'not pushed yet'}</span>}</div>
          <button type="button" className="plan-code__branch selectable" title="Copy the branch name" onClick={() => copy(r.branch!, 'Branch name')}>{r.branch}</button>
          {r.pr && <PrChipLine pr={r.pr} />}
        </div>}
        {r?.branch && !r.pr && !r.mergedAt && (r.gh === 'missing' || r.gh === 'signed_out' || !r.pushed) && <div className="plan-code__howto">
          <p className="board-muted">{r.gh === 'missing' ? 'The GitHub CLI is not installed, so Principia cannot open the pull request.' : r.gh === 'signed_out' ? 'The GitHub CLI is not signed in, so Principia cannot open the pull request.' : 'Open a PR pushes the branch and opens the pull request.'} To do it yourself, run this from any checkout of the repository, then merge on GitHub:</p>
          {openPrInstructions(r).map((line) => <button key={line} type="button" className="plan-code__cmd selectable" title="Copy the command" onClick={() => copy(line, 'Command')}>{line}</button>)}
        </div>}
        {r?.error && <p className="plan-code__error selectable">{r.error}</p>}
        {branches.map((m) => (
          <div key={m.id} className="plan-code">
            <span className="plan-draft__key">{m.key}</span>
            <button type="button" className="plan-code__branch selectable" title={`Copy the branch name · worktree ${m.worktree!.path}`} onClick={() => copy(m.worktree!.branch, 'Branch name')}>{m.worktree!.branch}</button>
          </div>
        ))}
      </div>}
      {checked.length > 0 && <div className="plan-notes__gates">
        <h3>Gates</h3>
        {checked.map((m) => (
          <div key={m.id} className={`plan-gate plan-gate--${m.gate.result}`}>
            <div className="plan-gate__head"><strong>{m.key}</strong> {m.gate.result === 'pass' ? 'passed its check' : 'failed its check'}{m.passedAt && ' · passed by you'} {m.gate.at && <span className="board-muted">· <RelativeTime iso={m.gate.at} /></span>}</div>
            <p className="selectable">{m.gate.notes}</p>
            {m.gate.evidence.length > 0 && <div className="plan-gate__evidence">Evidence: {m.gate.evidence.map((e, i) => <code key={i} className="selectable">{e}</code>)}</div>}
          </div>
        ))}
      </div>}
      {plan.changes.length > 0 && <div className="plan-notes__changes">
        <h3>Changes</h3>
        {plan.changes.slice().reverse().slice(0, 30).map((c, i) => <div key={i} className="plan-change"><span className="board-muted"><RelativeTime iso={c.at} /></span> <span className="selectable">{c.text}</span></div>)}
      </div>}
    </section>
  )
}
