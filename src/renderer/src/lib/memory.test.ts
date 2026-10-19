import { describe, expect, it } from 'vitest'
import type { MemoryFact, MemoryProvenance } from '@shared/memory'
import type { WorkflowNode } from '@shared/types'
import {
  allowedMemoryModes,
  applyMemoryToAll,
  briefPinned,
  defaultMemoryMode,
  factsByEntity,
  keyKnowledge,
  kindMarks,
  landmarkIds,
  nameTwins,
  recentOffGraph,
  topFacts,
  typeCounts,
  workflowMemoryMode,
  entityHue,
  entityNodeSize,
  groupFacts,
  isRecent,
  isUnreviewed,
  memoryProblem,
  normalizeRelationType,
  runsFrom,
  sourceLabel,
  supersedeChain,
  whyText,
  withinWindow
} from './memory'

const base = { label: 'x', after: [], cwd: null, timeoutMin: 30 }
const agent = (memory?: WorkflowNode['memory']): WorkflowNode => ({ ...base, id: 'a', type: 'agent', profileId: 'prof_1', prompt: 'p', memory })
const shell = (memory?: WorkflowNode['memory']): WorkflowNode => ({ ...base, id: 's', type: 'shell', command: 'ls', memory })
const check = (command: string | null, memory?: WorkflowNode['memory']): WorkflowNode => ({
  ...base,
  id: 'c',
  type: 'check',
  profileId: command ? null : 'prof_1',
  command,
  target: 'a',
  criteria: '',
  maxRetries: 1,
  memory
})

function fact(p: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    entityId: 'ment_1',
    entityName: 'auth',
    text: 't',
    kind: 'fact',
    scope: 'project',
    repoId: 'repo_1',
    status: 'active',
    reviewed: false,
    pinned: false,
    invalidatedAt: null,
    invalidReason: null,
    supersededBy: null,
    supersedes: [],
    actor: 'agent',
    provenance: null,
    unattributed: false,
    editedByUser: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...p
  }
}

const prov = (p: Partial<MemoryProvenance>): MemoryProvenance => ({
  grantId: 'mgr_1',
  adapter: 'claude',
  transport: 'mcp',
  profileId: null,
  profileName: null,
  model: null,
  repoId: null,
  repoName: null,
  runId: null,
  runTitle: null,
  workflowId: null,
  stepId: null,
  nodeId: null,
  nodeLabel: null,
  sessionId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...p
})

describe('memory modes per node (mirror of CONTRACT §11.3)', () => {
  it('limits shell steps and command checks to off, reviewer checks to read', () => {
    expect(allowedMemoryModes(shell())).toEqual(['off'])
    expect(allowedMemoryModes(check('npm test'))).toEqual(['off'])
    expect(allowedMemoryModes(check(null))).toEqual(['off', 'read'])
    expect(allowedMemoryModes(agent())).toEqual(['off', 'read', 'read-write'])
  })
  it('flags disallowed modes, accepts absent/off', () => {
    expect(memoryProblem(agent())).toBeNull()
    expect(memoryProblem(agent('read-write'))).toBeNull()
    expect(memoryProblem(shell('off'))).toBeNull()
    expect(memoryProblem(shell('read'))).toMatch(/shell steps cannot use memory/)
    expect(memoryProblem(check('npm test', 'read'))).toMatch(/shell steps cannot use memory/)
    expect(memoryProblem(check(null, 'read-write'))).toMatch(/only read/)
    expect(memoryProblem(agent('everything' as never))).toMatch(/unknown memory mode/)
  })
})

