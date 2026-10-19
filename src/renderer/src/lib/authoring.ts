/**
 * Pure helpers for agent-authored workflows (AUTHORING.md): approval card text, flags, diff, provenance, worktree
 * chips, nothing-to-do labels and the Claude history lists. No DOM, no IPC (unit-tested).
 */
import type { AuthorDraft, AuthorDraftDetail, AuthorFlags, ClaudeHistorySession } from '@shared/authoring'
import { notifyLabel, notifySlackOf } from './slack'
import { approveLabel, draftDiff, inputsInCommands } from '@shared/authoring'
import type { AdapterId, AgentProfile, Repo, Run, RunWorktree, WorkflowDraft, WorkflowNode, WorkflowOrigin } from '@shared/types'
import { NODE_GLYPH, NODE_LABEL } from './workflow'
import { tildify } from './format'
import { intervalLabel } from './graph'

// ---------- approval card ----------

export function kindVerb(kind: AuthorDraft['kind']): string {
  switch (kind) {
    case 'create':
      return 'Create workflow'
    case 'update':
      return 'Update workflow'
    case 'run':
      return 'Run workflow'
    case 'schedule':
      return 'Schedule workflow'
  }
}

type PrimaryInput = Pick<AuthorDraftDetail, 'kind' | 'flags'> & Partial<Pick<AuthorDraftDetail, 'schedule' | 'scheduleRequest' | 'runNow'>>

export function willSchedule(d: PrimaryInput): boolean {
  if (d.kind === 'run') return false
  return d.kind === 'schedule' || !!d.scheduleRequest || !!d.schedule || !!d.flags.scheduleSentence
}
export function willRunNow(d: PrimaryInput): boolean {
  if (d.kind === 'run') return true
  if (d.kind === 'schedule') return false
  return !!d.runNow
}

/** PO11: the requested schedule is created paused (schedule.enabled = false). */
export function schedulePaused(d: PrimaryInput): boolean {
  return d.kind !== 'run' && d.scheduleRequest?.enabled === false
}

/** PO2: the primary button says what one click does (PO11: "Approve & add paused schedule"). */
export function primaryLabel(d: PrimaryInput): string {
  return approveLabel({ kind: d.kind, hasSchedule: willSchedule(d), runNow: d.kind !== 'run' && willRunNow(d), schedulePaused: schedulePaused(d) })
}

/** The hint next to the primary button when approving also schedules. null = no schedule. */
export function scheduleHint(d: PrimaryInput): string | null {
  if (!willSchedule(d)) return null
  return schedulePaused(d)
    ? 'One click saves it and adds the schedule paused: it stays off until you turn it on in Schedules.'
    : 'One click saves it and turns the schedule on.'
}

const INPUT_TEMPLATE = /^\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/
/**
 * A repo id, path or `{{inputs.X}}` template as the user knows it: the repo's name (run inputs first, then the input's
 * default), else "repo from “Label”". Never shows a raw template.
 */
export function repoLabel(v: string, repos: Pick<Repo, 'id' | 'name' | 'path'>[], draft?: Pick<WorkflowDraft, 'inputs'> | null, inputs?: Record<string, string> | null): string {
  const m = INPUT_TEMPLATE.exec(v.trim())
  const def = m ? draft?.inputs.find((i) => i.name === m[1]) : undefined
  const id = m ? (inputs?.[m[1]] || def?.default || '') : v
  const r = id ? repos.find((x) => x.id === id || x.path === id) : undefined
  if (r) return r.name
  if (m) return `repo from “${def?.label || m[1]}”`
  return v
}

/** Native notification / hub title for a draft. */
export function draftTitle(d: Pick<AuthorDraft, 'kind' | 'adapter' | 'workflowName'>, provider: (a: AdapterId) => string): string {
  const who = provider(d.adapter)
  const what = d.kind === 'create' ? 'create' : d.kind === 'update' ? 'update' : d.kind === 'run' ? 'run' : 'schedule'
  return `${who} wants to ${what} “${d.workflowName}”`
}

export interface FlagChip {
  key: string
  text: string
  tone: 'neutral' | 'warning' | 'danger' | 'accent'
  title?: string
}

