import { describe, expect, it } from 'vitest'
import { resolvePersonas, type AgentPersona } from '@shared/personas'
import { editedPersona, personaNameError, personasToFreeze } from './personaRename'

const row = (id: string, p: { companyId?: string; archivedAt?: string | null } = {}) => ({ id, companyId: p.companyId ?? 'co_a', archivedAt: p.archivedAt ?? null })
const persona = (name: string): AgentPersona => ({ key: 'custom', name, personality: 'Writes fast.', bio: 'Bio.', look: { material: 'marble', hair: 'crop', beard: 'none', laurel: false, drape: 'purple' } })

describe('personaNameError', () => {
  const me = row('a1')
  const agents = [me, row('a2'), row('a3', { archivedAt: '2026-10-01T00:00:00Z' }), row('b1', { companyId: 'co_b' })]
  const personas = new Map([['a1', persona('Marcus')], ['a2', persona('Ovid')], ['a3', persona('Flavia')], ['b1', persona('Cato')]])

  it('accepts 1 to 24 characters after trimming, including the current name in another case', () => {
    expect(personaNameError('  Gaius ', me, agents, personas)).toBeNull()
    expect(personaNameError('marcus', me, agents, personas)).toBeNull()
    expect(personaNameError('x'.repeat(24), me, agents, personas)).toBeNull()
  })
  it('rejects empty and over-long names', () => {
    expect(personaNameError('   ', me, agents, personas)).toBe('Enter a name.')
    expect(personaNameError('x'.repeat(25), me, agents, personas)).toMatch(/24 characters/)
  })
  it('rejects a name another active agent of the company is shown with, case-insensitively', () => {
    expect(personaNameError('OVID', me, agents, personas)).toBe('Another agent in this company is already called Ovid. Pick another name.')
  })
  it('ignores archived agents and other companies', () => {
    expect(personaNameError('Flavia', me, agents, personas)).toBeNull()
    expect(personaNameError('Cato', me, agents, personas)).toBeNull()
  })
})

describe('editedPersona', () => {
  it('keeps the look and the rest, trims the new name and caps the bio', () => {
    const p = persona('Marcus')
    expect(editedPersona(p, { name: ' Gaius ' })).toEqual({ ...p, name: 'Gaius' })
    expect(editedPersona(p, { bio: ` ${'b'.repeat(500)}` }).bio).toHaveLength(400)
    expect(editedPersona(p, {}).look).toBe(p.look)
  })
})

describe('personasToFreeze', () => {
  const legacy = (id: string, createdAt: string, extra: { archivedAt?: string | null; data?: unknown; companyId?: string } = {}) => ({
    id, companyId: extra.companyId ?? 'co_a', departmentId: 'dep_m', name: 'Copywriter', archivedAt: extra.archivedAt ?? null, createdAt, data: extra.data ?? {}
  })
  const deps = [{ id: 'dep_m', key: 'marketing' }]

  it('renaming a legacy agent stores the shown persona of a legacy sibling that would otherwise be renamed', () => {
    const agents = [legacy('a1', '2026-01-01'), legacy('a2', '2026-01-02'), legacy('b1', '2026-01-01', { companyId: 'co_b' })]
    const before = resolvePersonas(agents, deps)
    expect(before.get('a1')!.name).toBe('Marcus')
    const next = editedPersona(before.get('a1')!, { name: 'Bob' })
    const frozen = personasToFreeze('a1', next, agents, deps)
    expect(frozen.map((f) => f.agent.id)).toEqual(['a2'])
    expect(frozen[0]!.persona).toEqual(before.get('a2'))
    // after storing both, nobody else changed name or face
    const stored = agents.map((a) => (a.id === 'a1' ? { ...a, data: { persona: next } } : a.id === 'a2' ? { ...a, data: { persona: frozen[0]!.persona } } : a))
    const after = resolvePersonas(stored, deps)
    expect(after.get('a2')).toEqual(before.get('a2'))
    expect(after.get('b1')).toEqual(before.get('b1'))
  })
  it('freezes nothing when the name stays taken (a bio edit) or the others are stored, and skips archived agents', () => {
    const agents = [legacy('a1', '2026-01-01'), legacy('a2', '2026-01-02'), legacy('a3', '2026-01-03', { archivedAt: '2026-02-01' })]
    const p = resolvePersonas(agents, deps).get('a1')!
    expect(personasToFreeze('a1', editedPersona(p, { bio: 'New bio.' }), agents, deps)).toEqual([])
    const allStored = agents.map((a) => ({ ...a, data: { persona: resolvePersonas(agents, deps).get(a.id) } }))
    expect(personasToFreeze('a1', editedPersona(p, { name: 'Bob' }), allStored, deps)).toEqual([])
    expect(personasToFreeze('missing', p, agents, deps)).toEqual([])
  })
})
