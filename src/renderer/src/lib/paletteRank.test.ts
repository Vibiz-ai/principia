import { describe, expect, it } from 'vitest'
import { rankPalette, type Rankable } from './paletteRank'
import { goToEntries } from './nav'

const goTo: (Rankable & { id: string })[] = goToEntries(() => true).map((g) => ({ id: g.id, label: g.label, group: 'Go to', keywords: g.keywords, exact: g.exact }))
const pauseAll = { id: 'a:pause', label: 'Pause Schedules in All Companies…', group: 'Actions', global: true }
const newSch = { id: 'a:newSch', label: 'New Schedule', group: 'Actions' }
const items = [pauseAll, newSch, ...goTo]

describe('palette ranking', () => {
  it('an old nav word lands on its new door, never on a global action ("schedules" → Automations)', () => {
    expect(rankPalette(items, 'schedules')[0]!.id).toBe('v:automations')
    expect(rankPalette(items, 'Schedules')[0]!.id).toBe('v:automations')
    expect(rankPalette(items, 'canvas')[0]!.id).toBe('v:activity')
    expect(rankPalette(items, 'passport')[0]!.id).toBe('v:knowledge')
    expect(rankPalette(items, 'usage')[0]!.id).toBe('v:spend')
  })

  it('an action that touches every company is never the top hit while anything else matches', () => {
    const r = rankPalette(items, 'pause')
    expect(r.map((x) => x.id)).toContain('a:pause')
    // the only match still lists (and asks before it runs)
    expect(rankPalette([pauseAll], 'pause')[0]!.id).toBe('a:pause')
    expect(rankPalette(items, 'pause sched').at(-1)?.id).toBe('a:pause')
  })

  it('empty query keeps the given order; no match is left out', () => {
    expect(rankPalette(items, '').map((x) => x.id)).toEqual(items.map((x) => x.id).slice(0, 60))
    expect(rankPalette(items, 'zzzzqx')).toEqual([])
  })
})

describe('palette synonyms (design §9)', () => {
  it('"api key" finds both Keys & secrets and AI providers; "connections" and "linear" find their pages', () => {
    const top = (q: string, n = 2): string[] => rankPalette(goTo, q).slice(0, n).map((x) => x.id)
    expect(top('api key')).toEqual(['v:set:keys', 'v:set:agents'])
    expect(top('connections', 1)).toEqual(['v:set:connections'])
    expect(top('linear', 1)).toEqual(['v:set:company'])
    // not in the catalog yet (step 4): no row pretends it is; the empty state offers Look in Connections
    expect(top('instagram', 1)).toEqual([])
  })
})

describe('keywords add no noise', () => {
  const hubspot = { id: 'conn:hubspot', label: 'Connect HubSpot…', group: 'Connections', keywords: 'crm pipeline marketing deals customers' }
  it('a keyword matches as a word, not as scattered letters', () => {
    expect(rankPalette([hubspot], 'pause')).toEqual([])
    expect(rankPalette([hubspot], 'crm').map((x) => x.id)).toEqual(['conn:hubspot'])
    expect(rankPalette([hubspot], 'deals').map((x) => x.id)).toEqual(['conn:hubspot'])
    // the label still matches loosely ("hbspt")
    expect(rankPalette([hubspot], 'hbspt').map((x) => x.id)).toEqual(['conn:hubspot'])
  })
})
