import { describe, expect, it } from 'vitest'
import { REQUEST_SCHEMAS } from './ipcSchemas'

const ok = (v: unknown): boolean => REQUEST_SCHEMAS['settings:update'].safeParse(v).success

describe('settings:update sidebarNav (five doors: pins per company)', () => {
  it('accepts pins and visibility per company and for All companies', () => {
    expect(ok({ sidebarNav: { co_abc123: { pins: ['spend', 'dept:dep_x1'], visibility: { spend: 'always', forum: 'hidden' } }, all: { pins: ['activity'] } } })).toBe(true)
    expect(ok({ sidebarNav: {} })).toBe(true)
  })
  it('rejects unknown keys, bad visibility and malformed refs', () => {
    expect(ok({ sidebarNav: { co_abc123: { pins: ['spend'], extra: 1 } } })).toBe(false)
    expect(ok({ sidebarNav: { co_abc123: { visibility: { spend: 'sometimes' } } } })).toBe(false)
    expect(ok({ sidebarNav: { co_abc123: { pins: ['../etc'] } } })).toBe(false)
    expect(ok({ sidebarNav: { 'not an id': { pins: [] } } })).toBe(false)
  })
})

describe('settings:update notices and firstWeek (five doors step 5)', () => {
  it('accepts a dismissed notice and a first week waiting per company', () => {
    expect(ok({ notices: { 'things-moved': '2026-10-25T21:00:00.000Z' } })).toBe(true)
    expect(ok({ firstWeek: { co_abc123: { journalId: 'j_x1-2', scheduleRefs: ['weekly-review'] } } })).toBe(true)
    expect(ok({ firstWeek: {} })).toBe(true)
  })
  it('rejects malformed ids, refs and extra fields', () => {
    expect(ok({ notices: { 'Things Moved': 'x' } })).toBe(false)
    expect(ok({ firstWeek: { co_abc123: { journalId: '../x', scheduleRefs: [] } } })).toBe(false)
    expect(ok({ firstWeek: { co_abc123: { journalId: 'j1', scheduleRefs: ['Bad Ref'] } } })).toBe(false)
    expect(ok({ firstWeek: { co_abc123: { journalId: 'j1', scheduleRefs: [], extra: true } } })).toBe(false)
    expect(ok({ firstWeek: { 'not an id': { journalId: 'j1', scheduleRefs: [] } } })).toBe(false)
  })
})

describe('settings:update routines and nudges (Automations › Routines, Home suggestions)', () => {
  it('accepts what a routine created and a dismissed suggestion per company', () => {
    expect(ok({ routines: { co_abc123: { 'morning-brief': { scheduleId: 'sch_1', onAt: '2026-10-26T09:00:00.000Z' }, 'code-brief': { scheduleId: 'sch_2', workflowId: 'wf_1', onAt: 'x' } } } })).toBe(true)
    expect(ok({ nudges: { co_abc123: { 'morning-brief': '2026-10-26T09:00:00.000Z', 'connect:instagram': 'x' } } })).toBe(true)
  })
  it('rejects unknown routines, bad ids and extra fields', () => {
    expect(ok({ routines: { co_abc123: { 'mine-bitcoin': { scheduleId: 'sch_1', onAt: 'x' } } } })).toBe(false)
    expect(ok({ routines: { co_abc123: { 'morning-brief': { scheduleId: '../x', onAt: 'x' } } } })).toBe(false)
    expect(ok({ routines: { co_abc123: { 'morning-brief': { scheduleId: 'sch_1', onAt: 'x', extra: 1 } } } })).toBe(false)
    expect(ok({ nudges: { co_abc123: { 'Bad Id': 'x' } } })).toBe(false)
  })
})