describe('entity look', () => {
  it('maps known types to fixed tokens and unknown ones stably', () => {
    expect(entityHue('component')).toBe('var(--accent)')
    expect(entityHue('Component ')).toBe('var(--accent)')
    expect(entityHue('weird-type')).toBe(entityHue('weird-type'))
    expect(entityHue('weird-type')).toMatch(/^var\(--/)
  })
  it('sizes pills by name and sqrt(active facts), within bounds', () => {
    const small = entityNodeSize({ name: 'db', type: 'file', counts: { active: 0, pending: 0, invalid: 0, unreviewed: 0, pinned: 0 } })
    const big = entityNodeSize({ name: 'a-very-long-entity-name-that-keeps-going', type: 'component', counts: { active: 100, pending: 1, invalid: 0, unreviewed: 0, pinned: 1 } })
    expect(small.width).toBe(104)
    expect(big.width).toBeLessThanOrEqual(260)
    expect(big.height).toBeGreaterThan(small.height)
    expect(big.height).toBeLessThanOrEqual(48)
  })
  it('marks entities changed in the last 7 days', () => {
    const now = Date.parse('2026-10-16T00:00:00Z')
    expect(isRecent('2026-10-10T00:00:00Z', now)).toBe(true)
    expect(isRecent('2026-10-01T00:00:00Z', now)).toBe(false)
    expect(isRecent(null, now)).toBe(false)
  })
})

describe('facts', () => {
  it('groups live facts by kind (pinned first) and puts invalid ones in history', () => {
    const facts = [
      fact({ id: 'f1', kind: 'gotcha' }),
      fact({ id: 'f2', kind: 'decision', createdAt: '2026-10-02T00:00:00.000Z' }),
      fact({ id: 'f3', kind: 'decision', pinned: true }),
      fact({ id: 'f4', status: 'invalid', invalidatedAt: '2026-10-05T00:00:00.000Z' }),
      fact({ id: 'f5', status: 'pending', kind: 'convention' })
    ]
    const { groups, history } = groupFacts(facts)
    expect(groups.map((g) => g.kind)).toEqual(['decision', 'convention', 'gotcha'])
    expect(groups[0]!.facts.map((f) => f.id)).toEqual(['f3', 'f2'])
    expect(history.map((f) => f.id)).toEqual(['f4'])
  })
  it('walks the supersede chain oldest first and survives cycles', () => {
    const a = fact({ id: 'a', status: 'invalid', supersededBy: 'b' })
    const b = fact({ id: 'b', status: 'invalid', supersededBy: 'c', supersedes: ['a'] })
    const c = fact({ id: 'c', supersedes: ['b'] })
    expect(supersedeChain(c, [a, b, c]).map((f) => f.id)).toEqual(['a', 'b'])
    const x = fact({ id: 'x', supersedes: ['y'] })
    const y = fact({ id: 'y', supersedes: ['x'] })
    expect(supersedeChain(x, [x, y]).map((f) => f.id)).toEqual(['y'])
  })
  it('treats only active, unapproved agent facts as unreviewed', () => {
    expect(isUnreviewed(fact({ id: '1' }))).toBe(true)
    expect(isUnreviewed(fact({ id: '2', reviewed: true }))).toBe(false)
    expect(isUnreviewed(fact({ id: '3', actor: 'user' }))).toBe(false)
    expect(isUnreviewed(fact({ id: '4', status: 'pending' }))).toBe(false)
  })
})

describe('provenance', () => {
  it('labels the source', () => {
    expect(sourceLabel(null)).toBe('You')
    expect(sourceLabel(prov({}), { unattributed: true })).toBe('unknown agent')
    expect(sourceLabel(prov({ runTitle: 'Nightly', nodeId: 'build' }))).toBe('Claude · run “Nightly” · build')
    expect(sourceLabel(prov({ adapter: 'codex', profileName: 'Codex fast', sessionId: 's_1' }))).toBe('Codex (Codex fast) · session')
  })
  it('lists distinct runs newest first', () => {
    const rows = [
      { provenance: prov({ runId: 'r_1', runTitle: 'One' }), createdAt: '2026-10-01T00:00:00Z' },
      { provenance: prov({ runId: 'r_2', runTitle: 'Two' }), createdAt: '2026-10-03T00:00:00Z' },
      { provenance: prov({ runId: 'r_1', runTitle: 'One' }), createdAt: '2026-10-05T00:00:00Z' },
      { provenance: null, createdAt: '2026-10-06T00:00:00Z' }
    ]
    expect(runsFrom(rows).map((r) => r.runId)).toEqual(['r_1', 'r_2'])
  })
})

describe('misc', () => {
  it('filters by time window', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(withinWindow('2026-10-16T00:00:00Z', '24h', now)).toBe(true)
    expect(withinWindow('2026-10-14T00:00:00Z', '24h', now)).toBe(false)
    expect(withinWindow('2026-10-14T00:00:00Z', '7d', now)).toBe(true)
    expect(withinWindow('2020-01-01T00:00:00Z', 'any', now)).toBe(true)
  })
  it('explains a score factor by factor', () => {
    expect(whyText({ exact: false, bm25: 0.8123, scope: 0.8, trust: 1.15, recency: 0.5 })).toBe('text match 0.81 × scope 0.80 × trust 1.15 × recency 0.50')
    expect(whyText({ exact: true, bm25: 1, scope: 1, trust: 1, recency: 1 })).toMatch(/^exact name match/)
  })
  it('normalizes relation types to snake_case', () => {
    expect(normalizeRelationType(' Depends On ')).toBe('depends_on')
    expect(normalizeRelationType('owned-by!')).toBe('owned_by')
  })
})

