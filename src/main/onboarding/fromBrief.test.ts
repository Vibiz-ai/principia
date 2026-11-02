import { describe, expect, it, vi } from 'vitest'
import type { LaunchResult, OnboardingPlan } from '../../shared/onboarding'
import { companyFromBrief, type FromBriefDeps } from './fromBrief'

const plan = {
  departments: [{ key: 'sales', name: 'Sales', include: true }, { key: 'legal', name: 'Legal', include: false }],
  agents: [{ name: 'Outreach', departmentKey: 'sales', include: true }],
  tasks: [{ title: 'Make a prospect list', include: true }]
} as unknown as OnboardingPlan

function deps(res: Partial<LaunchResult> = {}): FromBriefDeps & { launch: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn> } {
  return {
    readBrief: vi.fn(async () => ({ answers: { oneLiner: 'Sourdough for offices' }, source: 'agent' as const })),
    plan: vi.fn(async () => ({ plan, source: 'agent' as const })),
    launch: vi.fn(async () => ({ journalId: 'j1', companyId: 'co_new', status: 'done', steps: [], ...res }) as LaunchResult),
    hold: vi.fn(async () => undefined),
    tz: 'UTC'
  }
}

vi.mock('../../shared/onboarding', async (load) => {
  const real = await load<typeof import('../../shared/onboarding')>()
  return { ...real, LaunchInputSchema: { parse: (x: unknown) => x } }
})

describe('a company from a conversation', () => {
  it('reads the brief, plans, launches, holds Autopilot off and says what it made', async () => {
    const d = deps()
    const out = await companyFromBrief(d, { name: 'Sunday Bakery', brief: 'A sourdough bakery', website: 'https://sunday.example' })
    const input = (d.launch.mock.calls[0]![0] as { input: { answers: { name: string; oneLiner: string; siteUrl: string }; mode: string } }).input
    expect(input.answers).toMatchObject({ name: 'Sunday Bakery', oneLiner: 'Sourdough for offices', siteUrl: 'https://sunday.example' })
    expect(input.mode).toBe('new')
    expect(d.hold).toHaveBeenCalledWith('j1')
    expect(out).toEqual({ company_id: 'co_new', name: 'Sunday Bakery', autopilot: false, departments: ['Sales'], agents: [{ name: 'Outreach', department: 'Sales' }], first_tasks: ['Make a prospect list'] })
  })
  it('a failed launch says where it stopped and never touches Autopilot', async () => {
    const d = deps({ status: 'failed', companyId: null, steps: [{ name: 'agents', status: 'failed', error: 'no profile' }] as LaunchResult['steps'] })
    await expect(companyFromBrief(d, { name: 'X', brief: 'A bakery here' })).rejects.toThrow('stopped at agents: no profile')
    expect(d.hold).not.toHaveBeenCalled()
  })
})
