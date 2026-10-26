import { describe, expect, it } from 'vitest'
import type { NativeMenuItem } from '@shared/ipc'
import { companyMenuItems } from './companyMenu'
import { pauseToastText, taskNeedsIn, teamMeta } from './companyModel'

const personal = { id: 'co_personal', name: 'Personal', system: 'personal' as const }
const nw = { id: 'co_nw', name: 'Northwind Coffee', system: null }
const la = { id: 'co_la', name: 'Ledgerly App', system: null }
const companies = [nw, la, personal]
const flat = (items: NativeMenuItem[]): NativeMenuItem[] => items.flatMap((i) => [i, ...flat(((i as { submenu?: NativeMenuItem[] }).submenu ?? []) as NativeMenuItem[])])
const find = (items: NativeMenuItem[], id: string): (NativeMenuItem & { checked?: boolean; label?: string }) | undefined => flat(items).find((i) => (i as { id?: string }).id === id) as never
const base = { companies, departments: true, seats: 4, paused: false, missingPresets: [{ key: 'finance', name: 'Finance' }] }

describe('company menu', () => {
  it('Autopilot shows its real state, so a second click turns it off', () => {
    expect(find(companyMenuItems({ ...base, company: { ...nw, autopilot: true } }), 'autopilot')?.checked).toBe(true)
    expect(find(companyMenuItems({ ...base, company: { ...nw, autopilot: false } }), 'autopilot')?.checked).toBe(false)
    expect(find(companyMenuItems({ ...base, company: nw }), 'autopilot')?.checked).toBe(false)
  })
  it('offers Pause or Resume for this company only, and nothing to pause where there are no agents (Personal)', () => {
    expect(find(companyMenuItems({ ...base, company: nw }), 'pause')?.label).toBe('Pause Northwind Coffee')
    expect(find(companyMenuItems({ ...base, company: nw, paused: true }), 'resume')?.label).toBe('Resume Northwind Coffee')
    const p = companyMenuItems({ ...base, company: personal, seats: 0 })
    expect(find(p, 'pause')).toBeUndefined()
    expect(find(p, 'autopilot')).toBeUndefined()
  })
  it('A4: while paused, Autopilot reads "Off while paused" and is greyed out', () => {
    const a = find(companyMenuItems({ ...base, company: { ...nw, autopilot: true }, paused: true }), 'autopilot')
    expect(a).toMatchObject({ label: 'Auto-start: off while paused', checked: false, enabled: false })
  })
  it('Add Department lists the missing presets, never for Personal', () => {
    expect(find(companyMenuItems({ ...base, company: nw, seats: 0 }), 'dep:finance')?.label).toBe('Finance')
    expect(find(companyMenuItems({ ...base, company: personal, seats: 0 }), 'dep:finance')).toBeUndefined()
    expect(find(companyMenuItems({ ...base, company: nw, missingPresets: [] }), 'dep:finance')).toBeUndefined()
  })
  it('Switch To names Personal plainly', () => {
    expect(find(companyMenuItems({ ...base, company: nw }), 'co:co_personal')?.label).toBe('Personal')
  })
})

describe('counts that must agree', () => {
  it('Team in All companies counts companies like the header (Personal is not one)', () => {
    const seats = [{ companyId: 'co_nw' }, { companyId: 'co_la' }]
    expect(teamMeta(seats, companies, true)).toBe('2 agents · 2 companies')
    expect(teamMeta([...seats, { companyId: 'co_personal' }], companies, true)).toBe('3 agents · 2 companies and Personal')
    expect(teamMeta(seats.slice(0, 1), [nw], false)).toBe('1 agent')
  })
  it('the Home badge adds board tasks waiting on you, without counting a live ask twice', () => {
    const counts = { co_nw: { working: 0, needsYou: 3, doneToday: 0 }, co_la: { working: 1, needsYou: 2, doneToday: 0, liveAsks: 1 } }
    expect(taskNeedsIn(counts, 'co_nw')).toBe(3)
    expect(taskNeedsIn(counts, 'co_la')).toBe(1)
    expect(taskNeedsIn(counts)).toBe(4)
  })
  it('the pause toast names who keeps running; the resume toast does not', () => {
    const pliny = [{ agentName: 'Pliny', title: 'Competitor research' }]
    expect(pauseToastText('Harbor Dental Group', pliny, true)).toBe('Paused Harbor Dental Group. Pliny’s work on “Competitor research” is saved; Pliny continues when you resume. Other companies keep running.')
    expect(pauseToastText('Harbor Dental Group', [], true)).toBe('Paused Harbor Dental Group. Other companies keep running.')
    expect(pauseToastText('Harbor Dental Group', [], true, false)).toBe('Paused Harbor Dental Group.')
    expect(pauseToastText('Harbor Dental Group', pliny, false)).toBe('Resumed Harbor Dental Group. Pliny continues “Competitor research”.')
    // never another company's name: "keep running" is about every other company
    expect(pauseToastText('Harbor Dental Group', [], true)).not.toMatch(/Ledgerly|Northwind/)
  })
})
