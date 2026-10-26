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
 * - an autopilot offer (AUTOPILOT.md §6): "Put your ads on autopilot?" with a level; accepting turns the playbook on
 *   for the company at the level the founder picked. One offer per company per day at most, never one already on,
 *   and "Never for this" keeps it away for good. A paused autopilot (a run went above its level) is a card too.
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
import { isPlaybookId, isPlaybookLevel, levelLabel, maxLevel, OFFER_MAX_LEVEL, playbookDef, type PlaybookLevel } from '../../shared/autopilotPlaybooks'

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
  /** autopilot: the playbook and the level the offer preselects */
  playbookId?: string
  level?: number
  /** autopilot: Principia paused it (the card offers Resume) */
  breach?: boolean
  /** autopilot (money): the daily budget the work named, the offer's budget cap */
  budgetUsd?: number
  /** autopilot: the connection it needs is missing (the card says "Connect … first"; turning on waits for it) */
  needs?: { label: string; connectId: string }
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
  /** an autopilot offer: turn the playbook on for the company at `level`; a paused one: resume it. Returns plain words. */
  turnOnPlaybook?(s: OrchSuggestion, level: PlaybookLevel): string
  resumePlaybook?(s: OrchSuggestion): string
}

export interface SuggestionsDeps {
  db: Database.Database
  /** a ready-made routine is already on for the company (Settings.routines) */
  routineOn?: (companyId: string, id: RoutineId) => boolean
  /** a playbook is already on for the company (paused counts: it is never offered again) */
  playbookOn?: (companyId: string, id: string) => boolean
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
      if (i.kind === 'autopilot') return this.offer(i, title)
      const template = i.kind === 'routine' ? routineTemplateFor(`${i.title} ${i.detail ?? ''}`) : null
      if (template && this.d.routineOn?.(i.companyId, template)) return { status: 'skipped', detail: `the ${routineDef(template).name} routine is already on` }
      const print = template && !i.fingerprint ? `routine:${template}` : Suggestions.fingerprint(i)
      const now = this.now()
      const prev = this.d.db.prepare('SELECT * FROM orch_suggestions WHERE company_id=? AND fingerprint=? ORDER BY created_at DESC LIMIT 1').get(i.companyId, print) as Row | undefined
      if (prev?.status === 'open') return { status: 'skipped', detail: 'already suggested, waiting for you', id: prev.id }
      if (prev?.status === 'never') return { status: 'skipped', detail: 'you said never for this' }
      if (prev && prev.status !== 'expired') {
        const since = prev.decided_at ?? prev.created_at
        if (now.getTime() - Date.parse(since) < SUGGESTION_LIMITS.cooldownDays * DAY) return { status: 'skipped', detail: `you ${prev.status === 'accepted' ? 'took' : 'dismissed'} this less than ${SUGGESTION_LIMITS.cooldownDays} days ago` }
      }
      const dayAgo = new Date(now.getTime() - DAY).toISOString()
      const today = (this.d.db.prepare("SELECT COUNT(*) AS n FROM orch_suggestions WHERE company_id=? AND status!='queued' AND created_at>=?").get(i.companyId, dayAgo) as { n: number }).n
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

  /**
   * Whether an autopilot offer for this playbook could be made now (not on, not open or queued, not "Never", not in
   * its quiet period). The chief of staff skips the ones that cannot, so the next best playbook gets the offer.
   */
  offerable(companyId: string, playbookId: string): boolean {
    if (!isPlaybookId(playbookId) || this.d.playbookOn?.(companyId, playbookId)) return false
    const prev = this.d.db.prepare('SELECT * FROM orch_suggestions WHERE company_id=? AND fingerprint=? ORDER BY created_at DESC LIMIT 1').get(companyId, `autopilot:${playbookId}`) as Row | undefined
    if (!prev || prev.status === 'expired') return true
    if (prev.status === 'open' || prev.status === 'queued' || prev.status === 'never') return false
    return this.now().getTime() - Date.parse(prev.decided_at ?? prev.created_at) >= SUGGESTION_LIMITS.cooldownDays * DAY
  }

