import { describe, expect, it } from 'vitest'
import { BROWSER_SCOPE_RE, browserStateKey, FOUNDER_SCOPE, paneScope, runScope, taskScope } from '../../../shared/browser'
import { MAX_COMPANY_TABS, MAX_SCOPE_TABS, ScopedTabs, type ScopedTab } from '../scopes'

let seq = 0
const tab = (scope: string, used = ++seq): ScopedTab => ({ id: `t${++seq}`, scope, used })
const full = (max: number): Error => new Error(`max ${max}`)

describe('ScopedTabs', () => {
  it("keeps each chat's tabs and active tab apart", () => {
    const b = new ScopedTabs<ScopedTab>()
    const a1 = tab('pane:a')
    const a2 = tab('pane:a')
    const t1 = tab('task:t')
    b.add(a1)
    b.add(t1)
    b.add(a2)
    expect(b.list('pane:a').map((t) => t.id)).toEqual([a1.id, a2.id])
    expect(b.list('task:t')).toEqual([t1])
    expect(b.list('pane:other')).toEqual([])
    expect(b.activeId('pane:a')).toBe(a2.id)
    expect(b.activeId('task:t')).toBe(t1.id)
    b.select(a1)
    expect(b.activeId('pane:a')).toBe(a1.id)
    expect(b.activeId('task:t')).toBe(t1.id)
    expect(b.isActive(t1)).toBe(true)
  })

  it("never hands one chat another chat's tab", () => {
    const b = new ScopedTabs<ScopedTab>()
    const t1 = tab('task:t')
    b.add(t1)
    expect(b.get('task:t', t1.id)).toBe(t1)
    expect(b.get('pane:a', t1.id)).toBeNull()
    expect(b.activeOf('pane:a')).toBeNull()
  })

  it('closing the active tab makes the newest of the same chat active', () => {
    const b = new ScopedTabs<ScopedTab>()
    const a1 = tab('pane:a')
    const a2 = tab('pane:a')
    const o = tab('pane:o')
    b.add(a1)
    b.add(a2)
    b.add(o)
    b.remove(a2)
    expect(b.activeId('pane:a')).toBe(a1.id)
    expect(b.activeId('pane:o')).toBe(o.id)
    b.remove(a1)
    expect(b.activeId('pane:a')).toBeNull()
    expect(b.scopes()).toEqual(['pane:o'])
  })

  it('caps tabs per chat, and closes the oldest tab of a chat not on screen past the company cap', () => {
    const b = new ScopedTabs<ScopedTab>()
    for (let i = 0; i < MAX_SCOPE_TABS; i++) b.add(tab('pane:a'))
    expect(() => b.makeRoom('pane:a', new Set(), full)).toThrow(`max ${MAX_SCOPE_TABS}`)
    const old = tab('pane:old', -5)
    b.add(old)
    while (b.everything().length < MAX_COMPANY_TABS) b.add(tab(`pane:x${b.everything().length % 3}`))
    // the chat on screen (protected) and the asking chat are never evicted
    const out = b.makeRoom('pane:new', new Set(['pane:new', 'pane:a']), full)
    expect(out).toEqual([old])
    // nothing evictable: refused
    const only = new ScopedTabs<ScopedTab>()
    for (let i = 0; i < MAX_COMPANY_TABS; i++) only.add(tab(`pane:p${i % 3}`))
    expect(() => only.makeRoom('pane:p0', new Set(['pane:p1', 'pane:p2']), full)).toThrow(`max ${MAX_COMPANY_TABS}`)
  })
})

describe('browser scopes', () => {
  it('names a chat, a task and a run, and the IPC accepts only those', () => {
    expect(paneScope('ses_1')).toBe('pane:ses_1')
    expect(taskScope('tsk_1')).toBe('task:tsk_1')
    expect(runScope('run_1')).toBe('run:run_1')
    for (const ok of [FOUNDER_SCOPE, 'pane:ses_1', 'task:tsk-1', 'run:01HX.abc']) expect(BROWSER_SCOPE_RE.test(ok), ok).toBe(true)
    for (const bad of ['', 'pane:', 'other:x', 'pane:a b', 'task:../x/y', `pane:${'x'.repeat(130)}`]) expect(BROWSER_SCOPE_RE.test(bad), bad).toBe(false)
    expect(browserStateKey('co_a', 'pane:1')).not.toBe(browserStateKey('co_a', 'pane:2'))
  })
})
