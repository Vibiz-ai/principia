import { describe, expect, it } from 'vitest'
import type { AgentNode, CheckNode, WorkflowDraft } from '@shared/types'
import {
  ancestors,
  createNode,
  depsOf,
  implicitDeps,
  initialInputValue,
  runInputProblems,
  draftKey,
  insertTemplate,
  localValidate,
  moveNode,
  newDraft,
  openTemplateAt,
  removeNode,
  renameNode,
  shapeSummary,
  slugify,
  templateSuggestions,
  topoOrder,
  uniqueId,
  updateNode,
  wouldCycle
} from './workflow'

function agent(id: string, after: string[] = [], prompt = 'do it'): AgentNode {
  return { id, type: 'agent', label: id, after, cwd: null, timeoutMin: 30, profileId: 'prof_a', prompt }
}
function check(id: string, target: string, extra: Partial<CheckNode> = {}): CheckNode {
  return { id, type: 'check', label: id, after: [target], cwd: null, timeoutMin: 30, profileId: 'prof_b', command: null, target, criteria: 'ok', maxRetries: 3, ...extra }
}
const draft = (nodes: WorkflowDraft['nodes'], inputs: WorkflowDraft['inputs'] = []): WorkflowDraft => ({ name: 'wf', description: '', inputs, nodes })

describe('ids', () => {
  it('slugifies and uniquifies', () => {
    expect(slugify('Build It!')).toBe('build-it')
    expect(slugify('123abc')).toBe('abc')
    expect(slugify('')).toBe('step')
    expect(uniqueId('build', ['build', 'build2'])).toBe('build3')
  })
})

describe('dependencies', () => {
  it('derives check deps from target, and template refs count as deps (CONTRACT E2)', () => {
    expect(depsOf(check('review', 'build'))).toEqual(['build'])
    const b = agent('b', [], 'use {{a.output}} and {{inputs.x}}')
    expect(depsOf(b)).toEqual(['a'])
  })
  it('finds ancestors transitively and detects cycles', () => {
    const nodes = [agent('a'), agent('b', ['a']), agent('c', ['b'])]
    expect([...ancestors(nodes, 'c')].sort()).toEqual(['a', 'b'])
    expect(wouldCycle(nodes, 'a', 'c')).toBe(true)
    expect(wouldCycle(nodes, 'c', 'a')).toBe(false)
    expect(topoOrder(nodes)).toEqual(['a', 'b', 'c'])
    expect(topoOrder([agent('a', ['b']), agent('b', ['a'])])).toBeNull()
  })
})

describe('localValidate', () => {
  it('mirrors the memory rules: shell and command checks off, reviewer checks read only', () => {
    expect(localValidate(draft([{ ...agent('build'), memory: 'read-write' }, check('review', 'build', { memory: 'read' })]))).toEqual([])
    const errs = localValidate(
      draft([
        { ...agent('build'), memory: 'read-write' },
        check('review', 'build', { memory: 'read-write' }),
        check('test', 'build', { profileId: null, command: 'npm test', memory: 'read' }),
        { id: 's', type: 'shell', label: 's', after: [], cwd: null, timeoutMin: 30, command: 'ls', memory: 'read' }
      ])
    )
    expect(errs.filter((e) => e.path === 'review').map((e) => e.message)).toEqual(['Check "review": reviewer checks can only read memory'])
    expect(errs.some((e) => e.path === 'test' && e.message.includes('cannot use memory'))).toBe(true)
    expect(errs.some((e) => e.path === 's' && e.message.includes('cannot use memory'))).toBe(true)
  })
  it('accepts a clean agent -> check workflow', () => {
    expect(localValidate(draft([agent('build', [], '{{inputs.task}}'), check('review', 'build')], [{ name: 'task', label: 'Task' }]))).toEqual([])
  })
  it('names the node for an unknown template reference (W2)', () => {
    const errs = localValidate(draft([agent('build'), agent('review', ['build'], 'look at {{nope.output}}')]))
    expect(errs.some((e) => e.path === 'review' && e.message.includes('nope'))).toBe(true)
  })
  it('flags cycles, unknown inputs, duplicate ids, rooms with < 2 participants', () => {
    expect(localValidate(draft([agent('a', ['b']), agent('b', ['a'])])).some((e) => e.message.includes('cycle'))).toBe(true)
    expect(localValidate(draft([agent('a', [], '{{inputs.zzz}}')])).some((e) => e.message.includes('unknown input'))).toBe(true)
    expect(localValidate(draft([agent('a'), agent('a')])).some((e) => e.message.includes('used twice'))).toBe(true)
    const room = { id: 'room', type: 'room' as const, label: 'room', after: [], cwd: null, timeoutMin: 30, participants: [{ profileId: 'p', label: 'A' }], topic: 't', rounds: 2, final: 'last' as const }
    expect(localValidate(draft([room])).some((e) => e.message.includes('at least 2'))).toBe(true)
  })
  it('requires a check to target an agent and have a reviewer', () => {
    const errs = localValidate(draft([{ id: 's', type: 'shell', label: 's', after: [], cwd: null, timeoutMin: 30, command: 'ls' }, check('c', 's', { profileId: null, command: null })]))
    expect(errs.some((e) => e.message.includes('must check an agent'))).toBe(true)
    expect(errs.some((e) => e.message.includes('reviewer'))).toBe(true)
  })
})

