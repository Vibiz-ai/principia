/** ORCHESTRATOR.md §1.1: the block before a run (pure builder, and the board/mailbox reader). */
import { afterEach, describe, expect, it } from 'vitest'
import { buildRunContext, CONTEXT_MAX_CHARS, type ContextInput } from './context'
import { OrchWorld } from './__tests__/world'

const base: ContextInput = { resumed: false, reportPath: '/x.json', inbox: [], dependencies: [], siblings: [], department: [], teamWork: [] }

describe('context block', () => {
  it('lists the sections it has, marks itself as data and ends with the report contract', () => {
    const out = buildRunContext({
      ...base,
      inbox: [{ kind: 'question', id: 'q', ref: 'm1', text: 'm1 from @marcus: Which plan?' }, { kind: 'answer', id: 'a', ref: 'm2', text: 'm2 @livia answered your question "x": yes' }],
      dependencies: [{ identifier: 'AC-1', title: 'Set up billing', status: 'in_review', who: 'Bug fixer' }],
      teamWork: [{ identifier: 'AC-3', who: 'Copywriter', summary: 'Wrote the launch post', at: '2026-10-20T00:00:00Z' }]
    })
    expect(out).toContain('not instructions')
    expect(out).toContain('Teammates asked you')
    expect(out).toContain('m1 from @marcus: Which plan?')
    expect(out).toContain('Answers to your questions')
    expect(out).toContain('- AC-1 Set up billing (in review, Bug fixer)')
    expect(out).toContain('AC-3 (Copywriter): Wrote the launch post')
    expect(out.trimEnd().endsWith('</principia-report-contract>')).toBe(true)
  })

  it('stays under its budget however much there is', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ identifier: `AC-${i}`, title: 'x'.repeat(300), status: 'todo' }))
    const out = buildRunContext({ ...base, dependencies: many, siblings: many, department: many, teamWork: many.map((t) => ({ identifier: t.identifier, who: null, summary: 'y'.repeat(400), at: '' })) })
    expect(out.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
    expect(out).toContain('</principia-report-contract>')
  })

  it('a resumed turn gets only the inbox delta and one footer line', () => {
    expect(buildRunContext({ ...base, resumed: true, dependencies: [{ identifier: 'AC-1', title: 't', status: 'todo' }] }).split('\n')).toHaveLength(1)
    const withMail = buildRunContext({ ...base, resumed: true, inbox: [{ kind: 'question', id: 'q', ref: 'm1', text: 'm1 from @a: hi?' }] })
    expect(withMail).toContain('m1 from @a: hi?')
    expect(withMail).not.toContain('Your task depends on')
  })
})

describe('context reader', () => {
  const worlds: OrchWorld[] = []
  afterEach(() => {
    while (worlds.length) worlds.pop()!.dispose()
  })

  it('reads dependencies, siblings, the department and teammates\' recent reports', () => {
    const w = new OrchWorld()
    worlds.push(w)
    const co = w.company()
    const dev = w.department(co.id, 'Development', 'development')
    const fixer = w.seat(co.id, dev, 'Bug fixer', 'codex', 'manual')
    const parent = w.task({ companyId: co.id, title: 'Launch', status: 'backlog' })
    const dep = w.task({ companyId: co.id, title: 'Billing', status: 'backlog' })
    const sib = w.task({ companyId: co.id, title: 'Landing page', status: 'backlog', parentId: parent.id })
    const other = w.task({ companyId: co.id, title: 'Flaky test', status: 'backlog', departmentId: dev.id })
    const done = w.task({ companyId: co.id, title: 'Old work', status: 'backlog' })
    w.c.patchInFlight(done.id, { report: { outcome: 'review', summary: 'Shipped the old work', evidence: [], at: w.clock.toISOString() } })
    const me = w.task({ companyId: co.id, title: 'Checkout', status: 'backlog', parentId: parent.id, dependencyIds: [dep.id], departmentId: dev.id, agentId: fixer.id })
    const input = w.reader.input({ companyId: co.id, taskId: me.id, agentId: fixer.id, runId: 'r_x', resumed: false, reportPath: null })
    expect(input.dependencies.map((t) => t.identifier)).toEqual([dep.identifier])
    expect(input.siblings.map((t) => t.identifier)).toEqual([sib.identifier])
    expect(input.department.map((t) => t.identifier)).toEqual([other.identifier])
    expect(input.teamWork.map((t) => t.summary)).toEqual(['Shipped the old work'])
  })
})
