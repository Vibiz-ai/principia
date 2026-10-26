/**
 * ORCHESTRATOR.md §3 "pushing features": what Principia suggests to the founder, in Needs you. Three kinds:
 *
 * - a routine: one click makes the schedule (the click is the founder's yes; nothing is scheduled before it). When it
 *   is one of the ready-made routines (Automations › Routines: morning brief, weekly review, inbox triage, social
 *   drafts, the pull requests digest, the code brief) it links there instead (principia://automations/routines?add=…),
 *   so it is turned on, off and retimed in one place; a ready-made routine that is already on is never suggested;
 * - a connection: the principia://connect/<id> link (the founder sets it up; Principia never connects anything itself);
 * - a task: start a task a manual agent waits on, or file a task the team suggested.
 *
 * Each suggestion has a fingerprint. The same fingerprint is never open twice, and after the founder dismissed (or
 * accepted) one it waits 14 days before it may come back. At most 3 new suggestions per company per day. Text is
 * redacted and clipped. No Electron imports.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { SUGGESTION_LIMITS, type OrchSuggestion, type SuggestionKind, type SuggestionStatus } from '../../shared/orchestrator'
import { connectLink, formatDeepLink } from '../../shared/deepLink'
import { DAY_KEYS, routineDef, routineTimeOf, type RoutineId } from '../../shared/routines'

const DAY = 86_400_000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** A cron of 5 fields made of the usual characters, else null (the scheduler validates it again on accept). */
export function safeCron(c: string | undefined | null): string | null {
  const t = (c ?? '').trim()
  return /^[\d*/,\- ]+$/.test(t) && t.split(/\s+/).length === 5 ? t : null
}

/** The ready-made routine a routine idea is, or null (then accepting makes a plain schedule). */
const TEMPLATES: readonly [RoutineId, RegExp][] = [
  ['repo-health', /\b(pull requests?|prs?|failing (checks|ci)|stale branches)\b/],
  ['code-brief', /\b(commits?|code activity|what changed in the code)\b/],
  ['inbox-triage', /\b(triage|support inbox|support tickets?|customer questions)\b/],
  ['social-drafts', /\b(social|instagram|linkedin|tweets?|posts? drafts?|draft posts?)\b/],
  ['weekly-review', /\b(weekly|every week|each week|friday) (review|summary|report|recap|digest)\b|\bweekly company review\b/],
  ['morning-brief', /\b(morning|daily|every day|each day) (brief|briefing|summary|digest|standup|update)\b/]
]
export function routineTemplateFor(text: string): RoutineId | null {
  const t = text.toLowerCase()
  for (const [id, re] of TEMPLATES) if (re.test(t)) return id
  return null
}
/** principia://automations/routines?add=<id>[&at=9:00&days=mon,tue]: the founder still presses Turn on there. */
export function routineLink(id: RoutineId, cron: string | null, companyId: string): string {
  const time = cron && cron !== routineDef(id).cron ? routineTimeOf(cron) : null
  return formatDeepLink({ kind: 'automations', tab: 'routines', add: id, ...(time ? { at: time.time, days: time.days.map((d) => DAY_KEYS[d]).join(',') } : {}), companyId })
}

export interface SuggestInput {
  companyId: string
  kind: SuggestionKind
  title: string
  detail?: string
  /** defaults: the task id (a task to start), the connection id, else the normalised title */
  fingerprint?: string
  cron?: string
  connectionId?: string
  taskId?: string
  taskIdentifier?: string
  agentId?: string
}
export interface SuggestResult { status: 'created' | 'skipped'; detail: string; id?: string }

/** What accepting does, from the wire (each is the founder's own yes). */
export interface AcceptDeps {
  /** a routine: a schedule for the agent (task mode) or the company; returns its name */
  createRoutine(s: OrchSuggestion): string
  /** a task suggestion with a task: start it (a human start) */
  startTask(taskId: string): string
  /** a task suggestion without a task: file it in To do; returns its identifier */
  fileTask(s: OrchSuggestion): string
}

