import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzy', () => {
  it('prefers prefix/substring matches over subsequences', () => {
    expect(fuzzyScore('ship', 'Ship check')).toBeGreaterThan(fuzzyScore('ship', 'something happening'))
    expect(fuzzyScore('xyz', 'Home')).toBe(-1)
    expect(fuzzyFilter(['Canvas', 'Run Build until tests pass', 'Keys'], 'btp', (s) => s)).toEqual(['Run Build until tests pass'])
    expect(fuzzyFilter(['a', 'b'], '', (s) => s)).toEqual(['a', 'b'])
  })
})
