import { describe, expect, it } from 'vitest'
import { DEPARTMENT_PRESET_KEYS } from './company'
import { PLAN_AGENT_ROLES } from './onboarding'
import {
  BUST_BEARDS,
  BUST_DRAPES,
  BUST_HAIRS,
  BUST_MATERIALS,
  DEPT_POOLS,
  LAUREL_ALWAYS,
  NO_DEPT_POOL,
  PERSONAS,
  PERSONA_LIMITS,
  ROLE_POOLS,
  lookFor,
  personaDef,
  pickPersona,
  resolvePersonas,
  storedPersona,
  usedPersonaNames,
  type AgentPersona,
  type PersonaAgentLike
} from './personas'

const none = new Set<string>()

describe('PERSONAS', () => {
  it('has 30 unique keys and names within the limits', () => {
    expect(PERSONAS).toHaveLength(30)
    expect(new Set(PERSONAS.map((p) => p.key)).size).toBe(30)
    expect(new Set(PERSONAS.map((p) => p.name.toLowerCase())).size).toBe(30)
    for (const p of PERSONAS) {
      expect(p.key.length).toBeLessThanOrEqual(PERSONA_LIMITS.key)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.name.length).toBeLessThanOrEqual(PERSONA_LIMITS.name)
      expect(p.personality.length).toBeLessThanOrEqual(PERSONA_LIMITS.personality)
      expect(p.bio.length).toBeLessThanOrEqual(PERSONA_LIMITS.bio)
      expect(BUST_HAIRS).toContain(p.base.hair)
      expect(BUST_BEARDS).toContain(p.base.beard)
      for (const d of p.depts) expect(DEPARTMENT_PRESET_KEYS).toContain(d)
      for (const r of p.roles) expect(PLAN_AGENT_ROLES).toContain(r)
    }
  })
  it('excludes the loaded names', () => {
    for (const n of ['Nero', 'Caligula', 'Commodus', 'Brutus', 'Cassius', 'Caesar', 'Augustus', 'Spartacus', 'Romulus']) {
      expect(PERSONAS.some((p) => p.name === n)).toBe(false)
    }
  })
  it('pools only reference curated keys and cover every department and role', () => {
    for (const k of DEPARTMENT_PRESET_KEYS) expect(DEPT_POOLS[k].length).toBeGreaterThan(0)
    for (const r of PLAN_AGENT_ROLES) expect(ROLE_POOLS[r].length).toBeGreaterThan(0)
    const all = [...Object.values(DEPT_POOLS).flat(), ...Object.values(ROLE_POOLS).flat(), ...NO_DEPT_POOL, ...LAUREL_ALWAYS]
    for (const k of all) expect(personaDef(k), k).toBeDefined()
  })
})

describe('pickPersona', () => {
  it('first marketing pick is Marcus, then Ovid', () => {
    const used = new Set<string>()
    const a = pickPersona({ departmentKey: 'marketing', used, seed: 'co:1' })
    expect(a.name).toBe('Marcus')
    used.add(a.name)
    expect(pickPersona({ departmentKey: 'marketing', used, seed: 'co:2' }).name).toBe('Ovid')
  })
  it('first developer is Livia; builder is Vitruvius', () => {
    expect(pickPersona({ departmentKey: 'development', role: 'developer', used: none, seed: 's' }).name).toBe('Livia')
    expect(pickPersona({ departmentKey: 'development', used: none, seed: 's' }).name).toBe('Livia')
    expect(pickPersona({ departmentKey: 'development', role: 'builder', used: none, seed: 's' }).name).toBe('Vitruvius')
    expect(pickPersona({ departmentKey: 'marketing', role: 'builder', used: none, seed: 's' }).name).toBe('Vitruvius')
  })
  it('role pool comes before the department pool, then the full list', () => {
    expect(pickPersona({ departmentKey: 'marketing', role: 'researcher', used: none, seed: 's' }).name).toBe('Pliny')
    expect(pickPersona({ departmentKey: null, used: none, seed: 's' }).name).toBe('Junia')
    const used = new Set(['junia', 'seneca', 'pliny'])
    expect(pickPersona({ departmentKey: null, used, seed: 's' }).name).toBe('Livia')
  })
  it('compares used names case-insensitively', () => {
    expect(pickPersona({ departmentKey: 'marketing', used: new Set(['MARCUS']), seed: 's' }).name).toBe('Ovid')
    expect(pickPersona({ departmentKey: 'marketing', used: new Set(['  marcus ']), seed: 's' }).name).toBe('Ovid')
  })
  it('never returns a duplicate within a used set, then numbers the department default', () => {
    const used = new Set<string>()
    const names: string[] = []
    for (let i = 0; i < 33; i++) {
      const p = pickPersona({ departmentKey: 'marketing', role: 'content', used, seed: `co:${i}` })
      expect(used.has(p.name.toLowerCase())).toBe(false)
      used.add(p.name.toLowerCase())
      names.push(p.name)
    }
    expect(new Set(names).size).toBe(33)
    expect(names.slice(30)).toEqual(['Marcus II', 'Marcus III', 'Marcus IV'])
  })
  it('exhaustion gives Marcus II for marketing and keeps the curated key', () => {
    const used = new Set(PERSONAS.map((p) => p.name))
    const p = pickPersona({ departmentKey: 'marketing', used, seed: 's' })
    expect(p.name).toBe('Marcus II')
    expect(p.key).toBe('marcus')
    expect(pickPersona({ departmentKey: 'development', used, seed: 's' }).name).toBe('Livia II')
    expect(pickPersona({ departmentKey: null, used, seed: 's' }).name).toBe('Junia II')
  })
  it('is pure and deterministic', () => {
    const used = new Set(['Marcus'])
    const a = pickPersona({ departmentKey: 'marketing', used, seed: 'co_9:copy' })
    const b = pickPersona({ departmentKey: 'marketing', used, seed: 'co_9:copy' })
    expect(a).toEqual(b)
    expect([...used]).toEqual(['Marcus'])
  })
  it('copies the curated text and stays inside the limits', () => {
    const p: AgentPersona = pickPersona({ departmentKey: 'support', used: none, seed: 'x' })
    const def = personaDef('cato')!
    expect(p).toMatchObject({ key: 'cato', name: 'Cato', personality: def.personality, bio: def.bio })
  })
})