/** The flags row (AUTHORING.md §2.2 + PO4/PO5/PO8). Never claims more certainty than main has. */
export function flagChips(flags: AuthorFlags, repos: Repo[], fmtNext: (iso: string) => string = (s) => s): FlagChip[] {
  const out: FlagChip[] = []
  for (const u of flags.unattended ?? []) {
    out.push({
      key: `unattended:${u.sentence}`,
      text: `Runs unattended: ${u.sentence}${u.nextAt ? `, next ${fmtNext(u.nextAt)}` : ''}`,
      tone: 'warning',
      title: 'Approving changes what this workflow does on its schedule.'
    })
  }
  if (flags.scheduleSentence) out.push({ key: 'schedule', text: `Schedule: ${flags.scheduleSentence}`, tone: 'accent' })
  for (const name of flags.shellInputs ?? []) {
    out.push({ key: `shellin:${name}`, text: `Input “${name}” is executed as shell`, tone: 'danger', title: 'Its value is pasted into a command as-is. Check the value before approving.' })
  }
  if (flags.shellCommands > 0) out.push({ key: 'shell', text: `Runs shell commands (${flags.shellCommands})`, tone: 'warning', title: 'Every command is shown in full below.' })
  if (flags.pushes) out.push({ key: 'push', text: 'May push to git', tone: 'warning', title: 'A command or prompt mentions git push or gh pr create. Principia blocks pushes to the default branch from worktrees.' })
  if (flags.pushPolicy) out.push({ key: 'pushPolicy', text: `Push policy (enforced by Principia): ${flags.pushPolicy}`, tone: 'accent', title: 'Enforced by a pre-push hook on the run’s worktree, not by prompt text.' })
  if (flags.worktreeRepo) {
    const name = repoLabel(flags.worktreeRepo, repos)
    out.push({ key: 'worktree', text: `Uses a git worktree of ${name}`, tone: 'neutral', title: 'Your checkout is never touched.' })
  }
  if (flags.bypassAgents > 0) out.push({ key: 'bypass', text: `Agents that run without asking (${flags.bypassAgents})`, tone: 'danger' })
  // SLACK.md §10.4: Slack replaces iMessage. The reply mode of a Slack trigger is never a chip (it has its own row).
  for (const a of flags.slackAlerts ?? []) out.push({ key: `slackAlert:${a}`, text: `Slack alert to ${a}`, tone: 'neutral' })
  if (flags.slackReads) out.push({ key: 'slackReads', text: 'Agents can read Slack and draft replies', tone: 'neutral', title: 'Headless Claude steps get the Slack tools. Posting still follows the trigger’s reply mode.' })
  if (flags.memoryWrite) out.push({ key: 'memory', text: 'Writes shared memory', tone: 'neutral' })
  return out
}

/** Node-level diff when main did not send one (update cards). */
export function computeDiff(base: WorkflowDraft | null, draft: WorkflowDraft | null): { added: string[]; removed: string[]; changed: string[] } | null {
  if (!base || !draft) return null
  return draftDiff(base, draft)
}
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null).sort(([a], [b]) => (a < b ? -1 : 1))) : val
  )
}
/** Workflow-level changes (name, inputs, worktree) an update card mentions above the node diff. */
export function metaChanges(base: WorkflowDraft | null, draft: WorkflowDraft | null): string[] {
  if (!base || !draft) return []
  const out: string[] = []
  if (base.name !== draft.name) out.push(`Renamed “${base.name}” → “${draft.name}”`)
  if (base.description !== draft.description) out.push('Description changed')
  if (stable(base.inputs) !== stable(draft.inputs)) out.push('Inputs changed')
  if (stable(base.worktree ?? null) !== stable(draft.worktree ?? null)) out.push(draft.worktree ? 'Worktree settings changed' : 'Worktree removed')
  return out
}

/** PO4: inputs referenced in a shell, wait or check command (same rule as main). */
export function shellInputsOf(draft: WorkflowDraft): string[] {
  return inputsInCommands(draft)
}

/** Does any notify node DM "me" on Slack (needs Settings.slackAlertUserId)? */
export function wantsSlackMe(draft: WorkflowDraft | null): boolean {
  return !!draft?.nodes.some((n) => n.type === 'notify' && notifySlackOf(n)?.kind === 'me')
}

