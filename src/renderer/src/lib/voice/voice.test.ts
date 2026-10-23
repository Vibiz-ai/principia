import { describe, expect, it } from 'vitest'
import { COPY, MILESTONE_COPY, type CopyKey, type Entry } from './copy'
import { LATIN, latinWords } from './latin'
import { LOADING_LATIN, interpolate, latinLine, loadingLine, milestoneName, milestoneToast, t, varsOf } from './core'

const entries = Object.entries(COPY) as [CopyKey, Entry][]
const LATIN_WORDS = latinWords()
const METAPHORS = /\b(seal|decree|charter|forum|empire|legion)\w*/i
/** Uppercase Roman numerals of two or more letters, or a lone V/X/L/C/D/M ("I" is the English pronoun). */
const NUMERAL = /\b(?:(?=[MDCLXVI]{2,}\b)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})|[VXLCDM])\b/

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? []
const numbers = (s: string) => s.match(/\d+/g) ?? []

describe('copy rules (VOICE.md §2)', () => {
  it('every {var} in playful also appears in plain, and plain vars survive in playful', () => {
    for (const [key, e] of entries) {
      if (!e.playful) continue
      const plain = new Set(varsOf(e.plain))
      const playful = new Set(varsOf(e.playful))
      for (const v of playful) expect(plain.has(v), `${key}: {${v}} missing from plain`).toBe(true)
      for (const v of plain) expect(playful.has(v), `${key}: playful drops {${v}}`).toBe(true)
    }
  })
  it('playful keeps the facts and promises plain carries (flavor never hides meaning, §1)', () => {
    // hand-reviewed: the clause in each plain line that tells the founder what happens next or what we promise
    const kept: Partial<Record<CopyKey, string>> = {
      'ob.goals.sub': "we'll build the team around them",
      'ob.content.sub': 'Nothing is published, sent or paid without',
      'ob.voice.sub': 'Pick a voice. Agents write in it.',
      'ob.ready.title': '{name} is ready.',
      'ob.resume': 'step {n} of {total}',
      'cer.sub': 'Your team is assembled.',
      'cer.sub.none': '{name} is set up.'
    }
    for (const [key, phrase] of Object.entries(kept) as [CopyKey, string][]) {
      const e: Entry = COPY[key]
      expect(e.plain.toLowerCase(), `${key}: plain`).toContain(phrase.toLowerCase())
      expect((e.playful ?? e.plain).toLowerCase(), `${key}: playful drops "${phrase}"`).toContain(phrase.toLowerCase())
    }
  })
  it('playful never drops a number plain carries', () => {
    for (const [key, e] of entries) {
      if (!e.playful) continue
      for (const n of numbers(e.plain)) expect(e.playful.includes(n), `${key}: playful drops ${n}`).toBe(true)
    }
  })
  it('plain has no Latin words, no Roman numerals and no metaphor words', () => {
    const plains: [string, string][] = [
      ...entries.map(([k, e]) => [k, e.plain] as [string, string]),
      ...Object.entries(MILESTONE_COPY).flatMap(([k, m]) => [[`ms.${k}`, m.plain], [`ms.${k}.meaning`, m.meaning]] as [string, string][])
    ]
    for (const [key, plain] of plains) {
      for (const w of words(plain)) expect(LATIN_WORDS.has(w), `${key}: Latin word "${w}" in plain`).toBe(false)
      expect(NUMERAL.test(plain), `${key}: Roman numeral in plain`).toBe(false)
      expect(plain.includes('|roman'), `${key}: numeral filter in plain`).toBe(false)
      expect(METAPHORS.test(plain), `${key}: metaphor word in plain`).toBe(false)
    }
  })
  it('playful is at most 30 characters longer than plain', () => {
    for (const [key, e] of entries) {
      if (e.playful) expect(e.playful.length, key).toBeLessThanOrEqual(e.plain.length + 30)
    }
  })
  it('no err.* key has a playful form or Latin', () => {
    const errs = entries.filter(([k]) => k.startsWith('err.'))
    expect(errs.length).toBeGreaterThan(0)
    for (const [key, e] of errs) {
      expect(e.playful, key).toBeUndefined()
      expect(e.latin, key).toBeUndefined()
    }
  })
  it('screen-reader keys (*.sr) are plain only', () => {
    const srs = entries.filter(([k]) => k.endsWith('.sr'))
    expect(srs.length).toBeGreaterThan(0)
    for (const [key, e] of srs) {
      expect(e.playful, key).toBeUndefined()
      expect(e.latin, key).toBeUndefined()
    }
  })
  it('Roman numerals only ever render a year (§1: never quantities you act on)', () => {
    for (const [key, e] of entries) {
      for (const text of [e.plain, e.playful ?? '']) {
        for (const m of text.matchAll(/\{(\w+)\|roman\}/g)) expect(m[1], key).toBe('year')
      }
    }
  })
  it('Latin is never inlined into copy text (it goes through `latin` so plain can drop it)', () => {
    const phrases = Object.values(LATIN).filter((p) => p.la.length > 4).map((p) => p.la.toLowerCase())
    for (const [key, e] of entries) {
      for (const text of [e.plain, e.playful ?? '']) {
        for (const la of phrases) expect(text.toLowerCase().includes(la), `${key}: inlines "${la}"`).toBe(false)
      }
    }
  })
  it('every latin reference exists', () => {
    for (const [key, e] of entries) if (e.latin) expect(LATIN[e.latin], key).toBeDefined()
    for (const m of Object.values(MILESTONE_COPY)) if (m.latin) expect(LATIN[m.latin]).toBeDefined()
  })
  it('the test helpers catch what they should', () => {
    expect(NUMERAL.test('FOUNDED MMXXVI')).toBe(true)
    expect(NUMERAL.test('Marcus II')).toBe(true)
    expect(NUMERAL.test("I'll explore on my own")).toBe(false)
    expect(NUMERAL.test('BUSINESS PASSPORT')).toBe(false)
    expect(METAPHORS.test('Signed and sealed')).toBe(true)
    expect(LATIN_WORDS.has('festina')).toBe(true)
  })
})

