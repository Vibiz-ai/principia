import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/live'
import type { TaskActivity } from '@shared/company'
import { noteHint, taskThread, toolBucket, toolsLabel, toolWords } from './taskThread'

let seq = 0
const at = (m: number): string => new Date(Date.parse('2026-10-28T10:00:00.000Z') + m * 60_000).toISOString()
const tool = (m: number, name: string, summary: string, x: Partial<AgentEvent> = {}): AgentEvent => ({ seq: ++seq, agentId: 'n', ts: at(m), kind: 'tool', toolUseId: `t${seq}`, name, summary, detail: null, state: 'ok', ...x })
const text = (m: number, t: string, kind: AgentEvent['kind'] = 'text'): AgentEvent => ({ seq: ++seq, agentId: 'n', ts: at(m), kind, toolUseId: null, name: null, summary: t.slice(0, 200), detail: t, state: null })
const act = (m: number, kind: TaskActivity['kind'], message: string, by: TaskActivity['by'] = 'human'): TaskActivity => ({ id: `a${++seq}`, taskId: 'vo-15', kind, message, createdAt: at(m), by })
const TASK = { id: 'vo-15', title: 'Check why maria’s workspace has posts', description: 'She says three posts went out she never scheduled.', createdAt: at(0) }

describe('CHAT-UI.md §8.4: the task thread', () => {
  it('the brief first, then bubbles, tool calls folded between them, your notes, in time order', () => {
    const items = taskThread({
      task: TASK,
      agentName: 'Julia',
      activity: [act(1, 'started', 'Julia started run run_abc', 'system'), act(6, 'comment', 'Check the Buffer integration too'), act(9, 'report', 'Found a second scheduler', 'agent')],
      events: [tool(2, 'ToolSearch', 'ToolSearch select:mcp__hivemem__task_get'), tool(2, 'mcp__hivemem__task_get', 'hivemem.task_get VO-15'), text(3, 'Let me look at the schedules table.'), tool(4, 'Bash', 'Bash psql -c "select…"', { description: 'Query the schedules table' }), tool(5, 'Bash', 'Bash git log'), tool(5, 'Read', 'Read /x/src/scheduler.ts'), text(7, 'Weighing the two schedulers', 'thinking'), tool(8, 'mcp__hivemem__task_comment', 'hivemem.task_comment VO-15')]
    })
    expect(items.map((i) => (i.kind === 'say' ? `${i.by}${i.thought ? '~' : ''}` : i.kind))).toEqual(['brief', 'note', 'tools', 'agent', 'tools', 'you', 'agent~', 'tools', 'agent'])
    expect(items[0]).toMatchObject({ kind: 'brief', text: 'Check why maria’s workspace has posts\n\nShe says three posts went out she never scheduled.' })
    expect(items[1]).toMatchObject({ kind: 'note', text: 'Julia started' })
    const labels = items.filter((i) => i.kind === 'tools').map((i) => (i.kind === 'tools' ? i.label : ''))
    expect(labels).toEqual(['Read the task', 'Ran 2 commands · read 1 file', 'Commenting on the task'])
    // never a raw tool name in a folded line
    for (const l of labels) expect(l).not.toMatch(/ToolSearch|mcp__|hivemem|select:|Bash|psql/)
  })
  it('a running call makes its fold shimmer', () => {
    const items = taskThread({ task: TASK, events: [tool(1, 'Bash', 'Bash npm test', { state: 'running' })] })
    expect(items[1]).toMatchObject({ kind: 'tools', running: true, label: 'Running a command' })
  })
})

describe('tool calls in words', () => {
  it('a Bash call says its own description; else the plain words; ToolSearch is loading tools', () => {
    expect(toolWords({ name: 'Bash', summary: 'Bash npm test -- --run', description: 'Run the unit tests' })).toBe('Run the unit tests')
    expect(toolWords({ name: 'Bash', summary: 'Bash npm test' })).toBe('Running a command')
    expect(toolWords({ name: 'Bash', summary: 'Bash npm test' }, false)).toBe('Working on it')
    expect(toolWords({ name: 'ToolSearch', summary: 'ToolSearch select:mcp__hivemem__task_get,mcp__hivemem__task_comment' })).toBe('Loading tools')
    expect(toolWords({ name: 'mcp__hivemem__task_get', summary: 'hivemem.task_get VO-15' })).toBe('Reading the task')
    expect(toolWords({ name: 'Read', summary: 'Read /Users/x/repo/src/a.ts' })).toBe('Reading a.ts')
  })
  it('the fold counts by kind: commands, files, memory, the task, connectors', () => {
    const e = (name: string, summary: string) => ({ name, summary })
    expect(toolsLabel([e('Bash', 'Bash a'), e('Bash', 'Bash b'), e('Read', 'Read x'), e('Read', 'Read y'), e('Read', 'Read z'), e('mcp__hivemem__memory_search', '[memory] search "maria"')])).toBe('Ran 2 commands · read 3 files · checked memory')
    expect(toolsLabel([e('ToolSearch', 'ToolSearch select:x'), e('ToolSearch', 'ToolSearch select:y')])).toBe('Loaded tools')
    expect(toolsLabel([e('ToolSearch', 'ToolSearch select:x'), e('Edit', 'Edit a.ts')])).toBe('Edited 1 file')
    expect(toolsLabel([e('posthog.exec', 'posthog.exec call execute-sql {}'), e('posthog.exec', 'posthog.exec call x'), e('Grep', 'Grep x')])).toBe('Searched the files · used PostHog')
    expect(toolsLabel([e('Bash', 'Bash a'), e('Read', 'Read x')], false)).toBe('Worked through 1 step · read 1 note')
    expect(toolBucket(e('mcp__hivemem__task_report', 'hivemem.task_report review'))).toEqual({ bucket: 'task', task: 'task_report' })
  })
})

describe('what sending a note does', () => {
  it('says when the agent gets it', () => {
    expect(noteHint('Julia', 'working')).toBe('→ Julia gets it as soon as this turn ends, and goes on from there')
    expect(noteHint('Julia', 'queued')).toBe('→ Julia reads it when the task starts')
    expect(noteHint('Julia', 'done')).toContain('nobody is woken')
    expect(noteHint('Julia', 'needs_you', { answers: true })).toBe('→ Answers Julia’s question, and the task goes on')
    expect(noteHint('Julia', 'in_review')).toBe('→ Julia reads it on the next turn of this task')
  })
})
