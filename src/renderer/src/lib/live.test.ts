import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentNode, Ask } from '@shared/live'
import type { CanvasSnapshot, Run, RunStep, WorkflowDraft } from '@shared/types'
import {
  activityLine,
  agentVisual,
  answerText,
  answerTrace,
  axisTicks,
  homeWindowLabel,
  lastSaid,
  needsOwners,
  rowActivity,
  niceIntMax,
  recentAnswer,
  rootTitle,
  costOrTokens,
  descendants,
  eventDurations,
  hubGroups,
  indexAgents,
  memoryChipText,
  mergeAgent,
  mergeAsk,
  mergeEvents,
  modelSeries,
  needsYouCount,
  nextNeedsYou,
  niceMax,
  pillsFor,
  sinceLabel,
  treeMemReads
} from './live'
import { canvasGraph, cardHeight, NODE_H, PILL_H, type CardData } from './graph'

const FIX = join(__dirname, '../../../main/engine/__tests__/fixtures')
const lines = (f: string): Record<string, unknown>[] =>
  readFileSync(join(FIX, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const T0 = Date.parse('2026-10-15T10:00:00.000Z')
const iso = (s: number): string => new Date(T0 + s * 1000).toISOString()
const agent = (p: Partial<AgentNode> & Pick<AgentNode, 'id'>): AgentNode => ({
  kind: 'step', parentId: null, rootId: p.id, sessionId: null, runId: 'r_1', stepId: 'st_1', provider: 'claude', repoId: 'repo_1', cwd: '/w',
  title: 'build', agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact',
  status: 'working', needs: null, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null,
  costUsd: null, modelUsage: null, report: null, startedAt: iso(0), updatedAt: iso(0), endedAt: null, ...p
})
const ask = (p: Partial<Ask> & Pick<Ask, 'id' | 'agentId' | 'rootId'>): Ask => ({
  sessionId: null, runId: 'r_1', stepId: 'st_1', provider: 'claude', kind: 'permission', channel: 'stdio', title: 'Bash npm test', detail: null,
  toolName: 'Bash', toolInput: null, question: null, options: [{ id: 'a', label: 'Allow once', kind: 'allow' }, { id: 'd', label: 'Deny', kind: 'deny' }],
  status: 'open', answer: null, answeredVia: null, createdAt: iso(10), answeredAt: null, expiresAt: null, ...p
})

/**
 * What the renderer receives for a headless claude step, replayed from a recorded stream: one agent:updated per
 * change, keyed by the first id seen (A6: the Agent tool_use id; task_started only adds an alias).
 */
function replayClaudeStream(file: string): { updates: AgentNode[]; events: Map<string, AgentEvent[]> } {
  const root = agent({ id: 'ag_root' })
  const updates: AgentNode[] = [root]
  const events = new Map<string, AgentEvent[]>()
  const keyOf = new Map<string, string>() // tool_use id / task_id -> ag id
  let seq = 0
  let t = 1
  for (const l of lines(file)) {
    t++
    if (l.type === 'assistant') {
      const parent = (l.parent_tool_use_id as string | null) ?? null
      const owner = parent ? (keyOf.get(parent) ?? 'ag_root') : 'ag_root'
      for (const c of (l.message as { content: { type: string; name?: string; id?: string; input?: Record<string, string> }[] }).content) {
        if (c.type !== 'tool_use') continue
        if (c.name === 'Agent' || c.name === 'Task') {
          const id = `ag_${c.id!.slice(-8)}`
          keyOf.set(c.id!, id)
          updates.push(agent({ id, kind: 'subagent', parentId: owner, rootId: 'ag_root', title: c.input!.description!, agentType: c.input!.subagent_type!, toolUseId: c.id!, depth: 1, status: 'starting', startedAt: iso(t), updatedAt: iso(t) }))
        } else {
          const list = events.get(owner) ?? []
          list.push({ seq: ++seq, agentId: owner, ts: iso(t), kind: 'tool', toolUseId: c.id!, name: c.name!, summary: c.input?.file_path ?? '', detail: null, state: 'ok' })
          events.set(owner, list)
          const prev = [...updates].reverse().find((u) => u.id === owner)!
          updates.push({ ...prev, status: 'working', toolCount: prev.toolCount + 1, activity: `${c.name} ${c.input?.file_path ?? ''}`.trim(), updatedAt: iso(t) })
        }
      }
    }
    if (l.type === 'system' && l.subtype === 'task_started') {
      const id = keyOf.get(l.tool_use_id as string)!
      keyOf.set(l.task_id as string, id) // alias, same node
      const prev = [...updates].reverse().find((u) => u.id === id)!
      updates.push({ ...prev, externalId: l.task_id as string, status: 'working', updatedAt: iso(t) })
    }
    if (l.type === 'system' && l.subtype === 'task_notification') {
      const id = keyOf.get(l.task_id as string)!
      const prev = [...updates].reverse().find((u) => u.id === id)!
      updates.push({ ...prev, status: 'done', endedAt: iso(t), updatedAt: iso(t) })
    }
  }
  return { updates, events }
}
function apply(updates: AgentNode[]): AgentNode[] {
  const m = new Map<string, AgentNode>()
  for (const u of updates) m.set(u.id, mergeAgent(m.get(u.id), u))
  return [...m.values()]
}

describe('live agent tree (fixtures)', () => {
  it('claude foreground subagent: one child node under the step, its Read on the child, done at the end (A6)', () => {
    const { updates, events } = replayClaudeStream('claude-subagent-fg.stream.jsonl')
    const idx = indexAgents(apply(updates))
    const kids = idx.children.get('ag_root') ?? []
    expect(kids).toHaveLength(1)
    expect(kids[0]!.title).toBe('Read note.txt contents')
    expect(kids[0]!.externalId).toBe('a6474ac33091f1e2b')
    expect(kids[0]!.status).toBe('done')
    expect(events.get(kids[0]!.id)!.map((e) => e.name)).toEqual(['Read', 'SubagentHandback'])
    // the main agent's own Read after the subagent finished stays on the root
    expect(events.get('ag_root')!.map((e) => e.name)).toEqual(['Read'])
    expect(descendants(idx, 'ag_root').map((d) => d.depth)).toEqual([1])
  })

  it('late or out-of-order updates never reopen a finished subagent', () => {
    const { updates } = replayClaudeStream('claude-subagent-fg.stream.jsonl')
    const done = apply(updates).find((a) => a.kind === 'subagent')!
    const stale = { ...done, status: 'working' as const, endedAt: null, updatedAt: iso(999) }
    expect(mergeAgent(done, stale).status).toBe('done')
    const older = { ...done, activity: 'old', updatedAt: iso(0) }
    expect(mergeAgent({ ...done, status: 'working', endedAt: null }, { ...older, status: 'working', endedAt: null }).activity).not.toBe('old')
  })

  it('canvas: the step card grows one pill per subagent, with the ◆ count from open asks in its tree', () => {
    const { updates } = replayClaudeStream('claude-subagent-fg.stream.jsonl')
    const live = apply(updates).map((a) => (a.kind === 'subagent' ? { ...a, status: 'working' as const, endedAt: null } : a))
    const idx = indexAgents(live)
    const sub = live.find((a) => a.kind === 'subagent')!
    const asks = [ask({ id: 'ask_1', agentId: sub.id, rootId: 'ag_root' })]
    const wf: WorkflowDraft = { name: 'W', description: '', inputs: [], nodes: [{ id: 'build', type: 'agent', label: 'build', after: [], cwd: null, timeoutMin: 30, profileId: 'pc', prompt: 'x' }] }
    const run: Run = { id: 'r_1', kind: 'workflow', title: 'W', target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, workflowId: 'wf', scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt: iso(0), startedAt: iso(0), endedAt: null, artifactsDir: '/a', artifactCount: 0 }
    const step: RunStep = { id: 'st_1', runId: 'r_1', seq: 1, nodeId: 'build', nodeType: 'agent', attempt: 1, round: null, profileId: 'pc', participantLabel: null, adapter: 'claude', cwd: '/', prompt: '', output: null, verdict: null, exitCode: null, pid: null, status: 'running', error: null, sourceStepIds: [], agentSessionId: null, logPath: '', startedAt: iso(0), endedAt: null }
    const snap: CanvasSnapshot = { sessions: [], runs: [{ run, workflow: wf, steps: [step] }], schedules: [], workflows: [], profiles: [], repos: [] }
    const g = canvasGraph(snap, T0 + 60_000, { idx, asks })
    const card = g.nodes.find((n) => n.id === 'r:r_1:build')!
    expect(card.type).toBe('card')
    const data = card.data as CardData
    expect(data.agentId).toBe('ag_root')
    expect(data.needs).toBe(1)
    expect(data.pills!.map((p) => [p.label, p.visual])).toEqual([['Read note.txt contents', 'needs']])
    expect(cardHeight(data)).toBe(NODE_H + PILL_H + 6)
    // without the overlay the same card is a plain 44 px node
    const plain = canvasGraph(snap, T0 + 60_000).nodes.find((n) => n.id === 'r:r_1:build')!
    expect(cardHeight(plain.data as never)).toBe(NODE_H)
  })

  it('pills: at most 4, asks first, then live, with "+n more"', () => {
    const kids = Array.from({ length: 6 }, (_, i) => agent({ id: `ag_k${i}`, kind: 'subagent', parentId: 'ag_root', rootId: 'ag_root', title: `k${i}`, status: i < 2 ? 'done' : 'working', startedAt: iso(i), endedAt: i < 2 ? iso(9) : null }))
    const idx = indexAgents([agent({ id: 'ag_root' }), ...kids])
    const { pills, more } = pillsFor(idx, 'ag_root', new Set(['ag_k0']))
    expect(pills.map((p) => p.label)).toEqual(['k0', 'k5', 'k4', 'k3'])
    expect(more).toBe(2)
  })
})

describe('Needs you (A3) and the hub groups', () => {
  /** Session root states the hooks in claude-hooks-pty-idle.jsonl drive, in order. */
  function idleSequence(): AgentNode[] {
    const out: AgentNode[] = []
    let cur = agent({ id: 'ag_s', kind: 'session', sessionId: 's_1', runId: null, stepId: null, title: 'Claude in vibiz', status: 'starting' })
    let t = 0
    for (const h of lines('claude-hooks-pty-idle.jsonl')) {
      t++
      const ev = h.hook_event_name
      if (ev === 'SessionStart') cur = { ...cur, status: 'idle', updatedAt: iso(t) }
      if (ev === 'UserPromptSubmit') cur = { ...cur, status: 'working', needs: null, updatedAt: iso(t) }
      if (ev === 'PreToolUse') cur = { ...cur, activity: `Bash ${(h.tool_input as { command: string }).command}`, updatedAt: iso(t) }
      if (ev === 'Stop') cur = { ...cur, status: 'needs_you', needs: 'idle', activity: null, updatedAt: iso(t) }
      out.push(cur)
    }
    return out
  }

  it('an idle turn counts while unseen, then moves to Open sessions and keeps its Reply (fixture: pty idle)', () => {
    const seq = idleSequence()
    const states = seq.map((a) => hubGroups([a], [], new Set(), { now: T0 + 3600e3 }))
    expect(states[0]!.open.map((a) => a.id)).toEqual(['ag_s']) // SessionStart: ready, not Needs you
    expect(states[1]!.working.map((a) => a.id)).toEqual(['ag_s'])
    const afterStop = seq[seq.findIndex((a) => a.needs === 'idle')]!
    expect(needsYouCount([afterStop], [], new Set())).toBe(1)
    expect(hubGroups([afterStop], [], new Set()).needs.map((g) => g.root.id)).toEqual(['ag_s'])
    expect(activityLine(afterStop)).toBe('Your turn')
    // the pane was on screen with the window focused
    const seen = new Set(['ag_s'])
    expect(needsYouCount([afterStop], [], seen)).toBe(0)
    const g = hubGroups([afterStop], [], seen)
    expect(g.needs).toHaveLength(0)
    expect(g.open.map((a) => a.id)).toEqual(['ag_s'])
    expect(agentVisual(afterStop, true)).toBe('idle')
    // a seen flag from main counts the same
    expect(needsYouCount([{ ...afterStop, seen: true }], [], new Set())).toBe(0)
  })

  it('orders Needs you by ask age, permission/question before idle; ⌘J picks the oldest ask', () => {
    const idle = agent({ id: 'ag_idle', kind: 'session', sessionId: 's_2', runId: null, stepId: null, status: 'needs_you', needs: 'idle', updatedAt: iso(1) })
    const stepA = agent({ id: 'ag_a', stepId: 'st_a', status: 'needs_you', needs: 'permission' })
    const stepB = agent({ id: 'ag_b', stepId: 'st_b' })
    const subB = agent({ id: 'ag_b1', kind: 'subagent', parentId: 'ag_b', rootId: 'ag_b', stepId: 'st_b' })
    const asks = [ask({ id: 'ask_new', agentId: 'ag_a', rootId: 'ag_a', createdAt: iso(50) }), ask({ id: 'ask_old', agentId: 'ag_b1', rootId: 'ag_b', kind: 'question', createdAt: iso(20) })]
    const g = hubGroups([idle, stepA, stepB, subB], asks, new Set())
    expect(g.needs.map((x) => x.root.id)).toEqual(['ag_b', 'ag_a', 'ag_idle'])
    expect(needsYouCount([idle, stepA, stepB, subB], asks, new Set())).toBe(3)
    expect(nextNeedsYou([idle, stepA], asks, new Set())).toEqual({ agentId: 'ag_b1', askId: 'ask_old' })
    expect(nextNeedsYou([idle], [], new Set())).toEqual({ agentId: 'ag_idle', askId: null })
    expect(nextNeedsYou([idle], [], new Set(['ag_idle']))).toBeNull()
  })

  it('working, done in the last 24 h (newest first), repo filter; subagents never become hub rows', () => {
    const now = T0 + 3600e3
    const w = agent({ id: 'ag_w', updatedAt: iso(30) })
    const d1 = agent({ id: 'ag_d1', status: 'done', endedAt: iso(100) })
    const d2 = agent({ id: 'ag_d2', status: 'failed', endedAt: iso(200), repoId: 'repo_2' })
    const old = agent({ id: 'ag_old', status: 'done', endedAt: new Date(now - 2 * 864e5).toISOString() })
    const sub = agent({ id: 'ag_sub', kind: 'subagent', parentId: 'ag_w', rootId: 'ag_w' })
    const g = hubGroups([w, d1, d2, old, sub], [], new Set(), { now })
    expect(g.working.map((a) => a.id)).toEqual(['ag_w'])
    expect(g.done.map((a) => a.id)).toEqual(['ag_d2', 'ag_d1'])
    expect(hubGroups([w, d1, d2], [], new Set(), { now, repoId: 'repo_2' }).done.map((a) => a.id)).toEqual(['ag_d2'])
  })

  it('closed asks never reopen from a stale event', () => {
    const open = ask({ id: 'ask_1', agentId: 'a', rootId: 'a' })
    const answered = { ...open, status: 'answered' as const, answeredVia: 'terminal' as const }
    expect(mergeAsk(answered, open).status).toBe('answered')
    expect(mergeAsk(open, answered).status).toBe('answered')
  })
})

describe('labels, chips and events', () => {
  it('cost when reported, else tokens, never an estimate', () => {
    expect(costOrTokens({ costUsd: 0.4231, tokensIn: 10, tokensOut: 5 })).toBe('$0.42')
    expect(costOrTokens({ costUsd: null, tokensIn: 12000, tokensOut: 340 })).toBe('12k tok')
    expect(costOrTokens({ costUsd: null, tokensIn: null, tokensOut: null })).toBe('')
  })
  it('memory chip: "3 read · 1 saved", "brief" for inject-only, hidden when memory was off and unused', () => {
    expect(memoryChipText({ reads: 3, saved: 1, briefOnly: false, granted: true })).toBe('3 read · 1 saved')
    expect(memoryChipText({ reads: 0, saved: 0, briefOnly: true, granted: true })).toBe('brief')
    expect(memoryChipText({ reads: 0, saved: 0, briefOnly: false, granted: false })).toBeNull()
    const idx = indexAgents([agent({ id: 'r', memReads: 1 }), agent({ id: 'c', kind: 'subagent', parentId: 'r', rootId: 'r', memReads: 2 })])
    expect(treeMemReads(idx, 'r')).toBe(3)
  })
  it('events merge by seq (a running tool row is updated in place) and get durations', () => {
    const e = (seq: number, s: number, state: AgentEvent['state']): AgentEvent => ({ seq, agentId: 'a', ts: iso(s), kind: 'tool', toolUseId: `t${seq}`, name: 'Bash', summary: 'npm test', detail: null, state })
    const list = mergeEvents([e(1, 0, 'running')], [e(2, 4, 'running'), e(1, 0, 'ok')])
    expect(list.map((x) => [x.seq, x.state])).toEqual([[1, 'ok'], [2, 'running']])
    expect(eventDurations(list).get(1)).toBe(4000)
    expect(mergeEvents(Array.from({ length: 10 }, (_, i) => e(i, i, 'ok')), [], 5)).toHaveLength(10)
    expect(mergeEvents(Array.from({ length: 10 }, (_, i) => e(i, i, 'ok')), [e(10, 10, 'ok')], 5).map((x) => x.seq)).toEqual([6, 7, 8, 9, 10])
  })
})

describe('dashboard math', () => {
  it('tokens by model: the 5 biggest models, the rest folded into "other"', () => {
    const day = (byModel: [string, number][]): { byModel: { model: string; tokens: number }[] } => ({ byModel: byModel.map(([model, tokens]) => ({ model, tokens })) })
    const s = modelSeries([day([['opus', 100], ['sonnet', 50], ['a', 5], ['b', 4], ['c', 3], ['d', 2]]), day([['opus', 10], ['e', 1]])])
    expect(s.models).toEqual(['opus', 'sonnet', 'a', 'b', 'c', 'other'])
    expect(s.values[0]).toEqual([100, 50, 5, 4, 3, 2])
    expect(s.values[1]).toEqual([10, 0, 0, 0, 0, 1])
    expect(modelSeries([day([['opus', 1]])]).models).toEqual(['opus'])
  })
  it('nice axis maxima and the "since" header', () => {
    expect([0, 3, 7, 12, 260, 999].map(niceMax)).toEqual([1, 5, 10, 20, 500, 1000])
    const now = new Date(2026, 9, 16, 10, 0)
    expect(sinceLabel(new Date(2026, 9, 16, 9, 14).toISOString(), now)).toBe('Since 09:14')
    expect(sinceLabel(new Date(2026, 9, 15, 9, 14).toISOString(), now)).toBe('Since 09:14 yesterday')
    expect(sinceLabel(new Date(2026, 9, 12, 9, 14).toISOString(), now)).toBe('Since Oct 12 09:14')
  })

  it('canvas: an interactive session that needs you shows the amber flag and the hub name', () => {
    const root = agent({ id: 'ag_s', kind: 'session', runId: null, stepId: null, sessionId: 's_1', title: 'acme-web · Claude', status: 'needs_you', needs: 'idle', activity: 'Your turn' })
    const sess = { id: 's_1', title: 'acme-web · Claude', profileId: 'pc', adapter: 'claude' as const, repoId: 'repo_1', cwd: '/w', status: 'running' as const, pid: 1, cols: 80, rows: 24, exitCode: null, startedAt: iso(0), endedAt: null, artifactsDir: '/a', fromRunId: null, agentSessionId: null }
    const snap: CanvasSnapshot = { sessions: [sess], runs: [], schedules: [], workflows: [], profiles: [], repos: [] }
    const card = (seen: Set<string>): CardData => canvasGraph(snap, T0 + 120_000, { idx: indexAgents([root]), asks: [], seen }).nodes.find((n) => n.id === 's:s_1')!.data as CardData
    const unseen = card(new Set())
    expect(unseen.label).toBe('acme-web · Claude')
    expect(unseen.waiting).toBe(true)
    expect(unseen.sub.startsWith('Your turn')).toBe(true)
    // A3: once its pane was seen it stops flagging
    expect(card(new Set(['ag_s'])).waiting).toBeUndefined()
  })

  it('canvas: a stalled working session gets the Stalled? flag; a rate-limited one shows the limit line', () => {
    const sess = { id: 's_1', title: 'acme-web · Claude', profileId: 'pc', adapter: 'claude' as const, repoId: 'repo_1', cwd: '/w', status: 'running' as const, pid: 1, cols: 80, rows: 24, exitCode: null, startedAt: iso(0), endedAt: null, artifactsDir: '/a', fromRunId: null, agentSessionId: null }
    const snap: CanvasSnapshot = { sessions: [sess], runs: [], schedules: [], workflows: [], profiles: [], repos: [] }
    const card = (root: AgentNode): CardData => canvasGraph(snap, T0 + 120_000, { idx: indexAgents([root]), asks: [] }).nodes.find((n) => n.id === 's:s_1')!.data as CardData
    const base = agent({ id: 'ag_s', kind: 'session', runId: null, stepId: null, sessionId: 's_1', status: 'working' })
    expect(card({ ...base, stalledSince: iso(60) }).stalled).toBe(true)
    expect(card(base).stalled).toBeUndefined()
    const limited = card({ ...base, stopReason: 'rate_limited', resetAt: null })
    expect(limited.sub).toBe('Hit usage limit')
  })

  it('canvas: a rate-limited step reads "Hit usage limit" instead of the raw error', () => {
    const wf: WorkflowDraft = { name: 'W', description: '', inputs: [], nodes: [{ id: 'build', type: 'agent', label: 'build', after: [], cwd: null, timeoutMin: 30, profileId: 'pc', prompt: 'x' }] }
    const run: Run = { id: 'r_1', kind: 'workflow', title: 'W', target: { kind: 'workflow', workflowId: 'wf', inputs: {} }, workflowId: 'wf', scheduleId: null, parentRunId: null, trigger: 'schedule', status: 'failed', reason: 'x', createdAt: iso(0), startedAt: iso(0), endedAt: iso(9), artifactsDir: '/a', artifactCount: 0, stopReason: 'rate_limited', resetAt: null }
    const step: RunStep = { id: 'st_1', runId: 'r_1', seq: 1, nodeId: 'build', nodeType: 'agent', attempt: 1, round: null, profileId: 'pc', participantLabel: null, adapter: 'claude', cwd: '/', prompt: '', output: null, verdict: null, exitCode: 1, pid: null, status: 'failed', error: "You've hit your session limit", sourceStepIds: [], agentSessionId: null, logPath: '', startedAt: iso(0), endedAt: iso(9), stopReason: 'rate_limited', resetAt: null }
    const snap: CanvasSnapshot = { sessions: [], runs: [{ run, workflow: wf, steps: [step] }], schedules: [], workflows: [], profiles: [], repos: [] }
    const data = canvasGraph(snap, T0 + 60_000).nodes.find((n) => n.id === 'r:r_1:build')!.data as CardData
    expect(data.sub).toBe('claude · Hit usage limit')
  })

  it('answered asks leave a trace line for a few minutes', () => {
    const q = ask({ id: 'q1', agentId: 'ag_a', rootId: 'ag_a', kind: 'question', options: [{ id: 'c1', label: 'users', kind: 'choice' }], status: 'answered', answeredVia: 'hive', answer: { askId: 'q1', optionId: 'c1' }, answeredAt: iso(100) })
    expect(answerText(q)).toBe('You answered: users')
    expect(answerText({ ...q, answer: { askId: 'q1', text: 'go  on' } })).toBe('You answered: go on')
    expect(answerText({ ...q, kind: 'permission', options: [{ id: 'd', label: 'Deny', kind: 'deny' }], answer: { askId: 'q1', optionId: 'd', message: 'no' } })).toBe('You denied: no')
    expect(answerText({ ...q, answeredVia: 'terminal' })).toBe('Answered in the terminal')
    expect(recentAnswer([q], 'ag_a', T0 + 150_000)?.id).toBe('q1')
    expect(recentAnswer([q], 'ag_a', T0 + 100_000 + 10 * 60_000)).toBeNull()
    expect(recentAnswer([q], 'other', T0 + 150_000)).toBeNull()
  })

  it('the answered trace never replaces a row that is waiting; it shows once nothing is pending', () => {
    const allowed = ask({ id: 'p1', agentId: 'ag_s', rootId: 'ag_s', channel: 'pty', status: 'answered', answeredVia: 'hive', answer: { askId: 'p1', optionId: 'a' }, answeredAt: iso(100) })
    const now = T0 + 120_000
    const idle = agent({ id: 'ag_s', kind: 'session', status: 'needs_you', needs: 'idle', report: 'Which port should I use?' })
    expect(answerTrace(idle, [allowed], now)).toBeNull()
    // another ask opened in the same tree (a subagent) while the root itself works
    const working = { ...idle, status: 'working' as const, needs: null }
    expect(answerTrace(working, [allowed, ask({ id: 'p2', agentId: 'ag_sub', rootId: 'ag_s' })], now)).toBeNull()
    expect(answerTrace(working, [allowed], now)?.id).toBe('p1')
    expect(answerText(answerTrace(working, [allowed], now)!)).toBe('You allowed it')
  })

  it('idle rows show what the agent last said; the end of a long message wins', () => {
    expect(lastSaid({ report: null })).toBeNull()
    expect(lastSaid({ report: '  \n ' })).toBeNull()
    expect(lastSaid({ report: 'Done.\n\n\n\nShould I also update the docs?' })).toBe('Done.\n\nShould I also update the docs?')
    const long = `${'x'.repeat(600)} Which one do you want?`
    const said = lastSaid({ report: long }, 100)!
    expect(said.length).toBeLessThanOrEqual(100)
    expect(said.startsWith('…')).toBe(true)
    expect(said.endsWith('Which one do you want?')).toBe(true)
  })

  it('needsOwners: sessions and runs that need you (open asks, unseen idle sessions)', () => {
    const idle = agent({ id: 'ag_s', kind: 'session', sessionId: 's_1', runId: null, stepId: null, status: 'needs_you', needs: 'idle' })
    const asked = agent({ id: 'ag_t', kind: 'session', sessionId: 's_2', runId: null, stepId: null, status: 'needs_you', needs: 'permission' })
    const working = agent({ id: 'ag_w', kind: 'session', sessionId: 's_3', runId: null, stepId: null, status: 'working' })
    const asks = [ask({ id: 'a1', agentId: 'ag_t', rootId: 'ag_t', sessionId: 's_2', runId: null, stepId: null }), ask({ id: 'a2', agentId: 'ag_x', rootId: 'ag_x' })]
    const o = needsOwners([idle, asked, working], asks, new Set())
    expect([...o.sessions].sort()).toEqual(['s_1', 's_2'])
    expect([...o.runs]).toEqual(['r_1'])
    // A3: a seen idle session no longer needs you
    expect([...needsOwners([idle], [], new Set(['ag_s'])).sessions]).toEqual([])
  })

  it('tree rows never repeat the title as the activity', () => {
    const sub = agent({ id: 'ag_1', kind: 'subagent', parentId: 'ag_r', rootId: 'ag_r', title: 'Explore the auth module', activity: 'Explore the auth module' })
    expect(rowActivity(sub)).toBeNull()
    expect(rowActivity({ ...sub, activity: 'Explore the auth module…' })).toBeNull()
    expect(rowActivity({ ...sub, activity: 'Read src/auth.ts' })).toBe('Read src/auth.ts')
    expect(rowActivity({ ...sub, activity: null, status: 'working', lastTool: null })).toBe('Working…')
  })

  it('first Home visit reads "Last 24 hours", later visits "Since …"', () => {
    const now = new Date(2026, 9, 16, 10, 0)
    const since = new Date(2026, 9, 15, 4, 9).toISOString()
    expect(homeWindowLabel('last', since, true, now)).toBe('Last 24 hours')
    expect(homeWindowLabel('last', since, false, now)).toBe('Since 04:09 yesterday')
    expect(homeWindowLabel('7d', since, true, now)).toBe('Last 7 days')
    expect(homeWindowLabel('24h', since, false, now)).toBe('Last 24 hours')
  })

  it('chart axes never repeat or round ticks; zero memory chips are hidden; step titles read as a sentence', () => {
    expect(axisTicks(niceIntMax(1), 1)).toEqual([0, 1])
    expect(axisTicks(niceIntMax(3), 1)).toEqual([0, 2, 4])
    expect(axisTicks(0.05, 0.01)).toEqual([0, 0.05])
    expect(axisTicks(0.1, 0.01)).toEqual([0, 0.05, 0.1])
    expect(memoryChipText({ reads: 0, saved: 0, briefOnly: false, granted: true })).toBeNull()
    expect(rootTitle(agent({ id: 'x', title: 'Step 1: use the Agent tool to map src. Then stop.' }))).toBe('Use the Agent tool to map src')
    expect(rootTitle(agent({ id: 'y', kind: 'session', title: 'acme-web · Claude' }))).toBe('acme-web · Claude')
  })
})

describe('saidPreview: a chat row reads the gist in plain words', () => {
  it('no markdown, no principia links, the first real line (never the tail of a long list)', async () => {
    const { saidPreview, plainText } = await import('./live')
    expect(saidPreview({ report: 'The helper reported **1** `.md` file directly in the folder: `README.md`.' })).toBe('The helper reported 1 .md file directly in the folder: README.md.')
    expect(saidPreview({ report: '## Headlines\n\n- Ship invoices in **one** click\n- Get paid faster' })).toBe('Headlines')
    expect(saidPreview({ report: `Here they are:\n${Array.from({ length: 300 }, (_, i) => i + 1).join('\n')}` })).toBe('Here they are:')
    expect(plainText('Done. [Open LA-2 →](principia://board?task=LA-2)')).toBe('Done. Open LA-2 →')
    expect(plainText('see <principia://board?task=LA-2>')).toBe('see')
    expect(plainText('LA-2 is now in review (principia://board?task=LA-2). Done.')).toBe('LA-2 is now in review. Done.')
    expect(saidPreview({ report: '' })).toBeNull()
  })
})
