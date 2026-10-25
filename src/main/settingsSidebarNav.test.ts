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
