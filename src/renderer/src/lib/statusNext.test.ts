import { describe, expect, it } from 'vitest'
import { statusNext } from './statusNext'

const f = (scheduleId: string, at: string) => ({ scheduleId, name: scheduleId, at })

describe('statusNext: the status bar always knows whose next fire it shows', () => {
  const status = { nextFire: f('s_la', '2026-10-26T09:00:00Z'), nextFireByCompany: { co_nw: f('s_nw', '2026-10-27T09:00:00Z'), co_la: f('s_la', '2026-10-26T09:00:00Z') } }
  it('inside a company: its own fire only', () => {
    expect(statusNext(status, 'co_nw')).toEqual({ fire: f('s_nw', '2026-10-27T09:00:00Z'), companyId: 'co_nw' })
    expect(statusNext(status, 'co_hd')).toBeNull()
  })
  it('All companies: the earliest fire, named by its company', () => {
    expect(statusNext(status, null)).toEqual({ fire: f('s_la', '2026-10-26T09:00:00Z'), companyId: 'co_la' })
  })
  it('an older main without per-company fires: the global one, owner unknown', () => {
    expect(statusNext({ nextFire: f('s', '2026-10-26T09:00:00Z') }, null)).toEqual({ fire: f('s', '2026-10-26T09:00:00Z'), companyId: null })
    expect(statusNext(null, null)).toBeNull()
  })
})
