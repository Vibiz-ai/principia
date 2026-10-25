import { describe, expect, it } from 'vitest'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import {
  doorForDigit,
  goToEntries,
  isPinned,
  MORE,
  moreGroups,
  morePopoverBox,
  navKeyOf,
  pinnedRefs,
  prefsFor,
  prefsKey,
  PRIMARY,
  resolveView,
  setVisibility,
  SETTINGS_PAGES,
  togglePin,
  viewFor,
  VIEW_TITLES,
  visibilityOf,
  type MoreKey,
  type PinnedContext
} from './nav'
import type { ViewState } from '../state/store'

const all = (): boolean => true
const ctx = (active: string[] = [], available: (k: MoreKey) => boolean = all, department?: (id: string) => boolean): PinnedContext => ({ active: new Set(active), available, department })

describe('registry', () => {
  it('has exactly five doors, in the fixed order, on ⌘1-⌘5', () => {
    expect(PRIMARY.map((d) => d.label)).toEqual(['Home', 'Team', 'Board', 'Chats', 'Knowledge'])
    expect(PRIMARY.map((d) => d.kbd)).toEqual(['⌘1', '⌘2', '⌘3', '⌘4', '⌘5'])
    expect([1, 2, 3, 4, 5].map(doorForDigit)).toEqual(['home', 'team', 'board', 'chats', 'knowledge'])
    expect(doorForDigit(6)).toBeNull()
    expect(doorForDigit(0)).toBeNull()
  })

  it('keys and labels are unique across doors, More and Settings pages', () => {
    const keys = [...PRIMARY.map((d) => d.key), ...MORE.map((m) => m.key)]
    expect(new Set(keys).size).toBe(keys.length)
    const labels = [...PRIMARY.map((d) => d.label), ...MORE.map((m) => m.label), ...SETTINGS_PAGES.map((p) => p.label)]
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('More holds the secondary pages in three groups, nothing that was moved to Settings', () => {
    expect(moreGroups(all).map((g) => g.group)).toEqual(['Automate', 'Work', 'Insight'])
    expect(MORE.map((m) => m.label)).toEqual(['Automations', 'Add-ons', 'Files', 'Forum', 'Slack', 'Plans', 'Activity', 'Spend'])
    // once-ever setup is not a nav item any more
    for (const gone of ['Keys', 'Cloud', 'Agents', 'Canvas', 'Passport', 'Usage', 'Artifacts', 'Marketplace']) {
      expect(MORE.some((m) => m.label === gone) || PRIMARY.some((d) => d.label === gone)).toBe(false)
    }
  })

  it('leaves out what is unavailable (Plans behind its flag)', () => {
    const noPlans = moreGroups((k) => k !== 'plans')
    expect(noPlans.flatMap((g) => g.items.map((i) => i.key))).not.toContain('plans')
    expect(goToEntries((k) => k !== 'plans').some((e) => e.label === 'Plans')).toBe(false)
  })

  it('a new user sees 7 rows: nothing pinned, Forum only "Show when active"', () => {
    expect(MORE.filter((m) => m.defaultVisibility === 'always')).toEqual([])
    expect(visibilityOf({}, 'forum')).toBe('active')
    expect(pinnedRefs({}, ctx())).toEqual([])
    // PRIMARY (5) + More + Settings
    expect(PRIMARY.length + 2).toBe(7)
  })
})

describe('aliases (old routes keep working)', () => {
  const cases: [ViewState | { name: string }, ViewState | Partial<ViewState>][] = [
    [{ name: 'agents' }, { name: 'chats', filter: 'live' }],
    [{ name: 'keys' }, { name: 'settings', section: 'keys' }],
    [{ name: 'cloud' }, { name: 'settings', section: 'cloud' }],
    [{ name: 'board' }, { name: 'tasks' }],
    [{ name: 'activity' }, { name: 'canvas' }],
    [{ name: 'files' }, { name: 'artifacts' }],
    [{ name: 'spend' }, { name: 'usage' }],
    [{ name: 'addons' }, { name: 'marketplace' }],
    [{ name: 'automations' }, { name: 'schedules' }]
  ]
  it.each(cases)('%o resolves to %o', (from, to) => {
    expect(resolveView(from as never)).toEqual(to)
  })

  it('knowledge opens the Passport vault', () => {
    expect(resolveView({ name: 'knowledge' }).name).toBe('passport')
  })

  it('company keeps its target, create flag and nonce inside Settings → Company', () => {
    expect(resolveView({ name: 'company', companyId: 'co_a', create: true, nonce: 7 })).toEqual({ name: 'settings', section: 'company', companyId: 'co_a', create: true, nonce: 7 })
  })

  it('real views pass through untouched', () => {
    const v: ViewState = { name: 'run', runId: 'run_1', stepId: 'st_1' }
    expect(resolveView(v)).toBe(v)
    expect(resolveView({ name: 'canvas', focusRunId: 'run_2' })).toEqual({ name: 'canvas', focusRunId: 'run_2' })
  })

  it('every door and More item opens a view that needs no further resolving', () => {
    for (const k of [...PRIMARY.map((d) => d.key), ...MORE.map((m) => m.key)]) {
      const v = viewFor(k, 1)
      expect(resolveView(v)).toEqual(v)
    }
  })

  it('every view highlights its door (or More item) and has a nav-word title', () => {
    expect(navKeyOf({ name: 'department' })).toBe('team')
    expect(navKeyOf({ name: 'agentSeat' })).toBe('team')
    expect(navKeyOf({ name: 'session' })).toBe('chats')
    expect(navKeyOf({ name: 'agents' })).toBe('chats')
    expect(navKeyOf({ name: 'memory' })).toBe('knowledge')
    expect(navKeyOf({ name: 'portfolio' })).toBe('home')
    expect(navKeyOf({ name: 'editor' })).toBe('automations')
    expect(navKeyOf({ name: 'run' })).toBe('activity')
    expect(navKeyOf({ name: 'company' })).toBe('settings')
    for (const k of [...PRIMARY.map((d) => d.key), ...MORE.map((m) => m.key)]) expect(navKeyOf(viewFor(k))).toBe(k)
    expect(VIEW_TITLES.canvas).toBe('Activity')
    expect(VIEW_TITLES.passport).toBe('Knowledge')
    expect(VIEW_TITLES.usage).toBe('Spend')
    expect(VIEW_TITLES.artifacts).toBe('Files')
    expect(VIEW_TITLES.tasks).toBe('Board')
  })
})

describe('palette labels match the nav', () => {
  it('Go to rows use the nav labels and shortcuts', () => {
    const entries = goToEntries(all)
    expect(entries.filter((e) => 'door' in e.target).map((e) => [e.label, e.kbd])).toEqual(PRIMARY.map((d) => [d.label, d.kbd]))
    expect(entries.filter((e) => 'more' in e.target).map((e) => e.label)).toEqual(MORE.map((m) => m.label))
    expect(entries.filter((e) => 'settings' in e.target).map((e) => e.label)).toEqual(['Company settings', 'Connections', 'Keys & secrets', 'AI providers', 'Cloud sync'])
  })

  it('old names are search keywords, never labels', () => {
    const byLabel = Object.fromEntries(goToEntries(all).map((e) => [e.label, e.keywords]))
    expect(byLabel.Activity).toContain('canvas')
    expect(byLabel.Knowledge).toContain('passport')
    expect(byLabel.Spend).toContain('usage')
    expect(byLabel.Files).toContain('artifacts')
    expect(byLabel.Chats).toContain('session')
    expect(byLabel['Keys & secrets']).toContain('api key')
  })
})

describe('pins and visibility', () => {
  it('pinning sets Always show and keeps pin order', () => {
    let p = togglePin({}, 'spend')
    p = togglePin(p, 'files')
    expect(isPinned(p, 'spend')).toBe(true)
    expect(p.pins).toEqual(['spend', 'files'])
    expect(pinnedRefs(p, ctx())).toEqual(['spend', 'files'])
  })

  it('unpinning returns an item to its default and drops it from the order', () => {
    const p = togglePin(togglePin({}, 'spend'), 'spend')
    expect(isPinned(p, 'spend')).toBe(false)
    expect(p).toEqual({})
  })

  it('Forum shows only while it has something for you, unless pinned; unpinning returns it to "Show when active"', () => {
    expect(pinnedRefs({}, ctx())).toEqual([])
    expect(pinnedRefs({}, ctx(['forum']))).toEqual(['forum'])
    const pinned = togglePin({}, 'forum')
    expect(pinnedRefs(pinned, ctx())).toEqual(['forum'])
    const unpinned = togglePin(pinned, 'forum')
    expect(visibilityOf(unpinned, 'forum')).toBe('active')
    expect(unpinned).toEqual({})
  })

  it('Hidden hides even an active item', () => {
    const p = setVisibility({}, 'forum', 'hidden')
    expect(pinnedRefs(p, ctx(['forum']))).toEqual([])
    expect(p.visibility).toEqual({ forum: 'hidden' })
  })

  it('departments pin by ref and vanish when the department is gone', () => {
    const p = togglePin(togglePin({}, 'dept:dep_a'), 'activity')
    expect(isPinned(p, 'dept:dep_a')).toBe(true)
    expect(pinnedRefs(p, ctx([], all, (id) => id === 'dep_a'))).toEqual(['dept:dep_a', 'activity'])
    expect(pinnedRefs(p, ctx([], all, () => false))).toEqual(['activity'])
    expect(togglePin(p, 'dept:dep_a').pins).toEqual(['activity'])
  })

  it('skips unknown keys and unavailable items, and lists Always-show items with no pin order', () => {
    expect(pinnedRefs({ pins: ['nope', 'plans'], visibility: { plans: 'always' } }, ctx([], (k) => k !== 'plans'))).toEqual([])
    expect(pinnedRefs({ visibility: { spend: 'always' } }, ctx())).toEqual(['spend'])
  })

  it('prefs are per company: pins in one never show in another', () => {
    const saved = { co_a: togglePin({}, 'spend'), all: togglePin({}, 'activity') }
    expect(pinnedRefs(prefsFor(saved, 'co_a'), ctx())).toEqual(['spend'])
    expect(pinnedRefs(prefsFor(saved, 'co_b'), ctx())).toEqual([])
    expect(pinnedRefs(prefsFor(saved, 'all'), ctx())).toEqual(['activity'])
    expect(prefsFor(undefined, 'co_a')).toEqual({})
  })

  it('a Personal-only user pins into Personal, not All companies, so the pins stay put after a company is added', () => {
    expect(prefsKey('all', false)).toBe(PERSONAL_COMPANY_ID)
    expect(prefsKey('all', true)).toBe('all')
    const saved = { [PERSONAL_COMPANY_ID]: togglePin({}, 'files') }
    expect(pinnedRefs(prefsFor(saved, 'all', false), ctx())).toEqual(['files'])
    // once there is a second company, All companies has its own (empty) list and Personal keeps Files
    expect(pinnedRefs(prefsFor(saved, 'all'), ctx())).toEqual([])
    expect(pinnedRefs(prefsFor(saved, PERSONAL_COMPANY_ID), ctx())).toEqual(['files'])
  })
})

describe('More popover placement', () => {
  it('stays inside the window at 1100x720: it moves up instead of running off the bottom', () => {
    // QA: More row top 253, popover 549 tall (Plans on), window 720 → bottom was 801
    const b = morePopoverBox(253, 549, 720)
    expect(b.top + 549).toBeLessThanOrEqual(720 - 8)
    expect(b.top).toBe(720 - 549 - 8)
  })
  it('opens beside its row when there is room, never above 8px, and scrolls when taller than the window', () => {
    expect(morePopoverBox(253, 300, 900).top).toBe(245)
    expect(morePopoverBox(10, 300, 900).top).toBe(8)
    const tall = morePopoverBox(253, 2000, 700)
    expect(tall).toEqual({ top: 8, maxHeight: 684 })
  })
})
