import { describe, expect, it } from 'vitest'
import type { AuthorFlags, ClaudeHistorySession } from '@shared/authoring'
import type { AgentProfile, Repo, RunWorktree, WorkflowDraft, WorkflowOrigin } from '@shared/types'
import {
  canRemoveWorktree,
  computeDiff,
  draftTitle,
  flagChips,
  historyGroups,
  historyMeta,
  historyPlace,
  isNothingToDo,
  kindVerb,
  matchHistory,
  metaChanges,
  nodeLines,
  originDetail,
  originLine,
  primaryLabel,
  repoLabel,
  scheduleHint,
  recentOutside,
  runStatusLabel,
  shellInputsOf,
  splitRecent,
  wantsSlackMe,
  worktreeChip,
  worktreeState
} from './authoring'

const flags = (p: Partial<AuthorFlags> = {}): AuthorFlags => ({
  shellCommands: 0,
  worktreeRepo: null,
  pushes: false,
  bypassAgents: 0,
  memoryWrite: false,
  scheduleSentence: null,
  inputs: null,
  ...p
})
const repos: Repo[] = [{ id: 'repo_1', name: 'example-project', path: '/Users/me/example-project', addedAt: '', exists: true, isGit: true, liveSessions: 0 }]
const profiles: AgentProfile[] = [{ id: 'prof_c', name: 'Claude', adapter: 'claude', model: null, extraArgs: [], permissionMode: 'default', secretNames: ['*'], useApiKeyAuth: false, createdAt: '', updatedAt: '' }]
const provider = (a: string): string => ({ claude: 'Claude', codex: 'Codex' })[a] ?? a

const roundup: WorkflowDraft = {
  name: 'PR roundup',
  description: '',
  inputs: [
    { name: 'repo', label: 'Repository', type: 'repo', default: 'repo_1' },
    { name: 'test_command', label: 'Tests', default: 'npm test' }
  ],
  worktree: { repo: '{{inputs.repo}}' },
  nodes: [
    { id: 'scan', type: 'shell', label: 'List PRs', after: [], cwd: '{{inputs.repo}}', timeoutMin: 30, command: 'gh pr list --json number' },
    { id: 'fix', type: 'agent', label: 'Fix', after: ['scan'], cwd: null, timeoutMin: 45, profileId: 'prof_c', prompt: 'fix {{scan.output}}', isolate: 'worktree' },
    { id: 'tests', type: 'check', label: 'Tests', after: ['fix'], cwd: null, timeoutMin: 30, profileId: null, command: '{{inputs.test_command}}', target: 'fix', criteria: '', maxRetries: 3, isolate: 'worktree' },
    { id: 'wait_codex', type: 'wait', label: 'Wait', after: ['tests'], cwd: null, timeoutMin: 45, command: 'gh pr view 1', until: 'match', pattern: '^[1-9]', intervalSec: 60, onTimeout: 'continue', isolate: 'worktree' },
    { id: 'text_me', type: 'notify', label: 'Text me', after: ['wait_codex'], cwd: null, timeoutMin: 1, title: 'PR roundup', message: 'done', slack: { kind: 'me' } }
  ]
}

