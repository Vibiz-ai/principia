import { describe, expect, it } from 'vitest'
import type { CompanyTask } from '@shared/company'
import type { Plan } from '@shared/plans'
import { planGraph, taskNodeId } from './planGraph'

const gate = { result: null, notes: '', evidence: [], at: null }
const plan = {
  id: 'plan_1', autonomy: 'autopilot',
  milestones: [
    { id: 'pm_1', key: 'M1', title: 'One', dependsOn: [], agentId: null, gate, passedAt: null },
    { id: 'pm_2', key: 'M2', title: 'Two', dependsOn: [], agentId: null, gate, passedAt: null }
  ],
  tasks: [
    { id: 'pt_1', milestoneId: 'pm_1', taskId: 'task_1', title: 'Write one', touches: [], blockers: [], fix: false },
    { id: 'pt_2', milestoneId: 'pm_2', taskId: 'task_2', title: 'Write two', touches: [], blockers: [], fix: false }
  ]
} as unknown as Plan
const rows = [
  { id: 'task_1', identifier: 'PRN-1', status: 'in_progress' },
  { id: 'task_2', identifier: 'PRN-2', status: 'backlog' }
] as unknown as CompanyTask[]
const sub = (waits?: Record<string, string>) => (planGraph(plan, rows, () => '', waits).nodes.find(n => n.id === taskNodeId('task_2'))!.data as { sub: string }).sub

describe('planGraph', () => {
  it('a milestone that waits says why on its next card, not just "not started" (QA)', () => {
    expect(sub()).toBe('PRN-2 · not started')
    expect(sub({ pm_2: 'waits: Livia is running 3 tasks; PRN-2 starts when one finishes' })).toBe('PRN-2 · waits: Livia is running 3 tasks; PRN-2 starts when one finishes')
  })
})
