/**
 * slack_triggers (config, main writes) + slack_trigger_state / slack_trigger_events (engine-owned state, persisted here
 * for the EngineStore). Synchronous better-sqlite3 (the EngineStore is synchronous). SLACK.md §7.1, §9.
 */
import type Database from 'better-sqlite3'
import type { SlackTriggerState } from '../../../shared/engine'
import { HiveError } from '../../../shared/errors'
import { newId } from '../../../shared/ids'
import { slackAccessOf, type SlackTrigger, type SlackTriggerEvent } from '../../../shared/slack'
import type { RunStatus, WorkflowOrigin } from '../../../shared/types'
import { triggerSentence, type NormalizedTrigger } from './triggerConfig'

type DB = Database.Database

interface TriggerRow {
  id: string
  name: string
  workflow_id: string
  enabled: number
  match_json: string
  reply_json: string
  inputs_json: string
  limits_json: string
  access_json?: string | null
  action?: string | null
  department_id?: string | null
  origin_json: string | null
  note: string | null
  created_at: string
  updated_at: string
  last_fired_at: string | null
  last_run_id: string | null
  last_run_status: string | null
}
const j = <T>(s: string | null | undefined, fb: T): T => {
  if (s == null) return fb
  try {
    return JSON.parse(s) as T
  } catch {
    return fb
  }
}

const SELECT = `SELECT t.*,
  (SELECT e.created_at FROM slack_trigger_events e WHERE e.trigger_id = t.id AND e.kind = 'fired' ORDER BY e.created_at DESC LIMIT 1) AS last_fired_at,
  (SELECT e.run_id FROM slack_trigger_events e WHERE e.trigger_id = t.id AND e.kind = 'fired' ORDER BY e.created_at DESC LIMIT 1) AS last_run_id,
  (SELECT r.status FROM runs r WHERE r.id = (SELECT e.run_id FROM slack_trigger_events e WHERE e.trigger_id = t.id AND e.kind = 'fired' ORDER BY e.created_at DESC LIMIT 1)) AS last_run_status
  FROM slack_triggers t`

export class SlackTriggerStore {
  constructor(
    readonly db: DB,
    private channelName: (id: string) => string = (id) => id,
    private now: () => Date = () => new Date()
  ) {}

  setChannelNames(fn: (id: string) => string): void {
    this.channelName = fn
  }

