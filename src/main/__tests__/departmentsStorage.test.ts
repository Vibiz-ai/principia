/**
 * DEPARTMENTS.md §8, §1.3: the new columns round-trip through the stores (schedules.department_id, slack_triggers
 * action / department_id, company_task_activity.actor healed by openDatabase), and older rows keep their shape.
 */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db'
import { Store } from '../db/store'
import { SlackTriggerStore } from '../connectors/slack/triggerStore'
import type { NormalizedTrigger } from '../connectors/slack/triggerConfig'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk && !process.versions.electron ? describe : describe.skip

const cols = (db: ReturnType<typeof openDatabase>, table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))

d('departments storage', () => {
  it('openDatabase heals slack_triggers.action and company_task_activity.actor', () => {
    const db = openDatabase(':memory:')
    expect(cols(db, 'slack_triggers').has('action')).toBe(true)
    expect(cols(db, 'company_task_activity').has('actor')).toBe(true)
    db.close()
  })
  it('a schedule keeps its department; one without stays shaped as before', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    const target = { kind: 'prompt' as const, profileId: 'p', repoId: null, prompt: 'x', mode: 'task' as const }
    const when = { kind: 'at' as const, at: '2030-01-01T00:00:00Z' }
    const id = store.insertSchedule({ name: 'Weekly', target, when, departmentId: 'dep_mkt0000001' })
    expect(store.getSchedule(id)!.departmentId).toBe('dep_mkt0000001')
    // undefined keeps it; null clears it
    store.updateScheduleConfig(id, { name: 'Weekly 2', target, when })
    expect(store.getSchedule(id)!.departmentId).toBe('dep_mkt0000001')
    store.updateScheduleConfig(id, { name: 'Weekly 3', target, when, departmentId: null })
    expect('departmentId' in store.getSchedule(id)!).toBe(false)
    db.close()
  })
  it('a task-mode Slack trigger keeps its action and department across a save', () => {
    const db = openDatabase(':memory:')
    db.pragma('foreign_keys = OFF')
    const st = new SlackTriggerStore(db)
    const base = { name: 't', workflowId: 'wf_1', enabled: true, match: { on: ['dm'], channels: [], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'none', autoChannels: [], replyNode: null }, limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 }, inputs: {} }
    const run = st.insert({ ...base, action: 'run', departmentId: null } as unknown as NormalizedTrigger)
    expect(run.action).toBeUndefined()
    expect(run.departmentId).toBeUndefined()
    const task = st.insert({ ...base, action: 'task', departmentId: 'dep_mkt0000001' } as unknown as NormalizedTrigger)
    expect(task).toMatchObject({ action: 'task', departmentId: 'dep_mkt0000001' })
    expect(st.update(task.id, { ...base, action: 'run', departmentId: null } as unknown as NormalizedTrigger).action).toBeUndefined()
    db.close()
  })
})
