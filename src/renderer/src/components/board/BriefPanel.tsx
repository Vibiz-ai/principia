/**
 * PLANS.md §1: the task brief in the inspector. Goal in large type, then Acceptance criteria (checkboxes; a deferred
 * one in grey with its reason), Decisions, Open questions, Notes for the next agent, Proof thumbnails and the Context
 * (an old task's description). Each section shows who changed it last and when; Revisions lists every change.
 * A human can edit any section at any time, also while an agent works on the task.
 */
import { useEffect, useRef, useState } from 'react'
import type { CompanyTask } from '@shared/company'
import { briefOf, lastRevision, proofOf, type BriefAuthor, type BriefCriterion, type BriefOp, type BriefSection, type TaskBrief, type TaskProof } from '@shared/plans'
import { Button, IconButton, Popover, RelativeTime } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { useStore } from '../../state/store'
import { useAgentDisplay } from './NeedsYouTasks'
import '../../styles/plans.css'

type BriefTask = CompanyTask

/** 'You', 'Principia' or the agent's display name. */
export function useAuthorLabel(): (by: BriefAuthor) => string {
  const agents = useStore((s) => s.companyAgents)
  const who = useAgentDisplay()
  return (by) => {
    if (by === 'human') return 'You'
    if (by === 'system') return 'Principia'
    const id = by.startsWith('agent:') ? by.slice(6) : by
    const a = agents.find((x) => x.id === id)
    return a ? (who(a)?.name ?? a.name) : 'An agent'
  }
}

const SECTION_LABEL: Record<BriefSection, string> = { goal: 'Goal', context: 'Context', criteria: 'Acceptance criteria', decisions: 'Decisions', questions: 'Open questions', handoff: 'Notes for the next agent', proof: 'Proof' }