describe('mutations', () => {
  it('renames a node and rewrites after, check target and templates', () => {
    const d = draft([agent('build'), agent('docs', ['build'], 'Summarize {{build.output}}'), check('review', 'build')])
    const r = renameNode(d, 'build', 'impl')
    expect(r.nodes[0]!.id).toBe('impl')
    expect(r.nodes[1]!.after).toEqual(['impl'])
    expect((r.nodes[1] as AgentNode).prompt).toBe('Summarize {{impl.output}}')
    expect((r.nodes[2] as CheckNode).target).toBe('impl')
    expect(r.nodes[2]!.after).toEqual(['impl'])
  })
  it('removes a node and drops references', () => {
    const r = removeNode(draft([agent('a'), agent('b', ['a']), check('c', 'a')]), 'a')
    expect(r.nodes.map((n) => n.id)).toEqual(['b', 'c'])
    expect(r.nodes[0]!.after).toEqual([])
    expect((r.nodes[1] as CheckNode).target).toBe('')
  })
  it('keeps check.after derived from target on update', () => {
    const r = updateNode(draft([agent('a'), agent('b'), check('c', 'a')]), 'c', { target: 'b' } as Partial<CheckNode>)
    expect(r.nodes[2]!.after).toEqual(['b'])
  })
  it('moves nodes within bounds', () => {
    const d = draft([agent('a'), agent('b')])
    expect(moveNode(d, 'b', -1).nodes.map((n) => n.id)).toEqual(['b', 'a'])
    expect(moveNode(d, 'a', -1)).toBe(d)
  })
  it('new nodes default after = previous card; check targets the previous agent', () => {
    const d = newDraft('prof_a')
    expect(d.nodes).toHaveLength(1)
    expect((d.nodes[0] as AgentNode).prompt).toBe('{{inputs.task}}')
    const sh = createNode(d, 'shell', 'prof_a')
    expect(sh.after).toEqual([d.nodes[0]!.id])
    expect(sh.cwd).toBe('{{inputs.repo}}')
    const c = createNode(d, 'check', 'prof_a', 'prof_codex') as CheckNode
    expect(c.target).toBe(d.nodes[0]!.id)
    expect(c.profileId).toBe('prof_codex')
    expect(createNode(d, 'room', 'p1', 'p2').type).toBe('room')
  })
  it('new agent and room steps read and write memory, reviewers read (LIVE.md §7); shell steps do not', () => {
    const d = newDraft('prof_a')
    expect(d.nodes[0]!.memory).toBe('read-write')
    expect(createNode(d, 'room', 'p1', 'p2').memory).toBe('read-write')
    expect(createNode(d, 'check', 'prof_a').memory).toBe('read')
    expect(createNode(d, 'shell', 'prof_a').memory).toBeUndefined()
    expect(localValidate({ ...d, nodes: [...d.nodes, createNode(d, 'check', 'prof_a')] })).toEqual([])
  })
  it('summarizes shape and tracks edits', () => {
    const d = draft([agent('build'), check('review', 'build', { command: 'npm test', profileId: null })])
    expect(shapeSummary(d)).toBe('agent → command check ↺3')
    expect(draftKey(d)).toBe(draftKey(structuredClone(d)))
  })
})

