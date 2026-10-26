import { describe, expect, it } from 'vitest'
import { findTeammate, teammateLine, type Teammate } from './roster'

const mate = (handle: string, name: string, role: string, department: string | null, id = handle): Teammate => ({ memberId: `m_${id}`, agentId: `a_${id}`, handle, name, role, department })
const roster = [
  mate('marcus', 'Marcus', 'Brand Voice Writer', 'Marketing'),
  mate('livia', 'Livia', 'Developer', 'Development'),
  mate('julia', 'Julia', 'Developer', 'Development'),
  mate('pliny', 'Pliny', 'Ad Strategist', 'Ads')
]
const who = (raw: string) => findTeammate(roster, raw)?.handle ?? null

describe('roster: a teammate from what an agent wrote', () => {
  it('reads a handle, a name, a role, or a mix of them', () => {
    expect(who('@marcus')).toBe('marcus')
    expect(who('Marcus')).toBe('marcus')
    expect(who('marcus')).toBe('marcus')
    expect(who('Brand Voice Writer')).toBe('marcus')
    expect(who('Marcus, Brand Voice Writer')).toBe('marcus')
    expect(who('Marcus (Brand Voice Writer, Marketing)')).toBe('marcus')
    expect(who('Marcus Brand Voice Writer')).toBe('marcus')
    expect(who('Livia, Developer')).toBe('livia')
    expect(who('Pliny - Ad Strategist')).toBe('pliny')
  })

  it('never guesses: an unknown name, a shared role, a part that fits someone else, a department alone', () => {
    expect(who('Cicero')).toBeNull()
    expect(who('Developer')).toBeNull()
    expect(who('Marcus, Developer')).toBeNull()
    expect(who('Marketing')).toBeNull()
    expect(who('')).toBeNull()
  })

  it('writes one line per teammate for the context', () => {
    expect(teammateLine(roster[0]!)).toBe('@marcus (Brand Voice Writer, Marketing)')
    expect(teammateLine(mate('mv', 'Marcus Varro', 'Writer', null))).toBe('@mv Marcus Varro (Writer)')
  })
})
