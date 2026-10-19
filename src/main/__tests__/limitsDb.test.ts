/** CONTRACT §13 persistence: healed v2 columns (no version bump), settings defaults, run retries, agent stall/limit fields. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { Run } from '../../shared/types'
import { openDatabase } from '../db'
import { DDL_V1, DDL_V2_SCHEDULE_EVENTS, DDL_V2_TABLES, SCHEMA_VERSION } from '../db/schema'
import { Store } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { LiveStore } from '../db/liveStore'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false
}
const d = nativeOk ? describe : describe.skip
const cols = (db: Database.Database, t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

d('CONTRACT §13 persistence', () => {
  it('heals an existing v2 db in place: new nullable columns, same schema version', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-db-')), 'hive.db')
    const old = new Database(file)
    old.exec(DDL_V1)
    old.exec(DDL_V2_TABLES)
    old.exec('ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT')
    old.exec(DDL_V2_SCHEDULE_EVENTS)
    old.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2')").run()
    expect(cols(old, 'runs')).not.toContain('retry_at')
    old.close()
    const db = openDatabase(file)
    expect(SCHEMA_VERSION).toBe(2)
    expect(cols(db, 'runs')).toEqual(expect.arrayContaining(['stop_reason', 'reset_at', 'retry_at', 'retry_run_id']))
    expect(cols(db, 'run_steps')).toEqual(expect.arrayContaining(['stop_reason', 'reset_at']))
    expect(cols(db, 'agents')).toEqual(expect.arrayContaining(['stop_reason', 'reset_at', 'retry_at', 'stalled_since']))
    // idempotent
    db.close()
    openDatabase(file).close()
  })

  it('settings default to auto retry on and Stalled? after 10 minutes; patches stick', () => {
    const store = new Store(openDatabase(':memory:'))
    expect(store.getSettings()).toMatchObject({ autoRetryRateLimit: true, stallMinutes: 10 })
    expect(store.updateSettings({ stallMinutes: 1, autoRetryRateLimit: false })).toMatchObject({ autoRetryRateLimit: false, stallMinutes: 1 })
  })

  it('runs and steps round-trip the stop reason; listRetries returns pending retries only', () => {
    const db = openDatabase(':memory:')
    const es = createEngineStore(db, { describe: () => () => '' })
    const run = (id: string): Run => ({
      id,
      kind: 'prompt',
      title: id,
      target: { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' },
      workflowId: null,
      scheduleId: null,
      parentRunId: null,
      trigger: 'schedule',
      status: 'failed',
      reason: null,
      createdAt: '2026-10-16T09:00:00.000Z',
      startedAt: null,
      endedAt: null,
      artifactsDir: '/tmp/a/',
      artifactCount: 0
    })
    es.insertRun(run('r_a'), null)
    es.insertRun(run('r_b'), null)
    const a = es.updateRun('r_a', { stopReason: 'rate_limited', resetAt: '2026-10-16T13:00:00.000Z', retryAt: '2026-10-16T13:01:00.000Z' })
    expect(a).toMatchObject({ stopReason: 'rate_limited', resetAt: '2026-10-16T13:00:00.000Z', retryAt: '2026-10-16T13:01:00.000Z', retryRunId: null })
    expect(es.listRetries!().map((r) => r.id)).toEqual(['r_a'])
    es.updateRun('r_a', { retryRunId: 'r_b' })
    expect(es.listRetries!()).toEqual([])
    expect(es.getRun('r_b')!.stopReason).toBeNull()
  })

  it('agents keep stalledSince / stopReason / retryAt; boot recovery clears stalls and session resumes', () => {
    const db = openDatabase(':memory:')
    const live = new LiveStore(db)
    const ts = '2026-10-16T09:00:00.000Z'
    const base = {
      parentId: null,
      sessionId: null,
      runId: null,
      stepId: null,
      provider: 'claude' as const,
      repoId: null,
      cwd: '/tmp',
      title: 't',
      agentType: null,
      externalId: null,
      toolUseId: null,
      model: null,
      depth: 0,
      background: false,
      attribution: 'exact' as const,
      status: 'working' as const,
      needs: null,
      activity: null,
      lastTool: null,
      toolCount: 0,
      memReads: 0,
      filesTouched: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      modelUsage: null,
      report: null,
      startedAt: ts,
      updatedAt: ts,
      endedAt: null
    }
    live.insertAgent({ ...base, id: 'ag_s', rootId: 'ag_s', kind: 'session', sessionId: 's_1' })
    live.insertAgent({ ...base, id: 'ag_t', rootId: 'ag_t', kind: 'step', runId: 'r_1', stepId: 'st_1' })
    live.updateAgent('ag_s', { stopReason: 'rate_limited', resetAt: ts, retryAt: ts, stalledSince: ts })
    live.updateAgent('ag_t', { stopReason: 'rate_limited', retryAt: ts, stalledSince: ts })
    expect(live.getAgent('ag_s')).toMatchObject({ stopReason: 'rate_limited', resetAt: ts, retryAt: ts, stalledSince: ts })
    live.bootRecover()
    expect(live.getAgent('ag_s')).toMatchObject({ stalledSince: null, retryAt: null, stopReason: 'rate_limited' })
    // a run's retry survives a restart (the scheduler still fires it), so its step root keeps the mirror
    expect(live.getAgent('ag_t')).toMatchObject({ stalledSince: null, retryAt: ts })
  })
})