describe('what the graph shows without a click', () => {
  const ent = (id: string, name: string, repoId: string | null, degree = 0, active = 0) => ({ id, name, repoId, type: 'component', degree, counts: { active, pending: 0, invalid: 0, unreviewed: 0, pinned: 0 } })
  it('groups live facts per entity and drops invalid ones', () => {
    const m = factsByEntity([fact({ id: 'a' }), fact({ id: 'b', entityId: 'ment_2' }), fact({ id: 'c', status: 'invalid' })])
    expect(m.get('ment_1')!.map((f) => f.id)).toEqual(['a'])
    expect(m.get('ment_2')!.map((f) => f.id)).toEqual(['b'])
  })
  it('orders the hover card: pinned, active before pending, gotcha > decision > convention > fact, newest', () => {
    const list = [
      fact({ id: 'plain', createdAt: '2026-10-09T00:00:00.000Z' }),
      fact({ id: 'conv', kind: 'convention' }),
      fact({ id: 'gotcha', kind: 'gotcha' }),
      fact({ id: 'pend', kind: 'gotcha', status: 'pending' }),
      fact({ id: 'pin', pinned: true }),
      fact({ id: 'gone', status: 'invalid', kind: 'gotcha' })
    ]
    expect(topFacts(list, 4).map((f) => f.id)).toEqual(['pin', 'gotcha', 'conv', 'plain'])
  })
  it('marks only gotcha / decision / convention, from active facts', () => {
    expect(kindMarks([fact({ id: '1', kind: 'convention' }), fact({ id: '2', kind: 'gotcha' }), fact({ id: '3', kind: 'decision', status: 'pending' }), fact({ id: '4' })])).toEqual(['gotcha', 'convention'])
    expect(kindMarks(undefined)).toEqual([])
  })
  it('keeps landmark labels for the best-connected entities', () => {
    const l = landmarkIds([ent('a', 'a', 'r', 0, 1), ent('b', 'b', 'r', 5, 0), ent('c', 'c', 'r', 1, 9)], 2)
    expect([...l].sort()).toEqual(['b', 'c'])
  })
  it('pairs project and global entities that share a name, ignoring case and separators', () => {
    const t = nameTwins([ent('p', 'Lautaro', 'repo'), ent('g', 'lautaro', null), ent('x', 'auth-service', 'repo'), ent('y', 'Auth Service', 'repo2')])
    expect(t.get('p')).toBe('g')
    expect(t.get('g')).toBe('p')
    expect(t.has('x')).toBe(false) // two projects: not a project/global pair
  })
  it('counts types for the legend, most common first', () => {
    expect(typeCounts([{ type: 'file' }, { type: 'API' }, { type: 'file' }, { type: '' }])).toEqual([
      { type: 'file', count: 2 },
      { type: 'api', count: 1 },
      { type: 'other', count: 1 }
    ])
  })
  it('fills the pinned part of the brief newest first within 1,500 chars', () => {
    const long = 'x'.repeat(900)
    const r = briefPinned([
      fact({ id: 'old', pinned: true, text: long, updatedAt: '2026-10-01T00:00:00.000Z' }),
      fact({ id: 'new', pinned: true, text: long, updatedAt: '2026-10-05T00:00:00.000Z' }),
      fact({ id: 'unpinned', text: 'short' }),
      fact({ id: 'pendingPin', pinned: true, status: 'pending' })
    ])
    expect(r.included.map((f) => f.id)).toEqual(['new'])
    expect(r.overflow.map((f) => f.id)).toEqual(['old'])
  })
  it('lists key knowledge by kind, trusted first', () => {
    const k = keyKnowledge([fact({ id: 'a', kind: 'gotcha' }), fact({ id: 'b', kind: 'gotcha', actor: 'user' }), fact({ id: 'c', kind: 'fact' })])
    expect(k).toEqual([{ kind: 'gotcha', facts: [expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'a' })], total: 2 }])
  })
  it('finds recently written entities the capped overview hides', () => {
    const now = Date.parse('2026-10-16T00:00:00.000Z')
    const r = recentOffGraph(
      [
        fact({ id: '1', entityId: 'shown', createdAt: '2026-10-15T00:00:00.000Z' }),
        fact({ id: '2', entityId: 'hidden', entityName: 'auth-service', createdAt: '2026-10-15T00:00:00.000Z' }),
        fact({ id: '3', entityId: 'old', createdAt: '2026-09-01T00:00:00.000Z' })
      ],
      new Set(['shown']),
      now
    )
    expect(r).toEqual([{ id: 'hidden', name: 'auth-service' }])
  })
})

describe('memory defaults and the workflow-wide switch', () => {
  it('new agent steps read and write (LIVE.md §7), reviewer checks read; shell and command checks stay off', () => {
    expect(defaultMemoryMode(agent())).toBe('read-write')
    expect(defaultMemoryMode(check(null))).toBe('read')
    expect(defaultMemoryMode(check('npm test'))).toBeUndefined()
    expect(defaultMemoryMode(shell())).toBeUndefined()
  })
  it('sets every step at once, capping reviewer checks at read', () => {
    const nodes = applyMemoryToAll([agent(), check(null), shell()], 'read-write')
    expect(nodes.map((n) => n.memory)).toEqual(['read-write', 'read', undefined])
    expect(workflowMemoryMode(nodes)).toBe('read-write')
    expect(applyMemoryToAll(nodes, 'off').map((n) => n.memory)).toEqual([undefined, undefined, undefined])
    expect(workflowMemoryMode([agent('read'), check(null)])).toBe('mixed')
    expect(workflowMemoryMode([shell()])).toBeNull()
  })
})
