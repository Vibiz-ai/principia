/** ORCHESTRATOR.md §6: one company's own "Principia runs the team" switches over the app-wide setting. */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db'
import { Store } from '../db/store'
import { orchestratorFor } from '../../shared/orchestrator'

describe('a company\'s own switches', () => {
  it('turn the layer off or on, pick the coordinator and the daily calls; shadow stays app-wide', () => {
    expect(orchestratorFor({ companies: { a: { mode: 'off' } } }, 'a').mode).toBe('off')
    expect(orchestratorFor({ mode: 'off', companies: { a: { mode: 'on' } } }, 'a').mode).toBe('on')
    expect(orchestratorFor({ mode: 'shadow', companies: { a: { mode: 'on' } } }, 'a').mode).toBe('shadow')
    expect(orchestratorFor({ companies: { a: { coordinator: 'model', callsPerDay: 500 } } }, 'a')).toMatchObject({ coordinator: 'model', callsPerDay: 200 })
    expect(orchestratorFor({ companies: { a: { mode: 'off' } } }, 'b').mode).toBe('on')
  })
  it('settings:update merges company by company, field by field', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    store.updateSettings({ orchestrator: { companies: { a: { mode: 'off' } } } })
    store.updateSettings({ orchestrator: { companies: { a: { coordinator: 'model' }, b: { callsPerDay: 3 } } } })
    store.updateSettings({ orchestrator: { callsPerDay: 10 } })
    expect(store.getSettings().orchestrator).toEqual({ callsPerDay: 10, companies: { a: { mode: 'off', coordinator: 'model' }, b: { callsPerDay: 3 } } })
    db.close()
  })
})