export interface NodeLine {
  id: string
  type: WorkflowNode['type']
  glyph: string
  typeLabel: string
  label: string
  who: string | null
  folder: string | null
  isolated: boolean
  /** Prompt / topic / criteria / message: collapsed to two lines on the card. */
  text: string | null
  /** Shell, wait and command-check commands: always shown in full, monospace. */
  command: string | null
  extras: string[]
}

/** Readable node list for the card (AUTHORING.md §2.2). */
export function nodeLines(draft: WorkflowDraft, profiles: AgentProfile[], repos: Repo[], inputs: Record<string, string> | null = null): NodeLine[] {
  const prof = (id: string | null | undefined): string | null => (id ? (profiles.find((p) => p.id === id)?.name ?? id) : null)
  const folder = (n: WorkflowNode): string | null => {
    if (n.isolate === 'worktree') return 'worktree'
    if (!n.cwd) return null
    return repoLabel(n.cwd, repos, draft, inputs)
  }
  return draft.nodes.map((n) => {
    const base = { id: n.id, type: n.type, glyph: NODE_GLYPH[n.type], typeLabel: NODE_LABEL[n.type], label: n.label || n.id, folder: folder(n), isolated: n.isolate === 'worktree' }
    switch (n.type) {
      case 'agent':
        return { ...base, who: prof(n.profileId), text: n.prompt, command: null, extras: n.memory && n.memory !== 'off' ? [`memory ${n.memory}`] : [] }
      case 'room':
        return { ...base, who: n.participants.map((p) => `${p.label} (${prof(p.profileId) ?? '?'})`).join(', '), text: n.topic, command: null, extras: [`${n.rounds} rounds`] }
      case 'check':
        return {
          ...base,
          who: n.command ? null : prof(n.profileId),
          text: n.command ? null : n.criteria,
          command: n.command,
          extras: [`checks ${n.target || '?'}`, `↺ ≤${n.maxRetries}`]
        }
      case 'shell':
        return { ...base, who: null, text: null, command: n.command, extras: [] }
      case 'wait':
        return {
          ...base,
          who: null,
          text: null,
          command: n.command,
          extras: [n.until === 'match' ? `until output matches /${n.pattern ?? ''}/` : 'until exit 0', `every ${intervalLabel(n.intervalSec)}`, `up to ${n.timeoutMin} min, then ${n.onTimeout === 'fail' ? 'fail' : 'continue'}`]
        }
      case 'notify':
        return { ...base, who: null, text: n.title ? `${n.title}\n${n.message}` : n.message, command: null, extras: notifyExtras(n) }
    }
  })
}

// ---------- provenance ----------

/** "Created by Claude in example-project · Claude" (AUTHORING.md §2.5). */
export function originLine(origin: WorkflowOrigin, provider: (a: AdapterId) => string): string {
  return `Created by ${provider(origin.adapter)} in ${origin.ownerLabel}`
}
/** "edited by you" / "updated by Claude 3×" suffixes. */
export function originDetail(origin: WorkflowOrigin, provider: (a: AdapterId) => string): string | null {
  const parts: string[] = []
  if (origin.edited) parts.push('you edited it before approving')
  const n = origin.updatedBy?.length ?? 0
  if (n) parts.push(`updated by ${provider(origin.adapter)} ${n === 1 ? 'once' : `${n}×`}`)
  return parts.length ? parts.join(' · ') : null
}

// ---------- runs: nothing to do + worktrees ----------

export function isNothingToDo(run: Pick<Run, 'status' | 'outcome'>): boolean {
  return run.status === 'passed' && run.outcome === 'nothing_to_do'
}
/** "Passed · nothing to do" or the plain status. */
export function runStatusLabel(run: Pick<Run, 'status' | 'outcome'>): string {
  if (isNothingToDo(run)) return 'Passed · nothing to do'
  return run.status
}

const KEPT: Record<NonNullable<RunWorktree['keptReason']>, string> = {
  pushed: 'kept (pushed)',
  dirty: 'kept (unpushed work)',
  failed: 'kept (run failed)',
  canceled: 'kept (canceled)'
}
export function worktreeState(wt: Pick<RunWorktree, 'status' | 'keptReason' | 'error'>): string {
  switch (wt.status) {
    case 'creating':
      return 'creating'
    case 'active':
      return 'in use'
    case 'kept':
      return wt.keptReason ? KEPT[wt.keptReason] : 'kept'
    case 'removed':
      return 'removed'
    case 'error':
      return wt.error ? `error · ${wt.error}` : 'error'
  }
}
export function worktreeChip(wt: Pick<RunWorktree, 'branch' | 'status' | 'keptReason' | 'error'>): string {
  return `${wt.branch} · ${worktreeState(wt)}`
}
/** Remove is offered for kept and errored worktrees (never while a run uses it). */
export function canRemoveWorktree(wt: Pick<RunWorktree, 'status'>): boolean {
  return wt.status === 'kept' || wt.status === 'error'
}

