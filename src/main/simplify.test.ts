import { describe, expect, it } from 'vitest'
import { retiredFlagsPatch } from './simplify'

describe('retiredFlagsPatch', () => {
  it('turns departments and plans off and keeps every other flag', () => {
    expect(retiredFlagsPatch({ companies: true, departments: true, vault: true, plans: true, vaultAI: false })).toEqual({ companies: true, departments: false, vault: true, plans: false, vaultAI: false })
  })
  it('is null when nothing retired is on', () => {
    expect(retiredFlagsPatch({ companies: true, vault: true, departments: false })).toBeNull()
    expect(retiredFlagsPatch({})).toBeNull()
    expect(retiredFlagsPatch(null)).toBeNull()
  })
})
