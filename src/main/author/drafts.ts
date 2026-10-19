/**
 * author_drafts + author_run_grants repository (AUTHORING.md §2.1, §2.4, §10; PO2, PO3). Synchronous (better-sqlite3),
 * no Electron imports. Every agent-supplied string is redacted before it is persisted.
 */
import crypto from 'node:crypto'
import type { AuthorDraft, AuthorDraftDetail, AuthorDraftKind, AuthorDraftSchedule, AuthorDraftStatus, AuthorFlags, AuthorRunGrant } from '../../shared/authoring'
import { canonicalDraftJson, draftDiff } from '../../shared/authoring'
import type { AdapterId, Id, ScheduleInput, Workflow, WorkflowDraft } from '../../shared/types'
import { newId } from '../../shared/ids'
import type { DB } from '../db'
import type { SlackTriggerInput } from '../../shared/slack'

export const PENDING_EXPIRY_DAYS = 7
export const DECIDED_RETENTION_DAYS = 90

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
/** PO3: what a run permission is pinned to. */
export const workflowHash = (w: Pick<WorkflowDraft, 'name' | 'description' | 'inputs' | 'nodes' | 'worktree'>): string => sha256(canonicalDraftJson(w))

export interface DraftOwner {
  kind: 'session'
  sessionId: Id
  agentId: Id | null
  ownerKey: string
  ownerLabel: string
  adapter: AdapterId
}

export interface DraftInsert {
  kind: AuthorDraftKind
  owner: DraftOwner
  summary: string
  workflowId: Id | null
  workflowName: string
  payload: WorkflowDraft | { inputs: Record<string, string>; reason: string | null }
  base: WorkflowDraft | null
  schedule: AuthorDraftSchedule | null
  runNow: { inputs: Record<string, string> } | null
  flags: AuthorFlags
  warnings: string[]
  /** SLACK.md §9.5: the trigger approving also creates (one card, one click). */
  slackTrigger?: SlackTriggerInput | null
}

export interface DraftResult {
  workflowId: Id | null
  scheduleId: Id | null
  runId: Id | null
  sentence?: string | null
}

interface Row {
  id: string
  kind: string
  status: string
  owner_kind: string
  session_id: string | null
  run_id: string | null
  step_id: string | null
  agent_id: string | null
  owner_key: string
  owner_label: string
  adapter: string
  summary: string
  workflow_id: string | null
  workflow_name: string
  payload_json: string
  base_json: string | null
  schedule_json: string | null
  run_now_json: string | null
  content_hash: string
  ask_id: string | null
  flags_json: string
  warnings_json: string
  decision_note: string | null
  decided_at: string | null
  edited: number
  run_allowed: number
  result_json: string | null
  created_at: string
  slack_trigger_json?: string | null
}

const json = <T>(s: string | null | undefined, fb: T): T => {
  if (s == null) return fb
  try {
    return JSON.parse(s) as T
  } catch {
    return fb
  }
}

/** Internal view with everything the broker needs. */
export interface DraftRecord extends AuthorDraft {
  ownerKey: string
  contentHash: string
  payload: WorkflowDraft | { inputs: Record<string, string>; reason: string | null }
  baseDraft: WorkflowDraft | null
  scheduleRequest: AuthorDraftSchedule | null
  runNowRequest: { inputs: Record<string, string> } | null
  slackTriggerRequest: SlackTriggerInput | null
}

const toRecord = (r: Row): DraftRecord => {
  const result = json<DraftResult | null>(r.result_json, null)
  return {
    id: r.id,
    kind: r.kind as AuthorDraftKind,
    status: r.status as AuthorDraftStatus,
    ownerLabel: r.owner_label,
    adapter: r.adapter as AdapterId,
    sessionId: r.session_id,
    runId: r.run_id,
    stepId: r.step_id,
    agentId: r.agent_id,
    askId: r.ask_id,
    summary: r.summary,
    workflowId: r.workflow_id ?? result?.workflowId ?? null,
    workflowName: r.workflow_name,
    flags: json<AuthorFlags>(r.flags_json, {
      shellCommands: 0,
      worktreeRepo: null,
      pushes: false,
      bypassAgents: 0,
      memoryWrite: false,
      scheduleSentence: null,
      inputs: null
    }),
    warnings: json<string[]>(r.warnings_json, []),
    decisionNote: r.decision_note,
    edited: !!r.edited,
    runAllowed: !!r.run_allowed,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    result: result ? { workflowId: result.workflowId, scheduleId: result.scheduleId, runId: result.runId } : null,
    ownerKey: r.owner_key,
    contentHash: r.content_hash,
    payload: json(r.payload_json, { name: '', description: '', inputs: [], nodes: [] } as WorkflowDraft),
    baseDraft: json<WorkflowDraft | null>(r.base_json, null),
    scheduleRequest: json<AuthorDraftSchedule | null>(r.schedule_json, null),
    runNowRequest: json<{ inputs: Record<string, string> } | null>(r.run_now_json, null),
    slackTriggerRequest: json<SlackTriggerInput | null>(r.slack_trigger_json ?? null, null)
  }
}