describe('templates', () => {
  it('suggests inputs, upstream outputs first, never descendants, plus ARTIFACTS_DIR', () => {
    const d = draft([agent('a'), agent('b', ['a']), agent('c', ['b'])], [{ name: 'task', label: 'Task' }])
    const s = templateSuggestions(d, 'b')
    expect(s[0]).toBe('inputs.task')
    expect(s).toContain('a.output')
    expect(s).not.toContain('c.output')
    expect(s).not.toContain('b.output')
    expect(s[s.length - 1]).toBe('ARTIFACTS_DIR')
  })
  it('detects an open {{ at the caret and inserts a token', () => {
    expect(openTemplateAt('Fix {{inp', 9)).toEqual({ start: 4, query: 'inp' })
    expect(openTemplateAt('Fix {{a.output}} ok', 19)).toBeNull()
    const r = insertTemplate('Fix {{inp', 9, 'inputs.task')
    expect(r.text).toBe('Fix {{inputs.task}}')
    expect(r.caret).toBe(r.text.length)
  })
})

describe('wait, notify and worktree (AUTHORING.md §4)', () => {
  const base = (): WorkflowDraft => ({ ...draft([agent('build')]), inputs: [{ name: 'repo', label: 'Repo', type: 'repo' }] })
  it('creates wait and notify nodes with editor defaults', () => {
    const d = base()
    const w = createNode(d, 'wait', 'prof_a')
    expect(w).toMatchObject({ id: 'wait', type: 'wait', until: 'exit0', pattern: null, intervalSec: 60, onTimeout: 'fail', timeoutMin: 60, after: ['build'] })
    expect(w.memory).toBeUndefined()
    const n = createNode(d, 'notify', 'prof_a')
    expect(n).toMatchObject({ id: 'notify', type: 'notify', cwd: null, slack: null, title: 'wf', timeoutMin: 1 })
  })
  it('validates wait fields', () => {
    const d = base()
    const w = { ...createNode(d, 'wait', null), command: '', until: 'match' as const, pattern: '([', intervalSec: 2 }
    const errs = localValidate({ ...d, nodes: [...d.nodes, w] }).map((e) => e.message)
    expect(errs).toContain('Wait "wait": command is empty')
    expect(errs).toContain('Wait "wait": pattern is not a valid regular expression')
    expect(errs).toContain('Wait "wait": check every 5–3600 seconds')
    const ok = { ...w, command: 'true', pattern: '^ok$', intervalSec: 30 }
    expect(localValidate({ ...d, nodes: [...d.nodes, ok] })).toEqual([])
  })
  it('validates notify: message required, no worktree, no memory', () => {
    const d = base()
    const n = { ...createNode(d, 'notify', null), message: '', isolate: 'worktree' as const, memory: 'read' as const }
    const errs = localValidate({ ...d, nodes: [...d.nodes, n] }).map((e) => e.message)
    expect(errs).toContain('Notify "notify": message is empty')
    expect(errs).toContain('Notify "notify" cannot run in a worktree')
    expect(errs.some((m) => m.includes('notify steps cannot use memory'))).toBe(true)
  })
  it('isolate needs a workflow worktree; WORKTREE_DIR needs an isolated step first', () => {
    const d = base()
    const iso = { ...agent('fix', ['build'], 'cd {{WORKTREE_DIR}}'), isolate: 'worktree' as const }
    const late = agent('late', [], 'ls {{WORKTREE_DIR}}')
    let errs = localValidate({ ...d, nodes: [...d.nodes, iso, late] }).map((e) => e.message)
    expect(errs).toContain('Step "fix": isolate needs a workflow worktree repo')
    errs = localValidate({ ...d, worktree: { repo: '{{inputs.repo}}' }, nodes: [...d.nodes, iso, late] }).map((e) => e.message)
    expect(errs).toEqual(['Step "late": {{WORKTREE_DIR}} is used before the worktree exists; isolate this step or one before it'])
    errs = localValidate({ ...d, worktree: { repo: '{{inputs.repo}}' }, nodes: [...d.nodes, iso, { ...late, after: ['fix'] }] }).map((e) => e.message)
    expect(errs).toEqual([])
  })
  it('worktree repo must be a repo input or a repo id', () => {
    const d = { ...base(), inputs: [{ name: 'task', label: 'Task' }] }
    expect(localValidate({ ...d, worktree: { repo: '{{inputs.task}}' } }).map((e) => e.message)).toContain('Worktree: {{inputs.task}} must be a Repository input')
    expect(localValidate({ ...d, worktree: { repo: '' } }).map((e) => e.message)).toContain('Worktree: pick the repository to branch from')
  })
  it('renames references in wait commands and notify messages; worktree tokens are not node refs', () => {
    const d = draft([agent('scan'), { id: 'w', type: 'wait', label: 'w', after: [], cwd: null, timeoutMin: 5, command: 'echo {{scan.output}}', until: 'exit0', pattern: null, intervalSec: 10, onTimeout: 'fail' }, { id: 'n', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: '{{scan.output}}', message: 'x {{scan.output}}', slack: null }])
    const r = renameNode(d, 'scan', 'look')
    expect(r.nodes[1]).toMatchObject({ command: 'echo {{look.output}}' })
    expect(r.nodes[2]).toMatchObject({ title: '{{look.output}}', message: 'x {{look.output}}' })
    expect(depsOf(agent('a', [], '{{WORKTREE_DIR}} {{WORKTREE_BRANCH}}'))).toEqual([])
  })
  it('suggests worktree tokens only where the worktree exists', () => {
    const d = { ...base(), worktree: { repo: '{{inputs.repo}}' }, nodes: [{ ...agent('fix'), isolate: 'worktree' as const }, agent('after', ['fix']), agent('other')] }
    expect(templateSuggestions(d, 'after')).toContain('WORKTREE_DIR')
    expect(templateSuggestions(d, 'other')).not.toContain('WORKTREE_DIR')
  })
  it('draftKey sees worktree changes', () => {
    const d = base()
    expect(draftKey(d)).not.toBe(draftKey({ ...d, worktree: { repo: 'repo_1' } }))
  })
})