describe('approval card', () => {
  it('primary button says what one click does (PO2)', () => {
    expect(primaryLabel({ kind: 'create', flags: flags() })).toBe('Approve')
    expect(primaryLabel({ kind: 'create', flags: flags({ scheduleSentence: 'Every weekday at 9:00' }) })).toBe('Approve & schedule')
    expect(primaryLabel({ kind: 'create', flags: flags(), runNow: { inputs: {} } })).toBe('Approve & run now')
    expect(primaryLabel({ kind: 'update', flags: flags({ scheduleSentence: 'Daily' }), runNow: { inputs: {} } })).toBe('Approve, schedule & run now')
    expect(primaryLabel({ kind: 'run', flags: flags({ inputs: { a: 'b' } }) })).toBe('Approve & run')
  })
  it('verbs and titles', () => {
    expect(kindVerb('update')).toBe('Update workflow')
    expect(draftTitle({ kind: 'create', adapter: 'claude', workflowName: 'PR roundup' }, provider)).toBe('Claude wants to create “PR roundup”')
  })
  it('flags: unattended first, shell inputs as danger, push is only "may"', () => {
    const chips = flagChips(
      flags({ shellCommands: 3, pushes: true, worktreeRepo: 'repo_1', shellInputs: ['test_command'], unattended: [{ sentence: 'Every weekday at 9:00', nextAt: '2026-10-19T07:00:00Z' }] }),
      repos,
      () => 'Mon 09:00'
    )
    expect(chips[0]!.text).toBe('Runs unattended: Every weekday at 9:00, next Mon 09:00')
    expect(chips.find((c) => c.key === 'shellin:test_command')).toMatchObject({ text: 'Input “test_command” is executed as shell', tone: 'danger' })
    expect(chips.find((c) => c.key === 'push')!.text).toBe('May push to git')
    expect(chips.find((c) => c.key === 'worktree')!.text).toBe('Uses a git worktree of example-project')
    expect(chips.find((c) => c.key === 'shell')!.text).toBe('Runs shell commands (3)')
    expect(flagChips(flags(), repos)).toEqual([])
  })
  it('diff and meta changes for update cards', () => {
    const next: WorkflowDraft = { ...roundup, name: 'PR roundup v2', nodes: [...roundup.nodes.filter((n) => n.id !== 'text_me').map((n) => (n.id === 'scan' ? { ...n, label: 'Scan' } : n)), { ...roundup.nodes[4]!, id: 'notify2' }] }
    const d = computeDiff(roundup, next)!
    expect(d.added).toEqual(['notify2'])
    expect(d.removed).toEqual(['text_me'])
    expect(d.changed).toEqual(['scan'])
    expect(computeDiff(null, next)).toBeNull()
    expect(metaChanges(roundup, next)).toEqual(['Renamed “PR roundup” → “PR roundup v2”'])
  })
  it('shell inputs (PO4) and Slack DM detection', () => {
    expect(shellInputsOf(roundup)).toEqual(['test_command'])
    expect(wantsSlackMe(roundup)).toBe(true)
    expect(wantsSlackMe(null)).toBe(false)
  })
  it('node lines: commands in full, worktree folder, wait extras', () => {
    const lines = nodeLines(roundup, profiles, repos)
    expect(lines.map((l) => l.id)).toEqual(['scan', 'fix', 'tests', 'wait_codex', 'text_me'])
    expect(lines[0]!.command).toBe('gh pr list --json number')
    expect(lines[1]).toMatchObject({ who: 'Claude', folder: 'worktree', isolated: true, command: null })
    expect(lines[2]!.command).toBe('{{inputs.test_command}}')
    expect(lines[3]!.extras).toEqual(['until output matches /^[1-9]/', 'every 1 min', 'up to 45 min, then continue'])
    expect(lines[4]).toMatchObject({ extras: ['+ Slack DM'], text: 'PR roundup\ndone' })
  })
})

describe('provenance', () => {
  const origin: WorkflowOrigin = { kind: 'agent', adapter: 'claude', ownerLabel: 'example-project · Claude', ownerKey: 'claude:abc', sessionId: 's_1', runId: null, stepId: null, draftId: 'adr_1', approvedAt: '', edited: true, updatedBy: [{ draftId: 'adr_2', ownerLabel: 'x', at: '' }] }
  it('reads "Created by Claude in <owner>"', () => {
    expect(originLine(origin, provider)).toBe('Created by Claude in example-project · Claude')
    expect(originDetail(origin, provider)).toBe('you edited it before approving · updated by Claude once')
    expect(originDetail({ ...origin, edited: false, updatedBy: [] }, provider)).toBeNull()
  })
})

describe('runs', () => {
  it('nothing to do label', () => {
    expect(isNothingToDo({ status: 'passed', outcome: 'nothing_to_do' })).toBe(true)
    expect(runStatusLabel({ status: 'passed', outcome: 'nothing_to_do' })).toBe('Passed · nothing to do')
    expect(runStatusLabel({ status: 'failed', outcome: null })).toBe('failed')
  })
  it('worktree chip states (PO6 reasons)', () => {
    const wt = (p: Partial<RunWorktree>): Pick<RunWorktree, 'branch' | 'status' | 'keptReason' | 'error'> => ({ branch: 'hive/pr-roundup-r_1', status: 'kept', keptReason: 'pushed', error: null, ...p })
    expect(worktreeChip(wt({}))).toBe('hive/pr-roundup-r_1 · kept (pushed)')
    expect(worktreeState(wt({ keptReason: 'dirty' }))).toBe('kept (unpushed work)')
    expect(worktreeState(wt({ status: 'error', error: 'not a git repository' }))).toBe('error · not a git repository')
    expect(canRemoveWorktree({ status: 'kept' })).toBe(true)
    expect(canRemoveWorktree({ status: 'active' })).toBe(false)
    expect(canRemoveWorktree({ status: 'removed' })).toBe(false)
  })
})