// ---------- Claude history (A3) ----------

export function historyTime(h: Pick<ClaudeHistorySession, 'endedAt' | 'startedAt'>): number {
  const iso = h.endedAt ?? h.startedAt
  return iso ? new Date(iso).getTime() : 0
}

/** "12 turns · 2 subagents" (unknown turn counts are left out). */
export function historyMeta(h: Pick<ClaudeHistorySession, 'turns' | 'subagents'>): string {
  const parts: string[] = []
  if (h.turns != null) parts.push(`${h.turns} turn${h.turns === 1 ? '' : 's'}`)
  if (h.subagents > 0) parts.push(`${h.subagents} subagent${h.subagents === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** Repo name when the cwd belongs to a Principia repo, else a ~ path. */
export function historyPlace(h: Pick<ClaudeHistorySession, 'cwd' | 'repoId'>, repos: Repo[], home: string | null = null): string {
  const r = h.repoId ? repos.find((x) => x.id === h.repoId) : (h.cwd ? repos.find((x) => x.path === h.cwd) : undefined)
  if (r) return r.name
  if (!h.cwd) return 'Unknown folder'
  return home && (h.cwd === home || h.cwd.startsWith(`${home}/`)) ? `~${h.cwd.slice(home.length)}` : tildify(h.cwd)
}

export interface HistoryGroup {
  key: string
  label: string
  repoId: string | null
  cwd: string | null
  items: ClaudeHistorySession[]
  latest: number
}

/** Canvas History layer: one lane per repo (or cwd), newest lane first, newest card first. */
export function historyGroups(items: ClaudeHistorySession[], repos: Repo[], home: string | null = null): HistoryGroup[] {
  const m = new Map<string, HistoryGroup>()
  for (const h of items) {
    const repo = h.repoId ? repos.find((x) => x.id === h.repoId) : h.cwd ? repos.find((x) => x.path === h.cwd) : undefined
    const key = repo ? `repo:${repo.id}` : `cwd:${h.cwd ?? '?'}`
    let g = m.get(key)
    if (!g) {
      g = { key, label: repo ? repo.name : historyPlace(h, repos, home), repoId: repo?.id ?? null, cwd: repo ? repo.path : h.cwd, items: [], latest: 0 }
      m.set(key, g)
    }
    g.items.push(h)
    g.latest = Math.max(g.latest, historyTime(h))
  }
  const groups = [...m.values()]
  for (const g of groups) g.items.sort((a, b) => historyTime(b) - historyTime(a))
  return groups.sort((a, b) => b.latest - a.latest)
}

/** Home: sessions outside Principia from the last `days`, newest first, at most `max`. */
export function recentOutside(items: ClaudeHistorySession[], now: number, days = 7, max = 8): ClaudeHistorySession[] {
  const since = now - days * 86_400_000
  return items
    .filter((h) => !h.inHive && historyTime(h) >= since)
    .sort((a, b) => historyTime(b) - historyTime(a))
    .slice(0, max)
}

/** Canvas lane: cards from the last `hours`; the rest collapse to "+n older". */
export function splitRecent(items: ClaudeHistorySession[], now: number, hours = 72, max = 120): { shown: ClaudeHistorySession[]; older: number } {
  const since = now - hours * 3_600_000
  const recent = items.filter((h) => historyTime(h) >= since)
  const shown = recent.slice(0, max)
  return { shown, older: items.length - shown.length }
}

/** Client-side filter for the "Show all" sheet. */
export function matchHistory(h: ClaudeHistorySession, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  return [h.title, h.cwd ?? '', h.gitBranch ?? '', h.model ?? ''].some((x) => x.toLowerCase().includes(s))
}

function notifyExtras(n: Extract<WorkflowNode, { type: 'notify' }>): string[] {
  const l = notifyLabel(notifySlackOf(n))
  return l ? [`+ ${l}`] : []
}
