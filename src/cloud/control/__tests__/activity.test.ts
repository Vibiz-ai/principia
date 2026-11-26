import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_FILE, activitySnapshot, writeActivity } from '../activity'
import { startHarness, workflowFile } from './harness'

describe('activity.json (docs/FLEET.md §6)', () => {
  it('counts busy runs, the last change and the next cloud schedule of an unpaused company', async () => {
    let t = new Date('2026-11-14T08:00:00.000Z')
    const h = await startHarness({ now: () => t })
    try {
      const snap = () => activitySnapshot(h.app.ctx, null)
      expect(snap()).toMatchObject({ v: 1, busy: false, running: 0, queued: 0, lastActivityAt: null, nextScheduleAt: null })
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w1', { token: dev, body: { file: workflowFile('Brief'), baseRev: null } })
      const spec = { name: 'Morning', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w1', inputs: {} }, enabled: true }
      await h.call('PUT', '/v1/companies/co_a/schedules/s1', { token: dev, body: { schedule: spec, placement: 'cloud', baseRev: null } })
      // a schedule kept on the Mac never wakes the cloud
      await h.call('PUT', '/v1/companies/co_a/schedules/s2', { token: dev, body: { schedule: { ...spec, when: { kind: 'cron', cron: '30 8 * * *', tz: 'UTC' } }, placement: 'local', baseRev: null } })
      expect(snap().nextScheduleAt).toBe('2026-11-14T09:00:00.000Z')

      t = new Date('2026-11-14T08:05:00.000Z')
      const r = h.app.ports.requestRun({ companyId: 'co_a', trigger: 'manual', target: { kind: 'workflow', workflowId: 'w1', inputs: {} } })
      expect(r.runId).toBeTruthy()
      // the fake runtime ends it at once (no credentials): hold it as running, as a real agent would be
      h.app.ctx.db.run("UPDATE cloud_runs SET status = 'running', ended_at = NULL WHERE id = ?", r.runId!)
      expect(snap()).toMatchObject({ busy: true, running: 1, lastActivityAt: '2026-11-14T08:05:00.000Z' })
      t = new Date('2026-11-14T08:20:00.000Z')
      h.app.ctx.db.run("UPDATE cloud_runs SET status = 'passed', ended_at = ? WHERE id = ?", t.toISOString(), r.runId!)
      expect(snap()).toMatchObject({ busy: false, running: 0, lastActivityAt: '2026-11-14T08:20:00.000Z' })
      // a newer change from a device wins over the last run
      expect(activitySnapshot(h.app.ctx, '2026-11-14T08:21:00.000Z').lastActivityAt).toBe('2026-11-14T08:21:00.000Z')

      await h.call('PATCH', '/v1/companies/co_a', { token: dev, body: { paused: true } })
      expect(snap().nextScheduleAt).toBeNull()
    } finally {
      await h.close()
    }
  })

  it('writes the file atomically with nothing but the snapshot', async () => {
    const h = await startHarness()
    try {
      const a = activitySnapshot(h.app.ctx, null)
      writeActivity(h.dir, a)
      expect(JSON.parse(readFileSync(join(h.dir, ACTIVITY_FILE), 'utf8'))).toEqual(a)
    } finally {
      await h.close()
    }
  })
})