describe('Claude history', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const h = (id: string, p: Partial<ClaudeHistorySession> = {}): ClaudeHistorySession => ({
    id,
    path: `/x/${id}.jsonl`,
    cwd: '/Users/me/example-project',
    repoId: null,
    gitBranch: 'main',
    title: `title ${id}`,
    titleSource: 'ai',
    startedAt: '2026-10-16T10:00:00Z',
    endedAt: '2026-10-16T11:00:00Z',
    turns: 3,
    subagents: 0,
    model: 'claude-opus',
    inHive: false,
    ...p
  })
  it('meta and place', () => {
    expect(historyMeta({ turns: 1, subagents: 2 })).toBe('1 turn · 2 subagents')
    expect(historyMeta({ turns: null, subagents: 0 })).toBe('')
    expect(historyPlace({ cwd: '/Users/me/example-project', repoId: null }, repos)).toBe('example-project')
    expect(historyPlace({ cwd: '/Users/me/other', repoId: null }, repos)).toBe('~/other')
    expect(historyPlace({ cwd: null, repoId: null }, repos)).toBe('Unknown folder')
  })
  it('groups by repo, then folder, newest lane first', () => {
    const items = [h('a', { endedAt: '2026-10-16T09:00:00Z' }), h('b', { cwd: '/tmp/x', endedAt: '2026-10-16T11:30:00Z' }), h('c', { repoId: 'repo_1', endedAt: '2026-10-16T08:00:00Z' })]
    const g = historyGroups(items, repos)
    expect(g.map((x) => x.label)).toEqual(['/tmp/x', 'example-project'])
    expect(g[1]!.items.map((x) => x.id)).toEqual(['a', 'c'])
    expect(g[1]!.repoId).toBe('repo_1')
  })
  it('Home: last 7 days outside Principia, newest first, max 8', () => {
    const items = [h('in', { inHive: true }), h('old', { endedAt: '2026-10-01T00:00:00Z' }), ...Array.from({ length: 10 }, (_, i) => h(`n${i}`, { endedAt: new Date(now - i * 3_600_000).toISOString() }))]
    const r = recentOutside(items, now)
    expect(r).toHaveLength(8)
    expect(r[0]!.id).toBe('n0')
    expect(r.some((x) => x.id === 'in' || x.id === 'old')).toBe(false)
  })
  it('Canvas: last 72 h shown, rest counted as older', () => {
    const items = [h('new', { endedAt: new Date(now - 3_600_000).toISOString() }), h('old', { endedAt: new Date(now - 100 * 3_600_000).toISOString() })]
    expect(splitRecent(items, now)).toEqual({ shown: [items[0]], older: 1 })
  })
  it('search matches title, folder, branch, model', () => {
    expect(matchHistory(h('a', { title: 'Fix login' }), 'login')).toBe(true)
    expect(matchHistory(h('a', { cwd: '/Users/me/sample-project' }), 'SAMPLE')).toBe(true)
    expect(matchHistory(h('a'), 'nope')).toBe(false)
    expect(matchHistory(h('a'), '  ')).toBe(true)
  })
})

describe('approval card fixes (items 2, 4, 7)', () => {
  it('a paused schedule request reads "Approve & add paused schedule" and says it stays off', () => {
    const paused = { kind: 'create' as const, flags: flags({ scheduleSentence: 'Every weekday at 9:00 · created paused' }), scheduleRequest: { name: null, when: { kind: 'cron' as const, cron: '0 9 * * 1-5', tz: 'Europe/Madrid' }, inputs: {}, sentence: 'Every weekday at 9:00', next: [], enabled: false } }
    expect(primaryLabel(paused)).toBe('Approve & add paused schedule')
    expect(primaryLabel({ ...paused, runNow: { inputs: {} } })).toBe('Approve, add paused schedule & run now')
    expect(scheduleHint(paused)).toMatch(/stays off until you turn it on/)
    const on = { ...paused, scheduleRequest: { ...paused.scheduleRequest, enabled: undefined, next: ['2026-10-19T07:00:00.000Z'] } }
    expect(primaryLabel(on)).toBe('Approve & schedule')
    expect(scheduleHint(on)).toBe('One click saves it and turns the schedule on.')
    expect(scheduleHint({ kind: 'create', flags: flags() })).toBeNull()
  })

  it('the enforced push policy is a chip; worktree / folder names never show a raw template', () => {
    const chips = flagChips(flags({ pushPolicy: 'Can push only hive/*; never the default or base branch', worktreeRepo: '{{inputs.repo}}' }), repos)
    expect(chips.find((c) => c.key === 'pushPolicy')?.text).toBe('Push policy (enforced by Principia): Can push only hive/*; never the default or base branch')
    expect(chips.find((c) => c.key === 'worktree')?.text).toBe('Uses a git worktree of repo from “repo”')
    expect(repoLabel('{{inputs.repo}}', repos, roundup)).toBe('example-project')
    expect(repoLabel('{{ inputs.repo }}', repos, roundup, { repo: 'repo_1' })).toBe('example-project')
    const lines = nodeLines({ ...roundup, nodes: [{ id: 'scan', type: 'shell', label: 'Scan', after: [], cwd: '{{inputs.repo}}', timeoutMin: 1, command: 'ls' }] }, profiles, repos)
    expect(lines[0]!.folder).toBe('example-project')
  })
})
