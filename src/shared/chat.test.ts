import { describe, expect, it } from 'vitest'
import { slashMatches, slashQuery } from './chat'

const c = (name: string): { name: string } => ({ name })

describe('slash menu', () => {
  it('lists names that start with the query first, then the shortest', () => {
    expect(slashMatches([c('extra-usage'), c('usage-credits'), c('usage'), c('compact')], 'usa').map((x) => x.name)).toEqual(['usage', 'usage-credits', 'extra-usage'])
  })
  it('hides internal commands', () => {
    expect(slashMatches([c('__remote-workflow'), c('usage')], '').map((x) => x.name)).toEqual(['usage'])
  })
  it('opens only while the draft is a command name', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/use')).toBe('use')
    expect(slashQuery('/usage now')).toBeNull()
    expect(slashQuery('hello /usage')).toBeNull()
  })
})
