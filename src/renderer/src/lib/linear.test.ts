import { describe, expect, it, vi } from 'vitest'
import type { LinearStatusView } from '@shared/linear'
vi.mock('./hive', () => ({ hive: {}, useHiveEvent: () => undefined }))
import { defaultTeam, linearLine, linearWorkLabel, parseLabels, startedInLinear, syncedAgo } from './linear'
import { isWriteOnlyKey } from '@shared/linear'

const view = (o: Partial<LinearStatusView> = {}): LinearStatusView => ({ companyId: 'co_a', connected: true, keyMasked: 'lin_…••••', team: { id: 't', key: 'ENG', name: 'Engineering' }, workspace: 'Acme', autosync: true, state: 'ok', message: null, lastSyncedAt: null, syncing: false, linkedCount: 0, links: {}, ...o })

describe('Linear in the renderer', () => {
  it('says when it last synced', () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    expect(syncedAgo(null, now)).toBe('Not synced yet')
    expect(syncedAgo('2026-10-25T09:59:48Z', now)).toBe('Synced 12 s ago')
    // never "Synced 0 s ago" right after connecting
    expect(syncedAgo('2026-10-25T10:00:00Z', now)).toBe('Synced just now')
    expect(syncedAgo('2026-10-25T09:57:00Z', now)).toBe('Synced 3 min ago')
  })
  it('has one line per state', () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    expect(linearLine(null)).toBe('Linear: Not connected')
    expect(linearLine(view({ lastSyncedAt: '2026-10-25T09:59:48Z' }), now)).toBe('Linear: Synced 12 s ago')
    expect(linearLine(view({ autosync: false, lastSyncedAt: '2026-10-25T09:59:48Z' }), now)).toBe('Linear: Synced 12 s ago · Autosync off')
    expect(linearLine(view({ state: 'auth', autosync: false }))).toBe('Linear: Key turned down · Autosync is off')
    expect(linearLine(view({ state: 'network', lastSyncedAt: '2026-10-25T09:59:48Z' }), now)).toBe('Linear: Offline · Synced 12 s ago')
    expect(linearLine(view({ state: 'error', lastSyncedAt: '2026-10-25T09:59:48Z' }), now)).toBe('Linear: Sync problem · Synced 12 s ago')
  })
  it('reads labels as typed, once each in any case', () => {
    expect(parseLabels(' bug, Launch,BUG ,, launch ')).toEqual(['bug', 'Launch'])
  })
  it('tells work in Linear from an agent working here', () => {
    expect(startedInLinear({ status: 'in_progress', runId: null }, { status: 'in_review' })).toBe(true)
    expect(startedInLinear({ status: 'in_progress', runId: 'run_1' }, { status: 'in_progress' })).toBe(false)
    expect(startedInLinear({ status: 'in_progress', runId: null }, null)).toBe(false)
    expect(linearWorkLabel({ status: 'in_review' })).toBe('in review in Linear')
    expect(linearWorkLabel({ status: 'in_progress' })).toBe('in progress in Linear')
  })
  it('starts on the connected team, else one no other company syncs with; never a team picked by name', () => {
    const teams = [{ id: 'a', syncedWith: ['Acme'] }, { id: 'b' }, { id: 'c' }]
    expect(defaultTeam(teams, 'c')).toBe('c')
    expect(defaultTeam(teams, null)).toBe('b')
    expect(defaultTeam([{ id: 'a', syncedWith: ['Acme'] }], null)).toBe('a')
    expect(defaultTeam([], null)).toBe('')
  })
  it('keeps the company Linear key write-only', () => {
    expect(isWriteOnlyKey('LINEAR_API_KEY', 'co_a')).toBe(true)
    expect(isWriteOnlyKey('LINEAR_API_KEY', null)).toBe(false)
    expect(isWriteOnlyKey('OPENAI_API_KEY', 'co_a')).toBe(false)
  })
})

describe('five doors E13: the preview before connecting Linear', () => {
  it('says what comes in, as what, and how it syncs', async () => {
    const { previewLine } = await import('./linear')
    const p = { teamKey: 'LED', teamName: 'Ledgerly', open: 14, recentlyClosed: 3, more: false, openTasksHere: 5 }
    expect(previewLine(p, { companyName: 'Ledgerly App', prefix: 'LA', sendOpen: false, autosync: true })).toBe(
      '14 open LED issues (and 3 issues closed in the last 14 days) come in as Ledgerly App tasks. Each gets a number here like LA-12 and shows its LED number beside it, so you can find it in Linear. After that, changes sync both ways every minute; when both sides change the same field, the newer change wins.'
    )
    expect(previewLine(p, { companyName: 'Ledgerly App', prefix: 'LA', sendOpen: true, autosync: false })).toContain('5 open tasks from here go to Linear. Autosync is off')
    expect(previewLine({ ...p, open: 1, recentlyClosed: 0 }, { companyName: 'X', prefix: null, sendOpen: false, autosync: true })).toMatch(/^1 open LED issue comes in as X tasks\. Each gets a number here and shows its LED number/)
    expect(previewLine({ ...p, open: 0, recentlyClosed: 0 }, { companyName: 'X', prefix: null, sendOpen: false, autosync: true })).toMatch(/^No open LED issues to bring in yet\./)
    expect(previewLine({ ...p, more: true, open: 250 }, { companyName: 'X', prefix: null, sendOpen: false, autosync: true })).toMatch(/^More than 250 open LED issues/)
  })
})
