import { describe, expect, it } from 'vitest'
import type { MarketItem } from '@shared/marketplace'
import { filterMarketItems, marketRuntime } from './marketplace'

const items: MarketItem[] = [
  { id: 'meeting', kind: 'workflow', name: 'Meeting action plan', description: 'Owners and decisions', tags: ['operations', 'meetings'], source: 'builtin', installed: true },
  { id: 'research', kind: 'skill', name: 'Customer research', description: 'Prepare a brief', tags: ['sales', 'research'], keys: ['RESEARCH_KEY'], author: 'A contributor', source: 'remote', installed: false },
  { id: 'fetch', kind: 'script', name: 'Fetch JSON', description: 'Read an API', tags: ['api'], source: 'builtin', installed: false }
]

describe('marketplace discovery', () => {
  it('combines query, kind, use case and installed state without losing remote items', () => {
    expect(filterMarketItems(items, '  MEETING decisions ', 'workflow', 'operations', true).map(i => i.id)).toEqual(['meeting'])
    expect(filterMarketItems(items, 'contributor research_key', 'skill', 'marketing', false).map(i => i.id)).toEqual(['research'])
    expect(filterMarketItems(items, '', 'all', 'research', false).map(i => i.id)).toEqual(['research', 'fetch'])
    expect(filterMarketItems(items, '', 'skill', 'all', true)).toEqual([])
  })
  it('states the current skill compatibility and distinguishes scripts from agent workflows', () => {
    expect(marketRuntime(items[1])).toBe('Claude Code')
    expect(marketRuntime(items[2])).toBe('No agent needed')
    expect(marketRuntime(items[0])).toBe('Your workspace agent')
  })
})