describe('lookFor', () => {
  it('is stable for the same seed and keeps the curated hair and beard', () => {
    const def = personaDef('ovid')!
    expect(lookFor(def, 'co_1:ovid')).toEqual(lookFor(def, 'co_1:ovid'))
    for (let i = 0; i < 50; i++) {
      const l = lookFor(def, `co:${i}`)
      expect(l.hair).toBe('curls')
      expect(l.beard).toBe('none')
      expect(BUST_MATERIALS).toContain(l.material)
      expect(BUST_DRAPES).toContain(l.drape)
    }
  })
  it('never drapes a bust in its own colour', () => {
    const def = personaDef('julia')!
    for (let i = 0; i < 400; i++) {
      const l = lookFor(def, `seed-${i}`)
      if (l.material === 'marble') expect(l.drape).not.toBe('marble')
      if (l.material === 'terracotta') expect(l.drape).not.toBe('terracotta')
      // #e9e3d8 on #e8dfcf would vanish, worst at the 16 px mini size
      if (l.material === 'travertine') expect(l.drape).not.toBe('marble')
    }
  })
  it('still uses every drape, and the other materials keep the marble drape', () => {
    const def = personaDef('julia')!
    const looks = Array.from({ length: 400 }, (_, i) => lookFor(def, `seed-${i}`))
    expect(new Set(looks.map((l) => l.drape)).size).toBe(4)
    expect(looks.some((l) => l.material === 'bronze' && l.drape === 'marble')).toBe(true)
  })
  it('the brand faces always wear a laurel; others vary', () => {
    for (const k of ['marcus', 'livia', 'aurelia', 'cato', 'seneca']) {
      for (let i = 0; i < 20; i++) expect(lookFor(personaDef(k)!, `s${i}`).laurel).toBe(true)
    }
    const ovid = personaDef('ovid')!
    const laurels = new Set(Array.from({ length: 60 }, (_, i) => lookFor(ovid, `s${i}`).laurel))
    expect(laurels).toEqual(new Set([true, false]))
  })
  it('spreads materials across seeds', () => {
    const def = personaDef('felix')!
    const mats = new Set(Array.from({ length: 100 }, (_, i) => lookFor(def, `co:${i}`).material))
    expect(mats.size).toBe(4)
  })
})

describe('resolvePersonas and usedPersonaNames (shared with main)', () => {
  const ag = (id: string, over: Partial<PersonaAgentLike> = {}): PersonaAgentLike => ({
    id, companyId: 'co_1', departmentId: 'd_mkt', name: 'Copywriter', archivedAt: null, createdAt: `2026-01-01T00:00:0${id.slice(-1)}Z`, data: {}, ...over
  })
  const depts = [{ id: 'd_mkt', key: 'marketing' }]

  it('never crashes on legacy agents with missing or odd data', () => {
    const odd: PersonaAgentLike[] = [
      ag('a1', { data: undefined }),
      ag('a2', { data: null as unknown as object }),
      ag('a3', { data: 'oops' as unknown as object }),
      ag('a4', { data: { persona: 42 } }),
      ag('a5', { data: { persona: { name: 'X', key: 'x', personality: '', bio: '', look: { material: 'gold' } } } }),
      ag('a6', { createdAt: undefined as unknown as string, departmentId: 'd_gone' })
    ]
    const map = resolvePersonas(odd, depts)
    expect(map.size).toBe(6)
    expect(new Set([...map.values()].map((p) => p.name)).size).toBe(6)
    expect(storedPersona(null)).toBeNull()
    expect(storedPersona(undefined)).toBeNull()
    expect(storedPersona({ data: null })).toBeNull()
  })
  it('reserves the names legacy agents display, so a new agent never takes one', () => {
    const legacy = [ag('a1'), ag('a2')]
    const used = usedPersonaNames('co_1', legacy, depts)
    expect(used).toEqual(new Set(['marcus', 'ovid']))
    const next = pickPersona({ departmentKey: 'marketing', used, seed: 'co_1:a3' })
    expect(next.name).toBe('Flavia')
    // once stored, the legacy agents keep the names they were shown with
    const after = resolvePersonas([...legacy, ag('a3', { data: { persona: next } })], depts)
    expect([after.get('a1')?.name, after.get('a2')?.name, after.get('a3')?.name]).toEqual(['Marcus', 'Ovid', 'Flavia'])
  })
  it('ignores other companies and archived agents', () => {
    const list = [ag('a1', { companyId: 'co_2' }), ag('a2', { archivedAt: '2026-02-01T00:00:00Z' })]
    expect(usedPersonaNames('co_1', list, depts)).toEqual(new Set())
  })
  it('treats prototype-ish department keys as custom', () => {
    const a = ag('a1', { departmentId: 'd_x' })
    expect(resolvePersonas([a], [{ id: 'd_x', key: 'constructor' }]).get('a1')?.name).toBe('Junia')
  })
})
