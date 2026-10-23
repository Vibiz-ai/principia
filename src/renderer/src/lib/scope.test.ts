import { describe, expect, it } from 'vitest'
import type { CompanyPassport } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { VaultFact } from '@shared/passport'
import type { Run, SecretMeta, Session } from '@shared/types'
import type { Graph } from './graph'
import {
  companyOfRef,
  findHubNote,
  groupByCompany,
  hubFieldOps,
  hubFieldText,
  inScope,
  keyId,
  keySections,
  keysForCompany,
  labelGraphCompanies,
  lastRunsByCompany,
  missionLine,
  opFailures,
  overriddenShared,
  scopeAgents,
  scopeAsks,
  scopeOf,
  scopeRows,
  showChips,
  statusLine
} from './scope'

const co = (id: string, name: string, extra: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, sortOrder: 0, slug: id, color: 'var(--series-1)', system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', ...extra }) as CompanyPassport
const personal = co('co_personal', 'Personal', { system: 'personal' })
const acme = co('co_a', 'Acme')
const beta = co('co_b', 'Beta')
const all = [acme, beta, personal]

const key = (name: string, companyId: string | null = null): SecretMeta => ({ name, companyId, label: '', masked: '…', createdAt: '', updatedAt: '', lastUsedAt: null })
const agent = (id: string, p: Partial<AgentNode & { companyId?: string }> = {}): AgentNode & { companyId?: string } =>
  ({ id, kind: 'session', rootId: id, parentId: null, sessionId: null, runId: null, status: 'working', needs: null, title: id, updatedAt: '2026-10-20T10:00:00Z', ...p }) as AgentNode & { companyId?: string }
const ask = (id: string, p: Partial<Ask & { companyId?: string }> = {}): Ask & { companyId?: string } =>
  ({ id, agentId: 'x', rootId: 'x', sessionId: null, runId: null, kind: 'permission', status: 'open', title: id, question: null, createdAt: '', ...p }) as Ask & { companyId?: string }
const session = (id: string, companyId?: string): Session => ({ id, companyId, repoId: null, status: 'running' }) as Session
const run = (id: string, companyId: string | undefined, createdAt: string): Run => ({ id, companyId, createdAt }) as Run
const fact = (id: string, category: string, text: string, p: Partial<VaultFact> = {}): VaultFact =>
  ({ id: `h:${id}`, blockId: `f-${id}`, line: 0, section: 'obs', category, kind: 'fact', text, tags: [], status: 'active', supersededBy: null, pinned: false, reviewed: true, actor: 'migration', runId: null, sessionId: null, date: null, repoId: null, ...p }) as VaultFact

describe('scope filters', () => {
  it('All mode keeps every row; focused keeps the company, NULL stamps reading as Personal', () => {
    const rows = [{ id: 1, companyId: 'co_a' }, { id: 2, companyId: 'co_b' }, { id: 3 }, { id: 4, companyId: null }]
    expect(scopeRows(rows, undefined)).toHaveLength(4)
    expect(scopeRows(rows, 'co_a').map((r) => r.id)).toEqual([1])
    expect(scopeRows(rows, 'co_personal').map((r) => r.id)).toEqual([3, 4])
    expect(inScope({ companyId: 'co_b' }, 'co_a')).toBe(false)
    expect(inScope(null, undefined)).toBe(true)
    expect(scopeOf('all')).toBeUndefined()
    expect(scopeOf('co_a')).toBe('co_a')
  })

  it('shows chips only in All mode with more than Personal', () => {
    expect(showChips(all, 'all')).toBe(true)
    expect(showChips(all, 'co_a')).toBe(false)
    expect(showChips([personal], 'all')).toBe(false)
  })

  it('groups rows in rail order with unknown (archived) companies last', () => {
    const groups = groupByCompany([{ companyId: 'co_b' }, { companyId: 'co_gone' }, {}, { companyId: 'co_b' }], all)
    expect(groups.map((g) => [g.companyId, g.rows.length, !!g.company])).toEqual([
      ['co_b', 2, true],
      ['co_personal', 1, true],
      ['co_gone', 1, false]
    ])
    expect(groupByCompany([], all, { keepEmpty: true })).toHaveLength(3)
  })
})

describe('live agents and asks per company', () => {
  const sessions = [session('s_a', 'co_a'), session('s_b', 'co_b')]
  const agents = [
    agent('ra', { companyId: 'co_a' }),
    agent('sub', { kind: 'subagent', rootId: 'ra', parentId: 'ra' }),
    agent('rb', { sessionId: 's_b' }),
    agent('rp')
  ]
  it('a subagent follows its root; an unstamped root its session; the rest is Personal', () => {
    expect(scopeAgents(agents, sessions, 'co_a').map((a) => a.id)).toEqual(['ra', 'sub'])
    expect(scopeAgents(agents, sessions, 'co_b').map((a) => a.id)).toEqual(['rb'])
    expect(scopeAgents(agents, sessions, 'co_personal').map((a) => a.id)).toEqual(['rp'])
    expect(scopeAgents(agents, sessions, undefined)).toHaveLength(4)
  })
  it('asks use their stamp, else their agent, else their session', () => {
    const asks = [ask('q1', { companyId: 'co_b', agentId: 'ra' }), ask('q2', { agentId: 'sub', rootId: 'ra' }), ask('q3', { agentId: 'gone', rootId: 'gone', sessionId: 's_b' })]
    expect(scopeAsks(asks, agents, sessions, 'co_a').map((q) => q.id)).toEqual(['q2'])
    expect(scopeAsks(asks, agents, sessions, 'co_b').map((q) => q.id)).toEqual(['q1', 'q3'])
  })
})

describe('keys (§4)', () => {
  const list = [key('OPENAI_API_KEY'), key('STRIPE_KEY'), key('STRIPE_KEY', 'co_a'), key('ACME_ONLY', 'co_a'), key('BETA_ONLY', 'co_b')]

  it('a Personal-only user sees one flat list', () => {
    const s = keySections(list, 'all', [personal])
    expect(s).toHaveLength(1)
    expect(s[0]!.title).toBeNull()
  })
  it('focused: This company, then Shared; never another company', () => {
    const s = keySections(list.filter((k) => !k.companyId || k.companyId === 'co_a'), 'co_a', all)
    expect(s.map((x) => [x.title, x.companyId, x.keys.map((k) => k.name)])).toEqual([
      ['This company', 'co_a', ['ACME_ONLY', 'STRIPE_KEY']],
      ['Shared', null, ['OPENAI_API_KEY', 'STRIPE_KEY']]
    ])
    // even if main returned too much, a focused section only holds its own company's keys
    expect(keySections(list, 'co_a', all)[0]!.keys.some((k) => k.name === 'BETA_ONLY')).toBe(false)
  })
  it('All mode: Shared, then one section per company with keys', () => {
    const s = keySections(list, 'all', all)
    expect(s.map((x) => [x.key, x.keys.length])).toEqual([
      ['shared', 2],
      ['co_a', 2],
      ['co_b', 1]
    ])
    expect(s[1]!.company?.name).toBe('Acme')
  })
  it('a company key overrides the shared one of the same name, for that company only', () => {
    expect([...overriddenShared(list, 'co_a')]).toEqual(['STRIPE_KEY'])
    expect(overriddenShared(list, 'co_b').size).toBe(0)
    expect(overriddenShared(list, null).size).toBe(0)
    const a = keysForCompany(list, 'co_a')
    expect(a.map((k) => `${k.name}:${k.companyId ?? 'shared'}`).sort()).toEqual(['ACME_ONLY:co_a', 'OPENAI_API_KEY:shared', 'STRIPE_KEY:co_a'])
    expect(keysForCompany(list, 'co_personal').map((k) => k.name).sort()).toEqual(['OPENAI_API_KEY', 'STRIPE_KEY'])
    expect(keyId(key('X', 'co_a'))).not.toBe(keyId(key('X')))
  })
})

describe('portfolio lines', () => {
  it('keeps the newest n runs per company', () => {
    const runs = [run('r1', 'co_a', '2026-10-01'), run('r2', 'co_a', '2026-10-03'), run('r3', undefined, '2026-10-02'), run('r4', 'co_a', '2026-10-02'), run('r5', 'co_a', '2026-09-01')]
    const by = lastRunsByCompany(runs, 3)
    expect(by.co_a!.map((r) => r.id)).toEqual(['r2', 'r4', 'r1'])
    expect(by.co_personal!.map((r) => r.id)).toEqual(['r3'])
  })
  it('status and mission lines', () => {
    expect(statusLine({ needsYou: 2, working: 3 })).toBe('2 need you · 3 working')
    expect(statusLine({ needsYou: 1, working: 0 })).toBe('1 needs you')
    expect(statusLine(undefined)).toBe('Quiet')
    expect(missionLine('\n  Build tools for bakers.\nSecond line')).toBe('Build tools for bakers.')
    expect(missionLine('x'.repeat(200), 10)).toHaveLength(10)
  })
})

describe('Canvas company labels', () => {
  const lookups = { sessions: [session('s1', 'co_a')], runs: [run('r1', 'co_b', '')], schedules: [{ id: 'sch', companyId: undefined }] }
  it('resolves session, run, step and schedule nodes; repo lanes have no company', () => {
    expect(companyOfRef({ kind: 'session', sessionId: 's1' }, lookups)).toBe('co_a')
    expect(companyOfRef({ kind: 'step', runId: 'r1', nodeId: 'n', stepId: null }, lookups)).toBe('co_b')
    expect(companyOfRef({ kind: 'schedule', scheduleId: 'sch' }, lookups)).toBe('co_personal')
    expect(companyOfRef({ kind: 'repo', repoId: null }, lookups)).toBeNull()
    expect(companyOfRef({ kind: 'session', sessionId: 'nope' }, lookups)).toBeNull()
  })
  it('prefixes top-level cards and lanes, leaves nested agents alone', () => {
    const graph = {
      width: 0,
      height: 0,
      edges: [],
      nodes: [
        { id: 'a', type: 'card', position: { x: 0, y: 0 }, data: { label: 'A', sub: 'claude', status: 'running', adapter: null, ref: { kind: 'session', sessionId: 's1' } } },
        { id: 'b', type: 'card', position: { x: 0, y: 0 }, data: { label: 'B', sub: 'sub', status: 'running', adapter: null, nestedAgent: true, ref: { kind: 'session', sessionId: 's1' } } },
        { id: 'f', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Lane', width: 1, height: 1, status: null, ref: { kind: 'run', runId: 'r1' } } }
      ]
    } as unknown as Graph
    const out = labelGraphCompanies(graph, lookups, (id) => (id === 'co_a' ? 'Acme' : 'Beta'))
    expect(out.nodes.map((n) => (n.type === 'card' ? n.data.sub : n.data.meta))).toEqual(['Acme · claude', 'sub', 'Beta'])
    const none = { ...graph, nodes: [] }
    expect(labelGraphCompanies(none, lookups, () => 'x')).toBe(none)
  })
})

describe('Company settings: profile fields in the hub note', () => {
  const facts = [fact('m1', 'mission', 'Bake better.', { line: 3 }), fact('p1', 'product', 'Ovens', { line: 5 }), fact('p2', 'product', 'Mixers', { line: 6 }), fact('old', 'mission', 'Old', { status: 'superseded', line: 9 }), fact('h', 'mission', 'Hist', { section: 'history', line: 12 })]
  it('reads active observations of the field, in file order', () => {
    expect(hubFieldText(facts, 'mission')).toBe('Bake better.')
    expect(hubFieldText(facts, 'products')).toBe('Ovens\nMixers')
    expect(hubFieldText(facts, 'goals')).toBe('')
  })
  it('no change, no ops', () => {
    expect(hubFieldOps(facts, 'mission', '  Bake better. ', 'Acme')).toEqual([])
  })
  it('supersedes the first line and invalidates the rest', () => {
    expect(hubFieldOps(facts, 'products', 'Ovens and mixers', 'Acme')).toEqual([
      { op: 'supersede', blockId: 'f-p1', text: 'Ovens and mixers' },
      { op: 'invalidate', blockId: 'f-p2', reason: 'Removed in Company settings' }
    ])
  })
  it('works line by line: an unchanged line keeps its observation, a changed one is superseded', () => {
    // editing the second of two lines never folds both into one observation (a newline is not part of the grammar)
    expect(hubFieldOps(facts, 'products', 'Ovens\nStand mixers', 'Acme')).toEqual([{ op: 'supersede', blockId: 'f-p2', text: 'Stand mixers' }])
    expect(hubFieldOps(facts, 'products', 'Mixers\n\n  Ovens  ', 'Acme')).toEqual([])
    expect(hubFieldOps(facts, 'products', 'Ovens\nMixers\nTimers', 'Acme')).toEqual([{ op: 'observe', note: 'Acme', category: 'product', text: 'Timers' }])
    expect(hubFieldOps(facts, 'products', 'Mixers', 'Acme')).toEqual([{ op: 'invalidate', blockId: 'f-p1', reason: 'Removed in Company settings' }])
    expect(hubFieldOps(facts, 'goals', 'Ship v2\nHire', 'Acme')).toEqual([
      { op: 'observe', note: 'Acme', category: 'goal', text: 'Ship v2' },
      { op: 'observe', note: 'Acme', category: 'goal', text: 'Hire' }
    ])
  })
  it('a new field observes; a cleared field invalidates; soft keys stand in for missing block ids', () => {
    expect(hubFieldOps(facts, 'goals', 'Ship v2', 'Acme')).toEqual([{ op: 'observe', note: 'Acme', category: 'goal', text: 'Ship v2' }])
    expect(hubFieldOps([fact('x', 'brand', 'Warm', { blockId: null })], 'brandVoice', '', 'Acme')).toEqual([{ op: 'invalidate', blockId: 'h:x', reason: 'Cleared in Company settings' }])
  })
})

describe('Company settings: hub note lookup and write results', () => {
  const e = (path: string, title: string, type = 'company', status = 'active') => ({ path, title, type, status })
  it('finds the root-level company note, preferring the company name, whatever its file is called', () => {
    expect(findHubNote([e('Repos/Acme.md', 'Acme', 'repo'), e('Acme Inc.md', 'Acme Inc'), e('Acme.md', 'acme')], 'Acme')?.path).toBe('Acme.md')
    // renamed company: the hub keeps its old title and path
    expect(findHubNote([e('People/Ann.md', 'Ann', 'person'), e('Old Name.md', 'Old Name')], 'New Name')?.path).toBe('Old Name.md')
    expect(findHubNote([e('Acme.md', 'Acme', 'company', 'archived'), e('Sub/Acme.md', 'Acme')], 'Acme')).toBeNull()
    expect(findHubNote([], 'Acme')).toBeNull()
  })
  it('reports conflicts and errors, not ok / noop', () => {
    expect(opFailures([{ status: 'ok', reason: null }, { status: 'noop', reason: null }])).toBeNull()
    expect(opFailures([{ status: 'ok', reason: null }, { status: 'conflict', reason: 'line changed' }, { status: 'error', reason: 'line changed' }])).toBe(
      '2 changes could not be saved: line changed. Reopen Company settings and try again.'
    )
  })
})