export interface SuggestionsDeps {
  db: Database.Database
  /** a ready-made routine is already on for the company (Settings.routines) */
  routineOn?: (companyId: string, id: RoutineId) => boolean
  redact?: (s: string) => string
  now?: () => Date
  onChange?: (companyId: string) => void
}

interface Row { id: string; company_id: string; kind: string; fingerprint: string; title: string; detail: string; data_json: string; status: string; created_at: string; decided_at: string | null }

export class Suggestions {
  constructor(private readonly d: SuggestionsDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  private text(s: string, n: number): string {
    const t = flat(s)
    return clip(this.d.redact ? this.d.redact(t) : t, n)
  }

  static fingerprint(i: Pick<SuggestInput, 'kind' | 'title' | 'fingerprint' | 'taskId' | 'connectionId'>): string {
    if (i.fingerprint) return `${i.kind}:${i.fingerprint}`
    if (i.kind === 'task' && i.taskId) return `task:${i.taskId}`
    if (i.kind === 'connection' && i.connectionId) return `connection:${norm(i.connectionId)}`
    return `${i.kind}:${norm(i.title).slice(0, 120)}`
  }

  /** One suggestion, unless the same one is open, cooling down, or today's 3 are used. Never throws. */
  suggest(i: SuggestInput): SuggestResult {
    try {
      const title = this.text(i.title, SUGGESTION_LIMITS.title)
      if (!title) return { status: 'skipped', detail: 'nothing to suggest' }
      const template = i.kind === 'routine' ? routineTemplateFor(`${i.title} ${i.detail ?? ''}`) : null
      if (template && this.d.routineOn?.(i.companyId, template)) return { status: 'skipped', detail: `the ${routineDef(template).name} routine is already on` }
      const print = template && !i.fingerprint ? `routine:${template}` : Suggestions.fingerprint(i)
      const now = this.now()
      const prev = this.d.db.prepare('SELECT * FROM orch_suggestions WHERE company_id=? AND fingerprint=? ORDER BY created_at DESC LIMIT 1').get(i.companyId, print) as Row | undefined
      if (prev?.status === 'open') return { status: 'skipped', detail: 'already suggested, waiting for you', id: prev.id }
      if (prev && prev.status !== 'expired') {
        const since = prev.decided_at ?? prev.created_at
        if (now.getTime() - Date.parse(since) < SUGGESTION_LIMITS.cooldownDays * DAY) return { status: 'skipped', detail: `you ${prev.status === 'accepted' ? 'took' : 'dismissed'} this less than ${SUGGESTION_LIMITS.cooldownDays} days ago` }
      }
      const dayAgo = new Date(now.getTime() - DAY).toISOString()
      const today = (this.d.db.prepare('SELECT COUNT(*) AS n FROM orch_suggestions WHERE company_id=? AND created_at>=?').get(i.companyId, dayAgo) as { n: number }).n
      if (today >= SUGGESTION_LIMITS.perDay) return { status: 'skipped', detail: `Principia already suggested ${SUGGESTION_LIMITS.perDay} things today` }
      const cron = i.kind === 'routine' ? safeCron(i.cron) : null
      const data = {
        ...(cron ? { cron } : {}),
        ...(template ? { routineId: template, link: routineLink(template, cron, i.companyId) } : {}),
        ...(i.kind === 'connection' && i.connectionId ? { connectionId: i.connectionId.slice(0, 80), link: connectLink(i.connectionId, i.companyId) } : {}),
        ...(i.taskId ? { taskId: i.taskId } : {}),
        ...(i.taskIdentifier ? { taskIdentifier: i.taskIdentifier.slice(0, 40) } : {}),
        ...(i.agentId ? { agentId: i.agentId } : {})
      }
      const id = `osg_${randomBytes(6).toString('hex')}`
      this.d.db
        .prepare("INSERT INTO orch_suggestions(id,company_id,kind,fingerprint,title,detail,data_json,status,created_at) VALUES (?,?,?,?,?,?,?,'open',?)")
        .run(id, i.companyId, i.kind, print, title, this.text(i.detail ?? '', SUGGESTION_LIMITS.detail), JSON.stringify(data), now.toISOString())
      this.changed(i.companyId)
      return { status: 'created', detail: `suggested to you: ${title}`, id }
    } catch (e) {
      return { status: 'skipped', detail: `could not suggest: ${clip(String(e instanceof Error ? e.message : e), 120)}` }
    }
  }

  private changed(companyId: string): void {
    try {
      this.d.onChange?.(companyId)
    } catch {
      /* the UI refresh never fails a write */
    }
  }

  private view(r: Row): OrchSuggestion {
    let data: Record<string, string> = {}
    try {
      data = JSON.parse(r.data_json) as Record<string, string>
    } catch {
      data = {}
    }
    return {
      id: r.id,
      companyId: r.company_id,
      kind: r.kind as SuggestionKind,
      title: r.title,
      detail: r.detail,
      status: r.status as SuggestionStatus,
      ...(data.cron ? { cron: data.cron } : {}),
      ...(data.link ? { link: data.link } : {}),
      ...(data.routineId ? { routineId: data.routineId } : {}),
      ...(data.taskId ? { taskId: data.taskId } : {}),
      ...(data.taskIdentifier ? { taskIdentifier: data.taskIdentifier } : {}),
      ...(data.agentId ? { agentId: data.agentId } : {}),
      createdAt: r.created_at,
      decidedAt: r.decided_at
    }
  }

  get(id: string): OrchSuggestion | null {
    const r = this.d.db.prepare('SELECT * FROM orch_suggestions WHERE id=?').get(id) as Row | undefined
    return r ? this.view(r) : null
  }
  /** Open suggestions of a company (or every company), oldest first. */
  list(companyId?: string | null): OrchSuggestion[] {
    const rows = (companyId
      ? this.d.db.prepare("SELECT * FROM orch_suggestions WHERE company_id=? AND status='open' ORDER BY created_at LIMIT 50").all(companyId)
      : this.d.db.prepare("SELECT * FROM orch_suggestions WHERE status='open' ORDER BY created_at LIMIT 200").all()) as Row[]
    return rows.map((r) => this.view(r))
  }

  /** A suggestion that no longer fits (its task moved on): gone from Needs you, free to come back later. */
  expire(id: string): void {
    const r = this.d.db.prepare("UPDATE orch_suggestions SET status='expired', decided_at=? WHERE id=? AND status='open'").run(this.now().toISOString(), id)
    if (r.changes) {
      const s = this.get(id)
      if (s) this.changed(s.companyId)
    }
  }

  /** The founder's answer. Accepting runs the suggestion's one action; a failed action leaves it open. */
  decide(id: string, decision: 'accept' | 'dismiss', act: AcceptDeps): { suggestion: OrchSuggestion; detail: string } {
    const s = this.get(id)
    if (!s) throw new Error('That suggestion is gone')
    if (s.status !== 'open') return { suggestion: s, detail: 'Already handled' }
    let detail = 'Dismissed. Principia will not suggest it again for two weeks.'
    if (decision === 'accept') {
      // a ready-made routine is turned on in Routines (the founder presses Turn on there), never made twice here
      if (s.kind === 'routine' && s.routineId && s.link) detail = `Open ${s.link} and press Turn on.`
      else if (s.kind === 'routine') detail = `Made the routine "${act.createRoutine(s)}".`
      else if (s.kind === 'connection') detail = s.link ? `Open ${s.link} to set it up.` : 'Open Connections to set it up.'
      else if (s.taskId) detail = act.startTask(s.taskId)
      else detail = `Filed ${act.fileTask(s)} in To do.`
    }
    this.d.db.prepare('UPDATE orch_suggestions SET status=?, decided_at=? WHERE id=?').run(decision === 'accept' ? 'accepted' : 'dismissed', this.now().toISOString(), id)
    this.changed(s.companyId)
    return { suggestion: this.get(id)!, detail }
  }
}