/** Public AuthorDraft (no payload). */
export function publicDraft(r: DraftRecord): AuthorDraft {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    ownerLabel: r.ownerLabel,
    adapter: r.adapter,
    sessionId: r.sessionId,
    runId: r.runId,
    stepId: r.stepId,
    agentId: r.agentId,
    askId: r.askId,
    summary: r.summary,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    flags: r.flags,
    warnings: r.warnings,
    decisionNote: r.decisionNote,
    edited: r.edited,
    runAllowed: r.runAllowed,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    result: r.result ?? null
  }
}

export class AuthorDrafts {
  constructor(
    private db: DB,
    private redact: (s: string) => string = (s) => s,
    private now: () => Date = () => new Date()
  ) {}

  private red(s: string, max: number): string {
    const t = this.redact(s)
    return t.length > max ? t.slice(0, max) : t
  }
  /** Redacts every string inside a JSON value (prompts and commands may quote secrets). */
  private redJson(v: unknown): string {
    return this.redact(JSON.stringify(v))
  }

  /** Dedupe key: kind + target + payload + schedule + run_now. */
  static contentHash(d: Pick<DraftInsert, 'kind' | 'workflowId' | 'payload' | 'schedule' | 'runNow' | 'slackTrigger'>): string {
    const payload = 'nodes' in d.payload ? canonicalDraftJson(d.payload) : JSON.stringify(d.payload)
    return sha256(
      JSON.stringify([
        d.kind,
        d.workflowId,
        payload,
        d.schedule ? { when: d.schedule.when, name: d.schedule.name, inputs: d.schedule.inputs, ...(d.schedule.enabled === false ? { enabled: false } : {}) } : null,
        d.runNow,
        ...(d.slackTrigger ? [d.slackTrigger] : [])
      ])
    )
  }