  /**
   * The oldest offer kept for later (the day's offer was already made) comes out once a day is free: it was real work,
   * so it is not lost. One that no longer fits (turned on meanwhile) expires.
   */
  private promoteQueued(companyId: string | null): void {
    const rows = (companyId
      ? this.d.db.prepare("SELECT * FROM orch_suggestions WHERE company_id=? AND status='queued' ORDER BY created_at LIMIT 20").all(companyId)
      : this.d.db.prepare("SELECT * FROM orch_suggestions WHERE status='queued' ORDER BY created_at LIMIT 50").all()) as Row[]
    if (!rows.length) return
    const now = this.now()
    const dayAgo = new Date(now.getTime() - DAY).toISOString()
    const done = new Set<string>()
    for (const r of rows) {
      if (done.has(r.company_id)) continue
      let data: Record<string, string> = {}
      try {
        data = JSON.parse(r.data_json) as Record<string, string>
      } catch {
        data = {}
      }
      if (data.playbookId && this.d.playbookOn?.(r.company_id, data.playbookId)) {
        this.d.db.prepare("UPDATE orch_suggestions SET status='expired', decided_at=? WHERE id=?").run(now.toISOString(), r.id)
        continue
      }
      const offers = (this.d.db.prepare("SELECT COUNT(*) AS n FROM orch_suggestions WHERE company_id=? AND kind='autopilot' AND fingerprint LIKE 'autopilot:%' AND status!='queued' AND created_at>=?").get(r.company_id, dayAgo) as { n: number }).n
      done.add(r.company_id)
      if (offers >= SUGGESTION_LIMITS.autopilotPerDay) continue
      this.d.db.prepare("UPDATE orch_suggestions SET status='open', created_at=? WHERE id=?").run(now.toISOString(), r.id)
      this.changed(r.company_id)
    }
  }

