/** ORCHESTRATOR.md §3, §5: the words of "Principia runs the team", suggestions and the chief of staff's Activity. */
import { describe, expect, it } from 'vitest'
import { batchLine, resultLine, suggestionAction, teamPatch, teamSwitches } from './orchestrator'

describe('Principia runs the team (renderer words)', () => {
  it('reads a company\'s switches over the app-wide setting', () => {
    expect(teamSwitches(undefined, 'co')).toEqual({ on: true, ai: false, callsPerDay: 20, shadow: false })
    expect(teamSwitches({ companies: { co: { mode: 'off' } } }, 'co').on).toBe(false)
    expect(teamSwitches({ companies: { co: { coordinator: 'model', callsPerDay: 5 } } }, 'co')).toMatchObject({ ai: true, callsPerDay: 5 })
    expect(teamSwitches({ companies: { other: { mode: 'off' } } }, 'co').on).toBe(true)
    expect(teamSwitches({ mode: 'shadow' }, 'co')).toMatchObject({ on: true, shadow: true })
  })
  it('patches only this company', () => {
    expect(teamPatch('co', { ai: true })).toEqual({ orchestrator: { companies: { co: { coordinator: 'model' } } } })
    expect(teamPatch('co', { on: false, callsPerDay: 999 })).toEqual({ orchestrator: { companies: { co: { mode: 'off', callsPerDay: 200 } } } })
  })
  it('plain buttons and lines', () => {
    expect(suggestionAction({ kind: 'routine' })).toBe('Make it a routine')
    expect(suggestionAction({ kind: 'task', taskId: 't' })).toBe('Start it')
    expect(suggestionAction({ kind: 'task' })).toBe('Add to To do')
    expect(batchLine({ events: ['run_ended', 'task_created', 'tick'], mode: 'model' })).toBe('After a run ended, a task was added and the daily check · with AI')
    expect(resultLine({ verb: 'pump', status: 'done', detail: 'Started the tasks that were ready' })).toBe('Started the tasks that were ready')
    expect(resultLine({ verb: 'x', status: 'refused', detail: 'Refused "x": no' })).toBe('Refused "x": no')
    expect(resultLine({ verb: 'file_task', status: 'skipped', detail: 'Already there' })).toBe('Skipped: Already there')
  })
})
