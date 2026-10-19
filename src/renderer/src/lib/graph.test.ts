import { describe, expect, it } from 'vitest'
import type { AgentProfile, CanvasSnapshot, Run, RunDetail, RunStep, WorkflowDraft } from '@shared/types'
import { appendHistory, applyStepUpdate, canvasGraph, draftDiffGraph, draftGraph, intervalLabel, workflowLocal } from './graph'

const profiles: AgentProfile[] = [
  { id: 'pc', name: 'Claude', adapter: 'claude', model: null, extraArgs: [], permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false, createdAt: '', updatedAt: '' },
  { id: 'px', name: 'Codex', adapter: 'codex', model: null, extraArgs: [], permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false, createdAt: '', updatedAt: '' }
]
const wf: WorkflowDraft = {
  name: 'Build + review',
  description: '',
  inputs: [],
  nodes: [
    { id: 'build', type: 'agent', label: 'build', after: [], cwd: null, timeoutMin: 30, profileId: 'pc', prompt: 'x' },
    { id: 'review', type: 'check', label: 'review', after: ['build'], cwd: null, timeoutMin: 30, profileId: 'px', command: null, target: 'build', criteria: 'ok', maxRetries: 3 },
    { id: 'debate', type: 'room', label: 'debate', after: ['review'], cwd: null, timeoutMin: 30, participants: [{ profileId: 'pc', label: 'Builder' }, { profileId: 'px', label: 'Skeptic' }], topic: 't', rounds: 2, final: 'summary' }
  ]
}
const run: Run = {
  id: 'r_1', kind: 'workflow', title: 'Build + review', target: { kind: 'workflow', workflowId: 'wf_1', inputs: {} }, workflowId: 'wf_1', scheduleId: 'sch_1', parentRunId: null,
  trigger: 'schedule', status: 'running', reason: null, createdAt: '2026-10-15T10:00:00Z', startedAt: '2026-10-15T10:00:00Z', endedAt: null, artifactsDir: '/a', artifactCount: 0
}
const step = (p: Partial<RunStep>): RunStep => ({
  id: 'st', runId: 'r_1', seq: 1, nodeId: 'build', nodeType: 'agent', attempt: 1, round: null, profileId: 'pc', participantLabel: null, adapter: 'claude', cwd: '/', prompt: '', output: null,
  verdict: null, exitCode: null, pid: null, status: 'passed', error: null, sourceStepIds: [], agentSessionId: null, logPath: '', startedAt: '2026-10-15T10:00:00Z', endedAt: '2026-10-15T10:01:00Z', ...p
})

