import { describe, expect, it } from 'vitest'
import { rankPalette, type Rankable } from './paletteRank'
import { goToEntries } from './nav'

const goTo: (Rankable & { id: string })[] = goToEntries(() => true).map((g) => ({ id: g.id, label: g.label, group: 'Go to', keywords: g.keywords, exact: g.exact }))
const pauseAll = { id: 'a:pause', label: 'Pause Schedules in All Companies…', group: 'Actions', global: true }
const newSch = { id: 'a:newSch', label: 'New Schedule', group: 'Actions' }
const items = [pauseAll, newSch, ...goTo]

describe('palette ranking', () => {
  it('an old nav word lands on its new door, never on a global action ("schedules" → Automations)', () => {
    // an old name lands on its own tab of Automations ("Schedules" ↵ never opens Autopilots)
    expect(rankPalette(items, 'schedules')[0]!.id).toBe('v:schedules')
    expect(rankPalette(items, 'Schedules')[0]!.id).toBe('v:schedules')
    expect(rankPalette(items, 'Workflows')[0]!.id).toBe('v:workflows')
    expect(rankPalette(items, 'autopilot')[0]!.id).toBe('v:autopilots')
    expect(rankPalette(items, 'automations')[0]!.id).toBe('v:automations')
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
    expect(top('api key')).toEqual(['v:set:keys', 'v:set:providers'])
    expect(top('connections', 1)).toEqual(['v:set:connections'])
    // step 4: Linear and Instagram are cards in Connections
    expect(top('linear', 1)).toEqual(['v:set:connections'])
    expect(top('instagram', 1)).toEqual(['v:set:connections'])
    expect(top('disk', 1)).toEqual(['v:set:storage'])
    expect(top('task prefix', 1)).toEqual(['v:set:company'])
  })
  it('several words, Danger zone and archive are found (QA round 4)', () => {
    const top = (q: string, n = 1): string[] => rankPalette(goTo, q).slice(0, n).map((x) => x.id)
    expect(top('openai key')).toEqual(['v:set:providers'])
    expect(top('key openai')).toEqual(['v:set:providers'])
    expect(top('danger')).toEqual(['v:set:danger'])
    expect(top('archive')).toEqual(['v:set:danger'])
    expect(top('unarchive')).toEqual(['v:set:storage'])
    expect(top('notifications')).toEqual(['v:set:notifications'])
    expect(rankPalette([{ id: 'gh', label: 'Connect GitHub…', group: 'Connections', keywords: 'github gh login' }], 'gh login').length).toBe(1)
    expect(rankPalette(goTo, 'openai zebra')).toEqual([])
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

describe('Automations tabs in ⌘K', () => {
  it('each old name opens its own tab', () => {
    const by = Object.fromEntries(goToEntries(() => true).map((g) => [g.id, g.target]))
    expect(by['v:schedules']).toEqual({ view: { name: 'schedules', tab: 'schedules' } })
    expect(by['v:workflows']).toEqual({ view: { name: 'workflows' } })
    expect(by['v:autopilots']).toEqual({ view: { name: 'schedules', tab: 'autopilots' } })
    expect(goToEntries((k) => k !== 'automations').some((g) => g.id === 'v:schedules')).toBe(false)
  })
})
