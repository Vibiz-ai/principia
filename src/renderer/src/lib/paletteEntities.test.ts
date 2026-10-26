import { describe, expect, it } from 'vitest'
import { paletteEntities } from './paletteEntities'
import { rankPalette } from './paletteRank'

const tasks = [
  { id: 't1', identifier: 'LA-6', title: 'Fix rounding in invoices', companyId: 'co_la', status: 'todo' as const },
  { id: 't2', identifier: 'NW-2', title: 'Weekly rounding of beans', companyId: 'co_nw', status: 'todo' as const },
  { id: 't3', identifier: 'LA-7', title: 'Old idea', companyId: 'co_la', status: 'canceled' as const }
]
const agents = [
  { id: 'a1', companyId: 'co_la', name: 'Content Writer', archivedAt: null, pausedAt: null },
  { id: 'a2', companyId: 'co_nw', name: 'Brand Voice Writer', archivedAt: null, pausedAt: 'x' },
  { id: 'a3', companyId: 'co_la', name: 'Gone', archivedAt: 'x', pausedAt: null }
]
const names: Record<string, string> = { a1: 'Marcus', a2: 'Junia', a3: 'Cato' }
const base = { tasks, agents, nameOf: (a: { id: string; name: string }) => ({ name: names[a.id], role: a.name }), companyName: (id: string) => (id === 'co_la' ? 'Ledgerly App' : 'Northwind Coffee'), multi: true }

describe('paletteEntities: ⌘K jumps to a task or an agent, inside the company only', () => {
  it('inside Ledgerly: its own tasks and agents, never Northwind’s; canceled and archived left out', () => {
    const rows = paletteEntities({ ...base, scope: 'co_la' })
    expect(rows.map((r) => r.id)).toEqual(['agent:a1', 'task:t1'])
    expect(rows.every((r) => r.companyId === 'co_la')).toBe(true)
  })
  it('the task ID, a title word and a persona name each make it the top hit', () => {
    const rows = paletteEntities({ ...base, scope: 'co_la' })
    expect(rankPalette(rows, 'LA-6')[0]?.id).toBe('task:t1')
    expect(rankPalette(rows, 'la-6')[0]?.id).toBe('task:t1')
    expect(rankPalette(rows, 'rounding')[0]?.id).toBe('task:t1')
    expect(rankPalette(rows, 'Marcus')[0]).toMatchObject({ id: 'agent:a1', label: 'Marcus · Content Writer' })
  })
  it('All companies: both companies, each row named by its company', () => {
    const rows = paletteEntities({ ...base, scope: undefined })
    expect(rows.find((r) => r.id === 'task:t2')?.hint).toBe('Northwind Coffee · NW-2')
    expect(rows.find((r) => r.id === 'agent:a2')?.hint).toBe('Northwind Coffee · paused')
  })
})