  /**
   * An autopilot offer: never one already on, never after "Never for this", 14 days after Not now, at most one a day
   * per company (and inside the daily 3). A paused-autopilot card skips the daily caps: it is about something that
   * already happened.
   */
  private offer(i: SuggestInput, title: string): SuggestResult {
    if (!isPlaybookId(i.playbookId)) return { status: 'skipped', detail: 'not an autopilot Principia knows' }
    const def = playbookDef(i.playbookId)
    const now = this.now()
    const print = i.breach ? `autopilot-paused:${i.playbookId}:${now.toISOString().slice(0, 10)}` : `autopilot:${i.playbookId}`
    if (!i.breach && this.d.playbookOn?.(i.companyId, i.playbookId)) return { status: 'skipped', detail: `${def.name} is already on` }
    const prev = this.d.db.prepare('SELECT * FROM orch_suggestions WHERE company_id=? AND fingerprint=? ORDER BY created_at DESC LIMIT 1').get(i.companyId, print) as Row | undefined
    if (prev?.status === 'open') return { status: 'skipped', detail: 'already offered, waiting for you', id: prev.id }
    if (prev?.status === 'queued') return { status: 'skipped', detail: 'already kept for a later day', id: prev.id }
    if (prev?.status === 'never') return { status: 'skipped', detail: 'you said never for this' }
    if (prev && prev.status !== 'expired' && now.getTime() - Date.parse(prev.decided_at ?? prev.created_at) < SUGGESTION_LIMITS.cooldownDays * DAY) return { status: 'skipped', detail: `you answered this less than ${SUGGESTION_LIMITS.cooldownDays} days ago` }
    // the day's offer already made: this one is kept for a later day, not lost
    let status: 'open' | 'queued' = 'open'
    if (!i.breach) {
      const dayAgo = new Date(now.getTime() - DAY).toISOString()
      const offers = (this.d.db.prepare("SELECT COUNT(*) AS n FROM orch_suggestions WHERE company_id=? AND kind='autopilot' AND fingerprint LIKE 'autopilot:%' AND status!='queued' AND created_at>=?").get(i.companyId, dayAgo) as { n: number }).n
      const today = (this.d.db.prepare("SELECT COUNT(*) AS n FROM orch_suggestions WHERE company_id=? AND status!='queued' AND created_at>=?").get(i.companyId, dayAgo) as { n: number }).n
      if (offers >= SUGGESTION_LIMITS.autopilotPerDay || today >= SUGGESTION_LIMITS.perDay) status = 'queued'
    }
    // an offer never preselects more than Level 2 (Level 3 is its own step, behind a confirm, in Automations)
    const level = Math.min(isPlaybookLevel(i.level) ? i.level : def.defaultLevel, maxLevel(def, false), OFFER_MAX_LEVEL)
    const budget = def.money && typeof i.budgetUsd === 'number' && Number.isFinite(i.budgetUsd) && i.budgetUsd >= 1 ? Math.round(Math.min(i.budgetUsd, 100_000)) : null
    const data = {
      playbookId: i.playbookId,
      level: String(level),
      ...(i.breach ? { breach: '1' } : {}),
      ...(i.agentId ? { agentId: i.agentId } : {}),
      ...(budget ? { budgetUsd: String(budget) } : {}),
      ...(i.needs ? { needsLabel: i.needs.label.slice(0, 80), needsId: i.needs.connectId.slice(0, 40), link: connectLink(i.needs.connectId, i.companyId) } : {}),
      ...(i.taskIdentifier ? { taskIdentifier: i.taskIdentifier.slice(0, 40) } : {})
    }
    const id = `osg_${randomBytes(6).toString('hex')}`
    const detail = i.detail ?? `${def.summary} ${def.cadence}. ${levelLabel(level as PlaybookLevel)}.`
    this.d.db
      .prepare("INSERT INTO orch_suggestions(id,company_id,kind,fingerprint,title,detail,data_json,status,created_at) VALUES (?,?,'autopilot',?,?,?,?,?,?)")
      .run(id, i.companyId, print, title, this.text(detail, SUGGESTION_LIMITS.detail), JSON.stringify(data), status, now.toISOString())
    if (status === 'queued') return { status: 'created', detail: `kept for tomorrow (Principia already offered an autopilot today): ${title}`, id }
    this.changed(i.companyId)
    return { status: 'created', detail: `offered to you: ${title}`, id }
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
      ...(data.playbookId ? { playbookId: data.playbookId } : {}),
      ...(data.level && isPlaybookLevel(Number(data.level)) ? { level: Number(data.level) } : {}),
      ...(data.breach ? { breach: true } : {}),
      ...(data.budgetUsd && Number(data.budgetUsd) > 0 ? { budgetUsd: Number(data.budgetUsd) } : {}),
      ...(data.needsLabel && data.needsId ? { needs: { label: data.needsLabel, connectId: data.needsId } } : {}),
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
    try {
      this.promoteQueued(companyId ?? null)
    } catch {
      /* a later read tries again */
    }
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
  decide(id: string, decision: 'accept' | 'dismiss' | 'never', act: AcceptDeps, opts: { level?: number } = {}): { suggestion: OrchSuggestion; detail: string } {
    const s = this.get(id)
    if (!s) throw new Error('That suggestion is gone')
    if (s.status !== 'open') return { suggestion: s, detail: 'Already handled' }
    let detail = 'Dismissed. Principia will not suggest it again for two weeks.'
    if (decision === 'never') {
      if (s.kind !== 'autopilot' || s.breach) throw new Error('Only an autopilot offer can be turned down for good')
      detail = 'Got it. Principia will not offer this autopilot again.'
    } else if (s.kind === 'autopilot' && decision === 'dismiss' && s.breach) detail = 'It stays paused. Resume it in Automations › Autopilot when you want.'
    else if (s.kind === 'autopilot' && decision === 'accept') {
      if (s.breach) {
        if (!act.resumePlaybook) throw new Error('Playbooks are not available')
        detail = act.resumePlaybook(s)
      } else {
        if (!act.turnOnPlaybook || !s.playbookId || !isPlaybookId(s.playbookId)) throw new Error('Playbooks are not available')
        const level = opts.level ?? s.level ?? playbookDef(s.playbookId).defaultLevel
        // the offer card turns on at most Level 2 (Level 3 is a separate, explicit step behind a confirm in Automations)
        if (!isPlaybookLevel(level) || level > Math.min(OFFER_MAX_LEVEL, maxLevel(playbookDef(s.playbookId), false))) throw new Error(`${playbookDef(s.playbookId).name} can be turned on at Level 1 or 2 here. Choose Level 3 in Automations › Autopilot.`)
        detail = act.turnOnPlaybook(s, level)
      }
    } else if (decision === 'accept') {
      // a ready-made routine is turned on in Routines (the founder presses Turn on there), never made twice here
      if (s.kind === 'routine' && s.routineId && s.link) detail = `Open ${s.link} and press Turn on.`
      else if (s.kind === 'routine') detail = `Made the routine "${act.createRoutine(s)}".`
      else if (s.kind === 'connection') detail = s.link ? `Open ${s.link} to set it up.` : 'Open Connections to set it up.'
      else if (s.taskId) detail = act.startTask(s.taskId)
      else detail = `Filed ${act.fileTask(s)} in To do.`
    }
    this.d.db.prepare('UPDATE orch_suggestions SET status=?, decided_at=? WHERE id=?').run(decision === 'accept' ? 'accepted' : decision === 'never' ? 'never' : 'dismissed', this.now().toISOString(), id)
    this.changed(s.companyId)
    return { suggestion: this.get(id)!, detail }
  }
}
