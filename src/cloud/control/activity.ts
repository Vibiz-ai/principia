/**
 * docs/MACHINES.md §6: what a managed machine needs to know to sleep safely. Every 30 s the control plane writes
 * `<dataDir>/activity.json`; the host's heartbeat (outside the container) reads it and reports it to the fleet, which
 * stops the machine after a quiet spell and starts it again before the next schedule.
 *
 * - busy: runs queued or running. A busy machine never sleeps.
 * - lastActivityAt: the latest of a run created or ended, and a change made from a device or the console (any request
 *   that is not a read). Reads and the event stream don't count: a Mac that is only watching keeps nothing awake.
 * - nextScheduleAt: the next slot of an enabled cloud schedule of a company that isn't paused (null when the workspace
 *   is paused). A missed slot younger than 12 hours still fires after a wake (agent/triggers.ts), so a late wake loses
 *   nothing.
 *
 * Nothing secret is in the file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { nextFire } from '../../main/engine/scheduler'
import type { CloudScheduleSpec } from '../../shared/cloud'
import type { Ctx } from './context'

export const ACTIVITY_FILE = 'activity.json'

export interface Activity {
  v: 1
  at: string
  busy: boolean
  running: number
  queued: number
  needsInput: number
  lastActivityAt: string | null
  nextScheduleAt: string | null
}

const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b)

export function activitySnapshot(ctx: Pick<Ctx, 'db' | 'now' | 'workspace'>, lastChangeAt: string | null): Activity {
  const now = ctx.now()
  const count = (status: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cloud_runs WHERE status = ?', status)?.n ?? 0
  const running = count('running')
  const queued = count('queued')
  const needsInput = count('needs_input')
  const runs = ctx.db.get<{ c: string | null; e: string | null }>('SELECT MAX(created_at) AS c, MAX(ended_at) AS e FROM cloud_runs')
  let next: Date | null = null
  if (!ctx.workspace().paused) {
    const rows = ctx.db.all<{ spec: string }>(
      "SELECT s.spec FROM schedules s JOIN companies c ON c.id = s.company_id WHERE s.placement = 'cloud' AND c.paused = 0"
    )
    for (const r of rows) {
      try {
        const spec = JSON.parse(r.spec) as CloudScheduleSpec
        if (!spec.enabled) continue
        const n = nextFire(spec.when, now)
        if (n && (!next || n < next)) next = n
      } catch {
        /* a schedule that can't be read never fires either */
      }
    }
  }
  return {
    v: 1,
    at: now.toISOString(),
    busy: running + queued > 0,
    running,
    queued,
    needsInput,
    lastActivityAt: later(later(runs?.c ?? null, runs?.e ?? null), lastChangeAt),
    nextScheduleAt: next ? next.toISOString() : null
  }
}

/** Atomic (write then rename), 0644: the host reads it as root, and it holds nothing secret. */
export function writeActivity(dataDir: string, a: Activity): void {
  const file = path.join(dataDir, ACTIVITY_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o644 })
  fs.renameSync(tmp, file)
}
