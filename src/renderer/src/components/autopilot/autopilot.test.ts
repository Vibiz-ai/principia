/** AUTOPILOT.md §7: Home's one-line answer says whether Autopilot is on, from the same state as the header chip. */
import { describe, expect, it } from 'vitest'
import { autopilotState, withAutopilot } from '@shared/autopilotState'

describe('Home line', () => {
  it('ends with Autopilot on / off; a paused company keeps its own line', () => {
    expect(withAutopilot('Northwind · nothing needs you, no agent is working.', autopilotState({ autopilot: true }))).toBe('Northwind · nothing needs you, no agent is working · Autopilot on.')
    expect(withAutopilot('Northwind · 2 things need you, 1 agent is working.', autopilotState({}))).toBe('Northwind · 2 things need you, 1 agent is working · Autopilot off.')
    expect(withAutopilot('Northwind · paused, nothing needs you.', autopilotState({ autopilot: true, pausedAt: '2026-10-01' }))).toBe('Northwind · paused, nothing needs you.')
    expect(withAutopilot('Personal · nothing needs you.', null)).toBe('Personal · nothing needs you.')
  })
})