describe('check loop body + implicit deps + typed inputs (items 1, 3, 7)', () => {
  const wait = { id: 'wait_codex', type: 'wait' as const, label: 'w', after: ['combine'], cwd: null, timeoutMin: 30, command: 'true', until: 'exit0' as const, pattern: null, intervalSec: 60, onTimeout: 'continue' as const }
  it('a check may run after a wait node downstream of its target; editing it keeps that after', () => {
    const c = check('pr_review', 'combine', { after: ['wait_codex'] })
    const d = draft([agent('combine'), wait, c])
    expect(depsOf(c).sort()).toEqual(['combine', 'wait_codex'])
    expect(localValidate(d)).toEqual([])
    const edited = updateNode(d, 'pr_review', { criteria: 'stricter' } as Partial<CheckNode>)
    expect(edited.nodes[2]!.after).toEqual(['wait_codex'])
    const retargeted = updateNode(draft([agent('combine'), agent('other'), wait, c]), 'pr_review', { target: 'other' } as Partial<CheckNode>)
    expect(retargeted.nodes[3]!.after).toEqual(['other'])
    const bad = draft([agent('scan'), agent('combine'), wait, check('pr_review', 'combine', { after: ['scan'] })])
    expect(localValidate(bad).map((e) => e.message)).toContain('Check "pr_review" may only run after "combine" or steps that run after it (its loop body); "scan" is not')
  })

  it('the After row shows dependencies that come from templates and check targets', () => {
    expect(implicitDeps(agent('b', [], 'use {{a.output}}'))).toEqual([{ id: 'a', why: 'uses {{a.output}}' }])
    expect(implicitDeps(agent('b', ['a'], 'use {{a.output}}'))).toEqual([])
    expect(implicitDeps(check('c', 'a', { after: ['w'] }))).toEqual([{ id: 'a', why: 'checks a' }])
  })

  it('run sheet: checkbox values are true/false; an unknown value is refused, never guessed', () => {
    const dry = { name: 'dry_run', label: 'Dry run', type: 'boolean' as const, default: 'true' }
    expect(initialInputValue(dry, undefined, '')).toBe('true')
    expect(initialInputValue(dry, 'false', '')).toBe('false')
    expect(initialInputValue(dry, 'yes', '')).toBe('true') // a stale free-text value is not reused
    expect(initialInputValue({ ...dry, default: undefined }, undefined, '')).toBe('false')
    expect(runInputProblems([dry], { dry_run: 'true' })).toEqual([])
    expect(runInputProblems([{ ...dry, default: 'yes' }], { dry_run: 'yes' })).toEqual(['Input "dry_run" is a checkbox: its value must be true or false (got "yes")'])
    expect(localValidate(draft([agent('a')], [{ ...dry, default: 'maybe' }])).map((e) => e.message)).toContain('Input "dry_run" is a checkbox: its default must be true or false')
  })
})
