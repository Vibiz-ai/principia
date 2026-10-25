import { describe, expect, it } from 'vitest'
import { forumVisualizeAsk, normalizeStatus, parseDiagram, TASK_STATUSES } from './diagram'

const tasks = (statuses: unknown[]): string =>
  JSON.stringify({ nodes: statuses.map((status, i) => ({ id: `t${i}`, kind: 'task', label: `T${i}`, status })) })

describe('forgiving task statuses (QA: real agents wrote "review")', () => {
  it('maps the words agents and the Board use to the five statuses', () => {
    expect(normalizeStatus('review')).toBe('in_review')
    expect(normalizeStatus('In Review')).toBe('in_review')
    expect(normalizeStatus('in-progress')).toBe('in_progress')
    expect(normalizeStatus('backlog')).toBe('todo')
    expect(normalizeStatus('triage')).toBe('todo')
    expect(normalizeStatus('completed')).toBe('done')
    expect(normalizeStatus('done')).toBe('done')
    expect(normalizeStatus('canceled')).toBeNull()
    expect(normalizeStatus(3)).toBeNull()
  })

  it('draws the diagram with mapped statuses and says what it fixed', () => {
    const r = parseDiagram(tasks(['todo', 'review', 'backlog', 'canceled', 'done']))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diagram.nodes.map((n) => n.status)).toEqual(['todo', 'in_review', 'todo', undefined, 'done'])
    expect(r.warnings).toEqual([
      'nodes[1].status "review" read as in_review',
      'nodes[2].status "backlog" read as todo',
      `nodes[3].status "canceled" left out (use one of ${TASK_STATUSES.join(', ')})`
    ])
    // the raw block is kept exactly, for Copy JSON
    expect(r.raw).toBe(tasks(['todo', 'review', 'backlog', 'canceled', 'done']))
  })

  it('a valid block has no warnings; a null status is just absent', () => {
    const r = parseDiagram(tasks(['todo', null]))
    expect(r.ok && r.warnings).toEqual([])
    expect(r.ok && r.diagram.nodes[1]!.status).toBeUndefined()
  })

  it('still rejects a bad node kind (kinds are not guessed)', () => {
    const r = parseDiagram(JSON.stringify({ nodes: [{ id: 'a', kind: 'robot', label: 'A' }] }))
    expect(!r.ok && r.error).toMatch(/^nodes\[0\]\.kind must be one of/)
  })
})

describe('edges that cannot be drawn as a line', () => {
  it('leaves out self-loops and edges between a node and its own group', () => {
    const r = parseDiagram(
      JSON.stringify({
        nodes: [
          { id: 'g', kind: 'group', label: 'Core' },
          { id: 'w', kind: 'service', label: 'Worker', group: 'g' },
          { id: 's', kind: 'service', label: 'Service' },
          { id: 't', kind: 'task', label: 'Todo' }
        ],
        edges: [
          { from: 'w', to: 'g' },
          { from: 'g', to: 'w' },
          { from: 's', to: 's' },
          { from: 't', to: 'g' },
          { from: 's', to: 'w', label: 'calls' }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diagram.edges).toEqual([
      { from: 't', to: 'g' },
      { from: 's', to: 'w', label: 'calls' }
    ])
    expect(r.warnings).toHaveLength(3)
    expect(r.warnings[2]).toBe('edges[2] from "s" to itself left out')
  })
})

describe('forum /visualize', () => {
  it('needs an @agent and a subject, else it would go unanswered', () => {
    expect(forumVisualizeAsk([], 'the checkout flow')).toBeNull()
    expect(forumVisualizeAsk(['marcus'], '  ')).toBeNull()
    expect(forumVisualizeAsk(['marcus', 'ana'], 'the checkout flow')).toBe('@marcus @ana Draw the checkout flow as a principia-graph.')
  })
})

describe('undeclared groups (QA live chat: "group": "Foundations")', () => {
  it('makes a group node for a group named but never declared', () => {
    const r = parseDiagram(
      JSON.stringify({
        nodes: [
          { id: 't1', kind: 'task', label: 'Pricing', group: 'Foundations' },
          { id: 't2', kind: 'task', label: 'Copy', group: 'Foundations' },
          { id: 't3', kind: 'task', label: 'Build', group: 'Build' }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diagram.nodes.filter((n) => n.kind === 'group').map((n) => [n.id, n.label])).toEqual([
      ['Foundations', 'Foundations'],
      ['Build', 'Build']
    ])
    expect(r.warnings).toEqual(['group "Foundations" was not a node, so it was added', 'group "Build" was not a node, so it was added'])
  })
})
