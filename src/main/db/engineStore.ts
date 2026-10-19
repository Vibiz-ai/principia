/** EngineStore implementation (CONTRACT §5.1). Engine-owned tables: runs, run_steps, schedule fire-state, schedule_events. */
import type { EngineStore } from '../../shared/engine'
import type { Run, RunDetail, RunStep, Schedule, ScheduleWhen, WorkflowDraft } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { newId } from '../../shared/ids'
import type { DB } from './index'
import { LiveStore } from './liveStore'
import { SlackTriggerStore } from '../connectors/slack/triggerStore'
import {
  RUN_SELECT,
  SCHEDULE_SELECT,
  buildPatch,
  runFromRow,
  runSnapshot,
  scheduleEventFromRow,
  scheduleFromRow,
  stepFromRow,
  type RunRow,
  type ScheduleRow,
  type StepRow
} from './mappers'

const RUN_COLS: Record<string, { col: string; kind?: 'json' | 'bool' }> = {
  kind: { col: 'kind' },
  title: { col: 'title' },
  target: { col: 'target_json', kind: 'json' },
  workflowId: { col: 'workflow_id' },
  scheduleId: { col: 'schedule_id' },
  parentRunId: { col: 'parent_run_id' },
  trigger: { col: 'trigger' },
  status: { col: 'status' },
  reason: { col: 'reason' },
  createdAt: { col: 'created_at' },
  startedAt: { col: 'started_at' },
  endedAt: { col: 'ended_at' },
  artifactsDir: { col: 'artifacts_dir' },
  stopReason: { col: 'stop_reason' },
  resetAt: { col: 'reset_at' },
  retryAt: { col: 'retry_at' },
  retryRunId: { col: 'retry_run_id' },
  // AUTHORING.md §5/§2.4 (trigger 'agent' and worktree are special-cased in updateRun)
  outcome: { col: 'outcome' },
  startedBy: { col: 'started_by_json', kind: 'json' }
}

const STEP_COLS: Record<string, { col: string; kind?: 'json' | 'bool' }> = {
  seq: { col: 'seq' },
  nodeId: { col: 'node_id' },
  nodeType: { col: 'node_type' },
  attempt: { col: 'attempt' },
  round: { col: 'round' },
  profileId: { col: 'profile_id' },
  participantLabel: { col: 'participant_label' },
  adapter: { col: 'adapter' },
  cwd: { col: 'cwd' },
  prompt: { col: 'prompt' },
  output: { col: 'output' },
  verdict: { col: 'verdict' },
  exitCode: { col: 'exit_code' },
  pid: { col: 'pid' },
  status: { col: 'status' },
  error: { col: 'error' },
  sourceStepIds: { col: 'source_step_ids_json', kind: 'json' },
  agentSessionId: { col: 'agent_session_id' },
  stopReason: { col: 'stop_reason' },
  resetAt: { col: 'reset_at' },
  halt: { col: 'halt' },
  logPath: { col: 'log_path' },
  startedAt: { col: 'started_at' },
  endedAt: { col: 'ended_at' }
}

/** runs.trigger CHECK predates 'agent' and 'slack' (stored as 'manual' + started_by_json / trigger_ext). */
const storedTrigger = (t: string): string => (t === 'agent' || t === 'slack' ? 'manual' : t)
/** run_steps.node_type CHECK predates wait/notify (stored as 'shell' + node_type_ext). */
const storedNodeType = (t: string): { node_type: string; node_type_ext: string | null } =>
  t === 'wait' || t === 'notify' ? { node_type: 'shell', node_type_ext: t } : { node_type: t, node_type_ext: null }

