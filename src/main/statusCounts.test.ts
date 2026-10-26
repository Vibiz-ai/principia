import { describe, expect, it } from 'vitest'
import { PERSONAL_COMPANY_ID } from '../shared/company'
import { activeByCompany } from './statusCounts'

describe('activeByCompany', () => {
  it('splits running sessions and runs and queued runs by company (QA: Beta showed Alpha\'s running chat)', () => {
    const runs = [
      { status: 'running', companyId: 'co_a' },
      { status: 'queued', companyId: 'co_a' },
      { status: 'running', companyId: null },
      { status: 'passed', companyId: 'co_b' }
    ]
    expect(activeByCompany(runs, { co_a: 1 })).toEqual({ co_a: { running: 2, queued: 1 }, [PERSONAL_COMPANY_ID]: { running: 1, queued: 0 } })
    expect(activeByCompany([], {})).toEqual({})
  })
})