export function BriefPanel({ task, onChanged }: { task: BriefTask; onChanged: () => void }): React.JSX.Element {
  const brief = briefOf(task)
  const proof = proofOf(task)
  const label = useAuthorLabel()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revAnchor, setRevAnchor] = useState<DOMRect | null>(null)
  const op = async (q: BriefOp): Promise<boolean> => {
    setBusy(true); setError(null)
    try { await hive.tasks.brief(q); onChanged(); return true } catch (e) { setError(errorMessage(e)); return false } finally { setBusy(false) }
  }
  const meta = (s: BriefSection) => <SectionMeta brief={brief} section={s} label={label} />
  return (
    <div className="tbrief" aria-label="Task brief">
      {error && <div className="company-error" role="alert">{error}</div>}
      <div className="tbrief__goal-row">
        <EditableText
          className="tbrief__goal"
          value={brief.goal}
          placeholder="What does done look like? Write the goal."
          busy={busy}
          single
          label="Goal"
          onSave={(text) => op({ op: 'edit', taskId: task.id, section: 'goal', text })}
        />
        {brief.revisions.length > 0 && <button type="button" className="tbrief__revisions-btn link-btn" onClick={(e) => setRevAnchor(e.currentTarget.getBoundingClientRect())}>Revisions · {brief.revisions.length}</button>}
      </div>
      <div className="tbrief__meta-line">{meta('goal')}</div>

      <section className="tbrief__section">
        <h3>Acceptance criteria {meta('criteria')}</h3>
        <Criteria task={task} criteria={brief.criteria} busy={busy} op={op} />
      </section>

      {brief.decisions.length > 0 && (
        <section className="tbrief__section">
          <h3>Decisions {meta('decisions')}</h3>
          <ul className="tbrief__decisions">
            {brief.decisions.slice().reverse().map((d, i) => (
              <li key={`${d.at}-${i}`}>
                <div className="selectable">{d.text}</div>
                <div className="tbrief__why selectable">Why: {d.why}</div>
                <div className="tbrief__by">{label(d.by)} · <RelativeTime iso={d.at} /></div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AddDecision busy={busy} onAdd={(text, why) => op({ op: 'decide', taskId: task.id, text, why })} />

      {brief.questions.length > 0 && (
        <section className="tbrief__section">
          <h3>Open questions {meta('questions')}</h3>
          <ul className="tbrief__questions">
            {brief.questions.map((q) => <Question key={q.id} text={q.text} answer={q.answer} busy={busy} onAnswer={(answer) => op({ op: 'answer', taskId: task.id, id: q.id, answer })} />)}
          </ul>
        </section>
      )}

      <section className="tbrief__section">
        <h3>Notes for the next agent {meta('handoff')}</h3>
        <EditableText value={brief.handoff} placeholder="Nothing yet. The agent rewrites this before it ends a turn that changed things." busy={busy} label="Notes for the next agent" onSave={(text) => op({ op: 'edit', taskId: task.id, section: 'handoff', text })} />
      </section>

      {proof.length > 0 && (
        <section className="tbrief__section">
          <h3>Proof {meta('proof')}</h3>
          <ProofList task={task} proof={proof} label={label} />
        </section>
      )}

      <section className="tbrief__section">
        <h3>Context {meta('context')}</h3>
        <EditableText value={brief.context} placeholder="No context yet. Add what the agent should know." busy={busy} label="Context" collapsible onSave={(text) => op({ op: 'edit', taskId: task.id, section: 'context', text })} />
      </section>

      <Popover anchor={revAnchor} onClose={() => setRevAnchor(null)} width={300}>
        <div className="tbrief__revisions" role="list" aria-label="Revisions">
          {brief.revisions.slice().reverse().slice(0, 60).map((r, i) => (
            <div key={`${r.at}-${i}`} className="tbrief__revision" role="listitem">
              <span>{label(r.by)}</span><span className="board-muted">{SECTION_LABEL[r.section]}</span><span className="board-muted"><RelativeTime iso={r.at} /></span>
            </div>
          ))}
        </div>
      </Popover>
    </div>
  )
}

function SectionMeta({ brief, section, label }: { brief: TaskBrief; section: BriefSection; label: (by: BriefAuthor) => string }): React.JSX.Element | null {
  const r = lastRevision(brief, section)
  if (!r) return null
  return <span className="tbrief__meta">{label(r.by)} · <RelativeTime iso={r.at} /></span>
}

function EditableText({ value, placeholder, onSave, busy, single, className, label, collapsible }: { value: string; placeholder: string; onSave: (v: string) => Promise<boolean>; busy: boolean; single?: boolean; className?: string; label: string; collapsible?: boolean }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])
  if (editing) {
    return (
      <form className="tbrief__edit" onSubmit={(e) => { e.preventDefault(); void onSave(draft.trim()).then((ok) => ok && setEditing(false)) }}>
        <textarea ref={ref} aria-label={label} rows={single ? 2 : 5} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } if (e.key === 'Enter' && (e.metaKey || single) && !e.shiftKey) { e.preventDefault(); void onSave(draft.trim()).then((ok) => ok && setEditing(false)) } }} />
        <div className="tbrief__edit-buttons"><Button size="sm" type="button" onClick={() => setEditing(false)}>Cancel</Button><Button size="sm" variant="primary" type="submit" disabled={busy}>Save</Button></div>
      </form>
    )
  }
  const long = collapsible && value.length > 600 && !open
  return (
    <div className={`tbrief__text ${className ?? ''} ${value ? '' : 'is-empty'}`}>
      <div className="selectable tbrief__body" onDoubleClick={() => setEditing(true)}>{value ? (long ? `${value.slice(0, 600)}…` : value) : placeholder}</div>
      <div className="tbrief__text-actions">
        {long && <button type="button" className="link-btn" onClick={() => setOpen(true)}>Show all</button>}
        <IconButton icon="edit" label={`Edit ${label.toLowerCase()}`} className="tbrief__edit-btn" onClick={() => setEditing(true)} />
      </div>
    </div>
  )
}

function Criteria({ task, criteria, busy, op }: { task: BriefTask; criteria: BriefCriterion[]; busy: boolean; op: (q: BriefOp) => Promise<boolean> }): React.JSX.Element {
  const [adding, setAdding] = useState('')
  const [deferring, setDeferring] = useState<{ id: string; state: 'deferred' | 'not_done' } | null>(null)
  const [reason, setReason] = useState('')
  return (
    <div className="tbrief__criteria">
      {criteria.length === 0 && <p className="board-muted">No criteria yet. Add what must hold for this task to be done.</p>}
      {criteria.map((c) => (
        <div key={c.id} className={`tbrief__criterion tbrief__criterion--${c.state}`}>
          <label>
            <input type="checkbox" checked={c.state === 'done'} disabled={busy} aria-label={c.text} onChange={(e) => void op({ op: 'criterion', taskId: task.id, id: c.id, state: e.target.checked ? 'done' : 'open' })} />
            <span className="selectable">{c.text}</span>
          </label>
          {(c.state === 'deferred' || c.state === 'not_done') && <div className="tbrief__reason">{c.state === 'deferred' ? 'Deferred' : 'Not done'}: {c.reason}</div>}
          <div className="tbrief__criterion-actions">
            {c.state === 'open' && <button type="button" className="link-btn" disabled={busy} onClick={() => { setDeferring({ id: c.id, state: 'deferred' }); setReason('') }}>Defer</button>}
            {(c.state === 'deferred' || c.state === 'not_done') && <button type="button" className="link-btn" disabled={busy} onClick={() => void op({ op: 'criterion', taskId: task.id, id: c.id, state: 'open' })}>Reopen</button>}
            <button type="button" className="link-btn" disabled={busy} onClick={() => void op({ op: 'removeCriterion', taskId: task.id, id: c.id })}>Remove</button>
          </div>
          {deferring?.id === c.id && (
            <form className="tbrief__inline" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void op({ op: 'criterion', taskId: task.id, id: c.id, state: deferring.state, reason: reason.trim() }).then((ok) => ok && setDeferring(null)) }}>
              <input autoFocus aria-label="Why it is deferred" placeholder="Why? (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" type="submit" disabled={busy || !reason.trim()}>Defer</Button>
              <Button size="sm" type="button" onClick={() => setDeferring(null)}>Cancel</Button>
            </form>
          )}
        </div>
      ))}
      <form className="tbrief__inline" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) void op({ op: 'addCriterion', taskId: task.id, text: adding.trim() }).then((ok) => ok && setAdding('')) }}>
        <input aria-label="Add a criterion" placeholder="Add a criterion…" value={adding} onChange={(e) => setAdding(e.target.value)} />
        {adding.trim() && <Button size="sm" type="submit" disabled={busy}>Add</Button>}
      </form>
    </div>
  )
}

