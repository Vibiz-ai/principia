/** ONBOARDING.md §2 S0b "From a prompt": the brief's answers, cleaned (model) and read without a model (fallback). */
import { describe, expect, it } from 'vitest'
import { AnswersSchema, EMPTY_ANSWERS, PLAN_BRIEF_MAX } from './onboarding'
import { briefFallback, briefForPlan, cleanBriefAnswers, plausibleSite } from './onboardingBrief'

describe('cleanBriefAnswers', () => {
  it('keeps known fields within the answer limits and drops empty ones', () => {
    const a = cleanBriefAnswers({
      name: '  Sunday   Bakery ',
      oneLiner: 'x'.repeat(400),
      products: '',
      audience: 'Office managers\nin Lisbon',
      voiceVibe: 'friendly',
      goals: ['customers', 'website', 'nope', 'customers'],
      extra: 'ignored'
    })
    expect(a.name).toBe('Sunday Bakery')
    expect(a.oneLiner!.length).toBeLessThanOrEqual(200)
    expect(a.products).toBeUndefined()
    expect(a.audience).toBe('Office managers in Lisbon')
    expect(a.voiceVibe).toBe('friendly')
    expect(a.goals).toEqual(['customers', 'website'])
    expect('extra' in a).toBe(false)
    // whatever the model said, the merged answers still pass the draft's schema
    expect(AnswersSchema.safeParse({ ...EMPTY_ANSWERS, ...a }).success).toBe(true)
  })

  it('drops an unknown vibe, a bad site, "other" without its text, and non-objects', () => {
    expect(cleanBriefAnswers({ voiceVibe: 'sarcastic' }).voiceVibe).toBeUndefined()
    expect(cleanBriefAnswers({ siteUrl: 'not a site' }).siteUrl).toBeUndefined()
    expect(cleanBriefAnswers({ siteUrl: 'https://me:tok@acme.com' }).siteUrl).toBeUndefined()
    expect(cleanBriefAnswers({ goals: ['other'] }).goals).toEqual([])
    expect(cleanBriefAnswers('nope')).toEqual({})
    expect(cleanBriefAnswers({ instagram: '@sunday.bakery!' }).instagram).toBe('sunday.bakery')
  })
})

describe('briefFallback (no model)', () => {
  it('takes a short first line as the name, the next sentence as the one-liner and the first link as the site', () => {
    const a = briefFallback('Sunday Bakery\nSourdough delivered to offices in Lisbon. We also bake pastries.\nSite: sundaybakery.com')
    expect(a.name).toBe('Sunday Bakery')
    expect(a.oneLiner).toBe('Sourdough delivered to offices in Lisbon.')
    expect(a.siteUrl).toBe('sundaybakery.com')
  })

  it('prefers a labelled name and never takes a sentence as the name', () => {
    expect(briefFallback('We are building a tool for dentists to book patients faster.\nName: Molar').name).toBe('Molar')
    const a = briefFallback('We are building a tool for dentists to book patients faster. It saves hours.')
    expect(a.name).toBeUndefined()
    expect(a.oneLiner).toBe('We are building a tool for dentists to book patients faster.')
  })

  it('strips markdown marks and is empty for an empty brief', () => {
    expect(briefFallback('# Acme Labs\n- Robots for warehouses').name).toBe('Acme Labs')
    expect(briefFallback('   ')).toEqual({})
  })
})

describe('briefForPlan / plausibleSite', () => {
  it('caps the brief for the plan prompt and drops an empty one', () => {
    expect(briefForPlan('  ')).toBeUndefined()
    expect(briefForPlan(undefined)).toBeUndefined()
    expect(briefForPlan('a'.repeat(PLAN_BRIEF_MAX + 50))!.length).toBe(PLAN_BRIEF_MAX)
  })
  it('accepts hosts with a dot only', () => {
    expect(plausibleSite('https://acme.com/x')).toBe('https://acme.com/x')
    expect(plausibleSite('localhost')).toBe('')
    expect(plausibleSite('a b.com')).toBe('')
  })
})
