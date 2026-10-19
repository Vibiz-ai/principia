/**
 * Author drafts slice (AUTHORING.md §2): pending approval cards, snapshot via author:list then live via
 * author:updated. No polling. Degrades quietly when main doesn't serve the authoring channels yet.
 */
import { useMemo } from 'react'
import type { AuthorDraft, AuthorDecideRequest } from '@shared/authoring'
import type { Id, ValidationError, WorkflowDraft } from '@shared/types'
import { errorCode, errorMessage, hive } from '../lib/hive'
import { focusSession, getState, navigate, setState, toast, toastError, useStore } from './store'

function upsert(d: AuthorDraft): void {
  setState((s) => ({ drafts: { ...s.drafts, [d.id]: d } }))
}

export async function loadDrafts(): Promise<void> {
  try {
    const list = await hive.author.list({ status: ['pending'], limit: 50 })
    setState((s) => {
      const drafts: Record<Id, AuthorDraft> = {}
      // keep decided drafts the user saw change while Principia was open, so a card can show its outcome
      for (const d of Object.values(s.drafts)) if (d.status !== 'pending') drafts[d.id] = d
      for (const d of list) drafts[d.id] = d
      return { drafts, authorAvailable: true }
    })
  } catch {
    setState({ authorAvailable: false })
  }
}

let wired = false
export function wireAuthorEvents(): void {
  if (wired) return
  wired = true
  hive.on('author:updated', upsert)
}

export function usePendingDrafts(): AuthorDraft[] {
  const drafts = useStore((s) => s.drafts)
  return useMemo(
    () =>
      Object.values(drafts)
        .filter((d) => d.status === 'pending')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [drafts]
  )
}

/** Pending drafts a session's Claude asked for (pinned above its terminal). */
export function useSessionDrafts(sessionId: Id): AuthorDraft[] {
  const pending = usePendingDrafts()
  return useMemo(() => pending.filter((d) => d.sessionId === sessionId), [pending, sessionId])
}

export interface DecideOutcome {
  ok: boolean
  errors?: ValidationError[]
}

/** One click: approve (save + schedule + run per PO2) or reject with an optional note. */
export async function decideDraft(req: AuthorDecideRequest): Promise<DecideOutcome> {
  try {
    const d = await hive.author.decide(req)
    upsert(d)
    toast(outcomeText(d))
    return { ok: true }
  } catch (e) {
    const errs = (e as { errors?: ValidationError[] }).errors
    if (errorCode(e) === 'validation' && errs?.length) return { ok: false, errors: errs }
    if (errorCode(e) === 'conflict') {
      toast('Already decided elsewhere.')
      void loadDrafts()
      return { ok: false }
    }
    toastError(e, req.decision === 'approve' ? 'Approve' : 'Reject')
    return { ok: false }
  }
}

export function outcomeText(d: AuthorDraft): string {
  if (d.status === 'rejected') return `Rejected. ${d.decisionNote ? 'Your note went back to the agent.' : 'The agent was told.'}`
  if (d.status !== 'approved') return `“${d.workflowName}” is ${d.status}`
  const did: string[] = []
  if (d.kind === 'create') did.push('saved')
  if (d.kind === 'update') did.push('updated')
  // PO11: a paused schedule request says so (it never fires until turned on)
  if (d.result?.scheduleId) did.push(/created paused/.test(d.flags?.scheduleSentence ?? '') ? 'schedule added paused' : 'scheduled')
  if (d.result?.runId) did.push('running')
  return `“${d.workflowName}” ${did.length ? did.join(', ') : 'approved'}.`
}

/** Approve from the editor after the user changed the proposed workflow ("Approve & save"). */
export async function approveEdited(id: Id, draft: WorkflowDraft, allowRun: boolean): Promise<DecideOutcome> {
  return decideDraft({ id, decision: 'approve', draft, allowRun })
}

/**
 * Notification click / ⌘J / hub: show the card where it lives. A session's draft opens that pane (the card is pinned
 * above its terminal); anything else opens the Agents hub, which lists every pending card.
 */
export async function openApproval(draftId: Id): Promise<void> {
  let d: AuthorDraft | undefined = getState().drafts[draftId]
  if (!d) {
    try {
      d = await hive.author.get({ id: draftId })
      upsert(d)
    } catch (e) {
      toast(`Couldn’t open the approval: ${errorMessage(e)}`, 'error')
      return
    }
  }
  setState((s) => ({ approvalFocus: { draftId, nonce: (s.approvalFocus?.nonce ?? 0) + 1 } }))
  const sess = d.sessionId ? getState().sessions.find((x) => x.id === d!.sessionId && x.status === 'running') : undefined
  if (sess && d.status === 'pending') focusSession(sess.id)
  else void navigate({ name: 'agents' })
}

/** Approve & save mode in the editor: the draft's proposed workflow, unsaved. */
export function editDraftInEditor(draftId: Id): void {
  void navigate({ name: 'editor', workflowId: null, nonce: Date.now(), approvalDraftId: draftId })
}
