/**
 * CONTRACT §14.4 persistence: no schema bump; values older CHECKs reject are stored compatibly (agent trigger,
 * wait/notify steps, approval asks) and read back widened; approval asks survive session exit and boot recovery;
 * workflows keep worktree + origin.
 */
import { describe, expect, it } from 'vitest'
import type { AgentNode, Ask } from '../../shared/live'
import type { Run, RunStep } from '../../shared/types'
import { openDatabase, currentVersion } from '../db'
import { SCHEMA_VERSION } from '../db/schema'
import { Store } from '../db/store'
import { LiveStore } from '../db/liveStore'
import { createEngineStore } from '../db/engineStore'

const ts = '2026-10-16T09:00:00.000Z'
const root: AgentNode = {
  id: 'ag_root000001', kind: 'session', parentId: null, rootId: 'ag_root000001', sessionId: 's_0000000001', runId: null, stepId: null,
  provider: 'claude', repoId: null, cwd: '/tmp', title: 'example-project · Claude', agentType: null, externalId: null, toolUseId: null,
  model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, seen: false, activity: null,
  lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null,
  report: null, startedAt: ts, updatedAt: ts, endedAt: null
}
const ask = (over: Partial<Ask>): Ask => ({
  id: 'ask_0000000001', agentId: root.id, rootId: root.id, sessionId: 's_0000000001', runId: null, stepId: null, provider: 'claude',
  kind: 'approval', channel: 'author', title: 'Create workflow "x"', detail: null, toolName: null, toolInput: null, question: null,
  options: [{ id: 'approve', label: 'Approve', kind: 'allow' }, { id: 'reject', label: 'Reject', kind: 'deny' }],
  status: 'open', answer: null, answeredVia: null, createdAt: ts, answeredAt: null, expiresAt: null, draftId: 'adr_0000000001', ...over
})

describe('authoring persistence', () => {
  it('heals tables and columns without a version bump', () => {
    const db = openDatabase(':memory:')
    expect(currentVersion(db)).toBe(SCHEMA_VERSION)
    for (const t of ['author_drafts', 'author_run_grants', 'worktrees', 'claude_history']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy()
    }
    const store = new Store(db)
    expect(store.getSettings()).toMatchObject({ claudeHistory: true, slackAlertUserId: null, slackMirrorNeedsYou: false, slackBackfillDays: 7, slackTriggerCatchupMin: 10, slackAutoPaused: false })
    // SLACK.md SA3: iMessage was removed
    expect(store.getSettings()).not.toHaveProperty('imessageHandle')
  })

  it('approval asks are stored compatibly and survive exit cancel + boot recovery', () => {
    const db = openDatabase(':memory:')
    const live = new LiveStore(db)
    live.insertAgent(root)
    live.insertAsk(ask({}))
    live.insertAsk(ask({ id: 'ask_0000000002', kind: 'permission', channel: 'pty', draftId: null }))
    expect(db.prepare('SELECT kind, channel FROM asks WHERE id = ?').get('ask_0000000001')).toEqual({ kind: 'question', channel: 'mcp' })
    expect(live.getAsk('ask_0000000001')).toMatchObject({ kind: 'approval', channel: 'author', draftId: 'adr_0000000001' })
    live.cancelOpenAsksForRoot(root.id)
    expect(live.getAsk('ask_0000000001')!.status).toBe('open')
    expect(live.getAsk('ask_0000000002')!.status).toBe('canceled')
    live.bootRecover()
    expect(live.getAsk('ask_0000000001')!.status).toBe('open')
    expect(live.needsYouCount()).toBe(1)
  })

  it('agent runs, wait/notify steps, outcome, halt and worktree round-trip', () => {
    const db = openDatabase(':memory:')
    const es = createEngineStore(db, { describe: () => () => '' })
    const run: Run = {
      id: 'r_0000000001', kind: 'workflow', title: 'PR roundup', target: { kind: 'workflow', workflowId: 'wf_0000000001', inputs: {} },
      workflowId: 'wf_0000000001', scheduleId: null, parentRunId: null, trigger: 'agent', status: 'running', reason: null, createdAt: ts,
      startedAt: ts, endedAt: null, artifactsDir: '/tmp/a/', artifactCount: 0,
      startedBy: { ownerLabel: 'example-project · Claude', ownerKey: 'claude:c1', draftId: null }
    }
    es.insertRun(run, null)
    expect(db.prepare('SELECT trigger FROM runs').get()).toEqual({ trigger: 'manual' })
    expect(es.getRun(run.id)).toMatchObject({ trigger: 'agent', startedBy: { ownerKey: 'claude:c1' } })
    expect(es.updateRun(run.id, { slotWaitSince: ts }).slotWaitSince).toBe(ts)
    expect(es.updateRun(run.id, { slotWaitSince: null }).slotWaitSince).toBeNull()
    const step = {
      id: 'st_0000000001', runId: run.id, seq: 1, nodeId: 'wait_codex', nodeType: 'wait', attempt: 1, round: null, profileId: null,
      participantLabel: null, adapter: 'shell', cwd: '/tmp', prompt: 'gh pr view', output: null, verdict: null, exitCode: null, pid: null,
      status: 'running', error: null, sourceStepIds: [], agentSessionId: null, logPath: '/tmp/l', startedAt: ts, endedAt: null
    } as RunStep
    es.insertStep(step)
    expect(es.updateStep(step.id, { status: 'passed', halt: 'PR closed' })).toMatchObject({ nodeType: 'wait', halt: 'PR closed' })
    db.prepare(
      "INSERT INTO worktrees(id, run_id, repo_path, path, branch, base, status, created_at) VALUES ('wt_0000000001', ?, '/r', '/u/worktrees/r', 'hive/x-r', 'origin/main @ abc1234', 'active', ?)"
    ).run(run.id, ts)
    const done = es.updateRun(run.id, { status: 'passed', outcome: 'nothing_to_do', endedAt: ts })
    expect(done).toMatchObject({ outcome: 'nothing_to_do', worktree: { id: 'wt_0000000001', branch: 'hive/x-r', status: 'active' } })
  })

  it('workflows keep worktree and origin; origin is set only by the agent path', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    const origin = { kind: 'agent' as const, adapter: 'claude' as const, ownerLabel: 'example-project · Claude', ownerKey: 'claude:c1', sessionId: 's_0000000001', runId: null, stepId: null, draftId: 'adr_0000000001', approvedAt: ts, edited: false }
    const wf = store.createWorkflow({ name: 'x', description: '', inputs: [], nodes: [], worktree: { repo: '{{inputs.repo}}', base: null } }, null, origin)
    expect(wf.worktree).toEqual({ repo: '{{inputs.repo}}', base: null })
    expect(wf.origin).toEqual(origin)
    const plain = store.createWorkflow({ name: 'y', description: '', inputs: [], nodes: [] })
    expect('origin' in plain).toBe(false)
    expect(store.updateWorkflow(wf.id, { name: 'x2', description: '', inputs: [], nodes: [] }).origin).toEqual(origin)
  })
})