describe('t', () => {
  it('interpolates vars and blanks missing ones', () => {
    expect(t('ob.progress', { n: 2, total: 6 })).toBe('Step 2 of 6')
    expect(t('ob.plan.primary', {})).toBe('Create ')
    expect(t('agent.header', { persona: 'Marcus', role: 'Copywriter' })).toBe('Marcus · Copywriter')
  })
  it('picks the tone and falls back to plain', () => {
    expect(t('ob.name.title', undefined, 'playful')).toBe('Every empire starts with a name.')
    expect(t('ob.name.title', undefined, 'plain')).toBe('Give your business a name.')
    expect(t('ob.name.title')).toBe('Give your business a name.')
    expect(t('ob.start.title.first', undefined, 'playful')).toBe('Welcome to Principia')
    expect(t('err.launch.schedules', { reason: 'busy' }, 'playful')).toBe("Couldn't create the schedules: busy")
  })
  it('t.sr is always plain', () => {
    expect(t.sr('ny.ask', { persona: 'Marcus' })).toBe('Marcus needs your answer')
    expect(t('ny.ask', { persona: 'Marcus' }, 'playful')).toBe('Ave! Marcus awaits your decree')
  })
  it('renders a year as a numeral only in playful', () => {
    expect(t('pp.founded', { year: 2026 }, 'plain')).toBe('FOUNDED 2026')
    expect(t('pp.founded', { year: 2026 }, 'playful')).toBe('FOUNDED · MMXXVI')
    expect(interpolate('{year|roman}', { year: 'soon' })).toBe('soon')
    expect(interpolate('{year|roman}', {})).toBe('')
  })
})

describe('latinLine and loadingLine', () => {
  it('latinLine is null in plain and for entries without Latin', () => {
    expect(latinLine('ob.plan.tailoring', 'playful')).toEqual({ la: 'Festina lente', en: 'Make haste slowly' })
    expect(latinLine('ob.plan.tailoring', 'plain')).toBeNull()
    expect(latinLine('ob.name.title', 'playful')).toBeNull()
    expect(latinLine('cer.title', 'playful')?.la).toBe('Alea iacta est')
  })
  it('loading lines say what is happening; Latin only on plan and launch in playful', () => {
    expect(loadingLine('plan', 7, 'playful')).toEqual({ text: 'Tailoring with Claude…', latin: { la: 'Festina lente', en: 'Make haste slowly' } })
    expect(loadingLine('plan', 7, 'plain')).toEqual({ text: 'Tailoring with Claude…' })
    expect(loadingLine('launch', 0, 'playful', { name: 'Sunday Bakery' })).toEqual({ text: 'Setting up Sunday Bakery…', latin: { la: 'Ab ovo', en: 'From the very beginning' } })
    expect(loadingLine('scan', 3, 'playful', { repo: 'web' })).toEqual({ text: 'Reading web…' })
    expect(loadingLine('site', 3, 'playful', { host: 'a.com' })).toEqual({ text: 'Reading a.com…' })
    expect(loadingLine('run', 1, 'playful')).toEqual({ text: 'Working…' })
    expect(loadingLine('generic', -5, 'playful')).toEqual({ text: 'Loading…' })
    for (const pool of Object.values(LOADING_LATIN)) for (const k of pool) expect(LATIN[k]).toBeDefined()
  })
})

describe('milestones', () => {
  it('has the eight milestones of §7', () => {
    expect(Object.keys(MILESTONE_COPY).sort()).toEqual(['calmWeek', 'firstAnswer', 'firstPost', 'firstTask', 'firstWeek', 'fullTeam', 'hundred', 'launched'])
  })
  it('toasts and names follow the tone', () => {
    expect(milestoneToast('firstPost', 'plain')).toEqual({ text: 'Milestone: first post approved.' })
    expect(milestoneToast('firstPost', 'playful')).toEqual({ text: 'First post approved.', latin: { la: 'Veni, vidi, vici', en: 'I came, I saw, I conquered' } })
    expect(milestoneToast('firstAnswer', 'playful')).toEqual({ text: 'Your first decree. First answer.' })
    expect(milestoneName('hundred', 'plain')).toEqual({ text: '100 tasks' })
    expect(milestoneName('launched', 'playful')).toEqual({ text: 'Primus lapis', latin: { la: 'Primus lapis', en: 'The first stone' } })
  })
})