  insert(d: DraftInsert): DraftRecord {
    const id = newId('authorDraft')
    this.db
      .prepare(
        `INSERT INTO author_drafts(id, kind, status, owner_kind, session_id, run_id, step_id, agent_id, owner_key, owner_label, adapter,
          summary, workflow_id, workflow_name, payload_json, base_json, schedule_json, run_now_json, content_hash, flags_json,
          warnings_json, created_at)
         VALUES (?,?, 'pending', ?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        d.kind,
        d.owner.kind,
        d.owner.sessionId,
        d.owner.agentId,
        d.owner.ownerKey,
        this.red(d.owner.ownerLabel, 200),
        d.owner.adapter,
        this.red(d.summary, 800),
        d.workflowId,
        this.red(d.workflowName, 200),
        this.redJson(d.payload),
        d.base ? this.redJson(d.base) : null,
        d.schedule ? JSON.stringify(d.schedule) : null,
        d.runNow ? this.redJson(d.runNow) : null,
        AuthorDrafts.contentHash(d),
        JSON.stringify(d.flags),
        JSON.stringify(d.warnings.map((w) => this.red(w, 300))),
        this.now().toISOString()
      )
    if (d.slackTrigger) this.db.prepare('UPDATE author_drafts SET slack_trigger_json = ? WHERE id = ?').run(this.redJson(d.slackTrigger), id)
    return this.get(id)!
  }

  get(id: Id): DraftRecord | null {
    const r = this.db.prepare('SELECT * FROM author_drafts WHERE id = ?').get(id) as Row | undefined
    return r ? toRecord(r) : null
  }

  findPendingDuplicate(ownerKey: string, hash: string): DraftRecord | null {
    const r = this.db
      .prepare("SELECT * FROM author_drafts WHERE owner_key = ? AND content_hash = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(ownerKey, hash) as Row | undefined
    return r ? toRecord(r) : null
  }

  pendingCount(ownerKey: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM author_drafts WHERE owner_key = ? AND status = 'pending'").get(ownerKey) as { n: number }).n
  }

  list(q: { status?: AuthorDraftStatus[]; limit?: number } = {}): DraftRecord[] {
    const status = q.status?.length ? q.status : ['pending']
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500)
    return (
      this.db
        .prepare(`SELECT * FROM author_drafts WHERE status IN (${status.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ${limit}`)
        .all(...status) as Row[]
    ).map(toRecord)
  }

  setAsk(id: Id, askId: Id): void {
    this.db.prepare('UPDATE author_drafts SET ask_id = ? WHERE id = ?').run(askId, id)
  }

  /** pending -> approved/rejected/expired. Returns null when it was not pending (conflict). */
  decide(
    id: Id,
    patch: { status: 'approved' | 'rejected' | 'expired'; note?: string | null; edited?: boolean; runAllowed?: boolean; result?: DraftResult | null; payload?: WorkflowDraft | null; workflowId?: Id | null }
  ): DraftRecord | null {
    const r = this.db
      .prepare(
        `UPDATE author_drafts SET status = @status, decision_note = @note, decided_at = @at, edited = @edited, run_allowed = @runAllowed,
          result_json = @result, payload_json = COALESCE(@payload, payload_json), workflow_id = COALESCE(workflow_id, @workflowId)
         WHERE id = @id AND status = 'pending'`
      )
      .run({
        id,
        status: patch.status,
        note: patch.note ? this.red(patch.note, 2000) : null,
        at: this.now().toISOString(),
        edited: patch.edited ? 1 : 0,
        runAllowed: patch.runAllowed ? 1 : 0,
        result: patch.result ? JSON.stringify(patch.result) : null,
        payload: patch.payload ? this.redJson(patch.payload) : null,
        workflowId: patch.workflowId ?? null
      })
    return r.changes ? this.get(id) : null
  }

  /** Pending > 7 days -> expired (returns them); decided > 90 days -> deleted. */
  sweep(): { expired: DraftRecord[]; deleted: number } {
    const nowMs = this.now().getTime()
    const cutoff = new Date(nowMs - PENDING_EXPIRY_DAYS * 86400_000).toISOString()
    const old = (this.db.prepare("SELECT * FROM author_drafts WHERE status = 'pending' AND created_at < ?").all(cutoff) as Row[]).map(toRecord)
    const expired = old.map((d) => this.decide(d.id, { status: 'expired' })).filter((d): d is DraftRecord => !!d)
    const del = new Date(nowMs - DECIDED_RETENTION_DAYS * 86400_000).toISOString()
    const deleted = this.db.prepare("DELETE FROM author_drafts WHERE status != 'pending' AND decided_at IS NOT NULL AND decided_at < ?").run(del).changes
    return { expired, deleted }
  }

  detail(r: DraftRecord, target: Workflow | null): AuthorDraftDetail {
    const isWf = r.kind === 'create' || r.kind === 'update'
    const draft = isWf ? (r.payload as WorkflowDraft) : target ? stripWorkflow(target) : null
    const base = r.kind === 'update' ? r.baseDraft : null
    const run = r.kind === 'run' ? (r.payload as { inputs: Record<string, string>; reason: string | null }) : null
    const schedule: ScheduleInput | null =
      r.scheduleRequest && (r.workflowId || target)
        ? {
            name: r.scheduleRequest.name ?? r.workflowName,
            target: { kind: 'workflow', workflowId: (r.workflowId ?? target?.id)!, inputs: r.scheduleRequest.inputs },
            when: r.scheduleRequest.when,
            enabled: r.scheduleRequest.enabled !== false
          }
        : null
    return {
      ...publicDraft(r),
      draft,
      base,
      diff: base && draft ? draftDiff(base, draft) : null,
      run,
      schedule,
      scheduleRequest: r.scheduleRequest,
      runNow: r.runNowRequest,
      slackTrigger: r.slackTriggerRequest
    }
  }

  // ---------- run permissions (PO3) ----------
  grant(g: { workflowId: Id; ownerKey: string; ownerLabel: string; contentHash: string }): void {
    this.db
      .prepare(
        `INSERT INTO author_run_grants(workflow_id, owner_key, owner_label, content_hash, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(workflow_id, owner_key) DO UPDATE SET owner_label = excluded.owner_label, content_hash = excluded.content_hash, created_at = excluded.created_at`
      )
      .run(g.workflowId, g.ownerKey, this.red(g.ownerLabel, 200), g.contentHash, this.now().toISOString())
  }
  revoke(workflowId: Id, ownerKey: string): void {
    this.db.prepare('DELETE FROM author_run_grants WHERE workflow_id = ? AND owner_key = ?').run(workflowId, ownerKey)
  }
  revokeWorkflow(workflowId: Id): void {
    this.db.prepare('DELETE FROM author_run_grants WHERE workflow_id = ?').run(workflowId)
  }
  getGrant(workflowId: Id, ownerKey: string): { contentHash: string } | null {
    const r = this.db.prepare('SELECT content_hash FROM author_run_grants WHERE workflow_id = ? AND owner_key = ?').get(workflowId, ownerKey) as
      | { content_hash: string }
      | undefined
    return r ? { contentHash: r.content_hash } : null
  }
  grants(getWorkflow: (id: Id) => Workflow | null): AuthorRunGrant[] {
    const rows = this.db.prepare('SELECT * FROM author_run_grants ORDER BY created_at DESC').all() as {
      workflow_id: string
      owner_key: string
      owner_label: string
      content_hash: string
      created_at: string
    }[]
    return rows.map((r) => {
      const wf = getWorkflow(r.workflow_id)
      return {
        workflowId: r.workflow_id,
        workflowName: wf?.name ?? '(deleted workflow)',
        ownerKey: r.owner_key,
        ownerLabel: r.owner_label,
        createdAt: r.created_at,
        contentHash: r.content_hash,
        active: !!wf && workflowHash(wf) === r.content_hash
      }
    })
  }
}

export const stripWorkflow = (w: Workflow): WorkflowDraft => ({
  name: w.name,
  description: w.description,
  inputs: w.inputs,
  nodes: w.nodes,
  ...(w.worktree ? { worktree: w.worktree } : {})
})