describe('graph', () => {
  it('draft preview: one card per node, rooms expand to participants, check loop-back edge', () => {
    const g = draftGraph(wf, profiles)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['build', 'debate:0', 'debate:1', 'review'])
    const loop = g.edges.find((e) => e.sourceHandle === 'loop-out')!
    expect(loop.source).toBe('review')
    expect(loop.target).toBe('build')
    expect(loop.label).toBe('↺ ≤3')
    expect(g.edges.some((e) => e.label === '⇄')).toBe(true)
  })
  it('run statuses come from the latest attempt; loop-back shows the attempt number (C3)', () => {
    const rd: RunDetail = {
      run,
      workflow: wf,
      steps: [
        step({ id: 's1', seq: 1 }),
        step({ id: 's2', seq: 2, nodeId: 'review', nodeType: 'check', adapter: 'codex', status: 'failed', verdict: 'FAIL' }),
        step({ id: 's3', seq: 3, attempt: 2, status: 'running', endedAt: null })
      ]
    }
    const { items, edges } = workflowLocal(wf, rd, profiles, new Date('2026-10-15T10:05:00Z').getTime())
    const build = items.find((i) => i.id === 'build')!
    expect(build.data.status).toBe('running')
    expect(build.data.sub).toContain('#2')
    expect(edges.find((e) => e.kind === 'loop')!.label).toBe('attempt 2')
    expect(items.find((i) => i.id === 'debate:0')!.data.status).toBe('queued')
  })
  it('canvas: session groups, run frames, schedule clock with edge to its workflow lane', () => {
    const snap: CanvasSnapshot = {
      sessions: [{ id: 's_1', title: 'vibiz · Claude', profileId: 'pc', adapter: 'claude', repoId: 'repo_1', cwd: '/x', status: 'running', pid: 1, cols: 80, rows: 24, exitCode: null, startedAt: '2026-10-15T10:00:00Z', endedAt: null, artifactsDir: '/a', fromRunId: null, agentSessionId: null }],
      runs: [{ run, workflow: wf, steps: [] }],
      schedules: [{ id: 'sch_1', name: 'Daily', target: run.target, when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, preset: null, enabled: true, sentence: '', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: '2026-10-16T09:00:00Z', createdAt: '', updatedAt: '' }],
      workflows: [],
      profiles,
      repos: [{ id: 'repo_1', name: 'example-project', path: '/x', addedAt: '', exists: true, isGit: true, liveSessions: 1 }]
    }
    const g = canvasGraph(snap, new Date('2026-10-15T10:05:00Z').getTime())
    expect(g.nodes.find((n) => n.id === 'f:repo:repo_1')?.data.label).toBe('example-project')
    expect(g.nodes.some((n) => n.id === 's:s_1')).toBe(true)
    expect(g.nodes.some((n) => n.id === 'r:r_1:build')).toBe(true)
    expect(g.edges.find((e) => e.source === 'sch:sch_1')?.target).toBe('f:lane:wf:wf_1')
    expect(g.nodes.some((n) => n.id === 'f:run:r_1')).toBe(true)
    const updated = applyStepUpdate(snap, step({ id: 'z', status: 'running' }))
    expect(updated.runs[0]!.steps).toHaveLength(1)
    expect(applyStepUpdate(updated, step({ id: 'z', status: 'passed' })).runs[0]!.steps[0]!.status).toBe('passed')
  })
  it('canvas: lanes per workflow, active first, older finished runs collapsed, ghost lane for a never-run schedule', () => {
    const mk = (id: string, wfId: string, status: Run['status'], at: string): RunDetail => ({
      run: { ...run, id, workflowId: wfId, scheduleId: null, target: { kind: 'workflow', workflowId: wfId, inputs: {} }, status, createdAt: at, startedAt: at, endedAt: status === 'running' ? null : at },
      workflow: wf,
      steps: []
    })
    const runs = [
      mk('a1', 'wf_a', 'passed', '2026-10-15T08:00:00Z'),
      mk('a2', 'wf_a', 'passed', '2026-10-15T08:10:00Z'),
      mk('a3', 'wf_a', 'failed', '2026-10-15T08:20:00Z'),
      mk('a4', 'wf_a', 'passed', '2026-10-15T08:30:00Z'),
      mk('b1', 'wf_b', 'running', '2026-10-15T07:00:00Z')
    ]
    const snap: CanvasSnapshot = {
      sessions: [],
      runs,
      schedules: [{ id: 'sch_c', name: 'Nightly', target: { kind: 'workflow', workflowId: 'wf_c', inputs: {} }, when: { kind: 'cron', cron: '0 2 * * *', tz: 'UTC' }, preset: null, enabled: true, sentence: '', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: '2026-10-16T02:00:00Z', createdAt: '', updatedAt: '' }],
      workflows: [{ id: 'wf_c', name: 'Nightly audit' } as never],
      profiles,
      repos: []
    }
    const g = canvasGraph(snap, new Date('2026-10-15T10:00:00Z').getTime())
    const lanes = g.nodes.filter((n) => n.id.startsWith('f:lane:'))
    expect(lanes.map((n) => n.id)).toEqual(['f:lane:wf:wf_b', 'f:lane:wf:wf_a', 'f:lane:wf:wf_c'])
    // wf_a: only the newest finished run expanded, the rest folded into one "N earlier runs" chip
    expect(g.nodes.some((n) => n.id === 'f:run:a4')).toBe(true)
    expect(g.nodes.some((n) => n.id === 'f:run:a3')).toBe(false)
    const chip = g.nodes.find((n) => n.id === 'c:wf:wf_a')!
    expect(chip.data.label).toBe('3 earlier runs')
    expect((chip.data as { sub: string }).sub).toMatch(/^2 ✓ 1 ✕/)
    expect(g.nodes.some((n) => n.id === 'f:run:a1')).toBe(false)
    // lanes sit side by side in rows, not one tall column of every run
    const laneA = lanes.find((n) => n.id === 'f:lane:wf:wf_a')!
    const laneB = lanes.find((n) => n.id === 'f:lane:wf:wf_b')!
    expect(laneA.position.y).toBeGreaterThan(laneB.position.y)
    // never-run schedule: ghost lane + dashed edge into it
    expect(g.nodes.some((n) => n.id === 'f:ghost:wf:wf_c')).toBe(true)
    expect(g.edges.find((e) => e.source === 'sch:sch_c')?.target).toBe('f:lane:wf:wf_c')
    expect(lanes.find((n) => n.id === 'f:lane:wf:wf_c')!.data.label).toBe('Nightly audit')
  })
  it('canvas: a prompt run that failed before any step reads "failed · <reason>", not "waiting"', () => {
    const rd: RunDetail = {
      run: { ...run, kind: 'prompt', workflowId: null, scheduleId: null, target: { kind: 'prompt', profileId: 'px', prompt: 'hello', repoId: null } as never, status: 'failed', reason: 'Codex not installed', endedAt: run.startedAt },
      workflow: null,
      steps: []
    }
    const { items } = workflowLocal(null, rd, profiles)
    expect(items[0]!.data.sub).toBe('failed · Codex not installed')
    expect(items[0]!.data.status).toBe('failed')
  })
  it('canvas: exited sessions collapse to the newest one per repo; killed sessions read "stopped"', () => {
    const base = { title: 'x · Claude', profileId: 'pc', adapter: 'claude' as const, cwd: '/x', pid: null, cols: 80, rows: 24, endedAt: null, artifactsDir: '/a', fromRunId: null, agentSessionId: null }
    const snap: CanvasSnapshot = {
      sessions: [
        { ...base, id: 'old', repoId: 'repo_1', status: 'exited', exitCode: 1, startedAt: '2026-10-15T08:00:00Z' },
        { ...base, id: 'new', repoId: 'repo_1', status: 'exited', exitCode: 129, startedAt: '2026-10-15T09:00:00Z' },
        { ...base, id: 'live', repoId: 'repo_1', status: 'running', exitCode: null, startedAt: '2026-10-15T09:30:00Z' }
      ],
      runs: [],
      schedules: [],
      workflows: [],
      profiles,
      repos: [{ id: 'repo_1', name: 'example-project', path: '/x', addedAt: '', exists: true, isGit: true, liveSessions: 1 }]
    }
    const g = canvasGraph(snap, new Date('2026-10-15T10:00:00Z').getTime())
    expect(g.nodes.some((n) => n.id === 's:old')).toBe(false)
    expect(g.nodes.find((n) => n.id === 's:new')!.data).toMatchObject({ sub: 'stopped' })
    expect(g.nodes.some((n) => n.id === 's:live')).toBe(true)
  })
  it('canvas: repos/Chat with only old (>24 h) stopped sessions get no group', () => {
    const base = { title: 'x · Claude', profileId: 'pc', adapter: 'claude' as const, cwd: '/x', pid: null, cols: 80, rows: 24, artifactsDir: '/a', fromRunId: null, agentSessionId: null }
    const snap: CanvasSnapshot = {
      sessions: [
        { ...base, id: 'stale', repoId: 'repo_1', status: 'exited', exitCode: 0, startedAt: '2026-10-13T08:00:00Z', endedAt: '2026-10-13T09:00:00Z' },
        { ...base, id: 'chat', repoId: null, status: 'exited', exitCode: 0, startedAt: '2026-10-12T08:00:00Z', endedAt: '2026-10-12T08:30:00Z' },
        { ...base, id: 'fresh', repoId: 'repo_2', status: 'exited', exitCode: 0, startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T09:00:00Z' }
      ],
      runs: [],
      schedules: [],
      workflows: [],
      profiles,
      repos: [
        { id: 'repo_1', name: 'old', path: '/x', addedAt: '', exists: true, isGit: true, liveSessions: 0 },
        { id: 'repo_2', name: 'new', path: '/y', addedAt: '', exists: true, isGit: true, liveSessions: 0 }
      ]
    }
    const g = canvasGraph(snap, new Date('2026-10-15T10:00:00Z').getTime())
    expect(g.nodes.some((n) => n.id === 'f:repo:repo_1')).toBe(false)
    expect(g.nodes.some((n) => n.id === 'f:repo:__chat')).toBe(false)
    expect(g.nodes.some((n) => n.id === 'f:repo:repo_2')).toBe(true)
  })
})