function AddDecision({ busy, onAdd }: { busy: boolean; onAdd: (text: string, why: string) => Promise<boolean> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [why, setWhy] = useState('')
  if (!open) return <button type="button" className="link-btn tbrief__add" onClick={() => setOpen(true)}><Icon name="plus" size={11} /> Record a decision</button>
  return (
    <form className="tbrief__decision-form" onSubmit={(e) => { e.preventDefault(); if (text.trim() && why.trim()) void onAdd(text.trim(), why.trim()).then((ok) => { if (ok) { setOpen(false); setText(''); setWhy('') } }) }}>
      <input autoFocus aria-label="Decision" placeholder="The decision" value={text} onChange={(e) => setText(e.target.value)} />
      <input aria-label="Why" placeholder="Why (required)" value={why} onChange={(e) => setWhy(e.target.value)} />
      <div className="tbrief__edit-buttons"><Button size="sm" type="button" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim() || !why.trim()}>Record</Button></div>
    </form>
  )
}

function Question({ text, answer, busy, onAnswer }: { text: string; answer?: string; busy: boolean; onAnswer: (a: string) => Promise<boolean> }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <li>
      <div className="selectable">{text}</div>
      {answer ? <div className="tbrief__why selectable">Answer: {answer}</div> : (
        <form className="tbrief__inline" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void onAnswer(draft.trim()).then((ok) => ok && setDraft('')) }}>
          <input aria-label={`Answer: ${text}`} placeholder="Answer…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {draft.trim() && <Button size="sm" type="submit" disabled={busy}>Answer</Button>}
        </form>
      )}
    </li>
  )
}

const PROOF_ICON: Record<TaskProof['kind'], string> = { screenshot: 'artifacts', test: 'check', link: 'link', file: 'file', graph: 'workflows' }
function ProofList({ task, proof, label }: { task: BriefTask; proof: TaskProof[]; label: (by: BriefAuthor) => string }): React.JSX.Element {
  return (
    <div className="tbrief__proof">
      {proof.map((p) => (
        <div key={p.id} className={`tbrief__proof-item tbrief__proof-item--${p.kind}`} title={`${p.title}\n${p.ref}\n${label(p.by)}`}>
          {p.kind === 'screenshot' ? <ProofThumb taskId={task.id} proof={p} /> : <Icon name={PROOF_ICON[p.kind]} size={14} />}
          <div className="tbrief__proof-text">
            {p.kind === 'link' ? <button type="button" className="link-btn" onClick={() => void hive.app.openExternal({ url: p.ref }).catch(() => undefined)}>{p.title}</button> : <span>{p.title}</span>}
            {p.kind === 'test' || p.kind === 'graph' ? <code className="selectable">{p.ref.length > 160 ? `${p.ref.slice(0, 159)}…` : p.ref}</code> : <span className="board-muted">{p.kind} · {label(p.by)} · <RelativeTime iso={p.at} /></span>}
          </div>
          <span className="tbrief__proof-id board-muted">{p.id}</span>
        </div>
      ))}
    </div>
  )
}
function ProofThumb({ taskId, proof }: { taskId: string; proof: TaskProof }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => { let live = true; void hive.tasks.proofPreview({ taskId, proofId: proof.id }).then((s) => live && setSrc(s), () => undefined); return () => { live = false } }, [taskId, proof.id])
  return src ? <img className="tbrief__thumb" src={src} alt={proof.title} /> : <span className="tbrief__thumb tbrief__thumb--empty"><Icon name="artifacts" size={14} /></span>
}
