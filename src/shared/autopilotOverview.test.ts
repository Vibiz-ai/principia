import { describe, expect, it } from 'vitest'
import { autopilotOverview, whenShort, type OverviewInput } from './autopilotOverview'
import { playbookLimits, playbookDef, type PlaybookView } from './autopilotPlaybooks'

const ads = (over: Partial<PlaybookView> = {}): PlaybookView => ({
  id: 'ads-watch', companyId: 'co', on: true, level: 1, raised: false, limits: playbookLimits(playbookDef('ads-watch'), { budgetCapUsd: 10 }), scheduleId: 's1', agentId: 'm', agentName: 'Marcus',
  running: true, pausedWhy: null, lastRunAt: null, lastRunStatus: null, nextRunAt: null, onAt: null, waiting: null, ...over
})
const base = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  companyName: 'Ledgerline',
  switchOn: true,
  paused: false,
  maxInFlight: 2,
  monthlyCap: 200,
  agents: [
    { id: 'm', name: 'Marcus', department: 'Marketing', auto: true, active: true },
    { id: 'd', name: 'Dana', department: 'Development', auto: false, active: true }
  ],
  tasks: [
    { id: 't1', identifier: 'LL-1', title: 'Write the launch post', status: 'in_review', agentId: 'm', dependencyIds: [], priority: 0 },
    { id: 't3', identifier: 'LL-3', title: 'Publish the launch post', status: 'blocked', blockReason: 'deps', agentId: 'm', dependencyIds: ['t1'], priority: 0 },
    { id: 't4', identifier: 'LL-4', title: 'Draft the newsletter', status: 'todo', agentId: 'm', dependencyIds: [], priority: 0 },
    { id: 't5', identifier: 'LL-5', title: 'Fix the footer', status: 'todo', agentId: 'd', dependencyIds: [], priority: 0 }
  ],
  schedules: [
    { name: 'Weekly company review', enabled: true, sentence: 'Mondays at 8:00', nextFireAt: '2026-10-26T07:00:00.000Z', agentName: 'Marcus' },
    { name: 'Ads watch & creative refresh', enabled: true, sentence: 'Every day at 9:00', nextFireAt: null, playbook: true },
    { name: 'Old digest', enabled: false, sentence: 'Fridays', nextFireAt: null }
  ],
  playbooks: [ads()],
  lately: [
    { at: '2026-10-20T09:00:00.000Z', line: 'Marcus started LL-1 Write the launch post on its own' },
    { at: '2026-10-21T09:00:00.000Z', line: 'Ads watch tried to change a budget to $900; refused.' }
  ],
  ...over
})

describe('What is Autopilot doing?', () => {
  it('says who starts work, what comes next and why it waits, the schedules, what is on autopilot and the limits', () => {
    const o = autopilotOverview(base())
    expect(o.headline).toBe('1 agent starts assigned work on its own · 1 schedule runs · 1 playbook on autopilot.')
    expect(o.starters).toEqual(['Marcus (Marketing)'])
    expect(o.manual).toEqual(['Dana (Development)'])
    expect(o.next).toEqual([
      { ref: 'LL-3', title: 'Publish the launch post', who: 'Marcus', why: 'starts when you approve LL-1' },
      { ref: 'LL-4', title: 'Draft the newsletter', who: 'Marcus', why: 'starts within a minute' },
      { ref: 'LL-5', title: 'Fix the footer', who: 'Dana', why: 'Dana works only when you press Start' }
    ])
    expect(o.schedules).toEqual([{ name: 'Weekly company review', when: 'Mondays at 8:00 · wakes Marcus', next: '2026-10-26T07:00:00.000Z' }])
    expect(o.onAutopilot).toEqual([{ name: 'Ads watch', state: 'Runs, by Marcus', level: 'Level 1 · Watch & report', limits: 'Up to 3 suggestions a run · total budget cap $10 a day · its runs reach the ads account only through Principia’s checked connections: no terminal, no web requests, no ads keys', cadence: 'Every day at 9:00', lastLine: null }])
    expect(o.limits).toBe('Up to 2 tasks at once · monthly cap $200')
    expect(o.lately.map((e) => e.line)).toEqual(['Ads watch tried to change a budget to $900; refused.', 'Marcus started LL-1 Write the launch post on its own'])
  })
  it('a busy agent, a full company, a switch that is off, a paused company and a waiting playbook each say so', () => {
    const busy = autopilotOverview(base({ tasks: [{ id: 'a', identifier: 'LL-7', title: 'A', status: 'in_progress', agentId: 'm', dependencyIds: [], priority: 0 }, { id: 'b', identifier: 'LL-8', title: 'B', status: 'todo', agentId: 'm', dependencyIds: [], priority: 0 }] }))
    expect(busy.next[0]!.why).toBe('starts after Marcus finishes LL-7')
    const off = autopilotOverview(base({ switchOn: false }))
    expect(off.starters).toEqual([])
    expect(off.headline.startsWith('Agents wait for you to press Start')).toBe(true)
    expect(off.next.find((n) => n.ref === 'LL-4')!.why).toBe('Autopilot is off: it waits for your Start')
    const paused = autopilotOverview(base({ paused: true }))
    expect(paused.headline).toBe('Ledgerline is paused, so nothing starts by itself.')
    const waiting = autopilotOverview(base({ playbooks: [ads({ running: false, waiting: { label: 'your ads account', connectId: 'meta-ads' } })] }))
    expect(waiting.onAutopilot[0]!.state).toBe('Waiting for your ads account')
    expect(waiting.headline).toContain('1 waiting for its connection')
  })
  it('a short when for the next fire', () => {
    const now = new Date('2026-10-20T08:00:00.000Z')
    expect(whenShort('2026-10-20T08:30:00.000Z', now)).toBe('in 30 min')
    expect(whenShort('2026-10-20T11:00:00.000Z', now)).toBe('in 3 h')
    expect(whenShort(null, now)).toBeNull()
  })
})
