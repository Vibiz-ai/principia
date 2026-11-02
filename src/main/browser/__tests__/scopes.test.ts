import { describe, expect, it } from 'vitest'
import { BROWSER_SCOPE_RE, browserStateKey, chatScope, FOUNDER_SCOPE, paneScope, runScope, scopeForRun, taskScope } from '../../../shared/browser'
import { MAX_COMPANY_TABS, MAX_SCOPE_TABS, scopeLabel, ScopedTabs, type ScopedTab } from '../scopes'

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

  it('lists every scope with live tabs, used last first, each with its active tab', () => {
    const b = new ScopedTabs<ScopedTab>()
    const old = tab('task:old', 1)
    const a1 = tab('chat:a', 5)
    const a2 = tab('chat:a', 9)
    const closed = { ...tab('run:gone', 99), dead: true }
    b.add(old)
    b.add(a1)
    b.add(a2)
    b.add(closed)
    b.select(a1)
    expect(b.openScopes().map((s) => [s.scope, s.tabs, s.active.id])).toEqual([
      ['chat:a', 2, a1.id],
      ['task:old', 1, old.id]
    ])
  })
})

describe('browser scopes', () => {
  it('keeps a task or conversation on one scope across its runs; only a run with neither gets its own', () => {
    // the bug behind PR-93: every reply in a conversation got a new, empty run:<id> scope nothing could show
    const reply = (runId: string): string => scopeForRun({ channelId: 'fch_1', runId })
    expect(reply('r_1')).toBe(reply('r_2'))
    expect(reply('r_1')).toBe(chatScope('fch_1'))
    expect(scopeForRun({ taskId: 'tsk_1', runId: 'r_1' })).toBe(scopeForRun({ taskId: 'tsk_1', runId: 'r_2' }))
    expect(scopeForRun({ taskId: 'tsk_1', channelId: 'fch_1', runId: 'r_1' })).toBe(taskScope('tsk_1'))
    expect(scopeForRun({ runId: 'r_1' })).toBe(runScope('r_1'))
    expect(scopeForRun({ taskId: null, channelId: null, runId: 'r_1' })).toBe(runScope('r_1'))
  })

  it('names whose tabs they are, and still shows them when the task or chat is gone', () => {
    const find = { task: (id: string) => (id === 't1' ? 'PR-92' : null), chat: (id: string) => (id === 'c1' ? 'Reddit plan' : null) }
    expect(scopeLabel('task:t1', find)).toBe('PR-92')
    expect(scopeLabel('task:gone', find)).toBe('A task')
    expect(scopeLabel('chat:c1', find)).toBe('Reddit plan')
    expect(scopeLabel('chat:gone', find)).toBe('A conversation')
    expect(scopeLabel('pane:s1', find)).toBe('A chat')
    expect(scopeLabel('run:r1', find)).toBe('A run')
    expect(scopeLabel(FOUNDER_SCOPE, find)).toBe('Your own tabs')
  })

  it('names a chat, a task and a run, and the IPC accepts only those', () => {
    expect(paneScope('ses_1')).toBe('pane:ses_1')
    expect(taskScope('tsk_1')).toBe('task:tsk_1')
    expect(runScope('run_1')).toBe('run:run_1')
    for (const ok of [FOUNDER_SCOPE, 'pane:ses_1', 'task:tsk-1', 'run:01HX.abc', chatScope('fch_lpaw574q9r')]) expect(BROWSER_SCOPE_RE.test(ok), ok).toBe(true)
    for (const bad of ['', 'pane:', 'other:x', 'pane:a b', 'task:../x/y', `pane:${'x'.repeat(130)}`]) expect(BROWSER_SCOPE_RE.test(bad), bad).toBe(false)
    expect(browserStateKey('co_a', 'pane:1')).not.toBe(browserStateKey('co_a', 'pane:2'))
  })
})
