/** ONBOARDING.md §7.2 step 5 with "From a prompt": the founder's brief becomes a Founder brief note of facts. */
import { describe, expect, it } from 'vitest'
import { EMPTY_ANSWERS, type LaunchInput } from '../../../shared/onboarding'
import { BRIEF_CONTEXT_CHARS, companyProfile } from '../launch'
import { BRIEF_SEED_CAPS, PASSPORT_NOTES, briefBullets, buildPassportOps } from '../passportSeed'

const BRIEF = '# Sunday Bakery\n- Sourdough delivered to offices in Lisbon.\n- Order by Thursday, delivered Friday 8am.\n\nWe want 20 office customers by December.'
const base = { hubTitle: 'Sunday Bakery', answers: { ...EMPTY_ANSWERS, name: 'Sunday Bakery' }, repoNames: [] }

describe('the Founder brief note', () => {
  it('keeps every line of the brief as a fact, linked from Business', () => {
    const ops = buildPassportOps({ ...base, brief: BRIEF, excerpts: true })
    expect(ops).toContainEqual({ op: 'createNote', title: PASSPORT_NOTES.brief, type: 'concept', summary: 'Sunday Bakery' })
    const facts = ops.filter((o) => o.op === 'observe' && o.note === PASSPORT_NOTES.brief).map((o) => (o as { text: string }).text)
    expect(facts).toEqual(['Sunday Bakery', 'Sourdough delivered to offices in Lisbon.', 'Order by Thursday, delivered Friday 8am.', 'We want 20 office customers by December.'])
    expect(ops).toContainEqual({ op: 'relate', from: PASSPORT_NOTES.business, rel: 'described in', to: PASSPORT_NOTES.brief })
  })

  it('is dropped with the other excerpts on the secret-screen retry, and absent without a brief', () => {
    expect(buildPassportOps({ ...base, brief: BRIEF, excerpts: false }).some((o) => 'title' in o && o.title === PASSPORT_NOTES.brief)).toBe(false)
    expect(buildPassportOps({ ...base, excerpts: true }).some((o) => 'title' in o && o.title === PASSPORT_NOTES.brief)).toBe(false)
  })

  it('splits long lines on sentences, caps bullets at 500 chars and their number', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something useful about the business.`).join(' ')
    const b = briefBullets(long)
    expect(b.length).toBeGreaterThan(1)
    expect(b.every((x) => x.length <= 500)).toBe(true)
    expect(briefBullets(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))).toHaveLength(BRIEF_SEED_CAPS.bullets)
  })
})

describe('companyProfile with a brief', () => {
  it('keeps the start of the brief in the profile context', () => {
    const input = { answers: { ...EMPTY_ANSWERS, name: 'Sunday Bakery' }, brief: `${BRIEF} ${'x'.repeat(4000)}` } as unknown as LaunchInput
    const ctx = companyProfile(input).context ?? ''
    expect(ctx).toContain('Founder brief: # Sunday Bakery - Sourdough')
    expect(ctx.length).toBeLessThanOrEqual(BRIEF_CONTEXT_CHARS + 40)
  })
})
