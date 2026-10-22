import { describe, expect, it } from 'vitest'
import { AGENT_DATA_DEFAULTS, type CompanyAgent, type Department } from '@shared/company'
import { lookFor, personaDef, type AgentPersona } from '@shared/personas'
import { displayName, personaFor, personasOf, resolvePersonas, storedPersona } from './personaView'

let n = 0
function agent(over: Partial<CompanyAgent> & { persona?: AgentPersona | Record<string, unknown> } = {}): CompanyAgent {
  n++
  const { persona, ...rest } = over
  return {
    id: `ag_${String(n).padStart(3, '0')}`,
    companyId: 'co_1',
    departmentId: null,
    kind: 'profile',
    refId: 'p1',
    name: 'Copywriter',
    archivedAt: null,
    pausedAt: null,
    createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-10-01T00:00:00.000Z',
    data: { ...AGENT_DATA_DEFAULTS, ...(persona ? { persona } : {}) } as CompanyAgent['data'],
    ...rest
  }
}
const dept = (id: string, key: string, companyId = 'co_1'): Department =>
  ({ id, companyId, key, name: key, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} as Department['data'] })

const stored = (name: string, key = 'custom'): AgentPersona => ({ key, name, personality: 'p', bio: 'b', look: lookFor(personaDef('ovid')!, 'x') })

describe('resolvePersonas', () => {
  it('assigns in createdAt order per department pool, with no duplicates', () => {
    const depts = [dept('d_mkt', 'marketing'), dept('d_dev', 'development')]
    const a1 = agent({ departmentId: 'd_mkt', createdAt: '2026-01-01T00:00:00Z' })
    const a2 = agent({ departmentId: 'd_mkt', createdAt: '2026-01-02T00:00:00Z' })
    const a3 = agent({ departmentId: 'd_dev', createdAt: '2026-01-03T00:00:00Z' })
    const map = resolvePersonas([a3, a2, a1], depts)
    expect(map.get(a1.id)?.name).toBe('Marcus')
    expect(map.get(a2.id)?.name).toBe('Ovid')
    expect(map.get(a3.id)?.name).toBe('Livia')
  })
  it('stored personas win and reserve their names', () => {
    const depts = [dept('d_mkt', 'marketing')]
    const early = agent({ departmentId: 'd_mkt', createdAt: '2026-01-01T00:00:00Z' })
    const late = agent({ departmentId: 'd_mkt', createdAt: '2026-01-05T00:00:00Z', persona: stored('Marcus', 'marcus') })
    const map = resolvePersonas([early, late], depts)
    expect(map.get(late.id)?.name).toBe('Marcus')
    expect(map.get(late.id)?.personality).toBe('p')
    expect(map.get(early.id)?.name).toBe('Ovid')
  })
  it('never duplicates names among non-archived agents, even across many agents', () => {
    const depts = [dept('d_mkt', 'marketing')]
    const list = Array.from({ length: 40 }, (_, i) => agent({ departmentId: 'd_mkt', createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` }))
    const names = list.map((a) => resolvePersonas(list, depts).get(a.id)!.name.toLowerCase())
    expect(new Set(names).size).toBe(40)
    expect(names).toContain('marcus ii')
  })
  it('re-resolves a later stored duplicate and drops malformed stored personas', () => {
    const a = agent({ createdAt: '2026-01-01T00:00:00Z', persona: stored('Ada') })
    const b = agent({ createdAt: '2026-01-02T00:00:00Z', persona: stored('ada') })
    const c = agent({ createdAt: '2026-01-03T00:00:00Z', persona: { name: 'Broken' } })
    const map = resolvePersonas([a, b, c])
    expect(map.get(a.id)?.name).toBe('Ada')
    expect(map.get(b.id)?.name).toBe('Junia')
    expect(map.get(c.id)?.name).toBe('Seneca')
    expect(storedPersona(c)).toBeNull()
  })
  it('companies are independent', () => {
    const depts = [dept('d1', 'marketing'), dept('d2', 'marketing', 'co_2')]
    const x = agent({ departmentId: 'd1' })
    const y = agent({ companyId: 'co_2', departmentId: 'd2' })
    const map = resolvePersonas([x, y], depts)
    expect(map.get(x.id)?.name).toBe('Marcus')
    expect(map.get(y.id)?.name).toBe('Marcus')
  })
  it('archived agents do not reserve names', () => {
    const depts = [dept('d_mkt', 'marketing')]
    const gone = agent({ departmentId: 'd_mkt', createdAt: '2026-01-01T00:00:00Z', archivedAt: '2026-02-01T00:00:00Z', persona: stored('Marcus', 'marcus') })
    const live = agent({ departmentId: 'd_mkt', createdAt: '2026-01-02T00:00:00Z' })
    const map = resolvePersonas([gone, live], depts)
    expect(map.get(gone.id)?.name).toBe('Marcus')
    expect(map.get(live.id)?.name).toBe('Marcus')
  })
  it('custom department keys use the no-department pool; output is deterministic', () => {
    const depts = [dept('d_x', 'research-lab')]
    const a = agent({ departmentId: 'd_x' })
    expect(resolvePersonas([a], depts).get(a.id)?.name).toBe('Junia')
    expect(resolvePersonas([a], depts).get(a.id)).toEqual(resolvePersonas([a], depts).get(a.id))
  })
})

describe('displayName and personaFor', () => {
  it('shows persona and role with personas on, the role label with them off', () => {
    const a = agent({ name: 'Copywriter', persona: stored('Marcus', 'marcus') })
    const map = resolvePersonas([a])
    expect(displayName(a, map, true)).toMatchObject({ name: 'Marcus', role: 'Copywriter' })
    expect(displayName(a, map, false)).toEqual({ name: 'Copywriter', role: '', persona: null })
    expect(displayName(agent({ name: 'Ghost' }), map, true)).toEqual({ name: 'Ghost', role: '', persona: null })
  })
  it('personaFor reads a snapshot and memoizes on slice identity', () => {
    const a = agent()
    const src = { companyAgents: [a], departments: [] as Department[] }
    expect(personaFor(a.id, src)?.name).toBe('Junia')
    expect(personaFor('nope', src)).toBeNull()
    expect(personasOf(src)).toBe(personasOf({ ...src }))
    expect(personasOf(src)).not.toBe(personasOf({ companyAgents: [a], departments: [] }))
  })
})
