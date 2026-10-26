/**
 * LINEAR.md §3: the synced fields, their canonical form on each side and their fingerprints. A fingerprint is a short
 * hash of a field's canonical value; a link keeps both sides' fingerprints as they last agreed, so a field whose
 * fingerprint has not moved is never sent, and nothing bounces. Pure.
 */
import { createHash } from 'node:crypto'
import type { BoardTask } from '../../../shared/company'
import type { RemoteIssue } from './provider'

export const SYNC_FIELDS = ['title', 'description', 'status', 'priority', 'labels', 'estimate', 'dueDate', 'parent'] as const
export type SyncField = typeof SYNC_FIELDS[number]
export const FIELD_LABEL: Record<SyncField, string> = { title: 'title', description: 'description', status: 'status', priority: 'priority', labels: 'labels', estimate: 'estimate', dueDate: 'due date', parent: 'parent' }

export function fingerprint(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16)
}
const text = (s: string | null | undefined) => (s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
export const labelKey = (labels: readonly string[]): string[] => [...new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean))].sort()

/**
 * The text a task sends as its description. When the plans track's brief exists on the task (an object with a goal
 * and sections), it is rendered as Markdown: the goal first, then each section under `## Heading`. Otherwise the
 * description as it is.
 */
export function outgoingBody(task: BoardTask): string {
  const brief = (task as unknown as { brief?: unknown }).brief
  if (brief && typeof brief === 'object') {
    const b = brief as { goal?: unknown; sections?: unknown }
    if (typeof b.goal === 'string') {
      const parts = [b.goal.trim()]
      if (Array.isArray(b.sections)) for (const s of b.sections as { title?: unknown; body?: unknown }[]) if (typeof s?.title === 'string' && typeof s.body === 'string' && s.body.trim()) parts.push(`## ${s.title.trim()}\n\n${s.body.trim()}`)
      return text(parts.filter(Boolean).join('\n\n'))
    }
  }
  return text(task.description)
}

/**
 * The task's canonical values. `parentRemote`: the linked parent's issue id, null without a parent, undefined when
 * the parent is not linked (the field is then left alone this round).
 */
export function localValues(task: BoardTask, parentRemote: string | null | undefined): Record<SyncField, unknown> {
  return {
    title: task.title.trim(), description: outgoingBody(task), status: task.status, priority: task.priority, labels: labelKey(task.labels ?? []),
    estimate: task.estimate ?? null, dueDate: task.dueDate ?? null, parent: parentRemote
  }
}
/** The issue's canonical values; the status is its state id (two states can mean one Board status). */
export function remoteValues(issue: RemoteIssue): Record<SyncField, unknown> {
  return {
    title: issue.title.trim(), description: text(issue.description), status: issue.stateId, priority: issue.priority, labels: labelKey(issue.labels),
    estimate: issue.estimate, dueDate: issue.dueDate, parent: issue.parentId
  }
}
export function fingerprints(values: Record<SyncField, unknown>): Record<SyncField, string> {
  const out = {} as Record<SyncField, string>
  for (const f of SYNC_FIELDS) out[f] = fingerprint(values[f])
  return out
}

const DUE = /^\d{4}-\d{2}-\d{2}$/
/**
 * An issue as the Board can hold it: a blank title becomes its key, labels are trimmed to 80 characters (deduped, at
 * most 50), an estimate outside 0–1000 is clamped, a due date that is not YYYY-MM-DD is dropped. Both sides then
 * fingerprint the same values, so a clamped field never bounces.
 */
export function cleanIssue(i: RemoteIssue): RemoteIssue {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const raw of i.labels ?? []) {
    const l = String(raw ?? '').trim().slice(0, 80).trim()
    if (!l || seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase())
    labels.push(l)
    if (labels.length >= 50) break
  }
  const estimate = typeof i.estimate === 'number' && Number.isFinite(i.estimate) ? Math.min(1000, Math.max(0, i.estimate)) : null
  const due = typeof i.dueDate === 'string' ? i.dueDate.slice(0, 10) : null
  return { ...i, title: (i.title ?? '').trim().slice(0, 240).trim() || i.key, description: (i.description ?? '').slice(0, 50_000), labels, estimate, dueDate: due && DUE.test(due) ? due : null }
}