  private fromRow(r: TriggerRow): SlackTrigger {
    const t: SlackTrigger = {
      id: r.id,
      name: r.name,
      workflowId: r.workflow_id,
      enabled: !!r.enabled,
      match: j(r.match_json, { on: [], channels: [], keywords: [], regex: null, fromUsers: [] }),
      reply: j(r.reply_json, { mode: 'draft', autoChannels: [], replyNode: null }),
      limits: j(r.limits_json, { debounceSec: 3, maxRunsPerThreadPerHour: 4 }),
      inputs: j(r.inputs_json, {}),
      access: slackAccessOf(j<unknown>(r.access_json ?? null, null)),
      origin: j<WorkflowOrigin | null>(r.origin_json, null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sentence: '',
      lastFiredAt: r.last_fired_at,
      lastRunId: r.last_run_id,
      lastRunStatus: (r.last_run_status as RunStatus | null) ?? null,
      note: r.note,
      // DEPARTMENTS.md §8: absent = 'run' / no department, so older rows keep their shape
      ...(r.action === 'task' ? { action: 'task' as const } : {}),
      ...(r.department_id ? { departmentId: r.department_id } : {})
    }
    t.sentence = triggerSentence(t, this.channelName)
    return t
  }

  list(q: { workflowId?: string } = {}): SlackTrigger[] {
    const rows = (q.workflowId ? this.db.prepare(`${SELECT} WHERE t.workflow_id = ? ORDER BY t.created_at`).all(q.workflowId) : this.db.prepare(`${SELECT} ORDER BY t.created_at`).all()) as TriggerRow[]
    const all = rows.map((r) => this.fromRow(r))
    const scope = this.scope
    return scope ? all.filter((t) => scope.has(t.id)) : all
  }

  private scope: Set<string> | null = null
  /**
   * Runs fn with list() limited to these trigger ids (null = all): SlackService hands a non-member's message to the
   * engine with only the triggers that let that person trigger them. Synchronous, so nothing else can observe it.
   */
  scoped<T>(ids: Set<string> | null, fn: () => T): T {
    const prev = this.scope
    this.scope = ids
    try {
      return fn()
    } finally {
      this.scope = prev
    }
  }
  private boardCols: boolean | null = null
  /** §8: action / department_id (healed by openDatabase; a bare test db may lack them). */
  private writeBoard(id: string, t: Pick<NormalizedTrigger, 'action' | 'departmentId'>): void {
    if (this.boardCols === null) {
      const cols = new Set((this.db.prepare('PRAGMA table_info(slack_triggers)').all() as { name: string }[]).map((c) => c.name))
      this.boardCols = cols.has('action') && cols.has('department_id')
    }
    if (!this.boardCols) return
    this.db.prepare('UPDATE slack_triggers SET action = ?, department_id = ? WHERE id = ?').run(t.action === 'task' ? 'task' : null, t.departmentId ?? null, id)
  }
  get(id: string): SlackTrigger | null {
    const r = this.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TriggerRow | undefined
    return r ? this.fromRow(r) : null
  }
  insert(t: NormalizedTrigger, origin: WorkflowOrigin | null = null, note: string | null = null): SlackTrigger {
    const id = newId('slackTrigger')
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO slack_triggers(id, name, workflow_id, enabled, match_json, reply_json, inputs_json, limits_json, access_json, origin_json, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(id, t.name, t.workflowId, t.enabled ? 1 : 0, JSON.stringify(t.match), JSON.stringify(t.reply), JSON.stringify(t.inputs), JSON.stringify(t.limits), JSON.stringify(slackAccessOf(t.access)), origin ? JSON.stringify(origin) : null, note, ts, ts)
    this.writeBoard(id, t)
    return this.get(id)!
  }
  update(id: string, t: NormalizedTrigger): SlackTrigger {
    const r = this.db
      .prepare(
        `UPDATE slack_triggers SET name = ?, workflow_id = ?, enabled = ?, match_json = ?, reply_json = ?, inputs_json = ?, limits_json = ?, access_json = ?, note = NULL, updated_at = ? WHERE id = ?`
      )
      .run(t.name, t.workflowId, t.enabled ? 1 : 0, JSON.stringify(t.match), JSON.stringify(t.reply), JSON.stringify(t.inputs), JSON.stringify(t.limits), JSON.stringify(slackAccessOf(t.access)), this.now().toISOString(), id)
    if (!r.changes) throw new HiveError('not_found', 'Slack trigger not found')
    this.writeBoard(id, t)
    return this.get(id)!
  }
  remove(id: string): void {
    const r = this.db.prepare('DELETE FROM slack_triggers WHERE id = ?').run(id)
    if (!r.changes) throw new HiveError('not_found', 'Slack trigger not found')
  }
  setEnabled(id: string, enabled: boolean, note: string | null = null): SlackTrigger {
    const r = this.db.prepare('UPDATE slack_triggers SET enabled = ?, note = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, note, this.now().toISOString(), id)
    if (!r.changes) throw new HiveError('not_found', 'Slack trigger not found')
    return this.get(id)!
  }
  /** slack:disconnect: every trigger disabled with a note (SLACK.md §3.3). */
  disableAll(note: string): number {
    return this.db.prepare('UPDATE slack_triggers SET enabled = 0, note = ?, updated_at = ? WHERE enabled = 1').run(note, this.now().toISOString()).changes
  }

  // ---------- engine-owned state ----------
  getState(triggerId: string, channelId: string, threadKey: string): SlackTriggerState | null {
    const r = this.db.prepare('SELECT * FROM slack_trigger_state WHERE trigger_id = ? AND channel_id = ? AND thread_key = ?').get(triggerId, channelId, threadKey) as
      | { trigger_id: string; channel_id: string; thread_key: string; pending_json: string; window_ends_at: string | null; active_run_id: string | null; fired_at_json: string }
      | undefined
    return r
      ? { triggerId: r.trigger_id, channelId: r.channel_id, threadKey: r.thread_key, pending: j(r.pending_json, []), windowEndsAt: r.window_ends_at, activeRunId: r.active_run_id, firedAt: j(r.fired_at_json, []) }
      : null
  }
  putState(s: SlackTriggerState): void {
    if (!this.db.prepare('SELECT 1 FROM slack_triggers WHERE id = ?').get(s.triggerId)) return
    const firedAt = s.firedAt
    if (!s.pending.length && !s.windowEndsAt && !s.activeRunId && !firedAt.length) {
      this.db.prepare('DELETE FROM slack_trigger_state WHERE trigger_id = ? AND channel_id = ? AND thread_key = ?').run(s.triggerId, s.channelId, s.threadKey)
      return
    }
    this.db
      .prepare(
        `INSERT INTO slack_trigger_state(trigger_id, channel_id, thread_key, pending_json, window_ends_at, active_run_id, fired_at_json, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(trigger_id, channel_id, thread_key) DO UPDATE SET pending_json = excluded.pending_json, window_ends_at = excluded.window_ends_at,
           active_run_id = excluded.active_run_id, fired_at_json = excluded.fired_at_json, updated_at = excluded.updated_at`
      )
      .run(s.triggerId, s.channelId, s.threadKey, JSON.stringify(s.pending), s.windowEndsAt, s.activeRunId, JSON.stringify(firedAt), this.now().toISOString())
  }
  listStates(): SlackTriggerState[] {
    return (this.db.prepare('SELECT trigger_id, channel_id, thread_key FROM slack_trigger_state').all() as { trigger_id: string; channel_id: string; thread_key: string }[]).map(
      (r) => this.getState(r.trigger_id, r.channel_id, r.thread_key)!
    )
  }
  insertEvent(e: Omit<SlackTriggerEvent, 'id' | 'createdAt'>): SlackTriggerEvent {
    const ev: SlackTriggerEvent = { ...e, id: newId('slackTriggerEvent'), createdAt: this.now().toISOString() }
    if (!this.db.prepare('SELECT 1 FROM slack_triggers WHERE id = ?').get(e.triggerId)) return ev
    this.db
      .prepare('INSERT INTO slack_trigger_events(id, trigger_id, kind, channel_id, thread_ts, ts, run_id, message, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ev.id, ev.triggerId, ev.kind, ev.channelId, ev.threadTs, ev.ts, ev.runId, ev.message, ev.createdAt)
    return ev
  }
  events(triggerId: string, limit = 50): SlackTriggerEvent[] {
    return (
      this.db.prepare('SELECT * FROM slack_trigger_events WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?').all(triggerId, Math.min(Math.max(limit, 1), 500)) as {
        id: string
        trigger_id: string
        kind: string
        channel_id: string | null
        thread_ts: string | null
        ts: string | null
        run_id: string | null
        message: string | null
        created_at: string
      }[]
    ).map((r) => ({
      id: r.id,
      triggerId: r.trigger_id,
      kind: r.kind as SlackTriggerEvent['kind'],
      channelId: r.channel_id,
      threadTs: r.thread_ts,
      ts: r.ts,
      runId: r.run_id,
      message: r.message,
      createdAt: r.created_at
    }))
  }
}