describe('authoring graph additions', () => {
  it('approval diff: removed nodes are ghosts, added and changed are marked', () => {
    const next: WorkflowDraft = { ...wf, nodes: [wf.nodes[0]!, { ...(wf.nodes[1] as Extract<WorkflowDraft['nodes'][number], { type: 'check' }>), maxRetries: 1 }, { id: 'ping', type: 'notify', label: 'ping', after: ['review'], cwd: null, timeoutMin: 1, title: 't', message: 'm', slack: { kind: 'me' } }] }
    const g = draftDiffGraph(next, wf, { added: ['ping'], removed: ['debate'], changed: ['review'] }, profiles)
    const byNode = (id: string) => g.nodes.filter((n) => n.type === 'card' && n.data.ref.kind === 'wfnode' && n.data.ref.nodeId === id)
    expect(byNode('ping')[0]!.data).toMatchObject({ diff: 'added', sub: 'notify · Slack' })
    expect(byNode('review')[0]!.data.diff).toBe('changed')
    expect(byNode('debate').every((n) => n.data.diff === 'removed')).toBe(true)
    expect(byNode('build')[0]!.data.diff).toBeUndefined()
  })
  it('nothing to do: halting step says so, unrun nodes read skipped and quiet', () => {
    const rd: RunDetail = { run: { ...run, status: 'passed', outcome: 'nothing_to_do', endedAt: '2026-10-15T10:02:00Z' }, steps: [step({ halt: 'no open PRs' })], workflow: wf }
    const { items } = workflowLocal(wf, rd, profiles)
    expect(items.find((i) => i.id === 'build')!.data).toMatchObject({ quiet: true })
    expect(items.find((i) => i.id === 'build')!.data.sub).toContain('stopped · no open PRs')
    expect(items.find((i) => i.id === 'review')!.data).toMatchObject({ quiet: true, status: 'canceled' })
    expect(items.find((i) => i.id === 'review')!.data.sub).toContain('skipped')
  })
  it('wait and isolated nodes', () => {
    const d: WorkflowDraft = { name: 'w', description: '', inputs: [], worktree: { repo: 'repo_1' }, nodes: [{ id: 'w', type: 'wait', label: 'w', after: [], cwd: null, timeoutMin: 5, command: 'true', until: 'exit0', pattern: null, intervalSec: 300, onTimeout: 'fail', isolate: 'worktree' }] }
    const { items } = workflowLocal(d, null, profiles)
    expect(items[0]!.data).toMatchObject({ sub: 'wait · every 5 min', adapter: 'shell', isolated: true })
    expect(intervalLabel(45)).toBe('45 s')
    expect(intervalLabel(7200)).toBe('2 h')
  })
  it('history lanes stack below the live graph with dashed compact cards', () => {
    const base = draftGraph(wf, profiles)
    const g = appendHistory(base, [{ key: 'repo:r', label: 'example-project', older: 2, cards: [{ id: 'u1', title: 'Fix login', sub: '3 turns' }] }])
    const card = g.nodes.find((n) => n.id === 'h:u1')!
    expect(card.position.y).toBeGreaterThan(base.height)
    expect(card.data).toMatchObject({ history: true, compact: true, ref: { kind: 'history', historyId: 'u1' } })
    expect(g.nodes.find((n) => n.id === 'h:older:repo:r')!.data.label).toBe('+2 older')
    expect(g.edges).toBe(base.edges)
    expect(appendHistory(base, [])).toBe(base)
  })
})