export function createEngineStore(
  db: DB,
  opts: { describe: () => (w: ScheduleWhen) => string; now?: () => Date; redact?: (s: string) => string; live?: LiveStore; slackTriggers?: SlackTriggerStore }
): EngineStore {
  const now = opts.now ?? (() => new Date())
  const live = opts.live ?? new LiveStore(db, opts.redact, now)
  const triggers = opts.slackTriggers ?? new SlackTriggerStore(db, undefined, now)
  const getRun = (id: string): Run | null => {
    const r = db.prepare(`${RUN_SELECT} WHERE runs.id = ?`).get(id) as RunRow | undefined
    return r ? runFromRow(r) : null
  }
  const getStep = (id: string): RunStep | null => {
    const r = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(id) as StepRow | undefined
    return r ? stepFromRow(r) : null
  }
  const getSchedule = (id: string): Schedule | null => {
    const r = db.prepare(`${SCHEDULE_SELECT} WHERE schedules.id = ?`).get(id) as ScheduleRow | undefined
    return r ? scheduleFromRow(r, opts.describe()) : null
  }

  return {
    insertRun(run: Run, workflowSnapshot: WorkflowDraft | null): void {
      db.prepare(
        `INSERT INTO runs(id, kind, title, target_json, workflow_id, workflow_json, schedule_id, parent_run_id, trigger,
          status, reason, created_at, started_at, ended_at, artifacts_dir, outcome, started_by_json, trigger_ext, slack_json)
         VALUES (@id, @kind, @title, @target_json, @workflow_id, @workflow_json, @schedule_id, @parent_run_id, @trigger,
          @status, @reason, @created_at, @started_at, @ended_at, @artifacts_dir, @outcome, @started_by_json, @trigger_ext, @slack_json)`
      ).run({
        id: run.id,
        kind: run.kind,
        title: run.title,
        target_json: JSON.stringify(run.target),
        workflow_id: run.workflowId,
        workflow_json: workflowSnapshot ? JSON.stringify(workflowSnapshot) : null,
        schedule_id: run.scheduleId,
        parent_run_id: run.parentRunId,
        trigger: storedTrigger(run.trigger),
        status: run.status,
        reason: run.reason,
        created_at: run.createdAt,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        artifacts_dir: run.artifactsDir,
        outcome: run.outcome ?? null,
        // trigger 'agent' without a startedBy still reads back as 'agent'
        started_by_json: run.startedBy ? JSON.stringify(run.startedBy) : run.trigger === 'agent' ? JSON.stringify({ ownerLabel: 'An agent', ownerKey: '', draftId: null }) : null,
        // SLACK.md §7.1
        trigger_ext: run.trigger === 'slack' ? 'slack' : null,
        slack_json: run.slack ? JSON.stringify(run.slack) : null
      })
    },
    updateRun(id, patch) {
      const p: Record<string, unknown> = { ...patch }
      if (typeof p.trigger === 'string') {
        if (p.trigger === 'slack') db.prepare("UPDATE runs SET trigger_ext = 'slack' WHERE id = ?").run(id)
        p.trigger = storedTrigger(p.trigger)
      }
      if ('slack' in p) {
        db.prepare('UPDATE runs SET slack_json = ? WHERE id = ?').run(p.slack ? JSON.stringify(p.slack) : null, id)
        delete p.slack
      }
      if ('worktree' in p) {
        const wt = p.worktree as { id?: string } | null | undefined
        delete p.worktree
        db.prepare('UPDATE runs SET worktree_id = ? WHERE id = ?').run(wt?.id ?? null, id)
      }
      const { set, params } = buildPatch(p, RUN_COLS)
      if (set) db.prepare(`UPDATE runs SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
      // Runs that fail at the gate (e.g. adapter missing) never "start": use ended_at so Home shows time + 0s.
      if (patch.endedAt) db.prepare('UPDATE runs SET started_at = ended_at WHERE id = ? AND started_at IS NULL').run(id)
      const r = getRun(id)
      if (!r) throw new HiveError('not_found', `run ${id} not found`)
      return r
    },
    getRun,
    getRunDetail(id: string): RunDetail | null {
      const r = db.prepare(`${RUN_SELECT} WHERE runs.id = ?`).get(id) as RunRow | undefined
      if (!r) return null
      const steps = (db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq').all(id) as StepRow[]).map(
        stepFromRow
      )
      return { run: runFromRow(r), steps, workflow: runSnapshot(r) }
    },
    listRetries(): Run[] {
      return (
        db.prepare(`${RUN_SELECT} WHERE runs.retry_at IS NOT NULL AND runs.retry_run_id IS NULL ORDER BY runs.retry_at`).all() as RunRow[]
      ).map(runFromRow)
    },
    listActiveRuns(): Run[] {
      return (
        db.prepare(`${RUN_SELECT} WHERE runs.status IN ('queued','running') ORDER BY runs.created_at`).all() as RunRow[]
      ).map(runFromRow)
    },
    insertStep(step: RunStep): void {
      db.prepare(
        `INSERT INTO run_steps(id, run_id, seq, node_id, node_type, attempt, round, profile_id, participant_label, adapter,
          cwd, prompt, output, verdict, exit_code, pid, status, error, source_step_ids_json, agent_session_id, log_path,
          started_at, ended_at, node_type_ext, halt)
         VALUES (@id, @run_id, @seq, @node_id, @node_type, @attempt, @round, @profile_id, @participant_label, @adapter,
          @cwd, @prompt, @output, @verdict, @exit_code, @pid, @status, @error, @source_step_ids_json, @agent_session_id,
          @log_path, @started_at, @ended_at, @node_type_ext, @halt)`
      ).run({
        id: step.id,
        run_id: step.runId,
        seq: step.seq,
        node_id: step.nodeId,
        ...storedNodeType(step.nodeType),
        attempt: step.attempt,
        round: step.round,
        profile_id: step.profileId,
        participant_label: step.participantLabel,
        adapter: step.adapter,
        cwd: step.cwd,
        prompt: step.prompt,
        output: step.output,
        verdict: step.verdict,
        exit_code: step.exitCode,
        pid: step.pid,
        status: step.status,
        error: step.error,
        source_step_ids_json: JSON.stringify(step.sourceStepIds ?? []),
        agent_session_id: step.agentSessionId,
        log_path: step.logPath,
        started_at: step.startedAt,
        ended_at: step.endedAt,
        halt: step.halt ?? null
      })
    },
    updateStep(id, patch) {
      const p: Record<string, unknown> = { ...patch }
      if (typeof p.nodeType === 'string') {
        const t = storedNodeType(p.nodeType)
        p.nodeType = t.node_type
        db.prepare('UPDATE run_steps SET node_type_ext = ? WHERE id = ?').run(t.node_type_ext, id)
      }
      const { set, params } = buildPatch(p, STEP_COLS)
      if (set) db.prepare(`UPDATE run_steps SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
      const s = getStep(id)
      if (!s) throw new HiveError('not_found', `step ${id} not found`)
      return s
    },
    listSchedules(): Schedule[] {
      const d = opts.describe()
      return (db.prepare(`${SCHEDULE_SELECT} ORDER BY schedules.created_at`).all() as ScheduleRow[]).map((r) =>
        scheduleFromRow(r, d)
      )
    },
    getSchedule,
    setScheduleFireState(id, patch) {
      const cols: Record<string, { col: string; kind?: 'json' | 'bool' }> = {
        lastFireAt: { col: 'last_fire_at' },
        lastRunId: { col: 'last_run_id' },
        nextFireAt: { col: 'next_fire_at' },
        enabled: { col: 'enabled', kind: 'bool' },
        skipSlotAt: { col: 'skip_slot_at' }
      }
      const { set, params } = buildPatch(patch as Record<string, unknown>, cols)
      if (set) db.prepare(`UPDATE schedules SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
      const s = getSchedule(id)
      if (!s) throw new HiveError('not_found', `schedule ${id} not found`)
      return s
    },
    insertScheduleEvent(e) {
      const id = newId('scheduleEvent')
      const createdAt = now().toISOString()
      db.prepare(
        'INSERT INTO schedule_events(id, schedule_id, kind, slot_at, run_id, message, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(id, e.scheduleId, e.kind, e.slotAt, e.runId, e.message, createdAt)
      return scheduleEventFromRow({
        id,
        schedule_id: e.scheduleId,
        kind: e.kind,
        slot_at: e.slotAt,
        run_id: e.runId,
        message: e.message,
        created_at: createdAt
      })
    },

    // ---------- live agents (LIVE.md §9.2) ----------
    insertAgent(a) {
      live.insertAgent(a)
    },
    updateAgent: (id, patch) => live.updateAgent(id, patch),
    appendAgentEvents: (agentId, events) => live.appendAgentEvents(agentId, events),
    updateAgentEvent: (agentId, toolUseId, patch) => live.updateAgentEvent(agentId, toolUseId, patch),
    insertAsk(a) {
      live.insertAsk(a)
    },
    updateAsk: (id, patch) => live.updateAsk(id, patch),
    listOpenAsks: (q) => live.listOpenAsks(q),
    // SLACK.md §9.3 (CONTRACT Slack.3): trigger config is main's; state + events are the engine's
    listSlackTriggers: () => triggers.list(),
    getSlackTriggerState: (t, c, k) => triggers.getState(t, c, k),
    putSlackTriggerState: (s) => triggers.putState(s),
    listSlackTriggerStates: () => triggers.listStates(),
    insertSlackTriggerEvent: (e) => triggers.insertEvent(e)
  }
}
